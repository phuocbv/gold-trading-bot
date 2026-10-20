const axios = require('axios');
const CONFIG = require('../config');
const { sendRawMessage } = require('./telegram');
const { readJson, writeJson } = require('./jsonStore');

// Feed ForexFactory chặn IP gọi quá dày: chỉ tải lại mỗi giờ, nếu lỗi thì thử lại sau 10 phút
const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
};

const FLAGS = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', CNY: '🇨🇳', AUD: '🇦🇺', CAD: '🇨🇦', NZD: '🇳🇿', CHF: '🇨🇭',
};
const IMPACT_ICONS = { High: '🔴', Medium: '🟠', Low: '🟡' };

const timeFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit' });

// Lịch tin đã tải (toàn bộ sự kiện của feed) và danh sách tin đã nhắn, lưu xuống file để không mất khi khởi động lại
let state = null;

function load() {
  if (!state) {
    const raw = readJson(CONFIG.newsStatePath, {});
    const saved = raw && typeof raw === 'object' ? raw : {};
    state = {
      fetchedAt: Number(saved.fetchedAt) || 0,
      lastAttemptAt: Number(saved.lastAttemptAt) || 0,
      events: Array.isArray(saved.events) ? saved.events : [],
      alerted: Array.isArray(saved.alerted) ? saved.alerted : [],
    };
  }
  return state;
}

function save() {
  writeJson(CONFIG.newsStatePath, state);
}

function isRelevant(event) {
  return CONFIG.newsCurrencies.includes(event.currency) && CONFIG.newsImpacts.includes(event.impact);
}

/**
 * Các tin theo dõi (tiền tệ & mức tác động trong cấu hình), sắp theo giờ ra tin
 */
function relevantEvents() {
  return load().events.filter(isRelevant);
}

/**
 * Tải một feed lịch kinh tế định dạng ForexFactory: [{ title, country, date, impact, forecast, previous }]
 */
async function fetchFeed(url) {
  const { data } = await axios.get(url, { headers: HTTP_HEADERS, timeout: 10000 });
  if (!Array.isArray(data)) throw new Error('Feed không trả về danh sách sự kiện');

  const events = [];
  for (const e of data) {
    const time = Date.parse(e && e.date);
    if (!e || !e.title || Number.isNaN(time)) continue;
    const iso = new Date(time).toISOString();
    const currency = String(e.country || '').toUpperCase();
    events.push({
      id: `${currency}|${iso}|${e.title}`,
      title: e.title,
      currency,
      impact: e.impact || '',
      time: iso,
      forecast: e.forecast || '',
      previous: e.previous || '',
    });
  }
  return events;
}

/**
 * Cập nhật lịch tin (tối đa mỗi giờ một lần). Feed chính lỗi thì giữ nguyên lịch đã lưu.
 */
async function refreshCalendar({ force = false } = {}) {
  if (!CONFIG.newsEnabled) return;
  load();
  const now = Date.now();
  if (!force && (now - state.fetchedAt < REFRESH_MS || now - state.lastAttemptAt < RETRY_MS)) return;
  state.lastAttemptAt = now;

  const [primaryUrl, ...extraUrls] = CONFIG.newsFeedUrls;
  try {
    const primary = await fetchFeed(primaryUrl);
    const extra = await Promise.all(extraUrls.map((url) => fetchFeed(url).catch((err) => {
      // Feed tuần sau trả 404 cho tới khi ForexFactory phát hành (thường vào cuối tuần)
      if (err.response?.status !== 404) console.warn(`⚠️ [News] Không tải được feed phụ ${url}: ${err.message}`);
      return [];
    })));

    const byId = new Map();
    for (const e of [...primary, ...extra.flat()]) byId.set(e.id, e);
    state.events = [...byId.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    state.alerted = state.alerted.filter((id) => byId.has(id));
    state.fetchedAt = now;
    console.log(`📰 [News] Đã cập nhật lịch tin: ${relevantEvents().length} tin ${CONFIG.newsCurrencies.join('/')} mức ${CONFIG.newsImpacts.join('/')} trong lịch.`);
  } catch (err) {
    console.warn(`⚠️ [News] Không tải được lịch tin (${err.message}). Tiếp tục dùng lịch đã lưu (${relevantEvents().length} tin).`);
  }
  save();
}

/**
 * Mô tả ngắn một tin cho log: "USD Non-Farm Employment Change lúc 19:30"
 */
function describeEvent(event) {
  return `${event.currency} ${event.title} lúc ${timeFmt.format(new Date(event.time))}`;
}

/**
 * Các tin đang trong khung chặn tín hiệu (±CONFIG.newsBlackoutMinutes quanh giờ ra tin); rỗng nếu không chặn
 */
function getNewsBlackout(now = Date.now()) {
  if (!CONFIG.newsEnabled || CONFIG.newsBlackoutMinutes <= 0) return [];
  const windowMs = CONFIG.newsBlackoutMinutes * MINUTE_MS;
  return relevantEvents().filter((e) => Math.abs(Date.parse(e.time) - now) <= windowMs);
}

/**
 * Soạn và gửi tin nhắn báo trước cho một nhóm tin ra cùng giờ
 */
async function sendNewsAlert(events, releaseTime, now) {
  const minutesLeft = Math.max(1, Math.round((releaseTime - now) / MINUTE_MS));
  const blackoutMs = CONFIG.newsBlackoutMinutes * MINUTE_MS;

  let msg = `📰 *SẮP CÓ TIN KINH TẾ QUAN TRỌNG* 📰\n\n`;
  msg += `⏰ *Giờ ra tin:* ${timeFmt.format(new Date(releaseTime))} — ${dateFmt.format(new Date(releaseTime))} (giờ VN)\n`;
  msg += `⏳ *Còn khoảng:* ${minutesLeft} phút\n\n`;
  for (const e of events) {
    msg += `${IMPACT_ICONS[e.impact] || '⚪'} ${FLAGS[e.currency] || ''} *${e.currency} — ${e.title}*\n`;
    if (e.forecast || e.previous) {
      msg += `      Dự báo: \`${e.forecast || '—'}\` | Kỳ trước: \`${e.previous || '—'}\`\n`;
    }
  }
  if (blackoutMs > 0) {
    msg += `\n⛔ Bot tạm dừng phát tín hiệu từ *${timeFmt.format(new Date(releaseTime - blackoutMs))}* đến *${timeFmt.format(new Date(releaseTime + blackoutMs))}*.\n`;
  }
  msg += `\n⚠️ _Giá có thể biến động mạnh và giãn spread quanh giờ ra tin. Cân nhắc giảm khối lượng, dời SL hoặc đứng ngoài._`;

  return sendRawMessage(msg);
}

/**
 * Chạy mỗi phút: nhắn Telegram cho các tin sẽ ra trong CONFIG.newsAlertMinutes phút tới (mỗi tin chỉ nhắn một lần)
 */
async function checkNewsAlerts(now = Date.now()) {
  if (!CONFIG.newsEnabled) return;
  await refreshCalendar();

  const alertMs = CONFIG.newsAlertMinutes * MINUTE_MS;
  const groups = new Map();
  for (const e of relevantEvents()) {
    const time = Date.parse(e.time);
    if (state.alerted.includes(e.id) || now < time - alertMs || now >= time) continue;
    if (!groups.has(time)) groups.set(time, []);
    groups.get(time).push(e);
  }

  for (const [time, events] of groups) {
    // Đánh dấu trước khi gửi để không nhắn lặp lại mỗi phút nếu Telegram lỗi (sendRawMessage đã tự thử lại)
    state.alerted.push(...events.map((e) => e.id));
    save();
    const sent = await sendNewsAlert(events, time, now);
    console.log(`📰 [News] ${sent ? 'Đã nhắn' : 'Không nhắn được'} báo trước ${events.length} tin lúc ${timeFmt.format(new Date(time))}: ${events.map((e) => e.title).join(', ')}`);
  }
}

/**
 * Dữ liệu lịch tin cho dashboard
 */
function getNewsOverview() {
  const s = load();
  return {
    enabled: CONFIG.newsEnabled,
    currencies: CONFIG.newsCurrencies,
    impacts: CONFIG.newsImpacts,
    alertMinutes: CONFIG.newsAlertMinutes,
    blackoutMinutes: CONFIG.newsBlackoutMinutes,
    fetchedAt: s.fetchedAt ? new Date(s.fetchedAt).toISOString() : null,
    events: relevantEvents().map((e) => ({ ...e, alerted: s.alerted.includes(e.id) })),
  };
}

module.exports = {
  refreshCalendar,
  checkNewsAlerts,
  getNewsBlackout,
  getNewsOverview,
  describeEvent,
};

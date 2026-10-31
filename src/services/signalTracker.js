const CONFIG = require('../config');
const { checkCandleHit, rMultiple, primaryStrategyName } = require('../tradeOutcome');
const { resolveSymbolSources, timeframeToMs } = require('./marketData');
const { readJson, writeJson } = require('./jsonStore');
const { dbEnabled, query, withTransaction } = require('./db');

// Danh sách tín hiệu đã ghi nhận, đọc từ file JSON ở lần dùng đầu tiên (có Postgres thì gộp thêm khi khởi động)
let records = null;

function load() {
  if (!records) {
    const saved = readJson(CONFIG.signalDbPath, []);
    records = Array.isArray(saved) ? saved : [];
  }
  return records;
}

/**
 * Khóa định danh luồng giá của một nguồn dữ liệu: cùng sàn + cùng mã thì cùng giá,
 * vd 'TradingView (BINANCE:ETHUSDT)' và 'Binance Spot (ETHUSDT)' đều là 'BINANCE:ETHUSDT'
 */
function feedKey(source) {
  const match = /\(([^)]+)\)/.exec(source || '');
  const ticker = (match ? match[1] : source || '').toUpperCase();
  return /^binance/i.test(source || '') && !ticker.includes(':') ? `BINANCE:${ticker}` : ticker;
}

// Có Postgres: mỗi thay đổi được ghi vào cả file JSON và Postgres. Bản ghi chưa lưu được vào Postgres (vd: mất kết nối)
// nằm ở pendingIds để thử lại ở lần cập nhật sau; lần đầu kết nối được thì gộp dữ liệu hai bên trước (dbSynced).
// Bot (ownsStore) còn kéo định kỳ các bản ghi mới trong Postgres, vd tín hiệu bổ sung bằng npm run backtest:day
const PULL_INTERVAL_MS = 60 * 1000;
const pendingIds = new Set();
let ownsStore = false;
let dbSynced = false;
let dbFailing = false;
let dbQueue = Promise.resolve();
let dbQueued = false;
let lastPulledAt = null;
let lastPullMs = 0;

// Mức tiến triển của một bản ghi để chọn bản mới hơn khi gộp: tín hiệu bot thật > tín hiệu bổ sung từ backtest,
// rồi đã đóng lệnh > số nến đã theo dõi > đã gửi
function progress(rec) {
  return [rec.origin === 'backtest' ? 0 : 1, rec.status !== 'OPEN' ? 1 : 0, rec.barsHeld || 0, rec.sent ? 1 : 0, rec.delivered ? 1 : 0];
}

function compareProgress(a, b) {
  const pa = progress(a);
  const pb = progress(b);
  const i = pa.findIndex((v, k) => v !== pb[k]);
  return i < 0 ? 0 : pa[i] - pb[i];
}

async function upsertSignal(client, rec) {
  await client.query(
    `INSERT INTO signals (id, symbol, timeframe, strategy, action, sent, status, candle_time, closed_time, r_multiple, origin, data, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (id) DO UPDATE SET symbol = EXCLUDED.symbol, timeframe = EXCLUDED.timeframe, strategy = EXCLUDED.strategy,
       action = EXCLUDED.action, sent = EXCLUDED.sent, status = EXCLUDED.status, candle_time = EXCLUDED.candle_time,
       closed_time = EXCLUDED.closed_time, r_multiple = EXCLUDED.r_multiple, origin = EXCLUDED.origin, data = EXCLUDED.data, updated_at = now()`,
    [rec.id, rec.symbol, rec.timeframe || CONFIG.timeframe, rec.strategy, rec.action, Boolean(rec.sent), rec.status,
      rec.candleTime, rec.closedTime, rec.status === 'OPEN' ? null : rMultiple(rec, rec.exitPrice), rec.origin || 'bot', rec]);
}

async function upsertSignals(list) {
  await withTransaction(async (client) => {
    for (const rec of list) await upsertSignal(client, rec);
  });
}

// Gộp hai danh sách bản ghi: mỗi id giữ bản tiến triển hơn, sắp theo thời gian tín hiệu
function mergeRecords(local, stored) {
  const merged = new Map(local.map((r) => [r.id, r]));
  for (const rec of stored) {
    if (!merged.has(rec.id) || compareProgress(rec, merged.get(rec.id)) > 0) merged.set(rec.id, rec);
  }
  return [...merged.values()].sort((a, b) => Date.parse(a.candleTime) - Date.parse(b.candleTime));
}

/**
 * Gộp tín hiệu trong Postgres với file JSON: bản ghi chỉ có ở một bên được bổ sung sang bên kia, bản ghi có ở cả hai
 * giữ bản tiến triển hơn (vd: file đã có kết quả lệnh nhưng bot dừng trước khi kịp lưu vào Postgres). Lần đầu lấy toàn bộ,
 * các lần sau chỉ lấy bản ghi đổi gần đây (lùi 5 phút để không sót bản ghi của giao dịch ghi xong muộn)
 */
async function syncWithDb() {
  load();
  const full = !dbSynced || !lastPulledAt;
  const { rows: [{ at }] } = await query('SELECT now() AS at');
  const { rows } = full
    ? await query('SELECT data FROM signals')
    : await query('SELECT data FROM signals WHERE updated_at > $1', [new Date(lastPulledAt.getTime() - 5 * 60 * 1000)]);
  const stored = new Map(rows.map((r) => [r.data.id, r.data]));
  const local = new Map(records.map((r) => [r.id, r]));
  records = mergeRecords(records, [...stored.values()]);
  for (const rec of records) {
    const db = stored.get(rec.id);
    if (db ? compareProgress(rec, db) > 0 : full) pendingIds.add(rec.id);
  }
  const added = records.filter((rec) => !local.has(rec.id)).length;
  if (records.some((rec) => rec !== local.get(rec.id))) writeJson(CONFIG.signalDbPath, records);
  dbSynced = true;
  lastPulledAt = at;
  lastPullMs = Date.now();
  if (full) console.log(`🗄️ [SignalTracker] Đã đồng bộ ${records.length} tín hiệu với Postgres (${pendingIds.size} bản ghi cần lưu thêm).`);
  else if (added > 0) console.log(`🗄️ [SignalTracker] Đã nạp ${added} tín hiệu mới từ Postgres.`);
}

/**
 * Lưu các bản ghi đang chờ vào Postgres, lần lượt và không chặn bot; lỗi thì giữ lại để thử ở lần sau
 */
function persistToDb() {
  if (!dbEnabled() || dbQueued) return dbQueue;
  dbQueued = true;
  dbQueue = dbQueue.then(async () => {
    dbQueued = false;
    let ids = [];
    try {
      if (!dbSynced || (ownsStore && Date.now() - lastPullMs > PULL_INTERVAL_MS)) await syncWithDb();
      ids = [...pendingIds];
      pendingIds.clear();
      if (ids.length > 0) await upsertSignals(records.filter((r) => ids.includes(r.id)));
      if (dbFailing) console.log('🗄️ [SignalTracker] Đã kết nối lại Postgres và lưu các tín hiệu còn chờ.');
      dbFailing = false;
    } catch (err) {
      ids.forEach((id) => pendingIds.add(id));
      // Chỉ báo lỗi một lần cho mỗi đợt mất kết nối để không làm ngập log
      if (!dbFailing) console.error(`❌ [SignalTracker] Chưa lưu được tín hiệu vào Postgres (${err.message}), sẽ thử lại ở lần cập nhật sau.`);
      dbFailing = true;
    }
  });
  return dbQueue;
}

function save(changed) {
  // Không có Postgres: file có thể vừa được npm run backtest:day bổ sung tín hiệu, gộp trước khi ghi để không ghi đè mất
  if (!dbEnabled()) records = mergeRecords(records, readJson(CONFIG.signalDbPath, []));
  writeJson(CONFIG.signalDbPath, records);
  for (const rec of changed) pendingIds.add(rec.id);
  persistToDb();
}

/**
 * Nạp tín hiệu đã lưu trước lượt quét đầu tiên: có Postgres thì gộp với file JSON (lỗi kết nối thì dùng file và thử lại sau)
 */
async function initSignalStore() {
  ownsStore = true;
  load();
  await persistToDb();
}

// Bot: tới hạn thì nạp bản ghi mới từ Postgres (không chặn, kết quả có ở lần đọc sau) hoặc từ file JSON khi không có Postgres
function pullIfDue() {
  if (!ownsStore || Date.now() - lastPullMs <= PULL_INTERVAL_MS) return;
  if (dbEnabled()) {
    persistToDb();
  } else {
    lastPullMs = Date.now();
    records = mergeRecords(load(), readJson(CONFIG.signalDbPath, []));
  }
}

/**
 * Chỉ đọc: nạp thêm tín hiệu đã lưu trong Postgres vào bộ nhớ, không ghi file hay Postgres. Dùng cho script chạy tay
 * (vd: backtest:day) để đối chiếu với tín hiệu bot thật kể cả khi bot chạy ở tiến trình hoặc máy khác
 */
async function loadStoredSignals() {
  load();
  if (!dbEnabled()) return;
  const { rows } = await query('SELECT data FROM signals');
  records = mergeRecords(records, rows.map((r) => r.data));
}

/**
 * Bổ sung tín hiệu tính lại bằng backtest (npm run backtest:day) vào danh sách tín hiệu, có chống trùng theo mã tín hiệu
 * (tài sản | chiều | giờ mở nến tín hiệu, giống bot thật): đã có tín hiệu bot thật thì bỏ qua, đã có tín hiệu bổ sung thì
 * chỉ cập nhật khi tiến triển hơn (vd: lần trước còn mở, nay đã chạm TP1). Có Postgres thì ghi vào Postgres (bot đang chạy
 * tự nạp trong vòng một phút), không có thì ghi vào file JSON.
 * @param {Array<object>} list - Bản ghi cùng cấu trúc recordSignal, origin = 'backtest'
 * @returns {Promise<{added: number, updated: number, unchanged: number, live: number}>}
 */
async function backfillSignals(list) {
  const counts = { added: 0, updated: 0, unchanged: 0, live: 0 };
  const decide = (existing, rec) => {
    if (!existing) return 'added';
    if (existing.origin !== 'backtest') return 'live';
    return compareProgress(rec, existing) > 0 ? 'updated' : 'unchanged';
  };

  if (dbEnabled()) {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT data FROM signals WHERE id = ANY($1) FOR UPDATE', [list.map((r) => r.id)]);
      const existing = new Map(rows.map((r) => [r.data.id, r.data]));
      for (const rec of list) {
        const result = decide(existing.get(rec.id), rec);
        counts[result]++;
        if (result === 'added' || result === 'updated') {
          await upsertSignal(client, rec);
          existing.set(rec.id, rec);
        }
      }
    });
    return counts;
  }

  load();
  for (const rec of list) {
    const at = records.findIndex((r) => r.id === rec.id);
    const result = decide(records[at], rec);
    counts[result]++;
    if (result === 'added') records.push(rec);
    if (result === 'updated') records[at] = rec;
  }
  if (counts.added + counts.updated > 0) {
    records.sort((a, b) => Date.parse(a.candleTime) - Date.parse(b.candleTime));
    writeJson(CONFIG.signalDbPath, records);
  }
  return counts;
}

/**
 * Chờ lưu xong các thay đổi vào Postgres (dùng trước khi tắt bot)
 */
function flushSignals() {
  return pendingIds.size > 0 ? persistToDb() : dbQueue;
}

/**
 * Ghi nhận một tín hiệu vừa phát (hoặc bị AI từ chối) để theo dõi kết quả TP1/SL
 * @param {object} signal - Tín hiệu đã chấm điểm (có symbol, displayName, aiReview)
 * @param {object} meta - { candleTime, sent: đã qua bộ lọc AI, delivered: Telegram gửi thành công, source: nguồn dữ liệu nến }
 */
function recordSignal(signal, { candleTime, sent, delivered, source }) {
  load();
  const id = `${signal.symbol}|${signal.action}|${candleTime}`;
  const ai = signal.aiReview;
  let existing = records.find((r) => r.id === id);
  // Tín hiệu bổ sung từ backtest cùng nến được thay bằng tín hiệu bot thật
  if (existing && existing.origin === 'backtest') {
    records.splice(records.indexOf(existing), 1);
    existing = null;
  }
  if (existing) {
    // Cùng nến trước đó bị AI từ chối, nay được duyệt và gửi đi: cập nhật để thống kê tính đúng là đã gửi
    if (sent && !existing.sent) {
      Object.assign(existing, {
        sent: true,
        delivered: Boolean(delivered),
        aiMode: ai ? ai.mode : null,
        aiConfidence: ai ? ai.confidence : null,
      });
      save([existing]);
    }
    return;
  }

  const signalTime = new Date(candleTime).toISOString();
  const rec = {
    id,
    symbol: signal.symbol,
    displayName: signal.displayName || signal.symbol,
    strategy: primaryStrategyName(signal.strategy),
    alliedStrategies: (signal.alliedStrategies || []).map(primaryStrategyName),
    action: signal.action,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    takeProfit2: signal.takeProfit2 || null,
    score: signal.score ?? null,
    candleTime: signalTime,
    timeframe: signal.timeframe || CONFIG.timeframe,
    source: source || null,
    sent,
    delivered: Boolean(delivered),
    aiMode: ai ? ai.mode : null,
    aiConfidence: ai ? ai.confidence : null,
    status: 'OPEN',
    barsHeld: 0,
    lastCheckedTime: signalTime,
    lastPrice: signal.entry,
    exitPrice: null,
    closedTime: null,
  };
  records.push(rec);
  save([rec]);
}

/**
 * Cập nhật các lệnh đang mở của một tài sản theo các nến đã đóng mới (chạm TP1 / SL / hết hạn)
 * Nguồn chính (MARKET_DATA_SOURCE) luôn được dùng để chấm, kể cả cho lệnh phát lúc đang dùng nguồn dự phòng,
 * vì người dùng đặt lệnh theo giá thật của tài sản. Nến từ nguồn dự phòng (vd: Binance PAXG thay cho OANDA XAU)
 * lệch giá vài đô nên chỉ dùng cho lệnh cùng luồng giá; lệnh khác nguồn chờ nguồn chính có lại, trừ khi
 * nguồn gốc mất liên tục quá thời gian theo dõi (vd: đã đổi TRADINGVIEW_SYMBOL) để lệnh không bị treo mãi.
 * @param {string} symbol
 * @param {Array<object>} candles - Chỉ gồm các nến đã đóng, cũ nhất -> mới nhất
 * @param {object} [feed] - { source: marketData.source, isFallback: nến từ nguồn dự phòng, timeframe: khung của các nến, now }
 */
function updateOpenSignals(symbol, candles, { source, isFallback = true, timeframe = CONFIG.timeframe, now = Date.now() } = {}) {
  load();
  const changed = new Set();

  for (const rec of records) {
    if (rec.symbol !== symbol || rec.status !== 'OPEN') continue;
    // Lệnh chỉ được chấm bằng nến cùng khung thời gian với lúc phát tín hiệu (thời gian theo dõi tính theo số nến của khung đó)
    if ((rec.timeframe || CONFIG.timeframe) !== timeframe) continue;
    if (isFallback && rec.source && source && feedKey(rec.source) !== feedKey(source)) {
      // Tính từ lúc bắt đầu mất nguồn (không phải lần cập nhật cuối) để khoảng nghỉ cuối tuần không bị tính là mất nguồn
      if (!rec.feedMissingSince) {
        rec.feedMissingSince = new Date(now).toISOString();
        changed.add(rec);
      }
      const horizonMs = CONFIG.signalTrackHorizonBars * timeframeToMs(rec.timeframe || CONFIG.timeframe);
      if (now - Date.parse(rec.feedMissingSince) <= horizonMs) continue;
    } else if (rec.feedMissingSince) {
      delete rec.feedMissingSince;
      changed.add(rec);
    }
    const checkedUntil = new Date(rec.lastCheckedTime).getTime();

    for (const candle of candles) {
      const time = new Date(candle.date).getTime();
      if (time <= checkedUntil) continue;

      rec.barsHeld++;
      rec.lastCheckedTime = new Date(time).toISOString();
      rec.lastPrice = candle.close;
      changed.add(rec);

      const hit = checkCandleHit(rec, candle);
      if (hit || rec.barsHeld >= CONFIG.signalTrackHorizonBars) {
        rec.status = hit || 'EXPIRED';
        rec.exitPrice = hit === 'SL' ? rec.stopLoss : hit === 'TP' ? rec.takeProfit : candle.close;
        rec.closedTime = rec.lastCheckedTime;
        const r = rMultiple(rec, rec.exitPrice);
        console.log(`📒 [SignalTracker] ${rec.displayName} ${rec.action} (${rec.strategy}) đóng lệnh: ${rec.status} | ${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
        break;
      }
    }
  }

  if (changed.size > 0) save(changed);
  // Không có gì đổi nhưng còn bản ghi chưa lưu được vào Postgres: thử lại mỗi lượt quét
  else if (pendingIds.size > 0 || (dbEnabled() && !dbSynced)) persistToDb();
  else pullIfDue();
}

/**
 * Thông tin quy đổi khối lượng của tài sản: Vàng tính theo lot (1 lot = 100 oz), Crypto tính theo coin
 */
function describeAsset(symbol) {
  const { displayName, isCrypto } = resolveSymbolSources(symbol);
  return {
    symbol,
    displayName,
    contractSize: isCrypto ? 1 : 100,
    sizeUnit: isCrypto ? 'coin' : 'lot',
  };
}

/**
 * Danh sách tín hiệu kèm lãi/lỗ (lệnh đang mở tính tạm theo giá đóng cửa nến gần nhất)
 * pnlPerUnit: lãi/lỗ USD cho 1 đơn vị giá (1 oz Vàng / 1 coin)
 */
function withPnl(rec) {
  const exit = rec.status === 'OPEN' ? rec.lastPrice : rec.exitPrice;
  const direction = rec.action === 'BUY' ? 1 : -1;
  const { contractSize, sizeUnit } = describeAsset(rec.symbol);
  return {
    ...rec,
    r: rMultiple(rec, exit),
    pnlPerUnit: (exit - rec.entry) * direction,
    contractSize,
    sizeUnit,
  };
}

function listSignals() {
  pullIfDue();
  return load().map(withPnl);
}

/**
 * Như listSignals nhưng đọc từ Postgres ở mỗi lần gọi (cho dashboard): thấy ngay tín hiệu do tiến trình khác ghi
 * (vd: npm run backtest:day), gộp với bộ nhớ của tiến trình để có cả thay đổi chưa kịp lưu. Không có Postgres thì
 * như listSignals; lỗi kết nối được ném ra để nơi gọi tự dùng listSignals
 */
async function listStoredSignals() {
  if (!dbEnabled()) return listSignals();
  const { rows } = await query('SELECT data FROM signals');
  return mergeRecords(rows.map((r) => r.data), load()).map(withPnl);
}

module.exports = {
  initSignalStore,
  loadStoredSignals,
  listStoredSignals,
  backfillSignals,
  flushSignals,
  recordSignal,
  updateOpenSignals,
  listSignals,
  describeAsset,
  feedKey,
};

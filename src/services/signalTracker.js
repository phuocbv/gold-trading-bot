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
// nằm ở pendingIds để thử lại ở lần cập nhật sau; lần đầu kết nối được thì gộp dữ liệu hai bên trước (dbSynced)
const pendingIds = new Set();
let dbSynced = false;
let dbFailing = false;
let dbQueue = Promise.resolve();
let dbQueued = false;

// Mức tiến triển của một bản ghi để chọn bản mới hơn khi gộp: đã đóng lệnh > số nến đã theo dõi > đã gửi
function progress(rec) {
  return [rec.status !== 'OPEN' ? 1 : 0, rec.barsHeld || 0, rec.sent ? 1 : 0, rec.delivered ? 1 : 0];
}

function compareProgress(a, b) {
  const pa = progress(a);
  const pb = progress(b);
  const i = pa.findIndex((v, k) => v !== pb[k]);
  return i < 0 ? 0 : pa[i] - pb[i];
}

async function upsertSignals(list) {
  await withTransaction(async (client) => {
    for (const rec of list) {
      await client.query(
        `INSERT INTO signals (id, symbol, timeframe, strategy, action, sent, status, candle_time, closed_time, r_multiple, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (id) DO UPDATE SET symbol = EXCLUDED.symbol, timeframe = EXCLUDED.timeframe, strategy = EXCLUDED.strategy,
           action = EXCLUDED.action, sent = EXCLUDED.sent, status = EXCLUDED.status, candle_time = EXCLUDED.candle_time,
           closed_time = EXCLUDED.closed_time, r_multiple = EXCLUDED.r_multiple, data = EXCLUDED.data, updated_at = now()`,
        [rec.id, rec.symbol, rec.timeframe || CONFIG.timeframe, rec.strategy, rec.action, Boolean(rec.sent), rec.status,
          rec.candleTime, rec.closedTime, rec.status === 'OPEN' ? null : rMultiple(rec, rec.exitPrice), rec]);
    }
  });
}

/**
 * Gộp tín hiệu trong Postgres với file JSON: bản ghi chỉ có ở một bên được bổ sung sang bên kia, bản ghi có ở cả hai
 * giữ bản tiến triển hơn (vd: file đã có kết quả lệnh nhưng bot dừng trước khi kịp lưu vào Postgres)
 */
async function syncWithDb() {
  load();
  const { rows } = await query('SELECT data FROM signals');
  const fromDb = new Map(rows.map((r) => [r.data.id, r.data]));
  const merged = new Map(records.map((r) => [r.id, r]));
  let fileChanged = false;
  for (const [id, rec] of fromDb) {
    if (!merged.has(id) || compareProgress(rec, merged.get(id)) > 0) {
      merged.set(id, rec);
      fileChanged = true;
    }
  }
  for (const [id, rec] of merged) {
    if (!fromDb.has(id) || compareProgress(rec, fromDb.get(id)) > 0) pendingIds.add(id);
  }
  records = [...merged.values()].sort((a, b) => Date.parse(a.candleTime) - Date.parse(b.candleTime));
  if (fileChanged) writeJson(CONFIG.signalDbPath, records);
  dbSynced = true;
  console.log(`🗄️ [SignalTracker] Đã đồng bộ ${records.length} tín hiệu với Postgres (${pendingIds.size} bản ghi cần lưu thêm).`);
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
      if (!dbSynced) await syncWithDb();
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
  writeJson(CONFIG.signalDbPath, records);
  for (const rec of changed) pendingIds.add(rec.id);
  persistToDb();
}

/**
 * Nạp tín hiệu đã lưu trước lượt quét đầu tiên: có Postgres thì gộp với file JSON (lỗi kết nối thì dùng file và thử lại sau)
 */
async function initSignalStore() {
  load();
  await persistToDb();
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
  const existing = records.find((r) => r.id === id);
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
function listSignals() {
  return load().map((rec) => {
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
  });
}

module.exports = {
  initSignalStore,
  flushSignals,
  recordSignal,
  updateOpenSignals,
  listSignals,
  describeAsset,
  feedKey,
};

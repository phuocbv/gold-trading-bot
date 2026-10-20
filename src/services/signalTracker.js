const CONFIG = require('../config');
const { checkCandleHit, rMultiple, primaryStrategyName } = require('../tradeOutcome');
const { resolveSymbolSources } = require('./marketData');
const { readJson, writeJson } = require('./jsonStore');

// Danh sách tín hiệu đã ghi nhận, đọc từ file JSON ở lần dùng đầu tiên
let records = null;

function load() {
  if (!records) records = readJson(CONFIG.signalDbPath, []);
  return records;
}

function save() {
  writeJson(CONFIG.signalDbPath, records);
}

/**
 * Ghi nhận một tín hiệu vừa phát (hoặc bị AI từ chối) để theo dõi kết quả TP1/SL
 * @param {object} signal - Tín hiệu đã chấm điểm (có symbol, displayName, aiReview)
 * @param {object} meta - { candleTime, sent: đã qua bộ lọc AI, delivered: Telegram gửi thành công, source: nguồn dữ liệu nến }
 */
function recordSignal(signal, { candleTime, sent, delivered, source }) {
  load();
  const id = `${signal.symbol}|${signal.action}|${candleTime}`;
  if (records.some((r) => r.id === id)) return;

  const ai = signal.aiReview;
  const signalTime = new Date(candleTime).toISOString();
  records.push({
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
    timeframe: CONFIG.timeframe,
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
  });
  save();
}

/**
 * Cập nhật các lệnh đang mở của một tài sản theo các nến đã đóng mới (chạm TP1 / SL / hết hạn)
 * Chỉ dùng nến cùng nguồn dữ liệu với lúc phát tín hiệu: nguồn dự phòng (vd: Binance PAXG thay cho OANDA XAU)
 * lệch giá vài đô sẽ làm chạm SL/TP sai, nên lệnh chờ tới khi có lại dữ liệu đúng nguồn.
 * @param {string} symbol
 * @param {Array<object>} candles - Chỉ gồm các nến đã đóng, cũ nhất -> mới nhất
 * @param {string} [source] - Nguồn dữ liệu của các nến (marketData.source)
 */
function updateOpenSignals(symbol, candles, source) {
  load();
  let changed = false;

  for (const rec of records) {
    if (rec.symbol !== symbol || rec.status !== 'OPEN') continue;
    if (rec.source && source && rec.source !== source) continue;
    const checkedUntil = new Date(rec.lastCheckedTime).getTime();

    for (const candle of candles) {
      const time = new Date(candle.date).getTime();
      if (time <= checkedUntil) continue;

      rec.barsHeld++;
      rec.lastCheckedTime = new Date(time).toISOString();
      rec.lastPrice = candle.close;
      changed = true;

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

  if (changed) save();
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
  recordSignal,
  updateOpenSignals,
  listSignals,
  describeAsset,
};

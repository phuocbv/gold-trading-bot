const CONFIG = require('../config');
const { checkCandleHit, rMultiple, primaryStrategyName } = require('../tradeOutcome');
const { resolveSymbolSources, timeframeToMs } = require('./marketData');
const { readJson, writeJson } = require('./jsonStore');

// Danh sách tín hiệu đã ghi nhận, đọc từ file JSON ở lần dùng đầu tiên
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
      save();
    }
    return;
  }

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
  });
  save();
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
  let changed = false;

  for (const rec of records) {
    if (rec.symbol !== symbol || rec.status !== 'OPEN') continue;
    // Lệnh chỉ được chấm bằng nến cùng khung thời gian với lúc phát tín hiệu (thời gian theo dõi tính theo số nến của khung đó)
    if ((rec.timeframe || CONFIG.timeframe) !== timeframe) continue;
    if (isFallback && rec.source && source && feedKey(rec.source) !== feedKey(source)) {
      // Tính từ lúc bắt đầu mất nguồn (không phải lần cập nhật cuối) để khoảng nghỉ cuối tuần không bị tính là mất nguồn
      if (!rec.feedMissingSince) {
        rec.feedMissingSince = new Date(now).toISOString();
        changed = true;
      }
      const horizonMs = CONFIG.signalTrackHorizonBars * timeframeToMs(rec.timeframe || CONFIG.timeframe);
      if (now - Date.parse(rec.feedMissingSince) <= horizonMs) continue;
    } else if (rec.feedMissingSince) {
      delete rec.feedMissingSince;
      changed = true;
    }
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
  feedKey,
};

/**
 * Lõi backtest dùng chung cho `npm run backtest` và báo cáo trên dashboard.
 * Mỗi nến được phân tích bằng đúng cửa sổ CANDLE_LIMIT nến như khi bot chạy thật; kết quả lệnh tính theo
 * quy tắc dùng chung với bộ theo dõi tín hiệu (TP1/SL, cùng nến chạm cả hai tính SL, hết hạn sau N nến).
 */
const { EMA, ATR } = require('technicalindicators');
const CONFIG = require('../config');
const { evaluateAllStrategies } = require('../strategies');
const { getMinScore, SignalCooldown } = require('../signalFilter');
const { checkCandleHit, rMultiple, primaryStrategyName } = require('../tradeOutcome');
const { CANDLE_LIMIT, timeframeToMs, resolveSymbolSources } = require('../services/marketData');

// Tiêu chí "đạt chuẩn" (đặt trước khi xem kết quả): lãi ròng ở cả giai đoạn đầu và sau,
// vượt lệnh ngẫu nhiên cùng chiều xu hướng với p < 0.05, đủ số lệnh, profit factor đủ cao
const PASS_CRITERIA = { minTrades: 100, maxP: 0.05, minProfitFactor: 1.2, splitRatio: 0.6 };
const RANDOM_SEEDS = 200;
// Số nến tải cho từng khung (gồm CANDLE_LIMIT nến khởi tạo), dùng chung cho CLI và báo cáo để ra cùng kết quả.
// TradingView ẩn danh giới hạn lịch sử: 15m ~5.500 nến, 30m từ đầu năm nay, 1h/2h từ năm trước, 4h ~4 năm, 1D ~40 năm
const DEFAULT_BARS = { '15m': 6000, '30m': 10000, '1h': 11000, '2h': 8000, '4h': 6000, '1d': 10000 };
// Phiên bản cấu trúc báo cáo backtest: tăng khi đổi cấu trúc để bot tự tạo lại báo cáo cũ lúc khởi động
// (2: thêm danh sách lệnh của từng phương pháp để dashboard lọc theo khoảng thời gian)
const REPORT_VERSION = 2;
const TRADE_LOG_FIELDS = ['entryMinute', 'side', 'outcome', 'netR'];
const OUTCOME_CODE = { TP: 1, SL: -1, EXPIRED: 0 };

/**
 * Chi phí mỗi lệnh quy về đơn vị giá: Vàng spread $0.35/oz, Crypto phí 0.1% x 2 chiều
 */
function tradeCost(symbol, entry, spreadOverride = null) {
  if (spreadOverride != null) return spreadOverride;
  return resolveSymbolSources(symbol).isCrypto ? entry * 0.002 : 0.35;
}

function costLabel(symbol, spreadOverride = null) {
  if (spreadOverride != null) return `spread $${spreadOverride}`;
  return resolveSymbolSources(symbol).isCrypto ? 'phí 0.1% x 2 chiều' : 'spread $0.35/oz';
}

function toMarketData(candles, { hasRealDelta = false, isCrypto = false } = {}) {
  return {
    candles,
    closes: candles.map((c) => c.close),
    highs: candles.map((c) => c.high),
    lows: candles.map((c) => c.low),
    opens: candles.map((c) => c.open),
    volumes: candles.map((c) => c.volume),
    hasRealDelta,
    isCrypto,
  };
}

/**
 * Kết quả một lệnh: chạm TP1, chạm SL, hoặc hết hạn sau `horizon` nến thì chốt theo giá đóng cửa
 */
function simulate(candles, index, signal, horizon) {
  const lastIndex = Math.min(candles.length - 1, index + horizon);
  for (let j = index + 1; j <= lastIndex; j++) {
    const hit = checkCandleHit(signal, candles[j]);
    if (hit) return { outcome: hit, r: rMultiple(signal, hit === 'SL' ? signal.stopLoss : signal.takeProfit) };
  }
  // open: hết dữ liệu trước khi đủ horizon, lệnh còn đang mở và R chỉ là tạm tính
  return { outcome: 'EXPIRED', r: rMultiple(signal, candles[lastIndex].close), open: lastIndex < index + horizon };
}

function toTrade(candles, index, signal, { symbol, horizon, spread }) {
  const risk = Math.abs(signal.entry - signal.stopLoss);
  const { outcome, r, open = false } = simulate(candles, index, signal, horizon);
  return {
    index,
    time: candles[index].date.getTime(),
    strategy: primaryStrategyName(signal.strategy),
    action: signal.action,
    score: signal.score,
    outcome,
    open,
    r,
    net: r - tradeCost(symbol, signal.entry, spread) / risk,
  };
}

/**
 * Backtest walk-forward trên chuỗi nến đã đóng
 * @param {object} params
 * @param {string} params.symbol
 * @param {Array<object>} params.candles - Nến đã đóng, cũ nhất -> mới nhất
 * @param {string} params.timeframe
 * @param {Array<object>} [params.strategies] - Chạy gộp theo đúng quy trình bot (hợp lưu, xung đột, ngưỡng điểm, cooldown)
 * @param {Array<object>} [params.standalone] - Chạy riêng từng chiến lược (mỗi chiến lược có cooldown riêng)
 * @returns {{ combined: Array<object>, perStrategy: Map<string, Array<object>>, warmup: number }}
 */
function runBacktest({ symbol, candles, timeframe, strategies = [], standalone = [], horizon = CONFIG.signalTrackHorizonBars, spread = null, hasRealDelta = false, isCrypto, warmup = CANDLE_LIMIT - 1 }) {
  const crypto = isCrypto ?? resolveSymbolSources(symbol).isCrypto;
  const windowMs = timeframeToMs(timeframe);
  const combined = [];
  const combinedCooldown = new SignalCooldown(CONFIG.signalCooldownBars, windowMs);
  const perStrategy = new Map(standalone.map((s) => [s.key, []]));
  const ownCooldown = new Map(standalone.map((s) => [s.key, new SignalCooldown(CONFIG.signalCooldownBars, windowMs)]));
  const opts = { symbol, horizon, spread };

  for (let i = warmup; i < candles.length - 1; i++) {
    const marketData = toMarketData(candles.slice(Math.max(0, i + 1 - CANDLE_LIMIT), i + 1), { hasRealDelta, isCrypto: crypto });
    const candleTime = candles[i].date.getTime();

    if (strategies.length > 0) {
      for (const signal of evaluateAllStrategies(marketData, { silent: true, strategies })) {
        if (signal.score < getMinScore(signal)) continue;
        if (combinedCooldown.isCoolingDown(symbol, signal.action, candleTime)) continue;
        combinedCooldown.record(symbol, signal.action, candleTime);
        combined.push(toTrade(candles, i, signal, opts));
      }
    }

    for (const strat of standalone) {
      let signal = null;
      try {
        signal = strat.analyze(marketData);
      } catch (e) {}
      if (!signal || signal.score < getMinScore(signal)) continue;
      const cooldown = ownCooldown.get(strat.key);
      if (cooldown.isCoolingDown(symbol, signal.action, candleTime)) continue;
      cooldown.record(symbol, signal.action, candleTime);
      perStrategy.get(strat.key).push(toTrade(candles, i, signal, opts));
    }
  }

  return { combined, perStrategy, warmup };
}

const avg = (list, key = 'net') => (list.length ? list.reduce((a, t) => a + t[key], 0) / list.length : 0);
const round = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

/**
 * Thống kê một danh sách lệnh; splitIndex tách giai đoạn đầu / giai đoạn sau
 */
function summarize(allTrades, splitIndex) {
  // Lệnh còn mở ở cuối dữ liệu chưa có kết quả (R chỉ là tạm tính) nên không tính vào thống kê
  const trades = allTrades.filter((t) => !t.open);
  const wins = trades.filter((t) => t.outcome === 'TP').length;
  const losses = trades.filter((t) => t.outcome === 'SL').length;
  let cum = 0, peak = 0, maxDrawdown = 0, gain = 0, loss = 0;
  for (const t of trades) {
    cum += t.net;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
    if (t.net > 0) gain += t.net; else loss -= t.net;
  }
  const early = trades.filter((t) => t.index < splitIndex);
  const late = trades.filter((t) => t.index >= splitIndex);
  const buys = trades.filter((t) => t.action === 'BUY');
  const sells = trades.filter((t) => t.action === 'SELL');
  return {
    trades: trades.length,
    wins,
    losses,
    expired: trades.length - wins - losses,
    winRate: wins + losses > 0 ? round(wins / (wins + losses), 4) : null,
    avgR: round(avg(trades, 'r')),
    avgNet: round(avg(trades)),
    totalNet: round(cum, 1),
    profitFactor: loss > 0 ? round(gain / loss, 2) : null,
    maxDrawdown: round(maxDrawdown, 1),
    early: { trades: early.length, avgNet: round(avg(early)) },
    late: { trades: late.length, avgNet: round(avg(late)) },
    buy: { trades: buys.length, avgNet: round(avg(buys)) },
    sell: { trades: sells.length, avgNet: round(avg(sells)) },
  };
}

/**
 * Danh sách lệnh đã đóng dạng gọn (theo TRADE_LOG_FIELDS) để dashboard tính lại thống kê theo khoảng thời gian:
 * [phút vào lệnh (Unix ms / 60000, lúc nến tín hiệu đóng), chiều (1 MUA, -1 BÁN), kết quả (1 TP, -1 SL, 0 hết hạn), R sau chi phí]
 */
function tradeLog(trades, timeframe) {
  const windowMs = timeframeToMs(timeframe);
  return trades
    .filter((t) => !t.open)
    .map((t) => [Math.round((t.time + windowMs) / 60000), t.action === 'BUY' ? 1 : -1, OUTCOME_CODE[t.outcome], round(t.net)]);
}

// PRNG có seed để phép đối chứng cho kết quả lặp lại được
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Đối chứng: vào lệnh ở các nến ngẫu nhiên theo chiều EMA200, SL 1.5 ATR / TP 2R, cùng số lệnh và cùng chi phí.
 * Trả về p = tỉ lệ lần ngẫu nhiên đạt R/lệnh >= kết quả thật (p nhỏ = khó là may mắn).
 */
function randomControl({ symbol, candles, timeframe, count, realAvgNet, horizon = CONFIG.signalTrackHorizonBars, spread = null, warmup = CANDLE_LIMIT - 1, seeds = RANDOM_SEEDS }) {
  if (!count) return { p: null, randomAvgNet: null };
  const closes = candles.map((c) => c.close);
  const emaRaw = EMA.calculate({ period: 200, values: closes });
  const atrRaw = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: closes });
  const emaAt = (i) => emaRaw[i - (closes.length - emaRaw.length)];
  const atrAt = (i) => atrRaw[i - (closes.length - atrRaw.length)];
  const valid = [];
  for (let i = warmup; i < candles.length - 1; i++) if (emaAt(i) != null && atrAt(i) > 0) valid.push(i);
  if (valid.length === 0) return { p: null, randomAvgNet: null };

  const windowMs = timeframeToMs(timeframe);
  const results = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const rand = mulberry32(seed);
    const picked = new Set();
    while (picked.size < Math.min(count, valid.length)) picked.add(valid[Math.floor(rand() * valid.length)]);
    const cooldown = new SignalCooldown(CONFIG.signalCooldownBars, windowMs);
    const trades = [];
    for (const i of [...picked].sort((a, b) => a - b)) {
      const action = candles[i].close > emaAt(i) ? 'BUY' : 'SELL';
      const t = candles[i].date.getTime();
      if (cooldown.isCoolingDown(symbol, action, t)) continue;
      cooldown.record(symbol, action, t);
      const d = action === 'BUY' ? 1 : -1;
      const risk = 1.5 * atrAt(i);
      const entry = candles[i].close;
      const signal = { strategy: 'Random', action, entry, stopLoss: entry - d * risk, takeProfit: entry + d * 2 * risk };
      trades.push(toTrade(candles, i, signal, { symbol, horizon, spread }));
    }
    results.push(avg(trades.filter((t) => !t.open)));
  }
  return {
    p: round(results.filter((v) => v >= realAvgNet).length / seeds),
    randomAvgNet: round(avg(results.map((v) => ({ net: v })))),
  };
}

/**
 * Đánh giá theo tiêu chí đạt chuẩn
 */
function passes(summary, p) {
  return summary.trades >= PASS_CRITERIA.minTrades
    && summary.early.avgNet > 0 && summary.late.avgNet > 0
    && p != null && p < PASS_CRITERIA.maxP
    && summary.profitFactor != null && summary.profitFactor >= PASS_CRITERIA.minProfitFactor;
}

module.exports = {
  PASS_CRITERIA,
  DEFAULT_BARS,
  REPORT_VERSION,
  TRADE_LOG_FIELDS,
  tradeLog,
  tradeCost,
  costLabel,
  toMarketData,
  simulate,
  runBacktest,
  summarize,
  randomControl,
  passes,
};

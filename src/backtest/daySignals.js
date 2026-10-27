/**
 * Kiểm tra một ngày (giờ Việt Nam): các phương pháp đang bật (STRATEGIES) cho tín hiệu gì, chạy đúng quy trình bot
 * như backtest (hợp lưu, xung đột, ngưỡng điểm, cooldown; chưa gồm AI và chặn tin tức), kèm kết quả từng lệnh tới hiện tại
 * và tín hiệu bot thật đã ghi nhận trong ngày để đối chiếu. Dùng chung cho `npm run backtest:day` và dashboard.
 */
const CONFIG = require('../config');
const { fetchTradingViewHistory, resolveSymbolSources, timeframeToMs, CANDLE_LIMIT } = require('../services/marketData');
const { listSignals } = require('../services/signalTracker');
const { runBacktest, toMarketData, costLabel } = require('./engine');
const { primaryStrategyName } = require('../tradeOutcome');
const { dayKey, dayStart, loadCandles } = require('./monthly');

const DAY_MS = 86400e3;
const ACTION_LABELS = { BUY: 'MUA', SELL: 'BÁN' };
const clockFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });

/**
 * Đọc ngày dạng 'YYYY-MM-DD', 'DD/MM/YYYY' hoặc 'DD/MM' (năm nay, giờ VN). Trả về 'YYYY-MM-DD', null nếu không hợp lệ
 */
function parseDay(text, now = Date.now()) {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const parts = m ? [m[1], m[2], m[3]] : (m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text)) ? [m[3] || dayKey(now).slice(0, 4), m[2], m[1]] : null;
  if (!parts) return null;
  const key = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  // Loại ngày không tồn tại (vd: 31/02)
  const date = new Date(`${key}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : null;
}

const round = (v, d = 2) => +v.toFixed(d);

/**
 * Lý do bot không phát tín hiệu riêng của một phương pháp: ngược chiều với phương pháp khác cùng nến (bot bỏ cả hai chiều),
 * hoặc bot vừa phát cùng chiều trong khoảng cooldown
 */
function skipReason(trade, raw, combined, tfMs) {
  const opposite = raw.filter((s) => s.action !== trade.action);
  if (opposite.length > 0) {
    return `ngược chiều với ${opposite.map((s) => `${primaryStrategyName(s.strategy)} ${ACTION_LABELS[s.action]}`).join(', ')} cùng nến, bot bỏ cả hai chiều`;
  }
  const recent = combined.find((c) => c.action === trade.action && c.time < trade.time && trade.time - c.time < CONFIG.signalCooldownBars * tfMs);
  if (recent) return `bot vừa phát ${ACTION_LABELS[recent.action]} lúc ${clockFmt.format(recent.time + tfMs)} (cooldown ${CONFIG.signalCooldownBars} nến)`;
  return 'bị lọc theo quy trình bot';
}

/**
 * Tín hiệu trong ngày `day` của một tài sản
 * @param {string} symbol
 * @param {Map<string, Array<object>>} plan - Khung thời gian -> chiến lược đang bật (getStrategyPlan)
 * @param {string} day - 'YYYY-MM-DD' theo giờ Việt Nam
 */
async function daySignalsFor(symbol, plan, day) {
  const sources = resolveSymbolSources(symbol);
  const start = dayStart(day);
  const end = start + DAY_MS;
  // Phân tích từ trước 0h đủ 2 lần cooldown để tín hiệu cùng chiều ngay trước ngày vẫn chặn tín hiệu trong ngày như khi bot chạy liên tục
  const sinceOf = (tf) => start - 2 * CONFIG.signalCooldownBars * timeframeToMs(tf);
  const tvCache = new Map();
  const fetchTv = (tf) => {
    if (!tvCache.has(tf)) {
      const bars = Math.ceil((Date.now() - sinceOf(tf)) / timeframeToMs(tf)) + CANDLE_LIMIT + 50;
      tvCache.set(tf, fetchTradingViewHistory(sources.tradingViewSymbol, tf, bars));
    }
    return tvCache.get(tf);
  };

  const timeframes = [];
  for (const [timeframe, active] of plan) {
    const keys = active.map((s) => s.key);
    try {
      const tfMs = timeframeToMs(timeframe);
      const since = sinceOf(timeframe);
      const { candles, source, fallback } = await loadCandles(symbol, timeframe, since, fetchTv);
      const entryOf = (i) => candles[i].date.getTime() + tfMs;
      if (candles.length < CANDLE_LIMIT || entryOf(CANDLE_LIMIT - 1) > start) {
        timeframes.push({ timeframe, keys, source, error: 'Nguồn dữ liệu chưa có đủ lịch sử tới ngày này' });
        continue;
      }
      // Đoạn nến cần phân tích; rỗng nếu ngày không có nến (cuối tuần, ngày lễ, hôm nay chưa có nến đóng)
      const indexFrom = (t) => {
        const i = candles.findIndex((c, k) => k >= CANDLE_LIMIT - 1 && entryOf(k) >= t);
        return i < 0 ? candles.length : i;
      };
      const first = indexFrom(since);
      const stop = indexFrom(end);

      // Phân tích cả nến đóng gần nhất như bot thật (lệnh vào ở nến đó còn đang mở)
      const { combined, perStrategy } = runBacktest({
        symbol, candles, timeframe, strategies: active, standalone: active.length > 1 ? active : [], warmup: first, end: stop,
      });
      const inDay = (t) => t.time + tfMs >= start && t.time + tfMs < end;
      const toSignal = (t) => ({
        time: new Date(t.time + tfMs).toISOString(),
        strategy: t.strategy,
        action: t.action,
        score: t.score,
        entry: round(t.entry),
        stopLoss: round(t.stopLoss),
        takeProfit: round(t.takeProfit),
        outcome: t.outcome,
        open: t.open,
        exitTime: new Date(t.exitTime).toISOString(),
        r: round(t.r),
        net: round(t.net),
      });

      const standalone = [...perStrategy.values()].flat().filter(inDay).sort((a, b) => a.time - b.time);
      const signals = combined.filter(inDay).map((t) => ({
        ...toSignal(t),
        // Các phương pháp cùng chiều trên cùng nến, gộp thành tín hiệu này (hợp lưu)
        allies: standalone.filter((s) => s.index === t.index && s.action === t.action && s.strategy !== t.strategy).map((s) => s.strategy),
      }));
      const marketDataAt = (i) => toMarketData(candles.slice(Math.max(0, i + 1 - CANDLE_LIMIT), i + 1), { isCrypto: sources.isCrypto });
      const skipped = standalone
        .filter((t) => !combined.some((c) => c.index === t.index && c.action === t.action))
        .map((t) => {
          const md = marketDataAt(t.index);
          const raw = active.map((s) => {
            try {
              return s.analyze(md);
            } catch (e) {
              return null;
            }
          }).filter(Boolean);
          return { ...toSignal(t), reason: skipReason(t, raw, combined, tfMs) };
        });

      timeframes.push({
        timeframe,
        keys,
        source,
        fallback,
        candles: stop - indexFrom(start),
        dataTo: new Date(candles[candles.length - 1].date.getTime() + tfMs).toISOString(),
        signals,
        skipped,
      });
    } catch (err) {
      timeframes.push({ timeframe, keys, error: err.message });
    }
  }

  // Tín hiệu bot thật đã ghi nhận (gồm cả tín hiệu bị AI từ chối), theo ngày của thời điểm vào lệnh
  const live = listSignals()
    .filter((rec) => rec.symbol === symbol && dayKey(Date.parse(rec.candleTime) + timeframeToMs(rec.timeframe || CONFIG.timeframe)) === day)
    .map((rec) => ({
      time: new Date(Date.parse(rec.candleTime) + timeframeToMs(rec.timeframe || CONFIG.timeframe)).toISOString(),
      timeframe: rec.timeframe || CONFIG.timeframe,
      strategy: rec.strategy,
      action: rec.action,
      score: rec.score,
      entry: round(rec.entry),
      stopLoss: round(rec.stopLoss),
      takeProfit: round(rec.takeProfit),
      sent: rec.sent,
      status: rec.status,
      r: rec.r != null ? round(rec.r) : null,
    }))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  return { symbol, displayName: sources.displayName, day, cost: costLabel(symbol), generatedAt: new Date().toISOString(), timeframes, live };
}

module.exports = {
  parseDay,
  daySignalsFor,
};

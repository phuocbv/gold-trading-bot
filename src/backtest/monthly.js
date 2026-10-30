/**
 * Backtest theo tháng và theo ngày cho các phương pháp đang bật (STRATEGIES) trong một năm, dùng chung cho
 * `npm run backtest:monthly` và mục "Theo tháng", "Theo ngày" trên dashboard. Mỗi khung chạy đúng quy trình bot
 * (hợp lưu, xung đột, ngưỡng điểm, cooldown); tháng và ngày tính theo giờ Việt Nam của thời điểm vào lệnh.
 */
const { fetchTradingViewHistory, fetchBinanceHistory, resolveSymbolSources, getClosedCandles, timeframeToMs, CANDLE_LIMIT } = require('../services/marketData');
const { runBacktest, summarize, costLabel, DEFAULT_BARS } = require('./engine');
const { primaryStrategyName } = require('../tradeOutcome');

const HOUR_MS = 3600e3;
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
// 'YYYY-MM-DD' và 'YYYY-MM' theo giờ Việt Nam, so sánh chuỗi được như so sánh thời gian
const dayKey = (t) => dayFmt.format(new Date(t));
const monthKey = (t) => dayKey(t).slice(0, 7);
// Thời điểm 0h của ngày 'YYYY-MM-DD' theo giờ Việt Nam (UTC+7, không đổi giờ mùa hè)
const dayStart = (day) => Date.parse(`${day}T00:00:00+07:00`);

/**
 * Các tháng của năm cần thống kê: tới tháng hiện tại nếu là năm nay
 */
function monthsOf(year, now = Date.now()) {
  const last = monthKey(now) < `${year}-12` ? monthKey(now) : `${year}-12`;
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    if (key <= last) months.push(key);
  }
  return months;
}

// Thời điểm vào lệnh đầu tiên có thể backtest (sau CANDLE_LIMIT nến khởi tạo chỉ báo)
function firstEntry(candles, timeframe) {
  return candles.length > CANDLE_LIMIT ? candles[CANDLE_LIMIT - 1].date.getTime() + timeframeToMs(timeframe) : Infinity;
}

/**
 * Nến đã đóng đủ để vào lệnh từ thời điểm `since` tới nay. Ưu tiên TradingView (nguồn bot dùng khi chạy thật); nếu lịch sử
 * TradingView ẩn danh không về tới `since` (vd: 15m chỉ ~5.500 nến) thì dùng Binance cho cả giai đoạn để không nối hai nguồn:
 * Crypto lấy Binance Spot (cùng dữ liệu với mã BINANCE: trên TradingView), Vàng khung <= 1h lấy hợp đồng
 * XAUUSDT Binance Futures và chỉ giữ các nến trong giờ OANDA có giao dịch (theo nến 1h OANDA, khớp cả ngày lễ).
 */
async function loadCandles(symbol, timeframe, since, fetchTv) {
  const sources = resolveSymbolSources(symbol);
  const closed = (candles) => getClosedCandles({ candles }, timeframe).candles;
  const covers = (candles) => firstEntry(candles, timeframe) <= since;
  const tv = closed(await fetchTv(timeframe));
  const primary = { candles: tv, source: `TradingView (${sources.tradingViewSymbol})`, fallback: false };
  if (covers(tv)) return primary;

  const tfMs = timeframeToMs(timeframe);
  // Binance chạy 24/7 nên số nến theo thời gian là đủ; thêm dư cho phần khởi tạo và nến bị lọc ngoài giờ
  const bars = Math.ceil((Date.now() - since) / tfMs) + 2 * CANDLE_LIMIT;
  try {
    let alt = null;
    if (sources.isCrypto) {
      alt = { candles: await fetchBinanceHistory(sources.binanceSymbol, timeframe, bars), source: `Binance Spot (${sources.binanceSymbol})` };
    } else if (sources.binanceFuturesSymbol && tfMs <= HOUR_MS) {
      const hourOf = (c) => Math.floor(c.date.getTime() / HOUR_MS) * HOUR_MS;
      const tradingHours = new Set((await fetchTv('1h')).map(hourOf));
      const raw = await fetchBinanceHistory(sources.binanceFuturesSymbol, timeframe, bars, { futures: true });
      alt = {
        candles: raw.filter((c) => tradingHours.has(hourOf(c))),
        source: `Binance Futures ${sources.binanceFuturesSymbol} (lọc theo giờ giao dịch ${sources.tradingViewSymbol})`,
      };
    }
    if (alt) {
      alt.candles = closed(alt.candles);
      if (firstEntry(alt.candles, timeframe) < firstEntry(tv, timeframe)) return { ...alt, fallback: true };
    }
  } catch (err) {
    console.warn(`⚠️ [Backtest] ${symbol} ${timeframe}: không tải được dữ liệu Binance thay thế (${err.message}), dùng TradingView.`);
  }
  return primary;
}

/**
 * Thống kê một nhóm lệnh; lệnh còn mở ở cuối dữ liệu không tính vào thắng% và R
 */
function stats(trades) {
  const closed = trades.filter((t) => !t.open);
  const s = summarize(closed, Infinity);
  const avgNet = (outcome) => {
    const list = closed.filter((t) => t.outcome === outcome);
    return list.length ? list.reduce((a, t) => a + t.net, 0) / list.length : null;
  };
  // Tỉ lệ thắng hòa vốn (theo cùng định nghĩa thắng% = TP / (TP + SL)), tính cả phần lãi/lỗ của lệnh hết hạn:
  // n·w·R_thắng + n·(1 - w)·R_thua + tổng R hết hạn = 0
  const win = avgNet('TP');
  const loss = avgNet('SL');
  const decided = s.wins + s.losses;
  const expiredNet = closed.filter((t) => t.outcome === 'EXPIRED').reduce((a, t) => a + t.net, 0);
  const breakEven = decided > 0 && win > 0 && loss < 0
    ? Math.min(1, Math.max(0, (-loss - expiredNet / decided) / (win - loss)))
    : null;
  return {
    trades: trades.length,
    wins: s.wins,
    losses: s.losses,
    expired: s.expired,
    open: trades.length - closed.length,
    winRate: s.winRate,
    avgNet: s.avgNet,
    totalNet: s.totalNet,
    profitFactor: s.profitFactor,
    breakEven: breakEven == null ? null : +breakEven.toFixed(4),
  };
}

/**
 * Thống kê từng ngày có lệnh, kèm danh sách lệnh của ngày đó theo thứ tự thời gian
 */
function byDay(trades) {
  const groups = new Map();
  for (const t of [...trades].sort((a, b) => a.entryTime - b.entryTime)) groups.set(t.day, [...(groups.get(t.day) || []), t]);
  return Object.fromEntries([...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, list]) => [day, {
    ...stats(list),
    list: list.map((t) => ({
      time: new Date(t.entryTime).toISOString(),
      strategy: t.strategy,
      timeframe: t.timeframe,
      action: t.action,
      outcome: t.outcome,
      open: t.open,
      net: +t.net.toFixed(2),
    })),
  }]));
}

/**
 * Một dòng của bảng: thống kê cả năm, từng tháng và từng ngày có lệnh. coverage của tháng: 'none' (chưa có dữ liệu),
 * 'partial' (dữ liệu bắt đầu giữa tháng, hoặc với dòng Toàn bot: chỉ một số khung có dữ liệu) hoặc 'full'
 * @param {number|Array<number>} from - Thời điểm vào lệnh đầu tiên có dữ liệu (dòng Toàn bot: của từng khung)
 */
function buildRow(row, trades, months, from) {
  const froms = [].concat(from);
  const firstMonth = monthKey(Math.min(...froms));
  const lastMonth = monthKey(Math.max(...froms));
  return {
    ...row,
    from: new Date(Math.min(...froms)).toISOString(),
    year: stats(trades),
    months: Object.fromEntries(months.map((m) => [m, {
      ...stats(trades.filter((t) => t.month === m)),
      coverage: m < firstMonth ? 'none' : m <= lastMonth ? 'partial' : 'full',
    }])),
    days: byDay(trades),
  };
}

/**
 * Backtest theo tháng của một tài sản
 * @param {string} symbol
 * @param {Map<string, Array<object>>} plan - Khung thời gian -> chiến lược đang bật (getStrategyPlan)
 * @param {number} year
 */
async function monthlyReportFor(symbol, plan, year) {
  const sources = resolveSymbolSources(symbol);
  const months = monthsOf(year);
  const tvCache = new Map();
  const fetchTv = (tf) => {
    if (!tvCache.has(tf)) {
      const request = fetchTradingViewHistory(sources.tradingViewSymbol, tf, DEFAULT_BARS[tf] || 6000);
      // Lỗi tạm thời không được giữ trong cache, để khung dùng lại dữ liệu này còn tải lại được
      request.catch(() => tvCache.delete(tf));
      tvCache.set(tf, request);
    }
    return tvCache.get(tf);
  };

  const timeframes = [];
  const rows = [];
  const botTrades = [];
  const botFrom = [];
  for (const [timeframe, active] of plan) {
    const keys = active.map((s) => s.key);
    try {
      const { candles, source, fallback } = await loadCandles(symbol, timeframe, dayStart(`${year}-01-01`), fetchTv);
      if (candles.length <= CANDLE_LIMIT) {
        timeframes.push({ timeframe, keys, source, error: `Chỉ có ${candles.length} nến, cần hơn ${CANDLE_LIMIT}` });
        continue;
      }
      const tfMs = timeframeToMs(timeframe);
      const from = firstEntry(candles, timeframe);
      // Vào lệnh ở giá đóng cửa nến tín hiệu nên thời điểm vào lệnh là lúc nến đóng
      const inYear = (trades) => trades
        .map((t) => {
          const entryTime = t.time + tfMs;
          const day = dayKey(entryTime);
          return { ...t, timeframe, entryTime, day, month: day.slice(0, 7) };
        })
        .filter((t) => t.month.startsWith(`${year}-`));

      // Khung chỉ có một phương pháp thì chạy gộp cũng chính là chạy riêng phương pháp đó
      const { combined, perStrategy } = runBacktest({ symbol, candles, timeframe, strategies: active, standalone: active.length > 1 ? active : [] });
      const bot = inYear(combined);
      if (active.length > 1) {
        for (const s of active) {
          rows.push(buildRow({ kind: 'strategy', key: s.key, label: primaryStrategyName(s.name), timeframe }, inYear(perStrategy.get(s.key)), months, from));
        }
        rows.push(buildRow({ kind: 'combined', keys, label: `Gộp ${active.length} phương pháp`, timeframe }, bot, months, from));
      } else {
        rows.push(buildRow({ kind: 'strategy', key: keys[0], label: primaryStrategyName(active[0].name), timeframe }, bot, months, from));
      }
      botTrades.push(...bot);
      botFrom.push(from);
      timeframes.push({
        timeframe,
        keys,
        source,
        fallback,
        from: new Date(from).toISOString(),
        to: candles[candles.length - 1].date.toISOString(),
      });
    } catch (err) {
      timeframes.push({ timeframe, keys, error: err.message });
    }
  }

  if (botFrom.length > 1) {
    // Khung nào không có dữ liệu từ đầu năm thì dòng Toàn bot chỉ gồm các khung còn lại ở những tháng đó
    const missing = timeframes.filter((t) => t.error || monthKey(Date.parse(t.from)) >= `${year}-01`).map((t) => t.timeframe);
    const label = missing.length ? `Toàn bot (thiếu dữ liệu đầu năm khung ${missing.join(', ')})` : 'Toàn bot';
    rows.push(buildRow({ kind: 'total', label, timeframe: null }, botTrades, months, botFrom));
  }
  return { symbol, displayName: sources.displayName, cost: costLabel(symbol), timeframes, rows };
}

module.exports = {
  dayKey,
  dayStart,
  monthsOf,
  loadCandles,
  monthlyReportFor,
};

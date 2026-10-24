/**
 * Backtest walk-forward toàn bộ chiến lược với đúng quy trình lọc của bot (ngưỡng điểm + cooldown), không gồm AI.
 *
 * Cách dùng:
 *   node scripts/backtest.js                       # các mã trong SYMBOLS, dữ liệu TradingView
 *   node scripts/backtest.js XAU/USD --bars 5000   # số nến lịch sử (TradingView tối đa ~5000)
 *   node scripts/backtest.js ETH/USDT --binance    # dữ liệu Binance có Delta thật
 *   --horizon 48                                   # số nến tối đa giữ lệnh trước khi chốt theo giá đóng cửa
 *
 * Các nến đầu (CANDLE_LIMIT) chỉ dùng để khởi tạo chỉ báo, không giao dịch.
 * Kết quả tính theo R (1R = khoảng cách Entry -> SL), chỉ xét TP1, chưa trừ spread/phí.
 * Nếu SL và TP1 cùng nằm trong một nến thì tính là chạm SL (giả định bi quan).
 */
const axios = require('axios');
const CONFIG = require('../src/config');
const { fetchTradingViewCandles, resolveSymbolSources, getClosedCandles, timeframeToMs, CANDLE_LIMIT } = require('../src/services/marketData');
const { evaluateAllStrategies } = require('../src/strategies');
const { getMinScore, SignalCooldown } = require('../src/signalFilter');
const { checkCandleHit, rMultiple, primaryStrategyName } = require('../src/tradeOutcome');

const WINDOW = CANDLE_LIMIT; // Số nến đưa vào mỗi lần phân tích, giống dữ liệu bot tải khi chạy thật
// Chỉ bắt đầu khi đủ WINDOW nến để chỉ báo (EMA200) giống hệt lúc bot chạy thật; các nến trước đó chỉ dùng để khởi tạo
const WARMUP = WINDOW - 1;

function parseArgs(argv) {
  const args = { symbols: [], bars: 5000, horizon: 48, binance: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bars') args.bars = parseInt(argv[++i], 10);
    else if (argv[i] === '--horizon') args.horizon = parseInt(argv[++i], 10);
    else if (argv[i] === '--binance') args.binance = true;
    else args.symbols.push(argv[i]);
  }
  if (args.symbols.length === 0) args.symbols = CONFIG.symbols;
  return args;
}

async function fetchBinanceHistory(binanceSymbol, interval, bars) {
  let endTime = Date.now();
  let rows = [];
  while (rows.length < bars) {
    const limit = Math.min(1000, bars - rows.length);
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (!Array.isArray(data) || data.length === 0) break;
    rows = data.concat(rows);
    endTime = data[0][0] - 1;
  }
  return rows.map((k) => {
    const volume = parseFloat(k[5]);
    const buyVolume = parseFloat(k[9] || 0);
    return {
      date: new Date(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume,
      delta: buyVolume - (volume - buyVolume),
    };
  });
}

async function loadCandles(symbol, args) {
  const sources = resolveSymbolSources(symbol);
  if (args.binance) {
    const candles = await fetchBinanceHistory(sources.binanceSymbol, CONFIG.timeframe, args.bars);
    return { candles, hasRealDelta: true, isCrypto: sources.isCrypto, source: `Binance (${sources.binanceSymbol})` };
  }
  const data = await fetchTradingViewCandles(sources.tradingViewSymbol, CONFIG.timeframe, args.bars);
  return { candles: data.candles, hasRealDelta: false, isCrypto: sources.isCrypto, source: data.source };
}

function toMarketData(candles, hasRealDelta, isCrypto) {
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
 * Kết quả lệnh tính theo R: chạm TP1 = +R:R, chạm SL = -1, hết horizon = lãi/lỗ theo giá đóng cửa
 */
function simulate(candles, index, signal, horizon) {
  const lastIndex = Math.min(candles.length - 1, index + horizon);

  for (let j = index + 1; j <= lastIndex; j++) {
    const hit = checkCandleHit(signal, candles[j]);
    if (hit) return { outcome: hit, r: rMultiple(signal, hit === 'SL' ? signal.stopLoss : signal.takeProfit) };
  }
  return { outcome: 'OPEN', r: rMultiple(signal, candles[lastIndex].close) };
}

function summarize(trades) {
  const wins = trades.filter((t) => t.outcome === 'TP').length;
  const losses = trades.filter((t) => t.outcome === 'SL').length;
  const totalR = trades.reduce((sum, t) => sum + t.r, 0);
  return {
    trades: trades.length,
    winRate: wins + losses > 0 ? `${Math.round((wins / (wins + losses)) * 100)}%` : '-',
    avgR: trades.length > 0 ? +(totalR / trades.length).toFixed(3) : 0,
    totalR: +totalR.toFixed(1),
  };
}

async function backtestSymbol(symbol, args) {
  const { candles: allCandles, hasRealDelta, isCrypto, source } = await loadCandles(symbol, args);
  const candles = getClosedCandles({ candles: allCandles }, CONFIG.timeframe).candles;
  if (candles.length < WARMUP + 2) {
    console.log(`\n⚠️ ${symbol}: chỉ có ${candles.length} nến đã đóng, cần tối thiểu ${WARMUP + 2} (${WINDOW} nến khởi tạo chỉ báo). Tăng --bars.`);
    return;
  }
  const cooldown = new SignalCooldown(CONFIG.signalCooldownBars, timeframeToMs(CONFIG.timeframe));
  const trades = [];

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const marketData = toMarketData(candles.slice(Math.max(0, i + 1 - WINDOW), i + 1), hasRealDelta, isCrypto);
    const candleTime = candles[i].date.getTime();

    for (const signal of evaluateAllStrategies(marketData, { silent: true })) {
      if (signal.score < getMinScore(signal)) continue;
      if (cooldown.isCoolingDown(symbol, signal.action, candleTime)) continue;
      cooldown.record(symbol, signal.action, candleTime);

      const primary = primaryStrategyName(signal.strategy);
      trades.push({ primary, score: signal.score, ...simulate(candles, i, signal, args.horizon) });
    }
  }

  const from = candles[WARMUP].date.toISOString().slice(0, 10);
  const to = candles[candles.length - 1].date.toISOString().slice(0, 10);
  console.log(`\n📊 ${symbol} | ${source} | ${CONFIG.timeframe} | ${from} → ${to} | horizon ${args.horizon} nến`);

  const rows = {};
  for (const name of [...new Set(trades.map((t) => t.primary))].sort()) {
    rows[name] = summarize(trades.filter((t) => t.primary === name));
  }
  rows['TỔNG'] = summarize(trades);
  console.table(rows);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const symbol of args.symbols) {
    try {
      await backtestSymbol(symbol, args);
    } catch (err) {
      console.error(`❌ Backtest ${symbol} thất bại:`, err.message);
    }
  }
  console.log('\nLưu ý: chưa gồm bộ lọc AI, spread và phí giao dịch. Kết quả quá khứ không đảm bảo tương lai.');
  process.exit(0);
}

main();

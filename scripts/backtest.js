/**
 * Backtest walk-forward với đúng quy trình lọc của bot (hợp lưu, ngưỡng điểm, cooldown), không gồm AI.
 *
 * Cách dùng:
 *   node scripts/backtest.js                          # các mã trong SYMBOLS, mọi khung trong STRATEGIES
 *   node scripts/backtest.js XAU/USD --timeframe 4h   # chỉ một khung (chiến lược theo STRATEGIES của khung đó)
 *   --strategies donchian-55,trend-following          # chọn chiến lược (bỏ qua STRATEGIES)
 *   --bars 6000                                       # số nến lịch sử (mặc định như báo cáo: 15m 6000, 30m 10000, 1h 11000, 4h 6000)
 *   --binance                                         # dữ liệu Binance có Delta thật (crypto)
 *   --horizon 48                                      # số nến tối đa giữ lệnh trước khi chốt theo giá đóng cửa
 *   --spread 0.35                                     # chi phí mỗi lệnh (mặc định: Vàng $0.35, Crypto 0.1% x 2 chiều)
 *
 * CANDLE_LIMIT nến đầu chỉ dùng để khởi tạo chỉ báo, không giao dịch. Kết quả tính theo R (1R = Entry -> SL), chỉ xét TP1.
 * Nếu SL và TP1 cùng nằm trong một nến thì tính là chạm SL (giả định bi quan).
 */
const CONFIG = require('../src/config');
const { fetchTradingViewHistory, fetchBinanceHistory, resolveSymbolSources, getClosedCandles, CANDLE_LIMIT } = require('../src/services/marketData');
const { registry, getStrategyPlan } = require('../src/strategies');
const { runBacktest, summarize, costLabel, DEFAULT_BARS } = require('../src/backtest/engine');

function parseArgs(argv) {
  const args = { symbols: [], bars: null, horizon: CONFIG.signalTrackHorizonBars, binance: false, timeframe: null, strategies: null, spread: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bars') args.bars = parseInt(argv[++i], 10);
    else if (argv[i] === '--horizon') args.horizon = parseInt(argv[++i], 10);
    else if (argv[i] === '--binance') args.binance = true;
    else if (argv[i] === '--timeframe') args.timeframe = argv[++i].toLowerCase();
    else if (argv[i] === '--strategies') args.strategies = argv[++i].split(',').map((k) => k.trim().toLowerCase());
    else if (argv[i] === '--spread') args.spread = parseFloat(argv[++i]);
    else args.symbols.push(argv[i]);
  }
  if (args.symbols.length === 0) args.symbols = CONFIG.symbols;
  return args;
}

/**
 * Các khung thời gian và chiến lược cần chạy: theo --timeframe/--strategies, hoặc theo cấu hình STRATEGIES
 */
function buildRuns(args) {
  const plan = getStrategyPlan();
  const pick = (keys) => keys.map((k) => registry[k]).filter(Boolean);
  if (args.timeframe) {
    const list = args.strategies ? pick(args.strategies) : (plan.get(args.timeframe) || []);
    return [[args.timeframe, list]];
  }
  if (args.strategies) return [[CONFIG.timeframe, pick(args.strategies)]];
  return [...plan.entries()];
}

async function loadCandles(symbol, timeframe, args) {
  const sources = resolveSymbolSources(symbol);
  if (args.binance) {
    const candles = await fetchBinanceHistory(sources.binanceSymbol, timeframe, args.bars || DEFAULT_BARS[timeframe] || 6000);
    return { candles, hasRealDelta: true, source: `Binance (${sources.binanceSymbol})` };
  }
  const candles = await fetchTradingViewHistory(sources.tradingViewSymbol, timeframe, args.bars || DEFAULT_BARS[timeframe] || 6000);
  return { candles, hasRealDelta: false, source: `TradingView (${sources.tradingViewSymbol})` };
}

function row(summary) {
  return {
    'lệnh': summary.trades,
    'thắng%': summary.winRate != null ? `${Math.round(summary.winRate * 100)}%` : '-',
    'R/lệnh': summary.avgR,
    'R/lệnh sau phí': summary.avgNet,
    'tổng R sau phí': summary.totalNet,
    PF: summary.profitFactor,
    'sụt max R': summary.maxDrawdown,
    'đầu R/lệnh': summary.early.avgNet,
    'sau R/lệnh': summary.late.avgNet,
  };
}

async function backtestSymbol(symbol, timeframe, strategyList, args) {
  if (strategyList.length === 0) {
    console.log(`\n⚠️ ${symbol} ${timeframe}: không có chiến lược nào để chạy.`);
    return;
  }
  const { candles: allCandles, hasRealDelta, source } = await loadCandles(symbol, timeframe, args);
  const candles = getClosedCandles({ candles: allCandles }, timeframe).candles;
  if (candles.length < CANDLE_LIMIT + 1) {
    console.log(`\n⚠️ ${symbol} ${timeframe}: chỉ có ${candles.length} nến đã đóng, cần tối thiểu ${CANDLE_LIMIT + 1} (${CANDLE_LIMIT} nến khởi tạo chỉ báo). Tăng --bars.`);
    return;
  }

  const { combined, warmup } = runBacktest({ symbol, candles, timeframe, strategies: strategyList, horizon: args.horizon, spread: args.spread, hasRealDelta });
  const split = warmup + Math.floor((candles.length - warmup) * 0.6);
  const from = candles[warmup].date.toISOString().slice(0, 10);
  const to = candles[candles.length - 1].date.toISOString().slice(0, 10);
  console.log(`\n📊 ${symbol} | ${source} | ${timeframe} | ${from} → ${to} | giai đoạn sau từ ${candles[split].date.toISOString().slice(0, 10)} | horizon ${args.horizon} nến | ${costLabel(symbol, args.spread)}`);
  console.log(`   Chiến lược: ${strategyList.map((s) => s.key).join(', ')}`);

  const rows = {};
  for (const name of [...new Set(combined.map((t) => t.strategy))].sort()) {
    rows[name] = row(summarize(combined.filter((t) => t.strategy === name), split));
  }
  rows['TỔNG'] = row(summarize(combined, split));
  console.table(rows);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = buildRuns(args);
  for (const symbol of args.symbols) {
    for (const [timeframe, strategyList] of runs) {
      try {
        await backtestSymbol(symbol, timeframe, strategyList, args);
      } catch (err) {
        console.error(`❌ Backtest ${symbol} ${timeframe} thất bại:`, err.message);
      }
    }
  }
  console.log('\nLưu ý: chưa gồm bộ lọc AI. "Đầu"/"sau" là 60% đầu và 40% sau của giai đoạn giao dịch. Kết quả quá khứ không đảm bảo tương lai.');
  process.exit(0);
}

main();

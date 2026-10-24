/**
 * Tạo báo cáo backtest cho dashboard (data/backtest-report.json): mọi chiến lược trên các khung trong
 * BACKTEST_REPORT_TIMEFRAMES (mặc định 15m, 30m, 1h, 4h), chạy riêng từng chiến lược và chạy gộp các chiến lược
 * đang bật theo STRATEGIES, kèm đối chứng ngẫu nhiên và đánh giá theo tiêu chí đạt chuẩn.
 *
 * Cách dùng: npm run backtest:report   (bot cũng tự chạy định kỳ ở tiến trình riêng theo BACKTEST_REPORT_CRON)
 */
const CONFIG = require('../src/config');
const { fetchTradingViewHistory, resolveSymbolSources, getClosedCandles, CANDLE_LIMIT } = require('../src/services/marketData');
const { registry, getStrategyPlan } = require('../src/strategies');
const { runBacktest, summarize, randomControl, passes, PASS_CRITERIA, DEFAULT_BARS, costLabel } = require('../src/backtest/engine');
const { primaryStrategyName } = require('../src/tradeOutcome');
const { writeJson } = require('../src/services/jsonStore');

function evaluate(symbol, candles, timeframe, trades, split, warmup) {
  const summary = summarize(trades, split);
  const control = randomControl({ symbol, candles, timeframe, count: summary.trades, realAvgNet: summary.avgNet, warmup });
  return { ...summary, p: control.p, randomAvgNet: control.randomAvgNet, pass: passes(summary, control.p) };
}

async function reportFor(symbol, timeframe, plan) {
  const sources = resolveSymbolSources(symbol);
  const raw = await fetchTradingViewHistory(sources.tradingViewSymbol, timeframe, DEFAULT_BARS[timeframe] || 6000);
  const candles = getClosedCandles({ candles: raw }, timeframe).candles;
  if (candles.length < CANDLE_LIMIT + 50) {
    return { symbol, displayName: sources.displayName, timeframe, error: `Chỉ có ${candles.length} nến, cần hơn ${CANDLE_LIMIT + 50}` };
  }

  const active = plan.get(timeframe) || [];
  const all = Object.values(registry);
  const { combined, perStrategy, warmup } = runBacktest({ symbol, candles, timeframe, strategies: active, standalone: all });
  const split = warmup + Math.floor((candles.length - warmup) * PASS_CRITERIA.splitRatio);

  return {
    symbol,
    displayName: sources.displayName,
    timeframe,
    source: `TradingView (${sources.tradingViewSymbol})`,
    cost: costLabel(symbol),
    from: candles[warmup].date.toISOString(),
    to: candles[candles.length - 1].date.toISOString(),
    splitAt: candles[split].date.toISOString(),
    bars: candles.length - warmup,
    strategies: all.map((s) => ({
      key: s.key,
      name: primaryStrategyName(s.name),
      active: active.includes(s),
      ...evaluate(symbol, candles, timeframe, perStrategy.get(s.key), split, warmup),
    })),
    combined: active.length > 0
      ? { keys: active.map((s) => s.key), ...evaluate(symbol, candles, timeframe, combined, split, warmup) }
      : null,
  };
}

async function main() {
  const started = Date.now();
  const plan = getStrategyPlan();
  const results = [];
  for (const symbol of CONFIG.symbols) {
    for (const timeframe of CONFIG.backtestReportTimeframes) {
      const t0 = Date.now();
      try {
        const res = await reportFor(symbol, timeframe, plan);
        results.push(res);
        const passed = (res.strategies || []).filter((s) => s.pass).map((s) => s.key);
        console.log(`📈 [BacktestReport] ${symbol} ${timeframe}: ${res.error || `${res.bars} nến, đạt chuẩn: ${passed.join(', ') || 'không có'}`} (${Math.round((Date.now() - t0) / 1000)}s)`);
      } catch (err) {
        results.push({ symbol, timeframe, error: err.message });
        console.error(`❌ [BacktestReport] ${symbol} ${timeframe}: ${err.message}`);
      }
    }
  }

  // Không ghi đè báo cáo cũ nếu lần này không tạo được kết quả nào (vd: mất kết nối TradingView)
  if (!results.some((r) => !r.error)) {
    console.error('❌ [BacktestReport] Không tạo được kết quả nào, giữ nguyên báo cáo cũ.');
    process.exit(1);
  }

  writeJson(CONFIG.backtestReportPath, {
    generatedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - started) / 1000),
    criteria: PASS_CRITERIA,
    horizonBars: CONFIG.signalTrackHorizonBars,
    cooldownBars: CONFIG.signalCooldownBars,
    candleWindow: CANDLE_LIMIT,
    results,
  });
  console.log(`✅ [BacktestReport] Đã ghi ${CONFIG.backtestReportPath} (${Math.round((Date.now() - started) / 1000)}s)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [BacktestReport] Lỗi:', err.message);
  process.exit(1);
});

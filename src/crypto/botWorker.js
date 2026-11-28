/**
 * Worker chạy 9 phương pháp của bot trên một khung bằng engine backtest có sẵn (chạy riêng từng phương pháp,
 * SL/TP của phương pháp, tối đa SIGNAL_TRACK_HORIZON_BARS nến). Chạy trong worker_threads để các khung chạy song song.
 */
const { parentPort, workerData } = require('worker_threads');
const { registry } = require('../strategies');
const { runBacktest } = require('../backtest/engine');
const { timeframeToMs } = require('../services/marketData');

const round3 = (v) => Math.round(v * 1000) / 1000;
const { symbol, timeframe, rows } = workerData;
const candles = rows.map((r) => ({ date: new Date(r[0]), open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], delta: r[6] }));
const strategies = Object.values(registry);
const { perStrategy, warmup } = runBacktest({ symbol, candles, timeframe, standalone: strategies, hasRealDelta: true, isCrypto: true });
const tfMinutes = timeframeToMs(timeframe) / 60000;

const series = [];
for (const strat of strategies) {
  const trades = perStrategy.get(strat.key) || [];
  for (const side of ['BUY', 'SELL']) {
    series.push({
      key: strat.key,
      name: strat.name.split(' (')[0],
      side,
      // [phút vào lệnh (lúc nến tín hiệu đóng), số nến giữ, R sau phí, phí theo R, 1 = còn mở ở cuối dữ liệu]
      log: trades.filter((t) => t.action === side).map((t) => [
        Math.round(t.time / 60000) + tfMinutes, t.bars, round3(t.net), round3(t.r - t.net), t.open ? 1 : 0,
      ]),
    });
  }
}
parentPort.postMessage({ timeframe, from: candles[Math.min(warmup, candles.length - 1)].date.toISOString(), series });

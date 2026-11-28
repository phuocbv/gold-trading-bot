/**
 * Backtest riêng cho BTC/ETH trên dữ liệu Binance Spot: nhóm phương pháp theo xu hướng (thoát bằng trailing stop) và
 * 9 phương pháp của bot (SL/TP cố định), lưu toàn bộ danh sách lệnh để trang /crypto-backtest thống kê theo khoảng
 * thời gian. Chỉ đọc dữ liệu và engine có sẵn, không đổi cách bot phát tín hiệu.
 */
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const CONFIG = require('../config');
const { fetchBinanceHistory, getClosedCandles, resolveSymbolSources, timeframeToMs } = require('../services/marketData');
const { trendMethods } = require('./methods');

const PAYLOAD_VERSION = 1;
// Phí mỗi chiều (mua hoặc bán) theo giá trị lệnh, giống backtest crypto của bot
const COST_PER_SIDE = 0.001;
const COST_LABEL = 'phí 0.1% x 2 chiều';
// Số nến tải về: toàn bộ lịch sử Binance (từ 08/2017) với khung từ 1h, khoảng 2 năm gần nhất với 15m
const BARS = { '15m': 70080, '30m': 70080, '1h': 90000, '2h': 45000, '4h': 23000, '1d': 4000 };
const DEFAULT_TREND_TIMEFRAMES = ['1h', '2h', '4h', '1d'];
const DEFAULT_BOT_TIMEFRAMES = ['15m', '1h', '2h', '4h', '1d'];
// Nến đầu tiên được giao dịch (đủ dữ liệu cho EMA200)
const TREND_START = 210;

const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Tên chuẩn của tài sản: 'BTCUSDT' / 'btc' / 'BTC/USDT' -> 'BTC/USDT'
 */
function normalizeSymbol(raw) {
  const s = String(raw).trim().toUpperCase();
  if (s.includes('/')) return s;
  return s.endsWith('USDT') ? `${s.slice(0, -4)}/USDT` : `${s}/USDT`;
}

function toColumns(candles) {
  const d = { t: [], o: [], h: [], l: [], c: [], n: candles.length };
  for (const k of candles) {
    d.t.push(k.date.getTime());
    d.o.push(k.open);
    d.h.push(k.high);
    d.l.push(k.low);
    d.c.push(k.close);
  }
  return d;
}

/**
 * Chạy một chiều của một phương pháp: vào lệnh ở giá đóng cửa nến tín hiệu, mỗi lúc một lệnh.
 * Thoát khi chạm SL (giá mở cửa vượt SL thì khớp ở giá mở), khi exitRule đúng (giá đóng cửa), hoặc khi hết dữ liệu
 * (lệnh còn mở, tạm tính theo giá đóng cửa nến cuối). Trailing: SL dời theo giá tốt nhất kể từ lúc vào lệnh ± trail x ATR.
 * @returns {Array<Array<number>>} [phút vào lệnh, số nến giữ, R sau phí, phí theo R, 1 = còn mở]
 */
function runTrend(d, A, signal, dir, { sl = 2, trail = null, exitRule = null } = {}, tfMinutes) {
  const log = [];
  for (let i = TREND_START; i < d.n - 1; i++) {
    if (!A[i] || !signal(i)) continue;
    const entry = d.c[i];
    const risk = sl * A[i];
    let stop = entry - dir * risk;
    let best = entry;
    let exit = null;
    let open = 0;
    let j = i + 1;
    for (; j < d.n; j++) {
      if (dir * (d.o[j] - stop) <= 0) { exit = d.o[j]; break; }
      if (dir > 0 ? d.l[j] <= stop : d.h[j] >= stop) { exit = stop; break; }
      if (exitRule && exitRule(j, dir)) { exit = d.c[j]; break; }
      if (j === d.n - 1) { exit = d.c[j]; open = 1; break; }
      best = dir > 0 ? Math.max(best, d.h[j]) : Math.min(best, d.l[j]);
      if (trail) stop = dir > 0 ? Math.max(stop, best - trail * A[j]) : Math.min(stop, best + trail * A[j]);
    }
    const fee = COST_PER_SIDE * (entry + exit) / risk;
    log.push([Math.round(d.t[i] / 60000) + tfMinutes, j - i, round3(dir * (exit - entry) / risk - fee), round3(fee), open]);
    i = j;
  }
  return log;
}

function runBotWorker(symbol, timeframe, candles) {
  return new Promise((resolve, reject) => {
    const rows = candles.map((c) => [c.date.getTime(), c.open, c.high, c.low, c.close, c.volume, c.delta || 0]);
    const worker = new Worker(path.join(__dirname, 'botWorker.js'), { workerData: { symbol, timeframe, rows } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker ${timeframe} dừng với mã ${code}`)); });
  });
}

// Chạy các tác vụ với số lượng song song giới hạn, giữ thứ tự kết quả
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const lane = async () => {
    while (next < tasks.length) {
      const k = next++;
      results[k] = await tasks[k]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return results;
}

/**
 * Backtest một tài sản crypto
 * @param {string} rawSymbol - 'BTC/USDT', 'BTCUSDT'...
 * @param {object} [opts] - { trendTimeframes, botTimeframes, log }
 * @returns {Promise<object>} Bản lưu cho trang /crypto-backtest
 */
async function scanSymbol(rawSymbol, { trendTimeframes = DEFAULT_TREND_TIMEFRAMES, botTimeframes = DEFAULT_BOT_TIMEFRAMES, log = console.log } = {}) {
  const symbol = normalizeSymbol(rawSymbol);
  const sources = resolveSymbolSources(symbol);
  if (!sources.isCrypto) throw new Error(`${symbol} không phải crypto`);
  const binanceSymbol = sources.binanceSymbol;
  const started = Date.now();

  // Khung ngày luôn tải để tính biến động giá của tài sản trong từng khoảng thời gian
  const timeframes = [...new Set([...trendTimeframes, ...botTimeframes, '1d'])];
  const candlesByTf = {};
  for (const tf of timeframes) {
    const raw = await fetchBinanceHistory(binanceSymbol, tf, BARS[tf] || 20000);
    candlesByTf[tf] = getClosedCandles({ candles: raw }, tf).candles;
    const list = candlesByTf[tf];
    log(`   ${symbol} ${tf}: ${list.length} nến ${list[0].date.toISOString().slice(0, 10)} → ${list[list.length - 1].date.toISOString().slice(0, 10)}`);
  }

  // Phương pháp của bot chạy song song trong worker (nặng), nhóm xu hướng chạy trên luồng chính trong lúc chờ
  const cpu = Math.max(1, Math.min(5, (os.cpus() || []).length - 1));
  const botRun = pool(botTimeframes.map((tf) => () => runBotWorker(symbol, tf, candlesByTf[tf]).then((res) => {
    log(`   ${symbol} ${tf}: xong 9 phương pháp của bot (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    return res;
  })), cpu);

  const series = [];
  for (const tf of trendTimeframes) {
    const d = toColumns(candlesByTf[tf]);
    const tfMinutes = timeframeToMs(tf) / 60000;
    const { atr, list } = trendMethods(d, tf);
    for (const m of list) {
      for (const [side, dir] of [['BUY', 1], ['SELL', -1]]) {
        const signal = dir > 0 ? m.buy : m.sell;
        series.push({
          id: `trend:${m.key}@${tf}:${side}`,
          group: 'trend',
          key: m.key,
          name: m.name,
          timeframe: tf,
          side,
          exitLabel: m.exitLabel,
          from: new Date(d.t[TREND_START]).toISOString(),
          log: runTrend(d, atr, signal, dir, { ...m.exit, exitRule: m.exitRule }, tfMinutes),
        });
      }
    }
  }
  log(`   ${symbol}: xong nhóm xu hướng (${((Date.now() - started) / 1000).toFixed(0)}s)`);

  for (const res of await botRun) {
    for (const s of res.series) {
      series.push({
        id: `bot:${s.key}@${res.timeframe}:${s.side}`,
        group: 'bot',
        key: s.key,
        name: s.name,
        timeframe: res.timeframe,
        side: s.side,
        exitLabel: `SL/TP của phương pháp, tối đa ${CONFIG.signalTrackHorizonBars} nến`,
        from: res.from,
        log: s.log,
      });
    }
  }

  const daily = candlesByTf['1d'].map((c) => [Math.round(c.date.getTime() / 60000), c.close]);
  return {
    version: PAYLOAD_VERSION,
    symbol,
    binanceSymbol,
    displayName: sources.displayName || symbol,
    generatedAt: new Date().toISOString(),
    source: `Binance Spot (${binanceSymbol})`,
    cost: COST_LABEL,
    horizonBars: CONFIG.signalTrackHorizonBars,
    dataTo: candlesByTf['1d'][candlesByTf['1d'].length - 1].date.toISOString(),
    timeframes: Object.fromEntries(timeframes.map((tf) => [tf, {
      from: candlesByTf[tf][0].date.toISOString(),
      candles: candlesByTf[tf].length,
    }])),
    daily,
    series,
  };
}

module.exports = {
  scanSymbol,
  normalizeSymbol,
  runTrend,
  DEFAULT_TREND_TIMEFRAMES,
  DEFAULT_BOT_TIMEFRAMES,
};

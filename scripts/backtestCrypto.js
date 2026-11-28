/**
 * Backtest riêng cho BTC/ETH (dữ liệu Binance Spot từ 2017), lưu vào Postgres (bảng crypto_backtest_runs) hoặc file
 * data/crypto-backtest-<MÃ>.json khi không có DATABASE_URL. Xem kết quả ở trang /crypto-backtest của dashboard.
 * Không ảnh hưởng tín hiệu, báo cáo backtest hay dữ liệu hiện có của bot.
 *
 * Cách dùng:
 *   npm run backtest:crypto                          # BTC/USDT và ETH/USDT
 *   npm run backtest:crypto -- BTC/USDT              # một tài sản
 *   --trend-timeframes 1h,4h,1d                      # khung cho nhóm xu hướng (mặc định 1h,2h,4h,1d)
 *   --bot-timeframes 4h,1d                           # khung cho 9 phương pháp của bot (mặc định 15m,1h,2h,4h,1d)
 *   --skip-bot                                       # bỏ qua phương pháp của bot (nhanh, khoảng 1 phút)
 *   --no-save                                        # chỉ in kết quả, không lưu
 *
 * Nhóm xu hướng: vào lệnh ở giá đóng cửa nến tín hiệu, SL 2 ATR + trailing 3 ATR (không TP), mỗi lúc một lệnh.
 * Phương pháp của bot: engine backtest có sẵn (SL/TP của phương pháp, tối đa SIGNAL_TRACK_HORIZON_BARS nến).
 * Mọi kết quả đã trừ phí 0.1% mỗi chiều.
 */
const { scanSymbol, normalizeSymbol, DEFAULT_TREND_TIMEFRAMES, DEFAULT_BOT_TIMEFRAMES } = require('../src/crypto/backtest');
const { saveRun } = require('../src/crypto/store');
const { dbEnabled, closeDb } = require('../src/services/db');

function parseArgs(argv) {
  const args = { symbols: [], trend: DEFAULT_TREND_TIMEFRAMES, bot: DEFAULT_BOT_TIMEFRAMES, save: true };
  const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') continue;
    if (argv[i] === '--trend-timeframes') args.trend = list(argv[++i]);
    else if (argv[i] === '--bot-timeframes') args.bot = list(argv[++i]);
    else if (argv[i] === '--skip-bot') args.bot = [];
    else if (argv[i] === '--no-save') args.save = false;
    else args.symbols.push(normalizeSymbol(argv[i]));
  }
  if (args.symbols.length === 0) args.symbols = ['BTC/USDT', 'ETH/USDT'];
  return args;
}

function stats(log) {
  const r = log.filter((t) => !t[4]).map((t) => t[2]);
  const n = r.length;
  if (n === 0) return { n };
  const total = r.reduce((a, b) => a + b, 0);
  return { n, avg: total / n, total, win: r.filter((v) => v > 0).length / n };
}

const sign = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

function printSummary(payload) {
  const year = new Date().getUTCFullYear();
  const yearFrom = Date.UTC(year, 0, 1) / 60000;
  const rows = payload.series.map((s) => ({ s, all: stats(s.log), ytd: stats(s.log.filter((t) => t[0] >= yearFrom)) }));
  const label = (s) => `${s.group === 'bot' ? '[bot] ' : ''}${s.name.split(' (')[0]} ${s.timeframe} ${s.side === 'BUY' ? 'MUA' : 'BÁN'}`;
  console.log(`\n📊 ${payload.displayName}: ${payload.series.length} dòng phương pháp × khung × chiều | ${payload.cost}`);
  console.log(`   Tốt nhất cả giai đoạn (≥ 30 lệnh, theo R/lệnh):`);
  for (const x of rows.filter((x) => x.all.n >= 30).sort((a, b) => b.all.avg - a.all.avg).slice(0, 8)) {
    console.log(`     ${label(x.s).padEnd(46)} ${String(x.all.n).padStart(5)} lệnh  ${sign(x.all.avg)}R/lệnh  tổng ${sign(x.all.total, 1)}R`);
  }
  console.log(`   Tốt nhất năm ${year} (≥ 5 lệnh, theo tổng R):`);
  for (const x of rows.filter((x) => x.ytd.n >= 5).sort((a, b) => b.ytd.total - a.ytd.total).slice(0, 8)) {
    console.log(`     ${label(x.s).padEnd(46)} ${String(x.ytd.n).padStart(5)} lệnh  ${sign(x.ytd.avg)}R/lệnh  tổng ${sign(x.ytd.total, 1)}R | cả giai đoạn ${x.all.n ? sign(x.all.avg) : '-'}R`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`🔎 Backtest crypto: ${args.symbols.join(', ')} | xu hướng: ${args.trend.join(', ') || '-'} | phương pháp của bot: ${args.bot.join(', ') || 'bỏ qua'}`);
  console.log(`🗄️ Lưu vào: ${!args.save ? 'không lưu (--no-save)' : dbEnabled() ? 'Postgres (bảng crypto_backtest_runs)' : 'file data/crypto-backtest-<MÃ>.json'}`);
  let failed = false;
  for (const symbol of args.symbols) {
    try {
      const payload = await scanSymbol(symbol, { trendTimeframes: args.trend, botTimeframes: args.bot });
      printSummary(payload);
      if (args.save) {
        const where = await saveRun(payload);
        console.log(`   ✅ Đã lưu ${payload.displayName} (${(JSON.stringify(payload).length / 1e6).toFixed(1)} MB) vào ${where}`);
      }
    } catch (err) {
      failed = true;
      console.error(`❌ ${symbol}: ${err.message}`);
    }
  }
  await closeDb();
  console.log('\nXem kết quả: http://localhost:<PORT>/crypto-backtest (cùng tài khoản đăng nhập dashboard).');
  process.exit(failed ? 1 : 0);
}

main();

/**
 * Backtest theo tháng và theo ngày của các phương pháp đang bật (STRATEGIES) trong một năm: thắng%, R sau chi phí
 * từng tháng, từng ngày. In bảng ra màn hình và ghi data/backtest-monthly.json cho dashboard
 * (tab Báo cáo backtest > Theo tháng, Theo ngày).
 *
 * Cách dùng:
 *   npm run backtest:monthly                         # năm hiện tại, các mã trong SYMBOLS
 *   node scripts/backtestMonthly.js XAU/USD --year 2026
 *   npm run backtest:daily                           # in thêm bảng theo ngày của tháng gần nhất
 *   node scripts/backtestMonthly.js --year 2025 --days 3
 *
 * Khung nào TradingView ẩn danh không đủ lịch sử về tới đầu năm (vd: 15m) thì tự dùng Binance cho cả giai đoạn
 * (Vàng: hợp đồng XAUUSDT Binance Futures, lọc theo giờ giao dịch OANDA). Chưa gồm bộ lọc AI và chặn tin tức.
 */
const CONFIG = require('../src/config');
const { getStrategyPlan, planSignature } = require('../src/strategies');
const { dayKey, monthsOf, monthlyReportFor } = require('../src/backtest/monthly');
const { CANDLE_LIMIT } = require('../src/services/marketData');
const { writeJson } = require('../src/services/jsonStore');

function parseArgs(argv) {
  const args = { symbols: [], year: Number(dayKey(Date.now()).slice(0, 4)), days: null };
  for (let i = 0; i < argv.length; i++) {
    // --days [tháng 1-12]: in thêm bảng theo ngày của tháng đó, không ghi tháng thì lấy tháng gần nhất (0)
    if (argv[i] === '--days') {
      args.days = /^\d{1,2}$/.test(argv[i + 1] || '') ? Number(argv[++i]) : 0;
      continue;
    }
    const year = argv[i] === '--year' ? argv[++i] : /^\d{4}$/.test(argv[i]) ? argv[i] : null;
    if (year === null) {
      args.symbols.push(argv[i]);
      continue;
    }
    if (!/^\d{4}$/.test(year || '')) {
      console.error(`❌ [BacktestMonthly] Năm không hợp lệ: "${year ?? ''}" (vd: --year 2026)`);
      process.exit(1);
    }
    args.year = Number(year);
  }
  if (args.symbols.length === 0) args.symbols = CONFIG.symbols;
  return args;
}

const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const signed = (v, d = 2) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`);
const rowLabel = (row) => (row.timeframe ? `${row.label} · ${row.timeframe}` : row.label);
const monthLabel = (m) => `T${Number(m.slice(5))}`;
const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const dayLabel = (d) => `${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(8)}/${d.slice(5, 7)}`;

function printReport(res, months) {
  console.log(`\n📅 ${res.displayName} | ${res.cost}`);
  for (const t of res.timeframes) {
    console.log(t.error
      ? `   ${t.timeframe}: ❌ ${t.error}`
      : `   ${t.timeframe}: ${t.source} | vào lệnh từ ${t.from.slice(0, 10)} → ${t.to.slice(0, 10)} | ${t.keys.join(', ')}`);
  }
  if (res.rows.length === 0) return;

  const yearly = {};
  for (const row of res.rows) {
    const s = row.year;
    yearly[rowLabel(row)] = {
      'lệnh': s.trades, TP: s.wins, SL: s.losses, 'hết hạn': s.expired, 'đang mở': s.open,
      'thắng%': pct(s.winRate), 'hòa vốn%': pct(s.breakEven), 'R/lệnh': signed(s.avgNet), 'tổng R': signed(s.totalNet, 1), PF: s.profitFactor ?? '-',
    };
  }
  console.table(yearly);

  // Mỗi ô: thắng% / số lệnh đã đóng (· = không có lệnh, x = chưa có dữ liệu)
  const matrix = (cell) => Object.fromEntries(res.rows.map((row) => [rowLabel(row), Object.fromEntries(months.map((m) => {
    const s = row.months[m];
    return [monthLabel(m), s.coverage === 'none' ? 'x' : s.trades === 0 ? '·' : s.trades === s.open ? 'đang mở' : cell(s)];
  }))]));
  console.log('Thắng% / số lệnh đã đóng theo tháng:');
  console.table(matrix((s) => `${pct(s.winRate)} / ${s.wins + s.losses + s.expired}`));
  console.log('Tổng R sau chi phí theo tháng:');
  console.table(matrix((s) => signed(s.totalNet, 1)));
}

/**
 * Bảng theo ngày của một tháng: mỗi khung một cột theo quy trình bot (dòng gộp, hoặc phương pháp duy nhất của khung)
 * và cột toàn bot; chỉ liệt kê ngày có lệnh
 */
function printDays(res, month) {
  const cols = res.rows.filter((row) => row.kind !== 'strategy' || !res.rows.some((r) => r.kind === 'combined' && r.timeframe === row.timeframe));
  const days = [...new Set(cols.flatMap((row) => Object.keys(row.days)))].filter((d) => d.startsWith(month)).sort();
  if (days.length === 0) {
    console.log(`Không có lệnh nào trong ${monthLabel(month)}/${month.slice(0, 4)}.`);
    return;
  }
  console.log(`Theo ngày ${monthLabel(month)}/${month.slice(0, 4)}: tổng R sau chi phí (TP1 / lệnh đã đóng):`);
  console.table(Object.fromEntries(days.map((d) => [dayLabel(d), Object.fromEntries(cols.map((row) => {
    const s = row.days[d];
    return [row.timeframe || row.label, !s ? '·' : s.trades === s.open ? 'đang mở' : `${signed(s.totalNet, 1)} (${s.wins}/${s.wins + s.losses + s.expired})`];
  }))])));
}

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const plan = getStrategyPlan();
  const months = monthsOf(args.year);
  if (months.length === 0) {
    console.error(`❌ [BacktestMonthly] Năm ${args.year} chưa bắt đầu.`);
    process.exit(1);
  }
  const dayMonth = args.days == null ? null : args.days ? `${args.year}-${String(args.days).padStart(2, '0')}` : months[months.length - 1];
  if (dayMonth && !months.includes(dayMonth)) {
    console.error(`❌ [BacktestMonthly] Tháng ${args.days} không thuộc năm ${args.year} hoặc chưa tới.`);
    process.exit(1);
  }

  const results = [];
  for (const symbol of args.symbols) {
    const t0 = Date.now();
    try {
      const res = await monthlyReportFor(symbol, plan, args.year);
      results.push(res);
      printReport(res, months);
      if (dayMonth && res.rows.length > 0) printDays(res, dayMonth);
      console.log(`   (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (err) {
      results.push({ symbol, error: err.message });
      console.error(`❌ [BacktestMonthly] ${symbol}: ${err.message}`);
    }
  }

  // Không ghi đè báo cáo cũ nếu lần này không tạo được kết quả nào (vd: mất kết nối TradingView)
  if (!results.some((r) => r.rows && r.rows.length > 0)) {
    console.error('❌ [BacktestMonthly] Không tạo được kết quả nào, giữ nguyên báo cáo cũ.');
    process.exit(1);
  }

  writeJson(CONFIG.backtestMonthlyPath, {
    generatedAt: new Date().toISOString(),
    planSignature: planSignature(plan),
    durationSec: Math.round((Date.now() - started) / 1000),
    year: args.year,
    months,
    horizonBars: CONFIG.signalTrackHorizonBars,
    cooldownBars: CONFIG.signalCooldownBars,
    candleWindow: CANDLE_LIMIT,
    results,
  });
  console.log(`\n✅ [BacktestMonthly] Đã ghi ${CONFIG.backtestMonthlyPath} (${Math.round((Date.now() - started) / 1000)}s)`);
  console.log('Lưu ý: thắng% = TP1 / (TP1 + SL); "hòa vốn%" là thắng% tối thiểu để không lỗ với R thắng/thua thực tế; tháng và ngày theo giờ VN. Kết quả quá khứ không đảm bảo tương lai.');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [BacktestMonthly] Lỗi:', err.message);
  process.exit(1);
});

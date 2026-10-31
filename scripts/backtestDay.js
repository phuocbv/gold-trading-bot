/**
 * Kiểm tra một ngày (giờ VN): các phương pháp đang bật (STRATEGIES) có tín hiệu gì, theo đúng quy trình bot (hợp lưu,
 * xung đột, ngưỡng điểm, cooldown) và kết quả từng lệnh tới hiện tại; kèm tín hiệu bot thật đã ghi nhận để đối chiếu.
 * Chưa gồm bộ lọc AI và chặn tin tức. Có DATABASE_URL thì đối chiếu với tín hiệu bot thật lưu trong Postgres và lưu kết quả
 * vào Postgres (backtest_runs, kind 'day'): mỗi ngày mỗi tài sản một dòng, chạy lại cùng ngày thì thay bằng kết quả mới nhất.
 * Tín hiệu bot sẽ phát cũng được bổ sung vào danh sách tín hiệu (đánh dấu backtest, chống trùng với tín hiệu đã có) để có
 * dữ liệu những ngày bot chưa chạy.
 *
 * Cách dùng:
 *   npm run backtest:day                         # hôm nay, các mã trong SYMBOLS
 *   npm run backtest:day -- 22/10                # ngày 22/10 năm nay (hoặc 22/10/2025, 2025-10-22)
 *   node scripts/backtestDay.js XAU/USD 2026-10-22
 */
const CONFIG = require('../src/config');
const { getStrategyPlan, planSignature } = require('../src/strategies');
const { parseDay, daySignalsFor } = require('../src/backtest/daySignals');
const { dayKey } = require('../src/backtest/monthly');
const { saveDayChecks } = require('../src/backtest/store');
const { loadStoredSignals, backfillSignals } = require('../src/services/signalTracker');
const { dbEnabled, closeDb } = require('../src/services/db');

const ACTION_LABELS = { BUY: 'MUA', SELL: 'BÁN' };
const OUTCOME_LABELS = { TP: 'TP1', SL: 'SL', EXPIRED: 'hết hạn' };
const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const timeFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
// 'DD/MM HH:MM' theo giờ VN
const dateTime = (iso) => `${dayKey(iso).slice(8)}/${dayKey(iso).slice(5, 7)} ${timeFmt.format(new Date(iso))}`;

function parseArgs(argv) {
  const args = { symbols: [], day: dayKey(Date.now()) };
  for (const arg of argv) {
    // pnpm truyền nguyên dấu "--" của "pnpm run backtest:day -- 22/10" vào script
    if (arg === '--') continue;
    if (/^\d/.test(arg)) {
      args.day = parseDay(arg);
      if (!args.day) throw new Error(`Ngày "${arg}" không hợp lệ (dùng 22/10, 22/10/2026 hoặc 2026-10-22)`);
    } else {
      // Dùng đúng tên tài sản trong SYMBOLS (vd: xau/usd -> XAU/USD) để mã tín hiệu bổ sung khớp với tín hiệu bot thật
      args.symbols.push(CONFIG.symbols.find((s) => s.toUpperCase() === arg.toUpperCase()) || arg);
    }
  }
  if (args.symbols.length === 0) args.symbols = CONFIG.symbols;
  return args;
}

const signed = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
const price = (v) => (Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(4));
// Giờ trong ngày đang xem, kèm ngày nếu khác ngày
const when = (iso, day) => (dayKey(iso) === day ? timeFmt.format(new Date(iso)) : dateTime(iso));
const dayLabel = (d) => `${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Tín hiệu bot sẽ phát trong ngày dưới dạng bản ghi của danh sách tín hiệu (cùng cấu trúc và mã với tín hiệu bot thật ghi
 * nhận), đánh dấu origin 'backtest'. Lệnh còn mở được bot tiếp tục theo dõi từ nến cuối đã xét.
 */
function toSignalRecords(res) {
  return res.timeframes.filter((t) => !t.error).flatMap((t) => t.signals.map((s) => ({
    id: `${res.symbol}|${s.action}|${Date.parse(s.candleTime)}`,
    origin: 'backtest',
    symbol: res.symbol,
    displayName: res.displayName,
    strategy: s.strategy,
    alliedStrategies: s.allies,
    action: s.action,
    entry: s.entry,
    stopLoss: s.stopLoss,
    takeProfit: s.takeProfit,
    takeProfit2: null,
    score: s.score ?? null,
    candleTime: s.candleTime,
    timeframe: t.timeframe,
    source: t.source,
    // Chưa qua AI: tính là tín hiệu bot phát theo quy trình kỹ thuật, không có thông tin duyệt / gửi Telegram
    sent: true,
    delivered: false,
    aiMode: null,
    aiConfidence: null,
    status: s.open ? 'OPEN' : s.outcome,
    barsHeld: s.bars,
    lastCheckedTime: s.exitTime,
    lastPrice: s.exitPrice,
    exitPrice: s.open ? null : s.exitPrice,
    closedTime: s.open ? null : s.exitTime,
    backfilledAt: res.generatedAt,
  })));
}

function outcomeText(s, day) {
  if (s.open) return `đang mở (${signed(s.r)}R tạm tính)`;
  return `${OUTCOME_LABELS[s.outcome]} ở nến ${when(s.exitTime, day)}`;
}

function printDay(res) {
  console.log(`\n🔎 ${res.displayName} · ${dayLabel(res.day)} · ${res.cost}`);
  for (const t of res.timeframes) {
    console.log(t.error
      ? `   ${t.timeframe}: ❌ ${t.error}`
      : `   ${t.timeframe}: ${t.source} · ${t.candles} nến trong ngày · dữ liệu tới ${dateTime(t.dataTo)} · ${t.keys.join(', ')}`);
  }

  const ok = res.timeframes.filter((t) => !t.error);
  const signals = ok.flatMap((t) => t.signals.map((s) => ({ ...s, timeframe: t.timeframe }))).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const skipped = ok.flatMap((t) => t.skipped.map((s) => ({ ...s, timeframe: t.timeframe }))).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  if (signals.length === 0) {
    console.log(`\n📭 Bot không có tín hiệu nào trong ngày${ok.every((t) => t.candles === 0) ? ' (không có nến nào đóng trong ngày)' : ''}.`);
  } else {
    console.log(`\n📣 Bot phát ${signals.length} tín hiệu (giờ vào lệnh = giờ đóng nến tín hiệu; R sau chi phí):`);
    console.table(signals.map((s) => ({
      'giờ': when(s.time, res.day),
      khung: s.timeframe,
      'phương pháp': [s.strategy, ...s.allies].join(' + '),
      'chiều': ACTION_LABELS[s.action],
      'điểm': s.score,
      entry: price(s.entry),
      SL: price(s.stopLoss),
      TP1: price(s.takeProfit),
      'kết quả': outcomeText(s, res.day),
      R: s.open ? '-' : signed(s.net),
    })));
  }

  if (skipped.length > 0) {
    console.log('🚫 Tín hiệu riêng của từng phương pháp nhưng bot không phát:');
    console.table(skipped.map((s) => ({
      'giờ': when(s.time, res.day),
      khung: s.timeframe,
      'phương pháp': s.strategy,
      'chiều': ACTION_LABELS[s.action],
      'điểm': s.score,
      'lý do': s.reason,
    })));
  }

  if (res.live.length === 0) {
    console.log(`🤖 Bot thật không ghi nhận tín hiệu nào trong ngày (${dbEnabled() ? 'Postgres + ' : ''}${CONFIG.signalDbPath}).`);
  } else {
    console.log(`🤖 Bot thật đã ghi nhận ${res.live.length} tín hiệu trong ngày:`);
    console.table(res.live.map((s) => ({
      'giờ': when(s.time, res.day),
      khung: s.timeframe,
      'phương pháp': s.strategy,
      'chiều': ACTION_LABELS[s.action],
      'điểm': s.score,
      entry: price(s.entry),
      'gửi': s.sent ? 'đã gửi' : 'AI từ chối',
      'trạng thái': s.status,
      R: signed(s.r),
    })));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.day > dayKey(Date.now())) throw new Error(`Ngày ${args.day} chưa tới`);
  const plan = getStrategyPlan();
  // Tín hiệu bot thật có thể chỉ nằm trong Postgres (bot chạy ở máy khác, hoặc file JSON đã mất)
  await loadStoredSignals().catch((err) => console.warn(`⚠️ [BacktestDay] Không đọc được tín hiệu từ Postgres (${err.message}), chỉ dùng ${CONFIG.signalDbPath}.`));
  const results = [];
  for (const symbol of args.symbols) {
    const t0 = Date.now();
    try {
      const res = await daySignalsFor(symbol, plan, args.day);
      results.push(res);
      printDay(res);
      console.log(`   (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (err) {
      results.push({ symbol, day: args.day, error: err.message });
      console.error(`❌ [BacktestDay] ${symbol}: ${err.message}`);
    }
  }
  console.log('\nLưu ý: theo đúng quy trình bot (hợp lưu, xung đột, ngưỡng điểm, cooldown) nhưng chưa gồm bộ lọc AI và chặn tin tức; ngày theo giờ VN.');

  const signalRecords = results.filter((r) => !r.error).flatMap(toSignalRecords);
  if (signalRecords.length > 0) {
    try {
      const c = await backfillSignals(signalRecords);
      console.log(`📒 [BacktestDay] Danh sách tín hiệu (${dbEnabled() ? 'Postgres' : CONFIG.signalDbPath}): thêm ${c.added}, cập nhật ${c.updated}, ` +
        `không đổi ${c.unchanged}, bỏ qua ${c.live} vì đã có tín hiệu bot thật.`);
    } catch (err) {
      console.error(`❌ [BacktestDay] Không bổ sung được vào danh sách tín hiệu (${err.message}).`);
    }
  }

  if (dbEnabled()) {
    try {
      const { saved, skipped } = await saveDayChecks(results, {
        planSignature: planSignature(plan),
        horizonBars: CONFIG.signalTrackHorizonBars,
        cooldownBars: CONFIG.signalCooldownBars,
      });
      if (saved.length) console.log(`🗄️ [BacktestDay] Đã lưu kết quả ${saved.join(', ')} vào Postgres (mỗi ngày mỗi tài sản giữ lần chạy mới nhất).`);
      if (skipped.length) console.log(`⚠️ [BacktestDay] Không lưu ${skipped.join(', ')}: lỗi dữ liệu ở mọi khung, hoặc lỗi nhiều khung hơn kết quả đã lưu trước đó.`);
    } catch (err) {
      console.error(`❌ [BacktestDay] Không lưu được kết quả vào Postgres (${err.message}); chạy lại lệnh khi kết nối được để lưu.`);
    }
    await closeDb();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [BacktestDay] Lỗi:', err.message);
  process.exit(1);
});

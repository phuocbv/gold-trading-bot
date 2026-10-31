/**
 * Lưu báo cáo backtest vào Postgres: mỗi lần tạo báo cáo là một bản riêng (backtest_runs), từng lệnh của báo cáo
 * tổng hợp được cộng dồn (backtest_trades) để thống kê theo khoảng thời gian dài hơn lịch sử nguồn dữ liệu trả về.
 */
const CONFIG = require('../config');
const { dbEnabled, query, withTransaction, closeDb } = require('../services/db');
const { readJson } = require('../services/jsonStore');
const { timeframeToMs } = require('../services/marketData');
const { OUTCOME_CODE } = require('./engine');

const OUTCOME_BY_CODE = Object.fromEntries(Object.entries(OUTCOME_CODE).map(([name, code]) => [code, name]));
const hasTradeLog = (report) => (report.version || 1) >= 2;
const combinedKey = (keys) => `combined:${keys.join('+')}`;

/**
 * Các dòng có danh sách lệnh của một khung trong báo cáo tổng hợp: [khóa lưu trong backtest_trades, thống kê]
 */
function logEntries(res) {
  const entries = res.strategies.map((s) => [s.key, s]);
  // Khung chỉ bật một phương pháp thì chạy gộp trùng với chạy riêng phương pháp đó
  if (res.combined && res.combined.keys.length > 1) entries.push([combinedKey(res.combined.keys), res.combined]);
  return entries;
}

// Danh sách lệnh đã nằm trong backtest_trades nên không lưu lặp trong bản lưu báo cáo
function withoutLogs(report) {
  const strip = ({ log, ...rest }) => rest;
  return {
    ...report,
    results: report.results.map((res) => (res.strategies
      ? { ...res, strategies: res.strategies.map(strip), combined: res.combined && strip(res.combined) }
      : res)),
  };
}

/**
 * Thay các lệnh trong khoảng dữ liệu của lần chạy này bằng kết quả mới nhất: lệnh ngoài khoảng (đã trôi khỏi
 * lịch sử nguồn dữ liệu) được giữ lại, lệnh trong khoảng mà lần này không còn (vd: đã sửa phương pháp) bị xóa
 */
async function replaceTrades(client, runId, report) {
  for (const res of report.results) {
    if (res.error || !res.strategies) continue;
    const entries = logEntries(res);
    await client.query(
      `DELETE FROM backtest_trades
       WHERE symbol = $1 AND timeframe = $2 AND strategy = ANY($3) AND entry_time BETWEEN $4 AND $5`,
      [res.symbol, res.timeframe, entries.map(([key]) => key), new Date(res.from), new Date(Date.parse(res.to) + timeframeToMs(res.timeframe))]);

    const rows = { strategy: [], minute: [], action: [], outcome: [], net: [] };
    for (const [key, s] of entries) {
      // Mỗi phương pháp vào tối đa một lệnh mỗi nến; giữ lệnh sau cùng nếu trùng phút để không lỗi khóa chính
      const byMinute = new Map((s.log || []).map((t) => [t[0], t]));
      for (const [minute, side, outcome, net] of byMinute.values()) {
        rows.strategy.push(key);
        rows.minute.push(minute);
        rows.action.push(side === 1 ? 'BUY' : 'SELL');
        rows.outcome.push(OUTCOME_BY_CODE[outcome]);
        rows.net.push(net);
      }
    }
    if (rows.strategy.length === 0) continue;
    await client.query(
      `INSERT INTO backtest_trades (symbol, timeframe, strategy, entry_time, action, outcome, net_r, run_id)
       SELECT $1, $2, t.strategy, to_timestamp(t.minute * 60), t.action, t.outcome, t.net, $3
       FROM unnest($4::text[], $5::bigint[], $6::text[], $7::text[], $8::float8[]) AS t(strategy, minute, action, outcome, net)
       ON CONFLICT (symbol, timeframe, strategy, entry_time)
       DO UPDATE SET action = EXCLUDED.action, outcome = EXCLUDED.outcome, net_r = EXCLUDED.net_r, run_id = EXCLUDED.run_id`,
      [res.symbol, res.timeframe, runId, rows.strategy, rows.minute, rows.action, rows.outcome, rows.net]);
  }
}

/**
 * Lưu một báo cáo vừa tạo (kind 'report' tổng hợp hoặc 'monthly' theo tháng). Báo cáo đã lưu (cùng thời điểm tạo)
 * thì bỏ qua. Trả về id bản lưu mới, hoặc null nếu đã có.
 */
async function saveRun(kind, report) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO backtest_runs (kind, generated_at, year, plan_signature, payload) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind, generated_at) DO NOTHING RETURNING id`,
      [kind, report.generatedAt, kind === 'monthly' ? report.year : null, report.planSignature || null,
        kind === 'report' ? withoutLogs(report) : report]);
    if (rows.length === 0) return null;
    const runId = rows[0].id;
    if (kind === 'report' && hasTradeLog(report)) {
      // Lưu bổ sung một báo cáo cũ hơn bản đã có (vd: từ file JSON) thì không ghi đè lệnh của lần chạy mới hơn
      const { rows: [newest] } = await client.query("SELECT max(generated_at) AS at FROM backtest_runs WHERE kind = 'report'");
      if (newest.at.getTime() <= Date.parse(report.generatedAt)) await replaceTrades(client, runId, report);
    }
    return runId;
  });
}

/**
 * Lưu kết quả kiểm tra tín hiệu theo ngày (npm run backtest:day): mỗi ngày mỗi tài sản một dòng (kind 'day'), chạy lại
 * cùng ngày thì thay bằng kết quả mới nhất (lệnh còn mở ở lần chạy trước có thể đã có kết quả). Kết quả lỗi ở mọi khung
 * không được lưu, và không ghi đè kết quả đã lưu có ít khung lỗi hơn (vd: TradingView lỗi tạm thời ở lần chạy lại).
 * @param {Array<object>} results - Kết quả daySignalsFor của từng tài sản (hoặc { symbol, error })
 * @param {object} meta - Thông tin chung lưu kèm (planSignature, horizonBars, cooldownBars)
 * @returns {Promise<{saved: Array<string>, skipped: Array<string>}>} Tài sản đã lưu / bỏ qua
 */
async function saveDayChecks(results, meta) {
  const usable = (res) => !res.error && (res.timeframes || []).some((t) => !t.error);
  const saved = [];
  const skipped = results.filter((res) => !usable(res)).map((res) => res.symbol);
  await withTransaction(async (client) => {
    for (const res of results.filter(usable)) {
      const { rowCount } = await client.query(
        `INSERT INTO backtest_runs (kind, generated_at, year, plan_signature, payload) VALUES ('day', $1, $2, $3, $4)
         ON CONFLICT ((payload->>'day'), (payload->>'symbol')) WHERE kind = 'day'
         DO UPDATE SET generated_at = EXCLUDED.generated_at, year = EXCLUDED.year, plan_signature = EXCLUDED.plan_signature, payload = EXCLUDED.payload
         WHERE (SELECT count(*) FROM jsonb_array_elements(EXCLUDED.payload->'timeframes') t WHERE t ? 'error')
            <= (SELECT count(*) FROM jsonb_array_elements(backtest_runs.payload->'timeframes') t WHERE t ? 'error')`,
        [res.generatedAt, Number(res.day.slice(0, 4)), meta.planSignature || null, { ...meta, ...res }]);
      (rowCount > 0 ? saved : skipped).push(res.symbol);
    }
  });
  return { saved, skipped };
}

/**
 * Thông tin bản lưu mới nhất (kind, và năm với báo cáo theo tháng) để quyết định có cần tạo lại báo cáo không
 */
async function latestRunMeta(kind, year = null) {
  const { rows } = await query(
    `SELECT generated_at, payload->>'version' AS version, plan_signature FROM backtest_runs
     WHERE kind = $1 AND ($2::int IS NULL OR year = $2) ORDER BY generated_at DESC LIMIT 1`,
    [kind, year]);
  if (rows.length === 0) return null;
  return { generatedAt: rows[0].generated_at.toISOString(), version: Number(rows[0].version) || 1, planSignature: rows[0].plan_signature };
}

/**
 * Báo cáo tổng hợp mới nhất, danh sách lệnh của từng phương pháp lấy từ toàn bộ lệnh đã cộng dồn.
 * historyFrom: dữ liệu sớm nhất từng có của khung (có thể có khoảng trống nếu bot ngừng tạo báo cáo lâu hơn
 * lịch sử nguồn dữ liệu trả về)
 */
async function latestReport() {
  const { rows } = await query("SELECT payload FROM backtest_runs WHERE kind = 'report' ORDER BY generated_at DESC LIMIT 1");
  if (rows.length === 0) return null;
  const report = rows[0].payload;
  if (!hasTradeLog(report)) return report;

  const [trades, coverage] = await Promise.all([
    query(`SELECT symbol, timeframe, strategy, (extract(epoch FROM entry_time) / 60)::int AS minute, action, outcome, net_r
           FROM backtest_trades ORDER BY entry_time`),
    query(`SELECT r->>'symbol' AS symbol, r->>'timeframe' AS timeframe, min(r->>'from') AS since, count(*)::int AS runs
           FROM backtest_runs, jsonb_array_elements(payload->'results') AS r
           WHERE kind = 'report' AND COALESCE((payload->>'version')::int, 1) >= 2 AND r ? 'strategies'
           GROUP BY 1, 2`),
  ]);
  const logs = new Map();
  for (const t of trades.rows) {
    const key = `${t.symbol}|${t.timeframe}|${t.strategy}`;
    if (!logs.has(key)) logs.set(key, []);
    logs.get(key).push([t.minute, t.action === 'BUY' ? 1 : -1, OUTCOME_CODE[t.outcome], t.net_r]);
  }
  const since = new Map(coverage.rows.map((c) => [`${c.symbol}|${c.timeframe}`, c]));

  for (const res of report.results) {
    if (res.error || !res.strategies) continue;
    const cov = since.get(`${res.symbol}|${res.timeframe}`);
    if (cov && cov.since < res.from) res.historyFrom = cov.since;
    for (const [key, s] of logEntries(res)) s.log = logs.get(`${res.symbol}|${res.timeframe}|${key}`) || [];
  }
  report.history = { runs: Math.max(0, ...coverage.rows.map((c) => c.runs)) };
  return report;
}

/**
 * Báo cáo theo tháng mới nhất của một năm (mặc định năm gần nhất có báo cáo)
 */
async function latestMonthly(year) {
  const { rows } = await query(
    `SELECT payload FROM backtest_runs WHERE kind = 'monthly' AND ($1::int IS NULL OR year = $1)
     ORDER BY year DESC, generated_at DESC LIMIT 1`,
    [year]);
  return rows.length ? rows[0].payload : null;
}

// Báo cáo chỉ đổi khi có bản lưu mới: giữ kết quả đã dựng (báo cáo tổng hợp, báo cáo theo tháng của từng năm)
// cho tới khi id bản lưu mới nhất thay đổi
let cache = { id: undefined, report: null, years: [], monthly: new Map() };

/**
 * Dữ liệu cho tab báo cáo backtest của dashboard
 * @param {number|null} year - Năm của báo cáo theo tháng (null = năm gần nhất)
 */
async function loadBacktest(year = null) {
  const { rows: [head] } = await query("SELECT max(id) AS id FROM backtest_runs WHERE kind IN ('report', 'monthly')");
  if (cache.id !== head.id) {
    const [report, years] = await Promise.all([
      latestReport(),
      query("SELECT DISTINCT year FROM backtest_runs WHERE kind = 'monthly' AND year IS NOT NULL ORDER BY year DESC"),
    ]);
    cache = { id: head.id, report, years: years.rows.map((r) => r.year), monthly: new Map() };
  }
  if (!cache.monthly.has(year)) cache.monthly.set(year, await latestMonthly(year));
  return { report: cache.report, monthly: cache.monthly.get(year), monthlyYears: cache.years };
}

/**
 * Lưu báo cáo vừa tạo vào Postgres (nếu có cấu hình) rồi đóng kết nối, dùng ở cuối các script tạo báo cáo.
 * Trả về false nếu không lưu được: báo cáo vẫn còn trong file JSON để bot lưu bổ sung sau
 */
async function saveRunAndClose(kind, report) {
  if (!dbEnabled()) return false;
  try {
    await saveRun(kind, report);
    console.log('🗄️ [BacktestStore] Đã lưu báo cáo vào Postgres.');
    return true;
  } catch (err) {
    console.error(`❌ [BacktestStore] Không lưu được báo cáo vào Postgres (${err.message}); bot sẽ lưu bổ sung từ file JSON khi kết nối lại được.`);
    return false;
  } finally {
    await closeDb();
  }
}

/**
 * Lưu bổ sung báo cáo đang có trong file JSON mà Postgres chưa có (lần đầu bật Postgres, hoặc lần tạo báo cáo
 * trước không kết nối được Postgres)
 */
async function syncReportFiles() {
  for (const [kind, file] of [['report', CONFIG.backtestReportPath], ['monthly', CONFIG.backtestMonthlyPath]]) {
    const report = readJson(file, null);
    if (report && report.generatedAt && Array.isArray(report.results) && await saveRun(kind, report)) {
      console.log(`🗄️ [BacktestStore] Đã lưu ${file} (tạo lúc ${report.generatedAt}) vào Postgres.`);
    }
  }
}

module.exports = {
  saveRun,
  saveRunAndClose,
  saveDayChecks,
  latestRunMeta,
  loadBacktest,
  syncReportFiles,
};

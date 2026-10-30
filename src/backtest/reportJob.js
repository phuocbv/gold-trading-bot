const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CONFIG = require('../config');
const { readJson } = require('../services/jsonStore');
const { dbEnabled } = require('../services/db');
const { planSignature } = require('../strategies');
const { REPORT_VERSION } = require('./engine');
const { dayKey, dayStart } = require('./monthly');
const { latestRunMeta, syncReportFiles } = require('./store');

// Báo cáo backtest tổng hợp rồi tới báo cáo theo tháng, chạy lần lượt; mỗi script ghi ra một file báo cáo (và Postgres nếu có).
// version: phiên bản cấu trúc báo cáo tối thiểu, báo cáo cũ hơn được tạo lại
const REPORTS = {
  report: { script: 'backtestReport.js', output: () => CONFIG.backtestReportPath, version: REPORT_VERSION },
  monthly: { script: 'backtestMonthly.js', output: () => CONFIG.backtestMonthlyPath, version: 1 },
};
const ALL_JOBS = Object.keys(REPORTS).map((kind) => ({ kind, args: [] }));
const jobLabel = (job) => [REPORTS[job.kind].script, ...job.args].join(' ');

// Backtest mất vài phút CPU nên chạy ở tiến trình con để không chặn việc quét và phát tín hiệu của bot
let child = null;
const status = { running: false, startedAt: null, finishedAt: null, exitCode: null, reason: null };

// Bot dừng (Ctrl+C, PM2 restart) thì dừng luôn tiến trình tạo báo cáo đang chạy dở
process.on('exit', () => {
  if (child) child.kill();
});

/**
 * Chạy lần lượt các script trong `queue` ở tiến trình con; exitCode giữ mã lỗi đầu tiên
 */
function runQueue(queue, exitCode) {
  if (queue.length === 0) {
    child = null;
    // Script không lưu được vào Postgres (vd: mất kết nối) thì lưu bổ sung từ file JSON vừa ghi
    const synced = dbEnabled()
      ? syncReportFiles().catch((err) => console.error('❌ [BacktestReport] Không lưu được báo cáo vào Postgres:', err.message))
      : Promise.resolve();
    synced.finally(() => Object.assign(status, { running: false, finishedAt: new Date().toISOString(), exitCode }));
    return;
  }
  const [current, ...rest] = queue;

  // Khi không chạy được tiến trình, 'error' và 'exit' có thể cùng phát: chỉ chuyển sang script kế tiếp một lần
  let done = false;
  const next = (code) => {
    if (done) return;
    done = true;
    runQueue(rest, exitCode || code);
  };

  try {
    child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'scripts', REPORTS[current.kind].script), ...current.args],
      { stdio: 'inherit', env: process.env });
  } catch (err) {
    // spawn có thể ném lỗi đồng bộ (vd: ENOMEM); script kế tiếp được gọi từ handler 'exit' của tiến trình trước
    // nên không được để lỗi này lọt ra thành uncaught exception làm dừng bot
    console.error(`❌ [BacktestReport] Không chạy được ${jobLabel(current)}:`, err.message);
    child = null;
    next(-1);
    return;
  }
  try {
    os.setPriority(child.pid, 10); // ưu tiên thấp để không tranh CPU với bot
  } catch (e) {}

  child.on('exit', (code) => next(code ?? -1));
  child.on('error', (err) => {
    console.error(`❌ [BacktestReport] Không chạy được ${jobLabel(current)}:`, err.message);
    next(-1);
  });
}

/**
 * Bắt đầu tạo báo cáo backtest (bỏ qua nếu đang chạy). Trả về true nếu đã khởi chạy.
 * @param {string} reason
 * @param {Array<{kind: string, args: Array<string>}>} [jobs] - Báo cáo cần tạo (mặc định: tất cả, năm hiện tại)
 */
function startReportJob(reason, jobs = ALL_JOBS) {
  if (child || status.running || jobs.length === 0) return false;
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, reason });
  console.log(`📈 [BacktestReport] Bắt đầu tạo báo cáo backtest (${reason}): ${jobs.map(jobLabel).join(', ')} ở tiến trình riêng...`);
  runQueue(jobs, 0);
  return true;
}

/**
 * Thông tin bản báo cáo mới nhất: từ Postgres nếu có cấu hình (lỗi kết nối thì đọc file JSON)
 */
async function reportMeta(kind, year) {
  if (dbEnabled()) {
    try {
      return await latestRunMeta(kind, kind === 'monthly' ? year : null);
    } catch (err) {
      console.error('❌ [BacktestReport] Không đọc được báo cáo từ Postgres, dùng file JSON:', err.message);
    }
  }
  try {
    const report = readJson(REPORTS[kind].output(), null);
    return report && report.generatedAt
      ? { generatedAt: report.generatedAt, version: report.version || 1, planSignature: report.planSignature }
      : null;
  } catch (err) {
    return null;
  }
}

/**
 * Các báo cáo cần tạo: chưa có, cũ hơn `maxAgeMs` (0 = tạo lại tất cả), có cấu trúc cũ, hoặc được tạo theo cấu hình
 * STRATEGIES khác hiện tại. Có Postgres thì giữ được báo cáo theo tháng của từng năm, nên tạo thêm báo cáo năm trước
 * nếu chưa có bản nào tạo sau khi năm đó kết thúc (để có đủ các ngày cuối năm)
 */
async function pendingReports(maxAgeMs) {
  const signature = planSignature();
  const year = Number(dayKey(Date.now()).slice(0, 4));
  const jobs = [];
  for (const kind of Object.keys(REPORTS)) {
    const meta = await reportMeta(kind, year);
    if (!meta || Date.now() - Date.parse(meta.generatedAt) > maxAgeMs || meta.version < REPORTS[kind].version || meta.planSignature !== signature) {
      jobs.push({ kind, args: [] });
    }
  }
  if (dbEnabled()) {
    try {
      const last = await latestRunMeta('monthly', year - 1);
      if (!last || Date.parse(last.generatedAt) < dayStart(`${year}-01-01`)) jobs.push({ kind: 'monthly', args: ['--year', String(year - 1)] });
    } catch (err) {
      // Đã báo lỗi kết nối ở trên; năm trước sẽ được tạo ở lần chạy sau
    }
  }
  return jobs;
}

function getReportJobStatus() {
  return { ...status };
}

module.exports = {
  startReportJob,
  pendingReports,
  getReportJobStatus,
};

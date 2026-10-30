const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CONFIG = require('../config');
const { readJson } = require('../services/jsonStore');
const { planSignature } = require('../strategies');
const { REPORT_VERSION } = require('./engine');

// Báo cáo backtest tổng hợp rồi tới báo cáo theo tháng, chạy lần lượt; mỗi script ghi ra một file báo cáo.
// version: phiên bản cấu trúc báo cáo tối thiểu, báo cáo cũ hơn được tạo lại
const REPORTS = [
  { script: 'backtestReport.js', output: () => CONFIG.backtestReportPath, version: REPORT_VERSION },
  { script: 'backtestMonthly.js', output: () => CONFIG.backtestMonthlyPath, version: 1 },
].map((r) => ({ ...r, scriptPath: path.join(__dirname, '..', '..', 'scripts', r.script) }));

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
    Object.assign(status, { running: false, finishedAt: new Date().toISOString(), exitCode });
    child = null;
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
    child = spawn(process.execPath, [current.scriptPath], { stdio: 'inherit', env: process.env });
  } catch (err) {
    // spawn có thể ném lỗi đồng bộ (vd: ENOMEM); script kế tiếp được gọi từ handler 'exit' của tiến trình trước
    // nên không được để lỗi này lọt ra thành uncaught exception làm dừng bot
    console.error(`❌ [BacktestReport] Không chạy được ${current.script}:`, err.message);
    child = null;
    next(-1);
    return;
  }
  try {
    os.setPriority(child.pid, 10); // ưu tiên thấp để không tranh CPU với bot
  } catch (e) {}

  child.on('exit', (code) => next(code ?? -1));
  child.on('error', (err) => {
    console.error(`❌ [BacktestReport] Không chạy được ${current.script}:`, err.message);
    next(-1);
  });
}

/**
 * Bắt đầu tạo báo cáo backtest (bỏ qua nếu đang chạy). Trả về true nếu đã khởi chạy.
 * @param {string} reason
 * @param {Array<string>} [scripts] - Tên script cần chạy (mặc định: tất cả)
 */
function startReportJob(reason, scripts = REPORTS.map((r) => r.script)) {
  if (child || status.running) return false;
  const queue = REPORTS.filter((r) => scripts.includes(r.script));
  if (queue.length === 0) return false;
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, reason });
  console.log(`📈 [BacktestReport] Bắt đầu tạo báo cáo backtest (${reason}): ${queue.map((r) => r.script).join(', ')} ở tiến trình riêng...`);
  runQueue(queue, 0);
  return true;
}

/**
 * Các script cần chạy lại: báo cáo chưa có, cũ hơn `maxAgeMs`, có cấu trúc cũ, hoặc được tạo theo
 * cấu hình STRATEGIES khác hiện tại
 */
function staleReports(maxAgeMs) {
  const signature = planSignature();
  return REPORTS.filter((r) => {
    let report = null;
    try {
      report = readJson(r.output(), null);
    } catch (err) {
      return true;
    }
    if (!report || !report.generatedAt) return true;
    return Date.now() - Date.parse(report.generatedAt) > maxAgeMs
      || (report.version || 1) < r.version
      || report.planSignature !== signature;
  }).map((r) => r.script);
}

function getReportJobStatus() {
  return { ...status };
}

module.exports = {
  startReportJob,
  staleReports,
  getReportJobStatus,
};

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CONFIG = require('../config');

// Báo cáo backtest tổng hợp rồi tới báo cáo theo tháng, chạy lần lượt
const SCRIPTS = ['backtestReport.js', 'backtestMonthly.js'].map((file) => path.join(__dirname, '..', '..', 'scripts', file));

// Backtest mất vài phút CPU nên chạy ở tiến trình con để không chặn việc quét và phát tín hiệu của bot
let child = null;
const status = { running: false, startedAt: null, finishedAt: null, exitCode: null, reason: null };

// Bot dừng (Ctrl+C, PM2 restart) thì dừng luôn tiến trình tạo báo cáo đang chạy dở
process.on('exit', () => {
  if (child) child.kill();
});

/**
 * Chạy script thứ `index` ở tiến trình con, xong thì chạy script kế tiếp; exitCode giữ mã lỗi đầu tiên
 */
function runScript(index, exitCode) {
  if (index >= SCRIPTS.length) {
    Object.assign(status, { running: false, finishedAt: new Date().toISOString(), exitCode });
    child = null;
    return;
  }

  child = spawn(process.execPath, [SCRIPTS[index]], { stdio: 'inherit', env: process.env });
  try {
    os.setPriority(child.pid, 10); // ưu tiên thấp để không tranh CPU với bot
  } catch (e) {}

  // Khi không chạy được tiến trình, 'error' và 'exit' có thể cùng phát: chỉ chuyển sang script kế tiếp một lần
  let done = false;
  const next = (code) => {
    if (done) return;
    done = true;
    runScript(index + 1, exitCode || code);
  };
  child.on('exit', (code) => next(code ?? -1));
  child.on('error', (err) => {
    console.error(`❌ [BacktestReport] Không chạy được ${path.basename(SCRIPTS[index])}:`, err.message);
    next(-1);
  });
}

/**
 * Bắt đầu tạo báo cáo backtest (bỏ qua nếu đang chạy). Trả về true nếu đã khởi chạy.
 */
function startReportJob(reason) {
  if (child) return false;
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, reason });
  console.log(`📈 [BacktestReport] Bắt đầu tạo báo cáo backtest (${reason}) ở tiến trình riêng...`);
  runScript(0, 0);
  return true;
}

/**
 * Tuổi của báo cáo cũ nhất (ms); Infinity nếu còn thiếu báo cáo
 */
function reportAgeMs() {
  return Math.max(...[CONFIG.backtestReportPath, CONFIG.backtestMonthlyPath].map((file) => {
    try {
      return Date.now() - fs.statSync(file).mtimeMs;
    } catch (err) {
      return Infinity;
    }
  }));
}

function getReportJobStatus() {
  return { ...status };
}

module.exports = {
  startReportJob,
  reportAgeMs,
  getReportJobStatus,
};

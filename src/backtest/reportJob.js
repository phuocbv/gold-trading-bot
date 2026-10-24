const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const CONFIG = require('../config');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'backtestReport.js');

// Backtest mất vài phút CPU nên chạy ở tiến trình con để không chặn việc quét và phát tín hiệu của bot
let child = null;
const status = { running: false, startedAt: null, finishedAt: null, exitCode: null, reason: null };

// Bot dừng (Ctrl+C, PM2 restart) thì dừng luôn tiến trình tạo báo cáo đang chạy dở
process.on('exit', () => {
  if (child) child.kill();
});

/**
 * Bắt đầu tạo báo cáo backtest (bỏ qua nếu đang chạy). Trả về true nếu đã khởi chạy.
 */
function startReportJob(reason) {
  if (child) return false;
  Object.assign(status, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, reason });
  console.log(`📈 [BacktestReport] Bắt đầu tạo báo cáo backtest (${reason}) ở tiến trình riêng...`);

  child = spawn(process.execPath, [SCRIPT], { stdio: 'inherit', env: process.env });
  try {
    os.setPriority(child.pid, 10); // ưu tiên thấp để không tranh CPU với bot
  } catch (e) {}

  child.on('exit', (code) => {
    Object.assign(status, { running: false, finishedAt: new Date().toISOString(), exitCode: code });
    child = null;
  });
  child.on('error', (err) => {
    console.error('❌ [BacktestReport] Không chạy được tiến trình tạo báo cáo:', err.message);
    Object.assign(status, { running: false, finishedAt: new Date().toISOString(), exitCode: -1 });
    child = null;
  });
  return true;
}

/**
 * Tuổi của báo cáo hiện có (ms); Infinity nếu chưa có báo cáo
 */
function reportAgeMs() {
  try {
    return Date.now() - fs.statSync(CONFIG.backtestReportPath).mtimeMs;
  } catch (err) {
    return Infinity;
  }
}

function getReportJobStatus() {
  return { ...status };
}

module.exports = {
  startReportJob,
  reportAgeMs,
  getReportJobStatus,
};

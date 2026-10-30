const fs = require('fs');
const CONFIG = require('../config');
const { listSignals, describeAsset } = require('../services/signalTracker');
const { getNewsOverview } = require('../services/newsCalendar');
const { getStrategyPlan } = require('../strategies');
const { primaryStrategyName } = require('../tradeOutcome');
const { readJson } = require('../services/jsonStore');
const { getReportJobStatus } = require('../backtest/reportJob');

// Báo cáo backtest chỉ đổi mỗi tuần: giữ bản đã đọc, chỉ đọc lại khi file thay đổi
const reportCache = new Map();
function readReport(file) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    return null;
  }
  const cached = reportCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;
  const data = readJson(file, null);
  reportCache.set(file, { mtimeMs, data });
  return data;
}

/**
 * Chặn truy cập dashboard khi có cấu hình DASHBOARD_TOKEN mà URL không kèm ?token= đúng
 */
function requireToken(req, res, next) {
  if (!CONFIG.dashboardToken || req.query.token === CONFIG.dashboardToken) return next();
  res.status(401).send('Unauthorized');
}

/**
 * Đăng ký trang thống kê tín hiệu (/dashboard) và API dữ liệu (/api/signals) vào Express app
 */
function registerDashboard(app) {
  app.get('/dashboard', requireToken, (req, res) => {
    // Dùng root để Express không chặn khi đường dẫn dự án chứa thư mục ẩn (vd: ~/.gemini/...)
    res.sendFile('index.html', { root: __dirname });
  });

  app.get('/api/signals', requireToken, (req, res) => {
    const records = listSignals();
    // Thứ tự tài sản cố định (theo cấu hình) để mỗi tài sản luôn giữ một màu trên biểu đồ
    const symbols = [...new Set([...CONFIG.symbols, ...records.map((r) => r.symbol)])];
    res.json({
      generatedAt: new Date().toISOString(),
      timeframe: CONFIG.timeframe,
      horizonBars: CONFIG.signalTrackHorizonBars,
      assets: symbols.map(describeAsset),
      // Phương pháp và khung đang chạy, để bộ lọc có đủ lựa chọn kể cả khi chưa có tín hiệu nào
      strategies: [...new Set([...getStrategyPlan().values()].flat().map((s) => primaryStrategyName(s.name)))],
      timeframes: [...getStrategyPlan().keys()],
      records,
    });
  });

  app.get('/api/news', requireToken, (req, res) => {
    res.json(getNewsOverview());
  });

  app.get('/api/backtest', requireToken, (req, res) => {
    res.json({
      report: readReport(CONFIG.backtestReportPath),
      monthly: readReport(CONFIG.backtestMonthlyPath),
      job: getReportJobStatus(),
      // Phương pháp đang bật theo từng khung, để báo cáo đánh dấu đúng kể cả khi cấu hình đổi sau lần chạy báo cáo
      active: Object.fromEntries([...getStrategyPlan()].map(([tf, list]) => [tf, list.map((s) => s.key)])),
    });
  });
}

module.exports = {
  registerDashboard,
};

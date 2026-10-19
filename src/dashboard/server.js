const CONFIG = require('../config');
const { listSignals, describeAsset } = require('../services/signalTracker');
const { getNewsOverview } = require('../services/newsCalendar');
const { strategies } = require('../strategies');
const { primaryStrategyName } = require('../tradeOutcome');

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
      // Toàn bộ phương pháp đang chạy, để bộ lọc có đủ lựa chọn kể cả khi chưa có tín hiệu nào
      strategies: strategies.map((s) => primaryStrategyName(s.name)),
      records,
    });
  });

  app.get('/api/news', requireToken, (req, res) => {
    res.json(getNewsOverview());
  });
}

module.exports = {
  registerDashboard,
};

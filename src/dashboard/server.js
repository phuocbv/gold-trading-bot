const fs = require('fs');
const CONFIG = require('../config');
const { listSignals, listStoredSignals, describeAsset } = require('../services/signalTracker');
const { getNewsOverview } = require('../services/newsCalendar');
const { getStrategyPlan } = require('../strategies');
const { primaryStrategyName } = require('../tradeOutcome');
const { readJson } = require('../services/jsonStore');
const { getReportJobStatus } = require('../backtest/reportJob');
const { loadBacktest } = require('../backtest/store');
const { dbEnabled } = require('../services/db');
const { parseDay, daySignalsFor } = require('../backtest/daySignals');
const { dayKey } = require('../backtest/monthly');

// Kiểm tra tín hiệu theo ngày tải dữ liệu mất vài giây: chạy lần lượt từng yêu cầu và giữ kết quả mỗi ngày trong một phút
const DAY_CHECK_TTL_MS = 60 * 1000;
const dayChecks = new Map();
let dayCheckQueue = Promise.resolve();

function checkDay(day) {
  const now = Date.now();
  for (const [key, entry] of dayChecks) if (now - entry.at > DAY_CHECK_TTL_MS) dayChecks.delete(key);
  if (!dayChecks.has(day)) {
    const run = dayCheckQueue.then(async () => {
      const plan = getStrategyPlan();
      const results = [];
      for (const symbol of CONFIG.symbols) {
        try {
          results.push(await daySignalsFor(symbol, plan, day));
        } catch (err) {
          results.push({ symbol, day, error: err.message });
        }
      }
      return { day, generatedAt: new Date().toISOString(), results };
    });
    dayCheckQueue = run.catch(() => {});
    dayChecks.set(day, { at: now, promise: run });
  }
  return dayChecks.get(day).promise;
}

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

  // Đọc từ Postgres ở mỗi lần tải (lỗi kết nối thì dùng danh sách trong bộ nhớ của bot, chỉ báo lỗi một lần mỗi đợt)
  let signalsDbFailing = false;
  app.get('/api/signals', requireToken, async (req, res) => {
    let records;
    try {
      records = await listStoredSignals();
      signalsDbFailing = false;
    } catch (err) {
      if (!signalsDbFailing) console.error('❌ [Dashboard] Không đọc được tín hiệu từ Postgres, dùng dữ liệu trong bộ nhớ:', err.message);
      signalsDbFailing = true;
      records = listSignals();
    }
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

  // ?year=YYYY: báo cáo theo tháng của năm đó (chỉ có khi lưu Postgres; mặc định năm gần nhất)
  app.get('/api/backtest', requireToken, async (req, res) => {
    const year = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : null;
    let stored = null;
    if (dbEnabled()) {
      try {
        stored = await loadBacktest(year);
      } catch (err) {
        console.error('❌ [Dashboard] Không đọc được báo cáo từ Postgres, dùng file JSON:', err.message);
      }
    }
    // Postgres chưa có báo cáo (vd: vừa bật, chưa lưu bổ sung xong) hoặc lỗi kết nối thì đọc file JSON
    const fileMonthly = () => {
      const monthly = readReport(CONFIG.backtestMonthlyPath);
      return monthly && (year == null || monthly.year === year) ? monthly : null;
    };
    res.json({
      storage: stored && stored.report ? 'postgres' : 'file',
      report: (stored && stored.report) || readReport(CONFIG.backtestReportPath),
      monthly: (stored && stored.monthly) || fileMonthly(),
      monthlyYears: stored ? stored.monthlyYears : [],
      job: getReportJobStatus(),
      // Phương pháp đang bật theo từng khung, để báo cáo đánh dấu đúng kể cả khi cấu hình đổi sau lần chạy báo cáo
      active: Object.fromEntries([...getStrategyPlan()].map(([tf, list]) => [tf, list.map((s) => s.key)])),
    });
  });

  // Các phương pháp đang bật cho tín hiệu gì trong một ngày (?date=YYYY-MM-DD, giờ VN)
  app.get('/api/backtest/day', requireToken, async (req, res) => {
    const day = parseDay(String(req.query.date || ''));
    if (!day || day > dayKey(Date.now())) {
      res.status(400).json({ error: 'Ngày không hợp lệ hoặc chưa tới' });
      return;
    }
    try {
      res.json(await checkDay(day));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  registerDashboard,
};

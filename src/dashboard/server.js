const fs = require('fs');
const zlib = require('zlib');
const express = require('express');
const CONFIG = require('../config');
const { loginEnabled, sessionUser, login, logout, requireAuth } = require('./auth');
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
const { listRuns: listCryptoRuns, latestRun: latestCryptoRun } = require('../crypto/store');

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
 * Đăng ký trang thống kê tín hiệu (/dashboard), trang đăng nhập (/login) và API dữ liệu (/api/*) vào Express app
 */
function registerDashboard(app) {
  // Đường dẫn chuyển hướng tương đối để vẫn đúng khi dashboard nằm sau tiền tố proxy
  app.get('/login', (req, res) => {
    if (!loginEnabled() || sessionUser(req)) return res.redirect(303, 'dashboard');
    res.set('Cache-Control', 'no-store');
    res.sendFile('login.html', { root: __dirname });
  });

  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    if (!loginEnabled()) return res.redirect(303, 'dashboard');
    const result = login(req, res, (req.body || {}).username, (req.body || {}).password);
    res.redirect(303, result === 'ok' ? 'dashboard' : `login?error=${result}`);
  });

  app.post('/logout', (req, res) => {
    logout(req, res);
    res.redirect(303, 'login');
  });

  app.get('/dashboard', requireAuth, (req, res) => {
    // Dùng root để Express không chặn khi đường dẫn dự án chứa thư mục ẩn (vd: ~/.gemini/...)
    res.sendFile('index.html', { root: __dirname });
  });

  // Đọc từ Postgres ở mỗi lần tải (lỗi kết nối thì dùng danh sách trong bộ nhớ của bot, chỉ báo lỗi một lần mỗi đợt)
  let signalsDbFailing = false;
  app.get('/api/signals', requireAuth, async (req, res) => {
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
      // Tài khoản đang đăng nhập (để dashboard hiện nút Đăng xuất); null khi không dùng đăng nhập
      user: sessionUser(req),
      timeframe: CONFIG.timeframe,
      horizonBars: CONFIG.signalTrackHorizonBars,
      assets: symbols.map(describeAsset),
      // Phương pháp và khung đang chạy, để bộ lọc có đủ lựa chọn kể cả khi chưa có tín hiệu nào
      strategies: [...new Set([...getStrategyPlan().values()].flat().map((s) => primaryStrategyName(s.name)))],
      timeframes: [...getStrategyPlan().keys()],
      records,
    });
  });

  app.get('/api/news', requireAuth, (req, res) => {
    res.json(getNewsOverview());
  });

  // ?year=YYYY: báo cáo theo tháng của năm đó (chỉ có khi lưu Postgres; mặc định năm gần nhất)
  app.get('/api/backtest', requireAuth, async (req, res) => {
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

  // Trang backtest riêng cho BTC/ETH (dữ liệu do npm run backtest:crypto tạo), tách khỏi dashboard tín hiệu
  app.get('/crypto-backtest', requireAuth, (req, res) => {
    res.sendFile('crypto.html', { root: __dirname });
  });

  // Không có ?symbol: danh sách tài sản đã có kết quả. Có ?symbol=BTCUSDT: lần chạy mới nhất của tài sản đó
  // (1-2 MB JSON nên gửi bản nén gzip, giữ sẵn theo lần chạy và trả 304 khi trình duyệt đã có)
  const cryptoCache = new Map();
  app.get('/api/crypto-backtest', requireAuth, async (req, res) => {
    try {
      const runs = await listCryptoRuns();
      const symbol = String(req.query.symbol || '').toUpperCase();
      if (!symbol) return res.json({ runs });
      const head = runs.find((r) => r.symbol === symbol);
      if (!head) return res.status(404).json({ error: `Chưa có kết quả backtest cho ${symbol} (chạy npm run backtest:crypto)` });
      let entry = cryptoCache.get(symbol);
      if (!entry || entry.id !== head.id) {
        const body = Buffer.from(JSON.stringify(await latestCryptoRun(symbol)));
        entry = { id: head.id, etag: `"crypto-${symbol}-${head.id}"`, body, gzip: zlib.gzipSync(body) };
        cryptoCache.set(symbol, entry);
      }
      res.set({ ETag: entry.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
      if (req.get('if-none-match') === entry.etag) return res.status(304).end();
      res.type('application/json');
      if (/\bgzip\b/.test(req.get('accept-encoding') || '')) {
        res.set('Content-Encoding', 'gzip');
        return res.send(entry.gzip);
      }
      return res.send(entry.body);
    } catch (err) {
      console.error('❌ [Dashboard] Không đọc được backtest crypto:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Các phương pháp đang bật cho tín hiệu gì trong một ngày (?date=YYYY-MM-DD, giờ VN)
  app.get('/api/backtest/day', requireAuth, async (req, res) => {
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

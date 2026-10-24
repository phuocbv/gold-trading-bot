require('dotenv').config();

const path = require('path');
const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Gộp cả GEMINI_API_KEYS và GEMINI_API_KEY (bỏ giá trị mẫu), để giá trị mẫu của biến này không che key thật của biến kia
function parseGeminiKeys() {
  const raw = [process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY].filter(Boolean).join(',');
  const keys = raw
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k && !k.includes('YOUR_GEMINI'));
  return [...new Set(keys)];
}

const geminiApiKeys = parseGeminiKeys();

function parseList(raw) {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const rawSymbols = process.env.SYMBOLS || process.env.SYMBOL || 'XAU/USD';
const timeframe = process.env.TIMEFRAME || '15m';

// Phương pháp và khung thời gian chạy: "tên@khung" cách nhau bởi dấu phẩy; thiếu "@khung" thì dùng TIMEFRAME.
// Theo backtest Vàng (2 năm gần nhất và 40 năm khung ngày, đã trừ spread):
// - Donchian 55 lãi cả hai năm ở mọi khung từ 30m tới 1D, tốt nhất ở 2h (+0.38R/lệnh), 4h (+0.34R) và 1D
// - Supertrend(10,3) chỉ có lợi thế ở khung ngày (lãi ở cả 5 giai đoạn thị trường 1990-2026)
// - Order Flow lỗ ở gần như mọi khung nên mặc định tắt (vẫn bật lại được bằng "order-flow")
// Donchian 1h đạt chuẩn sát ngưỡng và đang lỗ vài tháng gần nhất nên chưa bật (thêm "donchian-55@1h" nếu muốn).
const DEFAULT_STRATEGIES = 'trend-following,mean-reversion,volatility-breakout,smc-lite,rsi-divergence,smart-money-flow,'
  + 'donchian-55@2h,donchian-55@4h,donchian-55@1d,supertrend@1d';
function parseStrategyPlan(raw) {
  return parseList(raw).map((entry) => {
    const [key, tf] = entry.split('@');
    return { key: key.trim().toLowerCase(), timeframe: (tf || timeframe).trim().toLowerCase() };
  });
}
const parsedSymbols = rawSymbols.split(',').map((s) => s.trim()).filter(Boolean);

const CONFIG = {
  // Cấu hình thị trường & Nguồn dữ liệu (Hỗ trợ đa tài sản Vàng & Crypto)
  symbols: parsedSymbols.length > 0 ? parsedSymbols : ['XAU/USD'],
  symbol: parsedSymbols[0] || 'XAU/USD',
  timeframe,
  strategyPlan: parseStrategyPlan(process.env.STRATEGIES || DEFAULT_STRATEGIES),
  higherTimeframe: process.env.HIGHER_TIMEFRAME || '1h',
  cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *',
  minConfluenceScore: parseInt(process.env.MIN_CONFLUENCE_SCORE || '65', 10),
  marketDataSource: (process.env.MARKET_DATA_SOURCE || 'TRADINGVIEW').toUpperCase(),
  tradingViewSymbol: process.env.TRADINGVIEW_SYMBOL || 'OANDA:XAUUSD',
  priceOffset: parseFloat(process.env.PRICE_OFFSET || '0'),

  // Cấu hình Telegram
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramApiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',

  // Cấu hình AI (Gemini)
  geminiApiKeys,
  geminiApiKey: geminiApiKeys[0] || null,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  // AI_FILTER_ENABLED=false tắt hẳn bộ lọc (vẫn giữ key cho bản tin định kỳ); không đặt thì bật khi có key
  aiFilterEnabled: process.env.AI_FILTER_ENABLED ? process.env.AI_FILTER_ENABLED === 'true' : geminiApiKeys.length > 0,
  aiMinConfidence: parseInt(process.env.AI_MIN_CONFIDENCE || '75', 10),

  // Cấu hình Quản lý Rủi ro & Ngưỡng điểm chiến lược
  minStrategyScore: parseInt(process.env.MIN_STRATEGY_SCORE || '70', 10),
  // Không phát lại tín hiệu cùng chiều trên cùng tài sản trong N nến kể từ lần gửi trước
  signalCooldownBars: parseInt(process.env.SIGNAL_COOLDOWN_BARS || '4', 10),
  // Giờ UTC bắt đầu phiên để reset VWAP (0 = 00:00 UTC; Forex/Vàng có thể dùng 22)
  vwapSessionUtcHour: parseInt(process.env.VWAP_SESSION_UTC_HOUR || '0', 10),
  riskRewardMin: 1.5,
  atrMultiplierSl: 1.5,
  atrMultiplierTp: 3.0,

  // Theo dõi kết quả tín hiệu & Dashboard thống kê
  signalDbPath: process.env.SIGNAL_DB_PATH || path.join(__dirname, '..', 'data', 'signals.json'),
  // Lệnh chưa chạm TP1/SL sau N nến thì chốt theo giá đóng cửa (giống horizon mặc định của backtest)
  signalTrackHorizonBars: parseInt(process.env.SIGNAL_TRACK_HORIZON_BARS || '48', 10),
  // Nếu đặt, dashboard yêu cầu ?token=... trên URL
  dashboardToken: process.env.DASHBOARD_TOKEN || '',

  // Lịch tin tức kinh tế (ForexFactory): nhắn Telegram trước giờ ra tin & chặn tín hiệu quanh giờ ra tin
  newsEnabled: process.env.NEWS_ENABLED !== 'false',
  newsCurrencies: parseList(process.env.NEWS_CURRENCIES || 'USD').map((c) => c.toUpperCase()),
  // Chuẩn hóa theo cách viết của ForexFactory: High | Medium | Low
  newsImpacts: parseList(process.env.NEWS_IMPACTS || 'High').map((i) => i.charAt(0).toUpperCase() + i.slice(1).toLowerCase()),
  newsAlertMinutes: parseInt(process.env.NEWS_ALERT_MINUTES || '30', 10),
  newsBlackoutMinutes: parseInt(process.env.NEWS_BLACKOUT_MINUTES || '30', 10),
  // Feed đầu tiên là nguồn chính (tuần này); các feed sau là phụ (feed tuần sau thường 404 tới cuối tuần)
  newsFeedUrls: parseList(process.env.NEWS_FEED_URLS ||
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json,https://nfs.faireconomy.media/ff_calendar_nextweek.json'),
  newsStatePath: process.env.NEWS_STATE_PATH || path.join(__dirname, '..', 'data', 'news.json'),

  // Báo cáo backtest trên dashboard: chạy định kỳ ở tiến trình riêng (mặc định 9:00 Chủ nhật, thị trường Vàng nghỉ)
  backtestReportEnabled: process.env.BACKTEST_REPORT_ENABLED !== 'false',
  backtestReportCron: process.env.BACKTEST_REPORT_CRON || '0 9 * * 0',
  backtestReportTimeframes: parseList(process.env.BACKTEST_REPORT_TIMEFRAMES || '15m,30m,1h,2h,4h,1d').map((t) => t.toLowerCase()),
  backtestReportPath: process.env.BACKTEST_REPORT_PATH || path.join(__dirname, '..', 'data', 'backtest-report.json'),
};

module.exports = CONFIG;

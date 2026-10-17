require('dotenv').config();

const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

function parseGeminiKeys() {
  const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return raw
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k && !k.includes('YOUR_GEMINI'));
}

const geminiApiKeys = parseGeminiKeys();

const rawSymbols = process.env.SYMBOLS || process.env.SYMBOL || 'XAU/USD';
const parsedSymbols = rawSymbols.split(',').map((s) => s.trim()).filter(Boolean);

const CONFIG = {
  // Cấu hình thị trường & Nguồn dữ liệu (Hỗ trợ đa tài sản Vàng & Crypto)
  symbols: parsedSymbols.length > 0 ? parsedSymbols : ['XAU/USD'],
  symbol: parsedSymbols[0] || 'XAU/USD',
  timeframe: process.env.TIMEFRAME || '15m',
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
  aiFilterEnabled: process.env.AI_FILTER_ENABLED === 'true' || geminiApiKeys.length > 0,
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
};

module.exports = CONFIG;

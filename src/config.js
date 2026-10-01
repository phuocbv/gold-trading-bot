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

const CONFIG = {
  // Cấu hình thị trường
  symbol: process.env.SYMBOL || 'XAU/USD',
  timeframe: process.env.TIMEFRAME || '15m',
  higherTimeframe: process.env.HIGHER_TIMEFRAME || '1h',
  cronSchedule: process.env.CRON_SCHEDULE || '*/5 * * * *',

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
  riskRewardMin: 1.5,
  atrMultiplierSl: 1.5,
  atrMultiplierTp: 3.0,

  // Cấu hình Bot Scalping 1 Phút (1 Giá)
  scalp: {
    symbol: process.env.SCALP_SYMBOL || process.env.SYMBOL || 'XAU/USD',
    timeframe: '1m',
    cronSchedule: process.env.SCALP_CRON_SCHEDULE || '* * * * *',
    takeProfit: parseFloat(process.env.SCALP_TAKE_PROFIT || '1.0'), // Cứ 1 giá là đóng lệnh
    stopLoss: parseFloat(process.env.SCALP_STOP_LOSS || '1.5'), // Cắt lỗ theo người dùng cấu hình
    lotSize: parseFloat(process.env.EXNESS_LOT_SIZE || '0.01'), // Khối lượng lot giao dịch
    checkIntervalSec: parseInt(process.env.SCALP_CHECK_INTERVAL_SEC || '3', 10),
    minScore: parseInt(process.env.SCALP_MIN_SCORE || '70', 10),
    aiFilterEnabled: process.env.SCALP_AI_FILTER === 'true',
    port: parseInt(process.env.SCALP_PORT || '3001', 10),
  },
};

module.exports = CONFIG;

require('dotenv').config();

const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

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
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  aiFilterEnabled: process.env.AI_FILTER_ENABLED === 'true' || !!process.env.GEMINI_API_KEY,
  aiMinConfidence: parseInt(process.env.AI_MIN_CONFIDENCE || '75', 10),

  // Cấu hình Quản lý Rủi ro & Ngưỡng điểm chiến lược
  minStrategyScore: parseInt(process.env.MIN_STRATEGY_SCORE || '70', 10),
  riskRewardMin: 1.5,
  atrMultiplierSl: 1.5,
  atrMultiplierTp: 3.0,
};

module.exports = CONFIG;

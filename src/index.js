const cron = require('node-cron');
const express = require('express');
const CONFIG = require('./config');
const { scanMarket, runMarketBriefing } = require('./botEngine');

function startBot() {
  console.log('====================================================');
  console.log('🚀 HỆ THỐNG PHÂN TÍCH VÀ GIAO DỊCH VÀNG FOREX TỰ ĐỘNG');
  console.log(`📊 Cặp giao dịch: ${CONFIG.symbol} | Khung thời gian: ${CONFIG.timeframe}`);
  console.log(`⏰ Chu kỳ quét kỹ thuật: ${CONFIG.cronSchedule}`);
  console.log(`🤖 Trợ lý AI (Gemini): ${CONFIG.geminiApiKey ? `BẬT (${CONFIG.geminiModel})` : 'TẮT (Chế độ Kỹ thuật thuần)'}`);
  console.log('📈 Chiến lược kích hoạt:');
  console.log('   1. Trend Following (EMA Ribbon + MACD + RSI)');
  console.log('   2. Mean Reversion (Bollinger Bands + RSI Extremes)');
  console.log('   3. Volatility Breakout (Donchian Range + ATR Expansion)');
  console.log('   4. SMC Lite (Fair Value Gap + Order Block Retest)');
  console.log('====================================================');

  // Khởi chạy Web Server giả (Dummy Server) để giữ bot sống trên nền tảng Free (Render)
  const app = express();
  const PORT = process.env.PORT || 3000;
  
  app.get('/', (req, res) => {
    res.send('🟢 Gold Trading Bot đang hoạt động bình thường 24/7!');
  });
  
  app.get('/ping', (req, res) => {
    res.status(200).send('pong');
  });

  app.listen(PORT, () => {
    console.log(`\n🌐 Web server giả đang chạy tại cổng ${PORT} để tránh trạng thái Sleep.`);
  });

  // Chạy quét ngay lập tức khi khởi động
  scanMarket();

  // Đặt lịch quét định kỳ theo CRON
  cron.schedule(CONFIG.cronSchedule, () => {
    scanMarket();
  });

  // Đặt lịch gửi bản tin AI Briefing lúc 13:00 (đầu phiên Âu) và 19:30 (đầu phiên Mỹ) theo giờ VN
  cron.schedule('0 13,19 * * 1-5', () => {
    runMarketBriefing();
  });
}

// Xử lý dừng tiến trình an toàn
process.on('SIGINT', () => {
  console.log('\n🛑 Đã nhận lệnh dừng (Ctrl+C). Đang tắt Bot an toàn...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Đã nhận tín hiệu kết thúc tiến trình (Từ Hosting/VPS).');
  process.exit(0);
});

if (require.main === module) {
  startBot();
}

module.exports = { startBot };


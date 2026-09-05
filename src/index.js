const cron = require('node-cron');
const express = require('express');
const CONFIG = require('./config');
const { scanMarket, runMarketBriefing } = require('./botEngine');

function startBot() {
  console.log('====================================================');
  console.log('🚀 HỆ THỐNG PHÂN TÍCH VÀ GIAO DỊCH TỰ ĐỘNG (MULTI-ASSET)');
  console.log(`📊 Danh mục theo dõi: ${CONFIG.symbols.join(', ')} | Khung thời gian: ${CONFIG.timeframe}`);
  console.log(`⏰ Chu kỳ quét kỹ thuật: ${CONFIG.cronSchedule}`);
  console.log(`🤖 Trợ lý AI (Gemini): ${CONFIG.geminiApiKey ? `BẬT (${CONFIG.geminiModel})` : 'TẮT (Chế độ Kỹ thuật thuần)'}`);
  console.log('📈 6 Chiến lược kích hoạt:');
  console.log('   1. Trend Following (EMA Ribbon + ADX + MACD + StochRSI)');
  console.log('   2. Mean Reversion (Bollinger Bands + StochRSI + Price Action)');
  console.log('   3. Volatility Breakout (Donchian Range + Volume + ATR Expansion)');
  console.log('   4. SMC Lite (Fair Value Gap + Order Block Retest)');
  console.log('   5. RSI Divergence (Regular Divergence + Price Action Reversal)');
  console.log('   6. Smart Money Flow (VWAP + ADX + MFI Volume Confirmation)');
  console.log('====================================================');

  // Khởi chạy Web Server giả (Dummy Server) để giữ bot sống trên nền tảng Free (Render)
  const app = express();
  const PORT = process.env.PORT || 3000;
  
  app.get('/', (req, res) => {
    res.send(`🟢 Trading Bot đang hoạt động 24/7! Đang theo dõi: ${CONFIG.symbols.join(', ')}`);
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


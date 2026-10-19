const cron = require('node-cron');
const express = require('express');
const CONFIG = require('./config');
const { scanMarket, runMarketBriefing } = require('./botEngine');
const { strategies } = require('./strategies');
const { registerDashboard } = require('./dashboard/server');
const { refreshCalendar, checkNewsAlerts } = require('./services/newsCalendar');

async function startBot() {
  const isOnce = process.argv.includes('--once');
  const symbolsList = (CONFIG.symbols && CONFIG.symbols.length > 0) ? CONFIG.symbols.join(', ') : CONFIG.symbol;

  console.log('====================================================');
  console.log('🚀 HỆ THỐNG PHÂN TÍCH VÀ GIAO DỊCH VÀNG & CRYPTO TỰ ĐỘNG');
  console.log(`📊 Danh mục tài sản: ${symbolsList} | Khung thời gian: ${CONFIG.timeframe}`);
  console.log(`📡 Nguồn dữ liệu nến: ${CONFIG.marketDataSource} (${CONFIG.marketDataSource === 'TRADINGVIEW' ? CONFIG.tradingViewSymbol : 'Spot Binance'})`);
  const keyCount = CONFIG.geminiApiKeys ? CONFIG.geminiApiKeys.length : (CONFIG.geminiApiKey ? 1 : 0);
  const aiStatus = keyCount > 0 
    ? `BẬT (${keyCount} API Key trong pool | Model: ${CONFIG.geminiModel})` 
    : 'TẮT (Chế độ Kỹ thuật thuần)';
  console.log(`🤖 Trợ lý AI (Gemini): ${aiStatus}`);
  const newsStatus = CONFIG.newsEnabled
    ? `BẬT (${CONFIG.newsCurrencies.join('/')} mức ${CONFIG.newsImpacts.join('/')} | nhắn trước ${CONFIG.newsAlertMinutes} phút | chặn tín hiệu ±${CONFIG.newsBlackoutMinutes} phút)`
    : 'TẮT';
  console.log(`📰 Lịch tin tức: ${newsStatus}`);
  console.log(`📈 Chiến lược kích hoạt (${strategies.length}):`);
  strategies.forEach((s, idx) => {
    console.log(`   ${idx + 1}. ${s.name}`);
  });
  console.log('====================================================');

  // Chế độ quét một lần (--once)
  if (isOnce) {
    console.log('\n⚡ Chế độ kiểm tra nhanh (--once): Đang tiến hành quét 1 lượt rồi thoát...');
    await refreshCalendar();
    await scanMarket();
    console.log('✅ Hoàn tất lượt quét một lần. Tạm biệt!');
    process.exit(0);
  }

  // Khởi chạy Web Server giả (Dummy Server) để giữ bot sống trên nền tảng Free (Render)
  const app = express();
  const PORT = process.env.PORT || 3000;
  
  app.get('/', (req, res) => {
    res.send('🟢 Trading Bot (Gold & Crypto) đang hoạt động bình thường 24/7!');
  });
  
  app.get('/ping', (req, res) => {
    res.status(200).send('pong');
  });

  registerDashboard(app);

  app.listen(PORT, () => {
    console.log(`\n🌐 Web server giả đang chạy tại cổng ${PORT} để tránh trạng thái Sleep.`);
    console.log(`📊 Dashboard thống kê tín hiệu: http://localhost:${PORT}/dashboard${CONFIG.dashboardToken ? '?token=<DASHBOARD_TOKEN>' : ''}`);
  });

  // Tải lịch tin trước lượt quét đầu tiên để bộ chặn tín hiệu quanh giờ ra tin có dữ liệu
  await refreshCalendar();

  // Chạy quét ngay lập tức khi khởi động
  await scanMarket();

  // Mỗi phút kiểm tra tin sắp ra để nhắn Telegram trước giờ ra tin
  if (CONFIG.newsEnabled) {
    checkNewsAlerts().catch((err) => console.error('❌ [News] Lỗi kiểm tra lịch tin:', err.message));
    cron.schedule('* * * * *', () => {
      checkNewsAlerts().catch((err) => console.error('❌ [News] Lỗi kiểm tra lịch tin:', err.message));
    });
  }

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

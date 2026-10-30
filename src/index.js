const cron = require('node-cron');
const express = require('express');
const CONFIG = require('./config');
const { scanMarket, runMarketBriefing, strategyPlan } = require('./botEngine');
const { registerDashboard } = require('./dashboard/server');
const { refreshCalendar, checkNewsAlerts } = require('./services/newsCalendar');
const { startReportJob, staleReports } = require('./backtest/reportJob');

function logNewsError(err) {
  console.error('❌ [News] Lỗi lịch tin tức:', err.message);
}

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
  const activeCount = [...strategyPlan.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(`📈 Chiến lược kích hoạt (${activeCount}) theo khung thời gian:`);
  for (const [timeframe, list] of strategyPlan) {
    console.log(`   [${timeframe}] ${list.map((s) => s.name.split(' (')[0]).join(', ')}`);
  }
  console.log('====================================================');

  // Chế độ quét một lần (--once)
  if (isOnce) {
    console.log('\n⚡ Chế độ kiểm tra nhanh (--once): Đang tiến hành quét 1 lượt rồi thoát...');
    await refreshCalendar().catch(logNewsError);
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
  await refreshCalendar().catch(logNewsError);

  // Mỗi phút kiểm tra tin sắp ra để nhắn Telegram trước giờ ra tin (đặt lịch trước lượt quét đầu tiên vốn có thể chạy lâu)
  if (CONFIG.newsEnabled) {
    checkNewsAlerts().catch(logNewsError);
    cron.schedule('* * * * *', () => {
      checkNewsAlerts().catch(logNewsError);
    });
  }

  // Chạy quét ngay lập tức khi khởi động
  await scanMarket();

  // Đặt lịch quét định kỳ theo CRON
  cron.schedule(CONFIG.cronSchedule, () => {
    scanMarket();
  });

  // Báo cáo backtest cho dashboard: tạo ngay báo cáo nào chưa có, cũ hơn 7 ngày hoặc được tạo theo cấu hình
  // STRATEGIES khác hiện tại (chỉ chạy lại đúng báo cáo đó), sau đó chạy định kỳ
  if (CONFIG.backtestReportEnabled) {
    const stale = staleReports(7 * 24 * 3600 * 1000);
    if (stale.length > 0) startReportJob('chưa có báo cáo, báo cáo đã cũ hoặc cấu hình phương pháp đã đổi', stale);
    cron.schedule(CONFIG.backtestReportCron, () => startReportJob('lịch định kỳ'));
  }

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

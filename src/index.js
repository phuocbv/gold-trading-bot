const cron = require('node-cron');
const express = require('express');
const CONFIG = require('./config');
const { scanMarket, runMarketBriefing, strategyPlan } = require('./botEngine');
const { registerDashboard } = require('./dashboard/server');
const { refreshCalendar, checkNewsAlerts } = require('./services/newsCalendar');
const { startReportJob, pendingReports } = require('./backtest/reportJob');
const { syncReportFiles } = require('./backtest/store');
const { initSignalStore, flushSignals } = require('./services/signalTracker');
const { dbEnabled } = require('./services/db');

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
  console.log(`🗄️ Lưu trữ: ${dbEnabled() ? 'Postgres (DATABASE_URL) + file JSON dự phòng' : 'file JSON trong data/ (đặt DATABASE_URL để lưu vào Postgres)'}`);
  const activeCount = [...strategyPlan.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(`📈 Chiến lược kích hoạt (${activeCount}) theo khung thời gian:`);
  for (const [timeframe, list] of strategyPlan) {
    console.log(`   [${timeframe}] ${list.map((s) => s.name.split(' (')[0]).join(', ')}`);
  }
  console.log('====================================================');

  // Nạp tín hiệu đã ghi nhận (có Postgres thì gộp với file JSON) trước lượt quét đầu tiên
  await initSignalStore();

  // Chế độ quét một lần (--once)
  if (isOnce) {
    console.log('\n⚡ Chế độ kiểm tra nhanh (--once): Đang tiến hành quét 1 lượt rồi thoát...');
    await refreshCalendar().catch(logNewsError);
    await scanMarket();
    await flushSignals();
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

  // Báo cáo đang có trong file JSON mà Postgres chưa có (lần đầu bật Postgres, hoặc lần tạo trước mất kết nối)
  if (dbEnabled()) {
    await syncReportFiles().catch((err) => console.error('❌ [BacktestStore] Không lưu được báo cáo vào Postgres:', err.message));
  }

  // Báo cáo backtest cho dashboard: tạo ngay báo cáo nào chưa có, cũ hơn 7 ngày hoặc được tạo theo cấu hình
  // STRATEGIES khác hiện tại (chỉ chạy lại đúng báo cáo đó), sau đó chạy định kỳ
  if (CONFIG.backtestReportEnabled) {
    const jobs = await pendingReports(7 * 24 * 3600 * 1000);
    if (jobs.length > 0) startReportJob('chưa có báo cáo, báo cáo đã cũ hoặc cấu hình phương pháp đã đổi', jobs);
    cron.schedule(CONFIG.backtestReportCron, async () => {
      startReportJob('lịch định kỳ', await pendingReports(0));
    });
  }

  // Đặt lịch gửi bản tin AI Briefing lúc 13:00 (đầu phiên Âu) và 19:30 (đầu phiên Mỹ) theo giờ VN
  cron.schedule('0 13,19 * * 1-5', () => {
    runMarketBriefing();
  });
}

// Xử lý dừng tiến trình an toàn: chờ tối đa 5 giây để lưu nốt tín hiệu vào Postgres (phần chưa kịp lưu vẫn còn
// trong file JSON và được lưu bổ sung ở lần khởi động sau)
function shutdown() {
  Promise.race([flushSignals(), new Promise((resolve) => setTimeout(resolve, 5000))]).finally(() => process.exit(0));
}

process.on('SIGINT', () => {
  console.log('\n🛑 Đã nhận lệnh dừng (Ctrl+C). Đang tắt Bot an toàn...');
  shutdown();
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Đã nhận tín hiệu kết thúc tiến trình (Từ Hosting/VPS).');
  shutdown();
});

if (require.main === module) {
  startBot();
}

module.exports = { startBot };

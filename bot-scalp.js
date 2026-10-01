/**
 * Gold Scalping Bot (1-Minute / One-Price Scalper)
 * Entry point chạy riêng biệt cho bot scalping phân tích từng phút, chốt lời 1 giá
 */
const express = require('express');
const CONFIG = require('./src/config');
const ScalpEngine = require('./src/scalper/scalpEngine');

function startScalpBot() {
  const engine = new ScalpEngine();

  // Khởi chạy Web Server giữ bot luôn active trên Cloud (Render, Railway, VPS)
  const app = express();
  const PORT = CONFIG.scalp.port || 3001;

  app.get('/', (req, res) => {
    const stats = engine.getStats();
    res.json({
      name: 'Gold Scalping Bot 1M (One Price TP)',
      status: 'ONLINE',
      symbol: CONFIG.scalp.symbol,
      timeframe: CONFIG.scalp.timeframe,
      takeProfitTarget: `+${CONFIG.scalp.takeProfit.toFixed(2)} USD (1 giá)`,
      stopLossTarget: `-${CONFIG.scalp.stopLoss.toFixed(2)} USD (người dùng)`,
      currentPosition: stats.currentOpen,
      performance: {
        totalTrades: stats.totalTrades,
        wins: stats.wins,
        losses: stats.losses,
        winRate: `${stats.winRate}%`,
        totalPointsEarned: `${stats.totalPointsEarned} giá`,
      },
    });
  });

  app.get('/stats', (req, res) => {
    res.json(engine.getStats());
  });

  // API dành riêng cho EA chạy trong phần mềm MT5 (GoldScalpBridge.mq5)
  app.get('/api/mt5/order', (req, res) => {
    if (req.query.bid && req.query.ask) {
      engine.setMt5Price(parseFloat(req.query.bid), parseFloat(req.query.ask), req.query.symbol);
    }

    const pos = engine.tracker.getPosition();
    if (!pos) {
      return res.json({ hasOrder: false });
    }
    return res.json({
      hasOrder: true,
      id: pos.id,
      action: pos.action,
      symbol: req.query.symbol || process.env.EXNESS_SYMBOL || 'XAUUSD',
      lotSize: parseFloat(process.env.EXNESS_LOT_SIZE || '0.01'),
      entryPrice: pos.entryPrice,
      takeProfit: pos.takeProfit,
      stopLoss: pos.stopLoss,
      takeProfitPoints: pos.takeProfitPoints,
      stopLossPoints: pos.stopLossPoints,
    });
  });

  app.get('/ping', (req, res) => {
    res.status(200).send('pong');
  });

  app.listen(PORT, () => {
    console.log(`🌐 Server giám sát Scalp Bot đang lắng nghe tại cổng ${PORT}`);
  });

  // Khởi chạy engine scalping
  engine.start();

  // Xử lý dừng an toàn
  const handleShutdown = (signal) => {
    console.log(`\n🛑 Nhận tín hiệu ${signal}. Đang tắt Bot Scalping an toàn...`);
    engine.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

if (require.main === module) {
  startScalpBot();
}

module.exports = { startScalpBot };

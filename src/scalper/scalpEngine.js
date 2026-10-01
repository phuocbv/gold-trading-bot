const cron = require('node-cron');
const CONFIG = require('../config');
const { fetchCandles, fetchLivePrice } = require('../services/marketData');
const { sendScalpOpenAlert, sendScalpCloseAlert } = require('../services/telegram');
const OnePriceScalpStrategy = require('./scalpStrategy');
const PositionTracker = require('./positionTracker');
const ExnessMetaApiBroker = require('../brokers/exnessMetaApi');

class ScalpEngine {
  constructor() {
    this.config = CONFIG.scalp;
    this.strategy = new OnePriceScalpStrategy({
      takeProfitPoints: this.config.takeProfit,
      stopLossPoints: this.config.stopLoss,
    });
    this.tracker = new PositionTracker();
    this.broker = new ExnessMetaApiBroker();

    this.isScanning = false;
    this.isMonitoring = false;
    this.monitorTimer = null;
    this.lastHoldLogTime = 0;
    this.mt5LivePrice = null;
  }

  /**
   * Khởi chạy Scalping Engine
   */
  async start() {
    console.log('====================================================');
    console.log('⚡ KHỞI CHẠY BOT TRADING SCALPING VÀNG 1 PHÚT (1M)');
    console.log(`📊 Cặp: ${this.config.symbol} | Khung thời gian: ${this.config.timeframe}`);
    console.log(`🎯 Mục tiêu Chốt Lời (Take Profit): +${this.config.takeProfit.toFixed(2)} giá ($1.00 / lệnh)`);
    console.log(`🛡 Mức Cắt Lỗ (Stop Loss): -${this.config.stopLoss.toFixed(2)} giá (Tùy chỉnh người dùng)`);
    console.log(`📦 Khối lượng đặt lệnh MT5: ${this.config.lotSize} lot`);
    console.log(`⏱ Chu kỳ quét nến mới: ${this.config.cronSchedule} (Mỗi phút)`);
    console.log(`⚡ Giám sát giá Realtime: Mỗi ${this.config.checkIntervalSec} giây`);
    console.log(`🏆 Ngưỡng điểm tối thiểu: ${this.config.minScore}/100`);

    if (this.broker.isEnabled()) {
      console.log('🔌 Chế độ khớp lệnh: EXNESS MT5 (MetaApi Cloud)');
      console.log('====================================================\n');
      await this.broker.init();
    } else {
      console.log('💡 Chế độ khớp lệnh: PAPER TRADING (Giả lập)');
      console.log('👉 Muốn bắn lệnh thẳng vào tài khoản Exness MT5 Demo/Real: thêm META_API_TOKEN và META_API_ACCOUNT_ID vào .env');
      console.log('====================================================\n');
    }

    // 1. Quét nến 1m ngay lập tức khi khởi động
    this.scanCandle();

    // 2. Lập lịch quét nến định kỳ mỗi phút
    cron.schedule(this.config.cronSchedule, () => {
      this.scanCandle();
    });

    // 3. Khởi động vòng lặp giám sát giá tick realtime cho lệnh đang mở
    this.startRealtimePriceMonitor();
  }

  /**
   * Quét nến 1 Phút để tìm cơ hội vào lệnh mới
   */
  async scanCandle() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      const nowStr = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      // Nếu đang giữ vị thế mở -> Không vào thêm lệnh mới, tập trung theo dõi chốt lệnh
      if (this.tracker.hasOpenPosition()) {
        const pos = this.tracker.getPosition();
        console.log(`[${nowStr}] ⏳ [Scalp 1M] Đang giữ vị thế ${pos.action} @ $${pos.entryPrice} (TP: $${pos.takeProfit} | SL: $${pos.stopLoss}). Tạm hoãn mở lệnh mới.`);
        return;
      }

      console.log(`[${nowStr}] 🔍 [Scalp 1M] Đang tải nến 1m & 5m (${this.config.symbol}) và phân tích...`);
      const [marketData, marketData5m] = await Promise.all([
        fetchCandles(this.config.symbol, this.config.timeframe, 2),
        fetchCandles(this.config.symbol, '5m', 2).catch(() => null),
      ]);

      if (!marketData || !marketData.closes || marketData.closes.length < 60) {
        console.log(`⚠️ [Scalp 1M] Chưa đủ dữ liệu nến 1m (cần tối thiểu 60 nến).`);
        return;
      }

      const currentPrice = marketData.closes[marketData.closes.length - 1];
      const signal = this.strategy.analyze(marketData, marketData5m);
      const htfInfo = this.strategy.calculateHtfTrend(marketData5m);

      const isMt5Active = this.mt5LivePrice && (Date.now() - this.mt5LivePrice.timestamp < 10000);
      const displayPrice = isMt5Active ? this.mt5LivePrice.mid : currentPrice;

      if (!signal) {
        const sourceLabel = isMt5Active ? `MT5 ${this.mt5LivePrice.symbol}` : 'Binance';
        console.log(`ℹ️ [${nowStr}] [Scalp 1M] Giá hiện tại (${sourceLabel}): $${displayPrice.toFixed(2)} | Xu hướng 5M: ${htfInfo.label} -> Chưa có tín hiệu.`);
        return;
      }

      // Nếu có giá trực tiếp từ MT5 EA (GoldScalpBridge), chuẩn hóa entry, TP, SL theo giá MT5
      if (isMt5Active) {
        const mt5Entry = signal.action === 'BUY' ? this.mt5LivePrice.ask : this.mt5LivePrice.bid;
        signal.entry = mt5Entry;
        signal.takeProfit = signal.action === 'BUY'
          ? Number((mt5Entry + signal.takeProfitPoints).toFixed(2))
          : Number((mt5Entry - signal.takeProfitPoints).toFixed(2));
        signal.stopLoss = signal.action === 'BUY'
          ? Number((mt5Entry - signal.stopLossPoints).toFixed(2))
          : Number((mt5Entry + signal.stopLossPoints).toFixed(2));
        console.log(`   🔗 [MT5 Sync] Đã đồng bộ giá sàn MT5: Entry: $${signal.entry} | TP: $${signal.takeProfit} | SL: $${signal.stopLoss}`);
      }

      console.log(`\n⚡ [${nowStr}] Phát hiện tín hiệu: [${signal.action}] - ${signal.setupType} tại $${signal.entry.toFixed(2)} | Điểm: ${signal.score}/100 (${signal.rankBadge})`);
      if (signal.breakdown && signal.breakdown.length > 0) {
        console.log(`   📝 Đánh giá: ${signal.breakdown.join(' | ')}`);
      }

      // Lọc theo ngưỡng điểm chất lượng
      if (signal.score < this.config.minScore) {
        console.log(`✋ Tín hiệu bị bỏ qua do điểm (${signal.score}) thấp hơn ngưỡng tối thiểu (${this.config.minScore}).\n`);
        return;
      }

      // Mở vị thế giao dịch mới
      const openResult = this.tracker.openPosition(signal);
      if (openResult.success) {
        console.log(`🚀 [SCALP 1M] ĐÃ MỞ VỊ THẾ THÀNH CÔNG:`);
        console.log(`   👉 Lệnh: ${signal.action} @ $${signal.entry.toFixed(2)}`);
        console.log(`   🎯 Take Profit (+${signal.takeProfitPoints.toFixed(2)} giá): $${signal.takeProfit.toFixed(2)}`);
        console.log(`   🛡 Stop Loss (-${signal.stopLossPoints.toFixed(2)} giá): $${signal.stopLoss.toFixed(2)}`);

        // Bắn lệnh thật lên sàn Exness MT5 nếu broker đang kết nối
        if (this.broker.isReady) {
          try {
            const brokerRes = await this.broker.openMarketOrder(
              signal.action,
              signal.entry,
              signal.stopLoss,
              signal.takeProfit
            );
            if (brokerRes.success) {
              openResult.position.brokerPositionId = brokerRes.positionId;
              this.tracker.saveState();
              console.log(`   🔗 [Exness MT5] Mã vị thế (Position ID): ${brokerRes.positionId}`);
            }
          } catch (brokerErr) {
            console.error(`   ⚠️ [Exness MT5] Không thể gửi lệnh lên sàn:`, brokerErr.message);
          }
        }

        console.log(`   🔔 Đang phát thông báo Telegram...\n`);
        await sendScalpOpenAlert(openResult.position);
      }
    } catch (err) {
      console.error(`❌ [Scalp 1M] Lỗi trong chu kỳ quét nến:`, err.message);
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Giám sát giá Realtime liên tục mỗi X giây (Realtime Tick Price Monitor)
   */
  startRealtimePriceMonitor() {
    const intervalMs = Math.max(1000, this.config.checkIntervalSec * 1000);

    this.monitorTimer = setInterval(async () => {
      // Chỉ kiểm tra khi có vị thế đang mở
      if (!this.tracker.hasOpenPosition() || this.isMonitoring) {
        return;
      }

      this.isMonitoring = true;
      try {
        let livePrice = null;
        if (this.mt5LivePrice && (Date.now() - this.mt5LivePrice.timestamp < 10000)) {
          const pos = this.tracker.getPosition();
          livePrice = pos && pos.action === 'BUY' ? this.mt5LivePrice.bid : this.mt5LivePrice.ask;
        } else {
          livePrice = await fetchLivePrice(this.config.symbol);
        }
        if (livePrice == null) return;

        const checkRes = this.tracker.checkPrice(livePrice);
        if (!checkRes) return;

        // Trường hợp LỆNH ĐÃ ĐÓNG (Chốt lời hoặc Cắt lỗ)
        if (checkRes.closed) {
          const { type, trade, stats } = checkRes;
          const nowStr = new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

          // Đóng vị thế trên Exness MT5 nếu có brokerPositionId
          if (this.broker.isReady && trade.brokerPositionId) {
            try {
              await this.broker.closePosition(trade.brokerPositionId);
            } catch (closeErr) {
              console.error(`   ⚠️ [Exness MT5] Lỗi đóng vị thế sàn ${trade.brokerPositionId}:`, closeErr.message);
            }
          }

          if (type === 'TP') {
            console.log('\n====================================================');
            console.log(`🎉🎉🎉 [${nowStr}] [SCALP 1M] CHỐT LỜI THÀNH CÔNG (+1.00 GIÁ)! 🎉🎉🎉`);
            console.log(`👉 Lệnh: ${trade.action} | Entry: $${trade.entryPrice.toFixed(2)} -> Exit: $${trade.exitPrice.toFixed(2)}`);
            console.log(`💰 Lợi nhuận: +${trade.pnlPoints.toFixed(2)} giá | Thời gian giữ lệnh: ${trade.durationFormatted}`);
            console.log(`📈 Thống kê: Tổng ${stats.totalTrades} lệnh | Thắng: ${stats.wins} | Thua: ${stats.losses} | Winrate: ${stats.winRate}% | Tổng PnL: +${stats.totalPointsEarned} giá`);
            console.log('====================================================\n');
          } else {
            console.log('\n====================================================');
            console.log(`🛑 [${nowStr}] [SCALP 1M] ĐÃ ĐÓNG LỆNH CẮT LỖ (SL HIT) 🛑`);
            console.log(`👉 Lệnh: ${trade.action} | Entry: $${trade.entryPrice.toFixed(2)} -> Exit: $${trade.exitPrice.toFixed(2)}`);
            console.log(`🔻 PnL: ${trade.pnlPoints.toFixed(2)} giá | Thời gian giữ lệnh: ${trade.durationFormatted}`);
            console.log(`📈 Thống kê: Tổng ${stats.totalTrades} lệnh | Thắng: ${stats.wins} | Thua: ${stats.losses} | Winrate: ${stats.winRate}% | Tổng PnL: ${stats.totalPointsEarned} giá`);
            console.log('====================================================\n');
          }

          // Phát cảnh báo chốt lệnh qua Telegram ngay tức thì
          await sendScalpCloseAlert(checkRes);
        } else {
          // Chưa đóng lệnh: In log trạng thái định kỳ mỗi 15 giây
          const now = Date.now();
          if (now - this.lastHoldLogTime > 15000) {
            this.lastHoldLogTime = now;
            const pos = checkRes.position;
            const floating = checkRes.floatingPoints;
            const floatSign = floating >= 0 ? `+${floating.toFixed(2)}` : `${floating.toFixed(2)}`;
            const isBuy = pos.action === 'BUY';
            const remainingToTp = isBuy ? (pos.takeProfit - livePrice) : (livePrice - pos.takeProfit);

            console.log(`⏳ [Theo dõi vị thế]: ${pos.action} @ $${pos.entryPrice.toFixed(2)} | Giá hiện tại: $${livePrice.toFixed(2)} (PnL tạm: ${floatSign} giá) | Còn ${Math.max(0, remainingToTp).toFixed(2)} giá nữa chạm TP.`);
          }
        }
      } catch (err) {
        console.error(`⚠️ [Scalp 1M Monitor] Lỗi kiểm tra giá realtime:`, err.message);
      } finally {
        this.isMonitoring = false;
      }
    }, intervalMs);
  }

  /**
   * Đồng bộ giá trực tiếp từ EA MetaTrader 5 (GoldScalpBridge)
   */
  setMt5Price(bid, ask, symbol) {
    if (!bid || !ask || isNaN(bid) || isNaN(ask)) return;
    const isFirstSync = !this.mt5LivePrice;
    this.mt5LivePrice = {
      bid: parseFloat(bid),
      ask: parseFloat(ask),
      mid: parseFloat(((parseFloat(bid) + parseFloat(ask)) / 2).toFixed(2)),
      symbol: symbol || 'XAUUSD',
      timestamp: Date.now(),
    };
    if (isFirstSync) {
      console.log(`\n🟢 [Exness MT5 Bridge] Đã kết nối EA! Đồng bộ giá sàn MT5: Bid $${this.mt5LivePrice.bid} | Ask $${this.mt5LivePrice.ask} (${this.mt5LivePrice.symbol})\n`);
    }
  }

  stop() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  getStats() {
    return this.tracker.getStats();
  }
}

module.exports = ScalpEngine;

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '../../logs');
const STATE_FILE = path.join(LOGS_DIR, 'scalp_state.json');
const TRADES_FILE = path.join(LOGS_DIR, 'scalp_trades.json');

/**
 * Quản lý vị thế giao dịch (Position Tracker) & Nhật ký lệnh Scalping 1 Phút
 * Hỗ trợ lưu trữ trạng thái bền vững (State Persistence) khi khởi động lại bot
 */
class PositionTracker {
  constructor() {
    this.currentPosition = null;
    this.history = [];
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPointsEarned: 0,
    };

    this.ensureDirs();
    this.loadState();
    this.loadHistory();
  }

  ensureDirs() {
    if (!fs.existsSync(LOGS_DIR)) {
      try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
      } catch (e) {}
    }
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.status === 'OPEN') {
          this.currentPosition = data;
          console.log(`📌 [PositionTracker] Đã khôi phục vị thế đang mở từ trước: ${data.action} @ $${data.entryPrice} (TP: $${data.takeProfit} | SL: $${data.stopLoss})`);
        }
      }
    } catch (err) {
      console.warn('⚠️ [PositionTracker] Không thể đọc file scalp_state.json:', err.message);
    }
  }

  saveState() {
    try {
      this.ensureDirs();
      if (this.currentPosition) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.currentPosition, null, 2), 'utf8');
      } else {
        if (fs.existsSync(STATE_FILE)) {
          fs.unlinkSync(STATE_FILE);
        }
      }
    } catch (err) {
      console.error('❌ [PositionTracker] Lỗi lưu scalp_state.json:', err.message);
    }
  }

  loadHistory() {
    try {
      if (fs.existsSync(TRADES_FILE)) {
        const raw = fs.readFileSync(TRADES_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data) {
          this.history = data.history || [];
          this.stats = data.stats || this.stats;
        }
      }
    } catch (err) {
      console.warn('⚠️ [PositionTracker] Không thể đọc file scalp_trades.json:', err.message);
    }
  }

  saveHistory() {
    try {
      this.ensureDirs();
      const payload = {
        stats: this.stats,
        history: this.history.slice(-100), // Lưu 100 lệnh gần nhất
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(TRADES_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ [PositionTracker] Lỗi lưu scalp_trades.json:', err.message);
    }
  }

  hasOpenPosition() {
    return this.currentPosition !== null;
  }

  getPosition() {
    return this.currentPosition;
  }

  /**
   * Mở vị thế giao dịch mới
   */
  openPosition(signal) {
    if (this.currentPosition) {
      return { success: false, reason: 'ALREADY_HAVE_OPEN_POSITION', position: this.currentPosition };
    }

    const id = `SCALP_${Date.now()}`;
    this.currentPosition = {
      id,
      action: signal.action,
      strategy: signal.strategy,
      setupType: signal.setupType || 'Scalp Setup',
      entryPrice: signal.entry,
      takeProfit: signal.takeProfit,
      stopLoss: signal.stopLoss,
      takeProfitPoints: signal.takeProfitPoints || 1.0,
      stopLossPoints: signal.stopLossPoints || 1.5,
      score: signal.score,
      rank: signal.rank,
      rankBadge: signal.rankBadge,
      entryTime: new Date().toISOString(),
      status: 'OPEN',
      isBreakevenLocked: false,
      indicators: signal.indicators,
    };

    this.saveState();
    return { success: true, position: this.currentPosition };
  }

  /**
   * Kiểm tra giá hiện tại với TP/SL
   * @param {number} currentPrice - Giá realtime tick mới nhất
   */
  checkPrice(currentPrice) {
    if (!this.currentPosition || !currentPrice) return null;

    const pos = this.currentPosition;
    const isBuy = pos.action === 'BUY';

    const floatingPoints = isBuy
      ? (currentPrice - pos.entryPrice)
      : (pos.entryPrice - currentPrice);

    // 🛡 Cơ chế Bảo hiểm Hòa Vốn (Break-even Lock):
    // Khi giá đã chạy được >= +0.60 giá (60% chặng đường đến TP 1.0 giá),
    // tự động dời Stop Loss về mức hòa vốn (+0.05 giá để bảo hiểm trượt giá/spread).
    // Đảm bảo lệnh đang thắng sẽ không bao giờ bị biến thành lệnh lỗ!
    if (!pos.isBreakevenLocked && floatingPoints >= 0.60) {
      pos.isBreakevenLocked = true;
      const bePrice = isBuy
        ? parseFloat((pos.entryPrice + 0.05).toFixed(2))
        : parseFloat((pos.entryPrice - 0.05).toFixed(2));
      pos.stopLoss = bePrice;
      this.saveState();
      console.log(`\n🛡 [BẢO HIỂM HÒA VỐN]: Lãi tạm đạt +${floatingPoints.toFixed(2)} giá -> Đã dời Stop Loss về $${pos.stopLoss} (Hòa vốn + phí)! Lệnh này an toàn 100%.\n`);
    }

    let isTpHit = false;
    let isSlHit = false;

    // Kiểm tra Take Profit (Cứ được 1 giá là đóng lệnh)
    if (isBuy && currentPrice >= pos.takeProfit) {
      isTpHit = true;
    } else if (!isBuy && currentPrice <= pos.takeProfit) {
      isTpHit = true;
    }

    // Kiểm tra Stop Loss
    if (isBuy && currentPrice <= pos.stopLoss) {
      isSlHit = true;
    } else if (!isBuy && currentPrice >= pos.stopLoss) {
      isSlHit = true;
    }

    // Nếu chạm 1 trong 2 mục tiêu: ĐÓNG LỆNH NGAY LẬP TỨC
    if (isTpHit || isSlHit) {
      const exitPrice = currentPrice;
      const pnlPoints = parseFloat(floatingPoints.toFixed(2));
      const entryDate = new Date(pos.entryTime);
      const durationMs = Date.now() - entryDate.getTime();
      const isWin = isTpHit || pnlPoints >= 0;

      const closedTrade = {
        ...pos,
        exitPrice,
        exitTime: new Date().toISOString(),
        durationMs,
        durationFormatted: this.formatDuration(durationMs),
        pnlPoints,
        result: isWin ? 'WIN' : 'LOSS',
        closeReason: isTpHit ? 'TAKE_PROFIT_HIT' : (pos.isBreakevenLocked ? 'BREAKEVEN_EXIT' : 'STOP_LOSS_HIT'),
      };

      // Cập nhật thống kê
      this.stats.totalTrades += 1;
      if (isWin) {
        this.stats.wins += 1;
      } else {
        this.stats.losses += 1;
      }
      this.stats.totalPointsEarned = parseFloat((this.stats.totalPointsEarned + pnlPoints).toFixed(2));
      this.stats.winRate = parseFloat(((this.stats.wins / this.stats.totalTrades) * 100).toFixed(1));

      this.history.push(closedTrade);
      this.currentPosition = null;

      this.saveState();
      this.saveHistory();

      return {
        closed: true,
        type: isTpHit ? 'TP' : 'SL',
        trade: closedTrade,
        stats: this.getStats(),
      };
    }

    // Chưa đóng lệnh: Trả về trạng thái đang giữ lệnh
    return {
      closed: false,
      position: pos,
      currentPrice,
      floatingPoints: parseFloat(floatingPoints.toFixed(2)),
    };
  }

  /**
   * Đóng lệnh thủ công
   */
  forceClose(currentPrice, reason = 'MANUAL') {
    if (!this.currentPosition) return null;

    const pos = this.currentPosition;
    const isBuy = pos.action === 'BUY';
    const floatingPoints = isBuy
      ? (currentPrice - pos.entryPrice)
      : (pos.entryPrice - currentPrice);

    const exitPrice = currentPrice;
    const pnlPoints = parseFloat(floatingPoints.toFixed(2));
    const durationMs = Date.now() - new Date(pos.entryTime).getTime();
    const isWin = pnlPoints > 0;

    const closedTrade = {
      ...pos,
      exitPrice,
      exitTime: new Date().toISOString(),
      durationMs,
      durationFormatted: this.formatDuration(durationMs),
      pnlPoints,
      result: isWin ? 'WIN' : 'LOSS',
      closeReason: reason,
    };

    this.stats.totalTrades += 1;
    if (isWin) this.stats.wins += 1;
    else this.stats.losses += 1;
    this.stats.totalPointsEarned = parseFloat((this.stats.totalPointsEarned + pnlPoints).toFixed(2));
    this.stats.winRate = parseFloat(((this.stats.wins / this.stats.totalTrades) * 100).toFixed(1));

    this.history.push(closedTrade);
    this.currentPosition = null;

    this.saveState();
    this.saveHistory();

    return {
      closed: true,
      type: 'MANUAL',
      trade: closedTrade,
      stats: this.getStats(),
    };
  }

  formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins === 0) return `${secs} giây`;
    return `${mins} phút ${secs} giây`;
  }

  getStats() {
    return {
      ...this.stats,
      currentOpen: this.currentPosition,
      recentTrades: this.history.slice(-10),
    };
  }
}

module.exports = PositionTracker;

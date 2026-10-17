const CONFIG = require('./config');

/**
 * Ngưỡng điểm tối thiểu theo loại tín hiệu (Order Flow có thang điểm riêng)
 */
function getMinScore(signal) {
  return signal.strategy.includes('Order Flow')
    ? CONFIG.minConfluenceScore
    : CONFIG.minStrategyScore;
}

/**
 * Chặn phát lại tín hiệu cùng chiều trên cùng tài sản trong N nến kể từ lần phát trước
 * (một setup thường thỏa điều kiện liên tiếp nhiều nến)
 */
class SignalCooldown {
  constructor(bars, timeframeMs) {
    this.windowMs = bars * timeframeMs;
    this.lastSent = new Map();
  }

  isCoolingDown(symbol, action, candleTime) {
    const last = this.lastSent.get(`${symbol}|${action}`);
    return last != null && candleTime - last < this.windowMs;
  }

  record(symbol, action, candleTime) {
    this.lastSent.set(`${symbol}|${action}`, candleTime);
  }
}

module.exports = {
  getMinScore,
  SignalCooldown,
};

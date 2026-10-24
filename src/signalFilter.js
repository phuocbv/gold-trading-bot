const CONFIG = require('./config');

/**
 * Ngưỡng điểm tối thiểu theo loại tín hiệu: chiến lược tự khai báo ngưỡng riêng (minScore) thì dùng ngưỡng đó,
 * Order Flow có thang điểm riêng
 */
function getMinScore(signal) {
  if (signal.minScore != null) return signal.minScore;
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
    const key = `${symbol}|${action}`;
    const last = this.lastSent.get(key);
    this.lastSent.set(key, last != null ? Math.max(last, candleTime) : candleTime);
  }
}

module.exports = {
  getMinScore,
  SignalCooldown,
};

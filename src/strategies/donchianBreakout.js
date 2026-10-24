const BaseStrategy = require('./baseStrategy');

/**
 * Phá vỡ kênh Donchian 55 nến (hệ thống Turtle 2) thuận xu hướng EMA200.
 * Backtest Vàng (npm run backtest:report, trừ spread $0.35, 10/2026):
 * - Khung 4h (08/2023 - 10/2026): 215 lệnh, thắng 45%, +0.33R/lệnh, PF 1.60, p = 0.04
 * - Khung 1h (03/2025 - 10/2026): 382 lệnh, thắng 41%, +0.21R/lệnh, PF 1.35, p = 0.03 (sát ngưỡng),
 *   nhưng lỗ từ 06/2026 (-0.12R/lệnh) nên mặc định chưa bật
 * - Khung 15m và 30m: không có lợi thế (≤ +0.05R/lệnh), nên không chạy ở các khung này.
 */
class DonchianBreakoutStrategy extends BaseStrategy {
  constructor(lookback = 55) {
    super(
      `Donchian Breakout (Turtle ${lookback} + EMA200)`,
      `Đóng cửa vượt đỉnh/đáy ${lookback} nến trước đó, thuận xu hướng dài hạn EMA200`,
      50,
      'BREAKOUT'
    );
    this.lookback = lookback;
    // Quy tắc vào lệnh đã được kiểm chứng bằng backtest, không lọc thêm bằng thang điểm chung
    this.minScore = 0;
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < Math.max(210, this.lookback + 2)) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, atr, ema200, highs, lows } = ind;
    if (!atr || !ema200) return null;

    // Kênh Donchian của các nến trước nến hiện tại
    const highestHigh = Math.max(...highs.slice(-this.lookback - 1, -1));
    const lowestLow = Math.min(...lows.slice(-this.lookback - 1, -1));

    let action = null;
    if (currentPrice > highestHigh && currentPrice > ema200) action = 'BUY';
    else if (currentPrice < lowestLow && currentPrice < ema200) action = 'SELL';
    if (!action) return null;

    const direction = action === 'BUY' ? 1 : -1;
    const risk = 1.5 * atr;

    return this.buildSignal({
      action,
      entry: currentPrice,
      stopLoss: currentPrice - direction * risk,
      takeProfit: currentPrice + direction * 2 * risk,
      takeProfit2: currentPrice + direction * 3 * risk,
      indicators: {
        currentPrice,
        atr,
        ema200,
        donchianHigh: highestHigh,
        donchianLow: lowestLow,
      },
    }, ind);
  }
}

module.exports = DonchianBreakoutStrategy;

const BaseStrategy = require('./baseStrategy');

class BreakoutAtrStrategy extends BaseStrategy {
  constructor() {
    super('Volatility Breakout (Donchian Range + ATR Expansion)', 'Chiến lược đánh bứt phá đỉnh/đáy kèm thanh khoản và nến bùng nổ');
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 50) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, atr, closes, highs, lows, volumes, ema200 } = ind;

    const lookback = 20;
    if (highs.length < lookback + 1) return null;

    // Tìm đỉnh cao nhất và đáy thấp nhất trong lookback nến trước đó (không tính nến hiện tại)
    const recentHighs = highs.slice(-lookback - 1, -1);
    const recentLows = lows.slice(-lookback - 1, -1);
    const highestHigh = Math.max(...recentHighs);
    const lowestLow = Math.min(...recentLows);

    const currentHigh = highs[highs.length - 1];
    const currentLow = lows[lows.length - 1];
    const currentRange = currentHigh - currentLow;

    // Lọc nến bùng nổ: Biên độ nến hiện tại phải lớn hơn 1.2 lần ATR
    const isVolatileCandle = currentRange >= 1.2 * atr;

    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    // BREAKOUT BUY: Giá vượt dứt khoát đỉnh 20 nến + Nến bùng nổ + Nằm trên EMA200 (thuận xu hướng lớn)
    if (currentPrice > highestHigh && isVolatileCandle && currentPrice > ema200) {
      action = 'BUY';
      stopLoss = currentLow - 0.5 * atr;
      takeProfit = currentPrice + 2.0 * atr;
      takeProfit2 = currentPrice + 3.5 * atr;
    }
    // BREAKOUT SELL: Giá thủng dứt khoát đáy 20 nến + Nến bùng nổ + Nằm dưới EMA200
    else if (currentPrice < lowestLow && isVolatileCandle && currentPrice < ema200) {
      action = 'SELL';
      stopLoss = currentHigh + 0.5 * atr;
      takeProfit = currentPrice - 2.0 * atr;
      takeProfit2 = currentPrice - 3.5 * atr;
    }

    if (!action) return null;

    return {
      strategy: this.name,
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      rrRatio: '1 : 2.0 / 1 : 3.5',
      indicators: {
        currentPrice,
        atr,
        highestHigh,
        lowestLow,
        candleRange: currentRange,
        ema200,
      },
    };
  }
}

module.exports = BreakoutAtrStrategy;

const BaseStrategy = require('./baseStrategy');

class MeanReversionStrategy extends BaseStrategy {
  constructor() {
    super('Mean Reversion (Bollinger Bands + RSI Extremes)', 'Chiến lược bắt đỉnh/đáy đảo chiều ngắn hạn khi giá quá mua/quá bán');
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 50) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, bb, rsi, atr, ema20, ema200, closes } = ind;
    if (!bb || !bb.lower || !bb.upper) return null;

    const candles = marketData.candles;
    if (!candles || candles.length < 2) return null;

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    // BUY SETUP: Giá chạm/xuyên dải dưới Bollinger Band + RSI quá bán (<35) + Nến rút chân / xanh đảo chiều
    const touchedLower = lastCandle.low <= bb.lower || prevCandle.low <= bb.lower;
    const isBullishCandle = lastCandle.close > lastCandle.open;
    const isOversold = rsi < 35;

    if (touchedLower && isOversold && isBullishCandle) {
      action = 'BUY';
      stopLoss = Math.min(lastCandle.low, prevCandle.low) - 0.5 * atr;
      takeProfit = bb.middle; // TP1: Chạm trục giữa BB
      takeProfit2 = bb.upper; // TP2: Dải trên BB
    }

    // SELL SETUP: Giá chạm/xuyên dải trên Bollinger Band + RSI quá mua (>65) + Nến rút râu / đỏ đảo chiều
    const touchedUpper = lastCandle.high >= bb.upper || prevCandle.high >= bb.upper;
    const isBearishCandle = lastCandle.close < lastCandle.open;
    const isOverbought = rsi > 65;

    if (touchedUpper && isOverbought && isBearishCandle) {
      action = 'SELL';
      stopLoss = Math.max(lastCandle.high, prevCandle.high) + 0.5 * atr;
      takeProfit = bb.middle; // TP1: Chạm trục giữa BB
      takeProfit2 = bb.lower; // TP2: Dải dưới BB
    }

    if (!action) return null;

    // Kiểm tra tỉ lệ R:R tối thiểu 1:1.5
    const risk = Math.abs(currentPrice - stopLoss);
    const reward = Math.abs(takeProfit - currentPrice);
    if (risk === 0 || reward / risk < 1.2) {
      return null; // Bỏ qua nếu tỉ lệ R:R quá thấp
    }

    return {
      strategy: this.name,
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      rrRatio: `1 : ${(reward / risk).toFixed(1)}`,
      indicators: {
        currentPrice,
        rsi,
        atr,
        ema20,
        ema200,
        bbLower: bb.lower,
        bbUpper: bb.upper,
        bbMiddle: bb.middle,
      },
    };
  }
}

module.exports = MeanReversionStrategy;

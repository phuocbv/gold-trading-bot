const BaseStrategy = require('./baseStrategy');

class TrendFollowingStrategy extends BaseStrategy {
  constructor() {
    super('Trend Following (EMA Ribbon + MACD + RSI)', 'Chiến lược bám theo xu hướng chủ đạo kết hợp nhịp điều chỉnh');
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 200) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, ema20, ema50, ema200, rsi, prevRsi, atr, macd, prevMacd } = ind;

    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    const isStrongUptrend = ema20 > ema50 && ema50 > ema200 && currentPrice > ema20;
    const isStrongDowntrend = ema20 < ema50 && ema50 < ema200 && currentPrice < ema20;

    const macdHist = macd ? (macd.MACD - macd.signal) : 0;
    const prevMacdHist = prevMacd ? (prevMacd.MACD - prevMacd.signal) : 0;

    // BUY SIGNAL: Xu hướng tăng + RSI bật tăng từ nhịp hồi hoặc MACD histogram cắt lên
    if (isStrongUptrend) {
      const rsiBounce = prevRsi < 48 && rsi >= 48;
      const macdBounce = prevMacdHist <= 0 && macdHist > 0;

      if (rsiBounce || macdBounce) {
        action = 'BUY';
        stopLoss = currentPrice - 1.5 * atr;
        takeProfit = currentPrice + 3.0 * atr;
        takeProfit2 = currentPrice + 4.5 * atr;
      }
    }
    // SELL SIGNAL: Xu hướng giảm + RSI quay đầu giảm từ nhịp hồi hoặc MACD histogram cắt xuống
    else if (isStrongDowntrend) {
      const rsiDrop = prevRsi > 52 && rsi <= 52;
      const macdDrop = prevMacdHist >= 0 && macdHist < 0;

      if (rsiDrop || macdDrop) {
        action = 'SELL';
        stopLoss = currentPrice + 1.5 * atr;
        takeProfit = currentPrice - 3.0 * atr;
        takeProfit2 = currentPrice - 4.5 * atr;
      }
    }

    if (!action) return null;

    return {
      strategy: this.name,
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      rrRatio: '1 : 2.0 (TP1) / 1 : 3.0 (TP2)',
      indicators: {
        currentPrice,
        ema20,
        ema50,
        ema200,
        rsi,
        atr,
      },
    };
  }
}

module.exports = TrendFollowingStrategy;

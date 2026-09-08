const BaseStrategy = require('./baseStrategy');

class TrendFollowingStrategy extends BaseStrategy {
  constructor() {
    super(
      'Trend Following (EMA Ribbon + ADX + MACD + StochRSI)',
      'Chiến lược bám theo xu hướng chủ đạo được xác nhận bởi ADX và nhịp hồi',
      85,
      'TREND'
    );
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 200) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, ema20, ema50, ema200, rsi, prevRsi, atr, macd, prevMacd, adx, pdi, mdi, stochRsi } = ind;

    // Lọc thị trường Sideway / Không có xu hướng: Bắt buộc ADX >= 20 để tránh bẫy whipsaw
    if (adx < 20) {
      return null;
    }

    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    const isStrongUptrend = ema20 > ema50 && ema50 > ema200 && currentPrice > ema20 && pdi > mdi;
    const isStrongDowntrend = ema20 < ema50 && ema50 < ema200 && currentPrice < ema20 && mdi > pdi;

    const macdHist = macd ? (macd.MACD - macd.signal) : 0;
    const prevMacdHist = prevMacd ? (prevMacd.MACD - prevMacd.signal) : 0;

    // BUY SIGNAL: Xu hướng tăng + ADX mạnh + RSI bật tăng từ nhịp hồi hoặc MACD histogram đảo chiều dương
    if (isStrongUptrend) {
      const rsiBounce = prevRsi < 48 && rsi >= 48;
      const macdBounce = prevMacdHist <= 0 && macdHist > 0;
      const stochBullish = stochRsi ? (stochRsi.k < 80 && stochRsi.k >= stochRsi.d) : true;

      if ((rsiBounce || macdBounce) && stochBullish) {
        action = 'BUY';
        stopLoss = Math.min(ema50, currentPrice - 1.5 * atr);
        takeProfit = currentPrice + 3.0 * atr;
        takeProfit2 = currentPrice + 4.5 * atr;
      }
    }
    // SELL SIGNAL: Xu hướng giảm + ADX mạnh + RSI quay đầu giảm hoặc MACD histogram đảo chiều âm
    else if (isStrongDowntrend) {
      const rsiDrop = prevRsi > 52 && rsi <= 52;
      const macdDrop = prevMacdHist >= 0 && macdHist < 0;
      const stochBearish = stochRsi ? (stochRsi.k > 20 && stochRsi.k <= stochRsi.d) : true;

      if ((rsiDrop || macdDrop) && stochBearish) {
        action = 'SELL';
        stopLoss = Math.max(ema50, currentPrice + 1.5 * atr);
        takeProfit = currentPrice - 3.0 * atr;
        takeProfit2 = currentPrice - 4.5 * atr;
      }
    }

    if (!action) return null;

    const risk = Math.abs(currentPrice - stopLoss);
    const reward1 = Math.abs(takeProfit - currentPrice);
    const reward2 = Math.abs(takeProfit2 - currentPrice);

    const signal = {
      strategy: this.name,
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      rrRatio: `1 : ${(reward1 / risk).toFixed(1)} (TP1) / 1 : ${(reward2 / risk).toFixed(1)} (TP2)`,
      indicators: {
        currentPrice,
        ema20,
        ema50,
        ema200,
        rsi,
        atr,
        adx,
        stochRsiK: stochRsi ? stochRsi.k : null,
      },
    };

    const scoreData = this.evaluateScore(signal, ind);
    return {
      ...signal,
      ...scoreData,
    };
  }
}

module.exports = TrendFollowingStrategy;


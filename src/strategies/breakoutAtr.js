const BaseStrategy = require('./baseStrategy');

class BreakoutAtrStrategy extends BaseStrategy {
  constructor() {
    super(
      'Volatility Breakout (Donchian Range + Volume + ATR Expansion)',
      'Chiến lược đánh bứt phá đỉnh/đáy kèm thanh khoản bùng nổ và xung lực ADX',
      75,
      'BREAKOUT'
    );
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 50) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, atr, highs, lows, ema200, adx, currentVolume, avgVolume20, vwap } = ind;

    // Lọc bứt phá giả (Fakeout): Bắt buộc ADX >= 22 (thị trường có xung lực mở biên độ)
    if (adx < 22) {
      return null;
    }

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
    if (!isVolatileCandle) return null;

    // Lọc khối lượng: Nếu có volume, nến phá vỡ phải có volume >= 1.2x khối lượng trung bình 20 nến
    const isVolumeSurge = avgVolume20 > 0 ? (currentVolume >= 1.2 * avgVolume20) : true;
    if (!isVolumeSurge) return null;

    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    // BREAKOUT BUY: Giá vượt đỉnh 20 nến + Nến bùng nổ + Nằm trên EMA200 + (Nếu có VWAP thì trên VWAP)
    const vwapBuyOk = vwap ? currentPrice >= vwap : true;
    if (currentPrice > highestHigh && currentPrice > ema200 && vwapBuyOk) {
      action = 'BUY';
      stopLoss = currentLow - 0.5 * atr;
      takeProfit = currentPrice + 2.2 * atr;
      takeProfit2 = currentPrice + 4.0 * atr;
    }
    // BREAKOUT SELL: Giá thủng đáy 20 nến + Nến bùng nổ + Nằm dưới EMA200 + (Nếu có VWAP thì dưới VWAP)
    const vwapSellOk = vwap ? currentPrice <= vwap : true;
    if (currentPrice < lowestLow && currentPrice < ema200 && vwapSellOk) {
      action = 'SELL';
      stopLoss = currentHigh + 0.5 * atr;
      takeProfit = currentPrice - 2.2 * atr;
      takeProfit2 = currentPrice - 4.0 * atr;
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
      rrRatio: `1 : ${(reward1 / risk).toFixed(1)} / 1 : ${(reward2 / risk).toFixed(1)}`,
      indicators: {
        currentPrice,
        atr,
        adx,
        highestHigh,
        lowestLow,
        candleRange: currentRange,
        volumeRatio: avgVolume20 > 0 ? `${(currentVolume / avgVolume20).toFixed(1)}x` : 'N/A',
        ema200,
        vwap,
      },
    };

    const scoreData = this.evaluateScore(signal, ind);
    return {
      ...signal,
      ...scoreData,
    };
  }
}

module.exports = BreakoutAtrStrategy;


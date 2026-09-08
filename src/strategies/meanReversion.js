const BaseStrategy = require('./baseStrategy');

class MeanReversionStrategy extends BaseStrategy {
  constructor() {
    super(
      'Mean Reversion (Bollinger Bands + StochRSI + Price Action)',
      'Chiến lược bắt đảo chiều tại biên Bollinger Bands kèm tín hiệu nến và StochRSI',
      70,
      'REVERSION'
    );
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 50) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, bb, rsi, atr, ema20, ema200, adx, stochRsi } = ind;
    if (!bb || !bb.lower || !bb.upper) return null;

    // Nếu ADX > 35: Xu hướng bùng nổ cực mạnh (Runaway Trend) -> Không được bắt đỉnh đáy ngược dòng!
    if (adx > 35) {
      return null;
    }

    const candles = marketData.candles;
    if (!candles || candles.length < 2) return null;

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    const pattern = this.detectCandlePattern(prevCandle, lastCandle);

    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    // BUY SETUP: Giá chạm/xuyên dải dưới Bollinger Band + RSI quá bán (<38) + StochRSI quá bán cắt lên + Nến đảo chiều (Pinbar/Engulfing/Nến xanh)
    const touchedLower = lastCandle.low <= bb.lower || prevCandle.low <= bb.lower;
    const isOversold = rsi < 38;
    const stochBuyConfirm = stochRsi ? (stochRsi.k < 35 && stochRsi.k >= stochRsi.d) : true;
    const candleBuyConfirm = pattern.isBullishReversal || lastCandle.close > lastCandle.open;

    if (touchedLower && isOversold && stochBuyConfirm && candleBuyConfirm) {
      action = 'BUY';
      stopLoss = Math.min(lastCandle.low, prevCandle.low) - 0.5 * atr;
      takeProfit = bb.middle; // TP1: Chạm trục giữa BB
      takeProfit2 = bb.upper; // TP2: Dải trên BB
    }

    // SELL SETUP: Giá chạm/xuyên dải trên Bollinger Band + RSI quá mua (>62) + StochRSI quá mua cắt xuống + Nến đảo chiều (Pinbar/Engulfing/Nến đỏ)
    const touchedUpper = lastCandle.high >= bb.upper || prevCandle.high >= bb.upper;
    const isOverbought = rsi > 62;
    const stochSellConfirm = stochRsi ? (stochRsi.k > 65 && stochRsi.k <= stochRsi.d) : true;
    const candleSellConfirm = pattern.isBearishReversal || lastCandle.close < lastCandle.open;

    if (touchedUpper && isOverbought && stochSellConfirm && candleSellConfirm) {
      action = 'SELL';
      stopLoss = Math.max(lastCandle.high, prevCandle.high) + 0.5 * atr;
      takeProfit = bb.middle; // TP1: Chạm trục giữa BB
      takeProfit2 = bb.lower; // TP2: Dải dưới BB
    }

    if (!action) return null;

    // Kiểm tra tỉ lệ R:R tối thiểu 1:1.3
    const risk = Math.abs(currentPrice - stopLoss);
    const reward = Math.abs(takeProfit - currentPrice);
    if (risk === 0 || reward / risk < 1.3) {
      return null; // Bỏ qua nếu tỉ lệ R:R quá thấp
    }

    const signal = {
      strategy: this.name,
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      rrRatio: `1 : ${(reward / risk).toFixed(1)} (TP1) / 1 : ${(Math.abs(takeProfit2 - currentPrice) / risk).toFixed(1)} (TP2)`,
      indicators: {
        currentPrice,
        rsi,
        atr,
        adx,
        stochRsiK: stochRsi ? stochRsi.k : null,
        bbLower: bb.lower,
        bbUpper: bb.upper,
        bbMiddle: bb.middle,
        pattern: pattern.isHammer ? 'Hammer/Pinbar' : (pattern.isBullishEngulfing ? 'Bullish Engulfing' : (pattern.isShootingStar ? 'Shooting Star' : (pattern.isBearishEngulfing ? 'Bearish Engulfing' : 'Reversal Candle'))),
      },
    };

    const scoreData = this.evaluateScore(signal, ind);
    return {
      ...signal,
      ...scoreData,
    };
  }
}

module.exports = MeanReversionStrategy;


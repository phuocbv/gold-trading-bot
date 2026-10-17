const BaseStrategy = require('./baseStrategy');

class RsiDivergenceStrategy extends BaseStrategy {
  constructor() {
    super(
      'RSI Divergence (Regular Divergence + Price Action Reversal)',
      'Chiến lược phát hiện phân kỳ đỉnh/đáy giữa giá và RSI kết hợp nến đảo chiều cho tỷ lệ R:R cao',
      50,
      'DIVERGENCE'
    );
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 50) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, rsiSeries, atr, closes, highs, lows, ema200, adx } = ind;
    if (!rsiSeries || rsiSeries.length < 40) return null;

    // Phát hiện phân kỳ thường giữa 2 đáy/đỉnh swing gần nhất
    const divergence = this.detectRsiDivergence(closes, highs, lows, rsiSeries);
    if (!divergence) return null;

    const candles = marketData.candles;
    if (!candles || candles.length < 2) return null;

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    const pattern = this.detectCandlePattern(prevCandle, lastCandle);

    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    // BULLISH DIVERGENCE: Phân kỳ dương + Nến xanh hoặc nến đảo chiều (Pinbar/Hammer/Engulfing)
    if (divergence.type === 'BULLISH') {
      const isReversalConfirmed = pattern.isBullishReversal || lastCandle.close > lastCandle.open;
      if (isReversalConfirmed) {
        action = 'BUY';
        stopLoss = divergence.price2 - 0.6 * atr;
        takeProfit = currentPrice + 2.5 * atr;
        takeProfit2 = currentPrice + 4.5 * atr;
      }
    }
    // BEARISH DIVERGENCE: Phân kỳ âm + Nến đỏ hoặc nến đảo chiều (Shooting Star/Engulfing)
    else if (divergence.type === 'BEARISH') {
      const isReversalConfirmed = pattern.isBearishReversal || lastCandle.close < lastCandle.open;
      if (isReversalConfirmed) {
        action = 'SELL';
        stopLoss = divergence.price2 + 0.6 * atr;
        takeProfit = currentPrice - 2.5 * atr;
        takeProfit2 = currentPrice - 4.5 * atr;
      }
    }

    if (!action) return null;

    // buildSignal tự loại lệnh có R:R dưới CONFIG.riskRewardMin
    return this.buildSignal({
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      indicators: {
        currentPrice,
        atr,
        adx,
        divergenceType: divergence.name,
        divergenceDetail: divergence.desc,
        candlePattern: this.describeCandlePattern(pattern, action),
        ema200,
      },
    }, ind);
  }
}

module.exports = RsiDivergenceStrategy;

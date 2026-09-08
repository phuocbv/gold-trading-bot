const BaseStrategy = require('./baseStrategy');

class SmcOrderBlockStrategy extends BaseStrategy {
  constructor() {
    super(
      'SMC Lite (Fair Value Gap + Order Block Retest)',
      'Chiến lược Smart Money Concepts phát hiện khoảng trống FVG và khối lệnh OB',
      85,
      'SMC'
    );
  }

  analyze(marketData) {
    const candles = marketData.candles;
    if (!candles || candles.length < 30) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, atr, ema200 } = ind;

    // Tìm kiếm các vùng FVG (Fair Value Gap) trong 10 nến gần đây
    let activeBullishFvg = null;
    let activeBearishFvg = null;

    for (let i = candles.length - 2; i >= candles.length - 12; i--) {
      const c1 = candles[i - 2];
      const c2 = candles[i - 1]; // Nến bùng nổ ở giữa
      const c3 = candles[i];

      // Bullish FVG: Đáy của nến c3 cao hơn đỉnh của nến c1
      if (c3.low > c1.high && c2.close > c2.open) {
        const gapSize = c3.low - c1.high;
        if (gapSize >= 0.3 * atr) { // Khoảng trống đủ ý nghĩa
          activeBullishFvg = {
            top: c3.low,
            bottom: c1.high,
            candleIndex: i - 1,
            mid: (c3.low + c1.high) / 2,
          };
          break;
        }
      }

      // Bearish FVG: Đỉnh của nến c3 thấp hơn đáy của nến c1
      if (c3.high < c1.low && c2.close < c2.open) {
        const gapSize = c1.low - c3.high;
        if (gapSize >= 0.3 * atr) {
          activeBearishFvg = {
            top: c1.low,
            bottom: c3.high,
            candleIndex: i - 1,
            mid: (c1.low + c3.high) / 2,
          };
          break;
        }
      }
    }

    const currentCandle = candles[candles.length - 1];
    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    // BUY SIGNAL: Giá hồi về test vùng Bullish FVG và có phản ứng rút chân
    if (activeBullishFvg && currentPrice >= activeBullishFvg.bottom && currentPrice <= activeBullishFvg.top) {
      if (currentCandle.close > currentCandle.open && currentPrice > ema200) {
        action = 'BUY';
        stopLoss = activeBullishFvg.bottom - 0.5 * atr;
        takeProfit = currentPrice + 2.5 * atr;
        takeProfit2 = currentPrice + 4.0 * atr;
      }
    }
    // SELL SIGNAL: Giá hồi về test vùng Bearish FVG và có phản ứng rút râu
    else if (activeBearishFvg && currentPrice >= activeBearishFvg.bottom && currentPrice <= activeBearishFvg.top) {
      if (currentCandle.close < currentCandle.open && currentPrice < ema200) {
        action = 'SELL';
        stopLoss = activeBearishFvg.top + 0.5 * atr;
        takeProfit = currentPrice - 2.5 * atr;
        takeProfit2 = currentPrice - 4.0 * atr;
      }
    }

    if (!action) return null;

    const signal = {
      strategy: this.name,
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      rrRatio: '1 : 2.5 (TP1) / 1 : 4.0 (TP2)',
      indicators: {
        currentPrice,
        atr,
        ema200,
        fvgZone: action === 'BUY'
          ? `$${activeBullishFvg.bottom.toFixed(2)} - $${activeBullishFvg.top.toFixed(2)}`
          : `$${activeBearishFvg.bottom.toFixed(2)} - $${activeBearishFvg.top.toFixed(2)}`,
      },
    };

    const scoreData = this.evaluateScore(signal, ind);
    return {
      ...signal,
      ...scoreData,
    };
  }
}

module.exports = SmcOrderBlockStrategy;

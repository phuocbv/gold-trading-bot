const BaseStrategy = require('./baseStrategy');

class SmcOrderBlockStrategy extends BaseStrategy {
  constructor() {
    super(
      'SMC Lite (Fair Value Gap + Order Block Retest)',
      'Chiến lược Smart Money Concepts phát hiện khoảng trống FVG và khối lệnh OB',
      50,
      'SMC'
    );
  }

  analyze(marketData) {
    const candles = marketData.candles;
    if (!candles || candles.length < 30) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, atr, ema200, adx } = ind;

    // FVG chỉ đáng tin khi thị trường có xung lực (backtest: ADX < 22 cho kết quả âm rõ rệt)
    if (adx < 22) return null;

    // Tìm kiếm các vùng FVG (Fair Value Gap) trong 10 nến gần đây
    let activeBullishFvg = null;
    let activeBearishFvg = null;

    // Vùng FVG đã bị giá quay lại chạm trước nến hiện tại thì không còn là lần retest đầu tiên
    const touchedBefore = (fromIndex, isBullish, zoneEdge) => candles
      .slice(fromIndex + 1, candles.length - 1)
      .some((c) => (isBullish ? c.low <= zoneEdge : c.high >= zoneEdge));

    for (let i = candles.length - 2; i >= candles.length - 12; i--) {
      const c1 = candles[i - 2];
      const c2 = candles[i - 1]; // Nến bùng nổ ở giữa
      const c3 = candles[i];

      // Bullish FVG: Đáy của nến c3 cao hơn đỉnh của nến c1
      if (c3.low > c1.high && c2.close > c2.open) {
        const gapSize = c3.low - c1.high;
        if (gapSize >= 0.3 * atr && !touchedBefore(i, true, c3.low)) { // Khoảng trống đủ ý nghĩa & chưa bị lấp
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
        if (gapSize >= 0.3 * atr && !touchedBefore(i, false, c3.high)) {
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

    // BUY SIGNAL: Râu nến chạm vào vùng Bullish FVG lần đầu, nến đóng cửa xanh và không thủng đáy vùng
    const tappedBullishFvg = activeBullishFvg &&
      currentCandle.low <= activeBullishFvg.top && currentPrice >= activeBullishFvg.bottom;
    const tappedBearishFvg = activeBearishFvg &&
      currentCandle.high >= activeBearishFvg.bottom && currentPrice <= activeBearishFvg.top;

    if (tappedBullishFvg) {
      if (currentCandle.close > currentCandle.open && currentPrice > ema200) {
        action = 'BUY';
        stopLoss = activeBullishFvg.bottom - 0.5 * atr;
        takeProfit = currentPrice + 2.5 * atr;
        takeProfit2 = currentPrice + 4.0 * atr;
      }
    }
    // SELL SIGNAL: Râu nến chạm vào vùng Bearish FVG lần đầu, nến đóng cửa đỏ và không vượt đỉnh vùng
    else if (tappedBearishFvg) {
      if (currentCandle.close < currentCandle.open && currentPrice < ema200) {
        action = 'SELL';
        stopLoss = activeBearishFvg.top + 0.5 * atr;
        takeProfit = currentPrice - 2.5 * atr;
        takeProfit2 = currentPrice - 4.0 * atr;
      }
    }

    if (!action) return null;

    return this.buildSignal({
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      indicators: {
        currentPrice,
        atr,
        ema200,
        fvgZone: action === 'BUY'
          ? `$${activeBullishFvg.bottom.toFixed(2)} - $${activeBullishFvg.top.toFixed(2)}`
          : `$${activeBearishFvg.bottom.toFixed(2)} - $${activeBearishFvg.top.toFixed(2)}`,
      },
    }, ind);
  }
}

module.exports = SmcOrderBlockStrategy;

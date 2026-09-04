const BaseStrategy = require('./baseStrategy');

class VolumeVwapAdxStrategy extends BaseStrategy {
  constructor() {
    super(
      'Smart Money Flow (VWAP + ADX + MFI Volume Confirmation)',
      'Chiến lược bám theo dòng tiền tổ chức tại vùng giá trị VWAP kết hợp xung lực ADX và chỉ số dòng tiền MFI'
    );
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 50) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, vwap, mfi, adx, pdi, mdi, atr, ema20, ema50, ema200, currentVolume, avgVolume20 } = ind;

    // Yêu cầu có dữ liệu VWAP hợp lệ từ sàn giao dịch
    if (!vwap || isNaN(vwap)) return null;

    // Yêu cầu thị trường có xu hướng rõ rệt: ADX >= 22
    if (adx < 22) return null;

    const candles = marketData.candles;
    if (!candles || candles.length < 3) return null;

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    let action = null;
    let stopLoss = 0;
    let takeProfit = 0;
    let takeProfit2 = 0;

    // BUY SETUP:
    // 1. Giá nằm trên VWAP và trên EMA50
    // 2. ADX >= 22 và +DI > -DI
    // 3. MFI >= 50 (Dòng tiền ròng đang đổ vào mua)
    // 4. Nhịp test: Nến trước hoặc nến này chạm sát vùng VWAP / EMA20 và rút chân xanh
    const isAboveVwap = currentPrice > vwap;
    const isUptrendFlow = pdi > mdi && mfi >= 50 && currentPrice > ema50;
    const testedSupport = Math.min(prevCandle.low, lastCandle.low) <= (Math.max(vwap, ema20) + 0.5 * atr);
    const isBullishReaction = lastCandle.close > lastCandle.open;

    if (isAboveVwap && isUptrendFlow && testedSupport && isBullishReaction) {
      action = 'BUY';
      stopLoss = Math.min(vwap, prevCandle.low) - 0.5 * atr;
      takeProfit = currentPrice + 2.5 * atr;
      takeProfit2 = currentPrice + 4.0 * atr;
    }

    // SELL SETUP:
    // 1. Giá nằm dưới VWAP và dưới EMA50
    // 2. ADX >= 22 và -DI > +DI
    // 3. MFI <= 50 (Dòng tiền ròng đang rút ra bán)
    // 4. Nhịp test: Nến trước hoặc nến này chạm sát vùng VWAP / EMA20 và rút râu đỏ
    const isBelowVwap = currentPrice < vwap;
    const isDowntrendFlow = mdi > pdi && mfi <= 50 && currentPrice < ema50;
    const testedResistance = Math.max(prevCandle.high, lastCandle.high) >= (Math.min(vwap, ema20) - 0.5 * atr);
    const isBearishReaction = lastCandle.close < lastCandle.open;

    if (isBelowVwap && isDowntrendFlow && testedResistance && isBearishReaction) {
      action = 'SELL';
      stopLoss = Math.max(vwap, prevCandle.high) + 0.5 * atr;
      takeProfit = currentPrice - 2.5 * atr;
      takeProfit2 = currentPrice - 4.0 * atr;
    }

    if (!action) return null;

    const risk = Math.abs(currentPrice - stopLoss);
    if (risk === 0 || risk < 0.2 * atr) return null;

    const reward1 = Math.abs(takeProfit - currentPrice);
    const reward2 = Math.abs(takeProfit2 - currentPrice);

    return {
      strategy: this.name,
      action,
      entry: currentPrice,
      stopLoss,
      takeProfit,
      takeProfit2,
      rrRatio: `1 : ${(reward1 / risk).toFixed(1)} / 1 : ${(reward2 / risk).toFixed(1)}`,
      indicators: {
        currentPrice,
        vwap,
        mfi,
        adx,
        atr,
        ema50,
        volumeRatio: avgVolume20 > 0 ? `${(currentVolume / avgVolume20).toFixed(1)}x` : 'N/A',
      },
    };
  }
}

module.exports = VolumeVwapAdxStrategy;

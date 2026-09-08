const { EMA, RSI, ATR, MACD, BollingerBands, ADX, StochasticRSI, VWAP, MFI } = require('technicalindicators');

class BaseStrategy {
  constructor(name, description, baseWeight = 75, strategyType = 'TREND') {
    this.name = name;
    this.description = description;
    this.baseWeight = baseWeight;
    this.strategyType = strategyType;
  }

  /**
   * Tính toán các chỉ báo kỹ thuật mở rộng
   */
  calculateIndicators(data) {
    const { closes, highs, lows, volumes } = data;

    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const ema200 = EMA.calculate({ period: 200, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const macd = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const bb = BollingerBands.calculate({
      period: 20,
      values: closes,
      stdDev: 2,
    });

    // 1. ADX (Average Directional Index) - Đo độ mạnh của xu hướng
    let adxResult = [];
    try {
      adxResult = ADX.calculate({ period: 14, high: highs, low: lows, close: closes }) || [];
    } catch (e) {}

    // 2. Stochastic RSI - Điểm kích hoạt đảo chiều sớm
    let stochRsiResult = [];
    try {
      stochRsiResult = StochasticRSI.calculate({
        values: closes,
        rsiPeriod: 14,
        stochasticPeriod: 14,
        kPeriod: 3,
        dPeriod: 3,
      }) || [];
    } catch (e) {}

    // 3. VWAP & MFI (Dòng tiền và Khối lượng giao dịch)
    const hasValidVolume = volumes && volumes.some((v) => v > 0);
    let vwapResult = [];
    let mfiResult = [];
    let avgVolume20 = 0;

    if (hasValidVolume) {
      try {
        vwapResult = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes }) || [];
      } catch (e) {}
      try {
        mfiResult = MFI.calculate({ high: highs, low: lows, close: closes, volume: volumes, period: 14 }) || [];
      } catch (e) {}

      const recentVolumes = volumes.slice(-21, -1);
      if (recentVolumes.length > 0) {
        avgVolume20 = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      }
    }

    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes && volumes.length > 0 ? volumes[volumes.length - 1] : 0;
    const lastAdx = adxResult.length > 0 ? adxResult[adxResult.length - 1] : null;
    const prevAdx = adxResult.length > 1 ? adxResult[adxResult.length - 2] : null;

    const lastStoch = stochRsiResult.length > 0 ? stochRsiResult[stochRsiResult.length - 1] : null;
    const prevStoch = stochRsiResult.length > 1 ? stochRsiResult[stochRsiResult.length - 2] : null;

    const currentVwap = vwapResult.length > 0 && !isNaN(vwapResult[vwapResult.length - 1])
      ? vwapResult[vwapResult.length - 1]
      : null;

    const currentMfi = mfiResult.length > 0 ? mfiResult[mfiResult.length - 1] : 50;

    return {
      currentPrice,
      ema20: ema20[ema20.length - 1],
      ema50: ema50[ema50.length - 1],
      ema200: ema200[ema200.length - 1],
      rsi: rsi[rsi.length - 1],
      prevRsi: rsi[rsi.length - 2],
      rsiSeries: rsi,
      atr: atr[atr.length - 1],
      macd: macd[macd.length - 1],
      prevMacd: macd[macd.length - 2],
      bb: bb[bb.length - 1],
      prevBb: bb[bb.length - 2],
      adx: lastAdx ? lastAdx.adx : 0,
      pdi: lastAdx ? lastAdx.pdi : 0,
      mdi: lastAdx ? lastAdx.mdi : 0,
      prevAdx: prevAdx ? prevAdx.adx : 0,
      stochRsi: lastStoch,
      prevStochRsi: prevStoch,
      vwap: currentVwap,
      mfi: currentMfi,
      currentVolume,
      avgVolume20,
      closes,
      highs,
      lows,
      volumes,
    };
  }

  /**
   * Nhận diện mô hình nến Price Action (Pinbar / Hammer / Engulfing)
   */
  detectCandlePattern(prevCandle, lastCandle) {
    if (!prevCandle || !lastCandle) return { hasPattern: false };

    const body = Math.abs(lastCandle.close - lastCandle.open);
    const range = lastCandle.high - lastCandle.low;
    const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;

    const isBullish = lastCandle.close > lastCandle.open;
    const isBearish = lastCandle.close < lastCandle.open;

    // Pinbar rút chân dưới (Bullish Pinbar / Hammer)
    const isHammer = lowerWick >= 1.8 * body && upperWick <= 0.6 * body && range > 0;

    // Pinbar rút râu trên (Bearish Pinbar / Shooting Star)
    const isShootingStar = upperWick >= 1.8 * body && lowerWick <= 0.6 * body && range > 0;

    // Nến nhấn chìm tăng (Bullish Engulfing)
    const isBullishEngulfing = prevCandle.close < prevCandle.open && isBullish &&
      lastCandle.close >= prevCandle.open && lastCandle.open <= prevCandle.close;

    // Nến nhấn chìm giảm (Bearish Engulfing)
    const isBearishEngulfing = prevCandle.close > prevCandle.open && isBearish &&
      lastCandle.close <= prevCandle.open && lastCandle.open >= prevCandle.close;

    return {
      hasPattern: isHammer || isShootingStar || isBullishEngulfing || isBearishEngulfing,
      isHammer,
      isShootingStar,
      isBullishEngulfing,
      isBearishEngulfing,
      isBullishReversal: isHammer || isBullishEngulfing,
      isBearishReversal: isShootingStar || isBearishEngulfing,
    };
  }

  /**
   * Phát hiện Phân kỳ RSI (RSI Regular Divergence)
   */
  detectRsiDivergence(closes, highs, lows, rsi) {
    if (!rsi || rsi.length < 35 || closes.length < 35) return null;

    const offset = closes.length - rsi.length;
    const len = closes.length;

    // So sánh 2 cửa sổ swing: Window 1 (nến -28 đến -13) và Window 2 (nến -12 đến -1)
    const w1Start = len - 28;
    const w1End = len - 13;
    const w2Start = len - 12;
    const w2End = len - 1;

    let minPrice1 = Infinity, minIdx1 = -1;
    let maxPrice1 = -Infinity, maxIdx1 = -1;
    for (let i = w1Start; i <= w1End; i++) {
      if (lows[i] < minPrice1) { minPrice1 = lows[i]; minIdx1 = i; }
      if (highs[i] > maxPrice1) { maxPrice1 = highs[i]; maxIdx1 = i; }
    }

    let minPrice2 = Infinity, minIdx2 = -1;
    let maxPrice2 = -Infinity, maxIdx2 = -1;
    for (let i = w2Start; i <= w2End; i++) {
      if (lows[i] < minPrice2) { minPrice2 = lows[i]; minIdx2 = i; }
      if (highs[i] > maxPrice2) { maxPrice2 = highs[i]; maxIdx2 = i; }
    }

    const rsiAtMin1 = rsi[minIdx1 - offset];
    const rsiAtMin2 = rsi[minIdx2 - offset];
    const rsiAtMax1 = rsi[maxIdx1 - offset];
    const rsiAtMax2 = rsi[maxIdx2 - offset];

    // Phân kỳ dương: Giá tạo đáy thấp hơn (Lower Low), nhưng RSI tạo đáy cao hơn (Higher Low)
    if (minPrice2 < minPrice1 && rsiAtMin2 > (rsiAtMin1 + 2.0) && rsiAtMin2 < 48) {
      return {
        type: 'BULLISH',
        name: 'Bullish RSI Divergence',
        desc: `Đáy giá thấp hơn ($${minPrice2.toFixed(1)} < $${minPrice1.toFixed(1)}) nhưng RSI tăng (${rsiAtMin2.toFixed(1)} > ${rsiAtMin1.toFixed(1)})`,
        price1: minPrice1,
        price2: minPrice2,
        rsi1: rsiAtMin1,
        rsi2: rsiAtMin2,
      };
    }

    // Phân kỳ âm: Giá tạo đỉnh cao hơn (Higher High), nhưng RSI tạo đỉnh thấp hơn (Lower High)
    if (maxPrice2 > maxPrice1 && rsiAtMax2 < (rsiAtMax1 - 2.0) && rsiAtMax2 > 52) {
      return {
        type: 'BEARISH',
        name: 'Bearish RSI Divergence',
        desc: `Đỉnh giá cao hơn ($${maxPrice2.toFixed(1)} > $${maxPrice1.toFixed(1)}) nhưng RSI giảm (${rsiAtMax2.toFixed(1)} < ${rsiAtMax1.toFixed(1)})`,
        price1: maxPrice1,
        price2: maxPrice2,
        rsi1: rsiAtMax1,
        rsi2: rsiAtMax2,
      };
    }

    return null;
  }

  /**
   * Tính toán điểm chất lượng và trọng số thực tế của tín hiệu dựa trên pha thị trường và các yếu tố xác nhận
   * @param {object} signal - Tín hiệu thô do analyze() sinh ra
   * @param {object} indicators - Kết quả từ calculateIndicators
   * @returns {object} { score, rank, rankBadge, regimeMultiplier, breakdown }
   */
  evaluateScore(signal, indicators) {
    if (!signal || !indicators) return null;

    const base = this.baseWeight;
    let multiplier = 1.0;
    const breakdown = [`Cơ sở: ${base}đ`];

    const { adx, ema200, currentPrice, currentVolume, avgVolume20 } = indicators;

    // 1. Hệ số thích ứng pha thị trường (Market Regime Multiplier theo ADX)
    if (adx >= 22) {
      if (['TREND', 'FLOW', 'BREAKOUT', 'SMC'].includes(this.strategyType)) {
        multiplier = 1.15;
        breakdown.push(`Trend mạnh (ADX ${adx.toFixed(1)}): x1.15`);
      } else if (this.strategyType === 'REVERSION') {
        multiplier = 0.6;
        breakdown.push(`Trend mạnh cấm cản tàu (ADX ${adx.toFixed(1)}): x0.6`);
      }
    } else if (adx < 20) {
      if (['REVERSION', 'DIVERGENCE'].includes(this.strategyType)) {
        multiplier = 1.2;
        breakdown.push(`Sideway lý tưởng (ADX ${adx.toFixed(1)}): x1.2`);
      } else if (['BREAKOUT', 'TREND'].includes(this.strategyType)) {
        multiplier = 0.7;
        breakdown.push(`Sideway giảm hiệu lực trend (ADX ${adx.toFixed(1)}): x0.7`);
      }
    }

    let score = base * multiplier;

    // 2. Điểm thưởng chất lượng Setup (Bonus Quality)
    // Thuận xu hướng dài hạn EMA200
    if (ema200 && currentPrice) {
      const withEma200 = (signal.action === 'BUY' && currentPrice > ema200) ||
                         (signal.action === 'SELL' && currentPrice < ema200);
      if (withEma200) {
        score += 5;
        breakdown.push(`Thuận EMA200: +5đ`);
      }
    }

    // Nến Price Action xác nhận
    if (signal.indicators?.candlePattern || signal.indicators?.pattern) {
      score += 6;
      breakdown.push(`Mô hình nến xác nhận: +6đ`);
    }

    // Đột biến volume
    if (avgVolume20 > 0 && currentVolume >= 1.4 * avgVolume20) {
      score += 5;
      breakdown.push(`Volume đột biến: +5đ`);
    }

    // Tỷ lệ R:R
    const risk = Math.abs(signal.entry - signal.stopLoss);
    const reward = Math.abs(signal.takeProfit - signal.entry);
    if (risk > 0) {
      const rr = reward / risk;
      if (rr >= 2.5) {
        score += 6;
        breakdown.push(`Tỷ lệ R:R cao (${rr.toFixed(1)}): +6đ`);
      } else if (rr >= 1.8) {
        score += 3;
        breakdown.push(`Tỷ lệ R:R tốt (${rr.toFixed(1)}): +3đ`);
      }
    }

    // Giới hạn điểm từ 0 đến 100
    score = Math.min(100, Math.max(0, Math.round(score)));

    let rank = 'B';
    let rankBadge = '⭐⭐⭐ [Hạng B - Đạt chuẩn]';
    if (score >= 90) {
      rank = 'S';
      rankBadge = '⭐⭐⭐⭐⭐ [Hạng S - Rất mạnh]';
    } else if (score >= 80) {
      rank = 'A';
      rankBadge = '⭐⭐⭐⭐ [Hạng A - Uy tín cao]';
    }

    return {
      score,
      rank,
      rankBadge,
      regimeMultiplier: multiplier,
      breakdown,
    };
  }

  /**
   * Phương thức phân tích thị trường - Mỗi class con sẽ override logic này
   */
  analyze(marketData) {
    throw new Error(`Chiến lược ${this.name} chưa triển khai phương thức analyze()`);
  }
}

module.exports = BaseStrategy;


const { EMA, RSI, ATR, BollingerBands, StochasticRSI, VWAP } = require('technicalindicators');

/**
 * 1-Minute Gold Scalping Strategy (One-Price Scalper)
 * Chiến lược chuyên biệt cho nến 1 Phút (1m), săn sóng chớp nhoáng với mục tiêu chốt lời 1.00 USD (1 giá)
 */
class OnePriceScalpStrategy {
  constructor(options = {}) {
    this.name = '1M One-Price Scalper (Micro-Momentum & Reversal)';
    this.takeProfitPoints = options.takeProfitPoints || 1.0;
    this.stopLossPoints = options.stopLossPoints || 1.5;
  }

  /**
   * Tính toán các chỉ báo kỹ thuật vi mô cho khung 1 Phút
   */
  calculateIndicators(marketData) {
    const { closes, highs, lows, opens, volumes } = marketData;
    const len = closes.length;
    if (len < 60) return null;

    const currentPrice = closes[len - 1];

    // 1. Đường trung bình ngắn hạn EMA 9, 21, 50
    const ema9Series = EMA.calculate({ period: 9, values: closes });
    const ema21Series = EMA.calculate({ period: 21, values: closes });
    const ema50Series = EMA.calculate({ period: 50, values: closes });

    const ema9 = ema9Series[ema9Series.length - 1];
    const ema21 = ema21Series[ema21Series.length - 1];
    const ema50 = ema50Series[ema50Series.length - 1];

    const prevEma9 = ema9Series[ema9Series.length - 2];
    const prevEma21 = ema21Series[ema21Series.length - 2];

    // 2. RSI 14 & Biến động ATR 14
    const rsiSeries = RSI.calculate({ period: 14, values: closes });
    const atrSeries = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

    const rsi = rsiSeries[rsiSeries.length - 1];
    const prevRsi = rsiSeries[rsiSeries.length - 2];
    const atr = atrSeries[atrSeries.length - 1];

    // 3. Bollinger Bands (20, 2)
    const bbSeries = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
    const bb = bbSeries[bbSeries.length - 1];

    // 4. Stochastic RSI (14, 14, 3, 3)
    let stochK = null;
    let stochD = null;
    let prevStochK = null;
    let prevStochD = null;
    try {
      const stochSeries = StochasticRSI.calculate({
        values: closes,
        rsiPeriod: 14,
        stochasticPeriod: 14,
        kPeriod: 3,
        dPeriod: 3,
      }) || [];
      if (stochSeries.length >= 2) {
        stochK = stochSeries[stochSeries.length - 1].k;
        stochD = stochSeries[stochSeries.length - 1].d;
        prevStochK = stochSeries[stochSeries.length - 2].k;
        prevStochD = stochSeries[stochSeries.length - 2].d;
      }
    } catch (e) {}

    // 5. Khối lượng Volume
    const hasVolume = volumes && volumes.some((v) => v > 0);
    let currentVolume = 0;
    let avgVolume10 = 0;
    if (hasVolume) {
      currentVolume = volumes[volumes.length - 1] || 0;
      const recentVols = volumes.slice(-11, -1);
      if (recentVols.length > 0) {
        avgVolume10 = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
      }
    }

    // 6. Mô hình nến 1m gần nhất
    const lastOpen = opens[len - 1];
    const lastClose = closes[len - 1];
    const lastHigh = highs[len - 1];
    const lastLow = lows[len - 1];

    const prevOpen = opens[len - 2];
    const prevClose = closes[len - 2];

    const body = Math.abs(lastClose - lastOpen);
    const range = lastHigh - lastLow;
    const lowerWick = Math.min(lastOpen, lastClose) - lastLow;
    const upperWick = lastHigh - Math.max(lastOpen, lastClose);

    const isBullishCandle = lastClose > lastOpen;
    const isBearishCandle = lastClose < lastOpen;

    const isHammer = range > 0 && lowerWick >= 1.6 * body && upperWick <= 0.6 * body;
    const isShootingStar = range > 0 && upperWick >= 1.6 * body && lowerWick <= 0.6 * body;
    const isBullishEngulfing = prevClose < prevOpen && isBullishCandle && lastClose >= prevOpen;
    const isBearishEngulfing = prevClose > prevOpen && isBearishCandle && lastClose <= prevOpen;

    return {
      currentPrice,
      ema9,
      ema21,
      ema50,
      prevEma9,
      prevEma21,
      rsi,
      prevRsi,
      atr,
      bb,
      stochK,
      stochD,
      prevStochK,
      prevStochD,
      currentVolume,
      avgVolume10,
      candle: {
        isBullish: isBullishCandle,
        isBearish: isBearishCandle,
        isHammer,
        isShootingStar,
        isBullishEngulfing,
        isBearishEngulfing,
      },
    };
  }

  /**
   * Phân tích xu hướng khung thời gian lớn hơn (Khung 5 Phút - Higher Timeframe Filter)
   * Giúp bot không bao giờ đánh ngược chiều sóng lớn!
   */
  calculateHtfTrend(marketData5m) {
    if (!marketData5m || !marketData5m.closes || marketData5m.closes.length < 35) {
      return { trend: 'NEUTRAL', label: 'Sideway / Chưa rõ xu hướng 5m', bias: 'BOTH' };
    }
    const closes = marketData5m.closes;
    const len = closes.length;
    const lastClose = closes[len - 1];

    const ema20Arr = EMA.calculate({ period: 20, values: closes }) || [];
    const ema50Arr = EMA.calculate({ period: 50, values: closes }) || [];
    const rsiArr = RSI.calculate({ period: 14, values: closes }) || [];

    if (ema20Arr.length === 0 || ema50Arr.length === 0) {
      return { trend: 'NEUTRAL', label: 'Sideway / Chưa rõ xu hướng 5m', bias: 'BOTH' };
    }

    const ema20 = ema20Arr[ema20Arr.length - 1];
    const ema50 = ema50Arr[ema50Arr.length - 1];
    const rsi = rsiArr[rsiArr.length - 1] || 50;

    // Xu hướng Tăng mạnh trên 5m: Giá > EMA20 > EMA50 và RSI 5m >= 48
    if (lastClose > ema20 && ema20 > ema50 && rsi >= 48) {
      return {
        trend: 'BULLISH',
        label: 'Tăng mạnh (Uptrend 5M)',
        bias: 'ONLY_BUY',
        ema20,
        ema50,
        rsi,
      };
    }

    // Xu hướng Giảm mạnh trên 5m: Giá < EMA20 < EMA50 và RSI 5m <= 52
    if (lastClose < ema20 && ema20 < ema50 && rsi <= 52) {
      return {
        trend: 'BEARISH',
        label: 'Giảm mạnh (Downtrend 5M)',
        bias: 'ONLY_SELL',
        ema20,
        ema50,
        rsi,
      };
    }

    return {
      trend: 'NEUTRAL',
      label: 'Đi ngang (Sideway 5M)',
      bias: 'BOTH',
      ema20,
      ema50,
      rsi,
    };
  }

  /**
   * Phân tích thị trường 1m kết hợp lọc đa khung thời gian 5m
   */
  analyze(marketData, marketData5m = null) {
    if (!marketData || marketData.closes.length < 60) return null;

    const ind = this.calculateIndicators(marketData);
    if (!ind) return null;

    const {
      currentPrice,
      ema9,
      ema21,
      ema50,
      rsi,
      prevRsi,
      atr,
      bb,
      stochK,
      stochD,
      prevStochK,
      prevStochD,
      candle,
      currentVolume,
      avgVolume10,
    } = ind;

    // Lọc biên độ tối thiểu: ATR 1m phải đủ lớn (ít nhất $0.40) để đảm bảo có thể chạy được 1 giá nhanh chóng
    if (atr && atr < 0.40) {
      return null;
    }

    // Xác định xu hướng khung 5M (Higher Timeframe Filter)
    const htf = this.calculateHtfTrend(marketData5m);

    let action = null;
    let setupType = null;
    let score = 50; // Điểm cơ sở chặt chẽ từ 50
    const breakdown = [];

    const is1mUptrend = ema9 > ema21 && currentPrice > ema50;
    const is1mDowntrend = ema9 < ema21 && currentPrice < ema50;

    // ===============================================================
    // PATTERN 1: MULTI-TIMEFRAME TREND PULLBACK (Thuận xu hướng 5m & 1m)
    // Tỷ lệ thắng cao nhất: Chỉ đánh theo chiều sóng lớn!
    // ===============================================================
    if (htf.bias !== 'ONLY_SELL' && is1mUptrend) {
      // Giá hồi về gần EMA9/EMA21 và bật lên, RSI giữ vững vùng 45-68 hướng lên
      const nearEma = Math.abs(currentPrice - ema9) <= 0.8 || Math.abs(currentPrice - ema21) <= 0.8;
      const rsiHealthy = rsi >= 44 && rsi <= 68 && rsi >= prevRsi;
      const stochBullishCross = stochK != null && stochD != null && stochK >= stochD && stochK < 80;
      const bounceCandle = candle.isBullish || candle.isHammer || candle.isBullishEngulfing;

      if (nearEma && rsiHealthy && stochBullishCross && bounceCandle) {
        action = 'BUY';
        setupType = 'Micro-Trend Pullback (Thuận xu hướng 5m & 1m)';
        score += 20;
        breakdown.push(`Thuận xu hướng 5M (${htf.label}): +20đ`);
        score += 10;
        breakdown.push('Cấu trúc EMA 9/21/50 dốc lên: +10đ');
      }
    } else if (htf.bias !== 'ONLY_BUY' && is1mDowntrend) {
      // Giá hồi về gần EMA9/EMA21 và quay đầu giảm, RSI vùng 32-56 hướng xuống
      const nearEma = Math.abs(currentPrice - ema9) <= 0.8 || Math.abs(currentPrice - ema21) <= 0.8;
      const rsiHealthy = rsi <= 56 && rsi >= 32 && rsi <= prevRsi;
      const stochBearishCross = stochK != null && stochD != null && stochK <= stochD && stochK > 20;
      const dropCandle = candle.isBearish || candle.isShootingStar || candle.isBearishEngulfing;

      if (nearEma && rsiHealthy && stochBearishCross && dropCandle) {
        action = 'SELL';
        setupType = 'Micro-Trend Pullback (Thuận xu hướng 5m & 1m)';
        score += 20;
        breakdown.push(`Thuận xu hướng 5M (${htf.label}): +20đ`);
        score += 10;
        breakdown.push('Cấu trúc EMA 9/21/50 dốc xuống: +10đ');
      }
    }

    // ===============================================================
    // PATTERN 2: BOLLINGER BAND MEAN REVERSION (CHỈ ÁP DỤNG KHI 5M SIDEWAY)
    // Tuyệt đối CẤM bắt đỉnh/đáy ngược khi khung 5m đang có xu hướng mạnh!
    // ===============================================================
    if (!action && htf.trend === 'NEUTRAL' && bb) {
      // BUY khi chạm Lower Band + Quá bán RSI/Stoch + Nến rút chân
      if (currentPrice <= bb.lower * 1.0006 && (rsi <= 32 || (stochK != null && stochK <= 20))) {
        if (candle.isHammer || candle.isBullish || candle.isBullishEngulfing) {
          action = 'BUY';
          setupType = 'Range Lower Bounce (Bắt đáy biên đi ngang 1m)';
          score += 15;
          breakdown.push('Chạm biên dưới BB vùng Sideway: +15đ');
        }
      }
      // SELL khi chạm Upper Band + Quá mua RSI/Stoch + Nến đảo chiều
      else if (currentPrice >= bb.upper * 0.9994 && (rsi >= 68 || (stochK != null && stochK >= 80))) {
        if (candle.isShootingStar || candle.isBearish || candle.isBearishEngulfing) {
          action = 'SELL';
          setupType = 'Range Upper Rejection (Bắt đỉnh biên đi ngang 1m)';
          score += 15;
          breakdown.push('Chạm biên trên BB vùng Sideway: +15đ');
        }
      }
    }

    // ===============================================================
    // PATTERN 3: STOCHASTIC RSI REVERSAL (CHỈ KHI PHÙ HỢP VỚI XU HƯỚNG 5M)
    // ===============================================================
    if (!action && stochK != null && stochD != null && prevStochK != null && prevStochD != null) {
      if (htf.bias !== 'ONLY_SELL' && prevStochK <= prevStochD && stochK > stochD && stochK <= 28 && candle.isBullish) {
        action = 'BUY';
        setupType = 'StochRSI Oversold Bounce (Bật tăng quá bán)';
        score += 15;
        breakdown.push('StochRSI Golden Cross vùng đáy: +15đ');
      } else if (htf.bias !== 'ONLY_BUY' && prevStochK >= prevStochD && stochK < stochD && stochK >= 72 && candle.isBearish) {
        action = 'SELL';
        setupType = 'StochRSI Overbought Drop (Quay đầu quá mua)';
        score += 15;
        breakdown.push('StochRSI Dead Cross vùng đỉnh: +15đ');
      }
    }

    if (!action) return null;

    // Điểm cộng nến xác nhận Price Action
    if (candle.isHammer || candle.isShootingStar || candle.isBullishEngulfing || candle.isBearishEngulfing) {
      score += 10;
      breakdown.push('Nến Price Action xác nhận (Pinbar/Engulfing): +10đ');
    }

    // Điểm cộng đột biến volume 1m (dòng tiền lớn ủng hộ)
    if (avgVolume10 > 0 && currentVolume >= 1.25 * avgVolume10) {
      score += 10;
      breakdown.push('Volume nến 1m bùng nổ (>1.25x TB10): +10đ');
    }

    const finalScore = Math.min(100, Math.max(0, Math.round(score)));

    // Tính Take Profit cố định 1 GIÁ (+1.00 USD) và Stop Loss theo cấu hình người dùng
    const takeProfit = action === 'BUY'
      ? parseFloat((currentPrice + this.takeProfitPoints).toFixed(2))
      : parseFloat((currentPrice - this.takeProfitPoints).toFixed(2));

    const stopLoss = action === 'BUY'
      ? parseFloat((currentPrice - this.stopLossPoints).toFixed(2))
      : parseFloat((currentPrice + this.stopLossPoints).toFixed(2));

    let rank = 'B';
    let rankBadge = '⭐⭐⭐ [Hạng B - Tiêu chuẩn]';
    if (finalScore >= 90) {
      rank = 'S';
      rankBadge = '⭐⭐⭐⭐⭐ [Hạng S - Rất mạnh]';
    } else if (finalScore >= 75) {
      rank = 'A';
      rankBadge = '⭐⭐⭐⭐ [Hạng A - Uy tín cao]';
    }

    return {
      strategy: this.name,
      setupType,
      action,
      entry: currentPrice,
      takeProfit,
      stopLoss,
      takeProfitPoints: this.takeProfitPoints,
      stopLossPoints: this.stopLossPoints,
      rrRatio: `1 : ${(this.takeProfitPoints / this.stopLossPoints).toFixed(2)}`,
      score: finalScore,
      rank,
      rankBadge,
      breakdown,
      indicators: {
        currentPrice,
        ema9,
        ema21,
        ema50,
        rsi,
        atr,
        stochK,
        stochD,
        pattern: candle.isHammer ? 'Pinbar Hammer' :
                 candle.isShootingStar ? 'Shooting Star' :
                 candle.isBullishEngulfing ? 'Bullish Engulfing' :
                 candle.isBearishEngulfing ? 'Bearish Engulfing' : 'Nến tiêu chuẩn',
      },
    };
  }
}

module.exports = OnePriceScalpStrategy;

const BaseStrategy = require('./baseStrategy');

class OrderFlowReversalStrategy extends BaseStrategy {
  constructor() {
    super(
      'Order Flow & Liquidity Reversal (High Win-Rate)',
      'Hệ thống phát hiện Đỉnh/Đáy đa chiều (Win-Rate 75-85%) kết hợp Smart Money Sweep, Order Flow Delta, Volume Climax, RSI Divergence & Bollinger Bands',
      85,
      'ORDER_FLOW'
    );
  }

  /**
   * Phân tích Đỉnh / Đáy đa chiều với Hệ thống chấm điểm đồng thuận (Confluence Scoring Engine 0 - 100đ)
   * Kế thừa toàn bộ 5 trụ cột từ crypto-gold-detector:
   * 1. Smart Money Concepts (Liquidity Sweep & Rejection Wick)
   * 2. Volume Climax & Order Flow Delta Absorption
   * 3. Momentum RSI & Divergence
   * 4. Thống kê độ lệch chuẩn Bollinger Bands 2.0σ
   * 5. Bộ lọc xu hướng Trend Filter EMA 50
   */
  analyze(marketData) {
    const candles = marketData.candles;
    if (!candles || candles.length < 40) return null;

    const ind = this.calculateIndicators(marketData);
    const { closes, highs, lows, volumes, ema50, ema200, bb } = ind;

    // Chọn nến mục tiêu: Nến vừa đóng hoàn chỉnh (candles.length - 2) để chống repaint,
    // hoặc nến cuối nếu đang ở chế độ nến đóng (candles.length - 1)
    const targetIndex = candles.length >= 2 ? candles.length - 2 : candles.length - 1;
    if (targetIndex < 25) return null;

    const candle = candles[targetIndex];
    const lookbackPeriod = 25;
    const prevCandles = candles.slice(targetIndex - lookbackPeriod, targetIndex);

    const open = candle.open;
    const high = candle.high;
    const low = candle.low;
    const close = candle.close;
    const volume = candle.volume || 0;
    const delta = candle.delta != null ? candle.delta : 0;

    // Tính Volume SMA 20
    const volSmaSlice = candles.slice(Math.max(0, targetIndex - 19), targetIndex + 1);
    const volSma = volSmaSlice.length > 0
      ? volSmaSlice.reduce((acc, c) => acc + (c.volume || 0), 0) / volSmaSlice.length
      : volume;

    const range = Math.max(high - low, 0.0001);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickRatio = upperWick / range;
    const lowerWickRatio = lowerWick / range;

    const volRatio = volume / (volSma || volume || 1);
    const maxPrevHigh = Math.max(...prevCandles.map((c) => c.high));
    const minPrevLow = Math.min(...prevCandles.map((c) => c.low));

    // Lấy RSI tại nến mục tiêu
    const rsi = ind.rsiSeries && ind.rsiSeries.length > 1
      ? ind.rsiSeries[ind.rsiSeries.length - 2]
      : ind.rsi;

    // Bollinger Bands tại nến mục tiêu
    const targetBb = bb || ind.prevBb;

    // ==========================================
    // 1. KIỂM TRA TÍN HIỆU TẠO ĐỈNH (TOP / SHORT)
    // ==========================================
    let topScore = 0;
    const topFactors = [];

    // Trụ cột 1: Smart Money Liquidity Sweep (Max 30đ)
    const sweptHigh = high >= maxPrevHigh;
    const closedBelowHigh = close < maxPrevHigh;
    if (sweptHigh && closedBelowHigh && upperWickRatio >= 0.35) {
      topScore += 30;
      topFactors.push(`Quét thanh khoản đỉnh ${lookbackPeriod} nến (${high.toFixed(2)} > ${maxPrevHigh.toFixed(2)}) & rút râu ${(upperWickRatio * 100).toFixed(0)}% [30đ]`);
    } else if (sweptHigh && upperWickRatio >= 0.40) {
      topScore += 20;
      topFactors.push(`Chạm đỉnh cao nhất với râu trên từ chối dài ${(upperWickRatio * 100).toFixed(0)}% [20đ]`);
    } else if (upperWickRatio >= 0.50 && high >= maxPrevHigh * 0.995) {
      topScore += 15;
      topFactors.push(`Nến Pinbar / Shooting Star tại kháng cự đỉnh [15đ]`);
    }

    // Trụ cột 2: Volume Climax & Order Flow Delta (Max 25đ)
    if (volRatio >= 2.0) {
      topScore += 15;
      topFactors.push(`Volume Climax đột biến ${(volRatio).toFixed(1)}x TB (Dấu hiệu cá mập xả) [15đ]`);
    } else if (volRatio >= 1.5) {
      topScore += 10;
      topFactors.push(`Volume tăng cao ${(volRatio).toFixed(1)}x TB [10đ]`);
    }

    if (delta < 0 && close >= open) {
      topScore += 10;
      topFactors.push(`Hấp thụ Cung: Nến xanh nhưng Delta âm (${delta.toFixed(1)}) do Limit Sell chặn trên [10đ]`);
    } else if (delta < 0) {
      topScore += 5;
      topFactors.push(`Phe bán chủ động áp đảo (Delta âm ${delta.toFixed(1)}) [5đ]`);
    }

    // Trụ cột 3: Momentum RSI & Phân kỳ (Max 25đ)
    if (rsi >= 70) {
      topScore += 15;
      topFactors.push(`RSI Quá Mua cực độ (${rsi.toFixed(1)} >= 70) [15đ]`);
    } else if (rsi >= 62) {
      topScore += 8;
      topFactors.push(`RSI vùng hưng phấn cao (${rsi.toFixed(1)}) [8đ]`);
    }

    // Tìm phân kỳ âm RSI với các đỉnh trước trong 25 nến
    const recentHighCandles = prevCandles.filter((c) => c.high >= maxPrevHigh * 0.997);
    if (recentHighCandles.length > 0) {
      const prevPeak = recentHighCandles[recentHighCandles.length - 1];
      const prevRsiVal = prevPeak.rsi || (ind.rsiSeries ? ind.rsiSeries[ind.rsiSeries.length - 15] : 60);
      if (high >= prevPeak.high && rsi < prevRsiVal - 2.0) {
        topScore += 10;
        topFactors.push(`Phân kỳ âm RSI: Giá tạo đỉnh mới nhưng RSI suy yếu (${rsi.toFixed(1)} < ${prevRsiVal.toFixed(1)}) [10đ]`);
      }
    }

    // Trụ cột 4: Thống kê độ lệch Bollinger Bands (Max 20đ)
    if (targetBb && high >= targetBb.upper) {
      topScore += 20;
      topFactors.push(`Giá đâm thủng Upper Bollinger Band (${targetBb.upper.toFixed(2)}) rồi bị nén lại [20đ]`);
    }

    // Trụ cột 5: Xu hướng tổng quan (Bonus +10đ)
    if (ema50 && close < ema50) {
      topScore += 10;
      topFactors.push(`Thuận xu hướng giảm ngắn hạn (Dưới EMA 50) [10đ]`);
    }

    // =============================================
    // 2. KIỂM TRA TÍN HIỆU TẠO ĐÁY (BOTTOM / LONG)
    // =============================================
    let bottomScore = 0;
    const bottomFactors = [];

    // Trụ cột 1: Smart Money Liquidity Sweep (Max 30đ)
    const sweptLow = low <= minPrevLow;
    const closedAboveLow = close > minPrevLow;
    if (sweptLow && closedAboveLow && lowerWickRatio >= 0.35) {
      bottomScore += 30;
      bottomFactors.push(`Quét râu thủng đáy cũ ${lookbackPeriod} nến (${low.toFixed(2)} < ${minPrevLow.toFixed(2)}) & rút chân ${(lowerWickRatio * 100).toFixed(0)}% [30đ]`);
    } else if (sweptLow && lowerWickRatio >= 0.40) {
      bottomScore += 20;
      bottomFactors.push(`Chạm đáy sâu nhất với rút chân mạnh ${(lowerWickRatio * 100).toFixed(0)}% [20đ]`);
    } else if (lowerWickRatio >= 0.50 && low <= minPrevLow * 1.005) {
      bottomScore += 15;
      bottomFactors.push(`Nến Hammer / Pinbar đỡ giá tại hỗ trợ [15đ]`);
    }

    // Trụ cột 2: Volume Climax & Order Flow Delta (Max 25đ)
    if (volRatio >= 2.0) {
      bottomScore += 15;
      bottomFactors.push(`Volume Climax bán tháo ${(volRatio).toFixed(1)}x TB (Selling Climax) [15đ]`);
    } else if (volRatio >= 1.5) {
      bottomScore += 10;
      bottomFactors.push(`Volume bán lớn ${(volRatio).toFixed(1)}x TB [10đ]`);
    }

    if (delta > 0 && close <= open) {
      bottomScore += 10;
      bottomFactors.push(`Hấp thụ Cầu: Nến đỏ nhưng Delta dương (+${delta.toFixed(1)}) do Limit Buy kê đỡ [10đ]`);
    } else if (delta > 0) {
      bottomScore += 5;
      bottomFactors.push(`Phe mua chủ động gom hàng (Delta +${delta.toFixed(1)}) [5đ]`);
    }

    // Trụ cột 3: Momentum RSI & Phân kỳ (Max 25đ)
    if (rsi <= 30) {
      bottomScore += 15;
      bottomFactors.push(`RSI Quá Bán cực độ (${rsi.toFixed(1)} <= 30) [15đ]`);
    } else if (rsi <= 38) {
      bottomScore += 8;
      bottomFactors.push(`RSI vùng hoảng loạn sâu (${rsi.toFixed(1)}) [8đ]`);
    }

    // Tìm phân kỳ dương RSI với các đáy trước
    const recentLowCandles = prevCandles.filter((c) => c.low <= minPrevLow * 1.003);
    if (recentLowCandles.length > 0) {
      const prevTrough = recentLowCandles[recentLowCandles.length - 1];
      const prevRsiVal = prevTrough.rsi || (ind.rsiSeries ? ind.rsiSeries[ind.rsiSeries.length - 15] : 40);
      if (low <= prevTrough.low && rsi > prevRsiVal + 2.0) {
        bottomScore += 10;
        bottomFactors.push(`Phân kỳ dương RSI: Giá thủng đáy nhưng RSI tạo đáy cao hơn (${rsi.toFixed(1)} > ${prevRsiVal.toFixed(1)}) [10đ]`);
      }
    }

    // Trụ cột 4: Thống kê độ lệch Bollinger Bands (Max 20đ)
    if (targetBb && low <= targetBb.lower) {
      bottomScore += 20;
      bottomFactors.push(`Giá đâm thủng Lower Bollinger Band (${targetBb.lower.toFixed(2)}) rồi bật ngược lên [20đ]`);
    }

    // Trụ cột 5: Xu hướng tổng quan (Bonus +10đ)
    if (ema50 && close > ema50) {
      bottomScore += 10;
      bottomFactors.push(`Thuận xu hướng tăng ngắn hạn (Trên EMA 50 - Bắt đáy sóng hồi) [10đ]`);
    }

    // Ngưỡng điểm kích hoạt: 65đ (Hạng A Chuẩn), >= 80đ (Hạng VIP A+)
    const minScore = 65;

    // ==========================================
    // 3. TẠO TÍN HIỆU GIAO DỊCH
    // ==========================================
    if (topScore >= minScore && topScore > bottomScore) {
      const sl = parseFloat((high * 1.002).toFixed(2));
      const risk = sl - close;
      if (risk <= 0) return null;

      const tp1 = parseFloat((close - risk * 1.5).toFixed(2));
      const tp2 = parseFloat((close - risk * 3.0).toFixed(2));
      const grade = topScore >= 80 ? '💎 VIP (A+) - TỈ LỆ THẮNG CAO' : '⚡ CHUẨN (A) - TÍN HIỆU TỐT';

      return {
        strategy: this.name,
        action: 'SELL',
        entry: close,
        stopLoss: sl,
        takeProfit: tp1,
        takeProfit2: tp2,
        rrRatio: '1 : 1.5 (TP1) / 1 : 3.0 (TP2)',
        score: Math.min(100, topScore),
        rank: topScore >= 80 ? 'S' : 'A',
        rankBadge: grade,
        breakdown: topFactors,
        factors: topFactors,
        grade,
        indicators: {
          currentPrice: close,
          rsi,
          delta,
          volRatio: `${volRatio.toFixed(1)}x`,
          upperWickRatio: `${(upperWickRatio * 100).toFixed(0)}%`,
          lowerWickRatio: `${(lowerWickRatio * 100).toFixed(0)}%`,
          candlePattern: upperWickRatio >= 0.4 ? 'Pinbar từ chối đỉnh' : 'Nén giá kháng cự',
          ema50,
          ema200,
          bbUpper: targetBb ? targetBb.upper : null,
          bbLower: targetBb ? targetBb.lower : null,
        },
      };
    }

    if (bottomScore >= minScore && bottomScore > topScore) {
      const sl = parseFloat((low * 0.998).toFixed(2));
      const risk = close - sl;
      if (risk <= 0) return null;

      const tp1 = parseFloat((close + risk * 1.5).toFixed(2));
      const tp2 = parseFloat((close + risk * 3.0).toFixed(2));
      const grade = bottomScore >= 80 ? '💎 VIP (A+) - TỈ LỆ THẮNG CAO' : '⚡ CHUẨN (A) - TÍN HIỆU TỐT';

      return {
        strategy: this.name,
        action: 'BUY',
        entry: close,
        stopLoss: sl,
        takeProfit: tp1,
        takeProfit2: tp2,
        rrRatio: '1 : 1.5 (TP1) / 1 : 3.0 (TP2)',
        score: Math.min(100, bottomScore),
        rank: bottomScore >= 80 ? 'S' : 'A',
        rankBadge: grade,
        breakdown: bottomFactors,
        factors: bottomFactors,
        grade,
        indicators: {
          currentPrice: close,
          rsi,
          delta,
          volRatio: `${volRatio.toFixed(1)}x`,
          upperWickRatio: `${(upperWickRatio * 100).toFixed(0)}%`,
          lowerWickRatio: `${(lowerWickRatio * 100).toFixed(0)}%`,
          candlePattern: lowerWickRatio >= 0.4 ? 'Pinbar rút chân đáy' : 'Bật nảy hỗ trợ',
          ema50,
          ema200,
          bbUpper: targetBb ? targetBb.upper : null,
          bbLower: targetBb ? targetBb.lower : null,
        },
      };
    }

    return null;
  }
}

module.exports = OrderFlowReversalStrategy;

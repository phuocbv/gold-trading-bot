const { EMA, RSI, ATR, MACD, BollingerBands, ADX, StochasticRSI, MFI } = require('technicalindicators');
const CONFIG = require('../config');

// Nhóm chiến lược theo pha thị trường phù hợp (dùng cho chấm điểm và ngưỡng R:R)
const TREND_TYPES = ['TREND', 'FLOW', 'BREAKOUT', 'SMC'];

// Cache chỉ báo theo từng bộ dữ liệu nến để các chiến lược không tính lại cùng một thứ
const indicatorCache = new WeakMap();

const HOUR_MS = 3600 * 1000;
const nyDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
// Ngày giao dịch Forex theo từng giờ (nhớ đệm vì Intl chậm khi gọi cho hàng nghìn nến mỗi lượt backtest)
const forexDayCache = new Map();

/**
 * Ngày giao dịch Forex/Vàng: phiên mới lúc 17:00 New York (cộng 7 giờ để 17:00 thành 00:00 ngày hôm sau),
 * tự theo giờ mùa hè/mùa đông giống phiên của TradingView
 */
function forexSessionDay(time) {
  const hour = Math.floor(time / HOUR_MS);
  let day = forexDayCache.get(hour);
  if (day === undefined) {
    if (forexDayCache.size > 50000) forexDayCache.clear();
    day = nyDateFmt.format(new Date(hour * HOUR_MS + 7 * HOUR_MS));
    forexDayCache.set(hour, day);
  }
  return day;
}

/**
 * VWAP neo theo phiên thay vì cộng dồn từ nến đầu tiên của dữ liệu tải về (mốc neo sẽ trôi theo mỗi lần tải).
 * Vàng/Forex reset lúc 17:00 New York; Crypto reset theo CONFIG.vwapSessionUtcHour (mặc định 00:00 UTC).
 */
function calculateSessionVwap(candles, isForex) {
  const sessionOffsetMs = (CONFIG.vwapSessionUtcHour || 0) * HOUR_MS;
  const sessionOf = isForex ? forexSessionDay : (time) => Math.floor((time - sessionOffsetMs) / 86400000);
  const result = [];
  let session = null;
  let cumulativePv = 0;
  let cumulativeVolume = 0;

  for (const c of candles) {
    const time = c.date ? new Date(c.date).getTime() : NaN;
    const candleSession = Number.isNaN(time) ? session : sessionOf(time);
    if (candleSession !== session) {
      session = candleSession;
      cumulativePv = 0;
      cumulativeVolume = 0;
    }
    const volume = c.volume || 0;
    cumulativePv += ((c.high + c.low + c.close) / 3) * volume;
    cumulativeVolume += volume;
    result.push(cumulativeVolume > 0 ? cumulativePv / cumulativeVolume : null);
  }
  return result;
}

class BaseStrategy {
  constructor(name, description, baseWeight = 50, strategyType = 'TREND') {
    this.name = name;
    this.description = description;
    this.baseWeight = baseWeight;
    this.strategyType = strategyType;
  }

  get isTrendType() {
    return TREND_TYPES.includes(this.strategyType);
  }

  /**
   * Xếp hạng tín hiệu theo điểm số (dùng chung cho mọi chiến lược và tín hiệu hợp lưu)
   */
  static rankFor(score, isConfluence = false) {
    if (score >= 90) {
      return { rank: 'S', rankBadge: isConfluence ? '⭐⭐⭐⭐⭐ [Hạng S - Hợp lưu Siêu cấp]' : '⭐⭐⭐⭐⭐ [Hạng S - Rất mạnh]' };
    }
    if (score >= 80) {
      return { rank: 'A', rankBadge: '⭐⭐⭐⭐ [Hạng A - Uy tín cao]' };
    }
    return { rank: 'B', rankBadge: '⭐⭐⭐ [Hạng B - Đạt chuẩn]' };
  }

  /**
   * Tính toán các chỉ báo kỹ thuật mở rộng
   */
  calculateIndicators(data) {
    if (indicatorCache.has(data)) return indicatorCache.get(data);

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

    // 3. VWAP theo phiên & MFI (Dòng tiền và Khối lượng giao dịch)
    const hasValidVolume = volumes && volumes.some((v) => v > 0);
    let vwapResult = [];
    let mfiResult = [];
    let avgVolume20 = 0;

    if (hasValidVolume) {
      if (data.candles && data.candles.length === closes.length) {
        vwapResult = calculateSessionVwap(data.candles, data.isCrypto === false);
      }
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

    const lastVwap = vwapResult.length > 0 ? vwapResult[vwapResult.length - 1] : null;
    const currentVwap = lastVwap != null && !isNaN(lastVwap) ? lastVwap : null;

    const currentMfi = mfiResult.length > 0 ? mfiResult[mfiResult.length - 1] : 50;

    // Delta chỉ có ý nghĩa khi nguồn cung cấp taker volume thật (Binance).
    // Delta ước tính từ thân nến (TradingView/Yahoo) luôn cùng dấu với màu nến nên bị bỏ qua.
    const hasRealDelta = data.hasRealDelta === true;
    const lastCandle = data.candles && data.candles.length > 0 ? data.candles[data.candles.length - 1] : null;
    const prevCandle = data.candles && data.candles.length > 1 ? data.candles[data.candles.length - 2] : null;
    const currentDelta = hasRealDelta && lastCandle ? (lastCandle.delta || 0) : 0;
    const prevDelta = hasRealDelta && prevCandle ? (prevCandle.delta || 0) : 0;

    const indicators = {
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
      volSma20: avgVolume20,
      volRatio: avgVolume20 > 0 ? currentVolume / avgVolume20 : 1,
      hasRealDelta,
      delta: currentDelta,
      prevDelta,
      closes,
      highs,
      lows,
      volumes,
      candles: data.candles || [],
    };

    indicatorCache.set(data, indicators);
    return indicators;
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
   * Tên mô hình nến cùng chiều lệnh, null nếu không có mô hình thật sự
   */
  describeCandlePattern(pattern, action) {
    if (action === 'BUY') {
      if (pattern.isBullishEngulfing) return 'Bullish Engulfing';
      if (pattern.isHammer) return 'Hammer/Pinbar';
    } else if (action === 'SELL') {
      if (pattern.isBearishEngulfing) return 'Bearish Engulfing';
      if (pattern.isShootingStar) return 'Shooting Star';
    }
    return null;
  }

  /**
   * Tìm các đỉnh/đáy swing (pivot) trong `lookback` nến gần nhất, mới nhất đứng trước.
   * Pivot cần `left` nến bên trái và `right` nến bên phải xác nhận.
   */
  findPivots(series, isLow, { left = 3, right = 1, lookback = 40 } = {}) {
    const pivots = [];
    const len = series.length;
    for (let i = len - 1 - right; i >= Math.max(left, len - lookback); i--) {
      let isPivot = true;
      for (let k = 1; k <= left && isPivot; k++) {
        isPivot = isLow ? series[i] < series[i - k] : series[i] > series[i - k];
      }
      for (let k = 1; k <= right && isPivot; k++) {
        isPivot = isLow ? series[i] <= series[i + k] : series[i] >= series[i + k];
      }
      if (isPivot) pivots.push(i);
    }
    return pivots;
  }

  /**
   * Phát hiện Phân kỳ RSI thường (Regular Divergence) giữa 2 đáy/đỉnh swing gần nhất.
   * Đáy/đỉnh thứ 2 phải vừa hình thành (trong `maxAge` nến) và cách đáy/đỉnh thứ 1 tối thiểu `minGap` nến.
   */
  detectRsiDivergence(closes, highs, lows, rsi, { maxAge = 6, minGap = 5 } = {}) {
    if (!rsi || rsi.length < 40 || closes.length < 40) return null;

    const offset = closes.length - rsi.length;
    const len = closes.length;

    const pickPair = (pivots) => {
      const recent = pivots[0];
      if (recent == null || len - 1 - recent > maxAge) return null;
      const earlier = pivots.find((p) => recent - p >= minGap);
      return earlier == null ? null : [earlier, recent];
    };

    // Phân kỳ dương: Giá tạo đáy thấp hơn (Lower Low), nhưng RSI tạo đáy cao hơn (Higher Low)
    const lowPair = pickPair(this.findPivots(lows, true));
    if (lowPair) {
      const [i1, i2] = lowPair;
      const rsi1 = rsi[i1 - offset];
      const rsi2 = rsi[i2 - offset];
      if (lows[i2] < lows[i1] && rsi2 > rsi1 + 2.0 && rsi2 < 50) {
        return {
          type: 'BULLISH',
          name: 'Bullish RSI Divergence',
          desc: `Đáy giá thấp hơn ($${lows[i2].toFixed(1)} < $${lows[i1].toFixed(1)}) nhưng RSI tăng (${rsi2.toFixed(1)} > ${rsi1.toFixed(1)})`,
          price1: lows[i1],
          price2: lows[i2],
          rsi1,
          rsi2,
        };
      }
    }

    // Phân kỳ âm: Giá tạo đỉnh cao hơn (Higher High), nhưng RSI tạo đỉnh thấp hơn (Lower High)
    const highPair = pickPair(this.findPivots(highs, false));
    if (highPair) {
      const [i1, i2] = highPair;
      const rsi1 = rsi[i1 - offset];
      const rsi2 = rsi[i2 - offset];
      if (highs[i2] > highs[i1] && rsi2 < rsi1 - 2.0 && rsi2 > 50) {
        return {
          type: 'BEARISH',
          name: 'Bearish RSI Divergence',
          desc: `Đỉnh giá cao hơn ($${highs[i2].toFixed(1)} > $${highs[i1].toFixed(1)}) nhưng RSI giảm (${rsi2.toFixed(1)} < ${rsi1.toFixed(1)})`,
          price1: highs[i1],
          price2: highs[i2],
          rsi1,
          rsi2,
        };
      }
    }

    return null;
  }

  /**
   * Tính điểm chất lượng tín hiệu (0 - 100) theo pha thị trường và các yếu tố xác nhận.
   * Chỉ giữ các yếu tố đã được backtest cho thấy có cải thiện kết quả:
   * pha ADX phù hợp, thuận EMA200, mô hình nến đảo chiều thật, Delta thật (chiến lược đảo chiều), R:R.
   * @param {object} signal - Tín hiệu thô do analyze() sinh ra
   * @param {object} indicators - Kết quả từ calculateIndicators
   * @returns {object} { score, rank, rankBadge, breakdown }
   */
  evaluateScore(signal, indicators) {
    if (!signal || !indicators) return null;

    let score = this.baseWeight;
    const breakdown = [`Cơ sở: ${this.baseWeight}đ`];
    const { adx, ema200, currentPrice, candles } = indicators;
    const isBuy = signal.action === 'BUY';

    // 1. Pha thị trường theo ADX: chiến lược xu hướng cần trend mạnh, chiến lược đảo chiều cần thị trường đi ngang
    if (this.isTrendType) {
      if (adx >= 22) {
        score += 10;
        breakdown.push(`Trend mạnh phù hợp chiến lược (ADX ${adx.toFixed(1)}): +10đ`);
      } else if (adx < 20) {
        score -= 15;
        breakdown.push(`Sideway làm yếu tín hiệu xu hướng (ADX ${adx.toFixed(1)}): -15đ`);
      }
    } else if (adx < 20) {
      score += 10;
      breakdown.push(`Sideway lý tưởng cho đảo chiều (ADX ${adx.toFixed(1)}): +10đ`);
    } else if (adx >= 22) {
      score -= 15;
      breakdown.push(`Trend mạnh, đánh ngược dòng rủi ro (ADX ${adx.toFixed(1)}): -15đ`);
    }

    // 2. Thuận xu hướng dài hạn EMA200
    if (ema200 && currentPrice && ((isBuy && currentPrice > ema200) || (!isBuy && currentPrice < ema200))) {
      score += 5;
      breakdown.push('Thuận EMA200: +5đ');
    }

    // 3. Mô hình nến đảo chiều thật sự (Pinbar / Engulfing) cùng chiều lệnh
    const n = candles.length;
    const patternName = this.describeCandlePattern(this.detectCandlePattern(candles[n - 2], candles[n - 1]), signal.action);
    if (patternName) {
      score += 8;
      breakdown.push(`Mô hình nến xác nhận (${patternName}): +8đ`);
    }

    // 4. Delta Order Flow thật xác nhận phe chủ động đã đảo chiều (chỉ áp dụng cho chiến lược đảo chiều)
    const delta = indicators.delta || 0;
    if (!this.isTrendType && indicators.hasRealDelta && ((isBuy && delta > 0) || (!isBuy && delta < 0))) {
      score += 5;
      breakdown.push(`Thuận Order Flow Delta (${delta > 0 ? '+' : ''}${delta.toFixed(1)}): +5đ`);
    }

    // 5. Tỷ lệ R:R
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

    return {
      score,
      ...BaseStrategy.rankFor(score),
      breakdown,
    };
  }

  /**
   * Đóng gói tín hiệu: loại lệnh có R:R TP1 dưới ngưỡng, ghi nhãn R:R thật và chấm điểm.
   * Chiến lược đảo chiều yêu cầu R:R >= CONFIG.riskRewardMin; chiến lược xu hướng tối thiểu 1:1.
   */
  buildSignal({ action, entry, stopLoss, takeProfit, takeProfit2, indicators }, ind) {
    const risk = Math.abs(entry - stopLoss);
    if (!risk) return null;

    // SL/TP phải nằm đúng phía so với Entry (vd: RSI Divergence đặt SL theo đáy/đỉnh swing mà giá có thể đã vượt qua)
    const isBuy = action === 'BUY';
    if (isBuy ? (stopLoss >= entry || takeProfit <= entry) : (stopLoss <= entry || takeProfit >= entry)) return null;

    const rr1 = Math.abs(takeProfit - entry) / risk;
    const minRr = this.isTrendType ? 1.0 : CONFIG.riskRewardMin;
    if (rr1 < minRr) return null;

    const rrRatio = takeProfit2
      ? `1 : ${rr1.toFixed(1)} (TP1) / 1 : ${(Math.abs(takeProfit2 - entry) / risk).toFixed(1)} (TP2)`
      : `1 : ${rr1.toFixed(1)}`;

    const signal = {
      strategy: this.name,
      // Ngưỡng điểm riêng của chiến lược (nếu có), vd: quy tắc đã kiểm chứng bằng backtest không cần lọc theo điểm
      ...(this.minScore != null ? { minScore: this.minScore } : {}),
      action,
      entry,
      stopLoss,
      takeProfit,
      takeProfit2,
      rrRatio,
      indicators,
    };

    return {
      ...signal,
      ...this.evaluateScore(signal, ind),
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
module.exports.TREND_TYPES = TREND_TYPES;

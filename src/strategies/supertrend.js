const { ATR } = require('technicalindicators');
const BaseStrategy = require('./baseStrategy');

/**
 * Supertrend (công thức ta.supertrend của TradingView) đổi chiều, thuận xu hướng dài hạn EMA200.
 * Backtest Vàng khung ngày 1990-2026 (trừ spread $0.35): lãi ở cả 5 giai đoạn thị trường (giảm 1990s, tăng 2000s,
 * giảm 2011-2015, đi ngang 2016-2019, tăng 2020s), lãi cả lệnh MUA lẫn BÁN. Ở khung 1h-2h không có lợi thế,
 * nên chỉ chạy ở khung ngày (ít tín hiệu, khoảng 4 lệnh/năm).
 */
class SupertrendStrategy extends BaseStrategy {
  constructor(period = 10, multiplier = 3) {
    super(
      `Supertrend (${period},${multiplier} + EMA200)`,
      `Supertrend(${period}, ${multiplier}) đổi chiều, thuận xu hướng dài hạn EMA200`,
      50,
      'TREND'
    );
    this.period = period;
    this.multiplier = multiplier;
    // Quy tắc vào lệnh đã được kiểm chứng bằng backtest, không lọc thêm bằng thang điểm chung
    this.minScore = 0;
  }

  /**
   * Hướng Supertrend ở nến cuối và nến trước đó, theo đúng công thức Pine ta.supertrend:
   * dải trên/dưới chỉ được nới khi giá đóng cửa trước đó vượt qua; đổi chiều khi giá đóng cửa vượt dải hiện tại
   */
  supertrend({ closes, highs, lows }) {
    const atr = ATR.calculate({ period: this.period, high: highs, low: lows, close: closes });
    const offset = closes.length - atr.length;
    let upper = NaN;
    let lower = NaN;
    let trendUp = false;
    let prevTrendUp = false;
    for (let i = offset; i < closes.length; i++) {
      const hl2 = (highs[i] + lows[i]) / 2;
      const band = this.multiplier * atr[i - offset];
      const rawUpper = hl2 + band;
      const rawLower = hl2 - band;
      const newUpper = Number.isNaN(upper) || rawUpper < upper || closes[i - 1] > upper ? rawUpper : upper;
      const newLower = Number.isNaN(lower) || rawLower > lower || closes[i - 1] < lower ? rawLower : lower;
      prevTrendUp = trendUp;
      if (i > offset) trendUp = prevTrendUp ? !(closes[i] < newLower) : closes[i] > newUpper;
      upper = newUpper;
      lower = newLower;
    }
    return { trendUp, prevTrendUp, line: trendUp ? lower : upper };
  }

  analyze(marketData) {
    if (!marketData || marketData.closes.length < 210) return null;

    const ind = this.calculateIndicators(marketData);
    const { currentPrice, atr, ema200 } = ind;
    if (!atr || !ema200) return null;

    const { trendUp, prevTrendUp, line } = this.supertrend(marketData);
    let action = null;
    if (trendUp && !prevTrendUp && currentPrice > ema200) action = 'BUY';
    else if (!trendUp && prevTrendUp && currentPrice < ema200) action = 'SELL';
    if (!action) return null;

    const direction = action === 'BUY' ? 1 : -1;
    const risk = 1.5 * atr;

    return this.buildSignal({
      action,
      entry: currentPrice,
      stopLoss: currentPrice - direction * risk,
      takeProfit: currentPrice + direction * 2 * risk,
      takeProfit2: currentPrice + direction * 3 * risk,
      indicators: {
        currentPrice,
        atr,
        ema200,
        supertrendLine: line,
      },
    }, ind);
  }
}

module.exports = SupertrendStrategy;

const { EMA, RSI, ATR, MACD, BollingerBands } = require('technicalindicators');

class BaseStrategy {
  constructor(name, description) {
    this.name = name;
    this.description = description;
  }

  /**
   * Tính toán các chỉ báo kỹ thuật cơ bản
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

    const currentPrice = closes[closes.length - 1];

    return {
      currentPrice,
      ema20: ema20[ema20.length - 1],
      ema50: ema50[ema50.length - 1],
      ema200: ema200[ema200.length - 1],
      rsi: rsi[rsi.length - 1],
      prevRsi: rsi[rsi.length - 2],
      atr: atr[atr.length - 1],
      macd: macd[macd.length - 1],
      prevMacd: macd[macd.length - 2],
      bb: bb[bb.length - 1],
      prevBb: bb[bb.length - 2],
      closes,
      highs,
      lows,
      volumes,
    };
  }

  /**
   * Phương thức phân tích thị trường - Mỗi class con sẽ override logic này
   * @param {object} marketData - { closes, highs, lows, opens, volumes, candles }
   * @returns {object | null} - Tín hiệu vào lệnh hoặc null nếu không có tín hiệu
   */
  analyze(marketData) {
    throw new Error(`Chiến lược ${this.name} chưa triển khai phương thức analyze()`);
  }
}

module.exports = BaseStrategy;

const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

// Bộ nhớ cache tạm thời trong cùng một chu kỳ quét
const cache = new Map();

// Danh sách mirror endpoints của Binance để đảm bảo độ sẵn sàng 100%
const BINANCE_ENDPOINTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

/**
 * Lấy dữ liệu nến Vàng giao ngay (Spot Gold XAU/USD) thời gian thực từ Binance
 * @param {string} interval - '15m', '1h', '4h', '1d'
 * @param {number} limit - Số lượng nến (mặc định 500 nến)
 */
async function fetchBinanceSpotGold(interval = '15m', limit = 500) {
  let lastError = null;

  for (const endpoint of BINANCE_ENDPOINTS) {
    try {
      // 1. Lấy dữ liệu klines (nến)
      const klinesUrl = `${endpoint}/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&limit=${limit}`;
      const res = await axios.get(klinesUrl, { timeout: 5000 });
      const rawKlines = res.data || [];

      // 2. Lấy giá tick trực tiếp realtime mới nhất
      let livePrice = null;
      try {
        const tickerRes = await axios.get(`${endpoint}/api/v3/ticker/price?symbol=PAXGUSDT`, { timeout: 3000 });
        if (tickerRes.data && tickerRes.data.price) {
          livePrice = parseFloat(tickerRes.data.price);
        }
      } catch (tickerErr) {
        // Nếu lỗi lấy ticker thì dùng giá đóng cửa nến cuối
      }

      const closes = [];
      const highs = [];
      const lows = [];
      const opens = [];
      const volumes = [];
      const candles = [];

      rawKlines.forEach((k, index) => {
        const open = parseFloat(k[1]);
        let high = parseFloat(k[2]);
        let low = parseFloat(k[3]);
        let close = parseFloat(k[4]);
        const volume = parseFloat(k[5]);
        const date = new Date(k[0]);

        // Cập nhật nến hiện tại với giá realtime tick mới nhất
        if (index === rawKlines.length - 1 && livePrice != null) {
          close = livePrice;
          if (livePrice > high) high = livePrice;
          if (livePrice < low) low = livePrice;
        }

        closes.push(close);
        highs.push(high);
        lows.push(low);
        opens.push(open);
        volumes.push(volume);
        candles.push({
          date,
          open,
          high,
          low,
          close,
          volume,
        });
      });

      return { closes, highs, lows, opens, volumes, candles, isRealtime: true, source: 'Binance Spot (PAXG/USDT)' };
    } catch (err) {
      lastError = err;
      // Thử mirror tiếp theo
    }
  }

  throw lastError || new Error('Không thể kết nối tới Binance Spot Gold API');
}

/**
 * Lấy dữ liệu nến từ Yahoo Finance (dành cho Hợp đồng tương lai GC=F)
 */
async function fetchYahooCandles(symbol = 'GC=F', interval = '15m', daysBack = 14) {
  const queryOptions = {
    period1: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000),
    interval: interval,
  };

  const result = await yahooFinance.chart(symbol, queryOptions);
  const quotes = result.quotes || [];

  const closes = [];
  const highs = [];
  const lows = [];
  const opens = [];
  const volumes = [];
  const candles = [];

  quotes.forEach((q) => {
    if (q.close != null && q.high != null && q.low != null && q.open != null) {
      closes.push(q.close);
      highs.push(q.high);
      lows.push(q.low);
      opens.push(q.open);
      volumes.push(q.volume || 0);
      candles.push({
        date: q.date,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume || 0,
      });
    }
  });

  return { closes, highs, lows, opens, volumes, candles, isRealtime: false, source: `Yahoo Finance (${symbol})` };
}

/**
 * Hàm lấy nến tổng quát hỗ trợ cả Vàng giao ngay Realtime và Hợp đồng tương lai
 * @param {string} symbol - 'XAU/USD' | 'XAUUSD' | 'PAXGUSDT' (mặc định Spot Realtime) hoặc 'GC=F' (Futures)
 * @param {string} interval - '15m', '1h', v.v.
 * @param {number} daysBack - Số ngày lùi lại nếu dùng Yahoo
 */
async function fetchCandles(symbol = 'XAU/USD', interval = '15m', daysBack = 14) {
  const cacheKey = `${symbol}_${interval}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  // Cache trong 15 giây để tránh spam gọi API trong cùng 1 chu kỳ
  if (cached && (now - cached.timestamp < 15 * 1000)) {
    return cached.data;
  }

  try {
    let data = null;
    const isSpotGold = !symbol || symbol.includes('XAU') || symbol.includes('PAXG') || symbol === 'GOLD';

    if (isSpotGold) {
      data = await fetchBinanceSpotGold(interval, 500);
    } else {
      data = await fetchYahooCandles(symbol, interval, daysBack);
    }

    cache.set(cacheKey, { timestamp: now, data });
    return data;
  } catch (error) {
    console.error(`❌ [MarketData] Lỗi lấy dữ liệu ${symbol} (${interval}):`, error.message);
    // Nếu lỗi Spot Binance, thử fallback sang Yahoo GC=F
    try {
      console.log('🔄 Đang thử fallback sang nguồn nến phụ...');
      const fallback = await fetchYahooCandles('GC=F', interval, daysBack);
      return fallback;
    } catch (fbErr) {
      return null;
    }
  }
}

/**
 * Lấy dữ liệu đa khung thời gian
 */
async function fetchMultiTimeframeCandles(symbol = 'XAU/USD', primaryTf = '15m', higherTf = '1h') {
  const [primaryData, higherData] = await Promise.all([
    fetchCandles(symbol, primaryTf, 14),
    fetchCandles(symbol, higherTf, 30),
  ]);

  return {
    primary: primaryData,
    higher: higherData,
  };
}

module.exports = {
  fetchCandles,
  fetchMultiTimeframeCandles,
};

const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

// Bộ nhớ cache tạm thời trong cùng một chu kỳ quét
const cache = new Map();

// Headers giả lập trình duyệt để tránh bị WAF/Cloudflare của Binance chặn (lỗi 418)
const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Danh sách mirror endpoints của Binance (ưu tiên data-api.binance.vision chuyên dụng cho public data)
const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision',
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
      const res = await axios.get(klinesUrl, { 
        headers: HTTP_HEADERS,
        timeout: 6000 
      });
      const rawKlines = res.data || [];

      if (!Array.isArray(rawKlines) || rawKlines.length === 0) {
        throw new Error('Dữ liệu nến rỗng từ Binance');
      }

      // 2. Lấy giá tick trực tiếp realtime mới nhất
      let livePrice = null;
      try {
        const tickerRes = await axios.get(`${endpoint}/api/v3/ticker/price?symbol=PAXGUSDT`, { 
          headers: HTTP_HEADERS,
          timeout: 3000 
        });
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
      // Nếu gặp lỗi 418 hoặc 429 (IP bị ban/rate limit), không gọi dồn dập các endpoint Binance khác
      if (err.response && (err.response.status === 418 || err.response.status === 429)) {
        break;
      }
    }
  }

  throw lastError || new Error('Không thể kết nối tới Binance Spot Gold API');
}

/**
 * Lấy dữ liệu nến Vàng giao ngay từ sàn Gate.io (Dự phòng 24/7 khi Binance bị 418/chặn IP)
 */
async function fetchGateIoSpotGold(interval = '15m', limit = 500) {
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=PAXG_USDT&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url, {
    headers: HTTP_HEADERS,
    timeout: 6000,
  });

  const raw = res.data || [];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Dữ liệu nến rỗng từ Gate.io');
  }

  const closes = [];
  const highs = [];
  const lows = [];
  const opens = [];
  const volumes = [];
  const candles = [];

  raw.forEach((c) => {
    // Format Gate.io: [timestamp_sec, quote_volume, close, high, low, open, base_volume]
    const timestamp = parseInt(c[0], 10) * 1000;
    const close = parseFloat(c[2]);
    const high = parseFloat(c[3]);
    const low = parseFloat(c[4]);
    const open = parseFloat(c[5]);
    const volume = parseFloat(c[6]);

    closes.push(close);
    highs.push(high);
    lows.push(low);
    opens.push(open);
    volumes.push(volume);
    candles.push({
      date: new Date(timestamp),
      open,
      high,
      low,
      close,
      volume,
    });
  });

  return { closes, highs, lows, opens, volumes, candles, isRealtime: true, source: 'Gate.io Spot (PAXG/USDT)' };
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
 * Hàm lấy nến tổng quát đa nguồn hỗ trợ tự động Fallback (Binance -> Gate.io -> Yahoo)
 * @param {string} symbol - 'XAU/USD' | 'XAUUSD' | 'PAXGUSDT' (mặc định Spot Realtime) hoặc 'GC=F' (Futures)
 * @param {string} interval - '15m', '1h', v.v.
 * @param {number} daysBack - Số ngày lùi lại nếu dùng Yahoo
 */
async function fetchCandles(symbol = 'XAU/USD', interval = '15m', daysBack = 14) {
  const cacheKey = `${symbol}_${interval}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  // Cache trong 20 giây để tránh spam gọi API trong cùng 1 chu kỳ quét
  if (cached && (now - cached.timestamp < 20 * 1000)) {
    return cached.data;
  }

  const isSpotGold = !symbol || symbol.includes('XAU') || symbol.includes('PAXG') || symbol === 'GOLD';

  // 1. Nếu là Spot Gold: Ưu tiên Binance Spot
  if (isSpotGold) {
    try {
      const data = await fetchBinanceSpotGold(interval, 500);
      cache.set(cacheKey, { timestamp: now, data });
      return data;
    } catch (binanceErr) {
      const isRateLimit = binanceErr.response && (binanceErr.response.status === 418 || binanceErr.response.status === 429);
      if (isRateLimit) {
        console.warn(`⚠️ [MarketData] Binance hạn chế IP (${binanceErr.response.status} Rate Limit). Đang chuyển sang sàn Spot dự phòng...`);
      } else {
        console.warn(`⚠️ [MarketData] Lỗi kết nối Binance (${binanceErr.message}). Đang chuyển sang sàn Spot dự phòng...`);
      }

      // 2. Fallback sang Gate.io Spot Gold (PAXG/USDT - 24/7)
      try {
        const gateData = await fetchGateIoSpotGold(interval, 500);
        cache.set(cacheKey, { timestamp: now, data: gateData });
        return gateData;
      } catch (gateErr) {
        console.warn(`⚠️ [MarketData] Gate.io không khả dụng (${gateErr.message}). Chuyển sang Yahoo Finance...`);
      }
    }
  }

  // 3. Fallback sang Yahoo Finance (GC=F)
  try {
    const yahooSymbol = isSpotGold ? 'GC=F' : symbol;
    const yahooData = await fetchYahooCandles(yahooSymbol, interval, daysBack);
    cache.set(cacheKey, { timestamp: now, data: yahooData });
    return yahooData;
  } catch (yahooErr) {
    console.error(`❌ [MarketData] Tất cả các nguồn dữ liệu cho ${symbol} (${interval}) đều thất bại:`, yahooErr.message);
    return null;
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

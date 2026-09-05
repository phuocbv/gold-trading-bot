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
 * Ánh xạ mã tài sản sang mã giao dịch trên Binance và Yahoo Finance
 */
function resolveSymbolSources(rawSymbol = 'XAU/USD') {
  const norm = rawSymbol.toUpperCase().replace(/[\/\-_]/g, '');

  // Vàng (Gold)
  if (norm.includes('XAU') || norm.includes('PAXG') || norm.includes('GOLD')) {
    return {
      rawSymbol,
      displayName: 'Vàng (XAU/USD)',
      binanceSymbol: 'PAXGUSDT',
      yahooSymbol: 'GC=F',
      isCrypto: false,
    };
  }

  // Ethereum
  if (norm.includes('ETH')) {
    return {
      rawSymbol,
      displayName: 'Ethereum (ETH/USDT)',
      binanceSymbol: 'ETHUSDT',
      yahooSymbol: 'ETH-USD',
      isCrypto: true,
    };
  }

  // Bitcoin
  if (norm.includes('BTC')) {
    return {
      rawSymbol,
      displayName: 'Bitcoin (BTC/USDT)',
      binanceSymbol: 'BTCUSDT',
      yahooSymbol: 'BTC-USD',
      isCrypto: true,
    };
  }

  // Solana
  if (norm.includes('SOL')) {
    return {
      rawSymbol,
      displayName: 'Solana (SOL/USDT)',
      binanceSymbol: 'SOLUSDT',
      yahooSymbol: 'SOL-USD',
      isCrypto: true,
    };
  }

  // Mặc định cho các cặp khác
  const binanceSymbol = norm.endsWith('USDT') ? norm : `${norm}USDT`;
  return {
    rawSymbol,
    displayName: rawSymbol,
    binanceSymbol,
    yahooSymbol: `${norm.replace('USDT', '')}-USD`,
    isCrypto: true,
  };
}

/**
 * Lấy dữ liệu nến thời gian thực từ Binance Spot
 */
async function fetchBinanceKlines(binanceSymbol = 'PAXGUSDT', interval = '15m', limit = 500) {
  let lastError = null;

  for (const endpoint of BINANCE_ENDPOINTS) {
    try {
      // 1. Lấy dữ liệu klines (nến)
      const klinesUrl = `${endpoint}/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
      const res = await axios.get(klinesUrl, { timeout: 6000 });
      const rawKlines = res.data || [];

      // 2. Lấy giá tick trực tiếp realtime mới nhất
      let livePrice = null;
      try {
        const tickerRes = await axios.get(`${endpoint}/api/v3/ticker/price?symbol=${binanceSymbol}`, { timeout: 3000 });
        if (tickerRes.data && tickerRes.data.price) {
          livePrice = parseFloat(tickerRes.data.price);
        }
      } catch (tickerErr) {
        // Fallback sang giá đóng cửa nến cuối
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

      return {
        closes,
        highs,
        lows,
        opens,
        volumes,
        candles,
        isRealtime: true,
        source: `Binance Spot (${binanceSymbol})`,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Không thể kết nối tới Binance Spot API cho ${binanceSymbol}`);
}

/**
 * Lấy dữ liệu nến từ Yahoo Finance
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
 * Hàm lấy nến tổng quát hỗ trợ cả Vàng, ETH và các Crypto khác
 * @param {string} symbol - 'XAU/USD' | 'ETH/USDT' | 'BTC/USDT', v.v.
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

  const resolved = resolveSymbolSources(symbol);

  try {
    let data = null;
    // Ưu tiên nạp từ Binance Spot Realtime
    try {
      data = await fetchBinanceKlines(resolved.binanceSymbol, interval, 500);
    } catch (binanceErr) {
      console.warn(`⚠️ [MarketData] Binance ${resolved.binanceSymbol} lỗi (${binanceErr.message}), thử fallback Yahoo Finance...`);
      data = await fetchYahooCandles(resolved.yahooSymbol, interval, daysBack);
    }

    if (data) {
      data.symbol = symbol;
      data.displayName = resolved.displayName;
    }

    cache.set(cacheKey, { timestamp: now, data });
    return data;
  } catch (error) {
    console.error(`❌ [MarketData] Lỗi lấy dữ liệu ${symbol} (${interval}):`, error.message);
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
  resolveSymbolSources,
};


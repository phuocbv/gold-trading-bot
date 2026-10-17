const axios = require('axios');
const TradingView = require('@mathieuc/tradingview');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const CONFIG = require('../config');

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
 * Chuyển đổi khung thời gian sang chuẩn của TradingView
 */
function mapTradingViewTimeframe(tf = '15m') {
  const clean = tf.toLowerCase();
  if (clean === '1m') return '1';
  if (clean === '5m') return '5';
  if (clean === '15m') return '15';
  if (clean === '30m') return '30';
  if (clean === '1h' || clean === '60m') return '60';
  if (clean === '2h') return '120';
  if (clean === '4h' || clean === '240m') return '240';
  if (clean === '1d' || clean === 'd') return 'D';
  if (clean === '1w' || clean === 'w') return 'W';
  return tf.replace('m', '');
}

/**
 * Ánh xạ mã tài sản sang các nguồn dữ liệu (TradingView, Binance, Yahoo Finance)
 */
function resolveSymbolSources(rawSymbol = 'XAU/USD') {
  const clean = (rawSymbol || '').toUpperCase().replace(/[\/\-_]/g, '').trim();

  // Vàng (Gold)
  if (clean.includes('XAU') || clean.includes('PAXG') || clean.includes('GOLD')) {
    return {
      rawSymbol,
      displayName: 'Vàng (XAU/USD)',
      tradingViewSymbol: CONFIG.tradingViewSymbol || 'OANDA:XAUUSD',
      binanceSymbol: 'PAXGUSDT',
      yahooSymbol: 'GC=F',
      isCrypto: false,
    };
  }

  // Ethereum
  if (clean.includes('ETH')) {
    return {
      rawSymbol,
      displayName: 'Ethereum (ETH/USDT)',
      tradingViewSymbol: 'BINANCE:ETHUSDT',
      binanceSymbol: 'ETHUSDT',
      yahooSymbol: 'ETH-USD',
      isCrypto: true,
    };
  }

  // Bitcoin
  if (clean.includes('BTC')) {
    return {
      rawSymbol,
      displayName: 'Bitcoin (BTC/USDT)',
      tradingViewSymbol: 'BINANCE:BTCUSDT',
      binanceSymbol: 'BTCUSDT',
      yahooSymbol: 'BTC-USD',
      isCrypto: true,
    };
  }

  // Solana
  if (clean.includes('SOL')) {
    return {
      rawSymbol,
      displayName: 'Solana (SOL/USDT)',
      tradingViewSymbol: 'BINANCE:SOLUSDT',
      binanceSymbol: 'SOLUSDT',
      yahooSymbol: 'SOL-USD',
      isCrypto: true,
    };
  }

  // Mặc định
  const binanceSymbol = clean.endsWith('USDT') ? clean : `${clean}USDT`;
  return {
    rawSymbol,
    displayName: rawSymbol,
    tradingViewSymbol: `BINANCE:${binanceSymbol}`,
    binanceSymbol,
    yahooSymbol: `${clean.replace('USDT', '')}-USD`,
    isCrypto: true,
  };
}

/**
 * Phân giải ticker TradingView tương ứng cho cặp giao dịch
 */
function resolveTradingViewSymbol(symbol) {
  if (symbol && symbol.includes(':')) {
    return symbol;
  }
  return resolveSymbolSources(symbol).tradingViewSymbol;
}

/**
 * Lấy dữ liệu nến Forex XAU/USD hoặc Crypto trực tiếp từ TradingView
 * @param {string} symbol - Ví dụ: 'OANDA:XAUUSD', 'BINANCE:ETHUSDT'
 * @param {string} interval - '15m', '1h', etc.
 * @param {number} range - Số lượng nến (mặc định 250 nến để tính EMA200)
 */
async function fetchTradingViewCandles(symbol = 'OANDA:XAUUSD', interval = '15m', range = 250) {
  const tvSymbol = resolveTradingViewSymbol(symbol);
  const tf = mapTradingViewTimeframe(interval);

  return new Promise((resolve, reject) => {
    let client = null;
    let isFinished = false;

    const cleanup = () => {
      isFinished = true;
      if (client) {
        try {
          client.end();
        } catch (e) {}
      }
    };

    const timeout = setTimeout(() => {
      if (!isFinished) {
        cleanup();
        reject(new Error(`Timeout khi kết nối TradingView (${tvSymbol} - ${interval}) sau 8s`));
      }
    }, 8000);

    try {
      client = new TradingView.Client();
      const chart = new client.Session.Chart();

      chart.setMarket(tvSymbol, {
        timeframe: tf,
        range: Math.max(range, 220),
      });

      chart.onUpdate(() => {
        if (isFinished) return;
        if (chart.periods && chart.periods.length >= 50) {
          clearTimeout(timeout);
          // chart.periods xếp theo thứ tự mới nhất -> cũ nhất, đảo ngược để cũ nhất -> mới nhất
          const rawPeriods = [...chart.periods].reverse();

          const closes = [];
          const highs = [];
          const lows = [];
          const opens = [];
          const volumes = [];
          const buyVolumes = [];
          const sellVolumes = [];
          const deltas = [];
          const candles = [];

          const offset = CONFIG.priceOffset || 0;

          for (const p of rawPeriods) {
            const open = p.open + offset;
            const high = p.max + offset;
            const low = p.min + offset;
            const close = p.close + offset;
            const volume = p.volume || 0;
            const date = new Date(p.time * 1000);

            // Ước tính Order Flow Delta dựa trên Price Action khi không có taker volume trực tiếp từ TV
            const candleRange = high - low;
            const body = close - open;
            const estimatedDelta = candleRange > 0 ? volume * (body / candleRange) : 0;
            const buyVol = Math.max(0, (volume + estimatedDelta) / 2);
            const sellVol = Math.max(0, (volume - estimatedDelta) / 2);

            closes.push(close);
            highs.push(high);
            lows.push(low);
            opens.push(open);
            volumes.push(volume);
            buyVolumes.push(buyVol);
            sellVolumes.push(sellVol);
            deltas.push(estimatedDelta);

            candles.push({
              date,
              open,
              high,
              low,
              close,
              volume,
              buyVolume: buyVol,
              sellVolume: sellVol,
              delta: estimatedDelta,
            });
          }

          cleanup();
          resolve({
            closes,
            highs,
            lows,
            opens,
            volumes,
            buyVolumes,
            sellVolumes,
            deltas,
            candles,
            isRealtime: true,
            hasRealDelta: false, // Delta ước tính từ thân nến, không phải taker volume thật
            source: `TradingView (${tvSymbol})`,
          });
        }
      });

      chart.onError((...err) => {
        if (isFinished) return;
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Lỗi TradingView Chart: ${err.join(' ')}`));
      });
    } catch (err) {
      clearTimeout(timeout);
      cleanup();
      reject(err);
    }
  });
}

/**
 * Lấy dữ liệu nến thời gian thực từ Binance Spot kèm dữ liệu Order Flow Delta (Taker Buy vs Sell)
 * @param {string} binanceSymbol - Ví dụ: 'PAXGUSDT', 'ETHUSDT', 'BTCUSDT'
 * @param {string} interval - '15m', '1h', '4h', '1d'
 * @param {number} limit - Số lượng nến (mặc định 500 nến)
 */
async function fetchBinanceKlines(binanceSymbol = 'PAXGUSDT', interval = '15m', limit = 500) {
  let lastError = null;

  for (const endpoint of BINANCE_ENDPOINTS) {
    try {
      // 1. Lấy dữ liệu klines (nến)
      const klinesUrl = `${endpoint}/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
      const res = await axios.get(klinesUrl, { timeout: 6000 });
      const rawKlines = res.data || [];

      if (!Array.isArray(rawKlines) || rawKlines.length === 0) {
        throw new Error('Dữ liệu nến rỗng từ Binance');
      }

      // 2. Lấy giá tick trực tiếp realtime mới nhất
      let livePrice = null;
      try {
        const tickerRes = await axios.get(`${endpoint}/api/v3/ticker/price?symbol=${binanceSymbol}`, { timeout: 3000 });
        if (tickerRes.data && tickerRes.data.price) {
          livePrice = parseFloat(tickerRes.data.price);
        }
      } catch (tickerErr) {
        // Dùng giá đóng cửa nến cuối nếu lỗi ticker
      }

      const closes = [];
      const highs = [];
      const lows = [];
      const opens = [];
      const volumes = [];
      const buyVolumes = [];
      const sellVolumes = [];
      const deltas = [];
      const candles = [];

      rawKlines.forEach((k, index) => {
        const open = parseFloat(k[1]);
        let high = parseFloat(k[2]);
        let low = parseFloat(k[3]);
        let close = parseFloat(k[4]);
        const volume = parseFloat(k[5]);
        const buyVolume = parseFloat(k[9] || 0); // Taker buy base volume
        const sellVolume = Math.max(0, volume - buyVolume);
        const delta = buyVolume - sellVolume; // Order Flow Delta
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
        buyVolumes.push(buyVolume);
        sellVolumes.push(sellVolume);
        deltas.push(delta);

        candles.push({
          date,
          open,
          high,
          low,
          close,
          volume,
          buyVolume,
          sellVolume,
          delta,
        });
      });

      return {
        closes,
        highs,
        lows,
        opens,
        volumes,
        buyVolumes,
        sellVolumes,
        deltas,
        candles,
        isRealtime: true,
        hasRealDelta: true, // Delta từ Taker Buy/Sell Volume thật
        source: `Binance Spot (${binanceSymbol})`,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Không thể kết nối tới Binance Spot API (${binanceSymbol})`);
}

/**
 * Tương thích ngược: Lấy dữ liệu Vàng từ Binance PAXGUSDT
 */
async function fetchBinanceSpotGold(interval = '15m', limit = 500) {
  return fetchBinanceKlines('PAXGUSDT', interval, limit);
}

/**
 * Lấy dữ liệu nến từ Yahoo Finance
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

  return { closes, highs, lows, opens, volumes, candles, isRealtime: true, hasRealDelta: false, source: 'Gate.io Spot (PAXG/USDT)' };
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
  const buyVolumes = [];
  const sellVolumes = [];
  const deltas = [];
  const candles = [];

  quotes.forEach((q) => {
    if (q.close != null && q.high != null && q.low != null && q.open != null) {
      const vol = q.volume || 0;
      const range = q.high - q.low;
      const body = q.close - q.open;
      const delta = range > 0 ? vol * (body / range) : 0;
      const buyVol = Math.max(0, (vol + delta) / 2);
      const sellVol = Math.max(0, (vol - delta) / 2);

      closes.push(q.close);
      highs.push(q.high);
      lows.push(q.low);
      opens.push(q.open);
      volumes.push(vol);
      buyVolumes.push(buyVol);
      sellVolumes.push(sellVol);
      deltas.push(delta);

      candles.push({
        date: q.date,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: vol,
        buyVolume: buyVol,
        sellVolume: sellVol,
        delta,
      });
    }
  });

  return {
    closes,
    highs,
    lows,
    opens,
    volumes,
    buyVolumes,
    sellVolumes,
    deltas,
    candles,
    isRealtime: false,
    hasRealDelta: false,
    source: `Yahoo Finance (${symbol})`,
  };
}

/**
 * Hàm lấy nến tổng quát với thứ tự ưu tiên cấu hình & cơ chế Fallback tự động
 * 1. TradingView (OANDA:XAUUSD hoặc BINANCE:ETHUSDT)
 * 2. Binance Spot (PAXGUSDT hoặc ETHUSDT) - Có Order Flow Delta thật
 * 3. Yahoo Finance
 * Hàm lấy nến tổng quát đa nguồn hỗ trợ tự động Fallback (Binance -> Gate.io -> Yahoo)
 * @param {string} symbol - 'XAU/USD' | 'XAUUSD' | 'PAXGUSDT' (mặc định Spot Realtime) hoặc 'GC=F' (Futures)
 * @param {string} interval - '15m', '1h', v.v.
 * @param {number} daysBack - Số ngày lùi lại nếu dùng Yahoo
 */
async function fetchCandles(symbol = 'XAU/USD', interval = '15m', daysBack = 14) {
  const resolved = resolveSymbolSources(symbol);
  const cacheKey = `${resolved.rawSymbol}_${interval}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  // Cache trong 10 giây để tránh gọi lặp lại trong cùng 1 chu kỳ quét
  if (cached && (now - cached.timestamp < 10 * 1000)) {
    return cached.data;
  }

  const sourcePreference = (CONFIG.marketDataSource || 'TRADINGVIEW').toUpperCase();

  // Chiến lược 1: Ưu tiên TradingView Direct Datafeed
  if (sourcePreference === 'TRADINGVIEW') {
    try {
      const data = await fetchTradingViewCandles(resolved.tradingViewSymbol, interval, 500);
      data.symbol = resolved.rawSymbol;
      data.displayName = resolved.displayName;
      cache.set(cacheKey, { timestamp: now, data });
      return data;
    } catch (tvError) {
      console.warn(`⚠️ [MarketData] TradingView gặp sự cố (${tvError.message}). Đang chuyển sang nguồn Binance...`);
    }
  }

  // Chiến lược 2: Binance Spot (PAXGUSDT, ETHUSDT, BTCUSDT) - Dữ liệu Order Flow chuẩn
  try {
    const data = await fetchBinanceKlines(resolved.binanceSymbol, interval, 500);
    data.symbol = resolved.rawSymbol;
    data.displayName = resolved.displayName;
    cache.set(cacheKey, { timestamp: now, data });
    return data;
  } catch (binanceError) {
    console.warn(`⚠️ [MarketData] Binance Spot gặp sự cố (${binanceError.message}). Đang chuyển sang Yahoo Finance...`);
  }

  // Chiến lược 3: Yahoo Finance Fallback
  try {
    const data = await fetchYahooCandles(resolved.yahooSymbol, interval, daysBack);
    data.symbol = resolved.rawSymbol;
    data.displayName = resolved.displayName;
    cache.set(cacheKey, { timestamp: now, data });
    return data;
  } catch (fbErr) {
    console.error(`❌ [MarketData] Toàn bộ nguồn cấp nến cho ${symbol} đều thất bại.`);
    return null;
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
 * Đổi khung thời gian ('15m', '1h', '4h', '1d') sang mili-giây
 */
function timeframeToMs(tf = '15m') {
  const match = /^(\d+)([mhdw])$/i.exec(String(tf).trim());
  if (!match) return 15 * 60 * 1000;
  const unitMs = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[match[2].toLowerCase()];
  return parseInt(match[1], 10) * unitMs;
}

/**
 * Bỏ nến cuối nếu nến đó chưa đóng (thời điểm mở + khung thời gian > hiện tại)
 * để chiến lược không phân tích nến đang chạy (tránh tín hiệu bị vẽ lại / repaint)
 */
function getClosedCandles(data, interval = '15m', now = Date.now()) {
  const candles = data && data.candles;
  const last = candles && candles[candles.length - 1];
  if (!last || !last.date || new Date(last.date).getTime() + timeframeToMs(interval) <= now) {
    return data;
  }

  const trimmed = { ...data };
  for (const key of ['closes', 'highs', 'lows', 'opens', 'volumes', 'buyVolumes', 'sellVolumes', 'deltas', 'candles']) {
    if (Array.isArray(data[key])) trimmed[key] = data[key].slice(0, -1);
  }
  return trimmed;
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
  fetchTradingViewCandles,
  fetchBinanceKlines,
  fetchBinanceSpotGold,
  fetchYahooCandles,
  resolveSymbolSources,
  resolveTradingViewSymbol,
  timeframeToMs,
  getClosedCandles,
};

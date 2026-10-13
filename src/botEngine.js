const CONFIG = require('./config');
const { fetchCandles } = require('./services/marketData');
const { evaluateAllStrategies, strategies } = require('./strategies');
const { validateTradeSignal, generateMarketDigest } = require('./ai/geminiAnalyzer');
const { sendTradeAlert, sendMarketDigest } = require('./services/telegram');
const { EMA, RSI, ATR, ADX, StochasticRSI, VWAP, MFI } = require('technicalindicators');

/**
 * Vẽ thanh đo điểm số Confluence trực quan trên console (từ crypto-gold-detector)
 */
function renderScoreBar(score) {
  const totalBars = 10;
  const filledBars = Math.min(10, Math.max(0, Math.round((score / 100) * totalBars)));
  const emptyBars = totalBars - filledBars;
  const bar = '█'.repeat(filledBars) + '░'.repeat(emptyBars);
  const color = score >= 80 ? '\x1b[32m' : '\x1b[33m';
  return `${color}[${bar}] ${score}/100đ\x1b[0m`;
}

/**
 * Trích xuất snapshot thị trường để phục vụ thẩm định và báo cáo
 */
function createMarketSnapshot(marketData) {
  const { closes, highs, lows, volumes, candles } = marketData;
  const currentPrice = closes[closes.length - 1];

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  let adxVal = 0, pdiVal = 0, mdiVal = 0;
  try {
    const adxRes = ADX.calculate({ period: 14, high: highs, low: lows, close: closes }) || [];
    if (adxRes.length > 0) {
      adxVal = adxRes[adxRes.length - 1].adx;
      pdiVal = adxRes[adxRes.length - 1].pdi;
      mdiVal = adxRes[adxRes.length - 1].mdi;
    }
  } catch (e) {}

  let stochK = null, stochD = null;
  try {
    const stochRes = StochasticRSI.calculate({
      values: closes,
      rsiPeriod: 14,
      stochasticPeriod: 14,
      kPeriod: 3,
      dPeriod: 3,
    }) || [];
    if (stochRes.length > 0) {
      stochK = stochRes[stochRes.length - 1].k;
      stochD = stochRes[stochRes.length - 1].d;
    }
  } catch (e) {}

  let vwapVal = null;
  let mfiVal = 50;
  const hasValidVolume = volumes && volumes.some((v) => v > 0);
  if (hasValidVolume) {
    try {
      const vwapRes = VWAP.calculate({ high: highs, low: lows, close: closes, volume: volumes }) || [];
      if (vwapRes.length > 0 && !isNaN(vwapRes[vwapRes.length - 1])) {
        vwapVal = vwapRes[vwapRes.length - 1];
      }
      const mfiRes = MFI.calculate({ high: highs, low: lows, close: closes, volume: volumes, period: 14 }) || [];
      if (mfiRes.length > 0) mfiVal = mfiRes[mfiRes.length - 1];
    } catch (e) {}
  }

  const lookback = 20;
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);

  const lastCandle = candles && candles.length > 0 ? candles[candles.length - 1] : null;

  return {
    symbol: marketData.symbol || CONFIG.symbol,
    displayName: marketData.displayName || marketData.symbol || CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    currentPrice,
    ema20: ema20[ema20.length - 1],
    ema50: ema50[ema50.length - 1],
    ema200: ema200[ema200.length - 1],
    rsi: rsi[rsi.length - 1],
    atr: atr[atr.length - 1],
    adx: adxVal,
    pdi: pdiVal,
    mdi: mdiVal,
    stochK,
    stochD,
    vwap: vwapVal,
    mfi: mfiVal,
    delta: lastCandle ? (lastCandle.delta || 0) : 0,
    recentHigh: Math.max(...recentHighs),
    recentLow: Math.min(...recentLows),
    recentCandles: candles.slice(-5).map((c) => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  };
}

/**
 * Quét một tài sản đơn lẻ (Ví dụ: XAU/USD, ETH/USDT, BTC/USDT)
 */
async function scanSingleSymbol(symbol) {
  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`\n[${timestamp}] 🔍 Đang quét thị trường: ${symbol} (${CONFIG.timeframe})...`);

  const marketData = await fetchCandles(symbol, CONFIG.timeframe, 14);
  if (!marketData || marketData.closes.length < 50) {
    console.log(`⚠️ [${symbol}] Chưa gom đủ dữ liệu nến.`);
    return;
  }

  const snapshot = createMarketSnapshot(marketData);
  const prevPrice = marketData.closes[marketData.closes.length - 2];
  const diff = snapshot.currentPrice - prevPrice;
  const changeText = diff >= 0 ? `+${diff.toFixed(2)}` : `${diff.toFixed(2)}`;

  const adxText = snapshot.adx ? ` | ADX: ${snapshot.adx.toFixed(1)} (${snapshot.adx >= 22 ? 'Trend' : 'Sideway'})` : '';
  const stochText = snapshot.stochK != null ? ` | StochRSI: ${snapshot.stochK.toFixed(0)}` : '';
  const vwapText = snapshot.vwap ? ` | VWAP: $${snapshot.vwap.toFixed(1)}` : '';
  const deltaText = snapshot.delta !== 0 ? ` | Delta: ${snapshot.delta > 0 ? '+' : ''}${snapshot.delta.toFixed(1)}` : '';

  console.log(`💵 [${snapshot.displayName}]: $${snapshot.currentPrice.toFixed(2)} (${changeText}) | EMA20: ${snapshot.ema20?.toFixed(2) || 'N/A'} | RSI: ${snapshot.rsi?.toFixed(1) || 'N/A'}${adxText}${stochText}${vwapText}${deltaText} | ATR: ${snapshot.atr?.toFixed(2) || 'N/A'}`);

  // 1. Chạy tất cả các chiến lược kỹ thuật
  const candidateSignals = evaluateAllStrategies(marketData);

  if (candidateSignals.length === 0) {
    console.log(`ℹ️ [Trạng thái - ${snapshot.displayName}]: Đã quét ${strategies.length} chiến lược -> Chưa có tín hiệu vào lệnh.`);
    return;
  }

  console.log(`⚡ [${snapshot.displayName}] Phát hiện ${candidateSignals.length} tín hiệu kỹ thuật tiềm năng tại giá $${snapshot.currentPrice.toFixed(2)}! Bắt đầu chấm điểm & thẩm định...`);

  // 2. Chấm điểm trọng số và Thẩm định tín hiệu qua AI
  for (const signal of candidateSignals) {
    signal.symbol = symbol;
    signal.displayName = snapshot.displayName;

    const scoreDisplay = signal.score != null ? ` | Confluence: ${renderScoreBar(signal.score)}` : '';
    const gradeBadge = signal.rankBadge || signal.grade || signal.rank || '';
    console.log(`\n👉 [${snapshot.displayName}] [${signal.strategy}] - ${signal.action} tại $${signal.entry.toFixed(2)}${scoreDisplay}  ${gradeBadge}`);

    if (signal.breakdown && signal.breakdown.length > 0) {
      console.log(`   🔍 Yếu tố hội tụ tạo nên tỉ lệ thắng cao:`);
      signal.breakdown.forEach((f) => console.log(`      \x1b[32m✓\x1b[0m \x1b[2m${f}\x1b[0m`));
    }

    // Lọc theo ngưỡng điểm tối thiểu (mặc định 65 cho Order Flow, 70 cho chiến lược chung)
    const minThreshold = signal.strategy.includes('Order Flow')
      ? CONFIG.minConfluenceScore
      : CONFIG.minStrategyScore;

    if (signal.score != null && signal.score < minThreshold) {
      console.log(`✋ Tín hiệu bị loại bỏ do điểm chất lượng (${signal.score}/100) thấp hơn ngưỡng tối thiểu (${minThreshold}).`);
      continue;
    }

    let aiReview = null;
    let shouldSend = true;

    if (CONFIG.aiFilterEnabled) {
      aiReview = await validateTradeSignal(signal, snapshot);
      const keyInfo = aiReview.keyUsed ? ` (${aiReview.keyUsed} | ${aiReview.modelUsed})` : '';
      console.log(`🤖 Kết quả AI [${aiReview.mode}${keyInfo}]: Điểm tin cậy: ${aiReview.confidence}% | Duyệt: ${aiReview.approved ? '✅ ĐỒNG THUẬN' : '❌ TỪ CHỐI'}`);
      console.log(`💬 Lý do AI: ${aiReview.reasoning}`);

      if (!aiReview.approved) {
        shouldSend = false;
        console.log(`✋ Tín hiệu bị loại bỏ do không đạt chuẩn độ tin cậy AI tối thiểu (${CONFIG.aiMinConfidence}%).`);
      }
    }

    if (shouldSend) {
      signal.aiReview = aiReview;
      await sendTradeAlert(signal);
      console.log(`🚀 ĐÃ PHÁT TÍN HIỆU THÀNH CÔNG: [${snapshot.displayName}] ${signal.action} $${signal.entry.toFixed(2)} [Điểm: ${signal.score || 'N/A'}] qua Telegram!\n`);
    }
  }
}

/**
 * Quét toàn bộ danh mục tài sản đã cấu hình
 */
async function scanMarket(targetSymbol = null) {
  const symbolsToScan = targetSymbol ? [targetSymbol] : (CONFIG.symbols || [CONFIG.symbol]);
  for (const sym of symbolsToScan) {
    try {
      await scanSingleSymbol(sym);
    } catch (err) {
      console.error(`❌ [ScanMarket] Lỗi khi quét ${sym}:`, err.message);
    }
  }
}

/**
 * Bản tin tổng hợp thị trường định kỳ cho từng tài sản
 */
async function runMarketBriefing(targetSymbol = null) {
  const symbolsToBrief = targetSymbol ? [targetSymbol] : (CONFIG.symbols || [CONFIG.symbol]);
  for (const sym of symbolsToBrief) {
    try {
      console.log(`\n📊 Đang tạo bản tin thị trường định kỳ bằng AI cho ${sym}...`);
      const marketData = await fetchCandles(sym, CONFIG.timeframe, 14);
      if (!marketData || marketData.closes.length < 50) continue;

      const snapshot = createMarketSnapshot(marketData);
      const digest = await generateMarketDigest(snapshot);

      if (digest) {
        digest.symbol = sym;
        digest.displayName = snapshot.displayName || sym;
        await sendMarketDigest(digest);
        console.log(`✅ Đã gửi bản tin thị trường định kỳ (${sym}) qua Telegram.`);
      }
    } catch (err) {
      console.error(`❌ [Briefing] Lỗi khi tạo bản tin ${sym}:`, err.message);
    }
  }
}

module.exports = {
  scanMarket,
  scanSingleSymbol,
  runMarketBriefing,
  renderScoreBar,
};

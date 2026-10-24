const CONFIG = require('./config');
const { fetchCandles, getClosedCandles, timeframeToMs } = require('./services/marketData');
const { evaluateAllStrategies, strategies, getStrategyPlan } = require('./strategies');
const { getMinScore, SignalCooldown } = require('./signalFilter');
const { validateTradeSignal, generateMarketDigest } = require('./ai/geminiAnalyzer');
const { sendTradeAlert, sendMarketDigest } = require('./services/telegram');
const signalTracker = require('./services/signalTracker');
const { getNewsBlackout, describeEvent } = require('./services/newsCalendar');

// Kế hoạch chạy: khung thời gian -> các chiến lược (cấu hình STRATEGIES)
const strategyPlan = getStrategyPlan();

// Thời điểm mở của nến đã đóng gần nhất đã được phân tích, theo từng tài sản + khung thời gian
const lastAnalyzedCandle = new Map();

// Cooldown theo khung thời gian: tín hiệu đã gửi, và riêng cho việc ghi nhận tín hiệu bị AI từ chối
// (để một setup kéo dài không bị ghi lặp ở mọi nến)
const cooldowns = new Map();
function cooldownsFor(timeframe) {
  if (!cooldowns.has(timeframe)) {
    const windowMs = timeframeToMs(timeframe);
    cooldowns.set(timeframe, {
      sent: new SignalCooldown(CONFIG.signalCooldownBars, windowMs),
      rejected: new SignalCooldown(CONFIG.signalCooldownBars, windowMs),
    });
  }
  return cooldowns.get(timeframe);
}

// Khôi phục cooldown từ các tín hiệu đã lưu để khởi động lại bot không phát lại tín hiệu của nến cũ
try {
  for (const rec of signalTracker.listSignals()) {
    const cd = cooldownsFor(rec.timeframe || CONFIG.timeframe);
    (rec.sent ? cd.sent : cd.rejected).record(rec.symbol, rec.action, Date.parse(rec.candleTime));
  }
} catch (err) {
  console.error('❌ [SignalTracker] Không khôi phục được cooldown từ dữ liệu đã lưu:', err.message);
}

/**
 * Chạy một tác vụ phụ (thống kê tín hiệu, lịch tin) mà không để lỗi của nó chặn việc quét và phát tín hiệu
 */
function runSafely(label, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    console.error(`❌ [${label}] ${err.message}`);
    return fallback;
  }
}

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
 * Dùng lại bộ chỉ báo đã tính cho các chiến lược (cache theo marketData) để AI thấy đúng số liệu chiến lược đã dùng
 */
function createMarketSnapshot(marketData, timeframe = CONFIG.timeframe) {
  const { highs, lows, candles } = marketData;
  const ind = strategies[0].calculateIndicators(marketData);

  const lookback = 20;
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);

  return {
    symbol: marketData.symbol || CONFIG.symbol,
    displayName: marketData.displayName || marketData.symbol || CONFIG.symbol,
    timeframe,
    currentPrice: ind.currentPrice,
    ema20: ind.ema20,
    ema50: ind.ema50,
    ema200: ind.ema200,
    rsi: ind.rsi,
    atr: ind.atr,
    adx: ind.adx,
    pdi: ind.pdi,
    mdi: ind.mdi,
    stochK: ind.stochRsi ? ind.stochRsi.k : null,
    stochD: ind.stochRsi ? ind.stochRsi.d : null,
    vwap: ind.vwap,
    mfi: ind.mfi,
    delta: ind.delta,
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
 * Quét một tài sản trên một khung thời gian với các chiến lược được cấu hình cho khung đó
 * @param {string} symbol - Ví dụ: XAU/USD, ETH/USDT
 * @param {string} [timeframe] - Khung nến, mặc định TIMEFRAME
 * @param {Array<object>} [strategyList] - Chiến lược chạy trên khung này, mặc định theo cấu hình STRATEGIES
 */
async function scanSingleSymbol(symbol, timeframe = CONFIG.timeframe, strategyList = strategyPlan.get(timeframe) || []) {
  if (strategyList.length === 0) return;
  const stateKey = `${symbol}|${timeframe}`;
  const timeframeMs = timeframeToMs(timeframe);

  // Nến kế tiếp của khung này chưa thể đóng thì không cần tải lại dữ liệu (vd: khung 4h không tải mỗi 5 phút)
  const lastAnalyzed = lastAnalyzedCandle.get(stateKey);
  if (lastAnalyzed != null && Date.now() < lastAnalyzed + 2 * timeframeMs) return;

  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`\n[${timestamp}] 🔍 Đang quét thị trường: ${symbol} (${timeframe})...`);

  const rawData = await fetchCandles(symbol, timeframe, 14);
  // Chỉ phân tích nến đã đóng để tín hiệu không bị vẽ lại (repaint) khi nến đang chạy thay đổi
  const marketData = rawData && getClosedCandles(rawData, timeframe);
  if (!marketData || marketData.closes.length < 50) {
    console.log(`⚠️ [${symbol} ${timeframe}] Chưa gom đủ dữ liệu nến.`);
    return;
  }

  // Cập nhật kết quả TP1/SL của các tín hiệu đã phát trước đó trên khung này theo các nến mới đóng
  runSafely('SignalTracker', () => signalTracker.updateOpenSignals(symbol, marketData.candles, {
    source: marketData.source,
    isFallback: marketData.isFallback,
    timeframe,
  }));

  // Mỗi nến đã đóng chỉ phân tích một lần (cron chạy dày hơn khung nến; cuối tuần thị trường Vàng đóng cửa)
  const lastClosed = marketData.candles[marketData.candles.length - 1];
  const candleTime = new Date(lastClosed.date).getTime();
  const candleLabel = new Date(candleTime).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  // So sánh <= để một nguồn dự phòng trả dữ liệu trễ không làm phân tích lại nến cũ
  if (lastAnalyzed != null && candleTime <= lastAnalyzed) {
    console.log(`ℹ️ [${symbol} ${timeframe}] Nến ${candleLabel} đã được phân tích, chờ nến mới đóng.`);
    return;
  }
  // Nến đã đóng quá một khung thời gian (thị trường đóng cửa cuối tuần, dữ liệu trễ, bot vừa khởi động lại):
  // không phát tín hiệu theo giá cũ
  if (Date.now() - (candleTime + timeframeMs) > timeframeMs) {
    console.log(`ℹ️ [${symbol} ${timeframe}] Nến gần nhất (${candleLabel}) đã đóng quá lâu (thị trường đóng cửa hoặc dữ liệu trễ), bỏ qua.`);
    return;
  }
  lastAnalyzedCandle.set(stateKey, candleTime);
  const { sent: signalCooldown, rejected: rejectedCooldown } = cooldownsFor(timeframe);

  const snapshot = createMarketSnapshot(marketData, timeframe);
  const prevPrice = marketData.closes[marketData.closes.length - 2];
  const diff = snapshot.currentPrice - prevPrice;
  const changeText = diff >= 0 ? `+${diff.toFixed(2)}` : `${diff.toFixed(2)}`;

  const adxText = snapshot.adx ? ` | ADX: ${snapshot.adx.toFixed(1)} (${snapshot.adx >= 22 ? 'Trend' : 'Sideway'})` : '';
  const stochText = snapshot.stochK != null ? ` | StochRSI: ${snapshot.stochK.toFixed(0)}` : '';
  const vwapText = snapshot.vwap ? ` | VWAP: $${snapshot.vwap.toFixed(1)}` : '';
  const deltaText = snapshot.delta !== 0 ? ` | Delta: ${snapshot.delta > 0 ? '+' : ''}${snapshot.delta.toFixed(1)}` : '';

  console.log(`💵 [${snapshot.displayName} ${timeframe}]: $${snapshot.currentPrice.toFixed(2)} (${changeText}) | EMA20: ${snapshot.ema20?.toFixed(2) || 'N/A'} | RSI: ${snapshot.rsi?.toFixed(1) || 'N/A'}${adxText}${stochText}${vwapText}${deltaText} | ATR: ${snapshot.atr?.toFixed(2) || 'N/A'}`);

  // 1. Chạy các chiến lược được cấu hình cho khung thời gian này
  const candidateSignals = evaluateAllStrategies(marketData, { strategies: strategyList });

  if (candidateSignals.length === 0) {
    console.log(`ℹ️ [Trạng thái - ${snapshot.displayName} ${timeframe}]: Đã quét ${strategyList.length} chiến lược -> Chưa có tín hiệu vào lệnh.`);
    return;
  }

  // Không phát tín hiệu trong khung ±N phút quanh giờ ra tin tác động mạnh (giá giật mạnh, giãn spread)
  // Không đọc được lịch tin thì không chặn (đã ghi log lỗi), để lỗi phụ không làm mất tín hiệu
  const newsEvents = runSafely('News', () => getNewsBlackout(Date.now(), candleTime), []);
  if (newsEvents.length > 0) {
    console.log(`⛔ [${snapshot.displayName}] Bỏ qua ${candidateSignals.length} tín hiệu: đang trong khung ±${CONFIG.newsBlackoutMinutes} phút quanh tin ${newsEvents.map(describeEvent).join(', ')}.`);
    return;
  }

  console.log(`⚡ [${snapshot.displayName}] Phát hiện ${candidateSignals.length} tín hiệu kỹ thuật tiềm năng tại giá $${snapshot.currentPrice.toFixed(2)}! Bắt đầu chấm điểm & thẩm định...`);

  // 2. Chấm điểm trọng số và Thẩm định tín hiệu qua AI
  for (const signal of candidateSignals) {
    signal.symbol = symbol;
    signal.displayName = snapshot.displayName;
    signal.timeframe = timeframe;

    const scoreDisplay = signal.score != null ? ` | Confluence: ${renderScoreBar(signal.score)}` : '';
    const gradeBadge = signal.rankBadge || signal.grade || signal.rank || '';
    console.log(`\n👉 [${snapshot.displayName}] [${signal.strategy}] - ${signal.action} tại $${signal.entry.toFixed(2)}${scoreDisplay}  ${gradeBadge}`);

    if (signal.breakdown && signal.breakdown.length > 0) {
      console.log(`   🔍 Yếu tố hội tụ tạo nên tỉ lệ thắng cao:`);
      signal.breakdown.forEach((f) => console.log(`      \x1b[32m✓\x1b[0m \x1b[2m${f}\x1b[0m`));
    }

    // Lọc theo ngưỡng điểm tối thiểu (mặc định 65 cho Order Flow, 70 cho chiến lược chung)
    const minThreshold = getMinScore(signal);

    if (signal.score != null && signal.score < minThreshold) {
      console.log(`✋ Tín hiệu bị loại bỏ do điểm chất lượng (${signal.score}/100) thấp hơn ngưỡng tối thiểu (${minThreshold}).`);
      continue;
    }

    if (signalCooldown.isCoolingDown(symbol, signal.action, candleTime)) {
      console.log(`⏳ Bỏ qua: đã phát tín hiệu ${signal.action} cho ${snapshot.displayName} (${timeframe}) trong ${CONFIG.signalCooldownBars} nến gần đây.`);
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

    signal.aiReview = aiReview;
    let delivered = false;
    if (shouldSend) {
      delivered = await sendTradeAlert(signal);
      signalCooldown.record(symbol, signal.action, candleTime);
      console.log(`🚀 ĐÃ PHÁT TÍN HIỆU THÀNH CÔNG: [${snapshot.displayName}] ${signal.action} $${signal.entry.toFixed(2)} [Điểm: ${signal.score || 'N/A'}] qua Telegram!\n`);
    }

    // Ghi nhận cả tín hiệu bị AI từ chối để dashboard so sánh được hiệu quả của bộ lọc AI
    if (shouldSend || !rejectedCooldown.isCoolingDown(symbol, signal.action, candleTime)) {
      if (!shouldSend) rejectedCooldown.record(symbol, signal.action, candleTime);
      runSafely('SignalTracker', () => signalTracker.recordSignal(signal, { candleTime, sent: shouldSend, delivered, source: marketData.source }));
    }
  }
}

/**
 * Quét toàn bộ danh mục tài sản đã cấu hình, trên mọi khung thời gian có chiến lược
 */
async function scanMarket(targetSymbol = null) {
  const symbolsToScan = targetSymbol ? [targetSymbol] : (CONFIG.symbols || [CONFIG.symbol]);
  for (const sym of symbolsToScan) {
    for (const [timeframe, strategyList] of strategyPlan) {
      try {
        await scanSingleSymbol(sym, timeframe, strategyList);
      } catch (err) {
        console.error(`❌ [ScanMarket] Lỗi khi quét ${sym} (${timeframe}):`, err.message);
      }
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
      const rawData = await fetchCandles(sym, CONFIG.timeframe, 14);
      const marketData = rawData && getClosedCandles(rawData, CONFIG.timeframe);
      if (!marketData || marketData.closes.length < 50) continue;

      const snapshot = createMarketSnapshot(marketData, CONFIG.timeframe);
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
  strategyPlan,
  scanMarket,
  scanSingleSymbol,
  runMarketBriefing,
  renderScoreBar,
};

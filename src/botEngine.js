const CONFIG = require('./config');
const { fetchCandles } = require('./services/marketData');
const { evaluateAllStrategies } = require('./strategies');
const { validateTradeSignal, generateMarketDigest } = require('./ai/geminiAnalyzer');
const { sendTradeAlert, sendMarketDigest } = require('./services/telegram');
const { EMA, RSI, ATR } = require('technicalindicators');

/**
 * Trích xuất snapshot thị trường để phục vụ thẩm định và báo cáo
 */
function createMarketSnapshot(marketData) {
  const { closes, highs, lows, candles } = marketData;
  const currentPrice = closes[closes.length - 1];

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  const lookback = 20;
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);

  return {
    timeframe: CONFIG.timeframe,
    currentPrice,
    ema20: ema20[ema20.length - 1],
    ema50: ema50[ema50.length - 1],
    ema200: ema200[ema200.length - 1],
    rsi: rsi[rsi.length - 1],
    atr: atr[atr.length - 1],
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
 * Quét thị trường, chạy các chiến lược và kiểm định bằng AI
 */
async function scanMarket() {
  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  console.log(`[${timestamp}] 🔍 Đang quét thị trường Vàng (${CONFIG.symbol} - ${CONFIG.timeframe})...`);

  const marketData = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 14);
  if (!marketData || marketData.closes.length < 200) {
    console.log('⚠️ Chưa gom đủ dữ liệu nến (cần tối thiểu 200 nến để tính EMA200).');
    return;
  }

  const snapshot = createMarketSnapshot(marketData);
  const prevPrice = marketData.closes[marketData.closes.length - 2];
  const diff = snapshot.currentPrice - prevPrice;
  const changeText = diff >= 0 ? `+${diff.toFixed(2)}` : `${diff.toFixed(2)}`;

  console.log(`💵 [GIÁ HIỆN TẠI]: $${snapshot.currentPrice.toFixed(2)} (${changeText}) | EMA20: ${snapshot.ema20.toFixed(2)} | EMA200: ${snapshot.ema200.toFixed(2)} | RSI: ${snapshot.rsi.toFixed(1)} | ATR: ${snapshot.atr.toFixed(2)}`);

  // 1. Chạy tất cả các chiến lược kỹ thuật
  const candidateSignals = evaluateAllStrategies(marketData);

  if (candidateSignals.length === 0) {
    console.log(`ℹ️ [Trạng thái]: Đã quét 4 chiến lược -> Chưa có tín hiệu vào lệnh.`);
    return;
  }

  console.log(`⚡ Phát hiện ${candidateSignals.length} tín hiệu kỹ thuật tiềm năng tại giá $${snapshot.currentPrice.toFixed(2)}! Bắt đầu quy trình thẩm định...`);

  // 2. Thẩm định tín hiệu qua AI
  for (const signal of candidateSignals) {
    console.log(`\n👉 Đang phân tích tín hiệu: [${signal.strategy}] - ${signal.action} tại $${signal.entry.toFixed(2)}`);

    let aiReview = null;
    let shouldSend = true;

    if (CONFIG.aiFilterEnabled) {
      aiReview = await validateTradeSignal(signal, snapshot);
      console.log(`🤖 Kết quả AI [${aiReview.mode}]: Điểm tin cậy: ${aiReview.confidence}% | Duyệt: ${aiReview.approved ? '✅ ĐỒNG THUẬN' : '❌ TỪ CHỐI'}`);
      console.log(`💬 Lý do AI: ${aiReview.reasoning}`);

      if (!aiReview.approved) {
        shouldSend = false;
        console.log(`✋ Tín hiệu bị loại bỏ do không đạt chuẩn độ tin cậy tối thiểu (${CONFIG.aiMinConfidence}%).`);
      }
    }

    if (shouldSend) {
      signal.aiReview = aiReview;
      await sendTradeAlert(signal);
      console.log(`🚀 ĐÃ PHÁT TÍN HIỆU THÀNH CÔNG: ${signal.action} $${signal.entry.toFixed(2)} qua Telegram!\n`);
    }
  }
}

/**
 * Bản tin tổng hợp thị trường định kỳ
 */
async function runMarketBriefing() {
  console.log('\n📊 Đang tạo bản tin thị trường định kỳ bằng AI...');
  const marketData = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 14);
  if (!marketData || marketData.closes.length < 50) return;

  const snapshot = createMarketSnapshot(marketData);
  const digest = await generateMarketDigest(snapshot);

  if (digest) {
    await sendMarketDigest(digest);
    console.log('✅ Đã gửi bản tin thị trường định kỳ qua Telegram.');
  }
}

module.exports = {
  scanMarket,
  runMarketBriefing,
};

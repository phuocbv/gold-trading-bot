const axios = require('axios');
const https = require('https');
const CONFIG = require('../config');

// HTTPS Agent cưỡng chế IPv4 (family: 4) để tránh lỗi ETIMEDOUT do ISP Việt Nam bị treo/chặn IPv6 Telegram
const httpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
});

/**
 * Gửi tin nhắn raw qua Telegram Bot API (có tự động retry và fallback)
 */
async function sendRawMessage(text, maxRetries = 3) {
  if (!CONFIG.telegramToken || CONFIG.telegramToken.includes('YOUR_TELEGRAM')) {
    console.log(`\n📢 [TELEGRAM PREVIEW - Chưa điền Telegram Token trong .env]\n${text}\n`);
    return false;
  }

  const apiBase = (CONFIG.telegramApiBase || 'https://api.telegram.org').replace(/\/+$/, '');
  const url = `${apiBase}/bot${CONFIG.telegramToken}/sendMessage`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await axios.post(
        url,
        {
          chat_id: CONFIG.telegramChatId,
          text: text,
          parse_mode: 'Markdown',
        },
        {
          httpsAgent,
          timeout: 12000,
        }
      );
      return true;
    } catch (error) {
      const errorData = error.response?.data;
      const desc = errorData?.description || error.message;

      // Nếu lỗi định dạng Markdown của Telegram, thử gửi lại dạng plain text
      if (desc && desc.toLowerCase().includes("can't parse entities")) {
        try {
          await axios.post(
            url,
            {
              chat_id: CONFIG.telegramChatId,
              text: text,
            },
            {
              httpsAgent,
              timeout: 12000,
            }
          );
          return true;
        } catch (fallbackErr) {
          console.error('❌ [Telegram] Lỗi gửi tin nhắn (plain text fallback):', fallbackErr.message);
        }
      }

      if (attempt < maxRetries) {
        console.warn(`⚠️ [Telegram] Lần gửi ${attempt}/${maxRetries} thất bại (${desc}), đang thử lại sau 2 giây...`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.error('❌ [Telegram] Lỗi gửi tin nhắn sau', maxRetries, 'lần thử:', errorData || error.message);
        return false;
      }
    }
  }
  return false;
}

/**
 * Định dạng và gửi tín hiệu giao dịch hoàn chỉnh
 * @param {object} signal
 * {
 *   strategy: string,
 *   action: 'BUY' | 'SELL',
 *   entry: number,
 *   stopLoss: number,
 *   takeProfit: number,
 *   takeProfit2?: number,
 *   rrRatio: string,
 *   indicators: { rsi, atr, currentPrice, ema20, ema50, ema200, ... },
 *   aiReview?: { confidence, reasoning, trend, support, resistance }
 * }
 */
async function sendTradeAlert(signal) {
  const isBuy = signal.action.toUpperCase() === 'BUY';
  const icon = isBuy ? '🟢 MUA (BUY)' : '🔴 BÁN (SELL)';
  const headerIcon = isBuy ? '🚀' : '🔻';

  let msg = `${headerIcon} *TÍN HIỆU GIAO DỊCH VÀNG (${CONFIG.symbol})* ${headerIcon}\n\n`;
  msg += `📌 *Chiến Lược:* \`${signal.strategy}\`\n`;
  msg += `👉 *Hành Động:* *${icon}*\n`;
  msg += `⏱ *Khung Giờ:* \`${CONFIG.timeframe}\`\n`;

  if (signal.score != null) {
    msg += `🏆 *Đánh Giá:* \`${signal.score}/100\` — *${signal.rankBadge || signal.rank}*\n`;
    if (signal.alliedStrategies && signal.alliedStrategies.length > 1) {
      msg += `🤝 *Hợp Lưu Đồng Thuận:* \`${signal.alliedStrategies.join(' + ')}\`\n`;
    }
  }
  msg += `\n`;

  msg += `🎯 *THÔNG SỐ VÀO LỆNH:*\n`;
  msg += `• *Entry:* \`$${signal.entry.toFixed(2)}\`\n`;
  msg += `• *Stop Loss (SL):* \`$${signal.stopLoss.toFixed(2)}\`\n`;
  msg += `• *Take Profit 1 (TP1):* \`$${signal.takeProfit.toFixed(2)}\`\n`;
  if (signal.takeProfit2) {
    msg += `• *Take Profit 2 (TP2):* \`$${signal.takeProfit2.toFixed(2)}\`\n`;
  }
  msg += `• *Tỉ lệ R:R:* \`${signal.rrRatio || '1 : 2'}\`\n\n`;

  msg += `📊 *CHỈ SỐ KỸ THUẬT:*\n`;
  if (signal.indicators.rsi != null) msg += `• RSI(14): \`${signal.indicators.rsi.toFixed(1)}\`\n`;
  if (signal.indicators.adx != null && signal.indicators.adx > 0) {
    msg += `• ADX(14): \`${signal.indicators.adx.toFixed(1)}\` (${signal.indicators.adx >= 22 ? 'Xu hướng mạnh' : 'Sideway'})\n`;
  }
  if (signal.indicators.stochRsiK != null) msg += `• StochRSI (%K): \`${signal.indicators.stochRsiK.toFixed(1)}\`\n`;
  if (signal.indicators.vwap != null) msg += `• VWAP: \`$${signal.indicators.vwap.toFixed(2)}\`\n`;
  if (signal.indicators.mfi != null) msg += `• MFI(14): \`${signal.indicators.mfi.toFixed(1)}\`\n`;
  if (signal.indicators.volumeRatio && signal.indicators.volumeRatio !== 'N/A') {
    msg += `• Đột biến Volume: \`${signal.indicators.volumeRatio}\`\n`;
  }
  if (signal.indicators.divergenceDetail) {
    msg += `• Phân kỳ: _${signal.indicators.divergenceDetail}_\n`;
  }
  if (signal.indicators.candlePattern || signal.indicators.pattern) {
    msg += `• Nến xác nhận: \`${signal.indicators.candlePattern || signal.indicators.pattern}\`\n`;
  }
  if (signal.indicators.fvgZone) {
    msg += `• Vùng FVG: \`${signal.indicators.fvgZone}\`\n`;
  }
  if (signal.indicators.atr != null) msg += `• ATR(14): \`${signal.indicators.atr.toFixed(2)}\`\n`;
  if (signal.indicators.ema20 != null) msg += `• EMA20: \`${signal.indicators.ema20.toFixed(2)}\`\n`;
  if (signal.indicators.ema200 != null) msg += `• EMA200: \`${signal.indicators.ema200.toFixed(2)}\`\n`;

  if (signal.aiReview) {
    msg += `\n🤖 *HỘI ĐỒNG AI THẨM ĐỊNH (Gemini):*\n`;
    msg += `• *Độ tin cậy:* \`${signal.aiReview.confidence}%\`\n`;
    msg += `• *Cấu trúc thị trường:* \`${signal.aiReview.trend || 'N/A'}\`\n`;
    if (signal.aiReview.support && signal.aiReview.resistance) {
      msg += `• *Vùng Hỗ trợ / Cản:* \`$${signal.aiReview.support} - $${signal.aiReview.resistance}\`\n`;
    }
    msg += `• *Nhận định AI:* _${signal.aiReview.reasoning}_\n`;
  } else {
    msg += `\n⚙️ *Chế độ:* Phân tích Kỹ thuật Thuần (Rule-based)\n`;
  }

  msg += `\n⚠️ _Lưu ý: Luôn tuân thủ kỷ luật quản lý vốn tối đa 1-2% tài khoản cho mỗi lệnh._`;

  return await sendRawMessage(msg);
}

/**
 * Gửi bản tin thị trường định kỳ do AI tổng hợp
 */
async function sendMarketDigest(digest) {
  let msg = `📋 *BẢN TIN THỊ TRƯỜNG VÀNG ĐỊNH KỲ (AI BRIEFING)* 📋\n\n`;
  msg += `🕒 *Thời gian:* ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n`;
  msg += `💰 *Giá hiện tại:* \`$${digest.currentPrice.toFixed(2)}\`\n\n`;
  msg += `📈 *Xu hướng chính:* \`${digest.trend}\`\n`;
  msg += `🛡 *Hỗ trợ gần nhất:* \`$${digest.support}\`\n`;
  msg += `🎯 *Kháng cự gần nhất:* \`$${digest.resistance}\`\n\n`;
  msg += `💡 *Nhận định & Kịch bản phiên:* \n${digest.summary}\n`;

  return await sendRawMessage(msg);
}

/**
 * Gửi thông báo mở vị thế Scalping 1 Phút (Mục tiêu 1 giá)
 */
async function sendScalpOpenAlert(position) {
  const isBuy = position.action.toUpperCase() === 'BUY';
  const icon = isBuy ? '🟢 MUA (BUY)' : '🔴 BÁN (SELL)';
  const headerIcon = isBuy ? '🚀' : '🔻';

  let msg = `${headerIcon} *[SCALP 1M] MỞ VỊ THẾ GIAO DỊCH* ${headerIcon}\n\n`;
  msg += `👉 *Hành Động:* *${icon}*\n`;
  msg += `📌 *Chiến Lược:* \`${position.setupType || position.strategy}\`\n`;
  msg += `⏱ *Khung Giờ:* \`1 Phút (1m)\`\n`;
  if (position.score != null) {
    msg += `🏆 *Đánh Giá:* \`${position.score}/100\` — *${position.rankBadge || position.rank}*\n`;
  }
  msg += `\n`;

  msg += `🎯 *THÔNG SỐ VỊ THẾ:*\n`;
  msg += `• *Giá Vào (Entry):* \`$${position.entryPrice.toFixed(2)}\`\n`;
  msg += `• *Chốt Lời (TP):* \`$${position.takeProfit.toFixed(2)}\` (🎯 Đúng +${position.takeProfitPoints.toFixed(2)} giá)\n`;
  msg += `• *Cắt Lỗ (SL):* \`$${position.stopLoss.toFixed(2)}\` (🛡 -${position.stopLossPoints.toFixed(2)} giá cấu hình)\n\n`;

  if (position.indicators) {
    msg += `📊 *TÍN HIỆU VI MÔ (1M):*\n`;
    if (position.indicators.ema9 && position.indicators.ema21) {
      msg += `• EMA 9/21: \`$${position.indicators.ema9.toFixed(2)} / $${position.indicators.ema21.toFixed(2)}\`\n`;
    }
    if (position.indicators.rsi != null) {
      msg += `• RSI(14): \`${position.indicators.rsi.toFixed(1)}\`\n`;
    }
    if (position.indicators.stochK != null) {
      msg += `• StochRSI: \`${position.indicators.stochK.toFixed(0)}\`\n`;
    }
    if (position.indicators.pattern) {
      msg += `• Nến: \`${position.indicators.pattern}\`\n`;
    }
    if (position.indicators.atr != null) {
      msg += `• ATR(14): \`${position.indicators.atr.toFixed(2)}\`\n`;
    }
    if (position.indicators.orderFlow) {
      const of = position.indicators.orderFlow;
      msg += `• 📊 Order Flow: \`Mua ${of.buyRatio}% | Bán ${of.sellRatio}% (Delta ${of.volumeDelta > 0 ? '+' : ''}${of.volumeDelta.toFixed(2)})\`\n`;
    }
    if (position.indicators.orderBook) {
      const ob = position.indicators.orderBook;
      msg += `• 📖 Sổ lệnh: \`${ob.bidPercent}% Chờ Mua vs ${ob.askPercent}% Chờ Bán\`\n`;
    }
  }

  msg += `\n💡 _Bot đang giám sát giá Realtime từng giây. Khi đạt đúng +1 giá là lập tức đóng lệnh chốt lời!_`;

  return await sendRawMessage(msg);
}

/**
 * Gửi thông báo đóng lệnh Scalping (Chốt lời 1 giá hoặc Cắt lỗ)
 */
async function sendScalpCloseAlert(result) {
  const { type, trade, stats } = result;
  const isTp = type === 'TP';
  const isBuy = trade.action.toUpperCase() === 'BUY';
  const icon = isBuy ? '🟢 MUA (BUY)' : '🔴 BÁN (SELL)';

  let msg = '';
  if (isTp) {
    msg += `🎉 *[SCALP 1M] CHỐT LỜI THÀNH CÔNG (+1.00 GIÁ)!* 🎉\n\n`;
    msg += `👉 *Vị Thế:* *${icon}*\n`;
    msg += `🎯 *Mục Tiêu:* Đã cán đích chốt lời 1 giá thành công!\n\n`;
  } else {
    msg += `🛑 *[SCALP 1M] ĐÃ ĐÓNG LỆNH CẮT LỖ (SL HIT)* 🛑\n\n`;
    msg += `👉 *Vị Thế:* *${icon}*\n`;
    msg += `🛡 *Lý Do:* Giá chạm mức cắt lỗ an toàn theo người dùng.\n\n`;
  }

  msg += `💵 *CHI TIẾT KHỚP LỆNH:*\n`;
  msg += `• *Giá Vào:* \`$${trade.entryPrice.toFixed(2)}\`\n`;
  msg += `• *Giá Đóng:* \`$${trade.exitPrice.toFixed(2)}\`\n`;
  const pnlSign = trade.pnlPoints >= 0 ? `+${trade.pnlPoints.toFixed(2)}` : `${trade.pnlPoints.toFixed(2)}`;
  msg += `• *Kết Quả:* *${trade.result === 'WIN' ? '💰 LÃI' : '🔻 LỖ'} ${pnlSign} giá*\n`;
  msg += `• *Thời Gian Giữ:* \`${trade.durationFormatted || 'N/A'}\`\n\n`;

  if (stats) {
    msg += `📈 *HIỆU SUẤT SCALPING HÔM NAY:*\n`;
    msg += `• *Tổng Số Lệnh:* \`${stats.totalTrades}\` (Thắng: \`${stats.wins}\` | Thua: \`${stats.losses}\`)\n`;
    msg += `• 🏆 *Tỷ Lệ Thắng (Winrate):* \`${stats.winRate}%\`\n`;
    const totalPnlSign = stats.totalPointsEarned >= 0 ? `+${stats.totalPointsEarned.toFixed(2)}` : `${stats.totalPointsEarned.toFixed(2)}`;
    msg += `• 💰 *Tổng PnL Tích Luỹ:* \`${totalPnlSign} giá\`\n`;
  }

  msg += `\n🚀 _Tiếp tục quét nến 1m tiếp theo để tìm cơ hội mới..._`;

  return await sendRawMessage(msg);
}

module.exports = {
  sendRawMessage,
  sendTradeAlert,
  sendMarketDigest,
  sendScalpOpenAlert,
  sendScalpCloseAlert,
};


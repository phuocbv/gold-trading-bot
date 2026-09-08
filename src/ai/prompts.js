/**
 * Prompt thẩm định tín hiệu giao dịch Vàng (XAU/USD - GC=F)
 */
function buildValidationPrompt(signal, marketSnapshot) {
  const divergenceInfo = signal.indicators?.divergenceDetail ? `\n- Tín hiệu Phân kỳ: ${signal.indicators.divergenceDetail}` : '';
  const candlePatternInfo = (signal.indicators?.pattern || signal.indicators?.candlePattern) ? `\n- Mô hình nến xác nhận: ${signal.indicators.pattern || signal.indicators.candlePattern}` : '';
  const volumeInfo = signal.indicators?.volumeRatio ? `\n- Khối lượng bùng nổ: ${signal.indicators.volumeRatio}` : '';
  const scoreInfo = signal.score != null ? `\n- Điểm chất lượng & Trọng số kỹ thuật: ${signal.score}/100 (${signal.rankBadge || signal.rank})` : '';
  const breakdownInfo = signal.breakdown && signal.breakdown.length > 0 ? `\n- Chi tiết đánh giá trọng số: ${signal.breakdown.join(' | ')}` : '';
  const confluenceInfo = signal.alliedStrategies ? `\n- Hợp lưu từ ${signal.alliedStrategies.length} chiến lược: ${signal.alliedStrategies.join(', ')}` : '';

  return `
Bạn là một Giám đốc Quản trị Rủi ro và Chuyên gia Phân tích Định lượng (Senior Forex/Gold Quant Trader) hàng đầu thị trường tài chính quốc tế.

Nhiệm vụ của bạn: Thẩm định một tín hiệu giao dịch Vàng (Gold - GC=F) vừa được phát hiện bởi thuật toán phân tích kỹ thuật, nhằm LỌC BỎ các bẫy giá (Bull/Bear Trap, Liquidity Sweep, Fakeout) và tối đa hóa xác suất chiến thắng.

THÔNG TIN TÍN HIỆU CẦN THẨM ĐỊNH:
- Chiến lược phát hiện: ${signal.strategy}${scoreInfo}${breakdownInfo}${confluenceInfo}
- Lệnh đề xuất: ${signal.action} (Giá hiện tại / Entry: $${signal.entry.toFixed(2)})
- Stop Loss đề xuất: $${signal.stopLoss.toFixed(2)}
- Take Profit 1: $${signal.takeProfit.toFixed(2)}${signal.takeProfit2 ? ` | Take Profit 2: $${signal.takeProfit2.toFixed(2)}` : ''}
- Tỉ lệ R:R: ${signal.rrRatio}${divergenceInfo}${candlePatternInfo}${volumeInfo}

DỮ LIỆU THỊ TRƯỜNG THỰC TẾ (SNAPSHOT):
- Khung thời gian: ${marketSnapshot.timeframe}
- ADX(14) - Đo độ mạnh xu hướng: ${marketSnapshot.adx?.toFixed(1) || 'N/A'} (${marketSnapshot.adx >= 22 ? 'XU HƯỚNG RÕ RÀNG' : 'SIDEWAY / ĐI NGANG'})
- Stochastic RSI (%K): ${marketSnapshot.stochK != null ? marketSnapshot.stochK.toFixed(1) : 'N/A'}
- RSI(14): ${marketSnapshot.rsi?.toFixed(1) || 'N/A'}
- VWAP (Giá trị chuẩn tổ chức): ${marketSnapshot.vwap ? '$' + marketSnapshot.vwap.toFixed(2) : 'N/A'}
- MFI(14) - Dòng tiền thực tế: ${marketSnapshot.mfi?.toFixed(1) || 'N/A'}
- ATR(14) - Độ biến động nến: ${marketSnapshot.atr?.toFixed(2) || 'N/A'}
- EMA Ribbon: EMA20: $${marketSnapshot.ema20?.toFixed(2) || 'N/A'} | EMA50: $${marketSnapshot.ema50?.toFixed(2) || 'N/A'} | EMA200: $${marketSnapshot.ema200?.toFixed(2) || 'N/A'}
- Đỉnh 20 nến gần nhất: $${marketSnapshot.recentHigh?.toFixed(2) || 'N/A'}
- Đáy 20 nến gần nhất: $${marketSnapshot.recentLow?.toFixed(2) || 'N/A'}
- 5 cây nến gần nhất [Open, High, Low, Close]:
${JSON.stringify(marketSnapshot.recentCandles || [], null, 2)}

HƯỚNG DẪN ĐÁNH GIÁ:
1. Đánh giá xem lệnh có thuận xu hướng lớn (EMA200, ADX) hoặc có tín hiệu đảo chiều tin cậy (Phân kỳ RSI, VWAP, Nến đảo chiều) không.
2. Kiểm tra xem điểm vào có nằm ngay sát vùng Cản/Hỗ trợ mạnh có nguy cơ bị bẫy Fakeout hoặc thanh khoản (Liquidity sweep) không.
3. Chấm điểm độ tin cậy từ 0% đến 100%. Nếu >= 75% -> approved: true, nếu < 75% -> approved: false.

BẮT BUỘC TRẢ VỀ DUY NHẤT ĐỊNH DẠNG JSON (không kèm markdown \`\`\`json ngoài text):
{
  "approved": true,
  "confidence": 82,
  "trend": "BULLISH | BEARISH | SIDEWAY",
  "support": 4400.0,
  "resistance": 4430.0,
  "reasoning": "Giải thích ngắn gọn súc tích 1-2 câu lý do đồng thuận hoặc từ chối bằng tiếng Việt.",
  "risk_warning": "Cảnh báo rủi ro chính (nếu có)."
}
`;
}

/**
 * Prompt tổng hợp bản tin thị trường định kỳ
 */
function buildDigestPrompt(marketSnapshot) {
  return `
Bạn là chuyên gia phân tích kỹ thuật Vàng Forex (XAU/USD).
Hãy viết một bản tin vắn tắt (Market Digest) cập nhật tình hình giá Vàng cho trader.

DỮ LIỆU HIỆN TẠI:
- Giá: $${marketSnapshot.currentPrice?.toFixed(2)}
- EMA20: $${marketSnapshot.ema20?.toFixed(2)} | EMA50: $${marketSnapshot.ema50?.toFixed(2)} | EMA200: $${marketSnapshot.ema200?.toFixed(2)}
- RSI: ${marketSnapshot.rsi?.toFixed(1)} | ATR: ${marketSnapshot.atr?.toFixed(2)}
- Đỉnh gần nhất: $${marketSnapshot.recentHigh?.toFixed(2)} | Đáy gần nhất: $${marketSnapshot.recentLow?.toFixed(2)}

YÊU CẦU TRẢ VỀ DUY NHẤT JSON:
{
  "trend": "Xu hướng tổng quan ngắn hạn",
  "support": "Mức giá hỗ trợ đáng chú ý",
  "resistance": "Mức giá kháng cự đáng chú ý",
  "summary": "Đoạn nhận định 2-3 câu tổng kết cấu trúc giá và kịch bản gợi ý cho phiên sắp tới bằng tiếng Việt."
}
`;
}

module.exports = {
  buildValidationPrompt,
  buildDigestPrompt,
};

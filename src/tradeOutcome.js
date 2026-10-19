/**
 * Quy tắc tính kết quả lệnh dùng chung cho backtest và theo dõi tín hiệu thật,
 * để thống kê trên dashboard khớp với cách backtest chấm điểm.
 */

/**
 * Nến có chạm SL hoặc TP1 của lệnh không: 'SL' | 'TP' | null.
 * Nếu SL và TP1 cùng nằm trong một nến thì tính là chạm SL (giả định bi quan).
 */
function checkCandleHit(trade, candle) {
  const isBuy = trade.action === 'BUY';
  if (isBuy ? candle.low <= trade.stopLoss : candle.high >= trade.stopLoss) return 'SL';
  if (isBuy ? candle.high >= trade.takeProfit : candle.low <= trade.takeProfit) return 'TP';
  return null;
}

/**
 * Lãi/lỗ theo R (1R = khoảng cách Entry -> SL) nếu thoát lệnh tại exitPrice
 */
function rMultiple(trade, exitPrice) {
  const risk = Math.abs(trade.entry - trade.stopLoss);
  if (!risk) return 0;
  const move = trade.action === 'BUY' ? exitPrice - trade.entry : trade.entry - exitPrice;
  return move / risk;
}

/**
 * Tên ngắn của chiến lược chính, bỏ tiền tố hợp lưu và phần mô tả trong ngoặc
 * ('Hợp lưu [2 Chiến Lược]: Smart Money Flow (VWAP + ...)' -> 'Smart Money Flow')
 */
function primaryStrategyName(strategy) {
  return (strategy.split(']: ')[1] || strategy).split(' (')[0];
}

module.exports = {
  checkCandleHit,
  rMultiple,
  primaryStrategyName,
};

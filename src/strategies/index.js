const TrendFollowingStrategy = require('./trendFollowing');
const MeanReversionStrategy = require('./meanReversion');
const BreakoutAtrStrategy = require('./breakoutAtr');
const SmcOrderBlockStrategy = require('./smcOrderBlock');
const RsiDivergenceStrategy = require('./rsiDivergence');
const VolumeVwapAdxStrategy = require('./volumeVwapAdx');

const strategies = [
  new TrendFollowingStrategy(),
  new MeanReversionStrategy(),
  new BreakoutAtrStrategy(),
  new SmcOrderBlockStrategy(),
  new RsiDivergenceStrategy(),
  new VolumeVwapAdxStrategy(),
];

/**
 * Chạy tất cả các chiến lược trên tập dữ liệu nến hiện tại và tính toán hợp lưu & xếp hạng
 * @param {object} marketData
 * @returns {Array<object>} Danh sách các tín hiệu đã được chấm điểm, xếp hạng và sắp xếp từ cao xuống thấp
 */
function evaluateAllStrategies(marketData) {
  const rawSignals = [];

  for (const strat of strategies) {
    try {
      const signal = strat.analyze(marketData);
      if (signal) {
        rawSignals.push(signal);
      }
    } catch (err) {
      console.error(`❌ Lỗi khi chạy chiến lược ${strat.name}:`, err.message);
    }
  }

  if (rawSignals.length === 0) return [];

  // Phân nhóm tín hiệu theo chiều giao dịch (BUY vs SELL)
  const buySignals = rawSignals.filter((s) => s.action === 'BUY');
  const sellSignals = rawSignals.filter((s) => s.action === 'SELL');

  // Cảnh báo nếu có xung đột đối nghịch (Vừa có BUY vừa có SELL)
  if (buySignals.length > 0 && sellSignals.length > 0) {
    console.warn(`⚠️ [Xung đột tín hiệu]: Phát hiện ${buySignals.length} BUY và ${sellSignals.length} SELL đồng thời! Đang chiết khấu điểm do thị trường giằng co.`);
    buySignals.forEach((s) => {
      s.score = Math.max(0, s.score - 15);
      if (s.breakdown) s.breakdown.push(`Trừ điểm xung đột đối kháng: -15đ`);
    });
    sellSignals.forEach((s) => {
      s.score = Math.max(0, s.score - 15);
      if (s.breakdown) s.breakdown.push(`Trừ điểm xung đột đối kháng: -15đ`);
    });
  }

  const processedSignals = [];

  // Xử lý hợp lưu cho 1 nhóm tín hiệu cùng chiều
  const processGroup = (group) => {
    if (group.length === 0) return;

    if (group.length === 1) {
      processedSignals.push(group[0]);
      return;
    }

    // Nếu có từ 2 chiến lược trở lên cùng đồng thuận một chiều -> TẠO SIÊU TÍN HIỆU HỢP LƯU (CONFLUENCE)
    group.sort((a, b) => b.score - a.score);
    const primary = group[0];
    const alliedStrategies = group.map((s) => s.strategy);

    const confluenceBonus = Math.min(20, (group.length - 1) * 10); // +10đ cho mỗi chiến lược đồng thuận thêm
    const combinedScore = Math.min(100, primary.score + confluenceBonus);

    let rank = 'B';
    let rankBadge = '⭐⭐⭐ [Hạng B - Đạt chuẩn]';
    if (combinedScore >= 90) {
      rank = 'S';
      rankBadge = '⭐⭐⭐⭐⭐ [Hạng S - Hợp lưu Siêu cấp]';
    } else if (combinedScore >= 80) {
      rank = 'A';
      rankBadge = '⭐⭐⭐⭐ [Hạng A - Uy tín cao]';
    }

    const mergedBreakdown = [
      ...(primary.breakdown || []),
      `Hợp lưu ${group.length} chiến lược đồng thuận (${alliedStrategies.join(' + ')}): +${confluenceBonus}đ`,
    ];

    const mergedIndicators = { ...primary.indicators };
    for (let i = 1; i < group.length; i++) {
      Object.assign(mergedIndicators, group[i].indicators);
    }

    const confluenceSignal = {
      ...primary,
      strategy: `Hợp lưu [${group.length} Chiến Lược]: ${primary.strategy}`,
      confluenceCount: group.length,
      alliedStrategies,
      score: combinedScore,
      rank,
      rankBadge,
      breakdown: mergedBreakdown,
      indicators: mergedIndicators,
    };

    processedSignals.push(confluenceSignal);
  };

  processGroup(buySignals);
  processGroup(sellSignals);

  // Sắp xếp các tín hiệu theo điểm số từ cao nhất xuống thấp nhất
  processedSignals.sort((a, b) => b.score - a.score);

  return processedSignals;
}

module.exports = {
  strategies,
  evaluateAllStrategies,
};

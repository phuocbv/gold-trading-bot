const BaseStrategy = require('./baseStrategy');
const TrendFollowingStrategy = require('./trendFollowing');
const MeanReversionStrategy = require('./meanReversion');
const BreakoutAtrStrategy = require('./breakoutAtr');
const SmcOrderBlockStrategy = require('./smcOrderBlock');
const RsiDivergenceStrategy = require('./rsiDivergence');
const VolumeVwapAdxStrategy = require('./volumeVwapAdx');
const OrderFlowReversalStrategy = require('./orderFlowReversal');
const DonchianBreakoutStrategy = require('./donchianBreakout');
const CONFIG = require('../config');

// Danh mục chiến lược theo tên khóa dùng trong cấu hình STRATEGIES
const registry = {
  'trend-following': new TrendFollowingStrategy(),
  'mean-reversion': new MeanReversionStrategy(),
  'volatility-breakout': new BreakoutAtrStrategy(),
  'smc-lite': new SmcOrderBlockStrategy(),
  'rsi-divergence': new RsiDivergenceStrategy(),
  'smart-money-flow': new VolumeVwapAdxStrategy(),
  'order-flow': new OrderFlowReversalStrategy(),
  'donchian-55': new DonchianBreakoutStrategy(55),
};
for (const [key, strat] of Object.entries(registry)) strat.key = key;

const strategies = Object.values(registry);

let defaultPlan = null;

/**
 * Kế hoạch chạy theo cấu hình STRATEGIES: Map(khung thời gian -> danh sách chiến lược), giữ thứ tự khai báo
 */
function getStrategyPlan(plan = null) {
  if (!plan) {
    if (!defaultPlan) defaultPlan = getStrategyPlan(CONFIG.strategyPlan);
    return defaultPlan;
  }
  const byTimeframe = new Map();
  for (const { key, timeframe } of plan) {
    const strat = registry[key];
    if (!strat) {
      console.warn(`⚠️ [Strategies] Không có chiến lược "${key}" (có: ${Object.keys(registry).join(', ')}), bỏ qua.`);
      continue;
    }
    if (!/^\d+[mhdw]$/.test(timeframe)) {
      console.warn(`⚠️ [Strategies] Khung thời gian "${timeframe}" của "${key}" không hợp lệ (vd: 15m, 1h, 4h), bỏ qua.`);
      continue;
    }
    if (!byTimeframe.has(timeframe)) byTimeframe.set(timeframe, []);
    if (!byTimeframe.get(timeframe).includes(strat)) byTimeframe.get(timeframe).push(strat);
  }
  return byTimeframe;
}

/**
 * Chạy các chiến lược trên tập dữ liệu nến hiện tại và tính toán hợp lưu & xếp hạng
 * @param {object} marketData - Dữ liệu nến (chỉ gồm các nến đã đóng)
 * @param {object} [options] - { silent: true } để tắt log (dùng cho backtest), { strategies } để chỉ chạy một số chiến lược
 * @returns {Array<object>} Danh sách các tín hiệu đã được chấm điểm, xếp hạng và sắp xếp từ cao xuống thấp
 */
function evaluateAllStrategies(marketData, options = {}) {
  const rawSignals = [];

  for (const strat of options.strategies || strategies) {
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

  // Xung đột đối nghịch (vừa có BUY vừa có SELL trên cùng nến): thị trường giằng co, bỏ qua cả hai chiều
  if (buySignals.length > 0 && sellSignals.length > 0) {
    if (!options.silent) {
      console.warn(`⚠️ [Xung đột tín hiệu]: Phát hiện ${buySignals.length} BUY và ${sellSignals.length} SELL đồng thời! Bỏ qua cả hai chiều do thị trường giằng co.`);
    }
    return [];
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

    const { rank, rankBadge } = BaseStrategy.rankFor(combinedScore, true);

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
  registry,
  getStrategyPlan,
  evaluateAllStrategies,
};

const TrendFollowingStrategy = require('./trendFollowing');
const MeanReversionStrategy = require('./meanReversion');
const BreakoutAtrStrategy = require('./breakoutAtr');
const SmcOrderBlockStrategy = require('./smcOrderBlock');

const strategies = [
  new TrendFollowingStrategy(),
  new MeanReversionStrategy(),
  new BreakoutAtrStrategy(),
  new SmcOrderBlockStrategy(),
];

/**
 * Chạy tất cả các chiến lược trên tập dữ liệu nến hiện tại
 * @param {object} marketData
 * @returns {Array<object>} Danh sách các tín hiệu được kích hoạt
 */
function evaluateAllStrategies(marketData) {
  const triggeredSignals = [];

  for (const strat of strategies) {
    try {
      const signal = strat.analyze(marketData);
      if (signal) {
        triggeredSignals.push(signal);
      }
    } catch (err) {
      console.error(`❌ Lỗi khi chạy chiến lược ${strat.name}:`, err.message);
    }
  }

  return triggeredSignals;
}

module.exports = {
  strategies,
  evaluateAllStrategies,
};

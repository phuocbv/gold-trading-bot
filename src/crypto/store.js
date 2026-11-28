/**
 * Lưu kết quả backtest crypto (npm run backtest:crypto) trong bảng riêng crypto_backtest_runs, tách khỏi các bảng
 * báo cáo backtest của bot. Bảng được tạo ở lần dùng đầu tiên. Không có Postgres thì lưu file JSON trong data/.
 */
const path = require('path');
const fs = require('fs');
const { dbEnabled, query, withTransaction } = require('../services/db');
const { readJson, writeJson } = require('../services/jsonStore');

// Mỗi tài sản giữ vài lần chạy gần nhất (mỗi lần khoảng 1-2 MB) để so sánh khi cần, lần cũ hơn bị xóa
const KEEP_RUNS = 10;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const fileFor = (binanceSymbol) => path.join(DATA_DIR, `crypto-backtest-${binanceSymbol}.json`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crypto_backtest_runs (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE (symbol, generated_at)
);
`;

let ready = null;
function ensureTable() {
  if (!ready) {
    ready = query(SCHEMA).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

/**
 * Lưu một lần chạy của một tài sản. Trả về nơi đã lưu ('postgres' hoặc đường dẫn file)
 */
async function saveRun(payload) {
  if (!dbEnabled()) {
    writeJson(fileFor(payload.binanceSymbol), payload);
    return fileFor(payload.binanceSymbol);
  }
  await ensureTable();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO crypto_backtest_runs (symbol, generated_at, payload) VALUES ($1, $2, $3)
       ON CONFLICT (symbol, generated_at) DO UPDATE SET payload = EXCLUDED.payload`,
      [payload.binanceSymbol, payload.generatedAt, payload]);
    await client.query(
      `DELETE FROM crypto_backtest_runs WHERE symbol = $1 AND id NOT IN (
         SELECT id FROM crypto_backtest_runs WHERE symbol = $1 ORDER BY generated_at DESC LIMIT $2)`,
      [payload.binanceSymbol, KEEP_RUNS]);
  });
  return 'postgres';
}

/**
 * Các tài sản đã có kết quả: [{ symbol, displayName, generatedAt, id }], lần chạy mới nhất của mỗi tài sản
 */
async function listRuns() {
  if (!dbEnabled()) {
    let files = [];
    try {
      files = fs.readdirSync(DATA_DIR).filter((f) => /^crypto-backtest-[A-Z0-9]+\.json$/.test(f));
    } catch (err) {
      return [];
    }
    return files.map((f) => {
      const p = readJson(path.join(DATA_DIR, f), null);
      return p && { symbol: p.binanceSymbol, displayName: p.displayName, generatedAt: p.generatedAt, id: p.generatedAt };
    }).filter(Boolean);
  }
  await ensureTable();
  const { rows } = await query(
    `SELECT DISTINCT ON (symbol) id, symbol, generated_at, payload->>'displayName' AS display_name
     FROM crypto_backtest_runs ORDER BY symbol, generated_at DESC`);
  return rows.map((r) => ({ symbol: r.symbol, displayName: r.display_name, generatedAt: r.generated_at.toISOString(), id: String(r.id) }));
}

// Bản chạy chỉ đổi khi quét lại: giữ bản đã đọc theo id
const cache = new Map();

/**
 * Lần chạy mới nhất của một tài sản (vd 'BTCUSDT'), null nếu chưa có
 */
async function latestRun(binanceSymbol) {
  const runs = await listRuns();
  const head = runs.find((r) => r.symbol === binanceSymbol);
  if (!head) return null;
  const hit = cache.get(binanceSymbol);
  if (hit && hit.id === head.id) return hit.payload;
  const payload = dbEnabled()
    ? (await query('SELECT payload FROM crypto_backtest_runs WHERE id = $1', [head.id])).rows[0].payload
    : readJson(fileFor(binanceSymbol), null);
  cache.set(binanceSymbol, { id: head.id, payload });
  return payload;
}

module.exports = {
  saveRun,
  listRuns,
  latestRun,
};

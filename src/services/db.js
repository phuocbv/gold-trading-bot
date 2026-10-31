const { Pool } = require('pg');
const CONFIG = require('../config');

// Bảng được tạo tự động ở lần kết nối đầu tiên
const SCHEMA = `
-- Tín hiệu bot đã phát (hoặc AI từ chối) và kết quả TP1/SL; data là bản ghi đầy đủ của signalTracker,
-- các cột còn lại tách ra để truy vấn thống kê
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  strategy TEXT NOT NULL,
  action TEXT NOT NULL,
  sent BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  candle_time TIMESTAMPTZ NOT NULL,
  closed_time TIMESTAMPTZ,
  r_multiple DOUBLE PRECISION,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_candle_time_idx ON signals (candle_time);
-- origin: 'bot' tín hiệu bot thật, 'backtest' tín hiệu bổ sung bằng npm run backtest:day (quy trình bot, chưa qua AI)
ALTER TABLE signals ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'bot';

-- Mỗi lần tạo báo cáo backtest là một bản lưu riêng, không ghi đè (kind: 'report' tổng hợp, 'monthly' theo tháng của year).
-- kind 'day' (npm run backtest:day) là kết quả kiểm tra một ngày của một tài sản: mỗi ngày mỗi tài sản chỉ một dòng,
-- chạy lại thì thay bằng lần mới nhất
CREATE TABLE IF NOT EXISTS backtest_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  year INTEGER,
  plan_signature TEXT,
  payload JSONB NOT NULL,
  UNIQUE (kind, generated_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS backtest_runs_day_symbol_idx ON backtest_runs ((payload->>'day'), (payload->>'symbol')) WHERE kind = 'day';

-- Từng lệnh backtest đã đóng của báo cáo tổng hợp, cộng dồn qua các lần chạy để thống kê được cả giai đoạn
-- nguồn dữ liệu không còn trả về (TradingView ẩn danh chỉ có vài nghìn nến gần nhất).
-- strategy: khóa phương pháp, hoặc 'combined:<khóa+khóa>' cho các phương pháp chạy gộp
CREATE TABLE IF NOT EXISTS backtest_trades (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  strategy TEXT NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  net_r DOUBLE PRECISION NOT NULL,
  run_id BIGINT NOT NULL REFERENCES backtest_runs (id),
  PRIMARY KEY (symbol, timeframe, strategy, entry_time)
);
`;

let pool = null;
let ready = null;

function dbEnabled() {
  return Boolean(CONFIG.databaseUrl);
}

// Lỗi kết nối thử cả IPv4 lẫn IPv6 (AggregateError) không có message: dùng mã lỗi để log còn đọc được
function withMessage(err) {
  if (err && !err.message) err.message = err.code || (err.errors && err.errors[0] && err.errors[0].message) || 'Lỗi kết nối Postgres';
  return err;
}

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Bot và tiến trình tạo báo cáo có thể cùng tạo bảng lúc khởi động
    await client.query('SELECT pg_advisory_xact_lock(7426001)');
    await client.query(SCHEMA);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Pool kết nối Postgres, tạo bảng ở lần dùng đầu tiên. Lỗi kết nối được ném ra để nơi gọi tự dùng file JSON thay thế.
 */
async function getDb() {
  if (!dbEnabled()) throw new Error('Chưa cấu hình DATABASE_URL');
  if (!pool) {
    pool = new Pool({ connectionString: CONFIG.databaseUrl, max: 3, connectionTimeoutMillis: 10000, statement_timeout: 60000 });
    // Lỗi của kết nối đang rảnh (vd: Postgres khởi động lại) không được làm dừng bot
    pool.on('error', (err) => console.error('❌ [DB] Lỗi kết nối Postgres:', err.message));
  }
  if (!ready) {
    ready = ensureSchema().catch((err) => {
      ready = null;
      throw withMessage(err);
    });
  }
  await ready;
  return pool;
}

async function query(text, params) {
  const db = await getDb();
  return db.query(text, params).catch((err) => {
    throw withMessage(err);
  });
}

async function withTransaction(fn) {
  const client = await (await getDb()).connect().catch((err) => {
    throw withMessage(err);
  });
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Đóng kết nối để tiến trình (vd: script tạo báo cáo) thoát được
 */
async function closeDb() {
  if (!pool) return;
  const current = pool;
  pool = null;
  ready = null;
  await current.end().catch(() => {});
}

module.exports = {
  dbEnabled,
  query,
  withTransaction,
  closeDb,
};

/**
 * Đăng nhập dashboard: một tài khoản trong .env (DASHBOARD_USERNAME / DASHBOARD_PASSWORD). Phiên đăng nhập lưu bằng
 * cookie ký HMAC nên server không cần lưu phiên; khóa ký lấy từ tài khoản nên đổi mật khẩu thì mọi phiên cũ hết hiệu lực.
 */
const crypto = require('crypto');
const CONFIG = require('../config');

const COOKIE = 'gtb_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
// Sai mật khẩu quá MAX_FAILS lần thì khóa đăng nhập từ IP đó trong LOCK_MS
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map();

function loginEnabled() {
  return Boolean(CONFIG.dashboardUsername && CONFIG.dashboardPassword);
}

function sign(payload) {
  const key = crypto.createHash('sha256').update(`gtb-dashboard-session\n${CONFIG.dashboardUsername}\n${CONFIG.dashboardPassword}`).digest();
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

// So sánh không lộ thông tin qua thời gian xử lý (băm trước để hai bên cùng độ dài)
function safeEqual(a, b) {
  const digest = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch (err) {
        return null;
      }
    }
  }
  return null;
}

/**
 * Tên tài khoản của phiên đăng nhập hợp lệ, null nếu chưa đăng nhập (hoặc chưa cấu hình đăng nhập)
 */
function sessionUser(req) {
  if (!loginEnabled()) return null;
  const [payload, signature] = (readCookie(req, COOKIE) || '').split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return u === CONFIG.dashboardUsername && exp > Date.now() ? u : null;
  } catch (err) {
    return null;
  }
}

// Sau reverse proxy HTTPS (nginx, Render...) thì req.secure là false nên xem thêm X-Forwarded-Proto
const cookieOptions = (req) => ({
  path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('x-forwarded-proto') === 'https',
});

/**
 * Kiểm tra tài khoản và tạo phiên đăng nhập. Trả về 'ok', 'invalid' (sai tài khoản) hoặc 'locked' (sai quá nhiều lần)
 */
function login(req, res, username, password) {
  const now = Date.now();
  // Lượt sai được đếm trong LOCK_MS kể từ lần sai cuối; hết khóa hoặc quá hạn thì xóa
  for (const [ip, f] of failures) if (Math.max(f.until, f.at + LOCK_MS) <= now) failures.delete(ip);
  const fail = failures.get(req.ip) || { count: 0, until: 0, at: 0 };
  if (fail.until > now) return 'locked';

  // Kiểm tra cả hai để thời gian xử lý không cho biết tên đăng nhập có đúng không
  const userOk = safeEqual(username, CONFIG.dashboardUsername);
  const passOk = safeEqual(password, CONFIG.dashboardPassword);
  if (!userOk || !passOk) {
    fail.count++;
    fail.at = now;
    if (fail.count >= MAX_FAILS) Object.assign(fail, { count: 0, until: now + LOCK_MS });
    failures.set(req.ip, fail);
    console.warn(`⚠️ [Dashboard] Đăng nhập sai từ ${req.ip}${fail.until > now ? ', khóa 15 phút' : ''}.`);
    return fail.until > now ? 'locked' : 'invalid';
  }

  failures.delete(req.ip);
  const payload = Buffer.from(JSON.stringify({ u: CONFIG.dashboardUsername, exp: now + SESSION_MS })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, { ...cookieOptions(req), maxAge: SESSION_MS });
  return 'ok';
}

function logout(req, res) {
  res.clearCookie(COOKIE, cookieOptions(req));
}

/**
 * Chặn truy cập khi chưa đăng nhập: trang dashboard chuyển sang trang đăng nhập, API trả 401.
 * Vẫn nhận ?token= khi có DASHBOARD_TOKEN (link cũ); không cấu hình đăng nhập lẫn token thì để mở như trước
 */
function requireAuth(req, res, next) {
  if (CONFIG.dashboardToken && req.query.token === CONFIG.dashboardToken) return next();
  if (loginEnabled() ? sessionUser(req) : !CONFIG.dashboardToken) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên đăng nhập đã hết hạn' });
  if (!loginEnabled()) return res.status(401).send('Unauthorized');
  // Đường dẫn tương đối để vẫn đúng khi dashboard nằm sau tiền tố proxy (vd: /bot/dashboard -> /bot/login)
  res.redirect(303, req.path.endsWith('/') ? '../login' : 'login');
}

module.exports = {
  loginEnabled,
  sessionUser,
  login,
  logout,
  requireAuth,
};

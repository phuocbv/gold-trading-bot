/**
 * Phương pháp theo xu hướng cho BTC/ETH (chỉ dùng cho backtest crypto, không ảnh hưởng tín hiệu của bot).
 * Mỗi phương pháp cho điểm vào lệnh MUA và BÁN tại nến đã đóng; thoát lệnh bằng SL ban đầu + trailing stop (xem trend.js).
 */

// ---------- Chỉ báo (mảng cùng độ dài với nến, null khi chưa đủ dữ liệu) ----------

// ATR Wilder
function atr(d, p = 14) {
  const out = new Array(d.n).fill(null);
  let a = 0;
  for (let i = 1; i < d.n; i++) {
    const tr = Math.max(d.h[i] - d.l[i], Math.abs(d.h[i] - d.c[i - 1]), Math.abs(d.l[i] - d.c[i - 1]));
    if (i <= p) {
      a += tr / p;
      if (i === p) out[i] = a;
      continue;
    }
    a = (a * (p - 1) + tr) / p;
    out[i] = a;
  }
  return out;
}

// EMA bắt đầu từ giá trị khác null đầu tiên của chuỗi
function ema(x, p) {
  const out = new Array(x.length).fill(null);
  const k = 2 / (p + 1);
  let e = null;
  let count = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] == null) continue;
    e = e == null ? x[i] : x[i] * k + e * (1 - k);
    if (++count >= p) out[i] = e;
  }
  return out;
}

function sma(x, p) {
  const out = new Array(x.length).fill(null);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= p) s -= x[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}

function stdev(x, p) {
  const out = new Array(x.length).fill(null);
  for (let i = p - 1; i < x.length; i++) {
    let s = 0;
    let q = 0;
    for (let k = i - p + 1; k <= i; k++) {
      s += x[k];
      q += x[k] * x[k];
    }
    out[i] = Math.sqrt(Math.max(0, q / p - (s / p) ** 2));
  }
  return out;
}

// RSI Wilder
function rsi(c, p = 14) {
  const out = new Array(c.length).fill(null);
  let g = 0;
  let l = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    const up = Math.max(ch, 0);
    const dn = Math.max(-ch, 0);
    if (i <= p) {
      g += up / p;
      l += dn / p;
      if (i === p) out[i] = 100 - 100 / (1 + g / (l || 1e-12));
      continue;
    }
    g = (g * (p - 1) + up) / p;
    l = (l * (p - 1) + dn) / p;
    out[i] = 100 - 100 / (1 + g / (l || 1e-12));
  }
  return out;
}

// Chiều Supertrend (1 tăng, -1 giảm)
function supertrend(d, A, mult = 3) {
  const dir = new Array(d.n).fill(null);
  let up = null;
  let dn = null;
  let cur = 1;
  for (let i = 1; i < d.n; i++) {
    if (!A[i]) continue;
    const mid = (d.h[i] + d.l[i]) / 2;
    const bu = mid - mult * A[i];
    const bd = mid + mult * A[i];
    up = up == null || d.c[i - 1] < up ? bu : Math.max(bu, up);
    dn = dn == null || d.c[i - 1] > dn ? bd : Math.min(bd, dn);
    if (cur === 1 && d.c[i] < up) cur = -1;
    else if (cur === -1 && d.c[i] > dn) cur = 1;
    dir[i] = cur;
  }
  return dir;
}

// Đỉnh / đáy cao nhất của N nến trước nến i (không gồm nến i)
function channels(d, N) {
  const hh = new Array(d.n).fill(null);
  const ll = new Array(d.n).fill(null);
  for (let i = N; i < d.n; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let k = i - N; k < i; k++) {
      if (d.h[k] > h) h = d.h[k];
      if (d.l[k] < l) l = d.l[k];
    }
    hh[i] = h;
    ll[i] = l;
  }
  return { hh, ll };
}

const crossUp = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i] > b[i] && a[i - 1] <= b[i - 1];

// ---------- Phương pháp ----------

// Thoát lệnh mặc định của nhóm xu hướng: SL ban đầu 2 ATR, trailing 3 ATR tính từ giá tốt nhất kể từ lúc vào lệnh, không TP
const TREND_EXIT = { sl: 2, trail: 3 };
const TREND_EXIT_LABEL = 'SL 2 ATR + trailing 3 ATR, không TP';

/**
 * Các phương pháp cho một chuỗi nến: [{ key, name, buy(i), sell(i), exit, exitLabel, exitRule? }]
 * @param {object} d - Nến dạng cột { t, o, h, l, c, n }
 * @param {string} timeframe
 */
function trendMethods(d, timeframe) {
  const A = atr(d);
  const { c } = d;
  const e20 = ema(c, 20);
  const e50 = ema(c, 50);
  const e200 = ema(c, 200);
  const s20 = sma(c, 20);
  const sd20 = stdev(c, 20);
  const bbU = s20.map((m, i) => (m == null ? null : m + 2 * sd20[i]));
  const bbL = s20.map((m, i) => (m == null ? null : m - 2 * sd20[i]));
  const kU = e20.map((m, i) => (m == null || !A[i] ? null : m + 2 * A[i]));
  const kL = e20.map((m, i) => (m == null || !A[i] ? null : m - 2 * A[i]));
  const width = s20.map((m, i) => (m == null ? null : (bbU[i] - bbL[i]) / m));
  const st = supertrend(d, A, 3);
  const r14 = rsi(c, 14);
  const m12 = ema(c, 12);
  const m26 = ema(c, 26);
  const macd = m12.map((v, i) => (v == null || m26[i] == null ? null : v - m26[i]));
  const signal = ema(macd, 9);
  const ch20 = channels(d, 20);
  const ch55 = channels(d, 55);

  const up = (i) => e200[i] != null && c[i] > e200[i];
  const down = (i) => e200[i] != null && c[i] < e200[i];
  const breakUp = (band, i) => band[i - 1] != null && c[i] > band[i] && c[i - 1] <= band[i - 1];
  const breakDown = (band, i) => band[i - 1] != null && c[i] < band[i] && c[i - 1] >= band[i - 1];
  // Độ rộng Bollinger của nến trước nằm trong 20% hẹp nhất của 120 nến gần đây
  const squeeze = (i) => {
    if (i < 140 || width[i - 1] == null) return false;
    const w = width.slice(i - 120, i).filter((v) => v != null).sort((a, b) => a - b);
    return width[i - 1] <= w[Math.floor(w.length * 0.2)];
  };

  const list = [
    { key: 'donchian-20', name: 'Donchian 20 + EMA200', buy: (i) => breakUp(ch20.hh, i) && up(i), sell: (i) => breakDown(ch20.ll, i) && down(i) },
    { key: 'donchian-55', name: 'Donchian 55 + EMA200', buy: (i) => breakUp(ch55.hh, i) && up(i), sell: (i) => breakDown(ch55.ll, i) && down(i) },
    { key: 'keltner', name: 'Keltner 20 / 2 ATR + EMA200', buy: (i) => breakUp(kU, i) && up(i), sell: (i) => breakDown(kL, i) && down(i) },
    { key: 'bollinger', name: 'Bollinger 20,2 + EMA200', buy: (i) => breakUp(bbU, i) && up(i), sell: (i) => breakDown(bbL, i) && down(i) },
    { key: 'supertrend-ema200', name: 'Supertrend 10,3 + EMA200', buy: (i) => st[i] === 1 && st[i - 1] === -1 && up(i), sell: (i) => st[i] === -1 && st[i - 1] === 1 && down(i) },
    {
      key: 'pullback-rsi',
      name: 'Pullback RSI14 (MUA: lên lại 40 khi xu hướng tăng · BÁN: rơi dưới 60 khi xu hướng giảm)',
      buy: (i) => r14[i - 1] != null && r14[i] > 40 && r14[i - 1] <= 40 && up(i) && e50[i] > e200[i],
      sell: (i) => r14[i - 1] != null && r14[i] < 60 && r14[i - 1] >= 60 && down(i) && e50[i] < e200[i],
    },
    { key: 'ema-20-50', name: 'EMA20 cắt EMA50', buy: (i) => crossUp(e20, e50, i), sell: (i) => crossUp(e50, e20, i) },
    {
      key: 'macd',
      name: 'MACD cắt Signal cùng phía 0 + EMA200',
      buy: (i) => crossUp(macd, signal, i) && macd[i] > 0 && up(i),
      sell: (i) => crossUp(signal, macd, i) && macd[i] < 0 && down(i),
    },
    { key: 'squeeze', name: 'Bollinger thắt lại rồi breakout', buy: (i) => breakUp(bbU, i) && squeeze(i), sell: (i) => breakDown(bbL, i) && squeeze(i) },
  ].map((m) => ({ ...m, exit: TREND_EXIT, exitLabel: TREND_EXIT_LABEL }));

  // Phương pháp khung ngày: vào khi tín hiệu đổi chiều, thoát khi tín hiệu đổi lại (SL 3 ATR phòng biến động mạnh)
  if (timeframe === '1d') {
    const ret = (i, L) => (i >= L ? c[i] / c[i - L] - 1 : null);
    const flip = (i, L, dir) => { const a = ret(i, L); const b = ret(i - 1, L); return a != null && b != null && dir * a > 0 && dir * b <= 0; };
    const s50 = sma(c, 50);
    list.push(
      {
        key: 'tsmom-28',
        name: 'TSMOM 28 ngày (lợi nhuận 28 ngày đổi dấu)',
        buy: (i) => flip(i, 28, 1),
        sell: (i) => flip(i, 28, -1),
        exitRule: (j, dir) => { const a = ret(j, 28); return a != null && dir * a <= 0; },
        exit: { sl: 3 },
        exitLabel: 'SL 3 ATR, thoát khi lợi nhuận 28 ngày đổi dấu',
      },
      {
        key: 'sma50-cross',
        name: 'Giá cắt SMA50 ngày',
        buy: (i) => crossUp(c, s50, i),
        sell: (i) => crossUp(s50, c, i),
        exitRule: (j, dir) => s50[j] != null && dir * (c[j] - s50[j]) < 0,
        exit: { sl: 3 },
        exitLabel: 'SL 3 ATR, thoát khi giá cắt ngược SMA50',
      },
    );
  }
  return { atr: A, list };
}

module.exports = {
  trendMethods,
  TREND_EXIT_LABEL,
  // Xuất để kiểm tra
  atr,
  ema,
  rsi,
  supertrend,
};

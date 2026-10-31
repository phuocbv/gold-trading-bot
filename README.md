# Gold & Crypto Trading Bot (Node.js AI Co-Pilot & Order Flow Engine)

Hệ thống tự động phân tích thị trường Vàng (XAU/USD) & Crypto (ETH, BTC) theo thời gian thực kết hợp **Đa Chiến Lược Kỹ Thuật (Multi-Strategy)**, **Hệ Thống Bắt Đỉnh Đáy Order Flow (Confluence Scoring)** và **Trợ Lý AI (Google Gemini Multi-Key Pool)** thẩm định bẫy giá và phát tín hiệu chất lượng cao về Telegram.

---

## 🌟 Tính Năng Nổi Bật

### 1. 7 Phương Pháp Phân Tích Kỹ Thuật & Dòng Lệnh Chuyên Nghiệp:
- 💎 **Order Flow & Liquidity Reversal (High Win-Rate 75-85%)**: Tích hợp từ engine `crypto-gold-detector`, phát hiện đỉnh/đáy đa chiều dựa trên **5 trụ cột đồng thuận**:
  1. *Smart Money Sweep*: Quét qua đỉnh/đáy 25 nến trước đó (quét sạch Stop Loss) kèm râu nến từ chối $\ge 35\% - 50\%$.
  2. *Volume Climax & Order Flow Delta*: Khối lượng giao dịch đột biến $\ge 1.5x - 2.0x$ Volume SMA 20 + Delta hấp thụ cung/cầu (Taker Buy vs Sell Volume).
  3. *Momentum RSI & Swing Divergence*: Phân kỳ âm tại đỉnh / Phân kỳ dương tại đáy hoặc vùng quá mua/quá bán cực độ.
  4. *Bollinger Bands 2.0σ*: Thủng dải Band rồi nén ngược vào trong (Mean Reversion).
  5. *Trend Filter EMA 50*: Thuận sóng hồi xu hướng ngắn hạn.
- 📈 **Trend Following (Bám Xu Hướng)**: Kết hợp EMA Ribbon (20/50/200), MACD Crossover và RSI pullback để bắt sóng thuận trend lớn.
- 🔄 **Mean Reversion (Đảo Chiều Ngắn Hạn)**: Dùng Bollinger Bands (20, 2) + RSI quá mua/quá bán kết hợp nến rút chân/đảo chiều khi thị trường sideway.
- 💥 **Volatility Breakout (Bùng Nổ Biên Độ)**: Phá vỡ đỉnh/đáy 20 nến (Donchian Range) kèm biên độ nến vượt 1.2x ATR.
- 🏛 **SMC Lite (Smart Money Concepts)**: Nhận diện khoảng trống FVG (Fair Value Gap) và phản ứng khi giá retest khối lệnh Order Block.
- ⚡ **RSI Divergence (Phân Kỳ Đỉnh Đáy)**: Phát hiện phân kỳ thường giữa giá và RSI kết hợp xác nhận nến Pinbar/Engulfing.
- 🌊 **Smart Money Flow (Volume VWAP ADX)**: Đánh giá sức mạnh dòng tiền tổ chức qua VWAP và MFI.

### 2. Quét Đa Tài Sản (Multi-Asset) & Dữ Liệu Order Flow Delta Thực:
- Hỗ trợ quét đồng thời: **Vàng (XAU/USD)**, **Ethereum (ETH/USDT)**, **Bitcoin (BTC/USDT)**.
- Kết nối trực tiếp **TradingView WebSocket Datafeed** (chuẩn 100% Forex) và **Binance Spot Datafeed** (lấy chính xác Taker Buy/Sell Volume để tính Order Flow Delta).
- Hỗ trợ chế độ kiểm tra nhanh 1 lần: `node bot.js --once`.

### 3. Chạy Nhiều Khung Thời Gian & Báo Cáo Backtest:
- Mỗi phương pháp chạy ở khung riêng qua biến `STRATEGIES` (vd: `donchian-55@4h`). Mặc định: 6 phương pháp cũ ở `TIMEFRAME` (15m, đã tắt Order Flow), **Donchian Breakout (Turtle 55 + EMA200)** ở khung 1h, 2h, 4h, 1D và **Supertrend (10,3 + EMA200)** ở khung 1D.
- Hai phương pháp này được thêm vì đạt chuẩn backtest trên Vàng thật (đã trừ spread): lãi ở cả giai đoạn đầu và sau, vượt lệnh ngẫu nhiên cùng xu hướng (p < 0,05), profit factor ≥ 1,2. Donchian 2h (2 năm gần nhất): 181 lệnh, thắng 46%, +0,38R/lệnh; Supertrend 1D lãi ở cả 5 giai đoạn thị trường 1990-2026.
- Dashboard `/dashboard#backtest`: ma trận phương pháp × khung (15m/30m/1h/2h/4h/1D) với tỉ lệ thắng, R/lệnh, profit factor, đối chứng ngẫu nhiên. Bot tự cập nhật báo cáo hằng tuần ở tiến trình riêng; chạy tay: `npm run backtest:report`.
- Mục **Thống kê theo khoảng thời gian** trên tab báo cáo: chọn khoảng (1 tháng → 10 năm, từng năm, hoặc tự nhập ngày), khung, phương pháp; bảng xếp hạng theo tổng R / R/lệnh / tỉ lệ thắng / PF và biểu đồ R tích lũy so sánh tối đa 5 phương pháp. Số liệu tính lại từ danh sách lệnh lưu trong báo cáo (có Postgres thì từ toàn bộ lệnh cộng dồn qua các lần tạo báo cáo, xem mục 4); báo cáo tạo bằng phiên bản cũ được bot tự tạo lại khi khởi động.
- Mục **Theo tháng** trên tab báo cáo: tỉ lệ thắng và tổng R từng tháng của năm hiện tại (có Postgres thì chọn được cả các năm trước) cho mỗi phương pháp đang bật, kèm dòng gộp theo quy trình bot ở mỗi khung và dòng toàn bot. Khung 15m của Vàng lấy dữ liệu Binance Futures XAUUSDT (lọc theo giờ giao dịch OANDA) vì TradingView ẩn danh chỉ có ~5.500 nến 15m. Tạo cùng lịch với báo cáo backtest; chạy tay: `npm run backtest:monthly` hoặc `node scripts/backtestMonthly.js XAU/USD --year 2026`.
- Mục **Theo ngày** ngay bên dưới: chọn một tháng, mỗi dòng là một ngày (giờ VN) với tổng R và số lệnh chạm TP1 ở từng khung (theo quy trình bot) và toàn bot, rê chuột vào ô để xem từng lệnh (giờ vào, chiều, phương pháp, kết quả); cuối bảng có số ngày lãi/lỗ. In bảng theo ngày ra màn hình: `npm run backtest:daily` (tháng gần nhất) hoặc `node scripts/backtestMonthly.js --year 2025 --days 3`.
- Mục **Kiểm tra tín hiệu theo ngày**: chọn một ngày (mặc định hôm nay, hoặc bấm vào ngày trong bảng theo ngày) để chạy các phương pháp đang bật theo đúng quy trình bot trên dữ liệu mới nhất: tín hiệu bot sẽ phát (giờ vào, entry, SL, TP1, kết quả tới hiện tại), tín hiệu riêng của từng phương pháp bị bot lọc kèm lý do (ngược chiều cùng nến, cooldown) và tín hiệu bot thật đã ghi nhận để đối chiếu. Chạy tay: `npm run backtest:day` (hôm nay) hoặc `npm run backtest:day -- 22/10` (cũng nhận `22/10/2025`, `2025-10-22`); có Postgres thì mỗi lần chạy tay được lưu lại (xem mục 4). Chạy tay cũng bổ sung các tín hiệu bot sẽ phát vào **Danh sách tín hiệu** (nhãn "backtest", lọc bằng ô "Nguồn") để có dữ liệu những ngày bot chưa chạy: chống trùng theo mã tín hiệu như bot thật (tài sản | chiều | giờ nến), đã có tín hiệu bot thật thì bỏ qua, chạy lại chỉ cập nhật kết quả lệnh còn mở. Tín hiệu bổ sung chưa qua bộ lọc AI và chặn tin tức.
- Backtest dòng lệnh: `npm run backtest` (theo `STRATEGIES`), hoặc `node scripts/backtest.js XAU/USD --timeframe 4h --strategies donchian-55`.

### 4. Lưu Trữ Lâu Dài Bằng PostgreSQL:
Đặt `DATABASE_URL` trong `.env` để lưu tín hiệu và báo cáo vào Postgres có sẵn (Supabase, Neon, RDS, server riêng...). Bot tự tạo bảng ở lần chạy đầu và chuyển dữ liệu đang có trong `data/*.json` sang; file JSON vẫn được ghi song song làm bản dự phòng. Bỏ trống `DATABASE_URL` thì bot chạy như cũ, chỉ dùng file JSON.

```env
DATABASE_URL=postgres://user:password@host:5432/dbname?sslmode=require
# Nhà cung cấp dùng chứng chỉ riêng (vd: Supabase) mà gặp lỗi "self-signed certificate": đổi thành sslmode=no-verify
```

| Bảng | Nội dung |
| --- | --- |
| `signals` | Tín hiệu bot đã phát (hoặc AI từ chối) và kết quả TP1/SL/hết hạn; cột `data` là bản ghi đầy đủ, `r_multiple` là R của lệnh đã đóng, `origin` là `'bot'` (bot thật) hoặc `'backtest'` (bổ sung bằng `npm run backtest:day`) |
| `backtest_runs` | Mỗi lần tạo báo cáo backtest là một bản riêng, không ghi đè: `kind = 'report'` tổng hợp, `'monthly'` theo tháng của `year`, `'day'` kết quả `npm run backtest:day` (mỗi ngày mỗi tài sản một dòng, chạy lại thì thay bằng lần mới nhất; ngày ở `payload->>'day'`) |
| `backtest_trades` | Từng lệnh backtest của báo cáo tổng hợp, cộng dồn qua các lần chạy nên giữ được cả giai đoạn TradingView ẩn danh không còn trả về (15m chỉ ~2 tháng gần nhất) |

- Mỗi lần chạy, lệnh trong khoảng dữ liệu của lần đó được thay bằng kết quả mới nhất, lệnh cũ hơn được giữ nguyên. Nếu sửa logic một phương pháp, lệnh cũ ngoài khoảng dữ liệu vẫn theo logic trước: muốn tính lại từ đầu thì xóa lệnh của phương pháp đó (`DELETE FROM backtest_trades WHERE strategy = 'donchian-55'`).
- Báo cáo theo tháng của năm trước được bot tự tạo lại một lần sau khi năm đó kết thúc để đủ các ngày cuối năm.
- Mất kết nối Postgres: bot vẫn chạy và ghi file JSON, phần chưa lưu được tự lưu bổ sung khi kết nối lại (hoặc ở lần khởi động sau).
- Ví dụ thống kê trực tiếp bằng SQL:

```sql
-- Tín hiệu bot thật đã gửi theo tháng (giờ VN) và phương pháp: số lệnh đã đóng, tỉ lệ thắng TP1 / (TP1 + SL), tổng R
-- (bỏ "AND origin = 'bot'" để tính cả tín hiệu bổ sung từ backtest)
SELECT date_trunc('month', candle_time AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS month, strategy, count(*) AS trades,
       round(avg((status = 'TP')::int) FILTER (WHERE status IN ('TP', 'SL')) * 100) AS win_pct,
       round(sum(r_multiple)::numeric, 2) AS total_r
FROM signals WHERE sent AND status <> 'OPEN' AND origin = 'bot' GROUP BY 1, 2 ORDER BY 1 DESC, 2;

-- Kết quả npm run backtest:day ngày 22/10/2026: số tín hiệu bot sẽ phát và số tín hiệu bot thật đã ghi nhận
SELECT payload->>'symbol' AS symbol, generated_at,
       (SELECT count(*) FROM jsonb_array_elements(payload->'timeframes') t, jsonb_array_elements(t->'signals')) AS signals,
       jsonb_array_length(payload->'live') AS live
FROM backtest_runs WHERE kind = 'day' AND payload->>'day' = '2026-10-22';

-- Backtest Donchian 55 khung 2h theo năm: số lệnh, tổng R sau chi phí
SELECT extract(year FROM entry_time AT TIME ZONE 'Asia/Ho_Chi_Minh') AS year, count(*) AS trades, round(sum(net_r)::numeric, 1) AS total_r
FROM backtest_trades WHERE symbol = 'XAU/USD' AND timeframe = '2h' AND strategy = 'donchian-55' GROUP BY 1 ORDER BY 1;
```

---

## 📁 Cấu Trúc Dự Án

```
gold-trading-bot/
├── .env                     # File cấu hình biến môi trường
├── .env.example             # Mẫu biến môi trường
├── package.json             # Khai báo dependency
├── bot.js                   # Entrypoint chính
└── src/
    ├── index.js             # Scheduler & khởi chạy bot
    ├── config.js            # Quản lý cấu hình tập trung
    ├── botEngine.js         # Điều phối quét nến, chạy chiến lược & AI
    ├── services/
    │   ├── marketData.js    # Tải dữ liệu nến từ Yahoo Finance v4
    │   ├── db.js            # Kết nối PostgreSQL (DATABASE_URL) & tạo bảng
    │   └── telegram.js      # Định dạng và gửi thông báo Telegram giàu Markdown
    ├── strategies/
    │   ├── baseStrategy.js  # Lớp cơ sở tính toán chỉ báo kỹ thuật
    │   ├── trendFollowing.js# Chiến lược Trend Ribbon (EMA + MACD + RSI)
    │   ├── meanReversion.js # Chiến lược Bollinger Bands + RSI Extremes
    │   ├── breakoutAtr.js   # Chiến lược Volatility Breakout
    │   ├── smcOrderBlock.js # Chiến lược SMC Fair Value Gap & OB
    │   └── index.js         # Tổng hợp các chiến lược
    └── ai/
        ├── prompts.js       # Prompt tài chính tối ưu cho AI
        └── geminiAnalyzer.js# Gọi Google Gemini thẩm định tín hiệu
```

---

## 🚀 Hướng Dẫn Cài Đặt & Chạy

### 1. Cài đặt thư viện:
```bash
pnpm install
# hoặc: npm install
```

### 2. Cấu hình file `.env`:
Tạo file `.env` (hoặc sao chép từ `.env.example`):
```env
# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

# Thị trường & Nguồn dữ liệu
SYMBOL=XAU/USD
TIMEFRAME=15m
CRON_SCHEDULE=*/5 * * * *
MARKET_DATA_SOURCE=TRADINGVIEW
TRADINGVIEW_SYMBOL=OANDA:XAUUSD

# Trợ lý AI (Google Gemini - Hỗ trợ 1 hoặc nhiều key phân tách bởi dấu phẩy)
GEMINI_API_KEYS=gemini_key_1,gemini_key_2,gemini_key_3
GEMINI_MODEL=gemini-3.8-flash
AI_MIN_CONFIDENCE=75
```

---

## 🌐 Hướng Dẫn Deploy Lên Server Chạy 24/24

### Lựa chọn 1: Tự động Deploy lên VPS Linux (Khuyên dùng)
Dự án đã tích hợp sẵn script tự động rsync mã nguồn, cài đặt Node.js, pnpm và PM2 lên VPS:
```bash
./deploy.sh
```
Script sẽ hỏi IP VPS, Username SSH và tự động cấu hình PM2 tự khởi động cùng hệ thống khi reboot.

### Lựa chọn 2: Chạy bằng Docker & Docker Compose (Rất tiện lợi)
Nếu VPS của bạn đã cài sẵn Docker:
```bash
# Khởi chạy ngầm bot trong container
docker compose up -d

# Xem log trực tiếp
docker compose logs -f

# Khởi động lại hoặc dừng
docker compose restart
docker compose down
```

### Lựa chọn 3: Triển khai thủ công bằng PM2 trên Server
```bash
# 1. Cài đặt PM2
npm install -g pm2

# 2. Khởi chạy bot thông qua ecosystem
pm2 start ecosystem.config.js

# 3. Xem log thời gian thực
pm2 logs gold-trading-bot

# 4. Lưu lại để server khởi động lại vẫn tự chạy
pm2 save
pm2 startup
```

### Lựa chọn 4: Deploy Miễn Phí lên Cloud (Render.com / Railway / Koyeb)
Bot đã tích hợp sẵn Express dummy server (port 3000):
1. Đẩy mã nguồn lên GitHub (Private repo).
2. Đăng nhập [Render.com](https://render.com) -> Tạo **New Web Service**.
3. Chọn repo GitHub của bot -> Chọn Runtime **Node**.
4. Cài đặt Build Command: `npm install` hoặc `pnpm install`.
5. Start Command: `node bot.js`.
6. Thêm các biến môi trường từ `.env` vào mục **Environment Variables** trên Render.
7. Nhấn **Deploy Web Service** -> Bot sẽ chạy 24/7 hoàn toàn miễn phí.


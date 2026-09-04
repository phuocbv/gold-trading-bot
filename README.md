# Gold Trading Bot (Node.js AI Co-Pilot)

Hệ thống tự động phân tích thị trường Vàng (Gold Forex / XAU/USD - GC=F) theo thời gian thực kết hợp **Đa Chiến Lược Kỹ Thuật (Multi-Strategy)** và **Trợ Lý AI (Google Gemini)** thẩm định bẫy giá và phát tín hiệu chất lượng cao về Telegram.

---

## 🌟 Tính Năng Nổi Bật

### 1. 4 Phương Pháp Phân Tích Kỹ Thuật Chuyên Nghiệp:
- 📈 **Trend Following (Bám Xu Hướng)**: Kết hợp EMA Ribbon (20/50/200), MACD Crossover và RSI pullback để bắt sóng thuận trend lớn.
- 🔄 **Mean Reversion (Đảo Chiều Ngắn Hạn)**: Dùng Bollinger Bands (20, 2) + RSI quá mua/quá bán kết hợp nến rút chân/đảo chiều khi thị trường sideway.
- 💥 **Volatility Breakout (Bùng Nổ Biên Độ)**: Phá vỡ đỉnh/đáy 20 nến (Donchian Range) kèm biên độ nến vượt 1.2x ATR.
- 🏛 **SMC Lite (Smart Money Concepts)**: Nhận diện khoảng trống FVG (Fair Value Gap) và phản ứng khi giá retest khối lệnh Order Block.

### 2. Trợ Lý AI Thẩm Định (Google Gemini):
- Đóng vai trò Senior Quant Trader: Đánh giá bẫy giá (Bull/Bear Trap, Liquidity Sweep), kiểm tra cản cứng S/R.
- Chấm điểm **Confidence Score (0-100%)**: Chỉ duyệt phát lệnh Telegram khi độ tin cậy đạt mức tối thiểu (mặc định $\ge 75\%$).
- Tự động fallback chạy chế độ kỹ thuật thuần nếu chưa điền API Key hoặc khi mạng gián đoạn.
- Bản tin thị trường định kỳ (AI Briefing) trước các phiên giao dịch chính (Âu 13:00, Mỹ 19:30).

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

# Thị trường
SYMBOL=XAU/USD
TIMEFRAME=15m
CRON_SCHEDULE=*/5 * * * *

# Trợ lý AI (Google Gemini)
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.7-flash
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


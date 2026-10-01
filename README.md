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
- **Cơ chế Multi-Key Pool**: Hỗ trợ nhiều API Key đồng thời, tự động xoay tua (Round-Robin) chia tải và tự động chuyển key (Instant Failover + Cooldown 60s) khi chạm Rate Limit 429 hoặc hết quota Free Tier.
- Tự động fallback chạy chế độ kỹ thuật thuần nếu chưa điền API Key hoặc khi mạng gián đoạn.
- Bản tin thị trường định kỳ (AI Briefing) trước các phiên giao dịch chính (Âu 13:00, Mỹ 19:30).

### 3. Bot Scalping 1 Phút (1-Minute One-Price Scalper - `feat/add-trade-one-price`):
- ⚡ **Phân tích theo từng phút (Khung 1m)**: Kết hợp EMA Ribbon ngắn hạn (EMA 9/21/50), RSI(14), Stochastic RSI và mô hình nến Price Action vi mô.
- 🎯 **Quy tắc Chốt Lời Cố Định 1 Giá (+1.00 USD)**: "Cứ được 1 giá là đóng lệnh". Ngay khi giá chạy đúng 1 giá theo chiều lệnh, bot tự động kích hoạt đóng lệnh chốt lời.
- 🛡 **Mức Cắt Lỗ (Stop Loss) Tùy Chỉnh**: Người dùng dễ dàng cài đặt mức cắt lỗ mong muốn trong `.env` (`SCALP_STOP_LOSS=1.5` hoặc 1.0, 2.0 giá).
- 🕒 **Giám Sát Giá Realtime Từng Giây**: Vòng lặp kiểm tra giá tick trực tiếp (<300ms) liên tục, lập tức phát hiện thời điểm chạm TP/SL để đóng lệnh và gửi báo cáo Telegram.
- 📊 **Quản Lý Vị Thế & Nhật Ký Giao Dịch (Position Tracker)**: Tự động lưu trạng thái bền vững (State Persistence), ngăn ngừa nhồi lệnh rủi ro, theo dõi Win Rate và tổng PnL tích lũy.

---

## 📁 Cấu Trúc Dự Án

```
gold-trading-bot/
├── .env                     # File cấu hình biến môi trường
├── .env.example             # Mẫu biến môi trường
├── package.json             # Khai báo dependency
├── bot.js                   # Entrypoint chính (Bot Swing/Daytrade)
├── bot-scalp.js             # Entrypoint riêng cho Bot Scalping 1 Phút (1 Giá)
└── src/
    ├── index.js             # Scheduler & khởi chạy bot chính
    ├── config.js            # Quản lý cấu hình tập trung
    ├── botEngine.js         # Điều phối quét nến, chạy chiến lược & AI
    ├── scalper/
    │   ├── scalpStrategy.js # Chiến lược vi mô 1m (Micro-Momentum, BB, StochRSI)
    │   ├── positionTracker.js # Quản lý vị thế, kiểm tra TP +1 giá / SL, ghi nhật ký
    │   └── scalpEngine.js   # Điều phối quét nến 1m & giám sát tick realtime
    ├── services/
    │   ├── marketData.js    # Tải nến & giá tick realtime từ Binance / Gate.io
    │   └── telegram.js      # Gửi thông báo Telegram (Swing + Scalp Alert)
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

# Cấu hình Bot Scalping 1 Phút (Chốt lời 1 giá - Cắt lỗ tùy chỉnh)
SCALP_TAKE_PROFIT=1.0
SCALP_STOP_LOSS=1.5
SCALP_CHECK_INTERVAL_SEC=3
SCALP_MIN_SCORE=70
SCALP_PORT=3001
```

### 3. Khởi chạy Bot:
- **Chạy Bot Scalping 1 Phút (Chốt lời 1 giá):**
```bash
pnpm run scalp
# hoặc: node bot-scalp.js
```

- **Chạy Bot Phân Tích Swing / Daytrade chính (Khung 15m/1h):**
```bash
pnpm start
# hoặc: node bot.js
```

- **Chạy song song cả 2 Bot trên cùng 1 máy bằng PM2:**
```bash
pm2 start ecosystem.config.js
```

---

## 🔌 Hướng Dẫn Kết Nối Tài Khoản Exness MT5 Auto Trade (2 Giải Pháp)

> 📖 **Xem tài liệu chi tiết đầy đủ tại:** [docs/EXNESS_MT5_INTEGRATION.md](docs/EXNESS_MT5_INTEGRATION.md)

### 🌟 Giải Pháp 1: Kết Nối Qua MetaApi Cloud (Treo Bot 24/7 Không Cần Mở Máy Tính)
Dành cho bạn muốn chạy bot trên VPS hoặc tắt máy tính mà bot vẫn tự động đánh vào tài khoản Demo/Real Exness (nhìn lệnh nhảy trên app MT5 điện thoại hoặc WebTerminal):

1. **Lấy đúng thông tin từ trang [my.exness.com](https://my.exness.com):**
   - Vào tab **Thử nghiệm (Demo)** $\to$ Bấm dấu `...` ở tài khoản $\to$ Chọn **Thông tin tài khoản**:
     - Xem đúng số **Login** và chính xác tên **Server** (Ví dụ: `Exness-MT5Trial6` - tránh chọn nhầm số đuôi).
     - Bấm **Đổi mật khẩu giao dịch** để đặt lại mật khẩu MT5 mới (tránh nhầm với mật khẩu web Exness).
2. **Đăng ký [app.metaapi.cloud](https://app.metaapi.cloud) (Miễn phí 1 tài khoản vĩnh viễn):**
   - Lấy `Token` tại mục **API Access**.
   - Bấm **Add Account**: Nhập Login, Server và Mật khẩu vừa đặt ở bước 1 $\to$ Bấm **Deploy** $\to$ Copy `Account ID`.
3. **Cấu hình file `.env`:**
   ```env
   META_API_TOKEN=your_meta_api_token
   META_API_ACCOUNT_ID=your_account_id
   EXNESS_SYMBOL=XAUUSD
   EXNESS_LOT_SIZE=0.01
   ```
4. **Khởi động Bot:**
   ```bash
   pnpm run scalp
   ```

---

### 🌟 Giải Pháp 2: Cài EA Bridge Trực Tiếp Vào MT5 Desktop (100% Miễn Phí & Cục Bộ)
Dành cho bạn đã cài phần mềm MetaTrader 5 trên máy tính (không cần đăng ký tài khoản đám mây trung gian nào):

1. Mở phần mềm MT5 $\to$ Menu **File** $\to$ **Open Data Folder** $\to$ vào thư mục `MQL5/Experts`.
2. Copy file `mt5/GoldScalpBridge.mq5` của dự án dán vào thư mục này.
3. Vào MT5 $\to$ Menu **Tools** $\to$ **Options** (`Ctrl + O`) $\to$ Tab **Expert Advisors**:
   - Tích chọn **Allow WebRequest for listed URL**.
   - Thêm URL: `http://127.0.0.1:3001` $\to$ Bấm **OK**.
4. Mở chart Vàng `XAUUSD` khung `M1` $\to$ Kéo file `GoldScalpBridge` từ Navigator vào biểu đồ $\to$ Bật nút **Algo Trading**.
5. Chạy bot trong terminal: `pnpm run scalp`. Lệnh sẽ tự động khớp và chốt lời đúng 1 giá ngay trên MT5 của bạn!

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


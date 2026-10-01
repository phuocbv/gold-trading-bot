# 🔌 HƯỚNG DẪN KẾT NỐI EXNESS METATRADER 5 AUTO TRADE (DEMO & REAL)

Tài liệu này ghi lại chi tiết toàn bộ quy trình thiết lập **Bot Scalping Vàng 1 Phút (One-Price Scalper)** kết nối tự động đánh và chốt lời 1 giá trên tài khoản **Exness MT5**.

---

## 🏗 KIẾN TRÚC HOẠT ĐỘNG (ARCHITECTURAL OVERVIEW)

```
┌─────────────────────────────────┐                 ┌─────────────────────────────────┐
│     Node.js Scalping Bot        │                 │    MetaTrader 5 Desktop (Mac)   │
│  (bot-scalp.js / scalpEngine)   │                 │   (Chart XAUUSD247m / M1)       │
├─────────────────────────────────┤                 ├─────────────────────────────────┤
│ • Quét nến 1m liên tục          │                 │ • EA: GoldScalpBridge.mq5       │
│ • Nhận diện tín hiệu vi mô      │                 │ • Lắng nghe mỗi 1 giây          │
│ • Theo dõi giá tick realtime    │  HTTP WebRequest│ • Gửi lệnh Market BUY/SELL      │
│ • Endpoint REST API:            │ <─────────────> │ • Đặt sẵn TP +1 giá / SL 3 giá  │
│   GET /api/mt5/order            │   Port: 3001    │ • Tự động khớp trên Exness      │
│ • Gửi báo cáo Telegram          │                 │ • Trực tiếp trên tài khoản Demo │
└─────────────────────────────────┘                 └─────────────────────────────────┘
```

---

## 🌟 GIẢI PHÁP KHUYÊN DÙNG: Cài EA Bridge Trực Tiếp Vào MT5 Desktop (100% Miễn Phí)

Phương án này chạy **cục bộ 100%**, không phải trả bất kỳ chi phí nào cho bên thứ 3 (như MetaApi), không lo lộ mật khẩu và khớp lệnh cực nhanh qua cổng `http://127.0.0.1:3001`.

### Bước 1: Vị trí thư mục EA trên macOS
Trên hệ điều hành macOS, phần mềm MetaTrader 5 chạy trong môi trường Wine, thư mục chứa EA nằm tại đường dẫn:
```bash
~/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Experts/
```

Dự án đã có sẵn file mã nguồn EA: [mt5/GoldScalpBridge.mq5](file:///Users/dacuoi/Documents/Trade/gold-trading-bot/mt5/GoldScalpBridge.mq5).
Để copy file vào thư mục MT5, chỉ cần chạy lệnh Terminal:
```bash
cp mt5/GoldScalpBridge.mq5 "$HOME/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Experts/GoldScalpBridge.mq5"
```

---

### Bước 2: Biên dịch EA trong MetaEditor (Quan trọng)
File `.mq5` là mã nguồn, MT5 cần biên dịch thành file chạy `.ex5`:
1. Mở phần mềm MT5 $\to$ Bấm phím **`F4`** (hoặc chọn menu **Tools** $\to$ **MetaQuotes Language Editor**).
2. Tại cột cây thư mục bên trái của MetaEditor, mở mục **`Experts`** $\to$ Nhấp đúp vào **`GoldScalpBridge.mq5`**.
3. Bấm nút **Compile** (biểu tượng dấu tích xanh, phím tắt **`F7`**).
4. Quan sát cửa sổ *Errors* bên dưới báo: `0 errors, 0 warnings` là biên dịch thành công!
5. Đóng MetaEditor lại để trở về giao diện chính của MT5.

---

### Bước 3: Cấp quyền WebRequest cho MT5
Để MT5 được phép lấy dữ liệu lệnh từ bot Node.js:
1. Trên menu chính của MT5, chọn: **Tools** $\to$ **Options** (phím tắt `Ctrl + O` hoặc `Cmd + ,`).
2. Chọn tab **Expert Advisors**:
   - Tích chọn ô: **Allow Algo Trading** (Cho phép giao dịch tự động).
   - Tích chọn ô: **Allow WebRequest for listed URL**.
   - Bấm nút **Add** (dấu `+` màu xanh) $\to$ Nhập URL: `http://127.0.0.1:3001`
   - Bấm **OK**.

---

### Bước 4: Gắn EA vào biểu đồ & Bật nút Algo Trading
1. Mở cửa sổ **Navigator** trong MT5 (nhấn `Ctrl + N`).
2. Chuột phải vào mục **Expert Advisors** $\to$ Chọn **Refresh**. Bạn sẽ thấy `GoldScalpBridge` xuất hiện.
3. Mở biểu đồ Vàng của Exness (Ví dụ: `XAUUSD`, `XAUUSDm` hoặc `XAUUSD247m`) khung thời gian **M1 (1 Phút)**.
4. Kéo thả file `GoldScalpBridge` từ Navigator vào biểu đồ:
   - Ở tab **Common**, tích chọn ô **Allow Algo Trading** $\to$ Bấm **OK**.
5. Nhìn lên thanh công cụ trên cùng của MT5, bấm nút **`Algo Trading`** để nút chuyển sang **màu XANH LÁ** ▶️.
6. Quan sát góc trên cùng bên phải của biểu đồ: Hiện dòng chữ **`GoldScalpBridge` kèm biểu tượng chiếc mũ học sĩ 🎓 màu xanh** là EA đã kích hoạt và sẵn sàng nhận lệnh!

---

### Bước 5: Khởi động Bot Scalping trong Terminal
Mở terminal tại thư mục dự án và chạy:
```bash
pnpm run scalp
```

---

## ⚙️ CÁC THÔNG SỐ CẤU HÌNH TRONG FILE `.env`

File [.env](file:///Users/dacuoi/Documents/Trade/gold-trading-bot/.env) điều khiển toàn bộ logic vào lệnh:

| Biến Cấu Hình | Mặc Định | Ý Nghĩa |
| :--- | :--- | :--- |
| `SCALP_TAKE_PROFIT` | `1.0` | Mục tiêu chốt lời đúng 1.00 giá (+$1.00 USD) |
| `SCALP_STOP_LOSS` | `3.0` | Mức cắt lỗ (tùy chỉnh: 1.5, 2.0 hoặc 3.0 giá) |
| `SCALP_CHECK_INTERVAL_SEC` | `3` | Chu kỳ giám sát giá realtime (mỗi 3 giây) |
| `SCALP_PORT` | `3001` | Cổng HTTP Web server cấp tín hiệu cho EA MT5 |
| `EXNESS_LOT_SIZE` | `0.01` | Khối lượng lệnh vào trên MT5 (0.01 lot an toàn) |
| `EXNESS_SYMBOL` | `XAUUSD` | Cặp tiền (EA tự động lấy theo mã chart hiện tại) |

---

## 🛠 HƯỚNG DẪN XỬ LÝ LỖI (TROUBLESHOOTING)

### 1. Lỗi: `Error: auto trading disabled by client`
* **Nguyên nhân:** Nút **Algo Trading** trên thanh công cụ của MT5 đang bị tắt (màu đỏ/xám), hoặc trong cài đặt của EA chưa tích ô *Allow Algo Trading*.
* **Cách sửa:**
  1. Bấm vào nút **Algo Trading** trên thanh công cụ MT5 chuyển sang màu **xanh lá**.
  2. Bấm phím **`F7`** trên chart Vàng $\to$ Tab *Common* $\to$ Tích chọn **Allow Algo Trading** $\to$ Bấm OK.

### 2. Lỗi: `Error: invalid stops`
* **Nguyên nhân:** Giá TP/SL bị lệch so với giá Bid/Ask thực tế của sàn Exness.
* **Cách sửa:** Phiên bản EA [GoldScalpBridge.mq5](file:///Users/dacuoi/Documents/Trade/gold-trading-bot/mt5/GoldScalpBridge.mq5) đã được cập nhật thuật toán:
  - Tự động lấy trực tiếp `SymbolInfoDouble(symbol, SYMBOL_ASK)` và `SYMBOL_BID` của MT5 tại giây vào lệnh.
  - Tự động cộng/trừ đúng `takeProfitPoints` và `stopLossPoints`.
  - Có cơ chế khớp Market trước rồi sửa SL/TP dự phòng, loại bỏ 100% lỗi này.
  *(Chỉ cần bấm `F4` $\to$ `F7` Compile lại file mới).*

### 3. Lỗi: `Error 4014 (ERR_WEBREQUEST_NOT_ALLOWED)`
* **Nguyên nhân:** Chưa thêm URL vào danh sách cho phép của MT5.
* **Cách sửa:** Vào `Tools` $\to$ `Options` $\to$ Tab `Expert Advisors` $\to$ Tích `Allow WebRequest` $\to$ Thêm `http://127.0.0.1:3001`.

### 4. Nhận diện các mã Vàng khác nhau của Exness:
* Tài khoản **Pro / Raw Spread / Zero**: Mã là `XAUUSD`.
* Tài khoản **Standard**: Mã là `XAUUSDm` (có chữ `m`).
* Tài khoản **24/7 (Giao dịch cả cuối tuần)**: Mã là `XAUUSD247m`.
* **Cơ chế của EA:** EA sử dụng biến hệ thống `_Symbol`, tự động phát hiện mã chart bạn thả vào, do đó tương thích với **tất cả mọi loại tài khoản của Exness** mà không cần sửa code!

---

## 🌟 GIẢI PHÁP PHỤ: Dùng MetaApi Cloud (Lưu ý về Chi Phí)
Nếu bạn muốn treo bot chạy 24/7 trên VPS mà không cần mở app MT5 trên máy tính:
- MetaApi yêu cầu nạp tiền trả phí dịch vụ cloud để "Deploy" terminal. Nếu bạn nạp credits, bạn chỉ cần điền `META_API_TOKEN` và `META_API_ACCOUNT_ID` vào `.env`.
- Nếu bạn không muốn mất phí: Hãy sử dụng **Giải Pháp EA Bridge cục bộ** ở trên, hoàn toàn miễn phí vĩnh viễn!

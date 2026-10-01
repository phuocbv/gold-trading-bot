//+------------------------------------------------------------------+
//|                                             GoldScalpBridge.mq5  |
//|                 Cầu nối Bot Node.js Auto Trade lên Exness MT5    |
//|                   (Tự động Mở lệnh & Chốt lời 1 giá trên MT5)   |
//+------------------------------------------------------------------+
#property copyright "Gold Trading Bot Scalper"
#property link      "https://github.com/phuocbv/gold-trading-bot"
#property version   "1.00"
#property description "EA tự động nhận tín hiệu từ Bot Node.js và khớp lệnh Demo/Real trên MT5"

#include <Trade\Trade.mqh>

// Input parameters
input string   InpServerUrl     = "http://127.0.0.1:3001/api/mt5/order"; // URL Bot Node.js
input double   InpLotSize       = 0.01;                                  // Khối lượng (Lot size)
input ulong    InpMagicNumber   = 888999;                                // Magic Number quản lý lệnh
input int      InpSlippage      = 20;                                    // Độ trượt giá (points)
input int      InpCheckTimerMs  = 1000;                                  // Chu kỳ kiểm tra lệnh (ms)

CTrade         ExtTrade;
string         ExtLastOrderId   = "";

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   ExtTrade.SetExpertMagicNumber(InpMagicNumber);
   ExtTrade.SetDeviationInPoints(InpSlippage);
   ExtTrade.SetTypeFilling(ORDER_FILLING_IOC);

   EventSetMillisecondTimer(InpCheckTimerMs);

   Print("========================================================");
   Print("🟢 [GoldScalpBridge] Khởi động thành công EA Auto Trade!");
   Print("📡 Kết nối tới Bot Node.js tại: ", InpServerUrl);
   Print("📦 Khối lượng đặt lệnh: ", DoubleToString(InpLotSize, 2), " lot");
   Print("⚠️ Lưu ý: Hãy bật 'Allow WebRequest' trong MT5 Tools -> Options -> Expert Advisors");
   Print("   và thêm URL: http://127.0.0.1:3001");
   Print("========================================================");

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("🛑 [GoldScalpBridge] Đã dừng EA Auto Trade.");
}

//+------------------------------------------------------------------+
//| Timer event function                                             |
//+------------------------------------------------------------------+
void OnTimer()
{
   CheckAndExecuteSignal();
}

//+------------------------------------------------------------------+
//| Gửi yêu cầu HTTP lấy lệnh từ Bot Node.js                         |
//+------------------------------------------------------------------+
void CheckAndExecuteSignal()
{
   char postData[];
   char result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";

   string symbol = _Symbol;
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if (digits <= 0) digits = _Digits;
   double ask = NormalizeDouble(SymbolInfoDouble(symbol, SYMBOL_ASK), digits);
   double bid = NormalizeDouble(SymbolInfoDouble(symbol, SYMBOL_BID), digits);

   // Gửi GET request kèm giá tick realtime của sàn MT5 để đồng bộ với Bot Node.js
   string requestUrl = InpServerUrl + "?symbol=" + symbol +
                       "&bid=" + DoubleToString(bid, digits) +
                       "&ask=" + DoubleToString(ask, digits);

   int res = WebRequest("GET", requestUrl, headers, 2000, postData, result, resultHeaders);

   if (res == -1)
   {
      int err = GetLastError();
      if (err == 4014) // ERR_WEBREQUEST_NOT_ALLOWED
      {
         Print("❌ Lỗi 4014: Chưa cấp quyền WebRequest! Vào MT5 -> Tools -> Options -> Expert Advisors -> Tích 'Allow WebRequest' và thêm: http://127.0.0.1:3001");
      }
      return;
   }

   string responseText = CharArrayToString(result);
   if (StringLen(responseText) == 0) return;

   // Phân tích JSON đơn giản
   if (StringFind(responseText, "\"hasOrder\":true") < 0)
   {
      return; // Hiện chưa có lệnh mới
   }

   string orderId = ExtractJsonString(responseText, "id");
   if (orderId == "" || orderId == ExtLastOrderId)
   {
      return; // Lệnh này đã khớp rồi, bỏ qua
   }

   string action = ExtractJsonString(responseText, "action");
   double tpPoints = ExtractJsonDouble(responseText, "takeProfitPoints");
   double slPoints = ExtractJsonDouble(responseText, "stopLossPoints");
   if (tpPoints <= 0) tpPoints = 1.0;
   if (slPoints <= 0) slPoints = 3.0;

   double lotSize = ExtractJsonDouble(responseText, "lotSize");
   if (lotSize <= 0) lotSize = InpLotSize;

   // Kiểm tra xem đã có lệnh nào mở của EA này chưa
   if (PositionsTotal() > 0)
   {
      for (int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong ticket = PositionGetTicket(i);
         if (ticket > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
         {
            return; // Đang có lệnh chạy, không mở thêm
         }
      }
   }

   // Cập nhật lại giá Ask/Bid mới nhất
   ask = NormalizeDouble(SymbolInfoDouble(symbol, SYMBOL_ASK), digits);
   bid = NormalizeDouble(SymbolInfoDouble(symbol, SYMBOL_BID), digits);

   // Tính Take Profit và Stop Loss trực tiếp từ giá khớp lệnh của sàn MT5
   double tp = 0;
   double sl = 0;
   if (action == "BUY")
   {
      tp = NormalizeDouble(ask + tpPoints, digits);
      sl = NormalizeDouble(ask - slPoints, digits);
   }
   else if (action == "SELL")
   {
      tp = NormalizeDouble(bid - tpPoints, digits);
      sl = NormalizeDouble(bid + slPoints, digits);
   }

   // Thực thi lệnh Mua / Bán trên MT5
   bool orderSuccess = false;
   if (action == "BUY")
   {
      orderSuccess = ExtTrade.Buy(lotSize, symbol, ask, sl, tp, "Scalp 1M Gold Bot");
      if (!orderSuccess)
      {
         // Dự phòng khớp lệnh Market trước rồi sửa SL/TP sau (dành cho chế độ Market Execution của Exness)
         if (ExtTrade.Buy(lotSize, symbol, ask, 0, 0, "Scalp 1M Gold Bot"))
         {
            orderSuccess = true;
            ulong ticket = ExtTrade.ResultOrder();
            ExtTrade.PositionModify(ticket, sl, tp);
         }
      }

      if (orderSuccess)
      {
         ExtLastOrderId = orderId;
         Print("🚀 [MT5 AUTO TRADE] ĐÃ KHỚP LỆNH BUY ", DoubleToString(lotSize, 2), " lot ", symbol, " @ ", ask, " | TP (+", tpPoints, " giá): ", tp, " | SL (-", slPoints, " giá): ", sl);
      }
      else
      {
         Print("❌ [MT5 AUTO TRADE] Mở lệnh BUY thất bại! Error: ", ExtTrade.ResultRetcodeDescription());
      }
   }
   else if (action == "SELL")
   {
      orderSuccess = ExtTrade.Sell(lotSize, symbol, bid, sl, tp, "Scalp 1M Gold Bot");
      if (!orderSuccess)
      {
         if (ExtTrade.Sell(lotSize, symbol, bid, 0, 0, "Scalp 1M Gold Bot"))
         {
            orderSuccess = true;
            ulong ticket = ExtTrade.ResultOrder();
            ExtTrade.PositionModify(ticket, sl, tp);
         }
      }

      if (orderSuccess)
      {
         ExtLastOrderId = orderId;
         Print("🔻 [MT5 AUTO TRADE] ĐÃ KHỚP LỆNH SELL ", DoubleToString(lotSize, 2), " lot ", symbol, " @ ", bid, " | TP (+", tpPoints, " giá): ", tp, " | SL (-", slPoints, " giá): ", sl);
      }
      else
      {
         Print("❌ [MT5 AUTO TRADE] Mở lệnh SELL thất bại! Error: ", ExtTrade.ResultRetcodeDescription());
      }
   }
}

//+------------------------------------------------------------------+
//| Helper trích xuất String từ chuỗi JSON                           |
//+------------------------------------------------------------------+
string ExtractJsonString(string json, string key)
{
   string search = "\"" + key + "\":\"";
   int pos = StringFind(json, search);
   if (pos < 0) return "";
   pos += StringLen(search);
   int endPos = StringFind(json, "\"", pos);
   if (endPos < 0) return "";
   return StringSubstr(json, pos, endPos - pos);
}

//+------------------------------------------------------------------+
//| Helper trích xuất Double từ chuỗi JSON                           |
//+------------------------------------------------------------------+
double ExtractJsonDouble(string json, string key)
{
   string search = "\"" + key + "\":";
   int pos = StringFind(json, search);
   if (pos < 0) return 0;
   pos += StringLen(search);
   int endPos = StringFind(json, ",", pos);
   if (endPos < 0) endPos = StringFind(json, "}", pos);
   if (endPos < 0) return 0;
   string valStr = StringSubstr(json, pos, endPos - pos);
   StringTrimLeft(valStr);
   StringTrimRight(valStr);
   return StringToDouble(valStr);
}
//+------------------------------------------------------------------+

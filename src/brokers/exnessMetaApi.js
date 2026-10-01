const MetaApi = require('metaapi.cloud-sdk').default;

/**
 * Exness MT5 Broker Connector qua MetaApi Cloud
 * Cho phép bot Node.js đặt lệnh Mua/Bán và đóng lệnh trực tiếp trên tài khoản Exness MT5
 */
class ExnessMetaApiBroker {
  constructor(config = {}) {
    this.token = config.token || process.env.META_API_TOKEN;
    this.accountId = config.accountId || process.env.META_API_ACCOUNT_ID;
    this.symbol = config.symbol || process.env.EXNESS_SYMBOL || 'XAUUSD';
    this.defaultLots = parseFloat(config.lots || process.env.EXNESS_LOT_SIZE || '0.01');

    this.api = null;
    this.account = null;
    this.connection = null;
    this.isReady = false;
    this.isConnecting = false;
  }

  isEnabled() {
    return Boolean(this.token && this.accountId && !this.token.includes('YOUR_META_API'));
  }

  /**
   * Khởi tạo và đồng bộ kết nối với terminal MT5 trên Cloud
   */
  async init() {
    if (!this.isEnabled()) {
      return false;
    }

    if (this.isReady && this.connection) {
      return true;
    }

    if (this.isConnecting) return false;
    this.isConnecting = true;

    try {
      console.log('🔄 [Exness MT5] Đang kết nối tới MetaApi Cloud Terminal...');
      this.api = new MetaApi(this.token);
      this.account = await this.api.metatraderAccountApi.getAccount(this.accountId);

      // Đảm bảo account đã deploy
      if (this.account.state !== 'DEPLOYED') {
        console.log('⏳ [Exness MT5] Đang khởi động Cloud Terminal MT5...');
        await this.account.deploy();
      }

      this.connection = this.account.getRPCConnection();
      await this.connection.connect();
      await this.connection.waitSynchronized();

      const accountInfo = await this.connection.getAccountInformation();

      // Tự động nhận diện mã Vàng của tài khoản (XAUUSD hoặc XAUUSDm cho Exness Standard)
      try {
        const symbols = await this.connection.getSymbols();
        if (Array.isArray(symbols) && symbols.length > 0) {
          if (!symbols.includes(this.symbol)) {
            if (symbols.includes('XAUUSDm')) {
              console.log(`ℹ️ [Exness MT5] Phát hiện tài khoản dùng mã 'XAUUSDm' (Exness Standard), tự động chuyển sang XAUUSDm.`);
              this.symbol = 'XAUUSDm';
            } else if (symbols.includes('XAUUSD')) {
              this.symbol = 'XAUUSD';
            }
          }
        }
      } catch (symErr) {}

      this.isReady = true;

      console.log('====================================================');
      console.log('🟢 [Exness MT5] KẾT NỐI TÀI KHOẢN MT5 THÀNH CÔNG!');
      console.log(`👤 Số tài khoản (Login): ${accountInfo.login} (${accountInfo.server})`);
      console.log(`💵 Số dư (Balance): $${accountInfo.balance.toFixed(2)} | Vốn (Equity): $${accountInfo.equity.toFixed(2)}`);
      console.log(`📊 Đòn bẩy (Leverage): 1:${accountInfo.leverage} | Cặp giao dịch: ${this.symbol}`);
      console.log(`📦 Khối lượng mặc định: ${this.defaultLots} lot`);
      console.log('====================================================\n');

      return true;
    } catch (err) {
      console.error('❌ [Exness MT5] Lỗi kết nối tài khoản MT5:', err.message);
      this.isReady = false;
      return false;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Mở lệnh Mua (BUY) hoặc Bán (SELL) trên MT5
   */
  async openMarketOrder(action, entryPrice, stopLoss, takeProfit, lotSize = null) {
    if (!this.isReady || !this.connection) {
      throw new Error('Chưa kết nối tới Exness MT5');
    }

    const lots = lotSize || this.defaultLots;
    const isBuy = action.toUpperCase() === 'BUY';

    try {
      console.log(`⚡ [Exness MT5] Đang gửi lệnh ${action} ${lots} lot ${this.symbol} lên sàn Exness...`);

      let result;
      if (isBuy) {
        result = await this.connection.createMarketBuyOrder(
          this.symbol,
          lots,
          stopLoss ? parseFloat(stopLoss.toFixed(2)) : undefined,
          takeProfit ? parseFloat(takeProfit.toFixed(2)) : undefined,
          { comment: 'Scalp 1M Gold Bot' }
        );
      } else {
        result = await this.connection.createMarketSellOrder(
          this.symbol,
          lots,
          stopLoss ? parseFloat(stopLoss.toFixed(2)) : undefined,
          takeProfit ? parseFloat(takeProfit.toFixed(2)) : undefined,
          { comment: 'Scalp 1M Gold Bot' }
        );
      }

      console.log(`✅ [Exness MT5] Khớp lệnh thành công! OrderID: ${result.orderId} | PositionID: ${result.positionId}`);
      return {
        success: true,
        orderId: result.orderId,
        positionId: result.positionId || result.orderId,
        numericCode: result.numericCode,
      };
    } catch (err) {
      console.error(`❌ [Exness MT5] Lỗi khi mở lệnh ${action}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Đóng một vị thế đang mở trên MT5
   */
  async closePosition(positionId) {
    if (!this.isReady || !this.connection) {
      throw new Error('Chưa kết nối tới Exness MT5');
    }

    try {
      console.log(`🛑 [Exness MT5] Đang gửi lệnh đóng vị thế Position ID: ${positionId}...`);
      const result = await this.connection.closePosition(positionId);
      console.log(`✅ [Exness MT5] Đã đóng vị thế thành công!`);
      return { success: true, result };
    } catch (err) {
      console.error(`❌ [Exness MT5] Lỗi khi đóng vị thế ${positionId}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Lấy thông tin tài khoản hiện tại
   */
  async getAccountInfo() {
    if (!this.isReady || !this.connection) return null;
    try {
      return await this.connection.getAccountInformation();
    } catch (e) {
      return null;
    }
  }

  /**
   * Lấy danh sách các vị thế đang mở
   */
  async getOpenPositions() {
    if (!this.isReady || !this.connection) return [];
    try {
      return await this.connection.getPositions();
    } catch (e) {
      return [];
    }
  }
}

module.exports = ExnessMetaApiBroker;

const { GoogleGenAI } = require('@google/genai');
const CONFIG = require('../config');
const { buildValidationPrompt, buildDigestPrompt } = require('./prompts');

/**
 * Che mờ API Key khi log để bảo vệ thông tin nhạy cảm
 */
function maskKey(key) {
  if (!key || typeof key !== 'string') return 'N/A';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Quản lý danh sách API Key với cơ chế Round-Robin, Failover và Cooldown khi bị Rate Limit
 */
class GeminiKeyPool {
  constructor(apiKeys = []) {
    this.currentIndex = 0;
    this.pool = (apiKeys || [])
      .map((key, idx) => {
        try {
          const client = new GoogleGenAI({ apiKey: key });
          return {
            index: idx + 1,
            key,
            masked: maskKey(key),
            client,
            cooldownUntil: 0,
            failCount: 0,
            successCount: 0,
          };
        } catch (err) {
          console.error(`❌ [AI] Không thể khởi tạo client cho key ${maskKey(key)}:`, err.message);
          return null;
        }
      })
      .filter(Boolean);
  }

  hasClients() {
    return this.pool.length > 0;
  }

  /**
   * Lấy danh sách key ứng viên theo chiến lược Round-Robin
   * Ưu tiên các key khỏe mạnh (không trong thời gian cooldown)
   */
  getCandidates() {
    if (this.pool.length === 0) return [];
    const count = this.pool.length;
    const now = Date.now();

    // Xoay tua bắt đầu từ currentIndex
    const ordered = [];
    for (let i = 0; i < count; i++) {
      const idx = (this.currentIndex + i) % count;
      ordered.push(this.pool[idx]);
    }

    // Tăng con trỏ vòng quay cho lượt request tiếp theo
    this.currentIndex = (this.currentIndex + 1) % count;

    // Tách nhóm: key sẵn sàng vs key đang cooldown
    const ready = ordered.filter((k) => k.cooldownUntil <= now);
    const cooling = ordered.filter((k) => k.cooldownUntil > now);

    // Sắp xếp key đang cooldown theo thời gian sắp hết hạn sớm nhất
    cooling.sort((a, b) => a.cooldownUntil - b.cooldownUntil);

    return [...ready, ...cooling];
  }

  /**
   * Đánh dấu key gặp Rate Limit (429 / Quota Exhausted) và đưa vào Cooldown
   */
  markRateLimited(keyIndex, cooldownMs = 60000) {
    const item = this.pool.find((k) => k.index === keyIndex);
    if (item) {
      item.cooldownUntil = Date.now() + cooldownMs;
      item.failCount++;
      const waitSec = Math.round(cooldownMs / 1000);
      console.warn(`⏳ [AI] Key #${item.index} (${item.masked}) đã bị Rate Limit (429/Quota). Tạm dừng sử dụng trong ${waitSec}s.`);
    }
  }

  /**
   * Ghi nhận lượt gọi thành công
   */
  markSuccess(keyIndex) {
    const item = this.pool.find((k) => k.index === keyIndex);
    if (item) {
      item.failCount = 0;
      item.successCount++;
    }
  }

  /**
   * Xem thống kê trạng thái các key trong pool
   */
  getStatus() {
    const now = Date.now();
    return {
      totalKeys: this.pool.length,
      keys: this.pool.map((k) => ({
        index: k.index,
        masked: k.masked,
        isCooling: k.cooldownUntil > now,
        cooldownRemainingSec: Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000)),
        successCount: k.successCount,
        failCount: k.failCount,
      })),
    };
  }
}

// Khởi tạo Key Pool từ danh sách keys trong cấu hình
const keyPool = new GeminiKeyPool(CONFIG.geminiApiKeys || (CONFIG.geminiApiKey ? [CONFIG.geminiApiKey] : []));

function getClient() {
  return keyPool.pool[0]?.client || null;
}

/**
 * Trích xuất chuỗi JSON từ phản hồi text của LLM
 */
function extractJson(text) {
  try {
    const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    // Thử regex tìm object {...}
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Không thể parse JSON từ AI response: ${text.substring(0, 100)}...`);
  }
}

/**
 * Danh sách model dự phòng theo thứ tự ưu tiên khi gặp lỗi 503 (quá tải) hoặc 429 (rate limit)
 */
function getModelCascade() {
  const models = [
    CONFIG.geminiModel,
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
  ].filter(Boolean);
  return [...new Set(models)];
}

/**
 * Gọi Gemini với cơ chế Đa Key (Pool xoay tua Round-Robin & Fallback tức thì khi 429)
 * kết hợp chuyển đổi Model dự phòng (Cascade)
 */
async function generateWithKeyPool(prompt) {
  if (!keyPool.hasClients()) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY hợp lệ trong hệ thống.');
  }

  const candidates = keyPool.getCandidates();
  const models = getModelCascade();
  let lastError = null;

  for (const candidate of candidates) {
    let keyHitRateLimit = false;

    for (const modelName of models) {
      if (keyHitRateLimit) break; // Key này đã dính 429, không thử tiếp model khác trên cùng key! Chuyển ngay sang key tiếp theo trong pool.

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await candidate.client.models.generateContent({
            model: modelName,
            contents: prompt,
          });
          const text = response.text ? response.text.trim() : (response.candidates?.[0]?.content?.parts?.[0]?.text || '');
          if (text) {
            keyPool.markSuccess(candidate.index);
            return {
              text,
              modelUsed: modelName,
              keyUsed: candidate.masked,
              keyIndex: candidate.index,
            };
          }
        } catch (err) {
          lastError = err;
          const errMsg = err.message || '';
          const isRateLimit = err.status === 429 ||
            errMsg.includes('429') ||
            errMsg.toLowerCase().includes('resource_exhausted') ||
            errMsg.toLowerCase().includes('quota') ||
            errMsg.toLowerCase().includes('rate limit') ||
            errMsg.toLowerCase().includes('too many requests');

          const isDemandSpike = err.status === 503 ||
            errMsg.includes('503') ||
            errMsg.toLowerCase().includes('high demand') ||
            errMsg.toLowerCase().includes('overloaded');

          if (isRateLimit) {
            console.warn(`⚠️ [AI] Key #${candidate.index} (${candidate.masked}) chạm hạn ngạch (429/Quota). Đang chuyển sang key dự phòng tiếp theo...`);
            keyPool.markRateLimited(candidate.index, 60000);
            keyHitRateLimit = true;
            break; // Thoát vòng lặp attempt để chuyển key
          } else if (isDemandSpike) {
            console.warn(`⚠️ [AI] Model ${modelName} gặp spike tải (${err.status || 503}) với Key #${candidate.index} (${candidate.masked}), đang thử lại...`);
            await new Promise((resolve) => setTimeout(resolve, 1500));
          } else {
            // Lỗi khác (ví dụ 404 model not found) thì chuyển sang model kế tiếp
            break;
          }
        }
      }
    }
  }

  throw lastError || new Error('Tất cả các API Key và Model AI trong pool đều bận hoặc không phản hồi.');
}

/**
 * Thẩm định tín hiệu giao dịch bằng Gemini AI
 */
async function validateTradeSignal(signal, marketSnapshot) {
  // Nếu không có API Key, fallback chế độ phân tích kỹ thuật thuần
  if (!keyPool.hasClients()) {
    return {
      approved: true,
      confidence: 80,
      trend: marketSnapshot.currentPrice > marketSnapshot.ema200 ? 'BULLISH' : 'BEARISH',
      support: marketSnapshot.recentLow,
      resistance: marketSnapshot.recentHigh,
      reasoning: 'Tín hiệu đạt chuẩn bộ lọc Phân tích Kỹ thuật (Chưa cấu hình GEMINI_API_KEY).',
      risk_warning: 'Quản lý vốn chặt chẽ.',
      mode: 'TECHNICAL_FALLBACK',
    };
  }

  try {
    const prompt = buildValidationPrompt(signal, marketSnapshot);
    const { text, modelUsed, keyUsed } = await generateWithKeyPool(prompt);
    const result = extractJson(text);

    // Kiểm tra tính hợp lệ
    return {
      approved: Boolean(result.approved) && (result.confidence || 0) >= CONFIG.aiMinConfidence,
      confidence: result.confidence || 75,
      trend: result.trend || 'N/A',
      support: result.support || marketSnapshot.recentLow,
      resistance: result.resistance || marketSnapshot.recentHigh,
      reasoning: result.reasoning || 'AI đã phê duyệt tín hiệu theo cấu trúc thị trường.',
      risk_warning: result.risk_warning || '',
      mode: 'AI_VALIDATED',
      modelUsed,
      keyUsed,
    };
  } catch (error) {
    console.error('⚠️ [AI] Lỗi khi gọi Gemini API thẩm định:', error.message);
    // Khi toàn bộ key gặp lỗi hoặc spike tải, fallback giữ nguyên tín hiệu kỹ thuật để không bỏ lỡ lệnh
    return {
      approved: true,
      confidence: 75,
      trend: marketSnapshot.currentPrice > marketSnapshot.ema200 ? 'BULLISH' : 'BEARISH',
      support: marketSnapshot.recentLow,
      resistance: marketSnapshot.recentHigh,
      reasoning: 'AI tạm thời quá tải hoặc hết hạn ngạch trên toàn bộ key, tự động duyệt theo chuẩn Kỹ thuật thuần.',
      mode: 'ERROR_FALLBACK',
    };
  }
}

/**
 * Tạo bản tin thị trường định kỳ
 */
async function generateMarketDigest(marketSnapshot) {
  if (!keyPool.hasClients()) return null;

  try {
    const prompt = buildDigestPrompt(marketSnapshot);
    const { text, modelUsed, keyUsed } = await generateWithKeyPool(prompt);
    const result = extractJson(text);

    return {
      currentPrice: marketSnapshot.currentPrice,
      trend: result.trend || 'N/A',
      support: result.support || marketSnapshot.recentLow,
      resistance: result.resistance || marketSnapshot.recentHigh,
      summary: result.summary || 'Không có nhận định chi tiết.',
      modelUsed,
      keyUsed,
    };
  } catch (error) {
    console.error('⚠️ [AI] Lỗi tạo bản tin thị trường:', error.message);
    return null;
  }
}

module.exports = {
  validateTradeSignal,
  generateMarketDigest,
  getKeyPoolStatus: () => keyPool.getStatus(),
  keyPool,
  maskKey,
  generateWithKeyPool,
};

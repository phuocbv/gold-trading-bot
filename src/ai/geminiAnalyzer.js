const { GoogleGenAI } = require('@google/genai');
const CONFIG = require('../config');
const { buildValidationPrompt, buildDigestPrompt } = require('./prompts');

let genAIClient = null;

function getClient() {
  if (!genAIClient && CONFIG.geminiApiKey && !CONFIG.geminiApiKey.includes('YOUR_GEMINI')) {
    try {
      genAIClient = new GoogleGenAI({ apiKey: CONFIG.geminiApiKey });
    } catch (err) {
      console.error('❌ [AI] Không thể khởi tạo GoogleGenAI:', err.message);
    }
  }
  return genAIClient;
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
 * Gọi Gemini với cơ chế tự động thử lại (Retry) và chuyển đổi Model dự phòng (Cascade)
 */
async function generateWithFallback(client, prompt) {
  const models = getModelCascade();
  let lastError = null;

  for (const modelName of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await client.models.generateContent({
          model: modelName,
          contents: prompt,
        });
        const text = response.text ? response.text.trim() : (response.candidates?.[0]?.content?.parts?.[0]?.text || '');
        if (text) {
          return { text, modelUsed: modelName };
        }
      } catch (err) {
        lastError = err;
        const errMsg = err.message || '';
        const isDemandSpike = err.status === 503 || errMsg.includes('503') || errMsg.includes('high demand');
        const isRateLimit = err.status === 429 || errMsg.includes('429');

        if (isDemandSpike || isRateLimit) {
          console.warn(`⚠️ [AI] Model ${modelName} gặp spike tải (${err.status || 503}), đang thử lại/chuyển model...`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } else {
          // Lỗi khác (ví dụ 404 model not found) thì chuyển ngay sang model kế tiếp
          break;
        }
      }
    }
  }

  throw lastError || new Error('Tất cả các model AI đều bận hoặc không phản hồi.');
}

/**
 * Thẩm định tín hiệu giao dịch bằng Gemini AI
 */
async function validateTradeSignal(signal, marketSnapshot) {
  const client = getClient();

  // Nếu không có API Key, fallback chế độ phân tích kỹ thuật thuần
  if (!client) {
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
    const { text, modelUsed } = await generateWithFallback(client, prompt);
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
    };
  } catch (error) {
    console.error('⚠️ [AI] Lỗi khi gọi Gemini API thẩm định:', error.message);
    // Khi AI gặp lỗi hoặc spike tải, fallback giữ nguyên tín hiệu kỹ thuật để không bỏ lỡ lệnh
    return {
      approved: true,
      confidence: 75,
      trend: marketSnapshot.currentPrice > marketSnapshot.ema200 ? 'BULLISH' : 'BEARISH',
      support: marketSnapshot.recentLow,
      resistance: marketSnapshot.recentHigh,
      reasoning: 'AI tạm thời quá tải do nhu cầu máy chủ tăng đột biến (Google 503 Spike), tự động duyệt theo chuẩn Kỹ thuật thuần.',
      mode: 'ERROR_FALLBACK',
    };
  }
}

/**
 * Tạo bản tin thị trường định kỳ
 */
async function generateMarketDigest(marketSnapshot) {
  const client = getClient();
  if (!client) return null;

  try {
    const prompt = buildDigestPrompt(marketSnapshot);
    const { text } = await generateWithFallback(client, prompt);
    const result = extractJson(text);

    return {
      currentPrice: marketSnapshot.currentPrice,
      trend: result.trend || 'N/A',
      support: result.support || marketSnapshot.recentLow,
      resistance: result.resistance || marketSnapshot.recentHigh,
      summary: result.summary || 'Không có nhận định chi tiết.',
    };
  } catch (error) {
    console.error('⚠️ [AI] Lỗi tạo bản tin thị trường:', error.message);
    return null;
  }
}

module.exports = {
  validateTradeSignal,
  generateMarketDigest,
};

const fs = require('fs');
const path = require('path');

/**
 * Đọc file JSON; trả về fallback nếu file chưa tồn tại.
 * File hỏng được đổi tên thành *.corrupt-<thời gian> để không bị ghi đè mất dữ liệu cũ.
 */
function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const backup = `${filePath}.corrupt-${Date.now()}`;
      console.error(`❌ [JsonStore] Không đọc được ${filePath} (${err.message}). Đã chuyển sang ${backup} và bắt đầu file mới.`);
      try {
        fs.renameSync(filePath, backup);
      } catch (e) {}
    }
    return fallback;
  }
}

/**
 * Ghi file JSON qua file tạm rồi đổi tên để file không bị hỏng nếu tiến trình dừng giữa chừng
 */
function writeJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error(`❌ [JsonStore] Lỗi ghi ${filePath}:`, err.message);
  }
}

module.exports = {
  readJson,
  writeJson,
};

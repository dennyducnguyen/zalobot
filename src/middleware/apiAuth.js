// =============================================
// Xác thực REST API — header X-API-Key (hoặc ?api_key=)
// Key quản lý trong bảng api_keys (trang Cài đặt)
// =============================================
const store = require('../db');

module.exports = function apiAuth(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key) {
        return res.status(401).json({
            success: false,
            error: { code: 'MISSING_API_KEY', message: 'Thiếu API key. Truyền qua header X-API-Key hoặc query ?api_key=' },
        });
    }
    const record = store.apiKeys.findActiveByKey(String(key));
    if (!record) {
        return res.status(401).json({
            success: false,
            error: { code: 'INVALID_API_KEY', message: 'API key không hợp lệ hoặc đã bị vô hiệu hóa' },
        });
    }
    store.apiKeys.touchLastUsed(record.id);
    req.apiKey = record;
    next();
};

// =============================================
// Xác thực web UI — cookie auth_token tra bảng auth_tokens
// =============================================
const store = require('../db');

module.exports = function webAuth(req, res, next) {
    const token = req.cookies?.auth_token;
    if (!token) {
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Chưa đăng nhập' } });
    }
    const record = store.tokens.findValid(token);
    if (!record) {
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Phiên đăng nhập hết hạn' } });
    }
    const user = store.users.findById(record.user_id);
    if (!user) {
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Tài khoản không tồn tại' } });
    }
    req.user = user;
    next();
};

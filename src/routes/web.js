// =============================================
// Routes /app/* — nội bộ cho web UI (inbox + cài đặt)
// Auth bằng cookie (webAuth), trừ /app/login
// =============================================
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const store = require('../db');
const config = require('../config');
const logger = require('../services/logger');
const zaloChannel = require('../services/zaloService');
const sse = require('../services/sse');
const webAuth = require('../middleware/webAuth');
const aiEngine = require('../services/ai/engine');

function ok(res, data) { res.json({ success: true, data }); }
function fail(res, code, message, status = 400) {
    res.status(status).json({ success: false, error: { code, message } });
}

// ==========================================
// Đăng nhập / đăng xuất web
// ==========================================
router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return fail(res, 'MISSING_PARAMS', 'Thiếu username hoặc password');

    const user = store.users.findByUsername(String(username).trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return fail(res, 'INVALID_CREDENTIALS', 'Sai tên đăng nhập hoặc mật khẩu', 401);
    }

    const token = uuidv4() + crypto.randomBytes(16).toString('hex');
    store.tokens.create(token, user.id, Date.now() + config.TOKEN_TTL_MS);
    store.tokens.purgeExpired();

    res.cookie('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: config.TOKEN_TTL_MS,
    });
    logger.info(`🔓 User đăng nhập web: ${user.username}`);
    ok(res, { user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
});

router.post('/logout', webAuth, (req, res) => {
    const token = req.cookies?.auth_token;
    if (token) store.tokens.remove(token);
    res.clearCookie('auth_token');
    ok(res, { message: 'Đã đăng xuất' });
});

// Từ đây trở xuống đều cần đăng nhập
router.use(webAuth);

router.get('/me', (req, res) => {
    ok(res, {
        user: req.user,
        app_name: config.APP_NAME,
        zalo: zaloChannel.status(),
    });
});

// ==========================================
// Kết nối Zalo (QR)
// ==========================================
router.post('/zalo/qr', async (req, res) => {
    try {
        const result = await zaloChannel.startQRLogin(req.body?.proxy || null);
        ok(res, { login_id: result.loginId });
    } catch (err) {
        logger.error('❌ [POST /app/zalo/qr]', err.message);
        fail(res, 'INTERNAL_ERROR', err.message, 500);
    }
});

router.get('/zalo/qr-image/:login_id', (req, res) => {
    const qrPath = path.join(config.ROOT, 'public', `qr_${req.params.login_id}.png`);
    if (fs.existsSync(qrPath)) {
        res.set('Cache-Control', 'no-store');
        res.sendFile(qrPath);
    } else {
        fail(res, 'QR_NOT_FOUND', 'QR chưa được tạo, thử lại sau 1-2 giây', 404);
    }
});

router.get('/zalo/qr-status/:login_id', (req, res) => {
    const loginData = zaloChannel.getLoginStatus(req.params.login_id);
    if (!loginData) return fail(res, 'LOGIN_NOT_FOUND', 'Phiên đăng nhập không tồn tại hoặc đã hết hạn', 404);
    if (loginData.status === 'failed') {
        return fail(res, 'QR_FAILED', loginData.error || 'Đăng nhập thất bại', 503);
    }
    ok(res, { status: loginData.status, zalo: loginData.status === 'success' ? zaloChannel.status() : null });
});

router.post('/zalo/logout', async (req, res) => {
    try {
        await zaloChannel.logoutZalo();
        ok(res, { message: 'Đã ngắt kết nối kênh Zalo' });
    } catch (err) {
        fail(res, 'INTERNAL_ERROR', err.message, 500);
    }
});

router.post('/zalo/sync', async (req, res) => {
    try {
        const result = await zaloChannel.syncContacts();
        ok(res, result);
    } catch (err) {
        fail(res, err.code || 'INTERNAL_ERROR', err.message, err.code === 'NOT_CONNECTED' ? 409 : 500);
    }
});

// ==========================================
// Hội thoại + tin nhắn
// ==========================================
// Trợ lý AI — routes /app/ai/* (cookie auth kế thừa từ router.use(webAuth) phía trên)
router.use('/ai', require('./ai'));

router.get('/threads', (req, res) => {
    const { search = '', type = '' } = req.query;
    ok(res, {
        threads: store.threads.list({ search: String(search), type: String(type) }),
        ai: aiEngine.threadStatesSummary(), // trạng thái AI theo thread để hiện icon 🤖/🙋
    });
});

router.get('/messages/:thread_id', (req, res) => {
    const threadId = req.params.thread_id;
    const beforeId = parseInt(req.query.before_id || '0', 10);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const thread = store.threads.get(threadId);
    ok(res, {
        thread,
        messages: store.messages.listByThread(threadId, beforeId, limit),
    });
});

router.post('/threads/:thread_id/read', (req, res) => {
    store.threads.resetUnread(req.params.thread_id);
    ok(res, {});
});

// Gửi tin từ UI: { thread_id, message?, image_base64? }
router.post('/send', async (req, res) => {
    try {
        const { thread_id, message, image_base64 } = req.body || {};
        if (!thread_id) return fail(res, 'MISSING_PARAMS', 'Thiếu thread_id');
        if (!message && !image_base64) return fail(res, 'MISSING_PARAMS', 'Cần message hoặc image_base64');

        let result;
        if (image_base64) {
            result = await zaloChannel.sendImage(thread_id, image_base64, message || '', 'web');
        } else {
            result = await zaloChannel.sendText(thread_id, message, 'web');
        }
        // Người thật vừa trả lời → Trợ lý AI tạm dừng trong thread này
        zaloChannel.emit('ai_human_reply', { threadId: String(thread_id), by: 'web' });
        ok(res, result);
    } catch (err) {
        logger.error('❌ [POST /app/send]', err.message);
        const status = err.code === 'SESSION_EXPIRED' || err.code === 'NOT_CONNECTED' ? 409 : 500;
        fail(res, err.code || 'INTERNAL_ERROR', err.message, status);
    }
});

// ==========================================
// API Keys — quản lý trong trang Cài đặt
// ==========================================
router.get('/api-keys', (req, res) => {
    ok(res, { keys: store.apiKeys.list() });
});

router.post('/api-keys', (req, res) => {
    const { name } = req.body || {};
    if (!name) return fail(res, 'MISSING_PARAMS', 'Thiếu tên (name) cho API key');
    const key = 'zik_' + crypto.randomBytes(24).toString('hex'); // zik = zalo-inbox key
    store.apiKeys.create(String(name).trim(), key);
    logger.info(`🔑 Tạo API key mới: ${name}`);
    ok(res, { name, api_key: key });
});

router.post('/api-keys/:id/toggle', (req, res) => {
    const list = store.apiKeys.list();
    const found = list.find(k => k.id === parseInt(req.params.id, 10));
    if (!found) return fail(res, 'NOT_FOUND', 'Không tìm thấy API key', 404);
    store.apiKeys.setActive(found.id, !found.is_active);
    ok(res, { id: found.id, is_active: !found.is_active });
});

router.delete('/api-keys/:id', (req, res) => {
    store.apiKeys.remove(parseInt(req.params.id, 10));
    ok(res, {});
});

// ==========================================
// Users — quản lý tài khoản đăng nhập web
// ==========================================
router.get('/users', (req, res) => {
    ok(res, { users: store.users.list() });
});

router.post('/users', (req, res) => {
    const { username, password, display_name } = req.body || {};
    if (!username || !password) return fail(res, 'MISSING_PARAMS', 'Thiếu username hoặc password');
    if (store.users.findByUsername(String(username).trim())) {
        return fail(res, 'DUPLICATE', 'Username đã tồn tại');
    }
    store.users.create(String(username).trim(), bcrypt.hashSync(password, 10), display_name || '');
    logger.info(`👤 Tạo user mới: ${username}`);
    ok(res, {});
});

router.post('/users/:id/password', (req, res) => {
    const { password } = req.body || {};
    if (!password) return fail(res, 'MISSING_PARAMS', 'Thiếu password mới');
    const target = store.users.findById(parseInt(req.params.id, 10));
    if (!target) return fail(res, 'NOT_FOUND', 'Không tìm thấy user', 404);
    store.users.updatePassword(target.id, bcrypt.hashSync(password, 10));
    ok(res, {});
});

router.delete('/users/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) return fail(res, 'FORBIDDEN', 'Không thể xóa chính mình');
    if (store.users.count() <= 1) return fail(res, 'FORBIDDEN', 'Phải còn ít nhất 1 tài khoản');
    store.users.remove(id);
    ok(res, {});
});

// ==========================================
// SSE — realtime tin nhắn mới + trạng thái kênh
// ==========================================
router.get('/events', (req, res) => {
    sse.addClient(res);
});

module.exports = router;

// =============================================
// REST API /api/v1/* — cho hệ thống bên ngoài gọi từ xa
// Auth: header X-API-Key (quản lý key trong trang Cài đặt)
// =============================================
const express = require('express');
const router = express.Router();

const store = require('../db');
const logger = require('../services/logger');
const zaloChannel = require('../services/zaloService');

function ok(res, data) { res.json({ success: true, data }); }
function fail(res, code, message, status = 400, extra = {}) {
    res.status(status).json({ success: false, error: { code, message, ...extra } });
}

function handleZaloError(res, err) {
    if (err.code === 'SESSION_EXPIRED' || err.code === 'NOT_CONNECTED') {
        return fail(res, err.code, err.message, 410, {
            connection_lost: true,
            reconnect: 'Đăng nhập web → quét QR kết nối lại kênh Zalo',
        });
    }
    fail(res, 'INTERNAL_ERROR', err.message, 500);
}

// ==========================================
// GET /api/v1/status — trạng thái kênh
// ==========================================
router.get('/status', (req, res) => {
    ok(res, zaloChannel.status());
});

// ==========================================
// POST /api/v1/send — gửi theo ID, TỰ nhận biết cá nhân/nhóm
// Body: { to, message?, image_url?, caption? }
//   - to: thread_id (ID cá nhân hoặc ID nhóm)
//   - message: nội dung text (bắt buộc nếu không có image_url)
//   - image_url: URL http(s) hoặc base64 data URI (data:image/...;base64,...)
//   - caption: chú thích kèm ảnh (tùy chọn)
// ==========================================
router.post('/send', async (req, res) => {
    try {
        const { to, message, image_url, caption } = req.body || {};
        if (!to) return fail(res, 'MISSING_PARAMS', 'Thiếu "to" (thread_id cá nhân hoặc nhóm)');
        if (!message && !image_url) return fail(res, 'MISSING_PARAMS', 'Cần "message" hoặc "image_url"');

        let result;
        if (image_url) {
            result = await zaloChannel.sendImage(to, image_url, caption || message || '', 'api');
        } else {
            result = await zaloChannel.sendText(to, message, 'api');
        }
        ok(res, {
            to: String(to),
            thread_type: result.thread_type, // đã tự nhận biết user/group
            message_id: result.message_row?.msg_id || String(result.message_row?.id || ''),
        });
    } catch (err) {
        logger.error('❌ [POST /api/v1/send]', err.message);
        handleZaloError(res, err);
    }
});

// ==========================================
// POST /api/v1/send-phone — tìm SĐT rồi gửi (text/hình)
// Body: { phone, message?, image_url?, caption? }
// ==========================================
router.post('/send-phone', async (req, res) => {
    try {
        const { phone, message, image_url, caption } = req.body || {};
        if (!phone) return fail(res, 'MISSING_PARAMS', 'Thiếu "phone"');
        if (!message && !image_url) return fail(res, 'MISSING_PARAMS', 'Cần "message" hoặc "image_url"');

        const findResult = await zaloChannel.findUserByPhone(String(phone));
        if (!findResult.success || !findResult.data?.uid) {
            return fail(res, 'USER_NOT_FOUND', `Không tìm thấy người dùng Zalo với SĐT ${phone}`, 404);
        }
        const uid = findResult.data.uid;

        let result;
        if (image_url) {
            result = await zaloChannel.sendImage(uid, image_url, caption || message || '', 'api', 'user');
        } else {
            result = await zaloChannel.sendText(uid, message, 'api', 'user');
        }
        ok(res, {
            user_found: {
                uid,
                display_name: findResult.data.display_name || '',
                avatar_url: findResult.data.avatar || '',
            },
            message_id: result.message_row?.msg_id || String(result.message_row?.id || ''),
        });
    } catch (err) {
        logger.error('❌ [POST /api/v1/send-phone]', err.message);
        handleZaloError(res, err);
    }
});

// ==========================================
// GET /api/v1/search?name=xxx — tìm theo tên trong danh bạ + hội thoại
// Trả list có ghi rõ type: 'user' (cá nhân) | 'group' (nhóm)
// Query: name (bắt buộc), type=user|group (tùy chọn), limit (mặc định 50)
// ==========================================
router.get('/search', (req, res) => {
    const { name, type, limit } = req.query;
    if (!name) return fail(res, 'MISSING_PARAMS', 'Thiếu query ?name=');

    let results = store.threads.searchByName(String(name), Math.min(parseInt(limit || '50', 10), 200));
    if (type === 'user' || type === 'group') {
        results = results.filter(r => r.type === type);
    }
    ok(res, {
        total: results.length,
        results: results.map(r => ({
            thread_id: r.thread_id,
            type: r.type, // 'user' = cá nhân, 'group' = nhóm
            name: r.name,
            avatar_url: r.avatar_url,
            phone: r.phone || '',
            is_contact: !!r.is_contact,
        })),
    });
});

// ==========================================
// GET /api/v1/find-phone?phone= — tìm user theo SĐT (không gửi tin)
// ==========================================
router.get('/find-phone', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return fail(res, 'MISSING_PARAMS', 'Thiếu query ?phone=');
        const findResult = await zaloChannel.findUserByPhone(String(phone));
        if (!findResult.success || !findResult.data?.uid) {
            return ok(res, { found: false, user: null });
        }
        ok(res, {
            found: true,
            user: {
                uid: findResult.data.uid,
                display_name: findResult.data.display_name || '',
                avatar_url: findResult.data.avatar || '',
            },
        });
    } catch (err) {
        logger.error('❌ [GET /api/v1/find-phone]', err.message);
        handleZaloError(res, err);
    }
});

module.exports = router;

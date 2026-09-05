// =============================================
// Zalo Inbox — Server Entry Point
// 1 domain = 1 kênh Zalo cá nhân
// Web trực chat (inbox) + REST API cho hệ thống ngoài
// =============================================
const config = require('./config');
const logger = require('./services/logger');

// Bắt lỗi process-level để server không crash
process.on('uncaughtException', (err) => {
    logger.error('⚠️ [UNCAUGHT EXCEPTION]', err.message || err, err.stack);
});
process.on('unhandledRejection', (reason) => {
    logger.error('⚠️ [UNHANDLED REJECTION]', reason?.message || reason);
});

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const bcrypt = require('bcryptjs');

const store = require('./db');
const zaloChannel = require('./services/zaloService');
const sse = require('./services/sse');
const webRoutes = require('./routes/web');
const apiRoutes = require('./routes/api');
const apiAuth = require('./middleware/apiAuth');

const app = express();
app.set('trust proxy', 'loopback');

// MCP/OAuth use smaller body limits and their own auth, before generic web middleware.
app.use(cookieParser());
require('./mcp').installMcp(app, { store, channel:zaloChannel, config, webAuth:require('./middleware/webAuth') });

// ==========================================
// Middleware
// ==========================================
// Limit 10MB — nhận ảnh base64 từ UI/API
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Log request đơn giản (bỏ qua polling + static)
app.use((req, res, next) => {
    if (!req.path.startsWith('/app/events') && !req.path.includes('.')) {
        res.on('finish', () => {
            const icon = res.statusCode >= 500 ? '🔴' : res.statusCode >= 400 ? '🟡' : '🟢';
            logger.info(`${icon} ${req.method} ${req.path} → ${res.statusCode}`);
        });
    }
    next();
});

// Static files (login.html, index.html, css, js, uploads)
app.use(express.static(path.join(config.ROOT, 'public')));

// ==========================================
// Routes
// ==========================================
app.use('/app', webRoutes);              // Web UI nội bộ (cookie auth)
app.use('/api/v1', apiAuth, apiRoutes);  // REST API (X-API-Key)

// Health check
app.get('/health', (req, res) => {
    res.json({ service: 'zalo-inbox', app_name: config.APP_NAME, status: 'running', zalo_connected: zaloChannel.status().connected });
});

// ==========================================
// Nối event Zalo → SSE (đẩy realtime cho UI)
// ==========================================
zaloChannel.on('message', (payload) => sse.broadcast('message', payload));
zaloChannel.on('status', (payload) => sse.broadcast('status', payload));
zaloChannel.on('threads_updated', () => sse.broadcast('threads_updated', {}));

// ==========================================
// Trợ lý AI — nghe tin đến từ kênh, trả lời tự động; event → SSE cho UI
// ==========================================
const aiEngine = require('./services/ai/engine');
aiEngine.init({ channel: zaloChannel });
aiEngine.on('state', (payload) => sse.broadcast('ai_state', payload));
aiEngine.on('log', (payload) => sse.broadcast('ai_log', payload));
aiEngine.on('handoff', (payload) => sse.broadcast('ai_handoff', payload));
aiEngine.on('error', (payload) => sse.broadcast('ai_error', payload));

// ==========================================
// Seed tài khoản admin đầu tiên (khi bảng users trống)
// ==========================================
function seedAdminUser() {
    if (store.users.count() === 0) {
        store.users.create(
            config.ADMIN_USERNAME,
            bcrypt.hashSync(config.ADMIN_PASSWORD, 10),
            'Quản trị viên'
        );
        logger.info(`👤 Đã tạo tài khoản admin đầu tiên: ${config.ADMIN_USERNAME} (đổi mật khẩu trong Cài đặt!)`);
    }
}

// ==========================================
// Khởi chạy
// ==========================================
async function start() {
    seedAdminUser();

    app.listen(config.PORT, config.HOST, async () => {
        logger.info('╔══════════════════════════════════════════════╗');
        logger.info(`║  ZALO INBOX — ${config.APP_NAME}`);
        logger.info(`║  🌐 http://localhost:${config.PORT}`);
        logger.info('╚══════════════════════════════════════════════╝');

        // Khôi phục kênh Zalo từ DB (không cần quét QR lại sau restart)
        logger.info('🔄 Đang khôi phục kênh Zalo...');
        const restored = await zaloChannel.restoreFromDb();
        logger.info(restored ? '✅ Kênh Zalo đã sẵn sàng!' : 'ℹ️ Kênh chưa kết nối — đăng nhập web và quét QR.');
    });
}

start();

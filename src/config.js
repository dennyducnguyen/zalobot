// =============================================
// Config — đọc .env tại thư mục gốc zalo-inbox
// =============================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ROOT = path.join(__dirname, '..');

module.exports = {
    ROOT,
    PORT: parseInt(process.env.PORT || '3100', 10),
    HOST: process.env.HOST || '0.0.0.0',
    APP_NAME: process.env.APP_NAME || 'Zalo Inbox',
    MCP_PUBLIC_URL: process.env.MCP_PUBLIC_URL || `http://localhost:${process.env.PORT || '3100'}`,
    MCP_SEND_INTERVAL_MS: Math.max(1000, parseInt(process.env.MCP_SEND_INTERVAL_MS || '2000', 10) || 2000),
    MCP_ALLOWED_ORIGINS: (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    DB_PATH: path.isAbsolute(process.env.DB_PATH || '')
        ? process.env.DB_PATH
        : path.join(ROOT, process.env.DB_PATH || './data/inbox.db'),
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
    ZALO_PROXY: process.env.ZALO_PROXY || null,
    // Trợ lý AI: khóa mã hóa secret (base64 32 byte); trống → tự sinh data/secret.key
    AI_SECRET_KEY: process.env.AI_SECRET_KEY || '',
    // Dev local: mở server callback 127.0.0.1:1455 để đăng nhập ChatGPT tự động (VPS dùng cách dán URL)
    AI_OAUTH_LOCAL_CALLBACK: ['1', 'true', 'yes'].includes(String(process.env.AI_OAUTH_LOCAL_CALLBACK || '').toLowerCase()),
    // Cookie đăng nhập web sống 30 ngày
    TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1000,
};

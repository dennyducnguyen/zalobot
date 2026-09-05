// =============================================
// Database SQLite (better-sqlite3, synchronous)
// 1 file .db duy nhất — dễ mang đi cài nhiều domain
// =============================================
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Tạo thư mục data nếu chưa có
const dbDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');

// ==========================================
// Schema — chạy idempotent mỗi lần khởi động
// ==========================================
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT DEFAULT '',
    role          TEXT DEFAULT 'admin',
    created_at    INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    api_key      TEXT NOT NULL UNIQUE,
    is_active    INTEGER DEFAULT 1,
    created_at   INTEGER DEFAULT (strftime('%s','now') * 1000),
    last_used_at INTEGER DEFAULT NULL
);

-- Kênh Zalo duy nhất — luôn chỉ 1 dòng id=1
CREATE TABLE IF NOT EXISTS zalo_session (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    zalo_id      TEXT,
    display_name TEXT,
    avatar_url   TEXT,
    phone        TEXT,
    credentials  TEXT,
    proxy        TEXT,
    status       TEXT DEFAULT 'active',
    login_at     INTEGER
);

-- Hội thoại (cá nhân + nhóm). type của 1 ID là bất biến.
CREATE TABLE IF NOT EXISTS threads (
    thread_id       TEXT PRIMARY KEY,
    type            TEXT NOT NULL CHECK (type IN ('user','group')),
    name            TEXT DEFAULT '',
    avatar_url      TEXT DEFAULT '',
    phone           TEXT DEFAULT '',
    is_contact      INTEGER DEFAULT 0,
    last_message    TEXT DEFAULT '',
    last_message_at INTEGER DEFAULT NULL,
    last_direction  TEXT DEFAULT NULL,
    unread_count    INTEGER DEFAULT 0,
    updated_at      INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id       TEXT DEFAULT '',
    thread_id    TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
    source       TEXT DEFAULT 'zalo',
    sender_id    TEXT DEFAULT '',
    sender_name  TEXT DEFAULT '',
    content      TEXT DEFAULT '',
    content_type TEXT DEFAULT 'text',
    sent_at      INTEGER NOT NULL,
    created_at   INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages (msg_id);
CREATE INDEX IF NOT EXISTS idx_threads_last ON threads (last_message_at DESC);
`);

// ==========================================
// Users
// ==========================================
const users = {
    count: () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    findByUsername: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username),
    findById: (id) => db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(id),
    list: () => db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY id').all(),
    create: (username, passwordHash, displayName, role = 'admin') =>
        db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
            .run(username, passwordHash, displayName || username, role),
    updatePassword: (id, passwordHash) =>
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id),
    remove: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id),
};

// ==========================================
// Auth tokens (cookie đăng nhập web)
// ==========================================
const tokens = {
    create: (token, userId, expiresAt) =>
        db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt),
    findValid: (token) =>
        db.prepare('SELECT * FROM auth_tokens WHERE token = ? AND expires_at > ?').get(token, Date.now()),
    remove: (token) => db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token),
    purgeExpired: () => db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').run(Date.now()),
};

// ==========================================
// API Keys
// ==========================================
const apiKeys = {
    list: () => db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all(),
    create: (name, key) => db.prepare('INSERT INTO api_keys (name, api_key) VALUES (?, ?)').run(name, key),
    findActiveByKey: (key) => db.prepare('SELECT * FROM api_keys WHERE api_key = ? AND is_active = 1').get(key),
    setActive: (id, active) => db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id),
    remove: (id) => db.prepare('DELETE FROM api_keys WHERE id = ?').run(id),
    touchLastUsed: (id) => db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id),
};

// ==========================================
// Zalo session (1 kênh duy nhất, dòng id=1)
// ==========================================
const zaloSession = {
    get: () => db.prepare('SELECT * FROM zalo_session WHERE id = 1').get(),
    save: ({ zaloId, displayName, avatarUrl, phone, credentials, proxy }) =>
        db.prepare(`
            INSERT INTO zalo_session (id, zalo_id, display_name, avatar_url, phone, credentials, proxy, status, login_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, 'active', ?)
            ON CONFLICT(id) DO UPDATE SET
                zalo_id = excluded.zalo_id,
                display_name = excluded.display_name,
                avatar_url = excluded.avatar_url,
                phone = excluded.phone,
                credentials = excluded.credentials,
                proxy = excluded.proxy,
                status = 'active',
                login_at = excluded.login_at
        `).run(zaloId, displayName, avatarUrl, phone, JSON.stringify(credentials), proxy, Date.now()),
    updateUserInfo: ({ displayName, avatarUrl, phone }) =>
        db.prepare('UPDATE zalo_session SET display_name = ?, avatar_url = ?, phone = ? WHERE id = 1')
            .run(displayName, avatarUrl, phone),
    expire: () => db.prepare("UPDATE zalo_session SET status = 'expired' WHERE id = 1").run(),
};

// ==========================================
// Threads (hội thoại)
// ==========================================
const threads = {
    get: (threadId) => db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId),

    // Upsert từ import bạn bè/nhóm — nguồn có thẩm quyền, được ghi đè name/avatar/type
    upsertContact: ({ threadId, type, name, avatarUrl, phone }) =>
        db.prepare(`
            INSERT INTO threads (thread_id, type, name, avatar_url, phone, is_contact, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                type = excluded.type,
                name = CASE WHEN excluded.name != '' THEN excluded.name ELSE threads.name END,
                avatar_url = CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE threads.avatar_url END,
                phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE threads.phone END,
                is_contact = 1,
                updated_at = excluded.updated_at
        `).run(threadId, type, name || '', avatarUrl || '', phone || '', Date.now()),

    // Tạo thread nếu chưa có (từ tin nhắn) — KHÔNG lật type đã có
    ensureExists: (threadId, type, name) =>
        db.prepare(`
            INSERT INTO threads (thread_id, type, name, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                name = CASE WHEN threads.name = '' AND excluded.name != '' THEN excluded.name ELSE threads.name END,
                updated_at = excluded.updated_at
        `).run(threadId, type, name || '', Date.now()),

    updateLastMessage: (threadId, text, at, direction, incUnread) =>
        db.prepare(`
            UPDATE threads SET last_message = ?, last_message_at = ?, last_direction = ?,
                unread_count = unread_count + ?, updated_at = ?
            WHERE thread_id = ?
        `).run(text, at, direction, incUnread ? 1 : 0, Date.now(), threadId),

    resetUnread: (threadId) =>
        db.prepare('UPDATE threads SET unread_count = 0 WHERE thread_id = ?').run(threadId),

    // Danh sách hội thoại: có tin nhắn xếp trước (mới nhất trên cùng), danh bạ chưa chat xếp sau theo tên
    list: ({ search = '', type = '' } = {}) => {
        let sql = 'SELECT * FROM threads WHERE 1=1';
        const params = [];
        if (search) {
            sql += ' AND (name LIKE ? OR thread_id LIKE ? OR phone LIKE ?)';
            const like = `%${search}%`;
            params.push(like, like, like);
        }
        if (type === 'user' || type === 'group') {
            sql += ' AND type = ?';
            params.push(type);
        }
        sql += ' ORDER BY (last_message_at IS NULL), last_message_at DESC, name COLLATE NOCASE ASC LIMIT 500';
        return db.prepare(sql).all(...params);
    },

    // Search theo tên cho API — trả kèm type để biết cá nhân hay nhóm
    searchByName: (name, limit = 50) =>
        db.prepare(`
            SELECT thread_id, type, name, avatar_url, phone, is_contact
            FROM threads WHERE name LIKE ? ORDER BY name COLLATE NOCASE LIMIT ?
        `).all(`%${name}%`, limit),
};

// ==========================================
// Messages
// ==========================================
const messages = {
    // meta (tùy chọn): JSON { mentions, quote, msgType, ... } — dùng cho Trợ lý AI (cột thêm bởi services/ai/store.js)
    insert: ({ msgId, threadId, direction, source, senderId, senderName, content, contentType, sentAt, meta = null }) =>
        db.prepare(`
            INSERT INTO messages (msg_id, thread_id, direction, source, sender_id, sender_name, content, content_type, sent_at, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(msgId || '', threadId, direction, source, senderId || '', senderName || '', content, contentType, sentAt,
            meta ? (typeof meta === 'string' ? meta : JSON.stringify(meta)) : null),

    existsByMsgId: (msgId) =>
        msgId ? !!db.prepare('SELECT 1 FROM messages WHERE msg_id = ? LIMIT 1').get(msgId) : false,

    findById: (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id),

    // Phân trang lùi: lấy limit tin mới nhất trước before_id (0 = mới nhất)
    listByThread: (threadId, beforeId = 0, limit = 50) => {
        const rows = beforeId > 0
            ? db.prepare('SELECT * FROM messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(threadId, beforeId, limit)
            : db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?').all(threadId, limit);
        return rows.reverse(); // trả về theo thứ tự cũ → mới
    },
};

require('./mcp/store').createMcpStore(db);
const mcpSync = {
    record(kind, status, count = 0) {
        db.prepare(`INSERT INTO mcp_sync (kind,attempted_at,completed_at,item_count,status) VALUES (?,?,?,?,?)
            ON CONFLICT(kind) DO UPDATE SET attempted_at=excluded.attempted_at,
            completed_at=CASE WHEN excluded.status='success' THEN excluded.completed_at ELSE mcp_sync.completed_at END,
            item_count=excluded.item_count,status=excluded.status`).run(kind,Date.now(),status==='success'?Date.now():null,count,status);
    },
};
// Trợ lý AI — bảng ai_* + cột messages.meta (xem services/ai/store.js). Phải chạy TRƯỚC messages.insert đầu tiên.
const ai = require('./services/ai/store').createAiStore(db);
module.exports = { db, users, tokens, apiKeys, zaloSession, threads, messages, mcpSync, ai };

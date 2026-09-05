// =============================================
// AI store — bảng SQLite riêng cho Trợ lý AI + cột messages.meta
// Tách khỏi db.js để không đụng phần MCP (cùng pattern mcp/store.js)
// =============================================

function createAiStore(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS ai_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS ai_providers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL CHECK (kind IN ('gemini','openai','openai_compat','chatgpt')),
    name         TEXT NOT NULL UNIQUE,
    base_url     TEXT DEFAULT '',
    secret_enc   TEXT DEFAULT '',
    chat_model   TEXT DEFAULT '',
    image_model  TEXT DEFAULT '',
    embed_model  TEXT DEFAULT '',
    embed_dims   INTEGER DEFAULT 0,
    is_enabled   INTEGER DEFAULT 1,
    status       TEXT DEFAULT 'unverified',
    status_note  TEXT DEFAULT '',
    meta         TEXT DEFAULT '{}',
    created_at   INTEGER,
    updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS ai_thread_state (
    thread_id        TEXT PRIMARY KEY,
    ai_enabled       INTEGER DEFAULT NULL,
    reset_at         INTEGER DEFAULT 0,
    reset_msg_id     INTEGER DEFAULT 0,
    paused_until     INTEGER DEFAULT 0,
    needs_human      INTEGER DEFAULT 0,
    last_reply_at    INTEGER DEFAULT 0,
    reply_count_day  INTEGER DEFAULT 0,
    reply_count_date TEXT DEFAULT '',
    updated_at       INTEGER
);

CREATE TABLE IF NOT EXISTS ai_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id      TEXT NOT NULL,
    trigger_msg_id INTEGER DEFAULT 0,
    provider_id    INTEGER DEFAULT 0,
    provider_kind  TEXT DEFAULT '',
    model          TEXT DEFAULT '',
    status         TEXT NOT NULL,
    skip_reason    TEXT DEFAULT '',
    input_tokens   INTEGER DEFAULT 0,
    output_tokens  INTEGER DEFAULT 0,
    latency_ms     INTEGER DEFAULT 0,
    tool_calls     TEXT DEFAULT '[]',
    reply_preview  TEXT DEFAULT '',
    error          TEXT DEFAULT '',
    created_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_logs_thread ON ai_logs (thread_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_created ON ai_logs (created_at DESC);
`);

    // messages.meta — JSON { mentions, quote, msgType, ... } (cần cho chế độ "chỉ trả lời khi được tag" + quote lại tin)
    const cols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
    if (!cols.includes('meta')) {
        db.exec('ALTER TABLE messages ADD COLUMN meta TEXT DEFAULT NULL');
    }

    const now = () => Date.now();

    const settings = {
        getRaw: (key) => db.prepare('SELECT value FROM ai_settings WHERE key = ?').get(key)?.value,
        all: () => {
            const out = {};
            for (const row of db.prepare('SELECT key, value FROM ai_settings').all()) {
                try { out[row.key] = JSON.parse(row.value); } catch { /* bỏ qua giá trị hỏng */ }
            }
            return out;
        },
        set: (key, value) =>
            db.prepare(`INSERT INTO ai_settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
                .run(key, JSON.stringify(value), now()),
        setMany: (obj) => {
            const tx = db.transaction((entries) => { for (const [k, v] of entries) settings.set(k, v); });
            tx(Object.entries(obj));
        },
    };

    const providers = {
        list: () => db.prepare('SELECT * FROM ai_providers ORDER BY id').all(),
        get: (id) => db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id),
        getByName: (name) => db.prepare('SELECT * FROM ai_providers WHERE name = ?').get(name),
        create: ({ kind, name, baseUrl, secretEnc, chatModel, imageModel, embedModel, embedDims, status, statusNote, meta }) =>
            db.prepare(`INSERT INTO ai_providers (kind, name, base_url, secret_enc, chat_model, image_model, embed_model, embed_dims, status, status_note, meta, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(kind, name, baseUrl || '', secretEnc || '', chatModel || '', imageModel || '', embedModel || '', embedDims || 0,
                    status || 'unverified', statusNote || '', JSON.stringify(meta || {}), now(), now()),
        update: (id, fields) => {
            const map = {
                name: 'name', baseUrl: 'base_url', secretEnc: 'secret_enc', chatModel: 'chat_model', imageModel: 'image_model',
                embedModel: 'embed_model', embedDims: 'embed_dims', isEnabled: 'is_enabled', status: 'status', statusNote: 'status_note', meta: 'meta',
            };
            const sets = [];
            const vals = [];
            for (const [k, col] of Object.entries(map)) {
                if (fields[k] === undefined) continue;
                sets.push(`${col} = ?`);
                let v = fields[k];
                if (k === 'meta') v = JSON.stringify(v || {});
                if (k === 'isEnabled') v = v ? 1 : 0;
                vals.push(v);
            }
            if (!sets.length) return;
            sets.push('updated_at = ?');
            vals.push(now(), id);
            db.prepare(`UPDATE ai_providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        },
        remove: (id) => db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id),
    };

    const threadState = {
        get: (threadId) => db.prepare('SELECT * FROM ai_thread_state WHERE thread_id = ?').get(threadId) || null,
        ensure: (threadId) => {
            db.prepare('INSERT OR IGNORE INTO ai_thread_state (thread_id, updated_at) VALUES (?, ?)').run(threadId, now());
            return threadState.get(threadId);
        },
        update: (threadId, fields) => {
            threadState.ensure(threadId);
            const allowed = ['ai_enabled', 'reset_at', 'reset_msg_id', 'paused_until', 'needs_human', 'last_reply_at', 'reply_count_day', 'reply_count_date'];
            const sets = [];
            const vals = [];
            for (const k of allowed) {
                if (fields[k] === undefined) continue;
                sets.push(`${k} = ?`);
                vals.push(fields[k]);
            }
            if (!sets.length) return threadState.get(threadId);
            sets.push('updated_at = ?');
            vals.push(now(), threadId);
            db.prepare(`UPDATE ai_thread_state SET ${sets.join(', ')} WHERE thread_id = ?`).run(...vals);
            return threadState.get(threadId);
        },
        // Các thread có trạng thái khác mặc định (để UI hiển thị icon)
        listActive: () => db.prepare(`SELECT thread_id, ai_enabled, paused_until, needs_human FROM ai_thread_state
            WHERE ai_enabled IS NOT NULL OR paused_until > ? OR needs_human = 1`).all(now()),
    };

    const logs = {
        insert: (row) =>
            db.prepare(`INSERT INTO ai_logs (thread_id, trigger_msg_id, provider_id, provider_kind, model, status, skip_reason,
                input_tokens, output_tokens, latency_ms, tool_calls, reply_preview, error, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(row.threadId, row.triggerMsgId || 0, row.providerId || 0, row.providerKind || '', row.model || '', row.status,
                    row.skipReason || '', row.inputTokens || 0, row.outputTokens || 0, row.latencyMs || 0,
                    JSON.stringify(row.toolCalls || []), (row.replyPreview || '').slice(0, 300), (row.error || '').slice(0, 2000), now()),
        list: ({ threadId = '', status = '', limit = 50, beforeId = 0 } = {}) => {
            let sql = 'SELECT * FROM ai_logs WHERE 1=1';
            const params = [];
            if (threadId) { sql += ' AND thread_id = ?'; params.push(threadId); }
            if (status) { sql += ' AND status = ?'; params.push(status); }
            if (beforeId > 0) { sql += ' AND id < ?'; params.push(beforeId); }
            sql += ' ORDER BY id DESC LIMIT ?';
            params.push(Math.min(Math.max(limit, 1), 200));
            return db.prepare(sql).all(...params);
        },
        stats: (sinceMs) => db.prepare(`SELECT status, provider_kind, COUNT(*) AS n,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, AVG(latency_ms) AS avg_latency
            FROM ai_logs WHERE created_at >= ? GROUP BY status, provider_kind`).all(sinceMs),
        purgeOlderThan: (ms) => db.prepare('DELETE FROM ai_logs WHERE created_at < ?').run(now() - ms),
    };

    // History cho ngữ cảnh AI: tin sau mốc reset, mới nhất trước → đảo lại
    const history = {
        listAfter: (threadId, afterMsgRowId, sinceMs, limit) => {
            const rows = db.prepare(`SELECT * FROM messages WHERE thread_id = ? AND id > ? AND sent_at >= ?
                ORDER BY id DESC LIMIT ?`).all(threadId, afterMsgRowId || 0, sinceMs || 0, limit);
            return rows.reverse();
        },
    };

    return { settings, providers, threadState, logs, history };
}

module.exports = { createAiStore };

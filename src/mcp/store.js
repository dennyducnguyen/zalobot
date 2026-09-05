const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');

function createMcpStore(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS mcp_pending (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS mcp_grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id INTEGER NOT NULL, scopes TEXT NOT NULL, password_version TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
        CREATE TABLE IF NOT EXISTS mcp_codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS mcp_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
        CREATE INDEX IF NOT EXISTS mcp_tokens_grant ON mcp_tokens(grant_id);
        CREATE TABLE IF NOT EXISTS mcp_sends (principal TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, tool TEXT NOT NULL, recipient TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(principal, request_id));
        CREATE TABLE IF NOT EXISTS mcp_sync (kind TEXT PRIMARY KEY, attempted_at INTEGER, completed_at INTEGER, item_count INTEGER, status TEXT NOT NULL);
    `);
    // An interrupted send may already have reached Zalo. Never automatically replay it.
    db.prepare("UPDATE mcp_sends SET status = 'unknown' WHERE status = 'pending'").run();
    return { db, hash, random };
}
module.exports = { createMcpStore, hash, random };

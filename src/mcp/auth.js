const bcrypt = require('bcryptjs');
const { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidTargetError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { hash, random } = require('./store');

const SCOPES = ['zalo:read', 'zalo:send'];
const ACCESS_SECONDS = 3600;
const REFRESH_MS = 30 * 24 * 3600 * 1000;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function createProvider(db, origin) {
    const dummyPasswordHash = bcrypt.hashSync(random(), 10);
    // OAuth identifiers are compared as exact strings. Keep the public origin
    // identical in discovery documents and callbacks, without URL.href adding '/'.
    const issuer = new URL(origin).origin;
    const resource = new URL('/mcp', origin).href;
    function checkResource(value) {
        if (value && value.href !== resource) throw new InvalidTargetError('Token chỉ dành cho MCP này');
    }
    function scopesOrDefault(scopes) {
        const selected = scopes?.length ? [...new Set(scopes)] : SCOPES;
        if (selected.some(s => !SCOPES.includes(s))) throw new InvalidScopeError('Quyền không được hỗ trợ');
        return selected;
    }
    function activeGrant(id) {
        const grant = db.prepare('SELECT g.*, u.password_hash FROM mcp_grants g JOIN users u ON u.id = g.user_id WHERE g.id = ? AND g.revoked_at IS NULL').get(id);
        if (!grant || grant.password_version !== hash(grant.password_hash)) throw new InvalidGrantError('Kết nối đã bị thu hồi hoặc tài khoản đã thay đổi');
        return grant;
    }
    function issue(grant, scopes) {
        const access = random(), refresh = random(), now = Date.now();
        const insert = db.prepare('INSERT INTO mcp_tokens (hash, grant_id, kind, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
        insert.run(hash(access), grant.id, 'access', JSON.stringify(scopes), resource, now + ACCESS_SECONDS * 1000);
        insert.run(hash(refresh), grant.id, 'refresh', JSON.stringify(scopes), resource, now + REFRESH_MS);
        return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes.join(' ') };
    }
    function codeRecord(client, code) {
        const record = db.prepare('SELECT * FROM mcp_codes WHERE hash = ? AND expires_at > ?').get(hash(code), Date.now());
        if (!record) throw new InvalidGrantError('Mã đăng nhập không hợp lệ hoặc hết hạn');
        const grant = activeGrant(record.grant_id);
        if (grant.client_id !== client.client_id) throw new InvalidGrantError('Mã không thuộc ứng dụng này');
        return { record, grant };
    }
    const provider = {
        issuer, resource,
        clientsStore: {
            async getClient(id) {
                const row = db.prepare('SELECT metadata FROM mcp_clients WHERE id = ?').get(id);
                return row ? JSON.parse(row.metadata) : undefined;
            },
            async registerClient(info) {
                if (db.prepare('SELECT COUNT(*) AS n FROM mcp_clients').get().n >= 2000) throw new InvalidClientMetadataError('Đã đạt giới hạn ứng dụng');
                if (!info.redirect_uris?.length || info.redirect_uris.length > 10) throw new InvalidClientMetadataError('Cần 1–10 địa chỉ callback');
                for (const value of info.redirect_uris) {
                    const url = new URL(value);
                    if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.length > 2048) throw new InvalidClientMetadataError('Callback phải dùng HTTPS, không chứa thông tin đăng nhập hoặc fragment');
                }
                if (!['none','client_secret_post','client_secret_basic'].includes(info.token_endpoint_auth_method || 'client_secret_post')) throw new InvalidClientMetadataError('Phương thức xác thực không hỗ trợ');
                if (info.scope) scopesOrDefault(info.scope.split(' '));
                if (info.grant_types?.some(g => !['authorization_code','refresh_token'].includes(g)) || info.response_types?.some(r => r !== 'code')) throw new InvalidClientMetadataError('Chỉ hỗ trợ authorization_code và refresh_token');
                const client = { ...info, client_name: String(info.client_name || 'Ứng dụng AI').slice(0,120), client_id: info.client_id || random(), token_endpoint_auth_method: info.token_endpoint_auth_method || 'client_secret_post' };
                const stored = { ...client, client_secret: client.client_secret ? hash(client.client_secret) : undefined };
                db.prepare('INSERT INTO mcp_clients VALUES (?, ?, ?)').run(client.client_id, JSON.stringify(stored), Date.now());
                return client;
            },
        },
        async authorize(client, params, res) {
            checkResource(params.resource);
            if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('PKCE S256 không hợp lệ');
            const scopes = scopesOrDefault(params.scopes);
            if (client.scope && scopes.some(s => !client.scope.split(' ').includes(s))) throw new InvalidScopeError('Quyền vượt quá đăng ký ứng dụng');
            const id = random(), csrf = random();
            db.prepare('DELETE FROM mcp_pending WHERE expires_at <= ?').run(Date.now());
            db.prepare('INSERT INTO mcp_pending VALUES (?, ?, ?, ?, ?)').run(id, client.client_id, JSON.stringify({ ...params, resource, scopes }), hash(csrf), Date.now() + 10 * 60 * 1000);
            res.cookie('mcp_consent', csrf, { httpOnly:true, secure: origin.startsWith('https:'), sameSite:'lax', path:'/oauth', maxAge:10*60*1000 });
            res.redirect(303, `/oauth/consent?id=${id}`);
        },
        async challengeForAuthorizationCode(client, code) { return codeRecord(client, code).record.challenge; },
        async exchangeAuthorizationCode(client, code, verifier, redirectUri, target) {
            checkResource(target);
            return db.transaction(() => {
                const {record, grant} = codeRecord(client, code);
                if (redirectUri !== record.redirect_uri) throw new InvalidGrantError('Callback không khớp');
                db.prepare('DELETE FROM mcp_codes WHERE hash = ?').run(hash(code));
                return issue(grant, JSON.parse(grant.scopes));
            })();
        },
        async exchangeRefreshToken(client, token, scopes, target) {
            checkResource(target);
            const record = db.prepare("SELECT * FROM mcp_tokens WHERE hash = ? AND kind = 'refresh'").get(hash(token));
            if (!record || record.expires_at <= Date.now()) throw new InvalidGrantError('Refresh token hết hạn hoặc không hợp lệ');
            const grant = activeGrant(record.grant_id);
            if (grant.client_id !== client.client_id) throw new InvalidGrantError('Token không thuộc ứng dụng này');
            if (record.used_at) {
                db.prepare('UPDATE mcp_grants SET revoked_at = ? WHERE id = ?').run(Date.now(), grant.id);
                throw new InvalidGrantError('Refresh token đã được dùng; hãy kết nối lại');
            }
            const previous = JSON.parse(record.scopes);
            const selected = scopes?.length ? scopesOrDefault(scopes) : previous;
            if (selected.some(s => !previous.includes(s))) throw new InvalidScopeError('Không thể tăng quyền khi làm mới token');
            return db.transaction(() => {
                db.prepare('UPDATE mcp_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(Date.now(), hash(token));
                return issue(grant, selected);
            })();
        },
        async verifyAccessToken(token) {
            const record = db.prepare("SELECT * FROM mcp_tokens WHERE hash = ? AND kind = 'access' AND expires_at > ?").get(hash(token), Date.now());
            if (!record || record.resource !== resource) throw new InvalidTokenError('Invalid or expired access token');
            let grant;
            try { grant = activeGrant(record.grant_id); } catch { throw new InvalidTokenError('Authorization has been revoked'); }
            db.prepare('UPDATE mcp_grants SET last_used_at = ? WHERE id = ?').run(Date.now(), grant.id);
            return { token, clientId:grant.client_id, scopes:JSON.parse(record.scopes), expiresAt:record.expires_at/1000, resource:new URL(resource), extra:{ userId:grant.user_id, grantId:grant.id } };
        },
        async revokeToken(client, request) {
            const row = db.prepare('SELECT g.id, g.client_id FROM mcp_tokens t JOIN mcp_grants g ON g.id = t.grant_id WHERE t.hash = ?').get(hash(request.token));
            if (row?.client_id === client.client_id) db.prepare('UPDATE mcp_grants SET revoked_at = ? WHERE id = ?').run(Date.now(), row.id);
        },
        cleanup() {
            const now = Date.now();
            db.prepare('DELETE FROM mcp_pending WHERE expires_at < ?').run(now);
            db.prepare('DELETE FROM mcp_codes WHERE expires_at < ?').run(now);
            db.prepare('DELETE FROM mcp_tokens WHERE expires_at < ?').run(now);
        },
    };

    provider.consentPage = (req, res) => {
        const row = db.prepare('SELECT p.*, c.metadata FROM mcp_pending p JOIN mcp_clients c ON c.id = p.client_id WHERE p.id = ? AND p.expires_at > ?').get(String(req.query.id || ''), Date.now());
        if (!row || row.csrf_hash !== hash(req.cookies?.mcp_consent || '')) return res.status(400).send('Phiên cấp quyền hết hạn. Hãy kết nối lại từ ứng dụng AI.');
        const params = JSON.parse(row.params), client = JSON.parse(row.metadata);
        // no-referrer makes browser form POSTs send Origin: null, failing CSRF checks.
        // same-origin preserves Origin here without leaking the pending ID to the client.
        // Chromium also applies form-action to the redirect after submission.
        // Permit only this authorization request's validated callback origin.
        const callbackOrigin = new URL(params.redirectUri).origin;
        res.set({ 'Cache-Control':'no-store', 'Referrer-Policy':'same-origin', 'X-Frame-Options':'DENY', 'Content-Security-Policy':`default-src 'none'; style-src 'self'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'` });
        res.type('html').send(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kết nối AI — Zalo Inbox</title><link rel="stylesheet" href="/css/mcp.css"></head><body><main><span class="eyebrow">ZALO INBOX · KẾT NỐI AI</span><h1>Cho phép ứng dụng truy cập Zalo</h1><p><strong>${esc(client.client_name)}</strong> yêu cầu kết nối. Tên ứng dụng do bên kết nối cung cấp; hãy kiểm tra địa chỉ nhận quyền bên dưới.</p><p class="callback">${esc(new URL(params.redirectUri).origin)}</p><form method="post" action="/oauth/consent"><input type="hidden" name="id" value="${esc(row.id)}"><input type="hidden" name="csrf" value="${esc(req.cookies.mcp_consent)}"><label>Tài khoản Zalo Inbox<input name="username" autocomplete="username" required maxlength="100"></label><label>Mật khẩu<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><fieldset><legend>Quyền cấp cho ứng dụng</legend>${params.scopes.map(scope => `<label class="permission"><input type="checkbox" name="scopes" value="${scope}" checked> ${scope === 'zalo:read' ? 'Xem danh sách nhóm, danh bạ và người đã chat; tìm theo SĐT' : 'Gửi tin nhắn từ tài khoản Zalo đang kết nối'}</label>`).join('')}</fieldset><p class="hint">Dùng tài khoản đăng nhập web. Bạn có thể thu hồi kết nối trong Cài đặt bất cứ lúc nào.</p><div class="actions"><button name="decision" value="allow">Đăng nhập và cấp quyền</button><button class="secondary" name="decision" value="deny" formnovalidate>Từ chối</button></div></form></main></body></html>`);
    };
    provider.consentSubmit = async (req, res) => {
        res.set({ 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer' });
        const row = db.prepare('SELECT * FROM mcp_pending WHERE id = ? AND expires_at > ?').get(String(req.body?.id || ''), Date.now());
        if (req.headers.origin !== origin || !row || typeof req.body.csrf !== 'string' || hash(req.body.csrf) !== row.csrf_hash || req.cookies?.mcp_consent !== req.body.csrf) return res.status(403).send('Phiên cấp quyền không hợp lệ. Hãy kết nối lại từ ứng dụng AI.');
        const params = JSON.parse(row.params);
        const callback = new URL(params.redirectUri);
        callback.searchParams.set('iss', issuer);
        if (params.state) callback.searchParams.set('state', params.state);
        if (req.body.decision === 'deny') {
            db.prepare('DELETE FROM mcp_pending WHERE id = ?').run(row.id);
            callback.searchParams.set('error','access_denied');
            return res.redirect(303, callback.href);
        }
        const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
        const password = typeof req.body.password === 'string' ? req.body.password : '';
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        const passwordMatches = password.length <= 256 && await bcrypt.compare(password, user?.password_hash || dummyPasswordHash);
        if (!user || !passwordMatches) return res.status(401).send('Sai tài khoản hoặc mật khẩu. Quay lại để nhập lại.');
        const selected = Array.isArray(req.body.scopes) ? req.body.scopes : [req.body.scopes];
        if (!selected.length || selected.some(s => !params.scopes.includes(s))) return res.status(400).send('Chọn ít nhất một quyền hợp lệ.');
        const code = random(), grantId = random();
        const saved = db.transaction(() => {
            if (!db.prepare('DELETE FROM mcp_pending WHERE id = ? AND expires_at > ?').run(row.id, Date.now()).changes) return false;
            db.prepare('INSERT INTO mcp_grants (id, client_id, user_id, scopes, password_version, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(grantId, row.client_id, user.id, JSON.stringify(selected), hash(user.password_hash), Date.now());
            db.prepare('INSERT INTO mcp_codes VALUES (?, ?, ?, ?, ?, ?)').run(hash(code), grantId, params.codeChallenge, params.redirectUri, resource, Date.now()+5*60*1000);
            return true;
        })();
        if (!saved) return res.status(400).send('Phiên đã được sử dụng hoặc hết hạn.');
        callback.searchParams.set('code', code);
        res.clearCookie('mcp_consent', { path:'/oauth' });
        res.redirect(303, callback.href);
    };
    return provider;
}
module.exports = { createProvider, SCOPES };

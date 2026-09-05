// =============================================
// OAuth PKCE với public client của OpenAI Codex CLI — dùng gói ChatGPT Plus/Pro làm provider.
// GIỮ NGUYÊN hằng số: đây là hợp đồng với backend OpenAI, đổi là hỏng.
// Hai cách hoàn tất đăng nhập:
//   1. Dán URL callback (mặc định, chạy được trên VPS): trình duyệt redirect về localhost:1455 (lỗi), người dùng copy URL dán vào UI.
//   2. Server callback local 127.0.0.1:1455 (dev local, AI_OAUTH_LOCAL_CALLBACK=1).
// =============================================
const crypto = require('crypto');
const http = require('http');
const { ProviderError } = require('./types');
const { maskSecrets } = require('../secrets');

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_ISSUER = 'https://auth.openai.com';
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_SCOPE = 'openid profile email offline_access';
const LOGIN_TTL_MS = 10 * 60 * 1000;

const b64url = (buf) => buf.toString('base64url');

function generatePkce() {
    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function buildAuthorizeUrl(challenge, state) {
    const q = new URLSearchParams({
        response_type: 'code',
        client_id: CODEX_CLIENT_ID,
        redirect_uri: CODEX_REDIRECT_URI,
        scope: CODEX_SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'codex_cli_rs',
    });
    return `${CODEX_ISSUER}/oauth/authorize?${q}`;
}

/** Decode payload JWT (không verify chữ ký — chỉ đọc claim). */
function decodeJwtPayload(token) {
    const part = String(token || '').split('.')[1];
    if (!part) throw new ProviderError('JWT không hợp lệ');
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** @typedef {{ accessToken:string, refreshToken:string, idToken:string, accountId:string, email?:string, expiresAt:number }} CodexAuth */

function authFromTokenResponse(data, previous = null) {
    const idToken = data.id_token || previous?.idToken;
    const payload = idToken ? decodeJwtPayload(idToken) : {};
    const authClaim = payload['https://api.openai.com/auth'] || {};
    const accountId = authClaim.chatgpt_account_id || previous?.accountId;
    if (!accountId) throw new ProviderError('id_token không có chatgpt_account_id — tài khoản có gói ChatGPT hợp lệ chưa?');
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || previous?.refreshToken,
        idToken: idToken || '',
        accountId,
        email: typeof payload.email === 'string' ? payload.email : previous?.email,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
}

async function tokenRequest(params, previous = null) {
    let res;
    try {
        res = await fetch(`${CODEX_ISSUER}/oauth/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        throw new ProviderError(`Không gọi được OAuth token endpoint: ${e.message}`, { code: 'NETWORK' });
    }
    const text = await res.text();
    if (!res.ok) {
        const invalidGrant = /invalid_grant|expired|revoked/i.test(text);
        throw new ProviderError(`OAuth token thất bại (${res.status}): ${maskSecrets(text).slice(0, 300)}`, {
            status: res.status, authFail: invalidGrant || res.status === 400 || res.status === 401, code: invalidGrant ? 'INVALID_GRANT' : '',
        });
    }
    return authFromTokenResponse(JSON.parse(text), previous);
}

function exchangeCode(code, verifier) {
    return tokenRequest({
        grant_type: 'authorization_code', code, redirect_uri: CODEX_REDIRECT_URI, client_id: CODEX_CLIENT_ID, code_verifier: verifier,
    });
}

function refreshAuth(auth) {
    return tokenRequest({
        grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: CODEX_CLIENT_ID, scope: 'openid profile email',
    }, auth);
}

/**
 * Chấp nhận: URL callback đầy đủ, chỉ phần query "code=...&state=...", hoặc chỉ mã code.
 * @returns {{ code:string, state:string|null }}
 */
function parseCallbackInput(input) {
    const s = String(input || '').trim();
    if (!s) throw new ProviderError('Chưa dán URL callback');
    let params;
    if (/^https?:\/\//i.test(s)) params = new URL(s).searchParams;
    else if (s.includes('=')) params = new URLSearchParams(s.replace(/^\?/, ''));
    else return { code: s, state: null };
    const err = params.get('error');
    if (err) throw new ProviderError(`OAuth trả lỗi: ${err} ${params.get('error_description') || ''}`.trim());
    const code = params.get('code');
    if (!code) throw new ProviderError('URL không có tham số code');
    return { code, state: params.get('state') };
}

/**
 * Quản lý phiên đăng nhập (chỉ 1 phiên tại 1 thời điểm).
 */
class LoginSessionManager {
    /**
     * @param {{ persist?: { save(p:object):void, load():object|null, clear():void } }} [opts]
     *   persist: lưu phiên (verifier/state) ra ngoài RAM để sống qua restart server giữa lúc đăng nhập
     */
    constructor(opts = {}) { this.pending = null; this.server = null; this.persist = opts.persist || null; }

    _save() {
        if (!this.persist || !this.pending) return;
        const { verifier, state, expiresAt, mode, providerId, createdAt } = this.pending;
        try { this.persist.save({ verifier, state, expiresAt, mode, providerId, createdAt }); } catch { /* bỏ qua */ }
    }
    _clearPersist() { try { this.persist?.clear(); } catch { /* bỏ qua */ } }
    /** Khôi phục phiên từ persist nếu RAM trống (server vừa restart) */
    _restore() {
        if (this.pending || !this.persist) return;
        let p = null;
        try { p = this.persist.load(); } catch { p = null; }
        if (p && p.verifier && p.state && p.expiresAt > Date.now()) {
            this.pending = { ...p, authorizeUrl: '', status: 'waiting', error: '', email: '', mode: 'paste' };
        }
    }

    /**
     * @param {{ localCallback?:boolean, providerId?:number }} opts
     * @param {(auth:CodexAuth)=>Promise<void>|void} onAuth  gọi khi callback local hoàn tất (mode local)
     */
    start(opts = {}, onAuth = null) {
        this.cancel();
        const { verifier, challenge } = generatePkce();
        const state = b64url(crypto.randomBytes(16));
        const authorizeUrl = buildAuthorizeUrl(challenge, state);
        const pending = { verifier, state, authorizeUrl, createdAt: Date.now(), expiresAt: Date.now() + LOGIN_TTL_MS, status: 'waiting', error: '', email: '', mode: opts.localCallback ? 'local' : 'paste', providerId: opts.providerId || null };
        this.pending = pending;
        this._save();

        if (opts.localCallback) {
            try {
                this.server = http.createServer(async (req, res) => {
                    const u = new URL(req.url || '/', 'http://localhost:1455');
                    if (u.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
                    try {
                        const auth = await this.complete(u.href);
                        if (onAuth) await onAuth(auth);
                        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                        res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding-top:60px"><h2>✅ Đăng nhập ChatGPT thành công!</h2><p>${auth.email || auth.accountId}</p><p>Đóng tab này và quay lại Zalo Inbox.</p></body>`);
                    } catch (e) {
                        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
                        res.end(`<h2>Đăng nhập thất bại</h2><p>${maskSecrets(e.message)}</p>`);
                    } finally {
                        this._closeServer();
                    }
                });
                this.server.on('error', (e) => {
                    pending.status = 'failed';
                    pending.error = e.code === 'EADDRINUSE' ? 'Cổng 1455 đang bị chiếm — đóng ứng dụng khác hoặc dùng cách dán URL' : e.message;
                    pending.mode = 'paste'; // vẫn cho dán URL
                    this._closeServer();
                });
                this.server.listen(1455, '127.0.0.1');
            } catch (e) {
                pending.mode = 'paste';
                pending.error = e.message;
            }
        }
        setTimeout(() => { if (this.pending === pending && pending.status === 'waiting') { pending.status = 'expired'; this._closeServer(); } }, LOGIN_TTL_MS).unref();
        return { authorize_url: authorizeUrl, expires_at: pending.expiresAt, mode: pending.mode };
    }

    /** Hoàn tất bằng URL callback (hoặc code). Trả CodexAuth; KHÔNG tự lưu — caller lưu. */
    async complete(input) {
        this._restore();
        const pending = this.pending;
        if (!pending) throw new ProviderError('Chưa bắt đầu đăng nhập — bấm "Mở trang đăng nhập" trước');
        if (pending.expiresAt < Date.now()) { pending.status = 'expired'; this._clearPersist(); throw new ProviderError('Phiên đăng nhập đã hết hạn (10 phút) — bấm "Mở trang đăng nhập" lại'); }
        const { code, state } = parseCallbackInput(input);
        if (state !== null && state !== pending.state) throw new ProviderError('state không khớp — URL này thuộc phiên đăng nhập cũ. Bấm "Mở trang đăng nhập" lại rồi dán URL mới');
        try {
            const auth = await exchangeCode(code, pending.verifier);
            pending.status = 'success';
            pending.email = auth.email || '';
            this._clearPersist();
            return auth;
        } catch (e) {
            pending.status = 'failed';
            pending.error = e.message;
            if (e.code === 'INVALID_GRANT' || e.status === 400) this._clearPersist(); // code đã dùng/hết hạn → phải bắt đầu lại
            throw e;
        }
    }

    status() {
        this._restore();
        const p = this.pending;
        if (!p) return { active: false };
        if (p.status === 'waiting' && p.expiresAt < Date.now()) p.status = 'expired';
        return { active: p.status === 'waiting', status: p.status, mode: p.mode, error: p.error, email: p.email, expires_at: p.expiresAt, provider_id: p.providerId || null };
    }

    cancel() { this.pending = null; this._clearPersist(); this._closeServer(); }

    _closeServer() {
        if (this.server) { try { this.server.close(); } catch { /* bỏ qua */ } this.server = null; }
    }
}

module.exports = {
    CODEX_CLIENT_ID, CODEX_ISSUER, CODEX_REDIRECT_URI, CODEX_SCOPE,
    generatePkce, buildAuthorizeUrl, decodeJwtPayload, exchangeCode, refreshAuth, parseCallbackInput, authFromTokenResponse,
    LoginSessionManager,
};

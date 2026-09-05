// =============================================
// Provider ChatGPT subscription — Responses API tại chatgpt.com/backend-api/codex (luôn stream SSE, gom lại trả 1 lần).
// Hỗ trợ: chat, tools, ảnh vào (input_image), tạo ảnh (tool image_generation), listModels, refresh token.
// CẢNH BÁO: đường không chính thức — có thể bị OpenAI khóa tài khoản hoặc đổi endpoint. Nên có provider dự phòng.
// =============================================
const crypto = require('crypto');
const { refreshAuth } = require('./chatgptOAuth');
const { ProviderError, safeParseArgs } = require('./types');
const { maskSecrets } = require('../secrets');
const { sleep } = require('./http');

const CODEX_API = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_MODELS = 'https://chatgpt.com/backend-api/codex/models?client_version=99.0.0';
const IMAGE_MODELS = [
    { slug: 'gpt-image-2', displayName: 'GPT Image 2' },
    { slug: 'gpt-image-1', displayName: 'GPT Image 1' },
];

class ChatGPTProvider {
    /**
     * @param {{ id?:number, name:string, auth:import('./chatgptOAuth').CodexAuth|null, chatModel?:string, imageModel?:string,
     *           onAuthUpdate?:(auth)=>void, onNeedsReauth?:(err)=>void }} cfg
     */
    constructor(cfg) {
        this.id = cfg.id || 0;
        this.kind = 'chatgpt';
        this.name = cfg.name;
        this.auth = cfg.auth || null;
        this.chatModel = cfg.chatModel || '';
        this.imageModel = cfg.imageModel || '';
        this.embedModel = '';
        this.onAuthUpdate = cfg.onAuthUpdate || (() => {});
        this.onNeedsReauth = cfg.onNeedsReauth || (() => {});
        this._refreshing = null;
        this.needsReauth = false;
    }

    get supports() {
        return { chat: true, tools: true, vision: true, image: true, embed: false };
    }

    authInfo() {
        if (!this.auth) return null;
        return { email: this.auth.email || '', accountId: this.auth.accountId, expiresAt: this.auth.expiresAt };
    }

    async _freshAuth(force = false) {
        if (!this.auth?.refreshToken) throw new ProviderError('Chưa đăng nhập ChatGPT', { authFail: true, code: 'NO_AUTH' });
        if (this.needsReauth) throw new ProviderError('Tài khoản ChatGPT cần đăng nhập lại', { authFail: true, code: 'NEEDS_REAUTH' });
        if (!force && this.auth.expiresAt - 60000 > Date.now()) return this.auth;
        if (!this._refreshing) {
            this._refreshing = refreshAuth(this.auth)
                .then(a => { this.auth = a; try { this.onAuthUpdate(a); } catch { /* bỏ qua */ } return a; })
                .catch(e => {
                    if (e.code === 'INVALID_GRANT' || e.authFail) { this.needsReauth = true; try { this.onNeedsReauth(e); } catch { /* bỏ qua */ } }
                    throw e;
                })
                .finally(() => { this._refreshing = null; });
        }
        return this._refreshing;
    }

    _headers(auth) {
        return {
            authorization: `Bearer ${auth.accessToken}`,
            'chatgpt-account-id': auth.accountId,
            'openai-beta': 'responses=experimental',
            originator: 'codex_cli_rs',
            session_id: crypto.randomUUID(),
            'content-type': 'application/json',
            accept: 'text/event-stream',
        };
    }

    buildBody(req) {
        const input = [];
        for (const m of req.messages) {
            if (m.role === 'user') {
                const content = [{ type: 'input_text', text: m.content || '' }];
                for (const img of m.images || []) content.push({ type: 'input_image', image_url: img, detail: 'auto' });
                input.push({ type: 'message', role: 'user', content });
            } else if (m.role === 'assistant') {
                if (m.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
                for (const tc of m.toolCalls || []) {
                    input.push({ type: 'function_call', name: tc.name, arguments: JSON.stringify(tc.args ?? {}), call_id: tc.id });
                }
            } else if (m.role === 'tool') {
                input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content ?? '' });
            }
        }
        const body = {
            model: req.model || this.chatModel,
            instructions: req.system || 'You are a helpful assistant.',
            input,
            store: false,
            stream: true,
        };
        if (req.tools?.length) {
            body.tools = req.tools.map(t => ({ type: 'function', name: t.name, description: t.description, strict: false, parameters: t.parameters }));
            body.tool_choice = 'auto';
            body.parallel_tool_calls = false;
        }
        if (req.reasoningEffort && req.reasoningEffort !== 'none') body.reasoning = { effort: req.reasoningEffort };
        return body;
    }

    /** POST + xử lý 401 (refresh 1 lần) + retry 429/5xx tối đa 3 lần. Trả Response có body SSE. */
    async _post(body, { signal, timeoutMs } = {}) {
        let auth = await this._freshAuth();
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            let res;
            try {
                res = await fetch(CODEX_API, {
                    method: 'POST', headers: this._headers(auth), body: JSON.stringify(body),
                    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs || 120000)]) : AbortSignal.timeout(timeoutMs || 120000),
                });
            } catch (e) {
                lastErr = new ProviderError(`Codex: lỗi mạng: ${e.message}`, { code: 'NETWORK' });
                if (signal?.aborted) throw lastErr;
                await sleep(500 * 2 ** attempt); continue;
            }
            if (res.status === 401) {
                auth = await this._freshAuth(true);
                res = await fetch(CODEX_API, { method: 'POST', headers: this._headers(auth), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs || 120000) });
                if (res.status === 401) {
                    this.needsReauth = true;
                    const err = new ProviderError('Codex: tài khoản bị từ chối (401) — cần đăng nhập lại ChatGPT', { status: 401, authFail: true, code: 'NEEDS_REAUTH' });
                    try { this.onNeedsReauth(err); } catch { /* bỏ qua */ }
                    throw err;
                }
            }
            if (res.ok && res.body) return res;
            const text = await res.text().catch(() => '');
            const ra = Number(res.headers.get('retry-after'));
            lastErr = new ProviderError(`Codex API lỗi ${res.status}: ${maskSecrets(text).slice(0, 500)}`, {
                status: res.status, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0,
            });
            if (!lastErr.retryable) throw lastErr;
            await sleep(lastErr.retryAfterMs || 500 * 2 ** attempt + Math.random() * 200);
        }
        throw lastErr;
    }

    /** Đọc SSE, gọi onEvent(payload) cho từng event JSON. */
    async _readSse(res, onEvent) {
        const decoder = new TextDecoder();
        let buffer = '';
        let dataLines = [];
        for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).replace(/\r$/, '');
                buffer = buffer.slice(idx + 1);
                if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                else if (line === '') {
                    const data = dataLines.join('\n');
                    dataLines = [];
                    if (!data || data === '[DONE]') continue;
                    let payload;
                    try { payload = JSON.parse(data); } catch { continue; }
                    onEvent(payload);
                }
            }
        }
    }

    /** @param {import('./types').ChatRequest} req @returns {Promise<import('./types').ChatResponse>} */
    async chat(req) {
        const res = await this._post(this.buildBody(req), { signal: req.signal, timeoutMs: req.timeoutMs });

        let content = '';
        let completedText = null;
        const toolCalls = [];
        const seen = new Set();
        const pending = new Map(); // item_id → { name, callId, args } — dự phòng khi thiếu output_item.done
        let usage = { inputTokens: 0, outputTokens: 0 };
        let truncated = false;
        let sawTerminal = false;

        const addToolCall = (fc) => {
            const id = fc.call_id || fc.id;
            if (!id || !fc.name || seen.has(id)) return;
            seen.add(id);
            toolCalls.push({ id, name: fc.name, args: safeParseArgs(fc.arguments) });
        };
        const collectItem = (item) => {
            if (!item) return;
            if (item.type === 'function_call') addToolCall(item);
            else if (item.type === 'message') {
                const text = (item.content || []).filter(c => c.type === 'output_text' && c.text).map(c => c.text).join('');
                if (text) completedText = (completedText || '') + text;
            }
        };

        await this._readSse(res, (ev) => {
            if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') { content += ev.delta; return; }
            if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call' && ev.item.id) {
                pending.set(ev.item.id, { name: ev.item.name, callId: ev.item.call_id, args: '' });
            }
            if (ev.type === 'response.function_call_arguments.delta' && ev.item_id && typeof ev.delta === 'string') {
                const p = pending.get(ev.item_id) || { args: '' };
                p.args += ev.delta;
                pending.set(ev.item_id, p);
            }
            if (ev.type === 'response.output_item.done') { collectItem(ev.item); if (ev.item?.id) pending.delete(ev.item.id); }
            if (ev.type === 'response.failed') {
                throw new ProviderError(`Codex response.failed: ${ev.response?.error?.message || 'không rõ'}`);
            }
            if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
                sawTerminal = true;
                if (ev.type === 'response.incomplete') truncated = true;
                for (const item of ev.response?.output || []) collectItem(item);
                for (const p of pending.values()) if (p.name) addToolCall({ name: p.name, call_id: p.callId, arguments: p.args });
                pending.clear();
                usage = { inputTokens: ev.response?.usage?.input_tokens ?? 0, outputTokens: ev.response?.usage?.output_tokens ?? 0 };
            }
        });

        if (!sawTerminal) throw new ProviderError('Codex: stream kết thúc bất thường (mất kết nối giữa chừng) — câu trả lời chưa hoàn tất', { code: 'NETWORK' });
        const finalContent = content || completedText;
        return {
            content: finalContent || null,
            toolCalls,
            stopReason: truncated ? 'max_tokens' : (toolCalls.length ? 'tool_use' : 'end'),
            usage,
        };
    }

    /** @param {import('./types').ImageRequest} req @returns {Promise<import('./types').ImageResult>} */
    async generateImage(req) {
        const content = [];
        for (const img of req.refImages || []) content.push({ type: 'input_image', image_url: img, detail: 'auto' });
        content.push({ type: 'input_text', text: req.prompt });
        const body = {
            model: this.chatModel || 'gpt-5.5',
            stream: true,
            store: false,
            instructions: "Generate an image matching the user's description using the image_generation tool. Return only the image; do not describe it in text.",
            input: [{ role: 'user', content }],
            tools: [{ type: 'image_generation', action: 'generate', model: req.model || this.imageModel || 'gpt-image-2', output_format: 'png', size: req.size || '1024x1024' }],
            tool_choice: { type: 'image_generation' },
        };
        const res = await this._post(body, { signal: req.signal, timeoutMs: req.timeoutMs || 360000 });
        let b64 = '';
        let format = 'png';
        let failed = '';
        await this._readSse(res, (ev) => {
            if (ev.type === 'response.output_item.done' && ev.item?.type === 'image_generation_call' && ev.item.result) {
                b64 = ev.item.result; if (ev.item.output_format) format = ev.item.output_format;
            }
            if (ev.type === 'response.completed') {
                for (const it of ev.response?.output || []) if (it.type === 'image_generation_call' && it.result) { b64 = it.result; if (it.output_format) format = it.output_format; }
            }
            if (ev.type === 'response.failed') failed = ev.response?.error?.message || 'không rõ';
        });
        if (failed) throw new ProviderError(`Codex tạo ảnh thất bại: ${failed}`);
        if (!b64) throw new ProviderError('Codex tạo ảnh: không nhận được ảnh trong stream');
        return { data: Buffer.from(b64, 'base64'), mime: format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png' };
    }

    /** Model tài khoản đang dùng được. */
    async listModels() {
        const auth = await this._freshAuth();
        const res = await fetch(CODEX_MODELS, {
            headers: { authorization: `Bearer ${auth.accessToken}`, 'chatgpt-account-id': auth.accountId, originator: 'codex_cli_rs' },
            signal: AbortSignal.timeout(30000),
        });
        if (res.status === 401) { this.needsReauth = true; throw new ProviderError('Codex list models: 401 — cần đăng nhập lại', { status: 401, authFail: true, code: 'NEEDS_REAUTH' }); }
        if (!res.ok) throw new ProviderError(`Codex list models lỗi ${res.status}`, { status: res.status });
        const data = await res.json();
        return (data.models || [])
            .filter(m => m.visibility !== 'hidden')
            .map(m => ({ slug: m.slug, displayName: m.display_name || m.slug }));
    }

    async listImageModels() { return IMAGE_MODELS; }
    async listEmbeddingModels() { return []; }
    async embed() { throw new ProviderError('ChatGPT subscription không hỗ trợ embedding'); }

    async verify({ chatModel } = {}) {
        const models = await this.listModels();
        const model = chatModel || this.chatModel || models[0]?.slug;
        let chatOk = null;
        if (model) {
            const r = await this.chat({ model, messages: [{ role: 'user', content: 'Return only the word OK.' }] });
            chatOk = typeof r.content === 'string';
        }
        return { models, chatOk };
    }
}

module.exports = { ChatGPTProvider, CODEX_API, IMAGE_MODELS };

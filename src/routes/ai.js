// =============================================
// Routes /app/ai/* — quản trị Trợ lý AI (mount trong web.js SAU webAuth → mọi route đều cần đăng nhập web)
// Không bao giờ trả API key / token ra ngoài; lỗi provider đều qua maskSecrets.
// =============================================
const express = require('express');
const router = express.Router();
const { z } = require('zod');

const store = require('../db');
const config = require('../config');
const logger = require('../services/logger');
const aiEngine = require('../services/ai/engine');
const { KINDS } = require('../services/ai/providers/manager');
const { maskSecrets, encryptSecret } = require('../services/ai/secrets');

function ok(res, data) { res.set('Cache-Control', 'no-store').json({ success: true, data }); }
function fail(res, code, message, status = 400) {
    res.status(status).json({ success: false, error: { code, message: maskSecrets(message) } });
}
function handleErr(res, err, ctx = '') {
    if (err?.name === 'ZodError') {
        const msg = err.issues?.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') || 'Dữ liệu không hợp lệ';
        return fail(res, 'INVALID', msg, 400);
    }
    logger.error(`❌ [ai] ${ctx}`, maskSecrets(err?.message || String(err)));
    const status = err?.status === 401 || err?.authFail ? 401 : (err?.status >= 400 && err?.status < 500) ? err.status : 500;
    fail(res, err?.code || 'INTERNAL_ERROR', err?.message || 'Lỗi không xác định', status);
}

const aiStore = store.ai;
const slugify = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// ==========================================
// Settings + trạng thái tổng
// ==========================================
router.get('/settings', (req, res) => {
    ok(res, {
        settings: aiEngine.settings.get(),
        status: aiEngine.status(),
        tools: aiEngine.tools.describe(),
        providers: aiEngine.providers.list(),
        kinds: KINDS,
    });
});

router.put('/settings', (req, res) => {
    try {
        const patch = req.body || {};
        for (const key of ['chat_provider_id', 'fallback_provider_id', 'image_provider_id', 'embedding_provider_id']) {
            if (patch[key] !== undefined && patch[key] !== null && !aiStore.providers.get(patch[key])) {
                return fail(res, 'NOT_FOUND', `Provider #${patch[key]} không tồn tại (${key})`, 404);
            }
        }
        if (patch.image_provider_id) {
            const row = aiStore.providers.get(patch.image_provider_id);
            if (row.kind === 'openai' || row.kind === 'openai_compat') return fail(res, 'INVALID', 'Provider này không hỗ trợ tạo ảnh (chỉ Gemini hoặc ChatGPT)');
        }
        const settings = aiEngine.settings.update(patch);
        aiEngine.providers.invalidate();
        logger.info(`⚙️ [ai] Cập nhật cấu hình: ${Object.keys(patch).join(', ')}`);
        ok(res, { settings, status: aiEngine.status(), tools: aiEngine.tools.describe() });
    } catch (err) { handleErr(res, err, 'PUT /settings'); }
});

// ==========================================
// Providers
// ==========================================
const providerBody = z.object({
    kind: z.enum(['gemini', 'openai', 'openai_compat', 'chatgpt']),
    name: z.string().min(1).max(60),
    api_key: z.string().max(500).optional(),
    base_url: z.string().max(300).optional(),
    chat_model: z.string().max(120).optional(),
    image_model: z.string().max(120).optional(),
    embed_model: z.string().max(120).optional(),
    embed_dims: z.number().int().min(0).max(8192).optional(),
});

function normalizeBaseUrl(kind, baseUrl) {
    if (KINDS[kind]?.fixedBase) return '';
    const u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) throw Object.assign(new Error('openai_compat cần Base URL'), { code: 'INVALID', status: 400 });
    let parsed;
    try { parsed = new URL(u); } catch { throw Object.assign(new Error('Base URL không hợp lệ'), { code: 'INVALID', status: 400 }); }
    if (parsed.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) throw Object.assign(new Error('Base URL phải là https'), { code: 'INVALID', status: 400 });
    return u;
}

/** Tạo instance tạm + tải catalog (chat/image/embedding) + chat test nếu có chatModel */
async function inspect({ kind, apiKey, baseUrl, chatModel, imageModel, auth, id = 0 }) {
    const inst = aiEngine.providers.makeInstance({ id, kind, name: 'credential-check', apiKey, baseUrl, chatModel, imageModel, auth });
    const [models, imageModels, embeddingModels] = await Promise.all([
        inst.listModels(),
        inst.listImageModels().catch(() => []),
        inst.listEmbeddingModels().catch(() => []),
    ]);
    let chatOk = null;
    if (chatModel) {
        const r = await inst.chat({ model: chatModel, messages: [{ role: 'user', content: 'Return only the word OK.' }], maxTokens: 20 });
        chatOk = typeof r.content === 'string' && r.content.length > 0;
    }
    return { models, imageModels, embeddingModels, chatOk };
}

function metaFrom(row, extra) {
    let meta = {};
    try { meta = JSON.parse(row?.meta || '{}'); } catch { /* bỏ qua */ }
    return { ...meta, ...extra };
}

router.get('/providers', (req, res) => ok(res, { providers: aiEngine.providers.list(), kinds: KINDS }));

router.post('/providers/preview', async (req, res) => {
    try {
        const b = req.body || {};
        if (b.id) {
            const row = aiStore.providers.get(Number(b.id));
            if (!row) return fail(res, 'NOT_FOUND', 'Provider không tồn tại', 404);
            const inst = aiEngine.providers.get(row.id);
            if (!inst) return fail(res, 'DISABLED', 'Provider đang tắt', 409);
            const [models, imageModels, embeddingModels] = await Promise.all([inst.listModels(), inst.listImageModels().catch(() => []), inst.listEmbeddingModels().catch(() => [])]);
            aiStore.providers.update(row.id, { meta: metaFrom(row, { models, image_models: imageModels, embedding_models: embeddingModels }) });
            return ok(res, { verified: true, models, image_models: imageModels, embedding_models: embeddingModels });
        }
        const kind = b.kind;
        if (!KINDS[kind] || kind === 'chatgpt') return fail(res, 'INVALID', 'Loại provider không hợp lệ cho preview bằng API key');
        const apiKey = String(b.api_key || '').trim();
        if (!apiKey) return fail(res, 'INVALID', 'Thiếu API key');
        const baseUrl = normalizeBaseUrl(kind, b.base_url);
        const r = await inspect({ kind, apiKey, baseUrl });
        ok(res, { verified: true, models: r.models, image_models: r.imageModels, embedding_models: r.embeddingModels });
    } catch (err) {
        if (err?.status === 401 || err?.status === 403 || err?.authFail) return fail(res, 'INVALID_KEY', 'API key không hợp lệ hoặc đã bị thu hồi', 401);
        handleErr(res, err, 'POST /providers/preview');
    }
});

router.post('/providers', async (req, res) => {
    try {
        const b = providerBody.parse(req.body || {});
        const name = slugify(b.name) || `${b.kind}-${Date.now().toString(36)}`;
        if (aiStore.providers.getByName(name)) return fail(res, 'DUPLICATE', `Tên provider "${name}" đã tồn tại`, 409);

        if (b.kind === 'chatgpt') {
            const info = aiStore.providers.create({
                kind: 'chatgpt', name, chatModel: b.chat_model || '', imageModel: b.image_model || 'gpt-image-2',
                status: 'needs_reauth', statusNote: 'Chưa đăng nhập ChatGPT', meta: {},
            });
            const row = aiStore.providers.get(info.lastInsertRowid);
            logger.info(`🤖 [ai] Tạo provider ChatGPT "${name}" (chờ đăng nhập)`);
            return ok(res, { provider: aiEngine.providers.publicInfo(row) });
        }

        const apiKey = String(b.api_key || '').trim();
        if (!apiKey) return fail(res, 'INVALID', 'Thiếu API key');
        const baseUrl = normalizeBaseUrl(b.kind, b.base_url);
        const r = await inspect({ kind: b.kind, apiKey, baseUrl, chatModel: b.chat_model, imageModel: b.image_model });
        const info = aiStore.providers.create({
            kind: b.kind, name, baseUrl, secretEnc: encryptSecret(apiKey),
            chatModel: b.chat_model || '', imageModel: b.image_model || '', embedModel: b.embed_model || '', embedDims: b.embed_dims || 0,
            status: 'ok', statusNote: r.chatOk === false ? 'Chat test không trả text' : '',
            meta: { models: r.models, image_models: r.imageModels, embedding_models: r.embeddingModels, verified_at: Date.now() },
        });
        const row = aiStore.providers.get(info.lastInsertRowid);
        logger.info(`🤖 [ai] Tạo provider ${b.kind} "${name}" (model=${b.chat_model || '-'})`);
        ok(res, { provider: aiEngine.providers.publicInfo(row) });
    } catch (err) {
        if (err?.status === 401 || err?.status === 403 || err?.authFail) return fail(res, 'INVALID_KEY', 'API key không hợp lệ hoặc đã bị thu hồi', 401);
        handleErr(res, err, 'POST /providers');
    }
});

router.patch('/providers/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const row = aiStore.providers.get(id);
        if (!row) return fail(res, 'NOT_FOUND', 'Provider không tồn tại', 404);
        const b = providerBody.partial().extend({ is_enabled: z.boolean().optional() }).parse(req.body || {});
        const fields = {};
        if (b.name !== undefined) {
            const name = slugify(b.name);
            if (!name) return fail(res, 'INVALID', 'Tên không hợp lệ');
            const dup = aiStore.providers.getByName(name);
            if (dup && dup.id !== id) return fail(res, 'DUPLICATE', `Tên provider "${name}" đã tồn tại`, 409);
            fields.name = name;
        }
        if (b.chat_model !== undefined) fields.chatModel = b.chat_model;
        if (b.image_model !== undefined) fields.imageModel = b.image_model;
        if (b.embed_model !== undefined) fields.embedModel = b.embed_model;
        if (b.embed_dims !== undefined) fields.embedDims = b.embed_dims;
        if (b.is_enabled !== undefined) fields.isEnabled = b.is_enabled;

        const newKey = row.kind !== 'chatgpt' && b.api_key ? String(b.api_key).trim() : '';
        const newBase = row.kind === 'openai_compat' && b.base_url !== undefined ? normalizeBaseUrl(row.kind, b.base_url) : undefined;
        if (newKey || newBase !== undefined) {
            const apiKey = newKey || (row.secret_enc ? require('../services/ai/secrets').decryptSecret(row.secret_enc) : '');
            const r = await inspect({ kind: row.kind, apiKey, baseUrl: newBase ?? row.base_url, chatModel: fields.chatModel ?? row.chat_model });
            if (newKey) fields.secretEnc = encryptSecret(newKey);
            if (newBase !== undefined) fields.baseUrl = newBase;
            fields.status = 'ok';
            fields.statusNote = '';
            fields.meta = metaFrom(row, { models: r.models, image_models: r.imageModels, embedding_models: r.embeddingModels, verified_at: Date.now() });
        }
        aiStore.providers.update(id, fields);
        aiEngine.providers.invalidate(id);
        ok(res, { provider: aiEngine.providers.publicInfo(aiStore.providers.get(id)) });
    } catch (err) {
        if (err?.status === 401 || err?.status === 403 || err?.authFail) return fail(res, 'INVALID_KEY', 'API key không hợp lệ hoặc đã bị thu hồi', 401);
        handleErr(res, err, 'PATCH /providers/:id');
    }
});

router.post('/providers/:id/verify', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const row = aiStore.providers.get(id);
        if (!row) return fail(res, 'NOT_FOUND', 'Provider không tồn tại', 404);
        const inst = aiEngine.providers.get(id);
        if (!inst) return fail(res, 'DISABLED', 'Provider đang tắt', 409);
        try {
            const r = await inst.verify({ chatModel: row.chat_model });
            const [imageModels, embeddingModels] = await Promise.all([inst.listImageModels().catch(() => []), inst.listEmbeddingModels().catch(() => [])]);
            aiStore.providers.update(id, {
                status: 'ok', statusNote: r.chatOk === false ? 'Chat test không trả text' : '',
                meta: metaFrom(row, { models: r.models, image_models: imageModels, embedding_models: embeddingModels, verified_at: Date.now() }),
            });
        } catch (e) {
            aiStore.providers.update(id, { status: e.authFail ? 'needs_reauth' : 'error', statusNote: maskSecrets(e.message).slice(0, 300) });
        }
        aiEngine.providers.invalidate(id);
        ok(res, { provider: aiEngine.providers.publicInfo(aiStore.providers.get(id)) });
    } catch (err) { handleErr(res, err, 'POST /providers/:id/verify'); }
});

router.delete('/providers/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = aiStore.providers.get(id);
    if (!row) return fail(res, 'NOT_FOUND', 'Provider không tồn tại', 404);
    const s = aiEngine.settings.get();
    const roles = [['chat_provider_id', 'provider chat'], ['fallback_provider_id', 'provider dự phòng'], ['image_provider_id', 'provider tạo ảnh'], ['embedding_provider_id', 'provider embedding']]
        .filter(([k]) => s[k] === id).map(([, label]) => label);
    if (roles.length) return fail(res, 'IN_USE', `Đang được dùng làm ${roles.join(', ')} — đổi vai trò trước khi xóa`, 409);
    aiStore.providers.remove(id);
    aiEngine.providers.invalidate(id);
    logger.info(`🗑️ [ai] Xóa provider #${id} (${row.name})`);
    ok(res, {});
});

// ==========================================
// ChatGPT OAuth (dán URL callback; hoặc callback local khi AI_OAUTH_LOCAL_CALLBACK=1)
// ==========================================
async function saveChatgptAuth(providerId, auth) {
    const row = aiStore.providers.get(providerId);
    if (!row || row.kind !== 'chatgpt') throw new Error('Provider ChatGPT không tồn tại');
    aiStore.providers.update(providerId, {
        secretEnc: encryptSecret(JSON.stringify(auth)), status: 'ok', statusNote: '',
        meta: metaFrom(row, { email: auth.email || '', accountId: auth.accountId, logged_in_at: Date.now() }),
    });
    aiEngine.providers.invalidate(providerId);
    // Tải danh sách model (best-effort) + chọn model mặc định nếu chưa có
    try {
        const inst = aiEngine.providers.get(providerId);
        const models = await inst.listModels();
        const fresh = aiStore.providers.get(providerId);
        const patch = { meta: metaFrom(fresh, { models, image_models: await inst.listImageModels(), verified_at: Date.now() }) };
        if (!fresh.chat_model && models.length) patch.chatModel = (models.find(m => /gpt-5/i.test(m.slug)) || models[0]).slug;
        aiStore.providers.update(providerId, patch);
        aiEngine.providers.invalidate(providerId);
    } catch (e) { logger.warn(`⚠️ [ai] ChatGPT listModels sau login lỗi: ${maskSecrets(e.message)}`); }
    logger.info(`🔐 [ai] Đăng nhập ChatGPT thành công cho provider #${providerId} (${auth.email || auth.accountId})`);
}

router.post('/chatgpt/login/start', (req, res) => {
    try {
        const providerId = Number(req.body?.provider_id);
        const row = aiStore.providers.get(providerId);
        if (!row || row.kind !== 'chatgpt') return fail(res, 'NOT_FOUND', 'Provider ChatGPT không tồn tại', 404);
        const r = aiEngine.login.start({ localCallback: config.AI_OAUTH_LOCAL_CALLBACK, providerId }, (auth) => saveChatgptAuth(providerId, auth));
        ok(res, { ...r, redirect_uri: 'http://localhost:1455/auth/callback' });
    } catch (err) { handleErr(res, err, 'POST /chatgpt/login/start'); }
});

router.post('/chatgpt/login/complete', async (req, res) => {
    try {
        const providerId = Number(req.body?.provider_id) || aiEngine.login.status().provider_id;
        const row = aiStore.providers.get(providerId);
        if (!row || row.kind !== 'chatgpt') return fail(res, 'NOT_FOUND', 'Provider ChatGPT không tồn tại', 404);
        const auth = await aiEngine.login.complete(String(req.body?.callback_url || ''));
        await saveChatgptAuth(providerId, auth);
        ok(res, { email: auth.email || '', account_id: auth.accountId, provider: aiEngine.providers.publicInfo(aiStore.providers.get(providerId)) });
    } catch (err) { handleErr(res, err, 'POST /chatgpt/login/complete'); }
});

router.get('/chatgpt/login/status', (req, res) => ok(res, aiEngine.login.status()));
router.post('/chatgpt/login/cancel', (req, res) => { aiEngine.login.cancel(); ok(res, {}); });

// ==========================================
// Thử nhanh (không gửi Zalo)
// ==========================================
router.post('/test', async (req, res) => {
    try {
        const { message = '', image_base64 = null, thread_id = null, history = [] } = req.body || {};
        if (!String(message).trim() && !image_base64) return fail(res, 'MISSING_PARAMS', 'Nhập câu hỏi hoặc gửi ảnh');
        const r = await aiEngine.testRun({ message: String(message).slice(0, 4000), imageDataUrl: image_base64, threadId: thread_id, history: Array.isArray(history) ? history : [] });
        ok(res, r);
    } catch (err) { handleErr(res, err, 'POST /test'); }
});

// ==========================================
// Trạng thái theo thread
// ==========================================
router.get('/threads/:id/state', (req, res) => ok(res, aiEngine.threadStatus(String(req.params.id))));

router.put('/threads/:id/state', (req, res) => {
    try {
        const b = z.object({
            ai_enabled: z.boolean().nullable().optional(),
            resume: z.boolean().optional(),
            pause_minutes: z.number().min(0).max(24 * 60).optional(),
            needs_human: z.boolean().optional(),
        }).parse(req.body || {});
        ok(res, aiEngine.setThreadState(String(req.params.id), b));
    } catch (err) { handleErr(res, err, 'PUT /threads/:id/state'); }
});

router.post('/threads/:id/reset', (req, res) => {
    aiEngine.resetThread(String(req.params.id));
    ok(res, aiEngine.threadStatus(String(req.params.id)));
});

// ==========================================
// Nhật ký + thống kê
// ==========================================
router.get('/logs', (req, res) => {
    const { thread_id = '', status = '', limit = '50', before_id = '0' } = req.query;
    const logs = aiStore.logs.list({ threadId: String(thread_id), status: String(status), limit: parseInt(limit, 10) || 50, beforeId: parseInt(before_id, 10) || 0 });
    const threadIds = [...new Set(logs.map(l => l.thread_id))];
    const names = {};
    for (const tid of threadIds) names[tid] = store.threads.get(tid)?.name || '';
    ok(res, { logs, thread_names: names });
});

router.get('/stats', (req, res) => {
    const now = Date.now();
    const dayStart = new Date(new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) + 'T00:00:00+07:00').getTime();
    ok(res, {
        today: aiStore.logs.stats(dayStart),
        last7d: aiStore.logs.stats(now - 7 * 24 * 3600 * 1000),
        engine: aiEngine.status(),
    });
});

module.exports = router;

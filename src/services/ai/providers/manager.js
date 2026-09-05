// =============================================
// Provider manager: DB row → instance (giải mã secret), cache, hot-reload; chọn provider theo vai trò
// (chat / dự phòng / tạo ảnh / embedding) từ ai_settings. Không bao giờ trả secret ra ngoài.
// =============================================
const { encryptSecret, decryptSecret } = require('../secrets');
const { OpenAICompatProvider } = require('./openaiCompat');
const { GeminiProvider } = require('./gemini');
const { ChatGPTProvider } = require('./chatgpt');
const { ProviderError } = require('./types');

const KINDS = {
    gemini: { label: 'Gemini (API key)', needsKey: true, fixedBase: true },
    openai: { label: 'OpenAI (API key)', needsKey: true, fixedBase: true },
    openai_compat: { label: 'OpenAI-compatible (OpenRouter, DeepSeek, Groq...)', needsKey: true, fixedBase: false },
    chatgpt: { label: 'ChatGPT subscription (đăng nhập OAuth)', needsKey: false, fixedBase: true },
};

function createProviderManager({ aiStore, settings, logger }) {
    const instances = new Map(); // id → { instance, updatedAt }

    function readSecret(row) {
        if (!row.secret_enc) return null;
        try { return decryptSecret(row.secret_enc); } catch (e) {
            logger?.error(`❌ [ai] Không giải mã được secret provider #${row.id} (${row.name}): ${e.message}`);
            return null;
        }
    }

    /** Tạo instance từ tham số thô (dùng cho preview trước khi lưu). */
    function makeInstance({ id = 0, kind, name, apiKey = '', baseUrl = '', chatModel = '', imageModel = '', embedModel = '', embedDims = 0, auth = null }) {
        if (kind === 'gemini') return new GeminiProvider({ id, name, apiKey, chatModel, imageModel, embedModel, embedDims });
        if (kind === 'openai') return new OpenAICompatProvider({ id, kind, name, apiKey, chatModel, embedModel, embedDims });
        if (kind === 'openai_compat') {
            if (!baseUrl) throw new ProviderError('openai_compat cần Base URL');
            return new OpenAICompatProvider({ id, kind, name, apiKey, baseURL: baseUrl, chatModel, embedModel, embedDims });
        }
        if (kind === 'chatgpt') {
            return new ChatGPTProvider({
                id, name, auth, chatModel, imageModel,
                onAuthUpdate: (a) => { if (id) aiStore.providers.update(id, { secretEnc: encryptSecret(JSON.stringify(a)), status: 'ok', statusNote: '', meta: { email: a.email || '', accountId: a.accountId } }); },
                onNeedsReauth: (e) => { if (id) aiStore.providers.update(id, { status: 'needs_reauth', statusNote: e?.message || 'Cần đăng nhập lại' }); invalidate(id); },
            });
        }
        throw new ProviderError(`Loại provider không hỗ trợ: ${kind}`);
    }

    function fromRow(row) {
        const secret = readSecret(row);
        let auth = null;
        let apiKey = '';
        if (row.kind === 'chatgpt') { try { auth = secret ? JSON.parse(secret) : null; } catch { auth = null; } }
        else apiKey = secret || '';
        const inst = makeInstance({
            id: row.id, kind: row.kind, name: row.name, apiKey, baseUrl: row.base_url, chatModel: row.chat_model,
            imageModel: row.image_model, embedModel: row.embed_model, embedDims: row.embed_dims, auth,
        });
        if (row.kind === 'chatgpt' && row.status === 'needs_reauth') inst.needsReauth = true;
        return inst;
    }

    function get(id) {
        if (!id) return null;
        const row = aiStore.providers.get(id);
        if (!row || !row.is_enabled) return null;
        const cached = instances.get(id);
        if (cached && cached.updatedAt === row.updated_at) return cached.instance;
        const instance = fromRow(row);
        instances.set(id, { instance, updatedAt: row.updated_at });
        return instance;
    }

    function invalidate(id) { if (id) instances.delete(id); else instances.clear(); }

    function role(key) {
        const s = settings.get();
        return get(s[key]);
    }

    function publicInfo(row) {
        let meta = {};
        try { meta = JSON.parse(row.meta || '{}'); } catch { /* bỏ qua */ }
        const s = settings.get();
        return {
            id: row.id, kind: row.kind, kind_label: KINDS[row.kind]?.label || row.kind, name: row.name, base_url: row.base_url,
            has_secret: !!row.secret_enc, chat_model: row.chat_model, image_model: row.image_model, embed_model: row.embed_model,
            embed_dims: row.embed_dims, is_enabled: !!row.is_enabled, status: row.status, status_note: row.status_note,
            email: meta.email || '', account_id: meta.accountId || '', verified_at: meta.verified_at || null,
            models: meta.models || [], image_models: meta.image_models || [], embedding_models: meta.embedding_models || [],
            roles: {
                chat: s.chat_provider_id === row.id, fallback: s.fallback_provider_id === row.id,
                image: s.image_provider_id === row.id, embedding: s.embedding_provider_id === row.id,
            },
            created_at: row.created_at, updated_at: row.updated_at,
        };
    }

    return {
        KINDS,
        makeInstance,
        get,
        invalidate,
        list: () => aiStore.providers.list().map(publicInfo),
        publicInfo,
        getChat: () => role('chat_provider_id'),
        getFallback: () => role('fallback_provider_id'),
        getImage: () => role('image_provider_id'),
        getEmbedding: () => role('embedding_provider_id'),
        encryptSecret,
    };
}

module.exports = { createProviderManager, KINDS };

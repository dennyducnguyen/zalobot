// =============================================
// Gemini (API key): chat/tool/vision qua endpoint OpenAI-compatible của Google;
// tạo ảnh + embedding + catalog model qua REST native v1beta (cùng key).
// =============================================
const { OpenAICompatProvider } = require('./openaiCompat');
const { fetchJson } = require('./http');
const { ProviderError } = require('./types');

const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GEMINI_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const EXCLUDE_CHAT = /(embedding|live|omni|robotics|computer-use|image|tts|native-audio|audio|veo|imagen|aqa|learnlm)/i;

class GeminiProvider extends OpenAICompatProvider {
    constructor(cfg) {
        super({
            ...cfg,
            kind: 'gemini',
            baseURL: GEMINI_OPENAI_BASE_URL,
            defaultHeaders: { 'x-goog-api-client': 'zalo-inbox/1.0' },
        });
        this.imageModel = cfg.imageModel || '';
        this._catalog = null; // cache danh sách model native trong 10 phút
    }

    get supports() {
        return { chat: true, tools: true, vision: true, image: !!this.imageModel, embed: true };
    }

    _nativeUrl(path) { return `${GEMINI_NATIVE_BASE_URL}/${path.replace(/^\/+/, '')}`; }
    _nativeHeaders() { return { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey }; }

    /** Catalog native: [{ name:'models/gemini-...', displayName, supportedGenerationMethods[] }] */
    async _nativeCatalog() {
        if (this._catalog && Date.now() - this._catalog.at < 10 * 60 * 1000) return this._catalog.models;
        const models = [];
        let pageToken = '';
        for (let i = 0; i < 5; i++) {
            const q = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
            const json = await fetchJson(this._nativeUrl(`models?${q}`), { headers: this._nativeHeaders(), timeoutMs: 30000, retries: 1 });
            for (const m of json.models || []) {
                models.push({
                    slug: String(m.name || '').replace(/^models\//, ''),
                    displayName: m.displayName || String(m.name || '').replace(/^models\//, ''),
                    methods: m.supportedGenerationMethods || [],
                });
            }
            pageToken = json.nextPageToken || '';
            if (!pageToken) break;
        }
        this._catalog = { models, at: Date.now() };
        return models;
    }

    async listModels() {
        const all = await this._nativeCatalog();
        return all
            .filter(m => /^(gemini|gemma)-/i.test(m.slug) && m.methods.includes('generateContent') && !EXCLUDE_CHAT.test(m.slug))
            .sort((a, b) => b.slug.localeCompare(a.slug, 'en', { numeric: true })) // mới nhất lên đầu
            .map(({ slug, displayName }) => ({ slug, displayName }));
    }

    async listImageModels() {
        const all = await this._nativeCatalog();
        return all
            .filter(m => /^gemini-/i.test(m.slug) && /image/i.test(m.slug) && m.methods.includes('generateContent'))
            .sort((a, b) => b.slug.localeCompare(a.slug, 'en', { numeric: true }))
            .map(({ slug, displayName }) => ({ slug, displayName }));
    }

    async listEmbeddingModels() {
        const all = await this._nativeCatalog();
        return all
            .filter(m => m.methods.includes('embedContent'))
            .map(({ slug, displayName }) => ({ slug, displayName }));
    }

    /** @param {import('./types').ImageRequest} req @returns {Promise<import('./types').ImageResult>} */
    async generateImage(req) {
        const model = req.model || this.imageModel;
        if (!model) throw new ProviderError('Chưa chọn model tạo ảnh cho Gemini');
        const parts = [];
        for (const img of req.refImages || []) {
            const m = /^data:([^;]+);base64,(.+)$/s.exec(img);
            if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
        }
        parts.push({ text: req.prompt });
        const body = {
            contents: [{ role: 'user', parts }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        };
        const json = await fetchJson(this._nativeUrl(`models/${encodeURIComponent(model)}:generateContent`), {
            method: 'POST', headers: this._nativeHeaders(), body: JSON.stringify(body),
            timeoutMs: req.timeoutMs || 180000, retries: 1, signal: req.signal,
        });
        const cand = json.candidates?.[0];
        const outParts = cand?.content?.parts || [];
        const img = outParts.find(p => p.inlineData || p.inline_data);
        if (!img) {
            const txt = outParts.map(p => p.text).filter(Boolean).join(' ').slice(0, 300);
            const reason = cand?.finishReason || json.promptFeedback?.blockReason || '';
            throw new ProviderError(`Gemini không trả ảnh${reason ? ` (${reason})` : ''}${txt ? `: ${txt}` : ''}`);
        }
        const d = img.inlineData || img.inline_data;
        return { data: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type || 'image/png' };
    }

    /** @param {import('./types').EmbedRequest} req */
    async embed(req) {
        const model = req.model || this.embedModel;
        if (!model) throw new ProviderError('Chưa chọn model embedding cho Gemini');
        if (!req.inputs?.length) throw new ProviderError('Embedding cần ít nhất một input');
        const json = await fetchJson(this._nativeUrl(`models/${encodeURIComponent(model)}:batchEmbedContents`), {
            method: 'POST', headers: this._nativeHeaders(), timeoutMs: 60000,
            body: JSON.stringify({
                requests: req.inputs.map(text => ({
                    model: `models/${model}`,
                    content: { parts: [{ text }] },
                    ...(req.dimensions ? { outputDimensionality: req.dimensions } : {}),
                })),
            }),
        });
        const vectors = (json.embeddings || []).map(e => e.values);
        if (vectors.length !== req.inputs.length) throw new ProviderError(`Gemini trả ${vectors.length} vector cho ${req.inputs.length} input`);
        return { model, vectors, usage: { inputTokens: 0 } };
    }
}

module.exports = { GeminiProvider, GEMINI_OPENAI_BASE_URL, GEMINI_NATIVE_BASE_URL };

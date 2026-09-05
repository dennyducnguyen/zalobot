// =============================================
// Provider cho mọi endpoint tương thích OpenAI Chat Completions (OpenAI, OpenRouter, DeepSeek, Groq, Gemini-compat...)
// Dùng fetch native — không SDK. Hỗ trợ: chat, tools (function calling), ảnh vào (data URL), listModels, embed.
// =============================================
const { fetchJson } = require('./http');
const { ProviderError, safeParseArgs } = require('./types');

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const NON_CHAT_MODEL = /(embedding|moderation|whisper|tts|transcrib|speech|audio|realtime|image|dall-e|sora|babbage|davinci|curie|ada|search|rerank)/i;
// gpt-5.x / o-series: bắt buộc max_completion_tokens, không nhận temperature tùy ý
const REASONING_FAMILY = /(^|\/)(gpt-5|o\d)/i;
// gpt-5.6+ trên chat/completions với tools BẮT BUỘC reasoning_effort="none" nếu không muốn reasoning (400 nếu bỏ trống)
const REQUIRES_EFFORT_WITH_TOOLS = /(^|\/)gpt-5\.([6-9]|\d{2,})/i;

function isLikelyChatModel(id) { return !!id && !NON_CHAT_MODEL.test(id); }
function isLikelyEmbeddingModel(id) { return /(embedding|embed-|embed$)/i.test(id); }

function mapFinish(reason) {
    if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
    if (reason === 'length') return 'max_tokens';
    return 'end';
}

class OpenAICompatProvider {
    /**
     * @param {{ id?:number, kind?:string, name:string, apiKey:string, baseURL?:string, defaultHeaders?:object,
     *           chatModel?:string, embedModel?:string, embedDims?:number }} cfg
     */
    constructor(cfg) {
        this.id = cfg.id || 0;
        this.kind = cfg.kind || 'openai';
        this.name = cfg.name;
        this.apiKey = cfg.apiKey || '';
        this.baseURL = (cfg.baseURL || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.defaultHeaders = cfg.defaultHeaders || {};
        this.chatModel = cfg.chatModel || '';
        this.imageModel = '';
        this.embedModel = cfg.embedModel || '';
        this.embedDims = cfg.embedDims || 0;
    }

    get supports() {
        return { chat: true, tools: true, vision: true, image: false, embed: true };
    }

    _headers(extra = {}) {
        return {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
            ...this.defaultHeaders,
            ...extra,
        };
    }

    _url(path) { return `${this.baseURL}/${path.replace(/^\/+/, '')}`; }

    /** Map ChatRequest → body Chat Completions */
    buildBody(req) {
        const messages = [];
        if (req.system) messages.push({ role: 'system', content: req.system });
        for (const m of req.messages) {
            if (m.role === 'user') {
                if (m.images?.length) {
                    messages.push({
                        role: 'user',
                        content: [
                            { type: 'text', text: m.content || '' },
                            ...m.images.map(url => ({ type: 'image_url', image_url: { url } })),
                        ],
                    });
                } else {
                    messages.push({ role: 'user', content: m.content || '' });
                }
            } else if (m.role === 'assistant') {
                const am = { role: 'assistant', content: m.content ?? null };
                if (m.toolCalls?.length) {
                    am.tool_calls = m.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
                        ...(tc.providerData || {}), // vd Gemini thought_signature (extra_content)
                    }));
                }
                messages.push(am);
            } else if (m.role === 'tool') {
                messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' });
            }
        }
        const model = req.model || this.chatModel;
        const body = { model, messages };
        if (req.tools?.length) {
            body.tools = req.tools.map(t => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
            }));
            body.tool_choice = 'auto';
        }
        const reasoning = REASONING_FAMILY.test(model);
        if (req.maxTokens) {
            if (reasoning) body.max_completion_tokens = req.maxTokens;
            else body.max_tokens = req.maxTokens;
        }
        if (!reasoning && typeof req.temperature === 'number') body.temperature = req.temperature;
        if (reasoning) {
            if (body.tools && REQUIRES_EFFORT_WITH_TOOLS.test(model)) body.reasoning_effort = 'none';
            else if (req.reasoningEffort && ['low', 'medium', 'high'].includes(req.reasoningEffort)) body.reasoning_effort = req.reasoningEffort;
        }
        return body;
    }

    _mapResponse(json) {
        const choice = json.choices?.[0];
        if (!choice) throw new ProviderError('Provider không trả về choice nào');
        const toolCalls = (choice.message?.tool_calls || [])
            .filter(tc => !tc.type || tc.type === 'function')
            .map(tc => ({
                id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
                name: tc.function?.name || '',
                args: safeParseArgs(tc.function?.arguments),
                ...(tc.extra_content ? { providerData: { extra_content: tc.extra_content } } : {}),
            }))
            .filter(tc => tc.name);
        return {
            content: typeof choice.message?.content === 'string' ? choice.message.content : (choice.message?.content ?? null),
            toolCalls,
            stopReason: toolCalls.length ? 'tool_use' : mapFinish(choice.finish_reason),
            usage: {
                inputTokens: json.usage?.prompt_tokens ?? 0,
                outputTokens: json.usage?.completion_tokens ?? 0,
            },
        };
    }

    /** @param {import('./types').ChatRequest} req @returns {Promise<import('./types').ChatResponse>} */
    async chat(req) {
        const json = await fetchJson(this._url('chat/completions'), {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({ ...this.buildBody(req), stream: false }),
            timeoutMs: req.timeoutMs || 90000,
            signal: req.signal,
        });
        return this._mapResponse(json);
    }

    async _rawModelIds() {
        const json = await fetchJson(this._url('models'), { headers: this._headers(), timeoutMs: 30000, retries: 1 });
        return (json.data || []).map(m => String(m.id || '')).filter(Boolean);
    }

    /** @returns {Promise<import('./types').ModelInfo[]>} */
    async listModels() {
        const ids = [...new Set((await this._rawModelIds()).filter(isLikelyChatModel))];
        return ids.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map(id => ({ slug: id, displayName: id }));
    }

    async listImageModels() { return []; }

    async listEmbeddingModels() {
        const ids = [...new Set((await this._rawModelIds()).filter(isLikelyEmbeddingModel))];
        return ids.sort().map(id => ({ slug: id, displayName: id }));
    }

    /** @param {import('./types').EmbedRequest} req */
    async embed(req) {
        if (!req.inputs?.length) throw new ProviderError('Embedding cần ít nhất một input');
        const json = await fetchJson(this._url('embeddings'), {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({
                model: req.model || this.embedModel,
                input: req.inputs,
                encoding_format: 'float',
                ...(req.dimensions ? { dimensions: req.dimensions } : {}),
            }),
            timeoutMs: 60000,
        });
        const ordered = [...(json.data || [])].sort((a, b) => a.index - b.index);
        if (ordered.length !== req.inputs.length) throw new ProviderError(`Provider trả ${ordered.length} vector cho ${req.inputs.length} input`);
        return { model: json.model || req.model, vectors: ordered.map(d => d.embedding), usage: { inputTokens: json.usage?.prompt_tokens ?? 0 } };
    }

    async generateImage() {
        throw new ProviderError(`Provider "${this.name}" (${this.kind}) không hỗ trợ tạo ảnh`);
    }

    /** Kiểm tra credential thật: list model + 1 lượt chat ngắn nếu có chatModel */
    async verify({ chatModel } = {}) {
        const models = await this.listModels();
        const model = chatModel || this.chatModel;
        let chatOk = null;
        if (model) {
            const res = await this.chat({ model, messages: [{ role: 'user', content: 'Return only the word OK.' }], maxTokens: 20 });
            chatOk = typeof res.content === 'string';
        }
        return { models, chatOk };
    }
}

module.exports = { OpenAICompatProvider, OPENAI_DEFAULT_BASE_URL, isLikelyChatModel, isLikelyEmbeddingModel };

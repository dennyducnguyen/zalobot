const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-ai-prov-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.AI_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

const { OpenAICompatProvider } = require('../src/services/ai/providers/openaiCompat');
const { GeminiProvider } = require('../src/services/ai/providers/gemini');
const { ChatGPTProvider } = require('../src/services/ai/providers/chatgpt');
const oauth = require('../src/services/ai/providers/chatgptOAuth');
const { encryptSecret, decryptSecret, maskSecrets } = require('../src/services/ai/secrets');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function jsonResponse(obj, status = 200, headers = {}) {
    return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function sseResponse(events) {
    const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('secrets: round trip + mask', () => {
    const enc = encryptSecret('sk-abcdefghijklmnopqrstuvwxyz');
    assert.match(enc, /^v1\./);
    assert.equal(decryptSecret(enc), 'sk-abcdefghijklmnopqrstuvwxyz');
    assert.equal(maskSecrets('token sk-abcdefghijklmnopqrstuvwxyz AIzaSyABCDEFGHIJKLMNOPQRSTUVWX'), 'token sk-… AIza…');
    assert.throws(() => decryptSecret('v1.bad'));
});

test('openaiCompat: buildBody maps messages/tools/images and model-specific params', () => {
    const p = new OpenAICompatProvider({ name: 'x', apiKey: 'k', chatModel: 'gpt-4.1-mini' });
    const body = p.buildBody({
        model: 'gpt-4.1-mini', system: 'SYS', temperature: 0.5, maxTokens: 100,
        messages: [
            { role: 'user', content: 'hi', images: ['data:image/jpeg;base64,AAA'] },
            { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'get_current_time', args: {}, providerData: { extra_content: { google: 1 } } }] },
            { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
        ],
        tools: [{ name: 'get_current_time', description: 'd', parameters: { type: 'object', properties: {} } }],
    });
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].content[1].type, 'image_url');
    assert.equal(body.messages[2].tool_calls[0].function.name, 'get_current_time');
    assert.deepEqual(body.messages[2].tool_calls[0].extra_content, { google: 1 });
    assert.equal(body.messages[3].role, 'tool');
    assert.equal(body.max_tokens, 100);
    assert.equal(body.temperature, 0.5);
    assert.equal(body.tools[0].function.name, 'get_current_time');

    const r = p.buildBody({ model: 'gpt-5.7', messages: [{ role: 'user', content: 'x' }], maxTokens: 50, temperature: 0.2, reasoningEffort: 'low', tools: [{ name: 't', description: 'd', parameters: {} }] });
    assert.equal(r.max_completion_tokens, 50);
    assert.equal(r.temperature, undefined, 'reasoning model không nhận temperature');
    assert.equal(r.reasoning_effort, 'none', 'gpt-5.6+ với tools ép none');
    const r2 = p.buildBody({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'medium' });
    assert.equal(r2.reasoning_effort, 'medium');
});

test('openaiCompat: chat parses tool calls, listModels filters, 401 → authFail, 429 retries', async () => {
    const p = new OpenAICompatProvider({ name: 'x', apiKey: 'sk-secretkey1234567890', chatModel: 'm' });
    let calls = 0;
    globalThis.fetch = async (url, init) => {
        calls++;
        if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: 'gpt-4.1' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }] });
        const body = JSON.parse(init.body);
        assert.equal(init.headers.authorization, 'Bearer sk-secretkey1234567890');
        if (body.messages.at(-1).content === 'tool') {
            return jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
        }
        return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };
    const r = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'OK'); assert.equal(r.stopReason, 'end'); assert.equal(r.usage.inputTokens, 1);
    const t = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'tool' }] });
    assert.equal(t.stopReason, 'tool_use'); assert.deepEqual(t.toolCalls, [{ id: 'c1', name: 'f', args: { a: 1 } }]);
    assert.deepEqual((await p.listModels()).map(m => m.slug), ['gpt-4.1']);
    assert.deepEqual((await p.listEmbeddingModels()).map(m => m.slug), ['text-embedding-3-small']);

    globalThis.fetch = async () => new Response('{"error":"invalid key sk-secretkey1234567890"}', { status: 401 });
    await assert.rejects(p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), (e) => e.authFail === true && e.status === 401 && !e.message.includes('sk-secretkey1234567890'));

    calls = 0;
    globalThis.fetch = async () => { calls++; return calls < 3 ? new Response('busy', { status: 429, headers: { 'retry-after': '0' } }) : jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'after retry' } }] }); };
    const rr = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(rr.content, 'after retry'); assert.equal(calls, 3);
});

test('gemini: native catalog filters + generateImage + embed', async () => {
    const g = new GeminiProvider({ name: 'g', apiKey: 'AIzaKEY', chatModel: 'gemini-x-flash', imageModel: 'gemini-x-flash-image', embedModel: 'gemini-embedding-2' });
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        assert.equal(init.headers['x-goog-api-key'], 'AIzaKEY');
        if (u.includes('/models?')) return jsonResponse({ models: [
            { name: 'models/gemini-x-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-x-flash-image', displayName: 'Flash Image', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-x-tts', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/veo-3', supportedGenerationMethods: ['predictLongRunning'] },
        ] });
        if (u.includes(':generateContent')) {
            const body = JSON.parse(init.body);
            assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
            return jsonResponse({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') } }] } }] });
        }
        if (u.includes(':batchEmbedContents')) return jsonResponse({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] });
        throw new Error('unexpected ' + u);
    };
    assert.deepEqual((await g.listModels()).map(m => m.slug), ['gemini-x-flash']);
    assert.deepEqual((await g.listImageModels()).map(m => m.slug), ['gemini-x-flash-image']);
    assert.deepEqual((await g.listEmbeddingModels()).map(m => m.slug), ['gemini-embedding-2']);
    const img = await g.generateImage({ prompt: 'a cat' });
    assert.equal(img.mime, 'image/png'); assert.equal(img.data.toString(), 'PNG');
    const emb = await g.embed({ inputs: ['a', 'b'], dimensions: 2 });
    assert.equal(emb.vectors.length, 2);
    assert.equal(g.supports.image, true);
});

test('chatgpt: SSE parse (text, function_call via delta fallback, usage), 401 refresh, incomplete stream throws', async () => {
    const auth = { accessToken: 'at1', refreshToken: 'rt', idToken: '', accountId: 'acc', email: 'a@b.c', expiresAt: Date.now() + 3600e3 };
    const updates = [];
    const p = new ChatGPTProvider({ name: 'c', auth, chatModel: 'gpt-5.5', onAuthUpdate: a => updates.push(a) });
    let mode = 'text';
    globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes('auth.openai.com/oauth/token')) {
            const idToken = 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc' }, email: 'a@b.c' })).toString('base64url') + '.y';
            return jsonResponse({ access_token: 'at2', refresh_token: 'rt2', id_token: idToken, expires_in: 3600 });
        }
        assert.equal(init.headers['chatgpt-account-id'], 'acc');
        assert.equal(init.headers['openai-beta'], 'responses=experimental');
        if (mode === '401' && init.headers.authorization === 'Bearer at1') return new Response('unauthorized', { status: 401 });
        if (mode === 'incomplete') return sseResponse([{ type: 'response.output_text.delta', delta: 'partial' }]);
        if (mode === 'tool') return sseResponse([
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'it1', name: 'get_current_time', call_id: 'call_1' } },
            { type: 'response.function_call_arguments.delta', item_id: 'it1', delta: '{}' },
            { type: 'response.completed', response: { output: [], usage: { input_tokens: 10, output_tokens: 2 } } },
        ]);
        return sseResponse([
            { type: 'response.output_text.delta', delta: 'Xin ' },
            { type: 'response.output_text.delta', delta: 'chào' },
            { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Xin chào' }] } },
            { type: 'response.completed', response: { output: [], usage: { input_tokens: 5, output_tokens: 3 } } },
        ]);
    };
    const r = await p.chat({ messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low' });
    assert.equal(r.content, 'Xin chào'); assert.equal(r.usage.inputTokens, 5); assert.equal(r.stopReason, 'end');
    mode = 'tool';
    const t = await p.chat({ messages: [{ role: 'user', content: 'time?' }], tools: [{ name: 'get_current_time', description: 'd', parameters: {} }] });
    assert.equal(t.stopReason, 'tool_use'); assert.deepEqual(t.toolCalls, [{ id: 'call_1', name: 'get_current_time', args: {} }]);
    mode = '401';
    const r2 = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r2.content, 'Xin chào'); assert.equal(updates.length, 1); assert.equal(p.auth.accessToken, 'at2');
    mode = 'incomplete';
    await assert.rejects(p.chat({ messages: [{ role: 'user', content: 'hi' }] }), /bất thường/);
    const body = p.buildBody({ messages: [{ role: 'user', content: 'x', images: ['data:image/jpeg;base64,AA'] }, { role: 'assistant', content: 'y', toolCalls: [{ id: 'c', name: 'f', args: { a: 1 } }] }, { role: 'tool', toolCallId: 'c', content: 'out' }], system: 'S', tools: [{ name: 'f', description: 'd', parameters: {} }] });
    assert.equal(body.instructions, 'S'); assert.equal(body.input[0].content[1].type, 'input_image'); assert.equal(body.input[2].type, 'function_call'); assert.equal(body.input[3].type, 'function_call_output'); assert.equal(body.store, false);
});

test('chatgptOAuth: parseCallbackInput + login session state check', async () => {
    assert.deepEqual(oauth.parseCallbackInput('http://localhost:1455/auth/callback?code=abc&state=st'), { code: 'abc', state: 'st' });
    assert.deepEqual(oauth.parseCallbackInput('code=abc&state=st'), { code: 'abc', state: 'st' });
    assert.deepEqual(oauth.parseCallbackInput('abc'), { code: 'abc', state: null });
    assert.throws(() => oauth.parseCallbackInput('http://localhost:1455/auth/callback?error=access_denied'), /access_denied/);
    assert.throws(() => oauth.parseCallbackInput(''), /Chưa dán/);
    const url = oauth.buildAuthorizeUrl('chal', 'st');
    const u = new URL(url);
    assert.equal(u.origin, 'https://auth.openai.com');
    assert.equal(u.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');

    const mgr = new oauth.LoginSessionManager();
    await assert.rejects(mgr.complete('code=x&state=y'), /Chưa bắt đầu/);
    const started = mgr.start({});
    assert.match(started.authorize_url, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    assert.equal(started.mode, 'paste');
    await assert.rejects(mgr.complete('http://localhost:1455/auth/callback?code=x&state=WRONG'), /state không khớp/);
    globalThis.fetch = async () => jsonResponse({ access_token: 'a', refresh_token: 'r', id_token: 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc9' }, email: 'e@x.y' })).toString('base64url') + '.z', expires_in: 100 });
    const auth = await mgr.complete(`http://localhost:1455/auth/callback?code=x&state=${mgr.pending.state}`);
    assert.equal(auth.accountId, 'acc9'); assert.equal(auth.email, 'e@x.y');
    assert.equal(mgr.status().status, 'success');
    mgr.cancel();

    // Phiên lưu ngoài RAM: server restart giữa lúc đăng nhập → manager mới vẫn hoàn tất được
    let stored = null;
    const persist = { save: p => { stored = JSON.stringify(p); }, load: () => stored ? JSON.parse(stored) : null, clear: () => { stored = null; } };
    const m1 = new oauth.LoginSessionManager({ persist });
    const s1 = m1.start({ providerId: 7 });
    assert.ok(stored, 'đã lưu phiên'); assert.equal(JSON.parse(stored).providerId, 7);
    assert.doesNotMatch(s1.authorize_url, /verifier/);
    const m2 = new oauth.LoginSessionManager({ persist }); // giả lập restart
    assert.equal(m2.status().active, true); assert.equal(m2.status().provider_id, 7);
    const auth2 = await m2.complete(`http://localhost:1455/auth/callback?code=y&state=${JSON.parse(stored).state}`);
    assert.equal(auth2.accountId, 'acc9');
    assert.equal(stored, null, 'hoàn tất thì xóa phiên đã lưu');
    const m3 = new oauth.LoginSessionManager({ persist });
    await assert.rejects(m3.complete('code=z&state=w'), /Chưa bắt đầu/);
});

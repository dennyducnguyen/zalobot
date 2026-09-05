// Test routes /app/ai/* qua HTTP thật (express), provider giả bằng mock fetch. Không gọi mạng thật.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-ai-routes-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.AI_SECRET_KEY = Buffer.alloc(32, 3).toString('base64');

const store = require('../src/db');
const engine = require('../src/services/ai/engine');
const password = crypto.randomBytes(12).toString('hex');
store.users.create('ai-test', bcrypt.hashSync(password, 4), 'Test');

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, init); // request tới server test → fetch thật
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    const key = init?.headers?.authorization || '';
    if (key.includes('bad-key')) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (u.endsWith('/models')) return json({ data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }, { id: 'text-embedding-3-small' }] });
    if (u.endsWith('/chat/completions')) return json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    throw new Error('unexpected fetch ' + u);
};

let origin, http, cookie;
const api = async (method, p, body) => {
    const res = await fetch(origin + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie || '' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
};

before(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(cookieParser());
    app.use('/app', require('../src/routes/web'));
    http = app.listen(0, '127.0.0.1');
    await new Promise(r => http.once('listening', r));
    origin = `http://127.0.0.1:${http.address().port}`;
    const login = await fetch(origin + '/app/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ai-test', password }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
});
after(() => http.close());

test('auth: không cookie → 401', async () => {
    const res = await fetch(origin + '/app/ai/settings');
    assert.equal(res.status, 401);
});

test('GET/PUT settings: default + validate', async () => {
    const g = await api('GET', '/app/ai/settings');
    assert.equal(g.status, 200);
    assert.equal(g.json.data.settings.enabled, false);
    assert.equal(g.json.data.tools.length, 3);
    assert.ok(g.json.data.kinds.gemini);
    const bad = await api('PUT', '/app/ai/settings', { dm_mode: 'weird' });
    assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'INVALID');
    const bad2 = await api('PUT', '/app/ai/settings', { chat_provider_id: 999 });
    assert.equal(bad2.status, 404);
    const okr = await api('PUT', '/app/ai/settings', { assistant_name: 'Lan', dm_mode: 'contacts', tools: { generate_image: true }, humanize_delay_ms: [0, 0] });
    assert.equal(okr.status, 200);
    assert.equal(okr.json.data.settings.assistant_name, 'Lan');
    assert.equal(okr.json.data.settings.tools.generate_image, true);
    assert.equal(okr.json.data.settings.tools.handoff_to_human, true, 'merge tools giữ key khác');
    assert.ok(okr.json.data.status.warnings.some(w => /tạo ảnh/.test(w)));
});

let providerId;
test('providers: preview key sai → 401 che key; tạo provider OpenAI verify thật (mock); không lộ secret', async () => {
    const bad = await api('POST', '/app/ai/providers/preview', { kind: 'openai', api_key: 'sk-bad-key-0000000000' });
    assert.equal(bad.status, 401); assert.equal(bad.json.error.code, 'INVALID_KEY');
    assert.doesNotMatch(JSON.stringify(bad.json), /sk-bad-key-0000000000/);

    const pv = await api('POST', '/app/ai/providers/preview', { kind: 'openai', api_key: 'sk-good-key-0000000000' });
    assert.equal(pv.status, 200);
    assert.deepEqual(pv.json.data.models.map(m => m.slug), ['gpt-4.1', 'gpt-4.1-mini']);
    assert.deepEqual(pv.json.data.embedding_models.map(m => m.slug), ['text-embedding-3-small']);

    const missing = await api('POST', '/app/ai/providers', { kind: 'openai_compat', name: 'x', api_key: 'sk-good-key-0000000000' });
    assert.equal(missing.status, 400, 'openai_compat thiếu base_url');

    const c = await api('POST', '/app/ai/providers', { kind: 'openai', name: 'OpenAI Chính', api_key: 'sk-good-key-0000000000', chat_model: 'gpt-4.1-mini' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    providerId = c.json.data.provider.id;
    assert.equal(c.json.data.provider.name, 'openai-chinh');
    assert.equal(c.json.data.provider.has_secret, true);
    assert.equal(c.json.data.provider.status, 'ok');
    assert.doesNotMatch(JSON.stringify(c.json), /sk-good-key/);
    const dup = await api('POST', '/app/ai/providers', { kind: 'openai', name: 'openai chinh', api_key: 'sk-good-key-0000000000' });
    assert.equal(dup.status, 409);

    const list = await api('GET', '/app/ai/providers');
    assert.equal(list.json.data.providers.length, 1);
    assert.doesNotMatch(JSON.stringify(list.json), /secret_enc|sk-good/);

    const role = await api('PUT', '/app/ai/settings', { chat_provider_id: providerId, enabled: true });
    assert.equal(role.status, 200);
    assert.equal(role.json.data.status.chat_provider.id, providerId);
    const del = await api('DELETE', `/app/ai/providers/${providerId}`);
    assert.equal(del.status, 409, 'đang dùng làm provider chat');
    const imgRole = await api('PUT', '/app/ai/settings', { image_provider_id: providerId });
    assert.equal(imgRole.status, 400, 'openai không tạo ảnh');

    const patch = await api('PATCH', `/app/ai/providers/${providerId}`, { chat_model: 'gpt-4.1', api_key: 'sk-rotated-key-000000000' });
    assert.equal(patch.status, 200); assert.equal(patch.json.data.provider.chat_model, 'gpt-4.1');
    const verify = await api('POST', `/app/ai/providers/${providerId}/verify`);
    assert.equal(verify.status, 200); assert.equal(verify.json.data.provider.status, 'ok');
});

test('chatgpt provider: tạo (chờ đăng nhập) → start login trả authorize_url → complete với URL sai state báo lỗi', async () => {
    const c = await api('POST', '/app/ai/providers', { kind: 'chatgpt', name: 'ChatGPT Plus' });
    assert.equal(c.status, 200);
    assert.equal(c.json.data.provider.status, 'needs_reauth');
    const id = c.json.data.provider.id;
    const s = await api('POST', '/app/ai/chatgpt/login/start', { provider_id: id });
    assert.equal(s.status, 200);
    assert.match(s.json.data.authorize_url, /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    assert.equal(s.json.data.mode, 'paste');
    const st = await api('GET', '/app/ai/chatgpt/login/status');
    assert.equal(st.json.data.active, true);
    const bad = await api('POST', '/app/ai/chatgpt/login/complete', { provider_id: id, callback_url: 'http://localhost:1455/auth/callback?code=x&state=nope' });
    assert.equal(bad.status, 500); assert.match(bad.json.error.message, /state không khớp/);
    await api('POST', '/app/ai/chatgpt/login/cancel');
    assert.equal((await api('GET', '/app/ai/chatgpt/login/status')).json.data.active, false);
    const del = await api('DELETE', `/app/ai/providers/${id}`);
    assert.equal(del.status, 200);
});

test('test run + thread state + logs + stats', async () => {
    const t = await api('POST', '/app/ai/test', { message: 'xin chào' });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.equal(t.json.data.reply, 'OK');
    assert.equal(t.json.data.provider.id, providerId);
    const empty = await api('POST', '/app/ai/test', { message: '' });
    assert.equal(empty.status, 400);

    store.threads.ensureExists('555', 'user', 'Khách');
    const g0 = await api('GET', '/app/ai/threads/555/state');
    assert.equal(g0.json.data.effective, 'off', 'dm_mode=contacts, khách không phải contact');
    const p1 = await api('PUT', '/app/ai/threads/555/state', { ai_enabled: true });
    assert.equal(p1.json.data.effective, 'on');
    const p2 = await api('PUT', '/app/ai/threads/555/state', { pause_minutes: 10 });
    assert.equal(p2.json.data.effective, 'paused'); assert.ok(p2.json.data.paused_remaining_s > 0);
    const p3 = await api('PUT', '/app/ai/threads/555/state', { resume: true });
    assert.equal(p3.json.data.effective, 'on');
    const p4 = await api('PUT', '/app/ai/threads/555/state', { ai_enabled: 'x' });
    assert.equal(p4.status, 400);
    const r = await api('POST', '/app/ai/threads/555/reset');
    assert.ok(r.json.data.reset_at > 0);
    const threads = await api('GET', '/app/threads');
    assert.equal(threads.json.data.ai.overrides['555'].ai_enabled, 1);

    engine.aiStore.logs.insert({ threadId: '555', status: 'ok', providerKind: 'openai', inputTokens: 5, outputTokens: 2, latencyMs: 100, replyPreview: 'hi' });
    const logs = await api('GET', '/app/ai/logs?thread_id=555');
    assert.equal(logs.json.data.logs.length, 1); assert.equal(logs.json.data.thread_names['555'], 'Khách');
    const stats = await api('GET', '/app/ai/stats');
    assert.equal(stats.status, 200); assert.ok(Array.isArray(stats.json.data.today));
});

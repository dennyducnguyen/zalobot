// Test engine end-to-end với kênh Zalo giả + provider OpenAI-compat giả (mock fetch). Không gọi mạng thật.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-ai-engine-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.AI_SECRET_KEY = Buffer.alloc(32, 9).toString('base64');

const store = require('../src/db');
const engine = require('../src/services/ai/engine');
const { encryptSecret } = require('../src/services/ai/secrets');

const ZALO_ID = '100';
const sent = [];
const channel = Object.assign(new EventEmitter(), {
    zaloId: ZALO_ID,
    userInfo: { displayName: 'Shop ABC' },
    connected: true,
    status() { return { connected: this.connected, display_name: 'Shop ABC', zalo_id: ZALO_ID }; },
    async sendText(threadId, message, source, threadType, opts = {}) {
        const info = store.messages.insert({ msgId: 'out' + Date.now() + Math.random(), threadId, direction: 'out', source, senderId: ZALO_ID, senderName: 'Shop ABC', content: message, contentType: 'text', sentAt: Date.now() });
        const row = store.messages.findById(info.lastInsertRowid);
        sent.push({ threadId, message, source, threadType, opts, row });
        return { success: true, thread_type: threadType, message_row: row };
    },
    async sendImage(threadId, dataUrl, caption, source, threadType) {
        sent.push({ threadId, image: dataUrl.slice(0, 30), source, threadType });
        return { success: true, message_row: { id: 0 } };
    },
});

// Provider giả: trả lời theo nội dung tin cuối
let providerMode = 'echo';
let fetchCalls = 0;
globalThis.fetch = async (url, init) => {
    fetchCalls++;
    const u = String(url);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/models')) return json({ data: [{ id: 'fake-model' }] });
    const body = JSON.parse(init.body);
    if (body.model === 'fail-model') return new Response('boom', { status: 500 });
    const last = body.messages.at(-1);
    if (last.role === 'tool') return json({ choices: [{ finish_reason: 'stop', message: { content: 'Bây giờ là ' + JSON.parse(last.content).human } }], usage: { prompt_tokens: 2, completion_tokens: 2 } });
    const text = typeof last.content === 'string' ? last.content : last.content.map(c => c.text || '[img]').join(' ');
    if (/mấy giờ/.test(text)) return json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    if (/gặp người/.test(text)) return json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'handoff_to_human', arguments: '{"reason":"khách yêu cầu"}' } }] } }] });
    if (/dài/.test(text)) return json({ choices: [{ finish_reason: 'stop', message: { content: 'Câu một khá dài để thử. '.repeat(30) } }] });
    return json({ choices: [{ finish_reason: 'stop', message: { content: `ECHO(${body.model}): ${text} | sys=${body.messages[0].content.includes('Shop ABC')} | hist=${body.messages.length}` } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
};

async function waitFor(cond, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise(r => setTimeout(r, 20)); }
    return false;
}
let seq = 0;
function incoming(threadId, content, { type = 'user', isSelf = false, source, contentType = 'text', meta = null, senderId = '200', senderName = 'Khách A' } = {}) {
    store.threads.ensureExists(threadId, type, type === 'group' ? 'Nhóm test' : senderName);
    const info = store.messages.insert({ msgId: 'in' + (++seq), threadId, direction: isSelf ? 'out' : 'in', source: source || (isSelf ? 'app' : 'zalo'), senderId: isSelf ? ZALO_ID : senderId, senderName: isSelf ? 'Shop ABC' : senderName, content, contentType, sentAt: Date.now(), meta });
    const row = store.messages.findById(info.lastInsertRowid);
    channel.emit('ai_incoming', { row, raw: { msgId: row.msg_id, content, msgType: 'chat.text', uidFrom: senderId, cliMsgId: 1, ts: String(Date.now()), ttl: 0, propertyExt: undefined }, isSelf, threadType: type });
    return row;
}
const lastSent = () => sent[sent.length - 1];
const lastLog = (threadId) => store.ai.logs.list({ threadId, limit: 1 })[0];

before(() => {
    engine.init({ channel });
    const info = store.ai.providers.create({ kind: 'openai', name: 'fake', secretEnc: encryptSecret('sk-fake'), chatModel: 'fake-model', status: 'ok' });
    const fb = store.ai.providers.create({ kind: 'openai', name: 'fallback', secretEnc: encryptSecret('sk-fb'), chatModel: 'fb-model', status: 'ok' });
    engine.settings.update({ enabled: true, chat_provider_id: Number(info.lastInsertRowid), fallback_provider_id: Number(fb.lastInsertRowid), debounce_ms: 30, humanize_delay_ms: [0, 0], cooldown_seconds: 0, history_limit: 20 });
    engine.providers.invalidate();
});

test('DM: trả lời text với source ai, log ok, đếm lượt', async () => {
    incoming('200', 'Shop còn hàng không?');
    assert.ok(await waitFor(() => sent.length >= 1));
    const s = lastSent();
    assert.equal(s.source, 'ai'); assert.equal(s.threadType, 'user'); assert.match(s.message, /ECHO\(fake-model\): Shop còn hàng không\? \| sys=true/);
    assert.ok(await waitFor(() => lastLog('200')?.status === 'ok'));
    const log = lastLog('200');
    assert.equal(log.provider_kind, 'openai'); assert.equal(log.input_tokens, 10);
    assert.equal(engine.threadStatus('200').reply_count_day, 1);
});

test('DM: debounce gom nhiều tin liên tiếp thành 1 lượt và giữ history', async () => {
    const n = sent.length;
    incoming('200', 'tin 1'); incoming('200', 'tin 2');
    assert.ok(await waitFor(() => sent.length === n + 1));
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sent.length, n + 1, 'chỉ 1 câu trả lời cho 2 tin');
    assert.match(lastSent().message, /tin 1\ntin 2/);
    assert.match(lastSent().message, /hist=4/, 'system + user1 + assistant + user(2 tin)');
});

test('DM: /new reset history + gửi xác nhận; tin sau không thấy lịch sử cũ', async () => {
    const n = sent.length;
    incoming('200', '/new');
    assert.ok(await waitFor(() => sent.length === n + 1));
    assert.equal(lastSent().message, engine.settings.get().new_session_reply);
    assert.ok(await waitFor(() => engine.threadStatus('200').reset_at > 0));
    incoming('200', 'sau reset');
    assert.ok(await waitFor(() => sent.length === n + 2));
    assert.match(lastSent().message, /hist=2/, 'chỉ system + tin mới');
});

test('Nhóm: không tag → bỏ qua; tag → trả lời có mention + quote; group_mode all', async () => {
    const n = sent.length;
    incoming('g1', 'ai biết giá không', { type: 'group', senderId: '300', senderName: 'Bình' });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sent.length, n, 'không tag thì im');
    incoming('g1', '@Shop giá bao nhiêu', { type: 'group', senderId: '300', senderName: 'Bình', meta: { mentions: [{ uid: ZALO_ID, pos: 0, len: 5 }] } });
    assert.ok(await waitFor(() => sent.length === n + 1));
    const s = lastSent();
    assert.equal(s.threadType, 'group');
    assert.match(s.message, /^@Bình ECHO/);
    assert.deepEqual(s.opts.mentions, [{ pos: 0, len: 5, uid: '300' }]);
    assert.equal(s.opts.quote?.uidFrom, '300');
    assert.match(s.message, /\[Bình\]: @Shop giá bao nhiêu/, 'trong nhóm prefix tên người gửi');

    engine.settings.update({ group_mode: 'all', group_quote_reply: false });
    incoming('g1', 'tin thường', { type: 'group', senderId: '301', senderName: 'Cúc' });
    assert.ok(await waitFor(() => sent.length === n + 2));
    assert.doesNotMatch(lastSent().message, /^@/);
    assert.equal(lastSent().opts.quote, undefined);
    engine.settings.update({ group_mode: 'mention', group_quote_reply: true, group_whitelist: ['other'] });
    incoming('g1', 'x', { type: 'group', meta: { mentions: [{ uid: ZALO_ID }] } });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sent.length, n + 2, 'whitelist chặn');
    engine.settings.update({ group_whitelist: [] });
});

test('Người thật trả lời → tạm dừng; /ai on từ app → tiếp tục; /ai off → tắt', async () => {
    const n = sent.length;
    channel.emit('ai_human_reply', { threadId: '200', by: 'web' });
    assert.equal(engine.threadStatus('200').effective, 'paused');
    incoming('200', 'còn ai không?');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sent.length, n, 'đang tạm dừng thì không trả lời');
    assert.equal(lastLog('200').skip_reason, 'paused');

    incoming('200', '/ai on', { isSelf: true });
    assert.equal(engine.threadStatus('200').effective, 'on');
    incoming('200', 'hello lại');
    assert.ok(await waitFor(() => sent.length === n + 1));

    incoming('200', '/ai off', { isSelf: true });
    assert.equal(engine.threadStatus('200').effective, 'off');
    incoming('200', 'còn đó không');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sent.length, n + 1);
    assert.equal(lastLog('200').skip_reason, 'thread_off');
    // Tin chủ kênh gửi từ app (không phải lệnh) → tạm dừng thread khác
    incoming('201', 'để mình trả lời', { isSelf: true });
    assert.equal(engine.threadStatus('201').effective, 'paused');
    engine.setThreadState('200', { ai_enabled: null, resume: true });
    assert.equal(engine.threadStatus('200').effective, 'on');
});

test('Tool: get_current_time chạy 2 vòng; handoff_to_human đánh dấu cần người', async () => {
    const n = sent.length;
    incoming('202', 'mấy giờ rồi', { senderId: '202' });
    assert.ok(await waitFor(() => sent.length === n + 1));
    assert.match(lastSent().message, /^Bây giờ là /);
    const log = lastLog('202');
    assert.equal(JSON.parse(log.tool_calls)[0].name, 'get_current_time');

    incoming('203', 'cho tôi gặp người', { senderId: '203' });
    assert.ok(await waitFor(() => engine.threadStatus('203').needs_human === true));
    assert.equal(engine.threadStatus('203').effective, 'needs_human');
    incoming('203', 'alo?', { senderId: '203' });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(lastLog('203').skip_reason, 'needs_human');
});

test('Tách tin dài theo reply_max_chars', async () => {
    engine.settings.update({ reply_max_chars: 200 });
    const n = sent.length;
    incoming('204', 'trả lời dài đi', { senderId: '204' });
    assert.ok(await waitFor(() => lastLog('204')?.status === 'ok', 6000));
    const parts = sent.slice(n).filter(s => s.threadId === '204');
    assert.ok(parts.length >= 3);
    assert.ok(parts.every(p => p.message.length <= 200));
    engine.settings.update({ reply_max_chars: 1200 });
});

test('Fallback provider khi provider chính lỗi 5xx', async () => {
    const primary = store.ai.providers.list().find(p => p.name === 'fake');
    store.ai.providers.update(primary.id, { chatModel: 'fail-model' });
    engine.providers.invalidate();
    const n = sent.length;
    incoming('205', 'xin chào', { senderId: '205' });
    assert.ok(await waitFor(() => sent.length === n + 1, 10000));
    assert.match(lastSent().message, /ECHO\(fb-model\)/);
    assert.equal(lastLog('205').status, 'fallback');
    store.ai.providers.update(primary.id, { chatModel: 'fake-model' });
    engine.providers.invalidate();
});

test('Kênh mất kết nối → bỏ qua; công tắc tổng tắt → bỏ qua', async () => {
    const n = sent.length;
    channel.connected = false;
    incoming('206', 'hi', { senderId: '206' });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sent.length, n);
    channel.connected = true;
    engine.settings.update({ enabled: false });
    incoming('206', 'hi', { senderId: '206' });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sent.length, n);
    engine.settings.update({ enabled: true });
});

test('testRun chạy pipeline không gửi Zalo', async () => {
    const n = sent.length;
    const r = await engine.testRun({ message: 'thử nhanh', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
    assert.match(r.reply, /ECHO\(fake-model\): thử nhanh/);
    assert.equal(sent.length, n);
    assert.equal(r.provider.name, 'fake');
});

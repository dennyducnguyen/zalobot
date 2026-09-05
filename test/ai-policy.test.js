const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide, isAddressedToBot, isWithinActiveHours } = require('../src/services/ai/policy');
const { parseCustomerCommand, parseOwnerCommand } = require('../src/services/ai/commands');
const { DEFAULTS } = require('../src/services/ai/settings');

const ZALO_ID = '111';
const base = { ...DEFAULTS, enabled: true };
const row = (over = {}) => ({ id: 1, direction: 'in', source: 'zalo', sender_id: '222', sender_name: 'Khách', content: 'xin chào', content_type: 'text', meta: null, ...over });
const dm = { thread_id: '222', type: 'user', is_contact: 0 };
const group = { thread_id: 'g1', type: 'group', is_contact: 1 };

test('policy: master off / not incoming / self / ai source', () => {
    assert.equal(decide({ row: row(), thread: dm, state: null, settings: { ...base, enabled: false }, zaloId: ZALO_ID }).reason, 'master_off');
    assert.equal(decide({ row: row({ direction: 'out' }), thread: dm, state: null, settings: base, zaloId: ZALO_ID }).reason, 'not_incoming');
    assert.equal(decide({ row: row({ sender_id: ZALO_ID }), thread: dm, state: null, settings: base, zaloId: ZALO_ID }).reason, 'self');
    assert.equal(decide({ row: row({ source: 'ai' }), thread: dm, state: null, settings: base, zaloId: ZALO_ID }).reason, 'own_ai_message');
    assert.equal(decide({ row: row(), thread: dm, state: null, settings: base, zaloId: ZALO_ID, connected: false }).reason, 'not_connected');
});

test('policy: DM modes', () => {
    assert.equal(decide({ row: row(), thread: dm, state: null, settings: base, zaloId: ZALO_ID }).action, 'reply');
    assert.equal(decide({ row: row(), thread: dm, state: null, settings: { ...base, dm_mode: 'off' }, zaloId: ZALO_ID }).reason, 'dm_off');
    assert.equal(decide({ row: row(), thread: dm, state: null, settings: { ...base, dm_mode: 'contacts' }, zaloId: ZALO_ID }).reason, 'not_contact');
    assert.equal(decide({ row: row(), thread: { ...dm, is_contact: 1 }, state: null, settings: { ...base, dm_mode: 'non_contacts' }, zaloId: ZALO_ID }).reason, 'is_contact');
    assert.equal(decide({ row: row(), thread: { ...dm, is_contact: 1 }, state: null, settings: { ...base, dm_mode: 'contacts' }, zaloId: ZALO_ID }).action, 'reply');
});

test('policy: group mention / all / whitelist', () => {
    const noMention = row({ meta: JSON.stringify({ mentions: [{ uid: '999' }] }) });
    const mention = row({ meta: JSON.stringify({ mentions: [{ uid: ZALO_ID }] }) });
    const quote = row({ meta: { quote: { ownerId: ZALO_ID } } });
    assert.equal(decide({ row: noMention, thread: group, state: null, settings: base, zaloId: ZALO_ID }).reason, 'not_mentioned');
    assert.equal(decide({ row: mention, thread: group, state: null, settings: base, zaloId: ZALO_ID }).action, 'reply');
    assert.equal(decide({ row: quote, thread: group, state: null, settings: base, zaloId: ZALO_ID }).action, 'reply');
    assert.equal(decide({ row: noMention, thread: group, state: null, settings: { ...base, group_mode: 'all' }, zaloId: ZALO_ID }).action, 'reply');
    assert.equal(decide({ row: noMention, thread: group, state: null, settings: { ...base, group_mode: 'off' }, zaloId: ZALO_ID }).reason, 'group_off');
    assert.equal(decide({ row: mention, thread: group, state: null, settings: { ...base, group_whitelist: ['other'] }, zaloId: ZALO_ID }).reason, 'group_not_whitelisted');
    assert.equal(decide({ row: mention, thread: group, state: null, settings: { ...base, group_whitelist: ['g1'] }, zaloId: ZALO_ID }).action, 'reply');
    assert.equal(isAddressedToBot({}, ZALO_ID), false);
});

test('policy: thread override, paused, needs_human, cooldown, daily limit', () => {
    const now = Date.now();
    assert.equal(decide({ row: row(), thread: dm, state: { ai_enabled: 0 }, settings: base, zaloId: ZALO_ID }).reason, 'thread_off');
    assert.equal(decide({ row: row(), thread: dm, state: { ai_enabled: 1 }, settings: { ...base, dm_mode: 'off' }, zaloId: ZALO_ID }).action, 'reply', 'override bật thắng dm_mode off');
    assert.equal(decide({ row: row(), thread: dm, state: { paused_until: now + 60000 }, settings: base, zaloId: ZALO_ID, now }).reason, 'paused');
    assert.equal(decide({ row: row(), thread: dm, state: { paused_until: now - 1 }, settings: base, zaloId: ZALO_ID, now }).action, 'reply');
    assert.equal(decide({ row: row(), thread: dm, state: { needs_human: 1 }, settings: base, zaloId: ZALO_ID }).reason, 'needs_human');
    assert.equal(decide({ row: row(), thread: dm, state: { last_reply_at: now - 1000 }, settings: base, zaloId: ZALO_ID, now }).reason, 'cooldown');
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    assert.equal(decide({ row: row(), thread: dm, state: { reply_count_date: today, reply_count_day: 200 }, settings: base, zaloId: ZALO_ID, now }).reason, 'daily_limit');
    assert.equal(decide({ row: row(), thread: dm, state: { reply_count_date: '2000-01-01', reply_count_day: 200 }, settings: base, zaloId: ZALO_ID, now }).action, 'reply');
});

test('policy: /new command works even when thread off or paused', () => {
    const r = row({ content: ' /NEW ' });
    assert.equal(decide({ row: r, thread: dm, state: { ai_enabled: 0 }, settings: base, zaloId: ZALO_ID }).action, 'command_new');
    assert.equal(decide({ row: r, thread: dm, state: null, settings: { ...base, enabled: false }, zaloId: ZALO_ID }).reason, 'master_off');
});

test('policy: content types', () => {
    const photo = row({ content_type: 'photo', content: JSON.stringify({ href: 'https://f1.zdn.vn/a.jpg', title: 'ảnh này' }) });
    assert.equal(decide({ row: photo, thread: dm, state: null, settings: base, zaloId: ZALO_ID }).reason, 'image');
    assert.equal(decide({ row: photo, thread: dm, state: null, settings: { ...base, vision_enabled: false }, zaloId: ZALO_ID }).reason, 'image_vision_off');
    assert.equal(decide({ row: photo, thread: dm, state: null, settings: { ...base, vision_enabled: false, non_text_reply: 'x' }, zaloId: ZALO_ID }).action, 'non_text_reply');
    const sticker = row({ content_type: 'sticker', content: '{}' });
    assert.equal(decide({ row: sticker, thread: dm, state: null, settings: base, zaloId: ZALO_ID }).reason, 'unsupported_sticker');
    assert.equal(decide({ row: sticker, thread: dm, state: null, settings: { ...base, non_text_reply: 'Mình chỉ đọc được text' }, zaloId: ZALO_ID }).action, 'non_text_reply');
    assert.equal(decide({ row: row({ content: '   ' }), thread: dm, state: null, settings: base, zaloId: ZALO_ID }).reason, 'empty');
});

test('active hours: overnight range + days', () => {
    // 20:00 giờ VN thứ Ba 2026-09-08 → 13:00Z
    const tue2000 = Date.UTC(2026, 8, 8, 13, 0);
    const tue1000 = Date.UTC(2026, 8, 8, 3, 0);
    const cfg = { tz: 'Asia/Ho_Chi_Minh', ranges: [['18:00', '08:00']], days: [0, 1, 2, 3, 4, 5, 6] };
    assert.equal(isWithinActiveHours(cfg, tue2000), true);
    assert.equal(isWithinActiveHours(cfg, tue1000), false);
    assert.equal(isWithinActiveHours({ ...cfg, days: [0, 6] }, tue2000), false);
    assert.equal(isWithinActiveHours(null, tue1000), true);
    assert.equal(isWithinActiveHours({ tz: 'Asia/Ho_Chi_Minh', ranges: [], days: [] }, tue1000), true);
});

test('commands', () => {
    assert.equal(parseCustomerCommand('/new'), 'new');
    assert.equal(parseCustomerCommand('/New '), 'new');
    assert.equal(parseCustomerCommand('/newx'), null);
    assert.equal(parseCustomerCommand('new'), null);
    assert.deepEqual(parseOwnerCommand('/ai off'), { cmd: 'off' });
    assert.deepEqual(parseOwnerCommand('/ai  ON'), { cmd: 'on' });
    assert.deepEqual(parseOwnerCommand('/ai'), { cmd: 'status' });
    assert.deepEqual(parseOwnerCommand('/ai tắt'), { cmd: 'off' });
    assert.equal(parseOwnerCommand('/ai something'), null);
    assert.deepEqual(parseOwnerCommand('/new'), { cmd: 'new' });
});

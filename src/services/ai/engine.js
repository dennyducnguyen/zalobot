// =============================================
// AI Engine — điều phối: nhận tin đến → policy → debounce theo thread → dựng ngữ cảnh → agent loop → gửi Zalo → log.
// Một instance duy nhất (init trong server.js). Emit events (EventEmitter) để server.js đẩy SSE cho UI:
//   'log' {log}, 'state' {thread_id, state}, 'handoff' {thread_id, reason}, 'error' {thread_id, message}
// =============================================
const { EventEmitter } = require('events');
const store = require('../../db');
const logger = require('../logger');
const config = require('../../config');
const { createSettings } = require('./settings');
const { createProviderManager } = require('./providers/manager');
const { createToolRegistry } = require('./tools');
const { createKnowledge } = require('./knowledge');
const { createImageLoader } = require('./images');
const { createContextBuilder } = require('./context');
const { runAgent } = require('./agent');
const policy = require('./policy');
const { parseOwnerCommand } = require('./commands');
const { LoginSessionManager } = require('./providers/chatgptOAuth');
const { maskSecrets, encryptSecret, decryptSecret } = require('./secrets');

const QUOTE_CACHE_TTL = 30 * 60 * 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(a, b) { return a + Math.floor(Math.random() * Math.max(0, b - a + 1)); }

/** Cắt text dài thành nhiều tin theo đoạn/câu, ưu tiên ranh giới tự nhiên */
function splitText(text, max) {
    const out = [];
    let rest = String(text || '').trim();
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n\n', max);
        if (cut < max * 0.4) cut = rest.lastIndexOf('\n', max);
        if (cut < max * 0.4) {
            const sentence = Math.max(rest.lastIndexOf('. ', max - 1), rest.lastIndexOf('? ', max - 1), rest.lastIndexOf('! ', max - 1));
            if (sentence >= max * 0.4) cut = sentence + 1; // giữ dấu câu ở phần trước
        }
        if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.4) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
}

class AiEngine extends EventEmitter {
    constructor() {
        super();
        this.channel = null;
        this.aiStore = store.ai;
        this.settings = createSettings(this.aiStore);
        this.providers = createProviderManager({ aiStore: this.aiStore, settings: this.settings, logger });
        this.tools = createToolRegistry({ settings: this.settings, providers: this.providers, logger });
        this.knowledge = createKnowledge({ aiStore: this.aiStore, providers: this.providers, settings: this.settings });
        this.images = createImageLoader({ settings: this.settings, logger });
        this.context = createContextBuilder({ aiStore: this.aiStore, settings: this.settings, images: this.images, knowledge: this.knowledge, logger });
        // Phiên đăng nhập ChatGPT lưu mã hóa trong ai_settings (key ngoài DEFAULTS nên không lộ ra API settings) → sống qua restart
        const LOGIN_KEY = 'chatgpt_login_pending';
        this.login = new LoginSessionManager({
            persist: {
                save: (p) => this.aiStore.settings.set(LOGIN_KEY, encryptSecret(JSON.stringify(p))),
                load: () => { const raw = this.aiStore.settings.getRaw(LOGIN_KEY); const enc = raw ? JSON.parse(raw) : ''; return enc ? JSON.parse(decryptSecret(enc)) : null; },
                clear: () => this.aiStore.settings.set(LOGIN_KEY, ''),
            },
        });

        this._buffers = new Map();   // threadId → { rows:[], timer }
        this._locks = new Map();     // threadId → Promise chain
        this._running = 0;
        this._waiters = [];
        this._quoteCache = new Map(); // msgId → { data, at } (raw message.data để quote lại)
        this._nonTextReplyAt = new Map(); // threadId → ts
        this.stats = { turns: 0, errors: 0, startedAt: Date.now() };
    }

    /** @param {{ channel: import('../zaloService') }} p */
    init({ channel }) {
        this.channel = channel;
        channel.on('ai_incoming', (p) => this.onIncoming(p).catch(e => logger.error('❌ [ai] onIncoming:', e.message)));
        channel.on('ai_human_reply', ({ threadId, by }) => this.onHumanReply(threadId, by));
        try { this.aiStore.logs.purgeOlderThan(30 * 24 * 3600 * 1000); this.images.cleanup(); } catch { /* bỏ qua */ }
        setInterval(() => { try { this.images.cleanup(); this._sweepQuoteCache(); } catch { /* bỏ qua */ } }, 3600 * 1000).unref();
        logger.info(`🤖 [ai] Trợ lý AI khởi tạo — ${this.settings.get().enabled ? 'ĐANG BẬT' : 'đang tắt'}`);
    }

    // ==========================================
    // Trạng thái / tiện ích cho routes
    // ==========================================
    status() {
        const s = this.settings.get();
        const chat = this.providers.getChat();
        const img = this.providers.getImage();
        const warnings = [];
        if (s.enabled && !s.chat_provider_id) warnings.push('Chưa chọn provider chat — AI sẽ không trả lời.');
        if (s.enabled && s.chat_provider_id && !chat) warnings.push('Provider chat đang tắt hoặc đã bị xóa.');
        if (chat && !chat.chatModel) warnings.push(`Provider "${chat.name}" chưa chọn model chat.`);
        if (chat?.needsReauth) warnings.push(`Provider "${chat.name}" cần đăng nhập lại ChatGPT.`);
        if (s.tools?.generate_image && !img) warnings.push('Tool tạo ảnh đang bật nhưng chưa chọn provider tạo ảnh.');
        if (s.enabled && !this.channel?.status().connected) warnings.push('Kênh Zalo chưa kết nối.');
        return {
            enabled: s.enabled,
            connected: !!this.channel?.status().connected,
            chat_provider: chat ? { id: chat.id, name: chat.name, kind: chat.kind, model: chat.chatModel } : null,
            fallback_provider: this.providers.getFallback() ? { id: this.providers.getFallback().id, name: this.providers.getFallback().name } : null,
            image_provider: img ? { id: img.id, name: img.name, model: img.imageModel } : null,
            running: this._running, queued: this._waiters.length, buffered_threads: this._buffers.size,
            stats: this.stats, warnings,
            oauth_local_callback: config.AI_OAUTH_LOCAL_CALLBACK,
        };
    }

    threadStatus(threadId) {
        const s = this.settings.get();
        const st = this.aiStore.threadState.get(threadId);
        const thread = store.threads.get(threadId);
        const now = Date.now();
        let effective = 'off';
        let reason = '';
        if (!s.enabled) { effective = 'off'; reason = 'master_off'; }
        else if (st?.ai_enabled === 0) { effective = 'off'; reason = 'thread_off'; }
        else if (st?.needs_human) { effective = 'needs_human'; reason = 'needs_human'; }
        else if ((st?.paused_until || 0) > now) { effective = 'paused'; reason = 'paused'; }
        else if (st?.ai_enabled === 1) { effective = 'on'; reason = 'thread_on'; }
        else if (thread?.type === 'group') {
            effective = s.group_mode === 'off' ? 'off' : (s.group_whitelist?.length && !s.group_whitelist.includes(threadId) ? 'off' : 'on');
            reason = effective === 'off' ? 'group_rule' : (s.group_mode === 'mention' ? 'group_mention' : 'group_all');
        } else {
            const isContact = !!thread?.is_contact;
            const m = s.dm_mode;
            effective = m === 'off' || (m === 'contacts' && !isContact) || (m === 'non_contacts' && isContact) ? 'off' : 'on';
            reason = effective === 'off' ? 'dm_rule' : 'dm_all';
        }
        return {
            thread_id: threadId, effective, reason,
            ai_enabled: st?.ai_enabled ?? null, paused_until: st?.paused_until || 0, needs_human: !!st?.needs_human,
            reset_at: st?.reset_at || 0, last_reply_at: st?.last_reply_at || 0, reply_count_day: st?.reply_count_day || 0,
            paused_remaining_s: Math.max(0, Math.ceil(((st?.paused_until || 0) - now) / 1000)),
        };
    }

    /** Map thread_id → trạng thái rút gọn (cho danh sách hội thoại) */
    threadStatesSummary() {
        const now = Date.now();
        const out = {};
        for (const r of this.aiStore.threadState.listActive()) {
            out[r.thread_id] = { ai_enabled: r.ai_enabled, paused: r.paused_until > now, needs_human: !!r.needs_human };
        }
        return { enabled: this.settings.get().enabled, dm_mode: this.settings.get().dm_mode, group_mode: this.settings.get().group_mode, group_whitelist: this.settings.get().group_whitelist, overrides: out };
    }

    setThreadState(threadId, patch) {
        const fields = {};
        if ('ai_enabled' in patch) fields.ai_enabled = patch.ai_enabled === null ? null : (patch.ai_enabled ? 1 : 0);
        if (patch.resume) { fields.paused_until = 0; fields.needs_human = 0; }
        if (patch.pause_minutes !== undefined) fields.paused_until = Date.now() + Number(patch.pause_minutes) * 60000;
        if (patch.needs_human !== undefined) fields.needs_human = patch.needs_human ? 1 : 0;
        this.aiStore.threadState.update(threadId, fields);
        this._emitState(threadId);
        return this.threadStatus(threadId);
    }

    resetThread(threadId, { lastMsgId } = {}) {
        const last = lastMsgId ?? (store.db.prepare('SELECT MAX(id) AS m FROM messages WHERE thread_id = ?').get(threadId)?.m || 0);
        this.aiStore.threadState.update(threadId, { reset_at: Date.now(), reset_msg_id: last, needs_human: 0 });
        this._emitState(threadId);
    }

    markNeedsHuman(threadId, reason = '') {
        this.aiStore.threadState.update(threadId, { needs_human: 1 });
        try { store.db.prepare('UPDATE threads SET unread_count = unread_count + 1 WHERE thread_id = ?').run(threadId); } catch { /* bỏ qua */ }
        logger.info(`🙋 [ai] Thread ${threadId} cần người hỗ trợ: ${reason}`);
        this.emit('handoff', { thread_id: threadId, reason });
        this._emitState(threadId);
    }

    /** Người thật (web UI hoặc app Zalo) vừa trả lời → tạm dừng AI trong thread */
    onHumanReply(threadId, by = 'web') {
        const s = this.settings.get();
        if (!s.enabled || !(s.human_pause_minutes > 0)) return;
        const st = this.aiStore.threadState.get(threadId);
        if (st?.ai_enabled === 0) return; // đã tắt hẳn rồi
        this.aiStore.threadState.update(threadId, { paused_until: Date.now() + s.human_pause_minutes * 60000 });
        // Người thật đã vào → hủy lượt AI đang chờ debounce cho thread này
        const buf = this._buffers.get(threadId);
        if (buf) { clearTimeout(buf.timer); this._buffers.delete(threadId); }
        logger.info(`⏸️ [ai] ${by} trả lời thread ${threadId} → AI tạm dừng ${s.human_pause_minutes} phút`);
        this._emitState(threadId);
    }

    _emitState(threadId) { this.emit('state', { thread_id: threadId, state: this.threadStatus(threadId) }); }

    // ==========================================
    // Nhận tin từ listener
    // payload: { row (messages), raw (message.data zca-js), isSelf, threadType }
    // ==========================================
    async onIncoming({ row, raw, isSelf }) {
        if (!row) return;
        const threadId = row.thread_id;
        if (raw?.msgId) this._quoteCache.set(String(raw.msgId), { data: raw, at: Date.now() });

        // Tin do chính chủ kênh gửi từ app Zalo (isSelf, source app)
        if (isSelf) {
            if (row.source !== 'app') return;
            const cmd = row.content_type === 'text' ? parseOwnerCommand(row.content) : null;
            if (cmd) return this._handleOwnerCommand(threadId, cmd, row);
            return this.onHumanReply(threadId, 'app');
        }

        const s = this.settings.get();
        const thread = store.threads.get(threadId) || { thread_id: threadId, type: 'user', is_contact: 0 };
        const state = this.aiStore.threadState.get(threadId);
        const decision = policy.decide({ row, thread, state, settings: s, zaloId: this.channel?.zaloId, connected: !!this.channel?.status().connected });

        if (decision.action === 'skip') {
            if (['thread_off', 'paused', 'needs_human', 'daily_limit', 'cooldown', 'outside_hours'].includes(decision.reason)) {
                this._log({ threadId, triggerMsgId: row.id, status: 'skipped', skipReason: decision.reason });
            }
            return;
        }
        if (decision.action === 'command_new') return this._handleCustomerNew(threadId, thread, row);
        if (decision.action === 'non_text_reply') return this._handleNonText(threadId, thread, row, s);

        // reply → gom debounce
        let buf = this._buffers.get(threadId);
        if (!buf) { buf = { rows: [], timer: null, thread }; this._buffers.set(threadId, buf); }
        buf.rows.push(row);
        clearTimeout(buf.timer);
        buf.timer = setTimeout(() => {
            this._buffers.delete(threadId);
            this._enqueue(threadId, () => this.runTurn(threadId, buf.rows).catch(e => logger.error(`❌ [ai] runTurn ${threadId}:`, e.message)));
        }, Math.max(0, s.debounce_ms));
    }

    async _handleOwnerCommand(threadId, cmd, row) {
        if (cmd.cmd === 'new') { this.resetThread(threadId, { lastMsgId: row.id }); logger.info(`🔄 [ai] Chủ kênh /new thread ${threadId}`); return; }
        if (cmd.cmd === 'on') { this.setThreadState(threadId, { ai_enabled: true, resume: true }); logger.info(`▶️ [ai] Chủ kênh bật AI thread ${threadId}`); return; }
        if (cmd.cmd === 'off') { this.setThreadState(threadId, { ai_enabled: false }); logger.info(`⏹️ [ai] Chủ kênh tắt AI thread ${threadId}`); return; }
        // status → không gửi ra Zalo (khách sẽ thấy), chỉ log + SSE
        this.emit('state', { thread_id: threadId, state: this.threadStatus(threadId), requested: true });
    }

    async _handleCustomerNew(threadId, thread, row) {
        const s = this.settings.get();
        const st = this.aiStore.threadState.get(threadId);
        // Nếu AI đang tắt cho thread này thì reset im lặng (không trả lời)
        const silent = st?.ai_enabled === 0 || (thread.type === 'group' && s.group_mode === 'off');
        let lastId = row.id;
        if (!silent && s.new_session_reply?.trim()) {
            try {
                const r = await this._send(threadId, thread, s.new_session_reply.trim(), { quoteRow: thread.type === 'group' ? row : null, mentionRow: thread.type === 'group' ? row : null });
                if (r?.message_row?.id) lastId = r.message_row.id;
            } catch (e) { logger.warn(`⚠️ [ai] Gửi xác nhận /new lỗi: ${e.message}`); }
        }
        this.resetThread(threadId, { lastMsgId: lastId });
        this._log({ threadId, triggerMsgId: row.id, status: 'ok', skipReason: 'command_new', replyPreview: silent ? '' : s.new_session_reply });
        logger.info(`🔄 [ai] Khách /new thread ${threadId}`);
    }

    async _handleNonText(threadId, thread, row, s) {
        const last = this._nonTextReplyAt.get(threadId) || 0;
        if (Date.now() - last < 10 * 60 * 1000) return; // 1 lần / 10 phút / thread
        this._nonTextReplyAt.set(threadId, Date.now());
        try {
            await this._send(threadId, thread, s.non_text_reply.trim(), { quoteRow: thread.type === 'group' ? row : null, mentionRow: thread.type === 'group' ? row : null });
            this._touchReplyCounters(threadId);
            this._log({ threadId, triggerMsgId: row.id, status: 'ok', skipReason: 'non_text_reply', replyPreview: s.non_text_reply });
        } catch (e) { logger.warn(`⚠️ [ai] Gửi non_text_reply lỗi: ${e.message}`); }
    }

    // ==========================================
    // Hàng đợi: lock theo thread + semaphore toàn hệ
    // ==========================================
    _enqueue(threadId, fn) {
        const prev = this._locks.get(threadId) || Promise.resolve();
        const next = prev.then(() => this._withSemaphore(fn)).catch(() => {});
        this._locks.set(threadId, next);
        next.finally(() => { if (this._locks.get(threadId) === next) this._locks.delete(threadId); });
        return next;
    }

    async _withSemaphore(fn) {
        const max = this.settings.get().global_concurrency || 3;
        if (this._running >= max) await new Promise(r => this._waiters.push(r));
        this._running++;
        try { return await fn(); } finally {
            this._running--;
            const w = this._waiters.shift();
            if (w) w();
        }
    }

    // ==========================================
    // Một lượt AI
    // ==========================================
    async runTurn(threadId, triggerRows) {
        const s = this.settings.get();
        const thread = store.threads.get(threadId) || { thread_id: threadId, type: 'user' };
        const state = this.aiStore.threadState.get(threadId);
        const now = Date.now();
        const lastRow = triggerRows[triggerRows.length - 1];

        // Kiểm tra lại các điều kiện có thể đổi trong lúc chờ debounce/hàng đợi
        if (!s.enabled || state?.ai_enabled === 0 || state?.needs_human || (state?.paused_until || 0) > now) {
            return this._log({ threadId, triggerMsgId: lastRow?.id, status: 'skipped', skipReason: !s.enabled ? 'master_off' : state?.ai_enabled === 0 ? 'thread_off' : state?.needs_human ? 'needs_human' : 'paused' });
        }
        if (!this.channel?.status().connected) return this._log({ threadId, triggerMsgId: lastRow?.id, status: 'skipped', skipReason: 'not_connected' });
        // Tin mới hơn đã tới trong lúc chờ? (đang gom ở buffer) → để lượt sau xử lý chung, tránh trả lời 2 lần
        if (this._buffers.has(threadId)) return;

        const provider = this.providers.getChat();
        if (!provider) return this._log({ threadId, triggerMsgId: lastRow?.id, status: 'error', error: 'Chưa cấu hình provider chat' });

        const t0 = Date.now();
        const ownerName = this.channel.userInfo?.displayName || this.channel.status().display_name || '';
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('turn timeout')), s.turn_timeout_ms + (s.tools?.generate_image ? s.image_timeout_ms : 0));
        let usedProvider = provider;
        let result;
        try {
            const ctx = await this.context.build({ thread, state, ownerName, toolsActive: this.tools.active(s).map(t => t.name), triggerRows });
            const toolCtx = { threadId, thread, settings: s, attachments: [], recentImages: ctx.recentImages, engine: this, signal: ac.signal };
            const request = { system: ctx.system, messages: ctx.messages, maxTokens: s.max_tokens, temperature: s.temperature, reasoningEffort: s.reasoning_effort, timeoutMs: s.turn_timeout_ms };

            try {
                result = await runAgent({ provider, request: { ...request, model: provider.chatModel }, tools: this.tools, ctx: toolCtx, maxRounds: s.max_tool_rounds, signal: ac.signal });
            } catch (e) {
                const fb = this.providers.getFallback();
                if (fb && fb.id !== provider.id && !ac.signal.aborted && (e.retryable || e.authFail || e.status >= 400)) {
                    logger.warn(`⚠️ [ai] Provider ${provider.name} lỗi (${maskSecrets(e.message)}) → dùng dự phòng ${fb.name}`);
                    usedProvider = fb;
                    result = await runAgent({ provider: fb, request: { ...request, model: fb.chatModel }, tools: this.tools, ctx: toolCtx, maxRounds: s.max_tool_rounds, signal: ac.signal });
                    result.fallback = true;
                } else throw e;
            }

            const text = (result.text || '').trim();
            const attachments = toolCtx.attachments;
            if (!text && !attachments.length) {
                this._log({ threadId, triggerMsgId: lastRow?.id, providerId: usedProvider.id, providerKind: usedProvider.kind, model: usedProvider.chatModel, status: 'error', error: 'AI trả về rỗng', latencyMs: Date.now() - t0, toolCalls: result.toolCalls, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
                return;
            }

            // Độ trễ giống người
            const [dmin, dmax] = s.humanize_delay_ms || [0, 0];
            if (dmax > 0) await sleep(randInt(dmin, dmax));

            const quoteOpts = thread.type === 'group' && s.group_quote_reply ? { quoteRow: lastRow, mentionRow: lastRow } : {};
            const parts = text ? splitText(text, s.reply_max_chars || 1200) : [];
            for (let i = 0; i < parts.length; i++) {
                await this._send(threadId, thread, parts[i], i === 0 ? quoteOpts : {});
                if (i < parts.length - 1) await sleep(600);
            }
            for (const att of attachments) {
                if (att.kind !== 'generated_image') continue;
                const saved = this.images.saveGenerated(att.data, att.mime);
                await this.channel.sendImage(threadId, saved.dataUrl, '', 'ai', thread.type);
            }

            this._touchReplyCounters(threadId);
            this.stats.turns++;
            this._log({
                threadId, triggerMsgId: lastRow?.id, providerId: usedProvider.id, providerKind: usedProvider.kind, model: usedProvider.chatModel,
                status: result.fallback ? 'fallback' : 'ok', inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
                latencyMs: Date.now() - t0, toolCalls: result.toolCalls, replyPreview: text.slice(0, 300),
            });
            logger.info(`🤖 [ai] Trả lời thread ${threadId} (${usedProvider.kind}/${usedProvider.chatModel}, ${Date.now() - t0} ms, tools=${result.toolCalls.length})`);
        } catch (e) {
            this.stats.errors++;
            const msg = maskSecrets(e.message || String(e));
            logger.error(`❌ [ai] Lượt AI thread ${threadId} lỗi: ${msg}`);
            this._log({ threadId, triggerMsgId: lastRow?.id, providerId: usedProvider?.id, providerKind: usedProvider?.kind, model: usedProvider?.chatModel, status: 'error', error: msg, latencyMs: Date.now() - t0 });
            this.emit('error', { thread_id: threadId, message: msg });
            if (s.error_reply?.trim() && this.channel?.status().connected) {
                try { await this._send(threadId, thread, s.error_reply.trim(), {}); } catch { /* bỏ qua */ }
            }
        } finally {
            clearTimeout(timer);
        }
    }

    /** Gửi text qua kênh với source 'ai'; trong nhóm quote + mention người hỏi nếu được yêu cầu */
    async _send(threadId, thread, text, { quoteRow = null, mentionRow = null } = {}) {
        const opts = {};
        let msg = text;
        if (mentionRow && thread.type === 'group' && mentionRow.sender_id && mentionRow.sender_id !== this.channel.zaloId) {
            const name = (mentionRow.sender_name || 'bạn').trim();
            msg = `@${name} ${text}`;
            opts.mentions = [{ pos: 0, len: name.length + 1, uid: String(mentionRow.sender_id) }];
        }
        if (quoteRow) {
            const q = this._buildQuote(quoteRow);
            if (q) opts.quote = q;
        }
        return this.channel.sendText(threadId, msg, 'ai', thread.type, opts);
    }

    _buildQuote(row) {
        const cached = row.msg_id ? this._quoteCache.get(String(row.msg_id)) : null;
        const raw = cached?.data;
        if (!raw) return null;
        let content = raw.content;
        return {
            content, msgType: raw.msgType, propertyExt: raw.propertyExt, uidFrom: raw.uidFrom,
            msgId: raw.msgId, cliMsgId: raw.cliMsgId, ts: raw.ts, ttl: raw.ttl,
        };
    }

    _touchReplyCounters(threadId) {
        const st = this.aiStore.threadState.get(threadId);
        const today = policy.todayKey(Date.now());
        const count = st?.reply_count_date === today ? (st.reply_count_day || 0) + 1 : 1;
        this.aiStore.threadState.update(threadId, { last_reply_at: Date.now(), reply_count_day: count, reply_count_date: today });
    }

    _log(row) {
        try {
            const info = this.aiStore.logs.insert(row);
            const saved = store.db.prepare('SELECT * FROM ai_logs WHERE id = ?').get(info.lastInsertRowid);
            this.emit('log', { log: saved });
        } catch (e) { logger.warn(`⚠️ [ai] Ghi log lỗi: ${e.message}`); }
    }

    _sweepQuoteCache() {
        const now = Date.now();
        for (const [k, v] of this._quoteCache) if (now - v.at > QUOTE_CACHE_TTL) this._quoteCache.delete(k);
    }

    // ==========================================
    // Thử nhanh từ UI — chạy đúng pipeline, KHÔNG gửi Zalo
    // ==========================================
    async testRun({ message, imageDataUrl = null, threadId = null, history = [] }) {
        const s = this.settings.get();
        const provider = this.providers.getChat();
        if (!provider) throw new Error('Chưa cấu hình provider chat');
        const thread = threadId ? (store.threads.get(threadId) || { thread_id: threadId, type: 'user', name: 'Khách thử' }) : { thread_id: 'test', type: 'user', name: 'Khách thử' };
        const ownerName = this.channel?.userInfo?.displayName || this.channel?.status().display_name || 'Chủ kênh';
        const toolsActive = this.tools.active(s).map(t => t.name);
        const system = this.context.buildSystemPrompt({ settings: s, thread, ownerName, toolsActive, knowledgeText: '' });
        const messages = history.filter(h => h && typeof h.content === 'string' && ['user', 'assistant'].includes(h.role)).slice(-20)
            .map(h => ({ role: h.role, content: h.content }));
        const images = [];
        if (imageDataUrl) images.push(await this.images.normalizeDataUrl(imageDataUrl));
        messages.push({ role: 'user', content: message || (images.length ? '(gửi ảnh)' : ''), ...(images.length ? { images } : {}) });
        const toolCtx = { threadId: thread.thread_id, thread, settings: s, attachments: [], recentImages: images, engine: { markNeedsHuman: () => {} }, signal: undefined };
        const t0 = Date.now();
        const result = await runAgent({
            provider, tools: this.tools, ctx: toolCtx, maxRounds: s.max_tool_rounds,
            request: { system, messages, model: provider.chatModel, maxTokens: s.max_tokens, temperature: s.temperature, reasoningEffort: s.reasoning_effort, timeoutMs: s.turn_timeout_ms },
        });
        const generated = toolCtx.attachments.filter(a => a.kind === 'generated_image').map(a => `data:${a.mime};base64,${a.data.toString('base64')}`);
        return { reply: result.text, tool_calls: result.toolCalls, usage: result.usage, latency_ms: Date.now() - t0, provider: { id: provider.id, name: provider.name, kind: provider.kind, model: provider.chatModel }, images: generated, system_prompt_preview: system.slice(0, 4000) };
    }
}

module.exports = new AiEngine();
module.exports.splitText = splitText;

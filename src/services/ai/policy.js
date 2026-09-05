// =============================================
// Policy — quyết định có để AI trả lời tin này không. Hàm THUẦN (không I/O) để test được.
// =============================================
const { parseCustomerCommand } = require('./commands');

function parseMeta(row) {
    if (!row?.meta) return {};
    if (typeof row.meta === 'object') return row.meta;
    try { return JSON.parse(row.meta) || {}; } catch { return {}; }
}

/** Tin nhóm có tag bot hoặc reply (quote) vào tin của bot? */
function isAddressedToBot(meta, zaloId) {
    if (!zaloId) return false;
    const id = String(zaloId);
    if (Array.isArray(meta.mentions) && meta.mentions.some(m => String(m?.uid) === id)) return true;
    if (meta.quote && String(meta.quote.ownerId) === id) return true;
    return false;
}

function todayKey(now, tz = 'Asia/Ho_Chi_Minh') {
    return new Date(now).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

/** active_hours: { tz, ranges:[["18:00","08:00"]], days:[0..6] } — range qua đêm được hỗ trợ */
function isWithinActiveHours(activeHours, now = Date.now()) {
    if (!activeHours) return true;
    const tz = activeHours.tz || 'Asia/Ho_Chi_Minh';
    const d = new Date(now);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const get = (t) => parts.find(p => p.type === t)?.value;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = dayMap[get('weekday')];
    const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
    if (Array.isArray(activeHours.days) && activeHours.days.length && !activeHours.days.includes(day)) return false;
    const ranges = activeHours.ranges || [];
    if (!ranges.length) return true;
    const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    return ranges.some(([a, b]) => {
        const start = toMin(a), end = toMin(b);
        if (start === end) return true;
        return start < end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
    });
}

function contentText(row) {
    if (row.content_type === 'text') return row.content || '';
    if (row.content_type === 'photo' || row.content_type === 'webchat') {
        try { const o = JSON.parse(row.content || '{}'); return o.title || o.caption || ''; } catch { return ''; }
    }
    return '';
}

function isImageRow(row) {
    if (row.content_type !== 'photo') return false;
    try { const o = JSON.parse(row.content || '{}'); return !!(o.href || o.thumb || o.oriUrl); } catch { return false; }
}

/**
 * @param {object} p
 * @param {object} p.row        dòng messages (direction in)
 * @param {object} p.thread     dòng threads
 * @param {object|null} p.state ai_thread_state
 * @param {object} p.settings   cấu hình đã merge default
 * @param {string} p.zaloId     id kênh
 * @param {boolean} p.connected kênh đang kết nối
 * @param {number} [p.now]
 * @returns {{ action:'skip'|'reply'|'command_new'|'non_text_reply', reason:string }}
 */
function decide({ row, thread, state, settings, zaloId, connected = true, now = Date.now() }) {
    if (!row || row.direction !== 'in') return { action: 'skip', reason: 'not_incoming' };
    if (row.source === 'ai') return { action: 'skip', reason: 'own_ai_message' };
    if (zaloId && String(row.sender_id) === String(zaloId)) return { action: 'skip', reason: 'self' };
    if (!settings.enabled) return { action: 'skip', reason: 'master_off' };
    if (!connected) return { action: 'skip', reason: 'not_connected' };

    const text = contentText(row);
    // /new của khách được xử lý kể cả khi thread đang tắt/tạm dừng (chỉ cần công tắc tổng bật)
    if (row.content_type === 'text' && parseCustomerCommand(text) === 'new') return { action: 'command_new', reason: 'command' };

    const threadType = thread?.type || 'user';
    const override = state?.ai_enabled;
    if (override === 0) return { action: 'skip', reason: 'thread_off' };

    if (override !== 1) {
        if (threadType === 'group') {
            if (settings.group_mode === 'off') return { action: 'skip', reason: 'group_off' };
            const wl = settings.group_whitelist || [];
            if (wl.length && !wl.includes(String(thread.thread_id))) return { action: 'skip', reason: 'group_not_whitelisted' };
            if (settings.group_mode === 'mention' && !isAddressedToBot(parseMeta(row), zaloId)) return { action: 'skip', reason: 'not_mentioned' };
        } else {
            const mode = settings.dm_mode;
            if (mode === 'off') return { action: 'skip', reason: 'dm_off' };
            const isContact = !!thread?.is_contact;
            if (mode === 'contacts' && !isContact) return { action: 'skip', reason: 'not_contact' };
            if (mode === 'non_contacts' && isContact) return { action: 'skip', reason: 'is_contact' };
        }
    } else if (threadType === 'group' && settings.group_mode === 'mention' && !isAddressedToBot(parseMeta(row), zaloId)) {
        // Ghi đè bật cho nhóm vẫn giữ quy tắc tag (tránh bot trả lời mọi tin trong nhóm bận)
        return { action: 'skip', reason: 'not_mentioned' };
    }

    if (state?.needs_human) return { action: 'skip', reason: 'needs_human' };
    if ((state?.paused_until || 0) > now) return { action: 'skip', reason: 'paused' };
    if (!isWithinActiveHours(settings.active_hours, now)) return { action: 'skip', reason: 'outside_hours' };

    if (settings.cooldown_seconds > 0 && state?.last_reply_at && now - state.last_reply_at < settings.cooldown_seconds * 1000) {
        return { action: 'skip', reason: 'cooldown' };
    }
    if (settings.daily_limit_per_thread > 0 && state?.reply_count_date === todayKey(now) && state.reply_count_day >= settings.daily_limit_per_thread) {
        return { action: 'skip', reason: 'daily_limit' };
    }

    if (row.content_type === 'text') return text.trim() ? { action: 'reply', reason: 'text' } : { action: 'skip', reason: 'empty' };
    if (isImageRow(row)) {
        if (settings.vision_enabled) return { action: 'reply', reason: 'image' };
        return settings.non_text_reply ? { action: 'non_text_reply', reason: 'image_vision_off' } : { action: 'skip', reason: 'image_vision_off' };
    }
    return settings.non_text_reply ? { action: 'non_text_reply', reason: `type_${row.content_type}` } : { action: 'skip', reason: `unsupported_${row.content_type}` };
}

module.exports = { decide, isAddressedToBot, isWithinActiveHours, parseMeta, contentText, isImageRow, todayKey };

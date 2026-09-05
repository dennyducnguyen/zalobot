// =============================================
// Cấu hình Trợ lý AI — default + validate (zod) + cache
// Lưu ai_settings dạng key/value JSON; thêm setting mới chỉ cần thêm vào DEFAULTS + schema
// =============================================
const { z } = require('zod');

const DEFAULTS = {
    enabled: false,
    assistant_name: 'Trợ lý',
    instruction: '',
    language: 'vi',
    reply_max_chars: 1200,
    unknown_answer: '',
    disclose_ai: true,
    dm_mode: 'all',              // off | all | non_contacts | contacts
    group_mode: 'mention',       // off | mention | all
    group_whitelist: [],         // [] = mọi nhóm
    group_quote_reply: true,     // quote + mention người hỏi trong nhóm
    history_limit: 20,
    history_max_age_hours: 12,
    image_history_limit: 3,
    vision_enabled: true,
    image_hosts: ['zdn.vn', 'zadn.vn', 'zalo.me', 'zaloapp.com', 'zalo.cloud'],
    debounce_ms: 3000,
    human_pause_minutes: 30,
    cooldown_seconds: 5,
    daily_limit_per_thread: 200,
    global_concurrency: 3,
    turn_timeout_ms: 90000,
    image_timeout_ms: 180000,
    max_tool_rounds: 4,
    max_tokens: 1500,
    humanize_delay_ms: [800, 2500],
    active_hours: null,          // { tz, ranges: [["18:00","08:00"]], days: [0..6] }
    non_text_reply: '',
    error_reply: '',
    new_session_reply: 'Đã bắt đầu hội thoại mới. Bạn cần hỗ trợ gì?',
    reasoning_effort: 'low',
    temperature: 0.7,
    tools: { generate_image: false, handoff_to_human: true, get_current_time: true },
    chat_provider_id: null,
    fallback_provider_id: null,
    image_provider_id: null,
    embedding_provider_id: null,
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const nullableId = z.number().int().positive().nullable();

const schema = z.object({
    enabled: z.boolean(),
    assistant_name: z.string().max(60),
    instruction: z.string().max(20000),
    language: z.string().max(10),
    reply_max_chars: z.number().int().min(200).max(2000),
    unknown_answer: z.string().max(500),
    disclose_ai: z.boolean(),
    dm_mode: z.enum(['off', 'all', 'non_contacts', 'contacts']),
    group_mode: z.enum(['off', 'mention', 'all']),
    group_whitelist: z.array(z.string().max(40)).max(500),
    group_quote_reply: z.boolean(),
    history_limit: z.number().int().min(0).max(100),
    history_max_age_hours: z.number().min(0).max(24 * 30),
    image_history_limit: z.number().int().min(0).max(10),
    vision_enabled: z.boolean(),
    image_hosts: z.array(z.string().max(100)).max(50),
    debounce_ms: z.number().int().min(0).max(30000),
    human_pause_minutes: z.number().min(0).max(24 * 60),
    cooldown_seconds: z.number().min(0).max(3600),
    daily_limit_per_thread: z.number().int().min(0).max(100000),
    global_concurrency: z.number().int().min(1).max(20),
    turn_timeout_ms: z.number().int().min(5000).max(600000),
    image_timeout_ms: z.number().int().min(5000).max(600000),
    max_tool_rounds: z.number().int().min(0).max(10),
    max_tokens: z.number().int().min(100).max(32000),
    humanize_delay_ms: z.tuple([z.number().int().min(0).max(60000), z.number().int().min(0).max(60000)]),
    active_hours: z.object({
        tz: z.string().max(60),
        ranges: z.array(z.tuple([hhmm, hhmm])).max(10),
        days: z.array(z.number().int().min(0).max(6)).max(7),
    }).nullable(),
    non_text_reply: z.string().max(1000),
    error_reply: z.string().max(1000),
    new_session_reply: z.string().max(500),
    reasoning_effort: z.enum(['none', 'low', 'medium', 'high']),
    temperature: z.number().min(0).max(2),
    tools: z.record(z.string().max(60), z.boolean()),
    chat_provider_id: nullableId,
    fallback_provider_id: nullableId,
    image_provider_id: nullableId,
    embedding_provider_id: nullableId,
}).partial();

function createSettings(aiStore) {
    let cache = null;

    function load() {
        const stored = aiStore.settings.all();
        const merged = { ...DEFAULTS };
        for (const [k, v] of Object.entries(stored)) {
            if (!(k in DEFAULTS)) continue;
            merged[k] = k === 'tools' ? { ...DEFAULTS.tools, ...(v || {}) } : v;
        }
        cache = merged;
        return merged;
    }

    return {
        DEFAULTS,
        get: () => cache || load(),
        reload: load,
        /** Validate + lưu một phần; trả cấu hình mới. Ném ZodError nếu sai. */
        update(patch) {
            const parsed = schema.parse(patch || {});
            const clean = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (v === undefined) continue;
                clean[k] = k === 'tools' ? { ...(cache || load()).tools, ...v } : v;
            }
            aiStore.settings.setMany(clean);
            return load();
        },
    };
}

module.exports = { createSettings, DEFAULTS, schema };

// =============================================
// Tool registry — thêm tool mới = thêm 1 file + 1 dòng require bên dưới.
// Mỗi tool: { name, label, description, settingKey|null, definition:{description, parameters}, available(ctx)→{ok,reason}, run(args, ctx) }
// =============================================
const TOOLS = [
    require('./getCurrentTime'),
    require('./handoffToHuman'),
    require('./generateImage'),
];

function createToolRegistry({ settings, providers, logger }) {
    function isEnabled(tool, cfg) {
        if (!tool.settingKey) return true;
        const v = cfg.tools?.[tool.settingKey];
        return v === undefined ? false : !!v;
    }

    function availability(tool, cfg) {
        try { return tool.available ? tool.available({ settings: cfg, providers }) : { ok: true }; }
        catch (e) { return { ok: false, reason: e.message }; }
    }

    /** Tool đang bật + khả dụng (đưa vào request LLM) */
    function active(cfg = settings.get()) {
        return TOOLS.filter(t => isEnabled(t, cfg) && availability(t, cfg).ok);
    }

    /** @returns {import('../providers/types').ToolDef[]} */
    function definitions(cfg = settings.get()) {
        return active(cfg).map(t => ({ name: t.name, description: t.definition.description, parameters: t.definition.parameters }));
    }

    async function run(name, args, ctx) {
        const tool = TOOLS.find(t => t.name === name);
        if (!tool) return { ok: false, error: `Tool "${name}" không tồn tại` };
        const cfg = ctx.settings || settings.get();
        if (!isEnabled(tool, cfg)) return { ok: false, error: `Tool "${name}" đang tắt` };
        const avail = availability(tool, cfg);
        if (!avail.ok) return { ok: false, error: avail.reason || `Tool "${name}" không khả dụng` };
        try {
            return await tool.run(args || {}, { ...ctx, providers, logger });
        } catch (e) {
            logger?.warn(`⚠️ [ai] tool ${name} lỗi: ${e.message}`);
            return { ok: false, error: e.message };
        }
    }

    /** Thông tin cho UI */
    function describe(cfg = settings.get()) {
        return TOOLS.map(t => {
            const avail = availability(t, cfg);
            return {
                name: t.name, label: t.label, description: t.description, setting_key: t.settingKey || null,
                toggleable: !!t.settingKey, enabled: isEnabled(t, cfg), available: avail.ok, reason: avail.ok ? '' : (avail.reason || ''),
            };
        });
    }

    return { active, definitions, run, describe, names: () => TOOLS.map(t => t.name) };
}

module.exports = { createToolRegistry, TOOLS };

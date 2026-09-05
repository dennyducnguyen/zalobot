// =============================================
// Agent loop: chat ↔ tool cho tới khi có câu trả lời text (tối đa maxRounds vòng tool).
// =============================================

/**
 * @param {object} p
 * @param {object} p.provider          instance provider (có .chat)
 * @param {{ system:string, messages:any[], model?:string, maxTokens?:number, temperature?:number, reasoningEffort?:string, timeoutMs?:number }} p.request
 * @param {{ definitions(cfg):any[], run(name,args,ctx):Promise<any> }} p.tools
 * @param {object} p.ctx               ctx cho tool (threadId, settings, attachments, recentImages, engine, signal)
 * @param {number} p.maxRounds
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{ text:string|null, toolCalls:Array<{name:string,args:object,ok:boolean,ms:number,error?:string}>, usage:{inputTokens:number,outputTokens:number}, rounds:number, stopReason:string }>}
 */
async function runAgent({ provider, request, tools, ctx, maxRounds = 4, signal }) {
    const messages = [...request.messages];
    const cfg = ctx.settings;
    const toolDefs = provider.supports?.tools === false ? [] : tools.definitions(cfg);
    const usage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls = [];
    let rounds = 0;
    let lastText = null;

    for (;;) {
        const res = await provider.chat({
            model: request.model, system: request.system, messages,
            tools: toolDefs.length ? toolDefs : undefined,
            maxTokens: request.maxTokens, temperature: request.temperature, reasoningEffort: request.reasoningEffort,
            timeoutMs: request.timeoutMs, signal,
        });
        usage.inputTokens += res.usage?.inputTokens || 0;
        usage.outputTokens += res.usage?.outputTokens || 0;
        if (res.content) lastText = res.content;

        if (!res.toolCalls?.length) {
            return { text: res.content ?? lastText, toolCalls, usage, rounds, stopReason: res.stopReason };
        }
        if (rounds >= maxRounds) {
            return { text: lastText, toolCalls, usage, rounds, stopReason: 'max_tool_rounds' };
        }
        rounds++;
        messages.push({ role: 'assistant', content: res.content ?? null, toolCalls: res.toolCalls });
        for (const tc of res.toolCalls) {
            const t0 = Date.now();
            const out = await tools.run(tc.name, tc.args, ctx);
            const ms = Date.now() - t0;
            toolCalls.push({ name: tc.name, args: summarizeArgs(tc.args), ok: out?.ok !== false, ms, ...(out?.error ? { error: String(out.error).slice(0, 200) } : {}) });
            messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify(out ?? { ok: true }) });
        }
    }
}

function summarizeArgs(args) {
    const s = JSON.stringify(args ?? {});
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

module.exports = { runAgent };

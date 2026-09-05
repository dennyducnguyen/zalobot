// =============================================
// Hợp đồng chung cho mọi LLM provider (JSDoc). Engine chỉ biết các kiểu này.
// =============================================

/**
 * @typedef {{ role:'user', content:string, images?:string[] }} UserMessage   images = data URL
 * @typedef {{ role:'assistant', content:string|null, toolCalls?:ToolCall[] }} AssistantMessage
 * @typedef {{ role:'tool', toolCallId:string, content:string }} ToolMessage
 * @typedef {UserMessage|AssistantMessage|ToolMessage} ChatMessage
 *
 * @typedef {{ id:string, name:string, args:object }} ToolCall
 * @typedef {{ name:string, description:string, parameters:object }} ToolDef   parameters = JSON Schema
 *
 * @typedef {{ model:string, system?:string, messages:ChatMessage[], tools?:ToolDef[], maxTokens?:number,
 *             temperature?:number, reasoningEffort?:'none'|'low'|'medium'|'high', signal?:AbortSignal }} ChatRequest
 * @typedef {{ content:string|null, toolCalls:ToolCall[], stopReason:'end'|'tool_use'|'max_tokens',
 *             usage:{ inputTokens:number, outputTokens:number } }} ChatResponse
 *
 * @typedef {{ slug:string, displayName:string }} ModelInfo
 * @typedef {{ prompt:string, size?:string, refImages?:string[], model?:string, signal?:AbortSignal }} ImageRequest
 * @typedef {{ data:Buffer, mime:string }} ImageResult
 * @typedef {{ model:string, inputs:string[], dimensions?:number }} EmbedRequest
 * @typedef {{ model:string, vectors:number[][], usage:{ inputTokens:number } }} EmbedResponse
 */

/**
 * Lỗi provider có thêm status HTTP + retryAfterMs + authFail để engine quyết định retry/fallback.
 */
class ProviderError extends Error {
    constructor(message, { status = 0, retryAfterMs = 0, authFail = false, code = '' } = {}) {
        super(message);
        this.name = 'ProviderError';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.authFail = authFail;
        this.code = code;
    }
    get retryable() {
        return this.status === 429 || this.status >= 500 || this.code === 'NETWORK';
    }
}

function safeParseArgs(raw) {
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    const s = String(raw).trim();
    if (!s) return {};
    try { return JSON.parse(s); } catch { return { _raw: s }; }
}

module.exports = { ProviderError, safeParseArgs };

// =============================================
// fetch helper: timeout, retry 429/5xx/lỗi mạng (backoff + Retry-After), che secret trong lỗi
// =============================================
const { ProviderError } = require('./types');
const { maskSecrets } = require('../secrets');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function retryAfterMs(res) {
    const ra = Number(res.headers.get('retry-after'));
    return Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0;
}

/**
 * Gọi HTTP và trả Response OK. Ném ProviderError nếu !ok (đã đọc body lỗi).
 * @param {string} url
 * @param {RequestInit & { timeoutMs?:number, retries?:number, signal?:AbortSignal }} opts
 */
async function fetchWithRetry(url, opts = {}) {
    const { timeoutMs = 60000, retries = 2, signal, ...init } = opts;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
        const onAbort = () => ctrl.abort(signal.reason);
        if (signal) {
            if (signal.aborted) { clearTimeout(timer); throw new ProviderError('Đã hủy', { code: 'ABORTED' }); }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            const res = await fetch(url, { ...init, signal: ctrl.signal });
            if (res.ok) return res;
            const text = await res.text().catch(() => '');
            const err = new ProviderError(`HTTP ${res.status}: ${maskSecrets(text).slice(0, 600)}`, {
                status: res.status, retryAfterMs: retryAfterMs(res), authFail: res.status === 401,
            });
            if (!err.retryable || attempt === retries) throw err;
            lastErr = err;
            await sleep(err.retryAfterMs || (500 * 2 ** attempt + Math.random() * 200));
        } catch (e) {
            if (e instanceof ProviderError) { if (attempt === retries || !e.retryable) throw e; lastErr = e; continue; }
            if (signal?.aborted) throw new ProviderError('Đã hủy', { code: 'ABORTED' });
            const isTimeout = ctrl.signal.aborted;
            const err = new ProviderError(isTimeout ? `Hết thời gian chờ (${timeoutMs} ms)` : `Lỗi mạng: ${maskSecrets(e.message)}`, { code: 'NETWORK' });
            if (attempt === retries) throw err;
            lastErr = err;
            await sleep(500 * 2 ** attempt + Math.random() * 200);
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }
    throw lastErr || new ProviderError('Lỗi không xác định');
}

async function fetchJson(url, opts = {}) {
    const res = await fetchWithRetry(url, opts);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new ProviderError(`Phản hồi không phải JSON: ${text.slice(0, 200)}`); }
}

module.exports = { fetchWithRetry, fetchJson, sleep };

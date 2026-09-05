// =============================================
// Lệnh trong chat
//  - Khách: /new  → làm mới hội thoại
//  - Chủ kênh (gửi từ app Zalo, isSelf): /ai on | /ai off | /ai status | /new
// =============================================

function normalize(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** @returns {'new'|null} */
function parseCustomerCommand(text) {
    const t = normalize(text);
    if (t === '/new' || t === '/reset' || t === '/moi') return 'new';
    return null;
}

/** @returns {{ cmd:'on'|'off'|'status'|'new' }|null} */
function parseOwnerCommand(text) {
    const t = normalize(text);
    if (t === '/new' || t === '/reset') return { cmd: 'new' };
    const m = /^\/ai(?:\s+(on|off|status|bật|tắt|bat|tat))?$/.exec(t);
    if (!m) return null;
    const w = m[1] || 'status';
    if (w === 'on' || w === 'bật' || w === 'bat') return { cmd: 'on' };
    if (w === 'off' || w === 'tắt' || w === 'tat') return { cmd: 'off' };
    return { cmd: 'status' };
}

module.exports = { parseCustomerCommand, parseOwnerCommand };

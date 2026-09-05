// =============================================
// Zalo Inbox — logic trang inbox chính
// =============================================
(() => {
'use strict';

// ============ State ============
let me = null;
let zaloStatus = null;
let threads = [];
let currentThread = null;
let oldestMsgId = 0;
let pendingImageBase64 = null;
let filterType = '';
let searchTimer = null;
let qrPollTimer = null;
let currentLoginId = null;
let aiSummary = null;      // trạng thái AI theo thread (từ /app/threads)
let aiThreadState = null;  // trạng thái AI của thread đang mở

const $ = (id) => document.getElementById(id);

// ============ Helpers ============
async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (res.status === 401) {
        location.href = '/login.html';
        throw new Error('unauthorized');
    }
    return res.json();
}

function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function timeShort(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

function timeFull(ts) {
    const d = new Date(Number(ts));
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(ts) {
    return new Date(Number(ts)).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function avatarHtml(t) {
    if (t.avatar_url) return `<img class="avatar" src="${esc(t.avatar_url)}" onerror="this.outerHTML='<div class=avatar>${t.type === 'group' ? '👥' : '👤'}</div>'">`;
    return `<div class="avatar">${t.type === 'group' ? '👥' : '👤'}</div>`;
}

// ============ Trạng thái kênh ============
function renderChannelStatus() {
    const z = zaloStatus || {};
    const chip = $('channelChip');
    if (z.zalo_id || z.display_name) {
        chip.style.display = 'flex';
        $('channelName').textContent = z.display_name || z.zalo_id;
        $('channelAvatar').src = z.avatar_url || '';
        $('channelAvatar').style.display = z.avatar_url ? 'block' : 'none';
    } else {
        chip.style.display = 'none';
    }
    $('statusDot').className = 'status-dot' + (z.connected ? ' on' : '');
    $('bannerDisconnected').style.display = z.connected ? 'none' : 'flex';
}

// ============ Danh sách hội thoại ============
async function loadThreads() {
    const search = $('searchInput').value.trim();
    const json = await api(`/app/threads?search=${encodeURIComponent(search)}&type=${filterType}`);
    if (!json.success) return;
    threads = json.data.threads;
    aiSummary = json.data.ai || null;
    renderThreads();
}

// Icon AI cho từng thread trong danh sách: 🤖 đang trả lời, ⏸️ tạm dừng, 🙋 cần người
function aiIconFor(t) {
    if (!aiSummary || !aiSummary.enabled) return '';
    const o = aiSummary.overrides?.[t.thread_id];
    if (o?.needs_human) return '<span class="ai-mark" title="Cần người hỗ trợ">🙋</span>';
    if (o?.ai_enabled === 0) return '';
    if (o?.paused) return '<span class="ai-mark" title="AI tạm dừng (người thật đang trả lời)">⏸️</span>';
    if (o?.ai_enabled === 1) return '<span class="ai-mark" title="AI đang bật">🤖</span>';
    let on = false;
    if (t.type === 'group') on = aiSummary.group_mode !== 'off' && (!aiSummary.group_whitelist?.length || aiSummary.group_whitelist.includes(t.thread_id));
    else on = aiSummary.dm_mode === 'all' || (aiSummary.dm_mode === 'contacts' && t.is_contact) || (aiSummary.dm_mode === 'non_contacts' && !t.is_contact);
    return on ? '<span class="ai-mark" title="AI đang bật">🤖</span>' : '';
}

function renderThreads() {
    const list = $('threadList');
    if (threads.length === 0) {
        list.innerHTML = '<div class="empty-note">Chưa có hội thoại nào.<br>Bấm "Đồng bộ danh bạ" để import bạn bè + nhóm.</div>';
        return;
    }
    list.innerHTML = threads.map(t => `
        <div class="thread-item ${currentThread?.thread_id === t.thread_id ? 'active' : ''}" data-id="${esc(t.thread_id)}">
            ${avatarHtml(t)}
            <div class="thread-info">
                <div class="thread-name">
                    <span class="name-text">${esc(t.name || '(Chưa có tên)')}</span>
                    <span class="badge-type ${t.type}">${t.type === 'group' ? 'NHÓM' : 'CÁ NHÂN'}</span>
                    ${aiIconFor(t)}
                </div>
                <div class="thread-id">${esc(t.thread_id)}</div>
                <div class="thread-preview">${t.last_direction === 'out' ? 'Bạn: ' : ''}${esc(t.last_message || '')}</div>
            </div>
            <div class="thread-meta">
                <div class="thread-time">${timeShort(t.last_message_at)}</div>
                ${t.unread_count > 0 ? `<span class="unread-badge">${t.unread_count}</span>` : ''}
            </div>
        </div>
    `).join('');

    list.querySelectorAll('.thread-item').forEach(el => {
        el.addEventListener('click', () => openThread(el.dataset.id));
    });
}

// ============ Mở hội thoại ============
async function openThread(threadId) {
    const json = await api(`/app/messages/${encodeURIComponent(threadId)}`);
    if (!json.success) return;

    currentThread = json.data.thread || { thread_id: threadId, type: 'user', name: '' };
    const msgs = json.data.messages;
    oldestMsgId = msgs.length > 0 ? msgs[0].id : 0;

    $('chatPlaceholder').style.display = 'none';
    $('chatContent').style.display = 'flex';
    $('app').classList.add('chat-open');

    $('chatTitle').textContent = currentThread.name || '(Chưa có tên)';
    $('chatThreadId').textContent = currentThread.thread_id;
    const badge = $('chatTypeBadge');
    badge.textContent = currentThread.type === 'group' ? 'NHÓM' : 'CÁ NHÂN';
    badge.className = 'badge-type ' + currentThread.type;
    $('chatAvatar').outerHTML = avatarHtml(currentThread).replace('class="avatar"', 'class="avatar" id="chatAvatar"');
    loadAiChip(threadId);

    const body = $('chatBody');
    body.innerHTML = (msgs.length >= 50 ? '<div class="load-more"><button class="btn btn-light btn-sm" id="btnLoadMore">Tải tin cũ hơn</button></div>' : '')
        + msgs.map(renderMessage).join('');
    bindLoadMore();
    body.scrollTop = body.scrollHeight;

    // Đánh dấu đã đọc
    api(`/app/threads/${encodeURIComponent(threadId)}/read`, { method: 'POST' }).then(loadThreads);
}

function bindLoadMore() {
    const btn = $('btnLoadMore');
    if (btn) btn.addEventListener('click', loadOlderMessages);
}

async function loadOlderMessages() {
    if (!currentThread || !oldestMsgId) return;
    const json = await api(`/app/messages/${encodeURIComponent(currentThread.thread_id)}?before_id=${oldestMsgId}`);
    if (!json.success || json.data.messages.length === 0) {
        const btn = $('btnLoadMore');
        if (btn) btn.parentElement.remove();
        return;
    }
    const msgs = json.data.messages;
    oldestMsgId = msgs[0].id;
    const body = $('chatBody');
    const prevHeight = body.scrollHeight;
    const loadMoreEl = body.querySelector('.load-more');
    const html = msgs.map(renderMessage).join('');
    if (loadMoreEl) loadMoreEl.insertAdjacentHTML('afterend', html);
    else body.insertAdjacentHTML('afterbegin', html);
    body.scrollTop = body.scrollHeight - prevHeight;
}

// ============ Render 1 tin nhắn ============
function renderMessage(m) {
    let inner = '';
    if (m.content_type === 'text') {
        inner = esc(m.content);
    } else if (m.content_type === 'photo' || m.content_type === 'webchat') {
        // content là JSON: { href, thumb, caption, ... }
        let obj = {};
        try { obj = JSON.parse(m.content); } catch { /* giữ obj rỗng */ }
        const src = obj.href || obj.thumb || obj.oriUrl || '';
        const caption = obj.caption || obj.title || '';
        if (src) {
            inner = `<img class="msg-img" src="${esc(src)}" loading="lazy" onclick="window.open('${esc(src)}')">`
                + (caption ? `<div>${esc(caption)}</div>` : '');
        } else {
            inner = `<span class="msg-special">[Hình ảnh]</span>`;
        }
    } else if (m.content_type === 'sticker') {
        inner = `<span class="msg-special">[Sticker]</span>`;
    } else {
        // voice / video / file / unknown — thử lấy href
        let obj = {};
        try { obj = JSON.parse(m.content); } catch { /* giữ obj rỗng */ }
        const label = { voice: '[Voice]', video: '[Video]', file: '[File: ' + (obj.title || '') + ']' }[m.content_type] || `[${m.content_type}]`;
        inner = obj.href
            ? `<a href="${esc(obj.href)}" target="_blank" class="msg-special">${esc(label)} ⬇</a>`
            : `<span class="msg-special">${esc(label)}</span>`;
    }

    const senderLine = (m.direction === 'in' && currentThread?.type === 'group' && m.sender_name)
        ? `<div class="msg-sender">${esc(m.sender_name)}</div>` : '';

    return `
        <div class="msg-row ${m.direction}" data-mid="${m.id}">
            <div class="msg-bubble">
                ${senderLine}
                ${inner}
                <div class="msg-time">${timeFull(m.sent_at)}${sourceLabel(m)}</div>
            </div>
        </div>`;
}

function sourceLabel(m) {
    if (m.direction !== 'out') return '';
    if (m.source === 'ai') return ' · <span class="src-ai">🤖 AI</span>';
    if (m.source === 'api') return ' · API';
    if (m.source === 'mcp') return ' · MCP';
    if (m.source === 'app') return ' · App';
    return '';
}

// ============ Trợ lý AI — chip trạng thái trong header chat ============
const AI_CHIP_LABEL = { on: 'AI: Đang bật', off: 'AI: Tắt', paused: 'AI: Tạm dừng', needs_human: 'AI: Cần người' };
function renderAiChip() {
    const chip = $('aiChip');
    if (!currentThread || !aiThreadState) { chip.style.display = 'none'; return; }
    const st = aiThreadState;
    chip.style.display = 'inline-flex';
    chip.className = 'ai-chip ' + st.effective;
    let label = AI_CHIP_LABEL[st.effective] || 'AI';
    if (st.effective === 'paused' && st.paused_remaining_s > 0) label += ` (${Math.ceil(st.paused_remaining_s / 60)} phút)`;
    $('aiChipLabel').textContent = label;
    const reasons = {
        master_off: 'Công tắc tổng đang tắt (trang Trợ lý AI).', thread_off: 'Đã tắt riêng cho hội thoại này.',
        needs_human: 'AI đã chuyển cho nhân viên — bấm "Tiếp tục ngay" để AI trả lời lại.', paused: 'Người thật vừa trả lời nên AI tạm dừng.',
        thread_on: 'Bật riêng cho hội thoại này.', group_rule: 'Theo cấu hình nhóm (đang tắt / không trong danh sách).',
        group_mention: 'Theo cấu hình nhóm: chỉ trả lời khi được tag hoặc reply vào tin của bot.', group_all: 'Theo cấu hình nhóm: trả lời mọi tin.',
        dm_rule: 'Theo cấu hình cá nhân (không thuộc nhóm khách được trả lời).', dm_all: 'Theo cấu hình cá nhân.',
    };
    $('aiMenuInfo').textContent = reasons[st.reason] || '';
}
async function loadAiChip(threadId) {
    aiThreadState = null;
    renderAiChip();
    try {
        const json = await api(`/app/ai/threads/${encodeURIComponent(threadId)}/state`);
        if (json.success && currentThread?.thread_id === threadId) { aiThreadState = json.data; renderAiChip(); }
    } catch (e) { /* bỏ qua */ }
}
async function aiChipAction(act) {
    if (!currentThread) return;
    const tid = encodeURIComponent(currentThread.thread_id);
    let json;
    if (act === 'reset') json = await api(`/app/ai/threads/${tid}/reset`, { method: 'POST' });
    else {
        const body = act === 'on' ? { ai_enabled: true, resume: true } : act === 'off' ? { ai_enabled: false } : act === 'auto' ? { ai_enabled: null } : { resume: true };
        json = await api(`/app/ai/threads/${tid}/state`, { method: 'PUT', body: JSON.stringify(body) });
    }
    if (json?.success) {
        aiThreadState = json.data;
        renderAiChip();
        toast(act === 'reset' ? '🔄 Đã làm mới hội thoại AI' : '✅ Đã cập nhật trạng thái AI');
        loadThreads();
    } else toast('❌ ' + (json?.error?.message || 'Lỗi'));
}

function appendMessage(m) {
    const body = $('chatBody');
    body.insertAdjacentHTML('beforeend', renderMessage(m));
    body.scrollTop = body.scrollHeight;
}

// ============ Gửi tin ============
async function sendCurrent() {
    if (!currentThread) return;
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text && !pendingImageBase64) return;

    const btn = $('btnSend');
    btn.disabled = true;
    try {
        const json = await api('/app/send', {
            method: 'POST',
            body: JSON.stringify({
                thread_id: currentThread.thread_id,
                message: text || undefined,
                image_base64: pendingImageBase64 || undefined,
            }),
        });
        if (json.success) {
            input.value = '';
            input.style.height = 'auto';
            clearImagePreview();
            // Tin đã được emit qua SSE → nếu SSE chậm thì message_row đã có sẵn
            if (json.data.message_row && !document.querySelector(`[data-mid="${json.data.message_row.id}"]`)) {
                appendMessage(json.data.message_row);
            }
            loadThreads();
        } else {
            toast('❌ ' + (json.error?.message || 'Gửi thất bại'));
            if (json.error?.code === 'SESSION_EXPIRED' || json.error?.code === 'NOT_CONNECTED') refreshStatus();
        }
    } catch (e) {
        toast('❌ Lỗi kết nối server');
    }
    btn.disabled = false;
    input.focus();
}

function clearImagePreview() {
    pendingImageBase64 = null;
    $('imgPreview').style.display = 'none';
    $('fileInput').value = '';
}

// ============ QR Connect ============
async function openQrModal() {
    $('qrModal').style.display = 'flex';
    $('qrWrap').innerHTML = '<span>Đang tạo QR...</span>';
    $('qrStatus').textContent = 'Đang khởi tạo...';

    const json = await api('/app/zalo/qr', { method: 'POST' });
    if (!json.success) {
        $('qrStatus').textContent = '❌ ' + (json.error?.message || 'Lỗi tạo QR');
        return;
    }
    currentLoginId = json.data.login_id;

    // Chờ 1.5s cho file QR được tạo rồi hiện ảnh
    setTimeout(() => {
        $('qrWrap').innerHTML = `<img src="/app/zalo/qr-image/${currentLoginId}?t=${Date.now()}" onerror="setTimeout(()=>{this.src='/app/zalo/qr-image/${currentLoginId}?t='+Date.now()},1500)">`;
    }, 1500);

    // Polling trạng thái
    clearInterval(qrPollTimer);
    qrPollTimer = setInterval(async () => {
        try {
            const st = await api(`/app/zalo/qr-status/${currentLoginId}`);
            if (!st.success) {
                $('qrStatus').textContent = '❌ ' + (st.error?.message || 'Thất bại');
                clearInterval(qrPollTimer);
                return;
            }
            const s = st.data.status;
            const labels = { waiting: 'Chờ quét mã...', scanned: '✅ Đã quét — xác nhận trên điện thoại', success: '🎉 Kết nối thành công!' };
            $('qrStatus').textContent = labels[s] || s;
            if (s === 'success') {
                clearInterval(qrPollTimer);
                zaloStatus = st.data.zalo;
                renderChannelStatus();
                setTimeout(() => { $('qrModal').style.display = 'none'; loadThreads(); }, 1200);
                toast('✅ Kênh Zalo đã kết nối!');
            }
        } catch (e) { /* poll tiếp */ }
    }, 2000);
}

function closeQrModal() {
    $('qrModal').style.display = 'none';
    clearInterval(qrPollTimer);
}

// ============ SSE realtime ============
function connectSSE() {
    const es = new EventSource('/app/events');
    es.addEventListener('message', (e) => {
        const { message, thread } = JSON.parse(e.data);
        // Đang mở đúng hội thoại → append + đánh dấu đọc
        if (currentThread && message.thread_id === currentThread.thread_id) {
            if (!document.querySelector(`[data-mid="${message.id}"]`)) appendMessage(message);
            api(`/app/threads/${encodeURIComponent(message.thread_id)}/read`, { method: 'POST' });
        }
        loadThreads();
    });
    es.addEventListener('status', (e) => {
        zaloStatus = JSON.parse(e.data);
        renderChannelStatus();
    });
    es.addEventListener('threads_updated', () => loadThreads());
    // Trợ lý AI
    es.addEventListener('ai_state', (e) => {
        const { thread_id, state } = JSON.parse(e.data);
        if (currentThread && thread_id === currentThread.thread_id) { aiThreadState = state; renderAiChip(); }
        loadThreads();
    });
    es.addEventListener('ai_handoff', (e) => {
        const { thread_id } = JSON.parse(e.data);
        const t = threads.find(x => x.thread_id === thread_id);
        toast(`🙋 AI chuyển cho nhân viên: ${t?.name || thread_id}`);
        loadThreads();
    });
    es.addEventListener('ai_error', (e) => {
        const { message } = JSON.parse(e.data);
        toast('⚠️ Trợ lý AI lỗi: ' + String(message || '').slice(0, 120));
    });
    es.onerror = () => {
        // Tự reconnect sau 5s nếu đứt
        es.close();
        setTimeout(connectSSE, 5000);
    };
}

async function refreshStatus() {
    const json = await api('/app/me');
    if (json.success) {
        me = json.data.user;
        zaloStatus = json.data.zalo;
        $('brandName').textContent = json.data.app_name;
        document.title = json.data.app_name;
        renderChannelStatus();
    }
}

// ============ Events ============
function bindEvents() {
    $('btnLogout').addEventListener('click', async () => {
        await api('/app/logout', { method: 'POST' });
        location.href = '/login.html';
    });
    $('btnConnect').addEventListener('click', openQrModal);
    $('btnCloseQr').addEventListener('click', closeQrModal);
    $('btnSync').addEventListener('click', async () => {
        toast('📇 Đang đồng bộ danh bạ...');
        const json = await api('/app/zalo/sync', { method: 'POST' });
        if (json.success) {
            toast(`✅ Đã import ${json.data.friends} bạn bè, ${json.data.groups} nhóm`);
            loadThreads();
        } else {
            toast('❌ ' + (json.error?.message || 'Lỗi đồng bộ'));
        }
    });

    $('searchInput').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(loadThreads, 300);
    });

    document.querySelectorAll('.filter-tabs button').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-tabs button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            filterType = btn.dataset.type;
            loadThreads();
        });
    });

    const msgInput = $('msgInput');
    msgInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCurrent();
        }
    });
    msgInput.addEventListener('input', () => {
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    });

    $('btnSend').addEventListener('click', sendCurrent);
    $('btnAttach').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', () => {
        const file = $('fileInput').files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { toast('❌ Ảnh tối đa 8MB'); return; }
        const reader = new FileReader();
        reader.onload = () => {
            pendingImageBase64 = reader.result;
            $('imgPreviewEl').src = reader.result;
            $('imgPreview').style.display = 'flex';
        };
        reader.readAsDataURL(file);
    });
    $('btnRemoveImg').addEventListener('click', clearImagePreview);

    $('btnCopyId').addEventListener('click', () => {
        if (currentThread) {
            navigator.clipboard.writeText(currentThread.thread_id);
            toast('📋 Đã copy ID: ' + currentThread.thread_id);
        }
    });
    $('btnBack').addEventListener('click', () => $('app').classList.remove('chat-open'));

    // Chip AI + menu
    $('aiChip').addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = $('aiMenu');
        const open = menu.style.display !== 'none';
        menu.style.display = open ? 'none' : 'block';
        if (!open) { menu.style.top = ($('aiChip').offsetTop + $('aiChip').offsetHeight + 4) + 'px'; menu.style.right = '12px'; }
    });
    $('aiMenu').querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', () => {
        $('aiMenu').style.display = 'none';
        aiChipAction(b.dataset.act);
    }));
    document.addEventListener('click', (e) => { if (!$('aiMenu').contains(e.target)) $('aiMenu').style.display = 'none'; });

    // Paste ảnh trực tiếp vào composer
    msgInput.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items || [];
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                const reader = new FileReader();
                reader.onload = () => {
                    pendingImageBase64 = reader.result;
                    $('imgPreviewEl').src = reader.result;
                    $('imgPreview').style.display = 'flex';
                };
                reader.readAsDataURL(file);
                e.preventDefault();
                break;
            }
        }
    });
}

// ============ Init ============
(async function init() {
    try {
        await refreshStatus();
    } catch (e) { return; } // 401 → đã redirect login
    bindEvents();
    await loadThreads();
    connectSSE();
    // Refresh trạng thái mỗi 60s (phòng SSE miss)
    setInterval(refreshStatus, 60000);
})();

})();

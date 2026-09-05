// =============================================
// Zalo Inbox — trang Trợ lý AI
// =============================================
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
let data = null;          // { settings, status, tools, providers, kinds }
let groups = [];          // danh sách nhóm cho whitelist
let wlSelected = new Set();
let testHistory = [];
let testImage = null;
let logsOldest = 0;
let loginProviderId = null;
let loginPoll = null;

// Luôn trả về object { success, error } — không bao giờ ném lỗi (trừ 401 → về trang đăng nhập) để UI không bị treo nút
async function api(path, options = {}) {
    let res;
    try {
        res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    } catch (e) {
        return { success: false, error: { code: 'NETWORK', message: 'Không kết nối được máy chủ — kiểm tra mạng rồi thử lại' } };
    }
    if (res.status === 401 && !path.startsWith('/app/ai/providers/preview')) { location.href = '/login.html'; throw new Error('unauthorized'); }
    try { return await res.json(); }
    catch { return { success: false, error: { code: 'HTTP_' + res.status, message: `Máy chủ trả lỗi HTTP ${res.status}${res.status === 502 || res.status === 504 ? ' (server đang khởi động lại?) — thử lại sau vài giây' : ''}` } }; }
}
const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });
const post = (path, body) => api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

function toast(msg) { const el = $('toast'); el.textContent = msg; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3200); }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function fmtTime(ts) { return ts ? new Date(Number(ts)).toLocaleString('vi-VN') : '—'; }
const num = (id) => Number($(id).value);

// ============ Tabs ============
$('tabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    $('tabs').querySelectorAll('button').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    b.classList.add('active');
    $('tab-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'logs') loadLogs(true);
    if (b.dataset.tab === 'scope' && !groups.length) loadGroups();
    location.hash = b.dataset.tab;
}));

// ============ Load & render ============
async function load() {
    const json = await api('/app/ai/settings');
    if (!json.success) { toast('❌ ' + (json.error?.message || 'Lỗi tải cấu hình')); return; }
    data = json.data;
    renderMaster();
    renderOverview();
    renderProviders();
    fillInstruction();
    fillScope();
    renderTools();
    fillAdvanced();
}

function renderMaster() {
    const s = data.settings;
    $('masterSwitch').checked = !!s.enabled;
    $('masterLabel').textContent = 'AI trả lời tự động: ' + (s.enabled ? 'ĐANG BẬT' : 'ĐANG TẮT');
    const st = data.status;
    $('masterHint').textContent = st.chat_provider ? `Provider: ${st.chat_provider.name} · ${st.chat_provider.model || 'chưa chọn model'}` : 'Chưa chọn provider chat';
    $('warnings').innerHTML = (st.warnings || []).map(w => `<div class="warn-box">⚠️ ${esc(w)}</div>`).join('');
}

async function renderOverview() {
    const st = data.status;
    const s = data.settings;
    let stats = null;
    try { const r = await api('/app/ai/stats'); if (r.success) stats = r.data; } catch { /* bỏ qua */ }
    const sum = (arr, k) => (arr || []).reduce((a, x) => a + (x[k] || 0), 0);
    const today = stats?.today || [];
    const okToday = today.filter(x => x.status === 'ok' || x.status === 'fallback').reduce((a, x) => a + x.n, 0);
    const errToday = today.filter(x => x.status === 'error').reduce((a, x) => a + x.n, 0);
    const dmLabel = { all: 'tất cả', non_contacts: 'chỉ người lạ', contacts: 'chỉ danh bạ', off: 'tắt' }[s.dm_mode];
    const grLabel = { mention: 'khi được tag', all: 'mọi tin', off: 'tắt' }[s.group_mode];
    $('overviewCards').innerHTML = `
        <div class="stat-card"><div class="label">Trạng thái</div><div class="big">${s.enabled ? '🟢 Đang bật' : '⚪ Đang tắt'}</div><div class="hint">Kênh Zalo: ${st.connected ? 'đã kết nối' : 'chưa kết nối'}</div></div>
        <div class="stat-card"><div class="label">Provider chat</div><div class="big" style="font-size:16px">${st.chat_provider ? esc(st.chat_provider.name) : '—'}</div><div class="hint">${st.chat_provider ? esc(st.chat_provider.kind + ' · ' + (st.chat_provider.model || 'chưa chọn model')) : 'Chưa cấu hình'}${st.fallback_provider ? ' · dự phòng: ' + esc(st.fallback_provider.name) : ''}</div></div>
        <div class="stat-card"><div class="label">Hôm nay</div><div class="big">${okToday} lượt</div><div class="hint">${errToday} lỗi · ${sum(today, 'input_tokens')} tokens vào · ${sum(today, 'output_tokens')} tokens ra</div></div>
        <div class="stat-card"><div class="label">Phạm vi</div><div class="big" style="font-size:16px">Cá nhân: ${dmLabel}</div><div class="hint">Nhóm: ${grLabel}${s.group_whitelist?.length ? ` (${s.group_whitelist.length} nhóm)` : ''} · Tạm dừng khi người thật trả lời: ${s.human_pause_minutes} phút</div></div>
        <div class="stat-card"><div class="label">Đang chạy</div><div class="big">${st.running} / ${s.global_concurrency}</div><div class="hint">${st.queued} chờ · ${st.buffered_threads} thread đang gom tin · tổng ${st.stats?.turns || 0} lượt từ khi khởi động</div></div>`;
    try {
        const r = await api('/app/ai/logs?limit=8');
        const tb = $('recentLogs').querySelector('tbody');
        tb.innerHTML = (r.data?.logs || []).map(l => `<tr><td>${fmtTime(l.created_at)}</td><td>${esc(r.data.thread_names[l.thread_id] || l.thread_id)}</td><td>${statusTag(l)}</td><td>${esc(l.provider_kind || '')}</td><td>${l.input_tokens + l.output_tokens || ''}</td><td class="hint" style="margin:0">${esc((l.reply_preview || l.error || '').slice(0, 90))}</td></tr>`).join('') || '<tr><td colspan="6" class="hint">Chưa có lượt AI nào.</td></tr>';
    } catch { /* bỏ qua */ }
}

function statusTag(l) {
    if (l.status === 'ok') return `<span class="tag on">OK</span>`;
    if (l.status === 'fallback') return `<span class="tag warn">DỰ PHÒNG</span>`;
    if (l.status === 'error') return `<span class="tag off">LỖI</span>`;
    return `<span class="tag muted">BỎ QUA${l.skip_reason ? ': ' + esc(l.skip_reason) : ''}</span>`;
}

// ============ Providers ============
function providerStatusTag(p) {
    if (!p.is_enabled) return '<span class="tag muted">TẮT</span>';
    if (p.status === 'ok') return '<span class="tag on">OK</span>';
    if (p.status === 'needs_reauth') return `<span class="tag warn" title="${esc(p.status_note)}">${p.kind === 'chatgpt' && !p.has_secret ? 'CHƯA ĐĂNG NHẬP' : 'CẦN ĐĂNG NHẬP LẠI'}</span>`;
    if (p.status === 'error') return `<span class="tag off" title="${esc(p.status_note)}">LỖI</span>`;
    return '<span class="tag muted">CHƯA KIỂM TRA</span>';
}
function modelSelect(p, field, list, current) {
    const opts = [...new Set([current, ...(list || []).map(m => m.slug)].filter(Boolean))];
    if (!opts.length) return '<span class="hint" style="margin:0">—</span>';
    return `<select data-pid="${p.id}" data-field="${field}">${field === 'image_model' ? '<option value="">(không)</option>' : ''}${opts.map(o => `<option value="${esc(o)}" ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}
function renderProviders() {
    const tb = $('providerTable').querySelector('tbody');
    const ps = data.providers || [];
    tb.innerHTML = ps.map(p => `
        <tr>
            <td><b>${esc(p.name)}</b>${p.email ? `<div class="hint" style="margin:0">${esc(p.email)}</div>` : ''}<div class="hint" style="margin:0">${['chat', 'fallback', 'image'].filter(r => p.roles[r]).map(r => ({ chat: '💬 chat', fallback: '🛟 dự phòng', image: '🎨 ảnh' })[r]).join(' · ')}</div></td>
            <td>${esc(p.kind_label)}${p.base_url ? `<div class="hint mono" style="margin:0">${esc(p.base_url)}</div>` : ''}</td>
            <td>${modelSelect(p, 'chat_model', p.models, p.chat_model)}</td>
            <td>${p.kind === 'gemini' || p.kind === 'chatgpt' ? modelSelect(p, 'image_model', p.image_models, p.image_model) : '<span class="hint" style="margin:0">—</span>'}</td>
            <td>${providerStatusTag(p)}${p.verified_at ? `<div class="hint" style="margin:0">kiểm tra ${fmtTime(p.verified_at)}</div>` : ''}</td>
            <td style="white-space:nowrap">
                ${p.kind === 'chatgpt' ? `<button class="btn btn-primary btn-sm" data-login="${p.id}">${p.has_secret ? 'Đăng nhập lại' : 'Đăng nhập ChatGPT'}</button>` : `<button class="btn btn-light btn-sm" data-rotate="${p.id}">Đổi key</button>`}
                <button class="btn btn-light btn-sm" data-verify="${p.id}">Kiểm tra</button>
                <button class="btn btn-light btn-sm" data-toggle="${p.id}">${p.is_enabled ? 'Tắt' : 'Bật'}</button>
                <button class="btn btn-danger btn-sm" data-del="${p.id}">Xóa</button>
            </td>
        </tr>`).join('') || '<tr><td colspan="6" class="hint">Chưa có provider — bấm "+ Thêm provider".</td></tr>';

    tb.querySelectorAll('select[data-pid]').forEach(sel => sel.addEventListener('change', async () => {
        const r = await api(`/app/ai/providers/${sel.dataset.pid}`, { method: 'PATCH', body: JSON.stringify({ [sel.dataset.field]: sel.value }) });
        toast(r.success ? '✅ Đã đổi model' : '❌ ' + (r.error?.message || 'Lỗi'));
        await load();
    }));
    tb.querySelectorAll('[data-verify]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Đang kiểm tra...';
        const r = await post(`/app/ai/providers/${b.dataset.verify}/verify`);
        toast(r.success ? (r.data.provider.status === 'ok' ? '✅ Provider hoạt động tốt' : '⚠️ ' + (r.data.provider.status_note || r.data.provider.status)) : '❌ ' + (r.error?.message || 'Lỗi'));
        await load();
    }));
    tb.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
        const p = ps.find(x => x.id === Number(b.dataset.toggle));
        const r = await api(`/app/ai/providers/${p.id}`, { method: 'PATCH', body: JSON.stringify({ is_enabled: !p.is_enabled }) });
        if (!r.success) toast('❌ ' + (r.error?.message || 'Lỗi'));
        await load();
    }));
    tb.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Xóa provider này? Key/token đã lưu sẽ bị xóa.')) return;
        const r = await api(`/app/ai/providers/${b.dataset.del}`, { method: 'DELETE' });
        toast(r.success ? '🗑️ Đã xóa' : '❌ ' + (r.error?.message || 'Lỗi'));
        await load();
    }));
    tb.querySelectorAll('[data-rotate]').forEach(b => b.addEventListener('click', async () => {
        const key = prompt('Dán API key mới (key sẽ được kiểm tra thật trước khi lưu):');
        if (!key) return;
        const r = await api(`/app/ai/providers/${b.dataset.rotate}`, { method: 'PATCH', body: JSON.stringify({ api_key: key.trim() }) });
        toast(r.success ? '✅ Đã đổi key' : '❌ ' + (r.error?.message || 'Lỗi'));
        await load();
    }));
    tb.querySelectorAll('[data-login]').forEach(b => b.addEventListener('click', () => openLoginModal(Number(b.dataset.login))));

    const optionsFor = (filter) => '<option value="">— Không —</option>' + ps.filter(filter).map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.kind)}${p.chat_model ? ' · ' + esc(p.chat_model) : ''})</option>`).join('');
    $('roleChat').innerHTML = optionsFor(p => p.is_enabled);
    $('roleFallback').innerHTML = optionsFor(p => p.is_enabled);
    $('roleImage').innerHTML = optionsFor(p => p.is_enabled && (p.kind === 'gemini' || p.kind === 'chatgpt'));
    $('roleChat').value = data.settings.chat_provider_id || '';
    $('roleFallback').value = data.settings.fallback_provider_id || '';
    $('roleImage').value = data.settings.image_provider_id || '';
}

$('btnSaveRoles').addEventListener('click', async () => {
    const v = (id) => $(id).value ? Number($(id).value) : null;
    const r = await put('/app/ai/settings', { chat_provider_id: v('roleChat'), fallback_provider_id: v('roleFallback'), image_provider_id: v('roleImage') });
    toast(r.success ? '✅ Đã lưu vai trò' : '❌ ' + (r.error?.message || 'Lỗi'));
    await load();
});

// ---- Modal thêm provider ----
let pmPreview = null;
function pmReset() {
    pmPreview = null;
    $('pmName').value = ''; $('pmKey').value = ''; $('pmBase').value = '';
    $('pmModels').style.display = 'none'; $('pmError').style.display = 'none'; $('pmKeyHint').textContent = '';
    $('pmChatModel').innerHTML = ''; $('pmImageModel').innerHTML = '';
    pmKindChanged();
}
function pmKindChanged() {
    const kind = $('pmKind').value;
    $('pmBaseWrap').style.display = kind === 'openai_compat' ? 'block' : 'none';
    $('pmKeyWrap').style.display = kind === 'chatgpt' ? 'none' : 'block';
    $('pmChatgptNote').style.display = kind === 'chatgpt' ? 'block' : 'none';
    $('pmImageWrap').style.display = kind === 'gemini' ? 'block' : 'none';
    $('pmModels').style.display = 'none';
    const suggestions = { gemini: 'gemini-chinh', openai: 'openai-api', openai_compat: 'openrouter', chatgpt: 'chatgpt-plus' };
    // Chỉ tự gợi ý tên khi ô trống hoặc đang là tên gợi ý của loại trước (người dùng đã gõ tay thì giữ)
    if (!$('pmName').value || Object.values(suggestions).includes($('pmName').value)) $('pmName').value = suggestions[kind];
    $('pmSave').textContent = kind === 'chatgpt' ? 'Tạo và đăng nhập' : 'Thêm provider';
}
$('pmKind').addEventListener('change', pmKindChanged);
$('btnAddProvider').addEventListener('click', () => { pmReset(); $('providerModal').style.display = 'flex'; });
$('pmCancel').addEventListener('click', () => { $('providerModal').style.display = 'none'; });
$('pmCheck').addEventListener('click', async () => {
    const kind = $('pmKind').value;
    $('pmError').style.display = 'none';
    $('pmCheck').disabled = true; $('pmCheck').textContent = 'Đang kiểm tra...';
    let r;
    try { r = await post('/app/ai/providers/preview', { kind, api_key: $('pmKey').value.trim(), base_url: $('pmBase').value.trim() }); }
    finally { $('pmCheck').disabled = false; $('pmCheck').textContent = 'Kiểm tra key & tải model'; }
    if (!r.success) { $('pmError').textContent = r.error?.message || 'Lỗi'; $('pmError').style.display = 'block'; return; }
    pmPreview = r.data;
    $('pmKeyHint').textContent = `✅ Key hợp lệ — ${r.data.models.length} model chat${r.data.image_models.length ? `, ${r.data.image_models.length} model ảnh` : ''}`;
    const pick = (list) => list.find(m => /flash|mini/i.test(m.slug) && !/lite|8b|preview|exp/i.test(m.slug)) || list[0];
    $('pmChatModel').innerHTML = r.data.models.map(m => `<option value="${esc(m.slug)}">${esc(m.displayName || m.slug)}</option>`).join('');
    if (r.data.models.length) $('pmChatModel').value = pick(r.data.models)?.slug || r.data.models[0].slug;
    $('pmImageModel').innerHTML = '<option value="">(không dùng tạo ảnh)</option>' + r.data.image_models.map(m => `<option value="${esc(m.slug)}">${esc(m.displayName || m.slug)}</option>`).join('');
    $('pmModels').style.display = 'grid';
});
$('pmSave').addEventListener('click', async () => {
    const kind = $('pmKind').value;
    $('pmError').style.display = 'none';
    const body = { kind, name: $('pmName').value.trim() };
    if (kind !== 'chatgpt') {
        if (!pmPreview) { $('pmError').textContent = 'Bấm "Kiểm tra key & tải model" trước.'; $('pmError').style.display = 'block'; return; }
        body.api_key = $('pmKey').value.trim();
        body.base_url = $('pmBase').value.trim();
        body.chat_model = $('pmChatModel').value;
        if (kind === 'gemini') body.image_model = $('pmImageModel').value;
    }
    $('pmSave').disabled = true;
    let r;
    try { r = await post('/app/ai/providers', body); } finally { $('pmSave').disabled = false; }
    if (!r.success) { $('pmError').textContent = r.error?.message || 'Lỗi'; $('pmError').style.display = 'block'; return; }
    $('providerModal').style.display = 'none';
    toast('✅ Đã thêm provider ' + r.data.provider.name);
    await load();
    // Tự gán vai trò chat nếu chưa có
    if (!data.settings.chat_provider_id && kind !== 'chatgpt') { await put('/app/ai/settings', { chat_provider_id: r.data.provider.id }); await load(); }
    if (kind === 'chatgpt') openLoginModal(r.data.provider.id);
});

// ---- Modal đăng nhập ChatGPT ----
function openLoginModal(providerId) {
    loginProviderId = providerId;
    $('lmUrl').value = ''; $('lmError').style.display = 'none'; $('lmOk').style.display = 'none'; $('lmStatus').textContent = '';
    $('loginModal').style.display = 'flex';
}
$('lmCancel').addEventListener('click', () => { $('loginModal').style.display = 'none'; clearInterval(loginPoll); post('/app/ai/chatgpt/login/cancel').catch(() => {}); });
$('lmOpen').addEventListener('click', async () => {
    $('lmError').style.display = 'none';
    const r = await post('/app/ai/chatgpt/login/start', { provider_id: loginProviderId });
    if (!r.success) { $('lmError').textContent = r.error?.message || 'Lỗi'; $('lmError').style.display = 'block'; return; }
    window.open(r.data.authorize_url, '_blank');
    $('lmStatus').textContent = r.data.mode === 'local' ? 'Đang chờ trình duyệt gọi về máy chủ (chế độ callback local)...' : 'Đã mở tab đăng nhập. Sau khi đăng nhập, copy URL callback dán vào ô dưới.';
    if (r.data.mode === 'local') {
        clearInterval(loginPoll);
        loginPoll = setInterval(async () => {
            const st = await api('/app/ai/chatgpt/login/status');
            if (st.data?.status === 'success') { clearInterval(loginPoll); $('lmOk').textContent = '✅ Đăng nhập thành công ' + (st.data.email || ''); $('lmOk').style.display = 'block'; await load(); }
            else if (st.data?.status === 'failed' || st.data?.status === 'expired') { clearInterval(loginPoll); $('lmError').textContent = st.data.error || 'Đăng nhập thất bại / hết hạn'; $('lmError').style.display = 'block'; }
        }, 2500);
    }
});
$('lmComplete').addEventListener('click', async () => {
    $('lmError').style.display = 'none';
    const url = $('lmUrl').value.trim();
    if (!url) { $('lmError').textContent = 'Dán URL callback trước.'; $('lmError').style.display = 'block'; return; }
    $('lmComplete').disabled = true; $('lmComplete').textContent = 'Đang xử lý...';
    try {
        const r = await post('/app/ai/chatgpt/login/complete', { provider_id: loginProviderId, callback_url: url });
        if (!r.success) { $('lmError').textContent = r.error?.message || 'Lỗi'; $('lmError').style.display = 'block'; return; }
        $('lmOk').textContent = `✅ Đăng nhập thành công${r.data.email ? ' — ' + r.data.email : ''}. Model chat: ${r.data.provider.chat_model || 'chọn trong bảng'}`;
        $('lmOk').style.display = 'block';
        await load();
        if (!data.settings.chat_provider_id) { await put('/app/ai/settings', { chat_provider_id: loginProviderId }); await load(); }
    } catch (e) {
        $('lmError').textContent = 'Lỗi không mong đợi: ' + (e?.message || e); $('lmError').style.display = 'block';
    } finally {
        $('lmComplete').disabled = false; $('lmComplete').textContent = 'Hoàn tất đăng nhập';
    }
});

// ============ Instruction ============
function fillInstruction() {
    const s = data.settings;
    $('f_assistant_name').value = s.assistant_name;
    $('f_language').value = s.language;
    $('f_instruction').value = s.instruction;
    $('instructionCount').textContent = s.instruction.length;
    $('f_unknown_answer').value = s.unknown_answer;
    $('f_reply_max_chars').value = s.reply_max_chars;
    $('f_disclose_ai').checked = !!s.disclose_ai;
}
$('f_instruction').addEventListener('input', () => { $('instructionCount').textContent = $('f_instruction').value.length; });
$('btnSaveInstruction').addEventListener('click', async () => {
    const r = await put('/app/ai/settings', {
        assistant_name: $('f_assistant_name').value.trim(), language: $('f_language').value, instruction: $('f_instruction').value,
        unknown_answer: $('f_unknown_answer').value.trim(), reply_max_chars: num('f_reply_max_chars'), disclose_ai: $('f_disclose_ai').checked,
    });
    toast(r.success ? '✅ Đã lưu instruction' : '❌ ' + (r.error?.message || 'Lỗi'));
    if (r.success) await load();
});

// ---- Thử nhanh ----
function addTestBubble(cls, html) {
    const el = document.createElement('div');
    el.className = 'bubble ' + cls;
    el.innerHTML = html;
    $('testLog').appendChild(el);
    $('testLog').scrollTop = $('testLog').scrollHeight;
    return el;
}
async function sendTest() {
    const text = $('testInput').value.trim();
    if (!text && !testImage) return;
    addTestBubble('user', esc(text) + (testImage ? `<img src="${testImage}">` : ''));
    $('testInput').value = '';
    const thinking = addTestBubble('meta', '⏳ AI đang trả lời...');
    $('btnTestSend').disabled = true;
    try {
        const r = await post('/app/ai/test', { message: text, image_base64: testImage, history: testHistory });
        thinking.remove();
        if (!r.success) { addTestBubble('meta', '❌ ' + esc(r.error?.message || 'Lỗi')); return; }
        const d = r.data;
        addTestBubble('ai', esc(d.reply || '(AI không trả text)') + (d.images || []).map(src => `<img src="${src}">`).join(''));
        const tools = (d.tool_calls || []).map(t => `${t.name}${t.ok ? '' : ' ✖'}`).join(', ');
        $('testMeta').textContent = `${d.provider.kind}/${d.provider.model} · ${d.latency_ms} ms · ${d.usage.inputTokens}+${d.usage.outputTokens} tokens${tools ? ' · tools: ' + tools : ''}`;
        testHistory.push({ role: 'user', content: text || '(gửi ảnh)' });
        if (d.reply) testHistory.push({ role: 'assistant', content: d.reply });
    } catch (e) { thinking.remove(); addTestBubble('meta', '❌ Lỗi kết nối'); }
    finally { $('btnTestSend').disabled = false; clearTestImage(); $('testInput').focus(); }
}
function clearTestImage() { testImage = null; $('testImgPreview').style.display = 'none'; $('testFile').value = ''; }
$('btnTestSend').addEventListener('click', sendTest);
$('testInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTest(); } });
$('btnTestClear').addEventListener('click', () => { testHistory = []; $('testLog').innerHTML = '<div class="bubble meta">Đã xóa. Bắt đầu hội thoại thử mới.</div>'; $('testMeta').textContent = ''; });
$('btnTestAttach').addEventListener('click', () => $('testFile').click());
$('btnTestRemoveImg').addEventListener('click', clearTestImage);
$('testFile').addEventListener('change', () => {
    const f = $('testFile').files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('❌ Ảnh tối đa 8MB'); return; }
    const reader = new FileReader();
    reader.onload = () => { testImage = reader.result; $('testImgPreviewEl').src = reader.result; $('testImgPreview').style.display = 'flex'; };
    reader.readAsDataURL(f);
});

// ============ Phạm vi ============
const DAY_LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
function fillScope() {
    const s = data.settings;
    document.querySelector(`input[name=dm_mode][value=${s.dm_mode}]`).checked = true;
    document.querySelector(`input[name=group_mode][value=${s.group_mode}]`).checked = true;
    $('f_group_quote_reply').checked = !!s.group_quote_reply;
    wlSelected = new Set(s.group_whitelist || []);
    $('wlCount').textContent = wlSelected.size;
    const ah = s.active_hours;
    $('f_hours_enabled').checked = !!ah;
    $('f_hours_from').value = ah?.ranges?.[0]?.[0] || '18:00';
    $('f_hours_to').value = ah?.ranges?.[0]?.[1] || '08:00';
    const days = ah?.days?.length ? ah.days : [0, 1, 2, 3, 4, 5, 6];
    $('hoursDays').innerHTML = DAY_LABELS.map((l, i) => `<label style="display:flex; gap:4px; align-items:center; font-size:13px"><input type="checkbox" data-day="${i}" ${days.includes(i) ? 'checked' : ''}>${l}</label>`).join('');
    $('hoursRow').style.opacity = ah ? 1 : 0.5;
    $('f_new_session_reply').value = s.new_session_reply;
    $('f_non_text_reply').value = s.non_text_reply;
    $('f_error_reply').value = s.error_reply;
    if (groups.length) renderWhitelist();
}
$('f_hours_enabled').addEventListener('change', () => { $('hoursRow').style.opacity = $('f_hours_enabled').checked ? 1 : 0.5; });
async function loadGroups() {
    const r = await api('/app/threads?type=group');
    groups = r.data?.threads || [];
    renderWhitelist();
}
function renderWhitelist() {
    const q = $('wlSearch').value.trim().toLowerCase();
    const list = groups.filter(g => !q || (g.name || '').toLowerCase().includes(q) || g.thread_id.includes(q)).slice(0, 300);
    $('wlList').innerHTML = list.map(g => `<label><input type="checkbox" data-gid="${esc(g.thread_id)}" ${wlSelected.has(g.thread_id) ? 'checked' : ''}><span>${esc(g.name || '(Chưa có tên)')}</span><span class="hint mono" style="margin:0 0 0 auto">${esc(g.thread_id)}</span></label>`).join('') || '<div class="hint">Không có nhóm nào.</div>';
    $('wlList').querySelectorAll('input[data-gid]').forEach(cb => cb.addEventListener('change', () => {
        if (cb.checked) wlSelected.add(cb.dataset.gid); else wlSelected.delete(cb.dataset.gid);
        $('wlCount').textContent = wlSelected.size;
    }));
}
$('wlSearch').addEventListener('input', renderWhitelist);
$('btnSaveScope').addEventListener('click', async () => {
    let active_hours = null;
    if ($('f_hours_enabled').checked) {
        const days = [...$('hoursDays').querySelectorAll('input:checked')].map(c => Number(c.dataset.day));
        active_hours = { tz: 'Asia/Ho_Chi_Minh', ranges: [[$('f_hours_from').value.trim(), $('f_hours_to').value.trim()]], days };
    }
    const r = await put('/app/ai/settings', {
        dm_mode: document.querySelector('input[name=dm_mode]:checked').value,
        group_mode: document.querySelector('input[name=group_mode]:checked').value,
        group_quote_reply: $('f_group_quote_reply').checked,
        group_whitelist: [...wlSelected],
        active_hours,
        new_session_reply: $('f_new_session_reply').value.trim(),
        non_text_reply: $('f_non_text_reply').value.trim(),
        error_reply: $('f_error_reply').value.trim(),
    });
    toast(r.success ? '✅ Đã lưu phạm vi' : '❌ ' + (r.error?.message || 'Lỗi'));
    if (r.success) await load();
});

// ============ Tools ============
function renderTools() {
    $('toolList').innerHTML = (data.tools || []).map(t => `
        <div class="stat-card" style="margin-bottom:10px; display:flex; gap:14px; align-items:flex-start">
            <label class="switch" style="margin-top:2px"><input type="checkbox" data-tool="${esc(t.setting_key || '')}" ${t.enabled ? 'checked' : ''} ${t.toggleable ? '' : 'disabled'}><span class="track"></span></label>
            <div style="flex:1"><div style="font-weight:700">${esc(t.label)} <span class="mono hint" style="margin:0">${esc(t.name)}</span> ${t.toggleable ? '' : '<span class="tag muted">LUÔN BẬT</span>'} ${t.enabled && !t.available ? `<span class="tag warn">KHÔNG KHẢ DỤNG</span>` : ''}</div>
            <div class="hint">${esc(t.description)}${t.reason ? ` <b style="color:#b26a00">— ${esc(t.reason)}</b>` : ''}</div></div>
        </div>`).join('');
}
$('btnSaveTools').addEventListener('click', async () => {
    const tools = {};
    $('toolList').querySelectorAll('input[data-tool]').forEach(cb => { if (cb.dataset.tool) tools[cb.dataset.tool] = cb.checked; });
    const r = await put('/app/ai/settings', { tools });
    toast(r.success ? '✅ Đã lưu tools' : '❌ ' + (r.error?.message || 'Lỗi'));
    if (r.success) await load();
});

// ============ Nâng cao ============
const ADV_FIELDS = ['debounce_ms', 'human_pause_minutes', 'cooldown_seconds', 'daily_limit_per_thread', 'global_concurrency', 'history_limit', 'history_max_age_hours', 'image_history_limit', 'max_tokens', 'temperature', 'max_tool_rounds', 'turn_timeout_ms', 'image_timeout_ms'];
function fillAdvanced() {
    const s = data.settings;
    for (const k of ADV_FIELDS) $('f_' + k).value = s[k];
    $('f_reasoning_effort').value = s.reasoning_effort;
    $('f_delay_min').value = s.humanize_delay_ms[0]; $('f_delay_max').value = s.humanize_delay_ms[1];
    $('f_vision_enabled').checked = !!s.vision_enabled;
    $('f_image_hosts').value = (s.image_hosts || []).join(', ');
}
$('btnSaveAdvanced').addEventListener('click', async () => {
    const patch = {};
    for (const k of ADV_FIELDS) patch[k] = num('f_' + k);
    patch.reasoning_effort = $('f_reasoning_effort').value;
    patch.humanize_delay_ms = [num('f_delay_min'), Math.max(num('f_delay_min'), num('f_delay_max'))];
    patch.vision_enabled = $('f_vision_enabled').checked;
    patch.image_hosts = $('f_image_hosts').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const r = await put('/app/ai/settings', patch);
    toast(r.success ? '✅ Đã lưu nâng cao' : '❌ ' + (r.error?.message || 'Lỗi'));
    if (r.success) await load();
});

// ============ Nhật ký ============
function logRow(l, names) {
    const tools = JSON.parse(l.tool_calls || '[]');
    return `<tr class="log-row" data-log="${l.id}"><td>${fmtTime(l.created_at)}</td><td>${esc(names[l.thread_id] || '')}<div class="hint mono" style="margin:0">${esc(l.thread_id)}</div></td><td>${statusTag(l)}</td><td>${esc(l.provider_kind || '')}${l.model ? '<div class="hint" style="margin:0">' + esc(l.model) + '</div>' : ''}</td><td>${l.input_tokens || l.output_tokens ? `${l.input_tokens}+${l.output_tokens}` : ''}</td><td>${l.latency_ms || ''}</td><td>${tools.map(t => esc(t.name) + (t.ok ? '' : ' ✖')).join(', ')}</td><td class="hint" style="margin:0; max-width:320px">${esc((l.reply_preview || l.error || '').slice(0, 120))}</td></tr>
    <tr class="log-detail" id="logd${l.id}" style="display:none"><td colspan="8"><pre>${esc(JSON.stringify({ trigger_msg_id: l.trigger_msg_id, skip_reason: l.skip_reason, tools, reply_preview: l.reply_preview, error: l.error }, null, 2))}</pre></td></tr>`;
}
async function loadLogs(reset) {
    if (reset) logsOldest = 0;
    const q = new URLSearchParams({ thread_id: $('logThread').value.trim(), status: $('logStatus').value, limit: '50', before_id: String(logsOldest) });
    const r = await api('/app/ai/logs?' + q);
    if (!r.success) return;
    const tb = $('logTable').querySelector('tbody');
    const html = r.data.logs.map(l => logRow(l, r.data.thread_names)).join('');
    if (reset) tb.innerHTML = html || '<tr><td colspan="8" class="hint">Không có nhật ký.</td></tr>'; else tb.insertAdjacentHTML('beforeend', html);
    if (r.data.logs.length) logsOldest = r.data.logs[r.data.logs.length - 1].id;
    $('btnLogMore').style.display = r.data.logs.length >= 50 ? 'inline-block' : 'none';
    tb.querySelectorAll('.log-row').forEach(row => row.addEventListener('click', () => { const d = $('logd' + row.dataset.log); d.style.display = d.style.display === 'none' ? 'table-row' : 'none'; }));
}
$('btnLogRefresh').addEventListener('click', () => loadLogs(true));
$('btnLogMore').addEventListener('click', () => loadLogs(false));
$('logStatus').addEventListener('change', () => loadLogs(true));

// ============ Công tắc tổng ============
$('masterSwitch').addEventListener('change', async () => {
    const on = $('masterSwitch').checked;
    if (on && !data.settings.chat_provider_id) { toast('⚠️ Chưa chọn provider chat — vào tab Provider trước'); $('masterSwitch').checked = false; return; }
    const r = await put('/app/ai/settings', { enabled: on });
    toast(r.success ? (on ? '🟢 AI đã BẬT — sẽ trả lời tin mới' : '⚪ AI đã tắt') : '❌ ' + (r.error?.message || 'Lỗi'));
    await load();
});

// ============ SSE: cập nhật nhật ký realtime ============
function connectSSE() {
    const es = new EventSource('/app/events');
    es.addEventListener('ai_log', () => { if ($('tab-logs').classList.contains('active')) loadLogs(true); if ($('tab-overview').classList.contains('active')) renderOverview(); });
    es.addEventListener('ai_handoff', (e) => { const d = JSON.parse(e.data); toast('🙋 AI chuyển cho nhân viên: ' + d.thread_id); });
    es.addEventListener('ai_error', (e) => { const d = JSON.parse(e.data); toast('⚠️ AI lỗi: ' + String(d.message || '').slice(0, 100)); });
    es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
}

$('btnLogout').addEventListener('click', async () => { await api('/app/logout', { method: 'POST' }); location.href = '/login.html'; });

// ============ Init ============
(async function init() {
    try {
        const me = await api('/app/me');
        if (me.success) document.title = 'Trợ lý AI — ' + me.data.app_name;
        await load();
    } catch (e) { return; }
    connectSSE();
    const tab = location.hash.replace('#', '');
    if (tab && $('tab-' + tab)) $('tabs').querySelector(`[data-tab="${tab}"]`).click();
})();
})();

// =============================================
// Zalo Inbox — trang Cài đặt & API
// =============================================
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
let me = null;

async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
    return res.json();
}

function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function fmtTime(ts) {
    return ts ? new Date(Number(ts)).toLocaleString('vi-VN') : '—';
}

// ============ Kênh Zalo ============
async function loadZaloInfo() {
    const json = await api('/app/me');
    if (!json.success) return;
    me = json.data.user;
    $('brandName').textContent = json.data.app_name;
    const z = json.data.zalo;
    const el = $('zaloInfo');
    if (z.connected) {
        el.innerHTML = `
            <div class="zalo-profile">
                ${z.avatar_url ? `<img src="${esc(z.avatar_url)}">` : '<div class="avatar">👤</div>'}
                <div style="flex:1">
                    <div style="font-weight:700">${esc(z.display_name)} <span class="tag on">ĐANG KẾT NỐI</span></div>
                    <div class="mono hint">Zalo ID: ${esc(z.zalo_id || '')} ${z.phone ? '· SĐT: ' + esc(z.phone) : ''}</div>
                    <div class="hint">Listener: ${z.listening ? '✅ đang nhận tin' : '⚠️ không hoạt động'} ${z.proxy ? '· Proxy: ' + esc(z.proxy) : ''}</div>
                </div>
                <button class="btn btn-light" id="btnSyncContacts">📇 Đồng bộ danh bạ</button>
                <button class="btn btn-danger" id="btnDisconnect">Ngắt kết nối</button>
            </div>`;
        $('btnDisconnect').addEventListener('click', async () => {
            if (!confirm('Ngắt kết nối kênh Zalo? Sẽ phải quét QR lại để dùng tiếp.')) return;
            await api('/app/zalo/logout', { method: 'POST' });
            loadZaloInfo();
        });
        $('btnSyncContacts').addEventListener('click', async () => {
            toast('📇 Đang đồng bộ...');
            const r = await api('/app/zalo/sync', { method: 'POST' });
            toast(r.success ? `✅ Import ${r.data.friends} bạn, ${r.data.groups} nhóm` : '❌ ' + (r.error?.message || 'Lỗi'));
        });
    } else {
        el.innerHTML = `
            <div class="zalo-profile">
                <div class="avatar">📵</div>
                <div style="flex:1">
                    <div style="font-weight:700">Chưa kết nối <span class="tag off">OFFLINE</span></div>
                    <div class="hint">${z.zalo_id ? 'Phiên của ' + esc(z.display_name) + ' đã hết hạn.' : 'Chưa có kênh Zalo nào.'} Về trang Inbox để quét QR kết nối.</div>
                </div>
                <a href="/" class="btn btn-primary" style="text-decoration:none">Về Inbox để kết nối</a>
            </div>`;
    }
}

// ============ API Keys ============
async function loadMcp() {
    try {
        const [connections, activity] = await Promise.all([api('/app/mcp/connections'), api('/app/mcp/activity')]);
        if (!connections.success || !activity.success) throw new Error('Không tải được thông tin MCP');
        $('mcpUrl').value = connections.data.url;
        const body = $('mcpConnections').querySelector('tbody');
        body.innerHTML = connections.data.connections.map(c => `<tr><td>${esc(c.client_name)}<div class="hint">${c.redirect_origins.map(esc).join('<br>')}</div></td><td>${c.scopes.map(s => s === 'zalo:send' ? 'Gửi tin' : 'Xem danh sách').join(', ')}</td><td>${fmtTime(c.last_used_at)}</td><td>${c.revoked_at ? 'Đã thu hồi' : 'Đã cấp quyền'}</td><td>${c.revoked_at ? '' : `<button class="btn btn-danger btn-sm" data-revoke-mcp="${esc(c.id)}">Thu hồi</button>`}</td></tr>`).join('') || '<tr><td colspan="5">Chưa có ứng dụng AI nào được bạn cấp quyền.</td></tr>';
        body.querySelectorAll('[data-revoke-mcp]').forEach(button => button.addEventListener('click', async () => {
            if (!confirm('Thu hồi quyền của kết nối AI này?')) return;
            const r = await api('/app/mcp/connections/' + encodeURIComponent(button.dataset.revokeMcp), {method:'DELETE',headers:{'X-MCP-Settings':'1'}});
            toast(r.success ? 'Đã thu hồi kết nối' : 'Không thể thu hồi kết nối');
            loadMcp();
        }));
        const labels = {sent:'Đã gửi',pending:'Đang xử lý',failed:'Thất bại trước khi gửi',unknown:'Chưa rõ kết quả — kiểm tra inbox'};
        $('mcpActivity').querySelector('tbody').innerHTML = activity.data.activity.map(a => `<tr><td>${fmtTime(a.created_at)}<div class="hint">${esc(a.client_name || '')}</div></td><td class="mono">${esc(a.recipient)}</td><td class="mono">${esc(a.request_id)}</td><td>${labels[a.status] || esc(a.status)}</td></tr>`).join('') || '<tr><td colspan="4">Chưa có lượt gửi qua MCP.</td></tr>';
    } catch (e) { toast(e.message || 'Không tải được MCP'); }
}
$('btnCopyMcp').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('mcpUrl').value); toast('Đã sao chép link MCP'); }
    catch { $('mcpUrl').select(); toast('Chọn và sao chép link trong ô'); }
});
$('btnRefreshMcp').addEventListener('click', loadMcp);

async function loadKeys() {
    const json = await api('/app/api-keys');
    if (!json.success) return;
    const tbody = $('keysTable').querySelector('tbody');
    if (json.data.keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-sub)">Chưa có API key nào — tạo key đầu tiên bên dưới.</td></tr>';
        return;
    }
    tbody.innerHTML = json.data.keys.map(k => `
        <tr>
            <td>${esc(k.name)}</td>
            <td class="mono">
                <span class="key-masked" data-key="${esc(k.api_key)}">${esc(k.api_key.slice(0, 10))}...${esc(k.api_key.slice(-4))}</span>
                <button class="copy-btn" data-copy="${esc(k.api_key)}">📋</button>
            </td>
            <td><span class="tag ${k.is_active ? 'on' : 'off'}">${k.is_active ? 'ACTIVE' : 'TẮT'}</span></td>
            <td>${fmtTime(k.last_used_at)}</td>
            <td style="white-space:nowrap">
                <button class="btn btn-light btn-sm" data-toggle="${k.id}">${k.is_active ? 'Tắt' : 'Bật'}</button>
                <button class="btn btn-danger btn-sm" data-del="${k.id}">Xóa</button>
            </td>
        </tr>
    `).join('');

    tbody.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
        navigator.clipboard.writeText(b.dataset.copy);
        toast('📋 Đã copy API key');
    }));
    tbody.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
        await api(`/app/api-keys/${b.dataset.toggle}/toggle`, { method: 'POST' });
        loadKeys();
    }));
    tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Xóa API key này? Hệ thống đang dùng key sẽ bị lỗi.')) return;
        await api(`/app/api-keys/${b.dataset.del}`, { method: 'DELETE' });
        loadKeys();
    }));
}

// ============ API Docs ============
function renderApiDocs() {
    const base = location.origin;
    $('baseUrl').textContent = base + '/api/v1';
    const docs = [
        {
            method: 'POST', path: '/api/v1/send',
            title: 'Gửi tin nhắn theo ID — tự nhận biết cá nhân/nhóm',
            desc: 'Truyền thread_id (ID cá nhân hoặc ID nhóm), hệ thống tự xác định loại để gửi đúng nơi. Gửi được text và hình (URL hoặc base64).',
            example: `curl -X POST ${base}/api/v1/send \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "1234567890",
    "message": "Xin chào từ API!"
  }'

# Gửi hình kèm chú thích:
curl -X POST ${base}/api/v1/send \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "1234567890",
    "image_url": "https://example.com/anh.jpg",
    "caption": "Ảnh sản phẩm"
  }'`,
            response: `{
  "success": true,
  "data": {
    "to": "1234567890",
    "thread_type": "user",   // tự nhận biết: "user" | "group"
    "message_id": "..."
  }
}`,
        },
        {
            method: 'POST', path: '/api/v1/send-phone',
            title: 'Gửi tin nhắn đến số điện thoại (text, hình)',
            desc: 'Tìm user Zalo theo SĐT rồi gửi tin. image_url nhận URL http(s) hoặc base64 data URI.',
            example: `curl -X POST ${base}/api/v1/send-phone \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "phone": "0912345678",
    "message": "Xin chào!"
  }'`,
            response: `{
  "success": true,
  "data": {
    "user_found": { "uid": "...", "display_name": "...", "avatar_url": "..." },
    "message_id": "..."
  }
}`,
        },
        {
            method: 'GET', path: '/api/v1/search',
            title: 'Tìm hội thoại theo tên — ghi rõ cá nhân hay nhóm',
            desc: 'Tìm trong danh bạ + hội thoại đã có. Query: name (bắt buộc), type=user|group (lọc, tùy chọn), limit.',
            example: `curl "${base}/api/v1/search?name=Minh" \\
  -H "X-API-Key: YOUR_API_KEY"`,
            response: `{
  "success": true,
  "data": {
    "total": 2,
    "results": [
      { "thread_id": "111", "type": "user",  "name": "Nguyễn Văn Minh", "phone": "0912...", "is_contact": true },
      { "thread_id": "222", "type": "group", "name": "Nhóm Minh Marketing", "phone": "", "is_contact": true }
    ]
  }
}`,
        },
        {
            method: 'GET', path: '/api/v1/find-phone',
            title: 'Tìm user Zalo theo SĐT (không gửi tin)',
            desc: 'Query: phone.',
            example: `curl "${base}/api/v1/find-phone?phone=0912345678" \\
  -H "X-API-Key: YOUR_API_KEY"`,
            response: `{
  "success": true,
  "data": { "found": true, "user": { "uid": "...", "display_name": "...", "avatar_url": "..." } }
}`,
        },
        {
            method: 'GET', path: '/api/v1/status',
            title: 'Trạng thái kênh Zalo',
            desc: 'Kiểm tra kênh có đang kết nối không.',
            example: `curl "${base}/api/v1/status" -H "X-API-Key: YOUR_API_KEY"`,
            response: `{
  "success": true,
  "data": { "connected": true, "zalo_id": "...", "display_name": "...", "listening": true }
}`,
        },
    ];

    $('apiDocs').innerHTML = docs.map((d, i) => `
        <div class="api-doc" id="doc${i}">
            <div class="api-doc-head" data-doc="${i}">
                <span class="method ${d.method.toLowerCase()}">${d.method}</span>
                <span class="mono">${d.path}</span>
                <span style="flex:1; color:var(--text-sub); text-align:right; font-size:12px">${d.title}</span>
            </div>
            <div class="api-doc-body">
                <p class="hint">${d.desc}</p>
                <div style="font-weight:600; margin-top:8px">Ví dụ:</div>
                <pre>${esc(d.example)}</pre>
                <div style="font-weight:600">Response:</div>
                <pre>${esc(d.response)}</pre>
            </div>
        </div>
    `).join('');

    document.querySelectorAll('.api-doc-head').forEach(h => {
        h.addEventListener('click', () => $('doc' + h.dataset.doc).classList.toggle('open'));
    });
}

// ============ Users ============
async function loadUsers() {
    const json = await api('/app/users');
    if (!json.success) return;
    const tbody = $('usersTable').querySelector('tbody');
    tbody.innerHTML = json.data.users.map(u => `
        <tr>
            <td>${esc(u.username)} ${me && u.id === me.id ? '<span class="tag on">BẠN</span>' : ''}</td>
            <td>${esc(u.display_name || '')}</td>
            <td>${esc(u.role)}</td>
            <td>${me && u.id !== me.id ? `<button class="btn btn-danger btn-sm" data-deluser="${u.id}">Xóa</button>` : ''}</td>
        </tr>
    `).join('');
    tbody.querySelectorAll('[data-deluser]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Xóa user này?')) return;
        const r = await api(`/app/users/${b.dataset.deluser}`, { method: 'DELETE' });
        if (!r.success) toast('❌ ' + (r.error?.message || 'Lỗi'));
        loadUsers();
    }));
}

// ============ Events ============
$('btnLogout').addEventListener('click', async () => {
    await api('/app/logout', { method: 'POST' });
    location.href = '/login.html';
});

$('btnCreateKey').addEventListener('click', async () => {
    const name = $('newKeyName').value.trim();
    if (!name) { toast('Nhập tên cho key'); return; }
    const json = await api('/app/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
    if (json.success) {
        $('newKeyName').value = '';
        prompt('API Key mới (copy ngay, key hiển thị đầy đủ trong bảng):', json.data.api_key);
        loadKeys();
    } else {
        toast('❌ ' + (json.error?.message || 'Lỗi'));
    }
});

$('btnCreateUser').addEventListener('click', async () => {
    const username = $('newUsername').value.trim();
    const password = $('newUserPass').value;
    if (!username || !password) { toast('Nhập username + mật khẩu'); return; }
    const json = await api('/app/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, display_name: $('newUserDisplay').value.trim() }),
    });
    if (json.success) {
        toast('✅ Đã tạo user ' + username);
        $('newUsername').value = ''; $('newUserPass').value = ''; $('newUserDisplay').value = '';
        loadUsers();
    } else {
        toast('❌ ' + (json.error?.message || 'Lỗi'));
    }
});

$('btnChangeMyPass').addEventListener('click', async () => {
    const password = $('myNewPass').value;
    if (!password) { toast('Nhập mật khẩu mới'); return; }
    const json = await api(`/app/users/${me.id}/password`, { method: 'POST', body: JSON.stringify({ password }) });
    if (json.success) { toast('✅ Đã đổi mật khẩu'); $('myNewPass').value = ''; }
    else toast('❌ ' + (json.error?.message || 'Lỗi'));
});

// ============ Init ============
(async function init() {
    try { await loadZaloInfo(); } catch (e) { return; }
    renderApiDocs();
    loadKeys();
    loadUsers();
    loadMcp();
})();

})();

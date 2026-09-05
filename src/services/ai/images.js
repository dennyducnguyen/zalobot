// =============================================
// Ảnh: tải ảnh khách gửi (Zalo CDN) → resize (sharp) → data URL cho vision; lưu ảnh AI tạo vào public/uploads/ai/
// Chỉ tải https từ host trong allowlist (settings.image_hosts), chặn IP nội bộ.
// =============================================
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const sharp = require('sharp');
const config = require('../../config');

const MAX_SIDE = 1024;
const MAX_DOWNLOAD = 15 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;

function createImageLoader({ settings, logger }) {
    const cacheDir = path.join(config.ROOT, 'tmp', 'ai-img');
    const uploadsDir = path.join(config.ROOT, 'public', 'uploads', 'ai');

    function hostAllowed(urlStr) {
        let u;
        try { u = new URL(urlStr); } catch { return false; }
        if (u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        if (net.isIP(host)) return false; // không cho IP literal (chặn SSRF nội bộ)
        if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
        const allow = settings.get().image_hosts || [];
        return allow.some(suffix => host === suffix || host.endsWith('.' + suffix));
    }

    async function download(urlStr) {
        const res = await fetch(urlStr, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') || 0);
        if (len > MAX_DOWNLOAD) throw new Error('Ảnh quá lớn');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_DOWNLOAD) throw new Error('Ảnh quá lớn');
        return buf;
    }

    /** Resize cạnh dài ≤ 1024, JPEG q80 → data URL */
    async function toDataUrl(buffer) {
        const out = await sharp(buffer).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
        return `data:image/jpeg;base64,${out.toString('base64')}`;
    }

    function cachePath(key) { return path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.txt'); }

    /**
     * Lấy data URL cho 1 tin nhắn ảnh (content_type photo). Trả null nếu không tải được.
     * @param {{ id:number, content:string, content_type:string }} row
     */
    async function loadMessageImage(row) {
        let obj = {};
        try { obj = JSON.parse(row.content || '{}'); } catch { return null; }
        const src = obj.href || obj.oriUrl || obj.thumb || '';
        if (!src) return null;
        if (!hostAllowed(src)) {
            logger?.warn(`⚠️ [ai] Bỏ qua ảnh — host không trong allowlist: ${src.slice(0, 80)}`);
            return null;
        }
        const cp = cachePath(`${row.id}:${src}`);
        try {
            if (fs.existsSync(cp) && Date.now() - fs.statSync(cp).mtimeMs < CACHE_TTL_MS) return fs.readFileSync(cp, 'utf8');
        } catch { /* bỏ qua cache lỗi */ }
        try {
            const buf = await download(src);
            const dataUrl = await toDataUrl(buf);
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(cp, dataUrl);
            return dataUrl;
        } catch (e) {
            logger?.warn(`⚠️ [ai] Không tải được ảnh tin #${row.id}: ${e.message}`);
            return null;
        }
    }

    /** Ảnh base64 từ UI (thử nhanh) → data URL chuẩn hóa */
    async function normalizeDataUrl(dataUrl) {
        const m = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(String(dataUrl || ''));
        if (!m) throw new Error('Ảnh không đúng định dạng data URL');
        return toDataUrl(Buffer.from(m[1], 'base64'));
    }

    /** Lưu ảnh AI tạo → { href, filePath, dataUrl } */
    function saveGenerated(buffer, mime) {
        fs.mkdirSync(uploadsDir, { recursive: true });
        const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
        const name = `ai_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
        const filePath = path.join(uploadsDir, name);
        fs.writeFileSync(filePath, buffer);
        return { href: `/uploads/ai/${name}`, filePath, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
    }

    /** Dọn cache cũ + ảnh AI cũ hơn 30 ngày */
    function cleanup() {
        const sweep = (dir, maxAge) => {
            if (!fs.existsSync(dir)) return;
            for (const f of fs.readdirSync(dir)) {
                const p = path.join(dir, f);
                try { if (Date.now() - fs.statSync(p).mtimeMs > maxAge) fs.unlinkSync(p); } catch { /* bỏ qua */ }
            }
        };
        sweep(cacheDir, CACHE_TTL_MS);
        sweep(uploadsDir, 30 * 24 * 60 * 60 * 1000);
    }

    return { hostAllowed, loadMessageImage, normalizeDataUrl, saveGenerated, toDataUrl, cleanup };
}

module.exports = { createImageLoader };

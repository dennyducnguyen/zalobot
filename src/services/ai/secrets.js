// =============================================
// Mã hóa secret at-rest (API key, token OAuth) — AES-256-GCM
// Khóa chủ: env AI_SECRET_KEY (base64 32 byte). Thiếu → tự sinh và lưu data/secret.key (mode 600)
// Định dạng lưu DB: v1.<iv b64>.<tag b64>.<ciphertext b64>
// =============================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');

let cachedKey = null;

function keyFilePath() {
    return path.join(path.dirname(config.DB_PATH), 'secret.key');
}

function loadKey() {
    if (cachedKey) return cachedKey;
    let b64 = (config.AI_SECRET_KEY || '').trim();
    if (!b64) {
        const file = keyFilePath();
        if (fs.existsSync(file)) {
            b64 = fs.readFileSync(file, 'utf8').trim();
        } else {
            b64 = crypto.randomBytes(32).toString('base64');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, b64 + '\n', { mode: 0o600 });
            try { fs.chmodSync(file, 0o600); } catch { /* Windows bỏ qua */ }
        }
    }
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('AI_SECRET_KEY phải là base64 của đúng 32 byte (tạo bằng: openssl rand -base64 32)');
    cachedKey = key;
    return key;
}

function encryptSecret(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

function decryptSecret(encoded) {
    const parts = String(encoded || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Định dạng secret không hợp lệ');
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

// Che key/token trong message lỗi trước khi log hoặc trả UI
function maskSecrets(text) {
    return String(text || '')
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…')
        .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-…')
        .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer …')
        .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ…');
}

module.exports = { encryptSecret, decryptSecret, maskSecrets, keyFilePath, _resetKeyCache: () => { cachedKey = null; } };

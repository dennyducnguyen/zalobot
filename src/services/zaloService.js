// =============================================
// Zalo Service — quản lý 1 KÊNH Zalo cá nhân duy nhất
// Kế thừa toàn bộ kinh nghiệm từ zalochat (zca-js):
// - imageMetadataGetter bắt buộc, key "size"
// - Windows path backslash → forward slash
// - loginQR(options, callback), callback types 0-4
// - selfListen=true để bắt tin đi từ app
// - HttpsProxyAgent + native fetch cho proxy
// Khác zalochat: LƯU tin nhắn vào SQLite + emit event cho UI realtime
// =============================================
const { Zalo, ThreadType } = require('zca-js');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const sharp = require('sharp');

const store = require('../db');
const logger = require('./logger');
const config = require('../config');

// Hàm lấy metadata ảnh (bắt buộc của zca-js) — key phải là "size", KHÔNG phải "totalSize"
async function imageMetadataGetter(filePath) {
    const data = await fs.promises.readFile(filePath);
    const metadata = await sharp(data).metadata();
    return { width: metadata.width, height: metadata.height, size: data.length };
}

// zca-js dùng filePath.split("/") lấy filename → Windows phải convert \ sang /
function normalizePath(filePath) {
    return filePath.replace(/\\/g, '/');
}

function createZaloOptions(proxy = null) {
    const options = {
        logging: false,
        imageMetadataGetter,
        // Bắt cả tin nhắn do chính mình gửi (isSelf=true) để hiển thị trong inbox
        selfListen: true,
    };
    if (proxy) {
        try {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            // KHÔNG ghi đè polyfill — native fetch hỗ trợ getSetCookie() nên cookies login parse đúng
            options.agent = new HttpsProxyAgent(proxy);
            logger.info(`🌐 Proxy được cấu hình: ${maskProxy(proxy)}`);
        } catch (e) {
            logger.warn('⚠️ Không thể khởi tạo proxy agent:', e.message);
        }
    }
    return options;
}

function maskProxy(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        const url = new URL(proxyUrl);
        if (url.password) url.password = '***';
        return url.toString();
    } catch { return proxyUrl; }
}

// =============================================
// ZaloChannel — singleton, 1 kênh Zalo duy nhất
// Emit events: 'message' (tin mới đã lưu DB), 'status' (connected/disconnected)
// =============================================
class ZaloChannel extends EventEmitter {
    constructor() {
        super();
        this.zalo = null;
        this.api = null;
        this.zaloId = null;
        this.isLoggedIn = false;
        this.isListening = false;
        this.userInfo = null;       // { displayName, zaloId, avatarUrl, phone }
        this.proxy = null;
        this.loggedInAt = null;
        // Map<loginId, { status, error, ... }> — phiên QR đang chờ
        this.pendingLogins = new Map();
        // msgId đã gửi qua server (web/api) — listener bỏ qua để không lưu trùng
        this._sentMsgIds = new Set();
        // Cache RAM tập group-ID (TTL 5 phút)
        this._groupIdSetCache = { ids: null, at: 0 };
    }

    static get GROUP_SET_TTL() { return 5 * 60 * 1000; }

    // ==========================================
    // Trạng thái kênh
    // ==========================================
    status() {
        const session = store.zaloSession.get();
        return {
            connected: this.isLoggedIn,
            listening: this.isListening,
            zalo_id: this.zaloId || session?.zalo_id || null,
            display_name: this.userInfo?.displayName || session?.display_name || '',
            avatar_url: this.userInfo?.avatarUrl || session?.avatar_url || '',
            phone: this.userInfo?.phone || session?.phone || '',
            proxy: maskProxy(this.proxy),
            logged_in_at: this.loggedInAt,
            session_status: session?.status || null,
        };
    }

    async fetchUserInfo() {
        try {
            const accountInfo = await this.api.fetchAccountInfo();
            const profile = accountInfo.profile || accountInfo;
            this.userInfo = {
                displayName: profile.displayName || profile.zaloName || profile.dName || 'Zalo User',
                zaloId: profile.userId || profile.uid || null,
                avatarUrl: profile.avatar || null,
                phone: profile.phoneNumber || profile.phone || null,
            };
            if (!this.zaloId && this.userInfo.zaloId) this.zaloId = this.userInfo.zaloId;
            return this.userInfo;
        } catch (e) {
            logger.warn('⚠️ Không lấy được thông tin tài khoản:', e.message);
            if (!this.userInfo) this.userInfo = { displayName: 'Zalo User', zaloId: this.zaloId, avatarUrl: null, phone: null };
            return this.userInfo;
        }
    }

    async checkConnectionAlive() {
        if (!this.api || !this.isLoggedIn) return { alive: false, error: 'Kênh chưa kết nối' };
        try {
            await this.api.fetchAccountInfo();
            return { alive: true, error: null };
        } catch (err) {
            return { alive: false, error: err.message || String(err) };
        }
    }

    // ==========================================
    // QR Login
    // ==========================================
    async startQRLogin(proxy = null) {
        const loginId = uuidv4();
        const qrFilePath = path.join(config.ROOT, 'public', `qr_${loginId}.png`);
        const useProxy = proxy || config.ZALO_PROXY || null;

        this.pendingLogins.set(loginId, {
            status: 'waiting', // waiting → scanned → success / failed
            error: null,
            createdAt: Date.now(),
        });

        // Chạy bất đồng bộ — client polling qua getLoginStatus
        this._processQRLogin(loginId, qrFilePath, useProxy).catch(err => {
            logger.login.error(`❌ [login:${loginId}] QR Login thất bại:`, err.message);
            const pending = this.pendingLogins.get(loginId);
            if (pending) {
                pending.status = 'failed';
                pending.error = err.message;
            }
            try { if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath); } catch (e) { /* bỏ qua */ }
        });

        return { loginId };
    }

    async _processQRLogin(loginId, qrFilePath, proxy) {
        const zalo = new Zalo(createZaloOptions(proxy));
        let capturedCredentials = null;
        const pending = this.pendingLogins.get(loginId);

        let expiredRetryCount = 0;
        const MAX_EXPIRED_RETRIES = 3;
        let declinedRetryCount = 0;
        const MAX_DECLINED_RETRIES = 2;

        const callback = (event) => {
            switch (event.type) {
                case 0: // QRCodeGenerated
                    logger.login.info(`📱 [login:${loginId}] QR Code đã được tạo`);
                    if (event.actions?.saveToFile) event.actions.saveToFile(qrFilePath);
                    break;
                case 1: // QRCodeExpired
                    expiredRetryCount++;
                    if (expiredRetryCount > MAX_EXPIRED_RETRIES) {
                        if (pending) { pending.status = 'failed'; pending.error = 'QR hết hạn nhiều lần, vui lòng tạo mã mới'; }
                        if (event.actions?.abort) event.actions.abort();
                        return;
                    }
                    if (pending) pending.status = 'waiting';
                    if (event.actions?.retry) event.actions.retry();
                    break;
                case 2: // QRCodeScanned
                    logger.login.info(`✅ [login:${loginId}] QR đã được quét, chờ xác nhận...`);
                    if (pending) pending.status = 'scanned';
                    break;
                case 3: // QRCodeDeclined
                    declinedRetryCount++;
                    if (declinedRetryCount > MAX_DECLINED_RETRIES) {
                        if (pending) { pending.status = 'failed'; pending.error = 'QR bị từ chối nhiều lần'; }
                        if (event.actions?.abort) event.actions.abort();
                        return;
                    }
                    if (pending) pending.status = 'waiting';
                    if (event.actions?.retry) event.actions.retry();
                    break;
                case 4: // GotLoginInfo — { cookie, imei, userAgent } để restore sau
                    logger.login.info(`🔑 [login:${loginId}] Đã nhận credentials`);
                    if (event.data) capturedCredentials = event.data;
                    break;
            }
        };

        logger.login.info(`🔄 [login:${loginId}] Bắt đầu loginQR...`);
        const api = await zalo.loginQR({ qrPath: qrFilePath }, callback);

        // Đăng nhập thành công — gắn vào channel (thay session cũ nếu có)
        this.stopListener();
        this.zalo = zalo;
        this.api = api;
        this.isLoggedIn = true;
        this.proxy = proxy;
        this.loggedInAt = new Date();
        this.zaloId = null;
        this._groupIdSetCache = { ids: null, at: 0 };

        await this.fetchUserInfo();

        store.zaloSession.save({
            zaloId: this.zaloId,
            displayName: this.userInfo.displayName,
            avatarUrl: this.userInfo.avatarUrl,
            phone: this.userInfo.phone,
            credentials: capturedCredentials,
            proxy: proxy,
        });

        this._startListener();
        if (pending) pending.status = 'success';
        this.emit('status', this.status());

        logger.login.info(`✅ [login:${loginId}] Đăng nhập thành công! zaloId=${this.zaloId}, tên=${this.userInfo.displayName}`);

        try { if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath); } catch (e) { /* bỏ qua */ }
        setTimeout(() => this.pendingLogins.delete(loginId), 5 * 60 * 1000);

        // Import danh bạ (bạn bè + nhóm) chạy nền — không block login
        this.syncContacts().catch(err => logger.warn('⚠️ Sync danh bạ sau login lỗi:', err.message));
    }

    getLoginStatus(loginId) {
        return this.pendingLogins.get(loginId) || null;
    }

    // ==========================================
    // Restore session từ DB (khi restart server)
    // ==========================================
    async restoreFromDb() {
        const session = store.zaloSession.get();
        if (!session || session.status !== 'active' || !session.credentials) {
            logger.login.info('ℹ️ Không có session Zalo để khôi phục');
            return false;
        }

        try {
            const credentials = JSON.parse(session.credentials);
            if (!credentials.cookie || !credentials.imei || !credentials.userAgent) {
                logger.login.warn('⚠️ Credentials thiếu thông tin, bỏ qua restore');
                return false;
            }

            logger.login.info(`🔄 [${session.zalo_id}] Đang khôi phục session Zalo...`);
            const proxy = session.proxy || null;
            this.zalo = new Zalo(createZaloOptions(proxy));
            this.api = await this.zalo.login(credentials);
            this.zaloId = session.zalo_id;
            this.isLoggedIn = true;
            this.proxy = proxy;
            this.loggedInAt = session.login_at ? new Date(session.login_at) : new Date();

            await this.fetchUserInfo();
            store.zaloSession.updateUserInfo({
                displayName: this.userInfo.displayName,
                avatarUrl: this.userInfo.avatarUrl,
                phone: this.userInfo.phone,
            });

            this._startListener();
            this.emit('status', this.status());
            logger.login.info(`✅ [${this.zaloId}] Khôi phục thành công! Tên: ${this.userInfo.displayName}`);
            return true;
        } catch (err) {
            logger.login.error(`⚠️ Khôi phục session thất bại:`, err.message);
            store.zaloSession.expire();
            return false;
        }
    }

    async logoutZalo() {
        this.stopListener();
        this.isLoggedIn = false;
        this.api = null;
        this.zalo = null;
        store.zaloSession.expire();
        this.emit('status', this.status());
        logger.info(`🚪 [${this.zaloId}] Đã ngắt kết nối kênh Zalo`);
        return { success: true };
    }

    _handleDisconnected(reason) {
        logger.error(`🔴 [${this.zaloId}] MẤT KẾT NỐI Zalo: ${reason}`);
        this.stopListener();
        this.isLoggedIn = false;
        store.zaloSession.expire();
        this.emit('status', this.status());
    }

    // ==========================================
    // Import danh bạ: bạn bè + nhóm → bảng threads
    // ==========================================
    async syncContacts() {
        this._requireConnected();
        let friendCount = 0;
        let groupCount = 0;

        // 1. Bạn bè
        try {
            const friends = await this.api.getAllFriends();
            for (const f of friends || []) {
                if (!f.userId) continue;
                store.threads.upsertContact({
                    threadId: String(f.userId),
                    type: 'user',
                    name: f.displayName || f.zaloName || '',
                    avatarUrl: f.avatar || '',
                    phone: f.phoneNumber || '',
                });
                friendCount++;
            }
            logger.info(`📇 [${this.zaloId}] Import ${friendCount} bạn bè vào danh bạ`);
            store.mcpSync.record('friends', 'success', friendCount);
        } catch (e) {
            store.mcpSync.record('friends', 'failed', friendCount);
            logger.warn(`⚠️ [${this.zaloId}] Lỗi import bạn bè: ${e.message}`);
        }

        // 2. Nhóm — getAllGroups lấy ID, getGroupInfo batch 10 lấy chi tiết
        try {
            const allGroups = await this.api.getAllGroups();
            const groupIds = Object.keys(allGroups?.gridVerMap || {});
            this._groupIdSetCache = { ids: new Set(groupIds), at: Date.now() };

            const BATCH_SIZE = 10;
            let partial = false;
            for (let i = 0; i < groupIds.length; i += BATCH_SIZE) {
                const batchIds = groupIds.slice(i, i + BATCH_SIZE);
                let gridInfoMap = {};
                try {
                    const detail = await this.api.getGroupInfo(batchIds);
                    gridInfoMap = detail?.gridInfoMap || {};
                } catch (batchErr) {
                    partial = true;
                    logger.warn(`⚠️ [${this.zaloId}] Lỗi chi tiết nhóm batch ${i}: ${batchErr.message}`);
                }
                for (const gid of batchIds) {
                    const info = gridInfoMap[gid] || {};
                    store.threads.upsertContact({
                        threadId: String(gid),
                        type: 'group',
                        name: info.name || '',
                        avatarUrl: info.avt || '',
                        phone: '',
                    });
                    groupCount++;
                }
            }
            logger.info(`👥 [${this.zaloId}] Import ${groupCount} nhóm vào danh bạ`);
            store.mcpSync.record('groups', partial ? 'partial' : 'success', groupCount);
        } catch (e) {
            store.mcpSync.record('groups', 'failed', groupCount);
            logger.warn(`⚠️ [${this.zaloId}] Lỗi import nhóm: ${e.message}`);
        }

        this.emit('threads_updated', {});
        return { friends: friendCount, groups: groupCount };
    }

    // ==========================================
    // Resolve thread type (user/group)
    // 1. Bảng threads (DB) → 2. group-set từ getAllGroups → 3. mặc định user
    // ==========================================
    async _getGroupIdSet() {
        const now = Date.now();
        if (this._groupIdSetCache.ids && (now - this._groupIdSetCache.at) < ZaloChannel.GROUP_SET_TTL) {
            return this._groupIdSetCache.ids;
        }
        const allGroups = await this.api.getAllGroups();
        const ids = new Set(Object.keys(allGroups?.gridVerMap || {}));
        this._groupIdSetCache = { ids, at: now };
        return ids;
    }

    async resolveThreadType(threadId) {
        const cached = store.threads.get(String(threadId));
        if (cached) return cached.type;

        try {
            const groupIds = await this._getGroupIdSet();
            const type = groupIds.has(String(threadId)) ? 'group' : 'user';
            store.threads.ensureExists(String(threadId), type, '');
            return type;
        } catch (e) {
            logger.warn(`⚠️ resolveThreadType: getAllGroups lỗi (${e.message}) → mặc định 'user'`);
            return 'user';
        }
    }

    // ==========================================
    // Gửi tin nhắn (text) — lưu DB + emit ngay
    // source: 'web' (từ UI inbox) | 'api' (REST API)
    // ==========================================
    // opts (tùy chọn, dùng bởi Trợ lý AI): { quote: SendMessageQuote, mentions: [{ pos, len, uid }] }
    async sendText(threadId, message, source = 'api', threadType = null, opts = {}) {
        this._requireConnected();
        threadId = String(threadId);
        if (!threadType) threadType = await this.resolveThreadType(threadId);
        const type = threadType === 'group' ? ThreadType.Group : ThreadType.User;

        try {
            const payload = { msg: message };
            if (opts?.quote) payload.quote = opts.quote;
            if (Array.isArray(opts?.mentions) && opts.mentions.length && type === ThreadType.Group) payload.mentions = opts.mentions;
            const result = await this.api.sendMessage(payload, threadId, type);
            // zca-js trả về { message: { msgId }, attachment: [{ msgId }] } — KHÔNG phải result.msgId
            const msgId = this._trackSentMsgIds(result);
            const saved = this._storeMessage({
                msgId, threadId, threadType,
                direction: 'out', source,
                senderId: this.zaloId,
                senderName: this.userInfo?.displayName || '',
                content: message, contentType: 'text',
                sentAt: Date.now(),
            });
            logger.info(`📤 [${this.zaloId}] Gửi text → ${threadId} (${threadType}, ${source})`);
            return { success: true, thread_type: threadType, message_row: saved };
        } catch (err) {
            await this._handleSendError(err);
        }
    }

    // ==========================================
    // Gửi hình ảnh — nhận URL http(s) hoặc base64 data URI
    // ==========================================
    async sendImage(threadId, imageSource, caption = '', source = 'api', threadType = null) {
        this._requireConnected();
        threadId = String(threadId);
        if (!threadType) threadType = await this.resolveThreadType(threadId);
        const type = threadType === 'group' ? ThreadType.Group : ThreadType.User;

        const isBase64 = typeof imageSource === 'string' && imageSource.startsWith('data:image/');
        let tmpFilePath = null;
        let storedHref = ''; // URL để UI hiển thị lại ảnh đã gửi

        try {
            if (isBase64) {
                tmpFilePath = this._saveBase64Image(imageSource);
                // Lưu bản copy vào public/uploads để inbox hiển thị lại được
                storedHref = this._copyToUploads(tmpFilePath);
            } else {
                tmpFilePath = await this._downloadImage(imageSource);
                storedHref = imageSource; // URL gốc
            }

            const fileStats = fs.statSync(tmpFilePath);
            if (fileStats.size === 0) throw new Error('File ảnh bị trống (0 bytes)');

            // Đảm bảo extension hợp lệ
            const ext = path.extname(tmpFilePath).toLowerCase();
            if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
                const newPath = tmpFilePath + '.jpg';
                fs.renameSync(tmpFilePath, newPath);
                tmpFilePath = newPath;
            }

            const result = await this.api.sendMessage(
                { msg: caption || '', attachments: [normalizePath(tmpFilePath)] },
                threadId,
                type
            );
            // Gửi ảnh: msgId nằm trong attachment[] (và message nếu có caption) — track hết
            const msgId = this._trackSentMsgIds(result);

            const saved = this._storeMessage({
                msgId, threadId, threadType,
                direction: 'out', source,
                senderId: this.zaloId,
                senderName: this.userInfo?.displayName || '',
                content: JSON.stringify({ href: storedHref, caption: caption || '' }),
                contentType: 'photo',
                sentAt: Date.now(),
            });
            logger.info(`🖼️ [${this.zaloId}] Gửi ảnh → ${threadId} (${threadType}, ${source})`);
            return { success: true, thread_type: threadType, message_row: saved };
        } catch (err) {
            await this._handleSendError(err);
        } finally {
            if (tmpFilePath) {
                const fileToDelete = tmpFilePath;
                setTimeout(() => {
                    try { if (fs.existsSync(fileToDelete)) fs.unlinkSync(fileToDelete); } catch (e) { /* bỏ qua */ }
                }, 10000);
            }
        }
    }

    // ==========================================
    // Tìm user theo SĐT
    // findUser trả TRỰC TIẾP User object có uid (không bọc {data, error_code})
    // ==========================================
    async findUserByPhone(phoneNumber) {
        this._requireConnected();
        try {
            const result = await this.api.findUser(phoneNumber);
            if (result && result.uid) {
                return {
                    success: true,
                    data: {
                        uid: String(result.uid),
                        display_name: result.display_name || result.displayName || null,
                        zalo_name: result.zalo_name || result.zaloName || null,
                        avatar: result.avatar || null,
                    },
                };
            }
            return { success: false, message: 'Không tìm thấy (SĐT chưa đăng ký Zalo hoặc chặn tìm kiếm)' };
        } catch (err) {
            if (this._isSessionExpiredError(err)) throw this._createSessionExpiredError();
            throw err;
        }
    }

    // ==========================================
    // Listener — nhận tin đến + tin đi, lưu DB, emit realtime
    // ==========================================
    _startListener() {
        if (!this.api || !this.isLoggedIn || this.isListening) return;
        const zaloId = this.zaloId;

        this.api.listener.on('message', async (message) => {
            try {
                const msgId = String(message.data?.msgId || '');

                // Echo tin do chính server gửi (web/api/mcp/ai) có thể tới qua WebSocket TRƯỚC khi sendMessage() resolve
                // (tức trước khi msgId được add vào _sentMsgIds) → chờ ngắn rồi kiểm tra lại, tránh lưu trùng
                // và tránh Trợ lý AI hiểu nhầm là "chủ kênh trả lời từ app" rồi tự tạm dừng.
                if (message.isSelf && msgId && !this._sentMsgIds.has(msgId)) {
                    await new Promise(r => setTimeout(r, 1500));
                }
                // Tin gửi qua server — đã lưu DB lúc gửi → bỏ qua
                if (message.isSelf && msgId && this._sentMsgIds.has(msgId)) {
                    this._sentMsgIds.delete(msgId);
                    return;
                }
                // Dedupe theo msgId (listener có thể emit lại)
                if (store.messages.existsByMsgId(msgId)) return;

                const direction = message.isSelf ? 'out' : 'in';
                const source = message.isSelf ? 'app' : 'zalo';
                const isGroup = message.type === ThreadType.Group;
                const threadType = isGroup ? 'group' : 'user';
                const threadId = String(message.threadId);

                // Parse nội dung: string → text, object có type → photo/sticker/... (giữ JSON)
                const rawContent = message.data?.content;
                let contentType = 'text';
                let content = '';
                if (typeof rawContent === 'string') {
                    content = rawContent;
                } else if (rawContent && typeof rawContent === 'object') {
                    contentType = rawContent.type || (rawContent.href || rawContent.thumb ? 'photo' : 'unknown');
                    try { content = JSON.stringify(rawContent); } catch { content = String(rawContent); }
                } else {
                    contentType = 'unknown';
                    content = '';
                }

                // Sender
                let senderId, senderName;
                if (direction === 'out') {
                    senderId = zaloId;
                    senderName = this.userInfo?.displayName || 'Tôi';
                } else {
                    // DM: threadId === uidFrom; Group: uidFrom = người gửi thực
                    senderId = String(message.data?.uidFrom || threadId);
                    senderName = message.data?.dName || '';
                }

                // Đảm bảo thread tồn tại (tên best-effort cho DM đến)
                const threadName = (threadType === 'user' && direction === 'in') ? senderName : '';
                store.threads.ensureExists(threadId, threadType, threadName);

                // meta cho Trợ lý AI: mentions (nhóm), quote (reply), msgType
                const meta = {};
                if (Array.isArray(message.data?.mentions) && message.data.mentions.length) {
                    meta.mentions = message.data.mentions.map(m => ({ uid: String(m.uid), pos: m.pos, len: m.len, type: m.type }));
                }
                if (message.data?.quote) {
                    const q = message.data.quote;
                    meta.quote = { ownerId: String(q.ownerId || ''), globalMsgId: q.globalMsgId, cliMsgId: q.cliMsgId, msg: typeof q.msg === 'string' ? q.msg.slice(0, 500) : '' };
                }
                if (message.data?.msgType) meta.msgType = message.data.msgType;

                const saved = this._storeMessage({
                    msgId, threadId, threadType, direction, source,
                    senderId, senderName, content, contentType,
                    sentAt: Number(message.data?.ts) || Date.now(),
                    meta: Object.keys(meta).length ? meta : null,
                });

                logger.info(`📩 [${zaloId}] Tin ${direction} (${threadType}) thread=${threadId}`);
                // Trợ lý AI: tin đến (khách) hoặc tin chủ kênh gửi từ app (isSelf) — engine tự quyết định
                this.emit('ai_incoming', { row: saved, raw: message.data, isSelf: !!message.isSelf, threadType });
            } catch (e) {
                logger.error(`❌ [${zaloId}] Lỗi xử lý tin nhắn listener:`, e.message);
            }
        });

        // Tránh ERR_UNHANDLED_ERROR crash process (WebSocket 502, reset...)
        this.api.listener.on('error', (err) => {
            const errMsg = err?.message || err?.error?.message || String(err);
            logger.error(`🔴 [${zaloId}] Listener WebSocket error: ${errMsg}`);
        });

        // WebSocket đóng → check thật trước khi kết luận mất kết nối
        this.api.listener.on('close', async () => {
            logger.warn(`🔌 [${zaloId}] Listener WebSocket CLOSED`);
            this.isListening = false;
            const connCheck = await this.checkConnectionAlive();
            if (!connCheck.alive) {
                this._handleDisconnected(connCheck.error || 'WebSocket closed');
            }
        });

        this.api.listener.start();
        this.isListening = true;
        logger.info(`👂 [${zaloId}] Message listener đã khởi động`);
    }

    stopListener() {
        if (this.api?.listener && this.isListening) {
            try { this.api.listener.stop(); } catch (e) { /* bỏ qua */ }
        }
        this.isListening = false;
    }

    // ==========================================
    // Helpers nội bộ
    // ==========================================

    /**
     * Track TẤT CẢ msgId từ kết quả sendMessage vào _sentMsgIds (chống listener lưu trùng echo)
     * zca-js SendMessageResponse = { message: { msgId } | null, attachment: [{ msgId }] }
     * @returns {string} msgId chính (dùng lưu vào DB)
     */
    _trackSentMsgIds(result) {
        const ids = [];
        if (result?.message?.msgId) ids.push(String(result.message.msgId));
        for (const a of result?.attachment || []) {
            if (a?.msgId) ids.push(String(a.msgId));
        }
        // Fallback phòng zca-js đổi format
        if (ids.length === 0 && (result?.msgId || result?.data?.msgId)) {
            ids.push(String(result.msgId || result.data.msgId));
        }
        for (const id of ids) {
            this._sentMsgIds.add(id);
            setTimeout(() => this._sentMsgIds.delete(id), 60000);
        }
        return ids[0] || '';
    }

    // Lưu message vào DB + cập nhật thread + emit event → SSE đẩy cho UI
    _storeMessage({ msgId, threadId, threadType, direction, source, senderId, senderName, content, contentType, sentAt, meta = null }) {
        store.threads.ensureExists(threadId, threadType, '');
        const info = store.messages.insert({
            msgId, threadId, direction, source, senderId, senderName, content, contentType, sentAt, meta,
        });

        // Preview cho danh sách hội thoại
        let preview = content;
        if (contentType !== 'text') {
            const labels = { photo: '[Hình ảnh]', sticker: '[Sticker]', voice: '[Voice]', video: '[Video]', file: '[File]' };
            preview = labels[contentType] || `[${contentType}]`;
        }
        if (preview.length > 120) preview = preview.slice(0, 120);
        store.threads.updateLastMessage(threadId, preview, sentAt, direction, direction === 'in');

        const row = store.messages.findById(info.lastInsertRowid);
        const thread = store.threads.get(threadId);
        this.emit('message', { message: row, thread });
        return row;
    }

    async _downloadImage(imageUrl) {
        const tmpDir = path.join(config.ROOT, 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const urlPath = new URL(imageUrl).pathname;
        const ext = path.extname(urlPath) || '.jpg';
        const filePath = path.join(tmpDir, `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);

        return new Promise((resolve, reject) => {
            const client = imageUrl.startsWith('https') ? https : http;
            client.get(imageUrl, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    return this._downloadImage(response.headers.location).then(resolve).catch(reject);
                }
                if (response.statusCode !== 200) {
                    return reject(new Error(`Không thể tải ảnh, HTTP ${response.statusCode}`));
                }
                const fileStream = fs.createWriteStream(filePath);
                response.pipe(fileStream);
                fileStream.on('finish', () => { fileStream.close(); resolve(filePath); });
                fileStream.on('error', reject);
            }).on('error', reject);
        });
    }

    _saveBase64Image(dataUri) {
        const tmpDir = path.join(config.ROOT, 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const matches = dataUri.match(/^data:image\/(\w+);base64,(.+)$/s);
        if (!matches) throw new Error('Base64 data URI không hợp lệ (format: data:image/<type>;base64,<data>)');

        const extMap = { png: '.png', jpeg: '.jpg', jpg: '.jpg', webp: '.webp', gif: '.gif' };
        const ext = extMap[matches[1].toLowerCase()] || '.jpg';
        const filePath = path.join(tmpDir, `img_b64_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);

        const buffer = Buffer.from(matches[2], 'base64');
        if (buffer.length === 0) throw new Error('Base64 decode ra dữ liệu trống');
        fs.writeFileSync(filePath, buffer);
        return filePath;
    }

    // Copy ảnh gửi từ UI vào public/uploads để hiển thị lại trong inbox
    _copyToUploads(tmpFilePath) {
        try {
            const uploadsDir = path.join(config.ROOT, 'public', 'uploads');
            if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
            const fileName = path.basename(tmpFilePath);
            fs.copyFileSync(tmpFilePath, path.join(uploadsDir, fileName));
            return `/uploads/${fileName}`;
        } catch (e) {
            return '';
        }
    }

    _requireConnected() {
        if (!this.api || !this.isLoggedIn) {
            const err = new Error('Kênh Zalo chưa kết nối. Vui lòng quét QR đăng nhập.');
            err.code = 'NOT_CONNECTED';
            throw err;
        }
    }

    async _handleSendError(err) {
        logger.error(`❌ [${this.zaloId}] Lỗi gửi:`, err.message || err);
        if (this._isSessionExpiredError(err)) {
            this._handleDisconnected(err.message);
            throw this._createSessionExpiredError();
        }
        // Gửi thất bại không rõ nguyên nhân → check kết nối thật
        const connCheck = await this.checkConnectionAlive().catch(() => ({ alive: false }));
        if (!connCheck.alive) {
            this._handleDisconnected('Gửi thất bại + check kết nối thất bại');
            throw this._createSessionExpiredError();
        }
        throw err;
    }

    _isSessionExpiredError(err) {
        const msg = (err.message || '').toLowerCase();
        const patterns = [
            'no login session', 'not_login', '-112', 'session expired', 'invalid session',
            'kicked', 'logged in from another', 'unauthorized', 'token expired', 'login required', 'relogin',
        ];
        return patterns.some(p => msg.includes(p));
    }

    _createSessionExpiredError() {
        const err = new Error('Phiên Zalo đã hết hạn hoặc bị thu hồi. Cần quét QR đăng nhập lại.');
        err.code = 'SESSION_EXPIRED';
        return err;
    }
}

module.exports = new ZaloChannel();

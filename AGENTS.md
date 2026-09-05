# zalo-inbox — Notes cho AI agents (Codex, Claude...)

Đây là **điểm vào ghi chú chung** của dự án; `CLAUDE.md` chỉ trỏ về đây. File này giữ tóm tắt và quy tắc chung; kiến trúc, lịch sử lỗi và hướng dẫn bảo trì chi tiết cập nhật trong tài liệu từng hệ thống được dẫn bên dưới.

Bộ source quản lý **1 kênh Zalo cá nhân / 1 domain** — web trực chat + REST API + MCP + Trợ lý AI. Kiến trúc: [README.md](README.md) · Setup VPS bất kỳ: [SETUP.md](SETUP.md) · API: [API.md](API.md) · MCP: [MCP.md](MCP.md) · Trợ lý AI: [docs/AI-ARCHITECTURE.md](docs/AI-ARCHITECTURE.md)

> Nếu bạn là AI đang giúp setup bản này lần đầu trên server mới: đọc và làm theo [SETUP.md](SETUP.md).

## Khác biệt với zalochat (repo cha)
- **1 kênh duy nhất** (`ZaloChannel` singleton) thay vì multi-account (`ZaloSessionManager`)
- **SQLite** (better-sqlite3, sync API) thay vì MySQL — file `data/inbox.db`, tự tạo schema khi boot
- **LƯU tin nhắn** vào DB (bảng `messages` + `threads`) để hiển thị inbox — zalochat chỉ forward webhook
- **Không webhook** ra ngoài; realtime cho UI bằng **SSE** (`/app/events`), không socket.io
- Web UI có **user login** (bảng `users`, cookie token bảng `auth_tokens`, bcryptjs)
- API key tự quản lý trong DB (bảng `api_keys`, prefix `zik_`), không dùng .env API_KEY

## Các quy tắc zca-js kế thừa từ zalochat (KHÔNG được quên)
1. `imageMetadataGetter` bắt buộc khi `new Zalo()`, trả `{ width, height, size }` — key `size` KHÔNG phải `totalSize`
2. Windows path: convert `\` → `/` trước khi truyền vào `sendMessage` attachments
3. `loginQR(options, callback)` — callback types: 0=generated, 1=expired(retry max 3), 2=scanned, 3=declined(retry max 2), 4=GotLoginInfo → `{cookie, imei, userAgent}` lưu DB để restore
4. `selfListen: true` để listener emit cả tin mình gửi (isSelf=true)
5. Proxy: `HttpsProxyAgent` + native fetch (KHÔNG polyfill node-fetch — thiếu getSetCookie)
6. `findUser(phone)` trả trực tiếp User object có `uid` (không bọc `{data, error_code}`)
7. `getUserInfo` trả `{ changed_profiles: { key: profile } }`; `getGroupInfo` trả `{ gridInfoMap }`; batch getGroupInfo 10 ID/lần
8. `getAllFriends()` trả `User[]` (userId, displayName, zaloName, avatar, phoneNumber)
9. Listener phải bắt event `error` (tránh ERR_UNHANDLED_ERROR crash) và `close` (check thật rồi mới kết luận disconnect)
10. zca-js unofficial — lỗi login lạ: check repo `RFS-ADRENO/zca-js` Issues, thử bản mới

## Luồng chống lưu trùng tin nhắn
- Gửi qua server (web UI / API / AI / MCP): lưu DB **ngay lúc gửi** (`_storeMessage`), msgId add vào `_sentMsgIds`
- Listener nhận tin isSelf=true: nếu msgId ∈ `_sentMsgIds` → **bỏ qua** (đã lưu); ngược lại = gửi từ app Zalo → lưu với source `app`
- Dedupe thêm bằng `messages.existsByMsgId()`
- **Race echo (sửa 2026-09-05):** echo WebSocket của tin server gửi có thể tới TRƯỚC khi `sendMessage()` resolve (chưa kịp add `_sentMsgIds`) → listener chờ 1,5 s rồi kiểm tra lại với mọi tin `isSelf` chưa có trong `_sentMsgIds`. Không bỏ bước chờ này: nếu bỏ, tin AI/API bị lưu trùng thành `app` và Trợ lý AI tự tạm dừng sau chính câu trả lời của mình.
- `messages.source` hiện có: `zalo` (khách), `app` (chủ kênh gửi từ điện thoại), `web`, `api`, `mcp`, `ai`

## Trợ lý AI (`src/services/ai/`) — tóm tắt
- **Trước khi sửa gì liên quan AI, đọc [docs/AI-ARCHITECTURE.md](docs/AI-ARCHITECTURE.md)** (bản đồ file, luồng, bảng DB, API, cách mở rộng, vận hành). Thiết kế gốc: [docs/AI-PLAN.md](docs/AI-PLAN.md). Hướng dẫn người dùng: [docs/AI.md](docs/AI.md).
- Móc vào kênh chỉ qua event `ai_incoming` / `ai_human_reply` từ `zaloService.js` và `web.js`; engine singleton tự quyết định. Không gọi provider từ zaloService.
- Provider dùng fetch native (không SDK). `chatgpt.js`/`chatgptOAuth.js` giữ nguyên client id, redirect URI, headers của Codex CLI. Secret chỉ đi qua `secrets.js`; API không trả secret; lỗi qua `maskSecrets()`.
- Tool mới = 1 file trong `tools/` + 1 dòng `tools/index.js`. RAG cắm vào `knowledge/index.js`.
- `npm test` phải pass (test AI mock fetch + test MCP) sau mỗi lần sửa engine/policy/provider/routes.

## Chạy & deploy
- Local: `npm run dev` → http://localhost:3100 (đừng đụng port 3000 của zalochat)
- Production: mỗi domain 1 thư mục clone + 1 PORT + 1 PM2 process riêng (`zalo-inbox-<tên>`) — xem [SETUP.md](SETUP.md)
- `.env` không commit; seed admin từ ADMIN_USERNAME/ADMIN_PASSWORD chỉ khi bảng users trống

## MCP (`src/mcp/`) — tóm tắt
- MCP Streamable HTTP tại `/mcp`, OAuth DCR + PKCE bằng tài khoản web, scope `zalo:read` / `zalo:send`. Chi tiết: [MCP.md](MCP.md).
- `MCP_PUBLIC_URL` trong `.env` phải là origin HTTPS public khi chạy production. Chỉ 1 PM2 instance (dùng chung ZaloChannel).
- Tin gửi qua MCP có source `mcp`, đi qua cùng luồng dedupe listener/SSE. Token/code lưu hash, không log giá trị.

## Phiên bản & cập nhật
- Phiên bản ghi trong `package.json` và [CHANGELOG.md](CHANGELOG.md). Người dùng cập nhật bằng `bash update.sh` (git pull, npm install, pm2 restart); schema SQLite tự nâng cấp khi khởi động, không cần migrate tay.

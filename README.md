# Zalo Inbox

**MCP cho ứng dụng AI:** Streamable HTTP tại `/mcp`, đăng nhập OAuth bằng tài khoản web; liệt kê nhóm/danh bạ/người đã chat và gửi text theo ID/SĐT. Hướng dẫn: [MCP.md](MCP.md).

Bộ source quản lý **1 kênh Zalo cá nhân** trên **1 domain** — thiết kế để mang đi cài nhiều domain cho nhiều khách (mỗi khách 1 domain + 1 kênh Zalo riêng).

## Tính năng

**Web trực chat (inbox):**
- Đăng nhập bằng tài khoản user (nhiều người có thể cùng đăng nhập trực tin nhắn)
- Quét QR kết nối Zalo cá nhân — session tự restore sau restart, không cần quét lại
- Danh sách hội thoại: hiện rõ **ID**, phân biệt 👤 **CÁ NHÂN** / 👥 **NHÓM**, tìm theo tên/ID/SĐT
- Xem từng đoạn hội thoại (realtime qua SSE), gửi text + hình (chọn file hoặc paste ảnh)
- Import danh bạ: bạn bè + nhóm tự kéo về sau khi kết nối (bấm "Đồng bộ danh bạ" để refresh)

**🤖 Trợ lý AI trả lời tự động** (trang `/ai.html`, hướng dẫn: [docs/AI.md](docs/AI.md)):
- Provider: **Gemini** (API key), **OpenAI** (API key), OpenAI-compatible (OpenRouter, DeepSeek...), **ChatGPT subscription** (đăng nhập tài khoản Plus/Pro). Key/token mã hóa AES-256-GCM trong SQLite. Provider dự phòng tự chuyển khi lỗi.
- Instruction (system prompt) sửa trên web, khung **Thử nhanh** không gửi lên Zalo.
- Bật/tắt nhiều cấp: công tắc tổng · cá nhân (tất cả / chỉ người lạ / chỉ danh bạ) · nhóm (chỉ khi được **tag** hoặc reply vào bot / mọi tin, kèm danh sách nhóm) · từng hội thoại ngay trong Inbox · khung giờ.
- **Tự tạm dừng** khi nhân viên trả lời từ web hoặc app Zalo; chủ kênh gõ `/ai on|off` từ điện thoại; khách gõ `/new` để làm mới hội thoại.
- **Đọc ảnh** khách gửi (vision), **tool calling**: xem giờ, chuyển cho nhân viên (gắn cờ 🙋), tạo ảnh (bật/tắt).
- Nhật ký từng lượt (provider, tokens, tool, lỗi). Kiến trúc sẵn chỗ cắm RAG (embedding qua Gemini/OpenAI) — xem [docs/AI-PLAN.md](docs/AI-PLAN.md).

**REST API** (trang Cài đặt có quản lý API key + tài liệu chi tiết từng endpoint):
| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/v1/send` | Gửi theo ID — **tự nhận biết cá nhân/nhóm**, text + hình |
| POST | `/api/v1/send-phone` | Gửi đến SĐT (tìm user rồi gửi), text + hình |
| GET | `/api/v1/search?name=` | Tìm theo tên → list có ghi rõ `type: user\|group` |
| GET | `/api/v1/find-phone?phone=` | Tìm user theo SĐT (không gửi) |
| GET | `/api/v1/status` | Trạng thái kênh |

Auth API: header `X-API-Key` (tạo key trong trang Cài đặt). Chi tiết: [API.md](API.md)

## Kiến trúc

```
Node.js + Express + SQLite (better-sqlite3) — KHÔNG cần MySQL
├── src/server.js            # Entry: seed admin, restore Zalo, nối event → SSE
├── src/config.js            # Đọc .env
├── src/db.js                # SQLite: users, auth_tokens, api_keys, zalo_session, threads, messages
├── src/services/
│   ├── zaloService.js       # Core zca-js: QR login, restore, listener, send, sync danh bạ
│   ├── sse.js               # SSE hub — realtime cho UI (không cần socket.io)
│   ├── logger.js            # Log tách kênh app/login/error theo ngày
│   └── ai/                  # Trợ lý AI: engine, policy, context, agent loop, providers/, tools/, knowledge/ (RAG sau)
├── src/mcp/                 # MCP server + OAuth cho công cụ AI bên ngoài (xem MCP.md)
├── src/middleware/          # webAuth (cookie), apiAuth (X-API-Key)
├── src/routes/
│   ├── web.js               # /app/* — nội bộ UI (login, QR, threads, messages, send, keys, users)
│   ├── ai.js                # /app/ai/* — cấu hình Trợ lý AI (provider, instruction, thử nhanh, nhật ký)
│   └── api.js               # /api/v1/* — REST API cho hệ thống ngoài
└── public/                  # login.html, index.html (inbox), ai.html (Trợ lý AI), settings.html + css/js
```

**Điểm khác zalochat (repo cha):** chỉ 1 kênh/domain, LƯU tin nhắn vào SQLite để xem hội thoại, có web UI + user login, không webhook. Kế thừa toàn bộ kinh nghiệm zca-js từ zalochat (xem [AGENTS.md](AGENTS.md)).

**Giới hạn:** zca-js không lấy được lịch sử tin nhắn cũ — tin nhắn chỉ có từ lúc kênh kết nối trở đi. Danh bạ (bạn bè + nhóm) thì import được ngay.

## Chạy local

```bash
cd zalo-inbox
cp .env.example .env    # sửa ADMIN_USERNAME/ADMIN_PASSWORD
npm install
npm run dev             # http://localhost:3100
```

Đăng nhập bằng tài khoản admin trong `.env` → quét QR kết nối Zalo → dùng.

## Cài lên server (VPS + domain)

Xem hướng dẫn từng bước: [SETUP.md](SETUP.md). Khuyên cài bằng `git clone` để sau này cập nhật được bằng một lệnh.

## Cập nhật phiên bản mới

Trong thư mục đã cài trên server:

```bash
bash update.sh
```

Script tự backup DB + `.env` vào `backups/`, `git pull`, `npm install`, khởi động lại PM2 và kiểm tra `/health`. Schema SQLite tự nâng cấp khi khởi động, không cần chạy migration tay. Danh sách thay đổi từng phiên bản: [CHANGELOG.md](CHANGELOG.md). Kiểm tra có bản mới không: `bash update.sh --check`.

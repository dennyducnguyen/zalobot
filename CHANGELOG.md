# Changelog

Mọi thay đổi đáng chú ý của Zalo Inbox. Phiên bản theo [SemVer](https://semver.org/lang/vi/): **MAJOR** đổi cách cài/cấu hình, **MINOR** thêm tính năng, **PATCH** sửa lỗi. Cập nhật bằng `bash update.sh`.

## [1.2.1] — 2026-09-05

### Sửa lỗi
- Listener Zalo: echo của tin do server gửi (AI/API/web/MCP) có thể về qua WebSocket trước khi lệnh gửi resolve → bị lưu trùng thành tin "gửi từ app" và làm Trợ lý AI tự tạm dừng 30 phút sau chính câu trả lời của mình. Nay chờ 1,5 giây rồi kiểm tra lại trước khi lưu.
- Đăng nhập ChatGPT: phiên OAuth lưu mã hóa trong DB nên không mất khi server restart; giao diện không còn treo nút khi gặp lỗi HTTP.
- Trang Cài đặt và Trợ lý AI cuộn bằng thanh cuộn trình duyệt.

## [1.2.0] — 2026-09-05

### Thêm
- **Trợ lý AI trả lời tự động** (`/ai.html`): provider Gemini / OpenAI / OpenAI-compatible (API key) và ChatGPT subscription (đăng nhập OAuth); instruction + khung thử nhanh; bật/tắt theo công tắc tổng, cá nhân, nhóm (tag/mọi tin, whitelist), từng hội thoại, khung giờ; tự tạm dừng khi nhân viên trả lời; lệnh `/new`, `/ai on|off`; đọc ảnh khách gửi; tool xem giờ, chuyển nhân viên, tạo ảnh; nhật ký từng lượt. Xem `docs/AI.md`.
- **MCP server** (`/mcp`, Streamable HTTP + OAuth) để ChatGPT/Claude gọi: liệt kê nhóm/danh bạ/hội thoại, tìm SĐT, gửi text. Quản lý kết nối ở Cài đặt. Xem `MCP.md`.
- Trang Cài đặt và Trợ lý AI cuộn như web bình thường.
- Script `update.sh` cập nhật phiên bản mới, `CHANGELOG.md`.

### Thay đổi
- `messages` thêm cột `meta` (mentions/quote) và giá trị `source` mới: `mcp`, `ai`. Schema tự nâng cấp khi khởi động.
- `.env` thêm tùy chọn `AI_SECRET_KEY`, `AI_OAUTH_LOCAL_CALLBACK`, `MCP_PUBLIC_URL`, `MCP_SEND_INTERVAL_MS`, `MCP_ALLOWED_ORIGINS` (xem `.env.example`).
- Dependencies mới: `@modelcontextprotocol/sdk`, `express-rate-limit`, `zod`; `sharp` lên 0.35.

## [1.0.0] — 2026-07-22
- Bản đầu: web trực chat 1 kênh Zalo cá nhân, QR login, SQLite, SSE realtime, REST API (`/api/v1`), quản lý API key và user.

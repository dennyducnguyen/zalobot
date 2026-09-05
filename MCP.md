# Zalo Inbox MCP

Endpoint: `https://<domain>/mcp` (thay `<domain>` bằng domain của bạn).

## Kết nối

Trong ứng dụng AI có hỗ trợ MCP từ xa và OAuth, thêm endpoint trên, chọn Streamable HTTP/OAuth nếu được hỏi. Server hỗ trợ OAuth Dynamic Client Registration (DCR), PKCE S256, `none`, `client_secret_post` và `client_secret_basic`. Để ứng dụng đăng ký tự động; không dùng tài khoản web làm OAuth client ID/secret.

Trình duyệt mở trang cấp quyền trên domain Zalo Inbox. Đăng nhập bằng tài khoản web hiện có, chọn quyền và cấp quyền. Mật khẩu không chuyển cho ứng dụng AI. Quản lý/thu hồi các kết nối của mình tại **Cài đặt → Kết nối AI / MCP**. Thay đổi mật khẩu hoặc xóa tài khoản làm token OAuth của tài khoản đó mất hiệu lực.

ChatGPT/Claude có thể yêu cầu bật tính năng MCP hoặc quyền quản trị tùy tài khoản. Bản này đã kiểm thử bằng SDK MCP và các yêu cầu HTTP phía server; chưa thử trực tiếp trên tài khoản ChatGPT/Claude. Server dùng SDK 1.30.0, kiểm thử với giao thức 2025-11-25 và Streamable HTTP không lưu phiên. Chưa hỗ trợ CIMD hoặc transport HTTP+SSE cũ.

## Công cụ

| Tool | Quyền | Tham số |
|---|---|---|
| `zalo_get_status` | `zalo:read` | Không có |
| `zalo_list_groups` | `zalo:read` | `query?`, `limit?`, `cursor?` |
| `zalo_list_contacts` | `zalo:read` | `query?`, `limit?`, `cursor?` |
| `zalo_list_conversations` | `zalo:read` | `query?`, `type?: user/group`, `limit?`, `cursor?` |
| `zalo_find_user_by_phone` | `zalo:read` | `phone` |
| `zalo_send_message` | `zalo:send` | `to`, `thread_type: user/group`, `message`, `request_id` |
| `zalo_send_message_by_phone` | `zalo:send` | `phone`, `message`, `request_id` |

ID/SĐT là chuỗi, không phải số. Giới hạn text 2000 ký tự. Danh sách mặc định 50, tối đa 100 mục/trang. Truyền `next_cursor` nhận được vào `cursor` để lấy trang sau; kết thúc khi `next_cursor=null`. Sắp theo ID ổn định; thêm/xóa danh bạ trong lúc phân trang vẫn có thể làm thay đổi kết quả.

Danh sách lấy từ SQLite; không tải toàn bộ Zalo mỗi lần gọi. `sync` trả lần thử/lần thành công gần nhất của đồng bộ bạn bè/nhóm (có thể trống trước lần đồng bộ đầu tiên sau cập nhật). Làm mới bằng **Đồng bộ danh bạ** trên web. Nhóm là những nhóm hệ thống biết, có thể còn nhóm cũ đã rời; xác nhận membership thực tế phụ thuộc Zalo lúc gửi. `zalo_list_conversations` chỉ gồm hội thoại có tin được hệ thống lưu, không phải toàn bộ lịch sử trên điện thoại; không trả nội dung tin.

## Gửi và thử lại

Ví dụ tham số gửi ID:

```json
{
  "to": "12345678901234567890",
  "thread_type": "user",
  "message": "Nội dung cần gửi",
  "request_id": "cc1162b0-c4f3-40b5-bebe-fbaf55f0ba77"
}
```

Mỗi ý định gửi mới dùng một `request_id` mới (UUID). Thử lại cùng tin phải giữ nguyên cả mã, người nhận, loại và nội dung. Server lưu mã cùng hash payload theo tài khoản web + OAuth client; ghi nhớ qua restart và refresh token. Mã cũ với payload khác trả `IDEMPOTENCY_CONFLICT`. Kết quả thành công được trả lại khi cùng yêu cầu lặp lại, không gọi gửi lần nữa. Đăng ký OAuth client mới tạo phạm vi chống trùng mới.

MCP cho phép một lượt gửi đang chạy tại một thời điểm; mặc định hai lần bắt đầu gửi cách nhau tối thiểu 2 giây. AI gửi nhiều người bằng cách gọi tuần tự và tuân theo `retry_after_seconds`. Không có lịch gửi, hàng đợi hàng loạt hoặc tự động thử lại ở server. Giới hạn này là bảo vệ vận hành, không phải cam kết hạn mức được Zalo cho phép.

| Lỗi | Xử lý |
|---|---|
| HTTP 401 | Token MCP hết hạn/thu hồi; refresh hoặc kết nối OAuth lại |
| `INSUFFICIENT_SCOPE` | Cấp thêm quyền cho kết nối |
| `RATE_LIMITED` / HTTP 429 | Chờ thời gian được trả, thử lại cùng mã yêu cầu |
| `SEND_IN_PROGRESS` | Chờ rồi kiểm tra lại bằng cùng mã và tham số |
| `SEND_OUTCOME_UNKNOWN` | Có thể Zalo đã nhận tin. Kiểm tra inbox; không tự gửi lại bằng mã mới |
| `NOT_CONNECTED` / `connection_lost: true` | Vào web quét QR Zalo lại |
| `USER_NOT_FOUND` | SĐT không tìm được hoặc hạn chế quyền tìm kiếm |
| `RECIPIENT_TYPE_MISMATCH` | Kiểm tra lại `user/group` và ID |

Kết quả thành công có `message_id` khi Zalo trả được mã; không đồng nghĩa người nhận đã đọc. Tin gửi thành công dùng source `mcp`, đi qua luồng lưu DB/SSE và dedupe listener hiện có.

## Cấu hình vận hành

OAuth discovery dùng issuer chính xác là public origin (không có dấu `/` cuối), đồng nhất trong cả hai Protected Resource Metadata và callback `iss`; trả `Cache-Control: no-store`. Sau cập nhật metadata, đóng form tạo kết nối cũ và tạo lại nếu ứng dụng vẫn giữ thông tin lỗi trước đó. Không nhập tài khoản web vào ô OAuth Client ID/Secret.

Trang cấp quyền dùng `Referrer-Policy: same-origin`: không đổi thành `no-referrer`, vì trình duyệt sẽ gửi `Origin: null` khi POST biểu mẫu và bị kiểm tra CSRF từ chối. CSP `form-action` phải cho phép origin của callback đã được xác thực cho yêu cầu đó để Chromium có thể chuyển hướng sau khi cấp quyền. Vẫn kiểm tra nghiêm ngặt Origin, cookie và CSRF token. Nếu gặp “Phiên cấp quyền không hợp lệ”, bắt đầu kết nối lại từ ứng dụng AI thay vì tải lại trang POST bị lỗi.

```dotenv
MCP_PUBLIC_URL=https://<domain>
MCP_SEND_INTERVAL_MS=2000
# Chỉ thêm nếu công cụ cần Origin khác; phân tách bằng dấu phẩy
MCP_ALLOWED_ORIGINS=
```

Production bắt buộc HTTPS. Origin mặc định gồm domain của app, `https://chatgpt.com`, `https://claude.ai`; client server-to-server không gửi Origin vẫn được chấp nhận nếu bearer token hợp lệ. App tiếp tục listen loopback sau nginx. Không dùng PM2 cluster/multiple workers vì ZaloChannel là singleton và giới hạn gửi đồng thời nằm trong tiến trình.

OAuth discovery: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` (có alias tại root). Các endpoint `/authorize`, `/token`, `/register`, `/revoke`, `/oauth/consent`. Access token sống 1 giờ; refresh token 30 ngày, xoay vòng khi sử dụng. Dùng lại refresh token cũ thu hồi grant tương ứng. Token, code và client secret được lưu hash, không ghi giá trị vào log. Các bảng MCP dùng chung SQLite với app; tiếp tục sao lưu DB nhất quán cùng `.env`.

`npm test` dùng DB tạm, dịch vụ Zalo giả lập và SDK client; không gửi tin thật. Bộ kiểm thử bao gồm OAuth/PKCE, scope, refresh/replay, token expiry/audience/revoke, list pagination, send dedupe/concurrency/uncertainty, web/REST auth, ảnh và khôi phục trạng thái sau restart.

Dependencies: pin SDK/Zod/rate limiter; override `qs` 6.16.0 và cập nhật `sharp` 0.35.4 để xử lý các advisory phát hiện khi kiểm tra phụ thuộc. Không nâng zca-js trong lần cập nhật này.

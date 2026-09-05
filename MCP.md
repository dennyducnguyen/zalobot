# Zalo Inbox MCP

Endpoint: `https://<domain>/mcp` (thay `<domain>` bằng domain của bạn).

Cập nhật tài liệu: **2026-09-05**, sau bản sửa OAuth discovery và trang cấp quyền. Đây là tài liệu chính để sử dụng, chẩn đoán và phát triển MCP; [AGENTS.md](AGENTS.md) chỉ giữ tóm tắt và các quy tắc chung. Khi thay đổi MCP, cập nhật tài liệu này cùng source.

## Phạm vi đã thống nhất

- Cho ứng dụng AI từ xa lấy danh sách nhóm, bạn bè, người đã chat; tra cứu và gửi text theo ID hoặc SĐT trên **một kênh Zalo của domain**.
- AI tự gọi từng người nhận tuần tự. Hẹn giờ, chiến dịch hàng loạt và quyết định thử lại do công cụ AI bên ngoài xử lý; MCP không chạy lịch, queue hay worker gửi nền.
- Dùng tài khoản web để cấp quyền OAuth. REST API key `zik_...`, cookie đăng nhập web và bearer token MCP là ba cơ chế riêng; không thay thế cho nhau.
- Không đọc nội dung lịch sử tin nhắn qua MCP, không gửi ảnh/tệp, không quản lý nhiều kênh. Tính năng Trợ lý AI trong web là hệ thống riêng, xem [docs/AI-ARCHITECTURE.md](docs/AI-ARCHITECTURE.md).
- Người dùng tự kiểm thử kết nối thực tế từ ChatGPT/Claude; kiểm thử của người bảo trì không gửi tin Zalo thật khi chưa có yêu cầu cụ thể.

## Kết nối

Trong ứng dụng AI có hỗ trợ MCP từ xa và OAuth, thêm endpoint trên, chọn Streamable HTTP/OAuth nếu được hỏi. Server hỗ trợ OAuth Dynamic Client Registration (DCR), PKCE S256, `none`, `client_secret_post` và `client_secret_basic`. Để ứng dụng đăng ký tự động; không dùng tài khoản web làm OAuth client ID/secret.

Trình duyệt mở trang cấp quyền trên domain Zalo Inbox. Đăng nhập bằng tài khoản web hiện có, chọn quyền và cấp quyền. Mật khẩu không chuyển cho ứng dụng AI. Quản lý/thu hồi các kết nối của mình tại **Cài đặt → Kết nối AI / MCP**. Thay đổi mật khẩu hoặc xóa tài khoản làm token OAuth của tài khoản đó mất hiệu lực.

Thiết lập giao diện của ChatGPT/Claude phụ thuộc tài khoản và phiên bản ứng dụng. Đã kiểm thử bằng SDK MCP và HTTP phía server; người dùng đã thử ChatGPT và báo hai lỗi ghi ở mục lịch sử bên dưới. **Chưa có xác nhận kết nối ChatGPT/Claude hoàn tất sau bản sửa cuối.** Server dùng SDK 1.30.0, kiểm thử với giao thức 2025-11-25 và Streamable HTTP không lưu phiên. Chưa hỗ trợ CIMD hoặc transport HTTP+SSE cũ.

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

## Bản đồ source để sửa tiếp

| File | Trách nhiệm và điểm cần chú ý |
|---|---|
| [src/mcp/index.js](src/mcp/index.js) | `installMcp`: discovery, router OAuth SDK, body parser nhỏ, Basic client auth, Origin/Host/CORS, bearer auth, rate limit, Streamable HTTP, API quản lý kết nối |
| [src/mcp/auth.js](src/mcp/auth.js) | `createProvider`: DCR, trang đăng nhập/cấp quyền, CSRF, PKCE/code, cấp/refresh/revoke token, ràng buộc user/client/resource/scope |
| [src/mcp/tools.js](src/mcp/tools.js) | Schema 7 tools, phân quyền từng tool, truy vấn danh sách, tra SĐT, chống gửi trùng và khóa gửi; `createToolService` dùng chung, `createMcpServer` tạo cho từng request |
| [src/mcp/store.js](src/mcp/store.js) | Tạo bảng/index MCP idempotent; helper hash/random; chuyển lượt gửi `pending` sang `unknown` khi khởi tạo |
| [src/server.js](src/server.js) | Cài cookie parser rồi MCP/OAuth trước middleware body chung; `trust proxy` cho loopback |
| [src/config.js](src/config.js) | Đọc biến môi trường MCP; khoảng cách gửi cấu hình tối thiểu 1000 ms, mặc định 2000 ms |
| [src/db.js](src/db.js) | Khởi tạo MCP store trên DB chung và `mcpSync.record` |
| [src/services/zaloService.js](src/services/zaloService.js) | Kênh Zalo dùng chung; `findUserByPhone`, `sendText`, đồng bộ friends/groups và ghi trạng thái đồng bộ |
| [public/settings.html](public/settings.html), [public/js/settings.js](public/js/settings.js) | Hiện/copy link MCP, danh sách kết nối, thu hồi và lịch sử trạng thái gửi |
| [public/css/mcp.css](public/css/mcp.css) | CSS ngoài cho trang cấp quyền; CSP không cho script hoặc style inline |
| [test/mcp.test.js](test/mcp.test.js) | DB/tài khoản/kênh Zalo giả, HTTP server cục bộ và SDK MCP client |

Khi thêm tool: thêm schema và đăng ký trong `createMcpServer`, triển khai nghiệp vụ ở `createToolService` hoặc dịch vụ dùng chung, đặt scope và annotations đúng tác động, cập nhật bảng tools/tài liệu và kiểm thử hành vi. Các tool gửi phải đi qua cơ chế `request_id` và `channel.sendText(..., 'mcp', ...)`, không gọi zca-js trực tiếp để tránh mất lưu DB/dedupe/SSE.

Mọi user được cấp `zalo:send` đều tác động lên cùng kênh Zalo của domain; chưa có phân quyền theo người nhận hoặc nhóm. Tên người/nhóm lấy từ dữ liệu ngoài là dữ liệu, không phải chỉ dẫn cho AI. Không trả proxy, cookie Zalo hoặc thông tin xác thực qua tool trạng thái.

## Luồng HTTP và OAuth

1. Client gọi `/mcp` chưa có token → HTTP 401 và `WWW-Authenticate` chỉ đến Protected Resource Metadata.
2. Client đọc metadata tài nguyên, rồi metadata authorization server; đăng ký tại `/register` nếu dùng DCR.
3. Trình duyệt tới `/authorize` với client ID, callback đã đăng ký, `state`, scope, `resource` và PKCE S256. SDK kiểm tra yêu cầu; provider lưu pending và chuyển 303 sang `/oauth/consent?id=...`.
4. Trang consent kiểm tra pending/cookie; form POST xác minh Origin + CSRF + cookie, rồi bcrypt kiểm tra tài khoản web. Giao dịch DB tiêu thụ pending một lần, tạo grant/code và chuyển 303 về callback kèm `code`, `state`, `iss`. Từ chối trả `error=access_denied`.
5. Client đổi code + verifier tại `/token`; server kiểm tra client, callback, PKCE và resource, tiêu thụ code một lần, trả access/refresh token.
6. Client gọi `POST /mcp` với bearer token. Server xác minh grant/user/password/resource, kiểm tra scope của tool và trả JSON MCP. Refresh token xoay vòng; dùng lại token refresh cũ sẽ thu hồi grant.

| Endpoint | Cơ chế / hành vi |
|---|---|
| `GET /.well-known/oauth-authorization-server` | Metadata OAuth, CORS `*`, `Cache-Control: no-store` |
| `GET /.well-known/oauth-protected-resource/mcp` | Metadata tài nguyên `/mcp`; alias `/.well-known/oauth-protected-resource` trả cùng nội dung |
| `/authorize`, `/register`, `/token`, `/revoke` | Router SDK; provider nghiệp vụ ở `auth.js` |
| `GET /oauth/consent`, `POST /oauth/consent` | Cookie `mcp_consent` và form đăng nhập/cấp quyền |
| `POST /mcp` | Streamable HTTP stateless, trả JSON; bearer token bắt buộc |
| `OPTIONS /mcp` | CORS preflight; GET/DELETE có token hợp lệ vẫn trả 405 vì không có phiên SSE để mở/xóa |
| `GET /app/mcp/connections` | Cookie web; tối đa 100 grant mới nhất thuộc user hiện tại |
| `DELETE /app/mcp/connections/:id` | Cookie web + Origin đúng + `X-MCP-Settings: 1`; chỉ thu hồi grant thuộc user |
| `GET /app/mcp/activity` | Cookie web; 50 lượt gửi gần nhất thuộc user, không trả nội dung tin |

### Các ràng buộc không được bỏ khi sửa

- Issuer là `new URL(MCP_PUBLIC_URL).origin`, không dùng `.href` làm thêm dấu `/`. Cả hai metadata tài nguyên và callback `iss` phải dùng đúng cùng chuỗi; resource là URL đầy đủ `/mcp`.
- Pending sống 10 phút; cookie HttpOnly, Secure khi HTTPS, SameSite=Lax, Path=`/oauth`. Authorization code sống 5 phút; access token 1 giờ; refresh token 30 ngày. Đồng hồ dùng thời gian server.
- Trang **GET** consent dùng `Referrer-Policy: same-origin`. Phản hồi **POST** đang dùng `no-referrer`; đừng tìm-thay toàn bộ mà vô tình đưa `no-referrer` trở lại trang chứa form.
- CSP của trang GET cho `form-action 'self' <origin callback đã xác thực>`, `frame-ancestors 'none'`, `base-uri 'none'`. Không dùng wildcard cho callback. Không chấp nhận `Origin: null`, Origin lạ, cookie/CSRF thiếu hoặc sai để né lỗi trình duyệt.
- DCR chỉ nhận 1–10 callback HTTPS, không userinfo/fragment; giới hạn 2000 client. Chỉ grant authorization_code/refresh_token, response code, PKCE S256. Secret client lưu hash; Basic và body secret được chuẩn hóa trước SDK so sánh. Không hash hai lần.
- Scope được ràng buộc theo đăng ký client → yêu cầu authorize → lựa chọn consent → token. Refresh không được tăng quyền. Trước gửi, kiểm tra token lại sau bước tra SĐT bất đồng bộ.
- `/mcp` kiểm tra Host và Origin độc lập; danh sách Origin mở rộng chỉ áp dụng MCP/CORS, không mở rộng Origin được phép POST consent.
- Body OAuth tối đa 16 KB, MCP 64 KB. Consent POST: 20 lượt/15 phút; DCR: 20 lượt theo cửa sổ mặc định SDK; token: 200 lượt theo cửa sổ mặc định SDK; MCP: 120 request/phút/grant. Các bộ đếm middleware và khóa gửi là trong tiến trình, không dùng để chạy cluster.
- Thông báo đưa vào HTTP header, nhất là `InvalidTokenError`/`WWW-Authenticate`, dùng ASCII. Từng gặp lỗi header khi dùng tiếng Việt; tiếng Việt để trong body/HTML/tool result.

## Dữ liệu và vòng đời lượt gửi

Tất cả trong SQLite `data/inbox.db`, thời gian lưu theo epoch milliseconds (riêng `expiresAt` đối tượng SDK quy đổi sang giây). Tạo bảng khi app boot; không cần migrate thủ công cho bản hiện tại.

| Bảng | Nội dung / quan hệ |
|---|---|
| `mcp_clients` | ID client, metadata JSON, thời gian tạo; `client_secret` trong metadata đã hash |
| `mcp_pending` | ID phiên consent, client, params JSON, hash CSRF, hạn sử dụng |
| `mcp_grants` | User + client, scopes JSON, hash phiên bản password, thời gian tạo/dùng/thu hồi |
| `mcp_codes` | Hash code, grant, PKCE challenge, callback, resource, hạn sử dụng |
| `mcp_tokens` | Hash access/refresh token, grant, loại, scopes, resource, hạn dùng và `used_at` refresh |
| `mcp_sends` | Khóa `(principal, request_id)`; hash payload, tool, recipient, trạng thái, result JSON, timestamps |
| `mcp_sync` | `friends`/`groups`, lần thử, lần đồng bộ thành công, số mục, trạng thái success/partial/failed |

`principal` là chuỗi `userId:clientId`. Payload hash gồm tên tool và tham số. Chuyển giữa tool gửi ID và tool gửi SĐT với cùng request ID cũng có thể gây conflict. Result có cả `content` dạng text JSON và `structuredContent`; lỗi nghiệp vụ có `isError: true` và `success: false`, thường nằm trong HTTP 200 của RPC.

Luồng gửi: kiểm tra cache → khóa/khoảng cách gửi → kết nối và loại recipient → ghi `pending` → tra SĐT nếu có → xác minh quyền lại → gọi gửi → ghi `sent`, `failed` hoặc `unknown`. Kết quả đã lưu, kể cả lỗi, được trả lại khi lặp cùng mã. Lỗi xảy ra trước khi ghi bản ghi (ví dụ rate limit hoặc chưa connected) chưa chiếm mã. `failed` đã lưu không tự chạy lại; nếu cần một lần thử mới, phải xác định lỗi xảy ra trước bước gửi rồi mới tạo ý định/mã mới. Với `unknown`, kiểm tra inbox trước, không tự động đổi mã để gửi lại.

Khi boot, `createMcpStore` chuyển mọi `pending` còn lại thành `unknown` để tránh gửi trùng sau crash. **Không `require('./src/db')` từ script chẩn đoán chạy song song production**: thao tác khởi tạo đó có thể đổi trạng thái lượt đang gửi thật. Với đọc/backup, mở trực tiếp `better-sqlite3`, ưu tiên read-only cho truy vấn, dùng backup API cho snapshot nhất quán.

Cleanup chạy khi cài MCP và mỗi giờ, xóa pending/code/token hết hạn. Hiện chưa có chính sách dọn client, grant hay lịch sử gửi; theo dõi DB và giới hạn DCR khi dùng lâu. Không xóa `mcp_sends` tùy tiện vì sẽ mất khả năng nhận diện request cũ. Bản ghi gửi lưu recipient và kết quả, không lưu text gửi thô trong bảng này; tin đã gửi vẫn nằm trong bảng `messages` chung.

## Kiểm thử khi bảo trì

```powershell
# Chỉ thay đổi MCP
node --test test/mcp.test.js

# Thay đổi dịch vụ/web dùng chung hoặc chuẩn bị phát hành
npm test
```

Bộ MCP có 15 subtest bên trong 1 test cha, nên Node báo **16 tests**. Dùng DB tạm và giả lập gửi, không lấy tài khoản thật. Kiểm tra discovery tự động/DCR/PKCE bằng SDK, callback/resource/CSRF, client secret hash, scope, phân trang, gửi ID/SĐT, dedupe/cạnh tranh/kết quả chưa rõ, refresh/revoke/password change, bảo vệ web/REST và image metadata.

Sau lỗi consent đã thêm kiểm tra header `same-origin`, CSP cho đúng callback, từ chối Origin thiếu/`null`/lạ và cookie thiếu/sai. Lưu ý HTTP client kiểm thử tự đặt `Origin`, không tự mô phỏng chính sách trình duyệt. Khi sửa HTML/header/cookie, cần thêm lượt kiểm tra trên trình duyệt với tài khoản và callback giả cục bộ; không dùng tài khoản ChatGPT/Claude của người dùng làm kiểm thử tự động.

Kiểm tra production đã dùng tài khoản web tạm quyền đọc, callback HTTPS giả không được theo chuyển hướng; DCR → authorize/consent → đổi token → SDK list tools → status/groups/conversations → kiểm tra quyền đọc bị chặn gửi → revoke → xóa tài khoản và các hàng OAuth tạm. Nếu dùng lại script, cleanup chỉ nhắm đúng ID tạo bởi lượt kiểm thử. Không in password, token, cookie hay URL callback có code.

Các script tại `tmp/` là công cụ hỗ trợ phiên làm việc, không phải thành phần ứng dụng hoặc bảo đảm luôn có: `vps-mcp.cjs` (SSH/SCP dùng cấu hình dự án), `mcp-production-check.cjs`, `mcp-preview.cjs`, `fix-mcp-consent-vps.sh`. Preview dùng DB/kênh/tài khoản giả, không deploy lên production. Nếu thiếu script, dựng lại theo quy trình trên và kiểm tra trước khi chạy.

## Deploy & cập nhật

MCP chạy trong cùng tiến trình với app: cài theo [SETUP.md](SETUP.md), đặt `MCP_PUBLIC_URL` là origin HTTPS public, cập nhật phiên bản bằng `bash update.sh`. Kiểm tra nhanh sau khi chạy: `curl -fsS https://<domain>/.well-known/oauth-authorization-server` và `https://<domain>/.well-known/oauth-protected-resource/mcp` phải trả JSON. Nếu ứng dụng AI báo không kết nối được, bắt đầu lại kết nối OAuth từ phía ứng dụng AI (không tải lại trang POST bị lỗi).

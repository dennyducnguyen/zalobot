# Zalo Inbox — REST API Reference

Base URL: `https://<domain>/api/v1`
Auth: header `X-API-Key: <key>` (tạo key trong trang **Cài đặt & API** trên web). Có thể dùng `?api_key=` nếu không set được header.

> **⚠️ Tiếng Việt / UTF-8:** body JSON phải là UTF-8. Gọi từ code (PHP `json_encode`, JS `JSON.stringify`, Python `json.dumps`) luôn đúng. Riêng khi **test bằng curl trên Windows**, KHÔNG viết tiếng Việt inline trong `-d '...'` (bị hỏng dấu do encoding console) — hãy lưu body vào file UTF-8 rồi dùng `--data-binary @body.json`.

Format response chung:
```json
{ "success": true,  "data": { ... } }
{ "success": false, "error": { "code": "...", "message": "..." } }
```
Khi kênh mất kết nối, API gửi trả **HTTP 410** `SESSION_EXPIRED`/`NOT_CONNECTED` kèm `connection_lost: true` → cần đăng nhập web quét QR lại.

---

## POST /api/v1/send — Gửi theo ID (tự nhận biết cá nhân/nhóm)

Body:
| Field | Bắt buộc | Mô tả |
|-------|----------|-------|
| `to` | ✅ | thread_id — ID cá nhân hoặc ID nhóm, hệ thống **tự nhận biết** |
| `message` | ✅ nếu không có image_url | Nội dung text |
| `image_url` | — | URL http(s) **hoặc** base64 data URI (`data:image/png;base64,...`) |
| `caption` | — | Chú thích kèm ảnh |

```bash
curl -X POST https://<domain>/api/v1/send \
  -H "X-API-Key: KEY" -H "Content-Type: application/json" \
  -d '{"to": "1234567890", "message": "Xin chào!"}'
```
Response: `data.thread_type` = `"user"` | `"group"` (kết quả tự nhận biết).

## POST /api/v1/send-phone — Gửi đến SĐT

Body: `phone` (✅), `message` / `image_url` / `caption` như trên.
```bash
curl -X POST https://<domain>/api/v1/send-phone \
  -H "X-API-Key: KEY" -H "Content-Type: application/json" \
  -d '{"phone": "0912345678", "message": "Xin chào!"}'
```
Lỗi 404 `USER_NOT_FOUND` nếu SĐT chưa đăng ký Zalo hoặc chặn tìm kiếm.

## GET /api/v1/search?name= — Tìm theo tên

Query: `name` (✅), `type=user|group` (lọc), `limit` (mặc định 50, max 200).
```bash
curl "https://<domain>/api/v1/search?name=Minh" -H "X-API-Key: KEY"
```
Mỗi kết quả có `type: "user"` (cá nhân) hoặc `"group"` (nhóm) + `thread_id` để gửi tin.

## GET /api/v1/find-phone?phone= — Tìm user theo SĐT (không gửi)

```bash
curl "https://<domain>/api/v1/find-phone?phone=0912345678" -H "X-API-Key: KEY"
```
Response: `{ found: true|false, user: { uid, display_name, avatar_url } }`

## GET /api/v1/status — Trạng thái kênh

```bash
curl "https://<domain>/api/v1/status" -H "X-API-Key: KEY"
```
Response: `{ connected, listening, zalo_id, display_name, phone, ... }`

---

## Error codes

| Code | HTTP | Ý nghĩa |
|------|------|---------|
| `MISSING_API_KEY` / `INVALID_API_KEY` | 401 | Key thiếu/sai/bị tắt |
| `MISSING_PARAMS` | 400 | Thiếu tham số |
| `USER_NOT_FOUND` | 404 | SĐT không tìm thấy |
| `NOT_CONNECTED` / `SESSION_EXPIRED` | 410 | Kênh chưa/mất kết nối — quét QR lại |
| `INTERNAL_ERROR` | 500 | Lỗi khác (xem message) |

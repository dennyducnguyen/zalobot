# Hướng dẫn Setup Zalo Inbox (cho mọi VPS/máy chủ)

> File này dành cho người mới nhận source (hoặc AI assistant giúp setup). Làm theo từng bước là chạy được. Mỗi bản cài = 1 domain = 1 kênh Zalo cá nhân.

## Yêu cầu môi trường

| Thành phần | Yêu cầu |
|---|---|
| Node.js | **v18 trở lên** (khuyến nghị v20 LTS — cần native fetch) |
| npm | Đi kèm Node |
| PM2 | `npm install -g pm2` (chạy nền trên server; local dev không cần) |
| Reverse proxy | nginx / OpenLiteSpeed / Caddy... (chỉ cần trên server, trỏ domain → port app) |
| RAM | ~150MB cho app |
| Database | KHÔNG cần cài gì — SQLite tự tạo file `data/inbox.db` |

## Bước 1 — Lấy source & cài dependencies

Khuyên dùng `git clone` (để sau này cập nhật bằng `bash update.sh`):
```bash
cd /var/www
git clone https://github.com/dennyducnguyen/zalobot.git zalo-inbox
cd zalo-inbox
npm install --omit=dev
```
> Nếu nhận source dạng file nén thì giải nén rồi `npm install --omit=dev` — nhưng sẽ không dùng được `update.sh`.
> `better-sqlite3` và `sharp` tự tải binary theo hệ điều hành. Nếu lỗi build trên Linux: cài `build-essential python3` rồi `npm install` lại.

## Bước 2 — Tạo file cấu hình .env

```bash
cp .env.example .env
```
Sửa các giá trị:
```env
PORT=3001                        # Port app chạy (đổi nếu trùng port khác trên server)
HOST=127.0.0.1                   # Server: 127.0.0.1 (sau nginx). Local test: 0.0.0.0
APP_NAME=Zalo Inbox              # Tên hiển thị trên trang (đặt theo thương hiệu)
DB_PATH=./data/inbox.db          # Giữ nguyên
ADMIN_USERNAME=admin             # Tài khoản đăng nhập web đầu tiên
ADMIN_PASSWORD=<đặt mật khẩu mạnh>
ZALO_PROXY=                      # Bỏ trống. Chỉ điền nếu cần proxy: http://user:pass@ip:port
AI_SECRET_KEY=                   # Trợ lý AI: khóa mã hóa key/token. Tạo bằng `openssl rand -base64 32`. Bỏ trống → app tự sinh data/secret.key
AI_OAUTH_LOCAL_CALLBACK=         # Để trống trên server. Chỉ đặt =1 khi chạy local để đăng nhập ChatGPT tự động
```
> `ADMIN_USERNAME/ADMIN_PASSWORD` chỉ dùng để **tạo tài khoản lần đầu** (khi database trống). Sau đó đổi mật khẩu/thêm user trong trang Cài đặt.
> Trợ lý AI cấu hình hoàn toàn trên web (`/ai.html`), không cần thêm gì vào `.env` ngoài 2 dòng trên (đều tùy chọn). Hướng dẫn: [docs/AI.md](docs/AI.md).

## Bước 3 — Chạy thử

```bash
npm start        # hoặc: npm run dev (tự reload khi sửa code)
```
Mở `http://localhost:3001` (đúng PORT trong .env) → thấy trang đăng nhập là OK.

## Bước 4 — Chạy nền bằng PM2 (server)

```bash
pm2 start src/server.js --name zalo-inbox
pm2 save
pm2 startup      # để tự chạy lại khi reboot server (làm 1 lần)
```

## Bước 5 — Trỏ domain (nginx)

Tạo vhost proxy domain → port app. Mẫu nginx:

```nginx
server {
    listen 80;
    server_name zalo.tenmien.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE realtime (bắt buộc để inbox nhận tin realtime)
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```
Sau đó cài SSL (certbot/acme.sh tùy hệ thống):
```bash
certbot --nginx -d zalo.tenmien.com
```
> **Lưu ý nếu dùng vhost proxy + acme.sh webroot:** request `/.well-known/acme-challenge/` có thể bị proxy vào Node → cấp SSL fail. Thêm location riêng trỏ về webroot của acme trước location `/`:
> ```nginx
> location /.well-known/acme-challenge/ { root /var/www/html; }
> ```

## Bước 6 — Kết nối Zalo & bắt đầu dùng

1. Mở `https://zalo.tenmien.com` → đăng nhập bằng ADMIN_USERNAME/ADMIN_PASSWORD
2. Bấm **"Quét QR kết nối"** → mở app Zalo trên điện thoại → quét mã
3. Hệ thống tự import bạn bè + nhóm về danh bạ
4. Vào **Cài đặt & API** → tạo API key nếu cần gọi API từ hệ thống ngoài (tài liệu API kèm ví dụ curl có ngay trên trang, hoặc xem [API.md](API.md))

## Kiểm tra sau khi setup

```bash
curl https://zalo.tenmien.com/health
# → {"service":"zalo-inbox","status":"running","zalo_connected":true}
```
- Gửi thử 1 tin từ điện thoại vào nick Zalo đã kết nối → tin hiện realtime trên inbox web
- Restart thử `pm2 restart zalo-inbox` → kênh Zalo tự khôi phục, KHÔNG cần quét QR lại

## Sự cố thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `npm install` lỗi better-sqlite3/sharp | Dùng Node v20 LTS; Linux cài `build-essential python3` |
| Quét QR xong không kết nối | Xem log `pm2 logs zalo-inbox` + file `logs/login/`. Thử `npm install zca-js@latest` (thư viện unofficial, Zalo đổi API thì cần bản mới — repo: github.com/RFS-ADRENO/zca-js) |
| Kênh hay bị văng / "SESSION_EXPIRED" | Nick Zalo đăng nhập nơi khác sẽ đá phiên; hạn chế đăng xuất app; quét QR lại |
| Inbox không nhận tin realtime | Kiểm tra vhost nginx có `proxy_buffering off` (SSE); app vẫn tự refresh mỗi 60s |
| Quên mật khẩu admin | Xóa file `data/inbox.db` (MẤT hết tin nhắn/danh bạ) hoặc nhờ người còn đăng nhập được đổi hộ trong Cài đặt |
| Tiếng Việt lỗi khi test API bằng curl trên Windows | Lưu body JSON vào file UTF-8, gọi `--data-binary @body.json` (xem [API.md](API.md)) |

## Cấu trúc dữ liệu & backup

- Toàn bộ dữ liệu (users, API keys, phiên Zalo, danh bạ, tin nhắn, cấu hình + provider Trợ lý AI) nằm trong **1 file `data/inbox.db`** → backup chỉ cần copy file này (kèm `.env`)
- Nếu không đặt `AI_SECRET_KEY` trong `.env`, khóa mã hóa key/token AI nằm ở **`data/secret.key`** → phải backup kèm, mất file này là mất toàn bộ API key/token đã lưu (phải nhập lại)
- Ảnh do AI tạo lưu `public/uploads/ai/` (tự dọn sau 30 ngày); cache ảnh khách gửi trong `tmp/ai-img/` (tự dọn sau 1 giờ)
- Log theo ngày trong `logs/` (app / login / error)
- Lịch sử tin nhắn chỉ có **từ lúc kênh kết nối trở đi** (Zalo không cho lấy lịch sử cũ)

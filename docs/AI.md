# Trợ lý AI — hướng dẫn sử dụng

Trang cấu hình: **`https://<domain>/ai.html`** (đăng nhập bằng tài khoản web). Mọi thứ cấu hình trên web, không cần sửa `.env`.

## 1. Thiết lập lần đầu (5 phút)

1. **Tab Provider → "+ Thêm provider"**
   - **Gemini (khuyên dùng)**: dán API key từ Google AI Studio → bấm *Kiểm tra key & tải model* → chọn model chat (mặc định gợi ý bản `flash`) và model tạo ảnh (nếu muốn dùng tool tạo ảnh) → *Thêm provider*.
   - **OpenAI**: tương tự với key `sk-...`.
   - **OpenAI-compatible**: điền Base URL (`https://openrouter.ai/api/v1`, DeepSeek, Groq...) + key.
   - **ChatGPT subscription**: tạo provider → hộp *Đăng nhập ChatGPT* hiện ra (xem mục 2).
   - Provider đầu tiên tự được gán vai trò **Provider chat**. Nên thêm provider thứ hai làm **dự phòng**.
2. **Tab Instruction & Thử nhanh**: viết instruction (bạn là ai, bán gì, giờ mở cửa, chính sách, cách xưng hô, việc gì không được hứa...). Bấm *Lưu instruction*, rồi chat thử ở khung bên phải — **không gửi lên Zalo**.
3. **Tab Phạm vi trả lời**: chọn AI trả lời ai (cá nhân: tất cả / chỉ người lạ / chỉ danh bạ; nhóm: chỉ khi được tag / mọi tin / tắt + danh sách nhóm), khung giờ, câu trả lời cố định.
4. Bật **công tắc tổng** ở đầu trang. Từ lúc này tin nhắn mới đến sẽ được AI trả lời (tin cũ không xử lý).

## 2. Đăng nhập ChatGPT subscription (Plus/Pro)

Cơ chế dùng đăng nhập của OpenAI Codex CLI. Trình duyệt sẽ chuyển về địa chỉ `http://localhost:1455/auth/callback?...` — địa chỉ này **không mở được** (trên VPS không có gì lắng nghe), đó là điều bình thường.

1. Trong bảng provider bấm **Đăng nhập ChatGPT** → **Mở trang đăng nhập** → đăng nhập tài khoản ChatGPT, cho phép Codex.
2. Khi trình duyệt báo "không kết nối được" tại `localhost:1455/...`, **copy toàn bộ URL trên thanh địa chỉ**.
3. Dán vào ô *URL callback* → **Hoàn tất đăng nhập**. Hệ thống đổi mã lấy token, lưu mã hóa, tải danh sách model của tài khoản và chọn model mặc định.
4. Token tự làm mới. Khi tài khoản bị thu hồi, provider chuyển sang trạng thái **CẦN ĐĂNG NHẬP LẠI** và AI tự dùng provider dự phòng (nếu có).

> ⚠️ Đây là đường **không chính thức**. OpenAI có thể khóa tài khoản hoặc đổi cơ chế bất kỳ lúc nào. Luôn cấu hình provider dự phòng.
> Chạy local trên máy có trình duyệt: đặt `AI_OAUTH_LOCAL_CALLBACK=1` trong `.env` để server tự bắt callback, không cần dán URL.

## 3. Cách AI hoạt động

- **Ngữ cảnh**: 20 tin gần nhất trong 12 giờ (chỉnh ở *Nâng cao*), gồm cả câu nhân viên đã trả lời. Trong nhóm mỗi tin có tên người gửi.
- **Gom tin**: khách gửi nhiều tin liên tiếp trong 3 giây → một câu trả lời.
- **Ảnh khách gửi**: được tải, thu nhỏ và đưa vào ngữ cảnh (3 ảnh gần nhất). Tắt ở *Nâng cao → Đọc ảnh*.
- **Trả lời trong nhóm**: quote tin hỏi + tag tên người hỏi (tắt được ở *Phạm vi*).
- **Tin dài**: tự tách theo giới hạn ký tự (mặc định 1200).
- **Tools** (tab Tools): *Xem giờ* (luôn bật), *Chuyển cho nhân viên* (AI gọi khi khách muốn gặp người → hội thoại gắn cờ 🙋, AI ngừng trả lời tới khi bạn bật lại), *Tạo ảnh* (tắt mặc định; cần chọn *Provider tạo ảnh*; ảnh gửi sau câu trả lời).
- **Provider lỗi**: thử dự phòng; hết đường thì im lặng và ghi nhật ký (có thể đặt câu "hệ thống đang bận" ở *Phạm vi*).

## 4. Bàn giao người thật

| Tình huống | Hành vi |
|---|---|
| Nhân viên trả lời từ **web Inbox** hoặc **app Zalo** trên điện thoại | AI **tạm dừng 30 phút** trong hội thoại đó (chỉnh ở *Nâng cao*) |
| Chủ kênh gõ trong hội thoại (từ app Zalo) `/ai off` | Tắt AI cho hội thoại đó cho tới khi `/ai on` |
| `/ai on` | Bật lại, bỏ tạm dừng / bỏ cờ cần người |
| `/ai status` | Không gửi gì ra Zalo, chỉ cập nhật trạng thái trên web |
| Khách gõ `/new` | AI quên ngữ cảnh cũ, trả lời câu xác nhận (sửa ở *Phạm vi*) |
| Trong Inbox, chip **AI: ...** ở đầu khung chat | Menu: bật / tắt riêng hội thoại, theo cấu hình chung, tiếp tục ngay, làm mới hội thoại |

Danh sách hội thoại: 🤖 AI đang bật · ⏸️ tạm dừng · 🙋 cần người. Tin do AI gửi có nhãn **🤖 AI**.

## 5. Nhật ký & chi phí

Tab **Nhật ký**: từng lượt AI với provider, model, tokens vào/ra, thời gian, tool đã gọi, lỗi. Click một dòng để xem chi tiết. Tab **Tổng quan** có số lượt và tokens hôm nay. Nhật ký giữ 30 ngày.

## 6. Bảo mật

- API key / token OAuth mã hóa AES-256-GCM, khóa trong `.env` (`AI_SECRET_KEY`) hoặc `data/secret.key`. Không bao giờ hiển thị lại key; chỉ có thể *Đổi key*.
- Ảnh khách gửi chỉ được tải từ domain Zalo CDN (danh sách ở *Nâng cao*).
- Mọi thao tác trên trang Trợ lý AI cần đăng nhập web.

## 7. Sự cố thường gặp

| Hiện tượng | Kiểm tra |
|---|---|
| AI không trả lời | Công tắc tổng bật chưa? Kênh Zalo đã kết nối? Tab Tổng quan có cảnh báo vàng? Nhật ký có dòng *BỎ QUA: paused/thread_off/not_mentioned*? |
| Trong nhóm không trả lời | Chế độ nhóm là *chỉ khi được tag* → khách phải @tag tài khoản kênh hoặc reply vào tin của bot |
| "API key không hợp lệ" | Key sai/hết hạn hoặc chưa bật billing (Gemini/OpenAI) |
| ChatGPT: CẦN ĐĂNG NHẬP LẠI | Token bị thu hồi → bấm *Đăng nhập lại* |
| Tool tạo ảnh "không khả dụng" | Chưa chọn *Provider tạo ảnh* hoặc provider Gemini chưa chọn model ảnh |

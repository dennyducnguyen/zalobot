# Kế hoạch thực thi — Trợ lý AI tự động trả lời kênh Zalo

> Trạng thái: **ĐÃ TRIỂN KHAI** (bước 1–9 hoàn tất ngày 2026-09-05, 44 test pass; chưa deploy VPS). Hướng dẫn dùng: [AI.md](AI.md).
> Khác biệt so với bản kế hoạch: bảng ai_* tạo trong `services/ai/store.js` (không trong `db.js`) để tránh đụng MCP; thêm cột `ai_thread_state.reset_msg_id` (mốc reset theo id tin, chính xác hơn `reset_at`); cột `ai_providers.embed_dims`/`embed_model` có sẵn nhưng UI chưa có màn hình embedding (để dành RAG). Ngày viết kế hoạch: 2026-09-05.
> Phạm vi: làm trọn gói từ đầu — provider (Gemini API key, OpenAI API key, ChatGPT subscription), instruction, bật/tắt theo nhiều cấp, `/new`, trả lời cá nhân + nhóm (tag hoặc mọi tin), **đọc ảnh khách gửi**, **tool calling** (ít tool, bật/tắt từng tool, có tool tạo ảnh), kiến trúc **sẵn cho RAG** (chưa làm RAG).

Tên tính năng trong UI: **"Trợ lý AI"** (để phân biệt với card "Kết nối AI / MCP" đã có trong Cài đặt — card đó là cho công cụ AI bên ngoài gọi vào qua MCP, không liên quan).

---

## 0. Tóm tắt quyết định thiết kế

| Vấn đề | Quyết định | Lý do |
|---|---|---|
| Vị trí móc vào code cũ | Một điểm duy nhất trong listener của `zaloService.js` sau khi lưu tin `direction='in'`; thêm hook "người thật vừa trả lời" ở `/app/send` và tin `isSelf` từ app | Không đụng luồng chống trùng tin hiện có |
| Provider abstraction | Interface trung lập `chat(req) → {content, toolCalls, usage}` có **tools + images**, thêm optional `embed()` và `generateImage()` | Cần tool ngay; embed để dành cho RAG |
| SDK | `fetch` native của Node 22, không thêm SDK `openai`/`@google/genai` | Ít dependency, VPS 960 MB RAM |
| Gemini | Chat qua **endpoint OpenAI-compatible** của Google (dùng chung adapter với OpenAI); tạo ảnh + embedding qua **REST native** `generativelanguage.googleapis.com/v1beta` | OpenAI-compat đủ cho chat/tool/vision; ảnh & embedding cần API native |
| ChatGPT subscription | OAuth PKCE theo client Codex CLI, gọi `chatgpt.com/backend-api/codex/responses` (SSE), tạo ảnh qua tool `image_generation` — port từ bản tham khảo, **bỏ pool nhiều tài khoản** | 1 kênh = 1 tài khoản là đủ; cảnh báo rủi ro trong UI |
| Đăng nhập ChatGPT trên VPS | **Dán URL callback**: server sinh link, người dùng đăng nhập, trình duyệt redirect về `localhost:1455/...` (không tải được), copy URL dán vào trang Trợ lý AI | Redirect URI cố định, không mở được cổng trên VPS; không cần SSH tunnel |
| Lưu secret | AES-256-GCM trong SQLite, khóa từ `AI_SECRET_KEY` (.env); thiếu thì tự sinh vào `data/secret.key` | Backup vẫn là `inbox.db` + `.env` (+ `secret.key`) |
| Bộ nhớ hội thoại | Dùng bảng `messages` sẵn có + mốc reset trong `ai_thread_state` | Không nhân đôi dữ liệu |
| Streaming | Không dùng (ChatGPT bắt buộc SSE thì gom lại rồi trả) | Zalo không hiển thị stream |
| Tool ban đầu | `generate_image` (bật/tắt), `handoff_to_human` (bật/tắt), `get_current_time` (luôn bật) | Ít, hữu ích, chứng minh được vòng lặp tool |
| RAG | **Chưa làm**, nhưng chốt sẵn: interface `KnowledgeRetriever`, schema bảng `knowledge_*`, cấu hình embedding, vị trí ghép vào prompt | Làm sau chỉ thêm module, không sửa engine |

---

## 1. Kiến trúc tổng thể

```
Zalo (zca-js listener)
   │ tin đến (text / photo / ...), mentions, quote
   ▼
zaloService._storeMessage  ──► messages (SQLite, thêm cột meta)
   │ emit 'message'
   ▼
aiEngine.onIncoming(row, raw)          src/services/ai/engine.js
   │
   ├─ policy.decide()                  src/services/ai/policy.js
   │    master on/off · thread on/off · tạm dừng do người thật · rule DM · rule nhóm (tag/quote/all + whitelist)
   │    · khung giờ · cooldown/quota · lệnh /new, /ai on|off · loại tin hỗ trợ
   │
   ├─ debounce theo thread (3 s) — gom nhiều tin liên tiếp thành 1 lượt
   │
   ▼
runTurn(threadId)
   ├─ context.build()                  src/services/ai/context.js
   │    system = instruction + persona fields + [knowledge snippets — hook, hiện rỗng]
   │    history = N tin sau mốc reset, ảnh gần nhất tải về → data URL (sharp resize)
   │
   ├─ agent loop (≤ 4 vòng tool)       src/services/ai/agent.js
   │    provider.chat(req) → toolCalls? → tools.run() → append → chat lại
   │    lỗi provider chính → thử provider dự phòng (nếu có)
   │
   ├─ gửi trả lời: zaloChannel.sendText(..., source 'ai', {quote, mentions})
   │    tách tin dài; trong nhóm: quote tin hỏi + mention người hỏi
   │    ảnh do tool tạo → zaloChannel.sendImage(...) sau phần text
   │
   └─ ai_logs (provider, model, tokens, latency, tools, lỗi) → SSE 'ai_log'
```

Thư mục mới:

```
src/services/ai/
  engine.js            # điều phối: onIncoming, onHumanReply, debounce, lock, runTurn
  policy.js            # thuần logic quyết định — test được bằng node --test
  context.js           # dựng system prompt + history + ảnh
  agent.js             # vòng lặp chat ↔ tool
  commands.js          # /new, /ai on|off, /ai status
  settings.js          # đọc/ghi ai_settings với default + validate (zod đã có trong deps)
  secrets.js           # AES-256-GCM
  images.js            # tải ảnh Zalo → resize → data URL; lưu ảnh AI tạo vào public/uploads/ai/
  providers/
    types.js           # JSDoc typedef ChatRequest/ChatResponse/ToolDef — hợp đồng chung
    manager.js         # tạo instance từ ai_providers, cache, chọn provider chính/dự phòng/ảnh/embedding
    openaiCompat.js    # Chat Completions qua fetch: tools, images, listModels, embed
    gemini.js          # extends openaiCompat: base URL Google, lọc model, generateImage & embed native REST
    chatgpt.js         # Codex Responses API SSE: chat, tools, images, generateImage, listModels
    chatgptOAuth.js    # PKCE, authorize URL, đổi code, refresh, decode id_token, trạng thái login
  tools/
    index.js           # registry: list(enabledOnly), toOpenAITools(), run(name, args, ctx)
    generateImage.js
    handoffToHuman.js
    getCurrentTime.js
  knowledge/
    index.js           # interface KnowledgeRetriever + NoopRetriever (RAG sau này cắm vào đây)
src/routes/ai.js       # /app/ai/* — mount trong web.js sau router.use(webAuth)
public/ai.html, public/js/ai.js, (css thêm vào app.css)
tests/ai/*.test.js     # node --test cho policy, context, sse parser, secrets, commands
```

---

## 2. Cơ sở dữ liệu (SQLite, tạo idempotent trong `db.js`)

### 2.1 Sửa bảng cũ

- `messages` thêm cột `meta TEXT DEFAULT NULL` (JSON: `{ mentions: [...], quote: {...}, msgType }`). Dùng `PRAGMA table_info` kiểm tra rồi `ALTER TABLE ADD COLUMN` nếu chưa có. Cần cho chế độ "chỉ trả lời khi được tag / reply vào bot" và để quote lại đúng tin.
- `messages.source` thêm giá trị `'ai'` (không đổi schema, chỉ quy ước). Inbox hiển thị nhãn 🤖.

### 2.2 Bảng mới

```sql
-- Cấu hình dạng key/value JSON — đơn giản, thêm setting không cần migrate
CREATE TABLE IF NOT EXISTS ai_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,            -- JSON
    updated_at INTEGER
);

-- Provider đã cấu hình. Secret luôn mã hóa. Một kind có thể có nhiều dòng (vd 2 key Gemini) nhưng phase này UI chỉ cần 1 dòng/kind.
CREATE TABLE IF NOT EXISTS ai_providers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL CHECK (kind IN ('gemini','openai','openai_compat','chatgpt')),
    name         TEXT NOT NULL,          -- nhãn hiển thị, unique
    base_url     TEXT DEFAULT '',        -- chỉ openai_compat
    secret_enc   TEXT DEFAULT '',        -- API key (gemini/openai/compat) hoặc JSON token OAuth (chatgpt), AES-256-GCM
    chat_model   TEXT DEFAULT '',
    image_model  TEXT DEFAULT '',        -- gemini / chatgpt
    embed_model  TEXT DEFAULT '',        -- gemini / openai — để dành cho RAG
    embed_dims   INTEGER DEFAULT 0,
    is_enabled   INTEGER DEFAULT 1,
    status       TEXT DEFAULT 'unverified', -- unverified | ok | error | needs_reauth
    status_note  TEXT DEFAULT '',
    meta         TEXT DEFAULT '{}',      -- JSON: email/accountId (chatgpt), catalog model đã tải, verified_at
    created_at   INTEGER, updated_at INTEGER,
    UNIQUE(name)
);

-- Trạng thái AI theo từng hội thoại
CREATE TABLE IF NOT EXISTS ai_thread_state (
    thread_id        TEXT PRIMARY KEY,
    ai_enabled       INTEGER DEFAULT NULL,   -- NULL = theo cấu hình chung; 0/1 = ghi đè
    reset_at         INTEGER DEFAULT 0,      -- mốc /new — chỉ lấy history sau mốc này
    paused_until     INTEGER DEFAULT 0,      -- tạm dừng vì người thật vừa trả lời
    needs_human      INTEGER DEFAULT 0,      -- tool handoff_to_human đã gọi
    last_reply_at    INTEGER DEFAULT 0,
    reply_count_day  INTEGER DEFAULT 0,
    reply_count_date TEXT DEFAULT '',        -- 'YYYY-MM-DD' để reset quota ngày
    updated_at       INTEGER
);

-- Nhật ký từng lượt AI
CREATE TABLE IF NOT EXISTS ai_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id     TEXT NOT NULL,
    trigger_msg_id INTEGER,                  -- messages.id của tin kích hoạt (tin cuối trong nhóm gom)
    provider_id   INTEGER, provider_kind TEXT, model TEXT,
    status        TEXT NOT NULL,             -- ok | error | skipped | fallback
    skip_reason   TEXT DEFAULT '',           -- khi status=skipped: master_off, thread_off, paused, not_mentioned, ...
    input_tokens  INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    latency_ms    INTEGER DEFAULT 0,
    tool_calls    TEXT DEFAULT '[]',         -- JSON [{name,args_summary,ok,ms}]
    reply_preview TEXT DEFAULT '',
    error         TEXT DEFAULT '',
    created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_logs_thread ON ai_logs (thread_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_created ON ai_logs (created_at DESC);
```

`ai_logs` chỉ ghi `skipped` cho các lý do đáng quan tâm (bị tắt theo thread, tạm dừng, quota); không ghi cho mọi tin nhóm không tag để tránh phình bảng. Có job dọn log cũ hơn 30 ngày khi boot.

### 2.3 Schema để dành cho RAG (CHƯA tạo, chỉ chốt thiết kế)

```sql
CREATE TABLE knowledge_docs   (id, title, source_type /*text|file|url*/, mime, size, status, chunk_count, embed_model, embed_dims, created_at, updated_at);
CREATE TABLE knowledge_chunks (id, doc_id, ord, text, embedding BLOB /*float32 LE*/, token_count, created_at);
CREATE TABLE knowledge_files  (id, doc_id, path /*data/knowledge/<id>.<ext>*/, sha256);
```

Truy vấn: cosine similarity brute-force trong JS trên các chunk (đủ nhanh tới vài chục nghìn chunk; nếu vượt thì cân nhắc `sqlite-vec`). Không trộn vector của model/số chiều khác nhau: khi đổi `embed_model`/`embed_dims` phải re-embed toàn bộ (`knowledge_docs.embed_model` để phát hiện lệch).

---

## 3. Lớp provider

### 3.1 Hợp đồng chung (`providers/types.js`, JSDoc)

```js
/** @typedef {{ role:'user', content:string, images?:string[] }
 *          | { role:'assistant', content:string|null, toolCalls?:ToolCall[] }
 *          | { role:'tool', toolCallId:string, content:string }} ChatMessage */
/** @typedef {{ id:string, name:string, args:object }} ToolCall */
/** @typedef {{ name:string, description:string, parameters:object }} ToolDef */
/** @typedef {{ model:string, system?:string, messages:ChatMessage[], tools?:ToolDef[],
 *              maxTokens?:number, temperature?:number, reasoningEffort?:'low'|'medium'|'high', signal?:AbortSignal }} ChatRequest */
/** @typedef {{ content:string|null, toolCalls:ToolCall[], stopReason:'end'|'tool_use'|'max_tokens',
 *              usage:{inputTokens:number, outputTokens:number} }} ChatResponse */
```

Mỗi provider là class có:

| Method | gemini | openai / openai_compat | chatgpt |
|---|---|---|---|
| `chat(req)` | ✅ | ✅ | ✅ (gom SSE) |
| `listModels()` | ✅ (lọc `gemini-*`, bỏ embedding/tts/image…; fallback catalog cứng) | ✅ (lọc non-chat) | ✅ `GET /codex/models` |
| `listImageModels()` | ✅ (lọc model có khả năng sinh ảnh) | ❌ | ✅ trả cố định `gpt-image-*` |
| `generateImage({prompt, size, refImages?})` | ✅ REST native `:generateContent` với `responseModalities:["IMAGE"]` | ❌ | ✅ tool `image_generation` (port tham khảo) |
| `listEmbeddingModels()` / `embed({model, inputs, dims})` | ✅ REST native `:embedContent` / `:batchEmbedContents` | ✅ `/embeddings` | ❌ |
| `verify()` | gọi `listModels` + 1 lượt chat ngắn "Return only OK." | như trái | như trái |

Quy tắc trong `openaiCompat.js` giữ từ bản tham khảo: `max_completion_tokens` cho `gpt-5*`/`o*`; `reasoning_effort` chỉ gửi khi model chấp nhận; ảnh gửi dạng `image_url: { url: 'data:image/jpeg;base64,...' }`; tool call gom theo `index`; retry 429/5xx tối đa 3 lần với backoff và tôn trọng `Retry-After`; **không** retry 4xx khác. Che key trong mọi message lỗi (regex `AIza…`, `sk-…`).

### 3.2 `gemini.js`

- Chat: `baseURL = https://generativelanguage.googleapis.com/v1beta/openai/`, header `x-goog-api-client: zalo-inbox/1.0`.
- Ảnh: `POST /v1beta/models/{image_model}:generateContent` với `generationConfig.responseModalities: ["IMAGE","TEXT"]`, đọc `inlineData` (base64 + mimeType). Model ảnh chọn trong UI từ `listImageModels()`; không hardcode tên.
- Embedding: `POST /v1beta/models/{embed_model}:batchEmbedContents`, hỗ trợ `outputDimensionality`. Chỉ cần expose method; UI phase này không có màn hình embedding.

### 3.3 `chatgpt.js` + `chatgptOAuth.js`

Giữ nguyên hằng số/headers của bản tham khảo (hợp đồng với backend OpenAI): client id `app_EMoamEEZ73f0CkXaXp7hrann`, issuer `https://auth.openai.com`, redirect `http://localhost:1455/auth/callback`, scope `openid profile email offline_access`, headers `chatgpt-account-id`, `openai-beta: responses=experimental`, `originator: codex_cli_rs`, `session_id`.

Luồng đăng nhập (mặc định, chạy được trên VPS):
1. `POST /app/ai/chatgpt/login/start` → server sinh PKCE + state, lưu RAM (TTL 10 phút, chỉ 1 phiên), trả `authorize_url`.
2. UI mở tab mới; người dùng đăng nhập ChatGPT; trình duyệt redirect về `http://localhost:1455/auth/callback?code=…&state=…` và báo không kết nối được (bình thường).
3. Người dùng copy URL trên thanh địa chỉ, dán vào ô trên trang Trợ lý AI → `POST /app/ai/chatgpt/login/complete { callback_url }`.
4. Server kiểm `state`, đổi `code` → token, decode `id_token` lấy `chatgpt_account_id` + email, mã hóa JSON token lưu `ai_providers.secret_enc`, `status='ok'`.

Tùy chọn dev local (`AI_OAUTH_LOCAL_CALLBACK=1` trong .env): server mở thêm HTTP server tạm tại `127.0.0.1:1455` để bắt callback tự động như bản tham khảo.

Runtime: refresh khi `expiresAt - 60s < now` (dedupe bằng promise chung); 401 → refresh 1 lần rồi thử lại; vẫn 401 hoặc `invalid_grant` → `status='needs_reauth'`, UI hiện nút "Đăng nhập lại", engine tự chuyển sang provider dự phòng. Parse SSE giữ đủ 3 nguồn `function_call` (output_item.done, arguments.delta, completed.output) và **throw nếu stream đứt không có event kết thúc**.

Cảnh báo hiển thị cố định trong UI: đây là đường không chính thức, dùng để bot trả lời khách là ngoài mục đích của Codex CLI, có thể bị OpenAI khóa tài khoản hoặc đổi endpoint; nên cấu hình provider dự phòng.

### 3.4 `manager.js`

- Nạp `ai_providers` khi boot và khi có thay đổi (hot-reload, không restart): giải mã secret → instance → cache theo `id`.
- Vai trò lấy từ `ai_settings`: `chat_provider_id`, `fallback_provider_id`, `image_provider_id`, `embedding_provider_id` (để dành).
- `getChat()`, `getFallback()`, `getImage()`, `getEmbedding()`; trả lỗi rõ ràng "Chưa cấu hình provider" khi thiếu.

---

## 4. Engine, policy, lệnh

### 4.1 Cấu hình (`ai_settings`, defaults)

```jsonc
{
  "enabled": false,                       // công tắc tổng
  "assistant_name": "Trợ lý",
  "instruction": "",                      // system prompt chính
  "language": "vi",
  "reply_max_chars": 1200,                // gợi ý độ dài cho AI + ngưỡng tách tin
  "unknown_answer": "",                   // câu AI nên dùng khi không biết (ghép vào prompt), rỗng = để AI tự xử
  "dm_mode": "all",                       // off | all | non_contacts | contacts
  "group_mode": "mention",                // off | mention | all
  "group_whitelist": [],                  // [] = mọi nhóm; có phần tử = chỉ các thread_id này
  "history_limit": 20,                    // số tin lấy làm ngữ cảnh
  "history_max_age_hours": 12,            // quá thời gian này coi như hội thoại mới
  "image_history_limit": 3,               // số ảnh gần nhất đưa vào ngữ cảnh (ảnh cũ hơn → "[ảnh]")
  "vision_enabled": true,
  "debounce_ms": 3000,
  "human_pause_minutes": 30,              // tạm dừng khi người thật trả lời
  "cooldown_seconds": 5,                  // tối thiểu giữa 2 lượt trả lời/thread
  "daily_limit_per_thread": 200,          // 0 = không giới hạn
  "global_concurrency": 3,
  "turn_timeout_ms": 90000,
  "image_timeout_ms": 180000,
  "max_tool_rounds": 4,
  "humanize_delay_ms": [800, 2500],       // [min,max]; [0,0] = tắt
  "active_hours": null,                   // null = 24/7; { "tz":"Asia/Ho_Chi_Minh", "ranges":[["18:00","08:00"]], "days":[0,1,2,3,4,5,6] }
  "non_text_reply": "",                   // trả lời cố định cho sticker/file/voice; rỗng = bỏ qua im lặng
  "error_reply": "",                      // gửi khi provider lỗi hết; rỗng = im lặng (chỉ log)
  "reasoning_effort": "low",              // cho chatgpt/gpt-5 (chat nhanh)
  "temperature": 0.7,
  "tools": { "generate_image": false, "handoff_to_human": true, "get_current_time": true },
  "chat_provider_id": null, "fallback_provider_id": null, "image_provider_id": null, "embedding_provider_id": null
}
```

### 4.2 `policy.decide(input) → { action, reason }` (hàm thuần, test được)

Thứ tự kiểm tra:

1. Tin `direction='out'` hoặc `source='ai'` → bỏ qua (chống lặp). Tin `isSelf` từ app → gọi `onHumanReply`, đồng thời parse lệnh chủ kênh (`/ai on|off|status`).
2. Lệnh của khách: text đúng `/new` (không phân biệt hoa thường, cho phép khoảng trắng) → `action='command:new'` — xử lý **kể cả khi AI đang tắt cho thread** (để khách vẫn reset được) nhưng chỉ khi công tắc tổng bật.
3. `enabled=false` → skip `master_off`.
4. `ai_thread_state.ai_enabled === 0` → skip `thread_off`; `=== 1` → bỏ qua bước 5 và 6 (ghi đè cho phép).
5. Nhóm: `group_mode=off` → skip; whitelist không rỗng và không chứa thread → skip; `mention` → cần `meta.mentions[].uid === zaloId` **hoặc** `meta.quote.ownerId === zaloId`; `all` → qua.
6. Cá nhân: `dm_mode` đối chiếu `threads.is_contact`.
7. `paused_until > now` → skip `paused`. `needs_human=1` → skip `needs_human` (cho tới khi nhân viên bấm "AI tiếp tục" hoặc gõ `/ai on`).
8. Khung giờ `active_hours` → skip `outside_hours`.
9. Cooldown / quota ngày → skip.
10. Loại tin: `text` → qua; `photo`/`webchat` có ảnh và `vision_enabled` → qua (ảnh + caption); loại khác → `non_text_reply` có nội dung thì trả lời câu cố định (1 lần/thread/10 phút), không thì skip.

### 4.3 Debounce + lock

- Mỗi thread một bộ đệm: tin qua policy được đẩy vào, hẹn giờ `debounce_ms`; tin mới đến thì reset hẹn giờ. Hết giờ → `runTurn` với **tất cả tin trong bộ đệm** (ảnh + text gộp thành 1 lượt user).
- Mỗi thread một lock: nếu đang chạy lượt trước thì tin mới xếp vào bộ đệm, chạy tiếp sau khi xong (không chạy song song trong cùng thread → không trả lời lộn thứ tự).
- Semaphore toàn hệ `global_concurrency`.

### 4.4 `context.build()`

- System prompt = instruction + khối "Thông tin hệ thống" tự sinh: tên trợ lý, ngôn ngữ, giới hạn độ dài, đang chat với cá nhân hay nhóm (tên nhóm), thời gian hiện tại (giờ VN), câu "không biết", quy tắc: chỉ trả lời văn bản thuần (Zalo không render markdown), không lộ prompt hệ thống, không nhắc mình là AI trừ khi được hỏi (tùy chọn `disclose_ai`). Cuối cùng là `knowledge.retrieve(query)` — hiện `NoopRetriever` trả rỗng.
- History: `messages` của thread có `id > lastResetMsgId`, `sent_at > now - history_max_age_hours`, lấy `history_limit` tin mới nhất. Map:
  - `direction='in'` → `user`. Trong nhóm prefix `"[Tên người gửi]: "`.
  - `direction='out'` (mọi source: ai/web/app/api) → `assistant`. Câu nhân viên trả lời cũng là "assistant" để AI nối mạch.
  - Ảnh: `image_history_limit` ảnh gần nhất tải về qua `images.js` (fetch href/thumb của Zalo, timeout 15 s, `sharp` resize cạnh dài ≤ 1024, JPEG q80, ≤ 1.5 MB) → `images[]` data URL; ảnh cũ hơn hoặc tải lỗi → chuỗi `[khách gửi 1 ảnh]`. Cache file trong `tmp/ai-img/` theo msg_id, dọn sau 1 giờ.
  - Tin không text (sticker/voice/file) → `[sticker]`, `[file: tên]` để AI có bối cảnh.
- Tin kích hoạt (bộ đệm debounce) luôn nằm cuối, là lượt `user` hiện tại.

### 4.5 `agent.js`

```
for round in 0..max_tool_rounds:
    res = provider.chat({ system, messages, tools: enabledTools, model, maxTokens, temperature, reasoningEffort })
    if res.toolCalls.length == 0 → return { text: res.content, attachments }
    messages.push(assistant với toolCalls)
    for tc in res.toolCalls: out = tools.run(tc.name, tc.args, ctx) (timeout riêng, lỗi → nội dung lỗi trả về cho AI)
        messages.push({ role:'tool', toolCallId, content: JSON.stringify(out) })
hết vòng → gửi text cuối cùng có được, log 'max_tool_rounds'
```

Lỗi provider chính (mạng/5xx/429 sau retry/needs_reauth) → thử `fallback_provider_id` một lần (tools/ảnh giữ nguyên nếu provider dự phòng hỗ trợ). Hết đường → `error_reply` (nếu có) + log `error` + SSE `ai_error` cho UI.

### 4.6 Gửi trả lời

- Text: cắt theo đoạn/câu tại ngưỡng `reply_max_chars`, gửi lần lượt, cách nhau 600 ms. Trong nhóm: tin đầu **quote** tin hỏi (giữ `raw message.data` trong Map RAM 30 phút theo msgId để dựng `SendMessageQuote`) và **mention** người hỏi (`@Tên` đầu tin, `mentions:[{uid,pos:0,len}]`).
- Ảnh do tool tạo: `attachments[]` gom trong lượt, gửi **sau** text bằng `sendImage(threadId, dataURI, caption, 'ai')` — ảnh cũng được lưu `public/uploads/ai/` để Inbox hiển thị.
- `sendText/sendImage` nhận thêm tham số `opts = { quote, mentions }` (mở rộng tương thích ngược). Source `'ai'` được tính là tin server gửi → vẫn qua `_sentMsgIds` chống trùng như hiện tại.
- Độ trễ giống người `humanize_delay_ms` áp trước tin đầu.

### 4.7 Lệnh (`commands.js`)

| Ai gõ | Lệnh | Hành động |
|---|---|---|
| Khách (DM hoặc nhóm) | `/new` | `reset_at = now`, `needs_human=0`; bot trả lời ngắn "Đã bắt đầu hội thoại mới." (câu chỉnh được) |
| Chủ kênh từ app Zalo (isSelf) | `/ai off` | `ai_enabled=0` cho thread; tin lệnh vẫn được lưu nhưng đánh dấu `content_type='command'` để không hiển thị như tin thường (tùy chọn) |
| Chủ kênh | `/ai on` | `ai_enabled=1`, `paused_until=0`, `needs_human=0` |
| Chủ kênh | `/ai status` | bot gửi (chỉ vào thread đó) trạng thái ngắn |

Lệnh chủ kênh **không** được gửi ra Zalo dưới dạng trả lời để tránh khách thấy; phản hồi qua SSE/toast trên web và log.

### 4.8 Bàn giao người thật

- `onHumanReply(threadId, by)` gọi từ `/app/send` (web) và listener khi `isSelf && source='app'` → `paused_until = now + human_pause_minutes`, SSE `ai_paused`.
- Tool `handoff_to_human` → `needs_human=1`, thread hiện badge "🙋 cần người hỗ trợ" + tăng `unread_count`, SSE `ai_handoff`; AI trả lời khách câu chuyển tiếp do tool trả về (AI tự diễn đạt theo instruction).
- Inbox header có nút **"AI: Đang bật / Tạm dừng (còn 27 phút) / Tắt / Cần người"** bấm để đổi trạng thái ngay.

---

## 5. Tools (`tools/`)

Mỗi tool là module:

```js
module.exports = {
  name: 'generate_image',
  settingKey: 'tools.generate_image',       // bật/tắt trong UI; undefined = luôn bật
  requires: ['image_provider'],             // điều kiện khả dụng — thiếu thì không đưa vào danh sách tool
  definition: { description, parameters /* JSON Schema */ },
  async run(args, ctx) { ... return { ok, ... } },   // ctx: threadId, thread, settings, providers, attachments[], logger
};
```

| Tool | Mặc định | Mô tả | Kết quả trả cho AI |
|---|---|---|---|
| `get_current_time` | bật, không tắt được | giờ hiện tại múi giờ VN | `{ iso, human }` |
| `handoff_to_human` | bật | AI gọi khi khách yêu cầu gặp người/ngoài phạm vi; args `{ reason }` | `{ ok:true, note:"Đã báo nhân viên. Hãy nói với khách sẽ có người hỗ trợ sớm." }` + side effect mục 4.8 |
| `generate_image` | **tắt** | args `{ prompt, size?, use_last_image_as_reference? }`; gọi `providers.getImage().generateImage()`; ảnh đẩy vào `ctx.attachments` | `{ ok:true, note:"Ảnh sẽ được gửi kèm sau câu trả lời." }` hoặc `{ ok:false, error }` |

Giới hạn `generate_image`: tối đa 1 ảnh/lượt, timeout `image_timeout_ms`, chỉ khả dụng khi `image_provider_id` đã verify. Ảnh tham chiếu (nếu bật) = ảnh khách gửi gần nhất trong ngữ cảnh.

Thêm tool sau này = thêm 1 file + 1 dòng trong `tools/index.js` (ví dụ tương lai: `search_knowledge` khi có RAG, `lookup_order` gọi API CRM của khách).

---

## 6. API nội bộ `/app/ai/*` (cookie auth, mount sau `webAuth` trong `web.js`)

| Method | Path | Việc |
|---|---|---|
| GET | `/app/ai/settings` | toàn bộ `ai_settings` (đã merge default) + tóm tắt provider + trạng thái engine |
| PUT | `/app/ai/settings` | cập nhật một phần (validate zod), hot-apply |
| GET | `/app/ai/providers` | danh sách provider: kind, name, model, status, `has_secret`, email (chatgpt), **không trả secret** |
| POST | `/app/ai/providers` | tạo: `{kind, name, api_key?, base_url?, chat_model?, image_model?}` → verify thật → mã hóa lưu → hot-register |
| PATCH | `/app/ai/providers/:id` | đổi key/model/base_url/bật tắt; verify lại khi đổi key |
| DELETE | `/app/ai/providers/:id` | chặn nếu đang là chat/fallback/image provider |
| POST | `/app/ai/providers/preview` | `{kind, api_key, base_url?}` hoặc `{id}` → `{ chat_models[], image_models[], embedding_models[] }` (kiểm tra key trước khi lưu) |
| POST | `/app/ai/providers/:id/verify` | chạy lại verify, cập nhật status |
| POST | `/app/ai/chatgpt/login/start` | → `{ authorize_url, expires_in }` |
| POST | `/app/ai/chatgpt/login/complete` | `{ callback_url }` → lưu token, trả `{ email }` |
| GET | `/app/ai/chatgpt/login/status` | trạng thái phiên đăng nhập đang chờ (dùng cho chế độ callback local) |
| POST | `/app/ai/test` | `{ message, image_base64?, thread_id? }` → chạy đúng pipeline (context giả hoặc của thread) **không gửi Zalo**, trả `{ reply, tool_calls, usage, latency }` |
| GET | `/app/ai/threads/:id/state` · PUT | trạng thái AI của 1 thread; PUT `{ ai_enabled, resume:true }` |
| POST | `/app/ai/threads/:id/reset` | tương đương `/new` từ web |
| GET | `/app/ai/logs?thread_id=&status=&limit=` | nhật ký |
| GET | `/app/ai/stats` | hôm nay/7 ngày: số lượt, tokens, lỗi, theo provider |

SSE mới (qua hub sẵn có): `ai_log`, `ai_paused`, `ai_handoff`, `ai_error`, `ai_state` (khi thread state đổi).

REST `/api/v1` **không** mở endpoint AI ở phase này (có thể thêm `POST /api/v1/ai/threads/:id/toggle` cho CRM sau).

---

## 7. UI

### 7.1 Trang mới `ai.html` — "🤖 Trợ lý AI" (link ở topbar Inbox và Cài đặt)

Tab ngang:

1. **Tổng quan**: công tắc tổng lớn; trạng thái provider đang dùng; số lượt hôm nay; 5 log gần nhất; cảnh báo cấu hình thiếu.
2. **Provider**: bảng provider (kind, model, trạng thái, nút verify/sửa/xóa). Nút "+ Thêm provider" → dialog: chọn kind → gợi ý tên; Gemini/OpenAI khóa Base URL; dán key → "Kiểm tra key & tải model" → dropdown model chat / model ảnh; lưu. Kind ChatGPT: nút "Đăng nhập ChatGPT" → mở tab + ô dán URL callback + hướng dẫn 3 bước + cảnh báo rủi ro. Bên dưới: 3 dropdown vai trò **Provider chat / Dự phòng / Tạo ảnh**.
3. **Instruction**: textarea lớn (monospace, đếm ký tự), tên trợ lý, ngôn ngữ, độ dài, câu không biết, checkbox "tự giới thiệu là AI khi được hỏi". Khung **Thử nhanh** bên phải: chat giả với AI (kèm gửi ảnh) dùng đúng cấu hình, hiện tool đã gọi + tokens + thời gian.
4. **Phạm vi trả lời**: DM mode; Group mode; whitelist nhóm (chọn từ danh bạ nhóm, tìm theo tên); khung giờ; câu trả lời cho tin không phải text; câu khi lỗi.
5. **Tools**: danh sách tool với công tắc, mô tả, điều kiện (vd "cần provider tạo ảnh"); trạng thái khả dụng.
6. **Nâng cao**: debounce, tạm dừng khi người thật trả lời, cooldown, quota, concurrency, timeout, history, ảnh trong ngữ cảnh, reasoning effort, temperature, độ trễ giống người.
7. **Nhật ký**: bảng lọc theo thread/trạng thái, click xem chi tiết (prompt tóm tắt, tool calls, lỗi đầy đủ).

### 7.2 Inbox (`index.html`, `app.js`, `app.css`)

- Danh sách hội thoại: icon 🤖 khi AI đang hoạt động cho thread, 🙋 khi `needs_human`.
- Header chat: chip trạng thái AI (bật / tạm dừng còn X phút / tắt / cần người) bấm → menu: Bật, Tắt, Tiếp tục ngay, Làm mới hội thoại (`/new`).
- Bong bóng tin `source='ai'`: nhãn "🤖 AI" (thay chỗ hiện đang ghi "· API").
- Toast khi có `ai_handoff` / `ai_error`.

---

## 8. Bảo mật & vận hành

- Secret chỉ đi một chiều vào DB; API trả `has_secret` + 4 ký tự cuối key. Log che key/token.
- `AI_SECRET_KEY` (base64 32 byte) trong `.env`; nếu thiếu, sinh ngẫu nhiên lưu `data/secret.key` (mode 600) và ghi log cảnh báo "nên copy vào .env". SETUP.md hướng dẫn tạo bằng `openssl rand -base64 32`.
- Ảnh khách gửi chỉ tải từ domain Zalo CDN (`*.zadn.vn`, `*.zalo.me`, `*.zaloapp.com`); ảnh AI tạo lưu `public/uploads/ai/` (đã gitignore), dọn file cũ hơn 30 ngày.
- Chống lặp bot ↔ bot: không xử lý `source='ai'`; trong nhóm bỏ qua tin từ chính zaloId; cooldown; quota ngày.
- Tài nguyên: `sharp` đã có; giới hạn ảnh ≤ 1.5 MB sau resize, ≤ 3 ảnh/lượt; concurrency 3; timeout mọi fetch. Theo dõi RAM PM2 (giới hạn 400 MB hiện tại nên giữ).
- Khi kênh Zalo mất kết nối, engine bỏ qua và log `skipped:not_connected`, không xếp hàng chờ.

---

## 9. Kiến trúc sẵn cho RAG (làm sau, không thuộc phạm vi lần này)

Đã chốt để lần sau chỉ thêm, không sửa engine:

1. `knowledge/index.js` có interface `retrieve({ query, threadType, limit }) → [{ text, title, score }]`; engine luôn gọi và ghép kết quả vào system prompt trong khối `## Tài liệu tham khảo`. Hiện `NoopRetriever`.
2. `ai_providers.embed_model/embed_dims` + `ai_settings.embedding_provider_id` + `provider.embed()` đã có (Gemini/OpenAI).
3. Schema `knowledge_docs/chunks/files` (mục 2.3), file lưu `data/knowledge/`.
4. Khi làm: thêm tab "Kiến thức" (upload .txt/.md/.pdf/.docx → trích text → chunk ~500 token → embed → lưu BLOB), tool `search_knowledge` (để AI chủ động tra) hoặc chế độ auto-inject top-k, nút "re-embed" khi đổi model.

---

## 10. Thứ tự thực thi (mỗi bước chạy được và kiểm tra được)

| # | Bước | File chính | Kiểm tra |
|---|---|---|---|
| 1 | Nền: bảng mới, cột `messages.meta`, `secrets.js`, `settings.js` (default + zod), lưu `mentions/quote` trong listener, tham số `opts {quote, mentions}` cho `sendText/sendImage`, source `'ai'` | `db.js`, `zaloService.js`, `ai/secrets.js`, `ai/settings.js` | boot không lỗi trên DB cũ; test secrets round-trip; tin nhóm có meta |
| 2 | Provider OpenAI-compat + Gemini (chat, tools, images, listModels, embed, generateImage, verify) | `providers/types.js`, `openaiCompat.js`, `gemini.js`, `manager.js` | script `node tests/manual/provider.js` với key thật: chat, tool call, ảnh vào, tạo ảnh |
| 3 | Tools registry + 3 tool; `agent.js` vòng lặp | `tools/*`, `agent.js` | test agent với provider giả (mock) gọi tool rồi kết thúc |
| 4 | `context.js` + `images.js` | — | test: history sau reset, prefix tên trong nhóm, giới hạn ảnh, ảnh lỗi → placeholder |
| 5 | `policy.js` + `commands.js` | — | bộ test thuần cho mọi nhánh mục 4.2 và lệnh |
| 6 | `engine.js`: debounce, lock, semaphore, runTurn, gửi trả lời (tách tin, quote, mention, ảnh sau text), bàn giao người thật, log, SSE | `engine.js`, hook trong `zaloService.js`, `web.js /send`, `server.js` | chạy thật với kênh Zalo test: DM, nhóm tag, `/new`, `/ai off`, ảnh, tool ảnh |
| 7 | ChatGPT: OAuth dán URL (+ callback local tùy chọn), provider Codex SSE, refresh, models, generateImage | `chatgptOAuth.js`, `chatgpt.js` | đăng nhập thật, chat, tool, ảnh; giả lập 401 → refresh; needs_reauth → fallback |
| 8 | Routes `/app/ai/*` | `routes/ai.js`, mount `web.js` | curl từng endpoint; preview key sai → 401 có che key |
| 9 | UI `ai.html`/`ai.js` + Inbox (chip AI, badge, nhãn 🤖) + CSS | `public/*` | duyệt bằng trình duyệt: thêm provider Gemini, thử nhanh, bật AI, đổi trạng thái thread |
| 10 | Tài liệu + triển khai: README (tính năng), SETUP.md (`AI_SECRET_KEY`, `AI_OAUTH_LOCAL_CALLBACK`), CLAUDE.md/AGENTS.md (quy tắc mới: source `'ai'`, hook, không log secret), `.env.example`; deploy VPS `<ten>`: pull, `npm install` (không thêm dep mới), `pm2 restart` | docs | health OK, log sạch, chạy thử 1 DM thật |

Ước lượng: bước 1–6 khoảng 3 ngày, bước 7 khoảng 1 ngày, bước 8–10 khoảng 1,5 ngày. Tổng **5–6 ngày công**.

Kiểm thử: dùng `node --test tests/` cho phần thuần (policy, commands, context, SSE parser, secrets); phần gọi provider thật để trong `tests/manual/` chạy tay với key trong `.env` local, không chạy tự động.

---

## 11. Các điểm cần bạn xác nhận khi review

1. **Mặc định tool `generate_image` tắt**, `handoff_to_human` bật — đúng ý chưa?
2. **Nhân viên trả lời từ web/app → AI tạm dừng 30 phút** trong thread đó. Muốn mặc định khác hoặc muốn "tắt hẳn cho tới khi bật lại"?
3. Trong nhóm, bot **quote + mention** người hỏi. Có muốn tắt được không (một số nhóm thấy phiền)?
4. Câu trả lời của nhân viên (source web/app) được đưa vào ngữ cảnh như lời của assistant — để AI nối mạch. Đồng ý?
5. ChatGPT subscription: chỉ 1 tài khoản, không pool. Đủ chưa?
6. Provider `openai_compat` (OpenRouter/DeepSeek/Groq…) làm luôn vì gần miễn phí công — giữ hay bỏ để UI gọn?
7. Ảnh khách gửi: chỉ lấy 3 ảnh gần nhất vào ngữ cảnh, resize ≤ 1024 px. Ổn không?
8. Khi provider lỗi hết: mặc định **im lặng + log** (không gửi câu lỗi cho khách). Muốn mặc định có câu "Hệ thống đang bận, vui lòng chờ" không?

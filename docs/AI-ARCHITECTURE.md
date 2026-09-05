# Trợ lý AI — kiến trúc & bản đồ mã nguồn (tài liệu tra cứu cho AI/dev)

> Đọc file này trước khi sửa bất kỳ thứ gì trong `src/services/ai/`, `src/routes/ai.js`, `public/ai.html`, `public/js/ai.js`.
> Thiết kế gốc và các quyết định: [AI-PLAN.md](AI-PLAN.md). Hướng dẫn người dùng: [AI.md](AI.md).

## 1. Tổng quan một câu

Tin nhắn Zalo đến → listener lưu DB → emit `ai_incoming` → **engine** quyết định (policy) → gom tin (debounce) → dựng ngữ cảnh từ bảng `messages` → **agent loop** gọi provider LLM (kèm tool) → gửi trả lời qua `zaloChannel.sendText/sendImage` với `source='ai'` → ghi `ai_logs` → SSE cho UI.

## 2. Bản đồ file

| File | Vai trò | Sửa khi |
|---|---|---|
| `src/services/ai/engine.js` | Singleton `AiEngine` (EventEmitter). `init({channel})`, `onIncoming`, `onHumanReply`, debounce/lock/semaphore, `runTurn`, gửi trả lời (tách tin, quote, mention), log, `testRun`, `threadStatus`, `setThreadState`, `resetThread`, `markNeedsHuman`. Chứa `LoginSessionManager` cho ChatGPT (persist mã hóa trong `ai_settings.chatgpt_login_pending`). | Đổi luồng xử lý một lượt, cách gửi, hàng đợi |
| `src/services/ai/policy.js` | Hàm thuần `decide()` → `skip / reply / command_new / non_text_reply` + lý do. `isAddressedToBot`, `isWithinActiveHours`, `todayKey`. Không I/O. | Thêm rule bật/tắt, điều kiện trả lời |
| `src/services/ai/commands.js` | Parse `/new` (khách) và `/ai on|off|status`, `/new` (chủ kênh từ app). | Thêm lệnh chat |
| `src/services/ai/context.js` | `buildSystemPrompt()` (instruction + khối thông tin hệ thống + knowledge) và `build()` lấy history sau mốc reset, gom tin liên tiếp, tải ảnh gần nhất, prefix tên trong nhóm. | Đổi prompt hệ thống, cách dựng history |
| `src/services/ai/agent.js` | `runAgent()`: vòng chat ↔ tool tối đa `max_tool_rounds`. Trả `{text, toolCalls, usage, rounds}`. | Đổi cách xử lý tool call |
| `src/services/ai/settings.js` | `DEFAULTS` + zod schema + `createSettings()` (cache, `update(patch)` validate). Key ngoài DEFAULTS trong `ai_settings` bị bỏ qua khi load (dùng cho dữ liệu nội bộ như phiên login). | Thêm setting mới (thêm vào DEFAULTS + schema + UI) |
| `src/services/ai/store.js` | Tạo bảng `ai_*`, cột `messages.meta`; repo `settings/providers/threadState/logs/history`. Được `db.js` gọi ở cuối. | Thêm bảng/cột AI |
| `src/services/ai/secrets.js` | AES-256-GCM `encryptSecret/decryptSecret`, khóa `AI_SECRET_KEY` hoặc `data/secret.key`; `maskSecrets()` che key/token trong lỗi. | Không nên sửa; mọi secret phải đi qua đây |
| `src/services/ai/images.js` | Tải ảnh Zalo CDN (allowlist host, chặn IP), resize sharp ≤1024 → data URL, cache `tmp/ai-img/`; lưu ảnh AI tạo `public/uploads/ai/`; `cleanup()`. | Đổi giới hạn ảnh, host cho phép |
| `src/services/ai/providers/types.js` | JSDoc hợp đồng `ChatRequest/ChatResponse/ToolDef/ToolCall`; `ProviderError` (status, retryAfterMs, authFail, code, `retryable`). | Thêm field chung cho mọi provider |
| `src/services/ai/providers/http.js` | `fetchWithRetry/fetchJson`: timeout, retry 429/5xx/mạng, che secret trong lỗi. | — |
| `src/services/ai/providers/openaiCompat.js` | Chat Completions qua fetch: map messages/tools/images, `max_completion_tokens` cho gpt-5/o-series, `reasoning_effort`, listModels, embed, verify. Dùng cho kind `openai` và `openai_compat`. | Thêm provider OpenAI-compatible mới chỉ cần baseURL |
| `src/services/ai/providers/gemini.js` | `extends OpenAICompatProvider`: chat qua endpoint OpenAI-compat của Google; catalog/model ảnh/embedding/tạo ảnh qua REST native `v1beta` (header `x-goog-api-key`). | Tính năng riêng Gemini |
| `src/services/ai/providers/chatgptOAuth.js` | PKCE + hằng số client Codex CLI (**không đổi**), `exchangeCode/refreshAuth`, `parseCallbackInput`, `LoginSessionManager` (start / complete bằng URL dán / callback local 1455 / persist). | Luồng đăng nhập ChatGPT |
| `src/services/ai/providers/chatgpt.js` | Responses API SSE tại `chatgpt.com/backend-api/codex/responses`: chat (gom stream), tools, ảnh vào, `generateImage` (tool image_generation), listModels, refresh token, 401 → refresh 1 lần → `needs_reauth`. | Parse SSE, headers Codex |
| `src/services/ai/providers/manager.js` | DB row → instance (giải mã), cache theo `updated_at`, `getChat/getFallback/getImage/getEmbedding` theo vai trò trong settings, `publicInfo()` (không lộ secret), `KINDS`. | Thêm kind provider mới |
| `src/services/ai/tools/index.js` | Registry: `active(cfg)`, `definitions(cfg)`, `run(name,args,ctx)`, `describe()`. Mảng `TOOLS` là nơi đăng ký. | Thêm tool: thêm file + 1 dòng require |
| `src/services/ai/tools/getCurrentTime.js` · `handoffToHuman.js` · `generateImage.js` | 3 tool hiện có. Mẫu tool: `{ name, label, description, settingKey, definition:{description, parameters}, available(ctx), run(args, ctx) }`. | — |
| `src/services/ai/knowledge/index.js` | `NoopRetriever` + `formatSnippets()`. Điểm cắm RAG: implement `retrieve({query, threadType, limit})`. | Làm RAG |
| `src/routes/ai.js` | REST nội bộ `/app/ai/*` (mount trong `web.js` sau `webAuth`). | Thêm API quản trị |
| `public/ai.html` + `public/js/ai.js` | Trang Trợ lý AI 7 tab; modal thêm provider; modal đăng nhập ChatGPT; thử nhanh. `api()` luôn trả `{success,error}` không ném. | UI |
| `public/index.html` + `public/js/app.js` | Chip AI trong header chat (`aiChip`, `aiMenu`), icon 🤖/⏸️/🙋 trong danh sách (`aiIconFor`), nhãn nguồn tin (`sourceLabel`), SSE `ai_state/ai_handoff/ai_error`. | UI Inbox |
| `public/css/app.css` | Khối `/* Trợ lý AI */` cuối file; `.app.page-scroll` cho trang cuộn thường. | — |
| `test/ai-policy.test.js` · `ai-providers.test.js` · `ai-engine.test.js` · `ai-routes.test.js` | Test không gọi mạng (mock `globalThis.fetch`), engine chạy với kênh Zalo giả. `npm test`. | Mỗi lần sửa engine/policy/provider/routes |

## 3. Điểm móc vào code cũ (chỉ 4 chỗ)

1. `src/services/zaloService.js` listener: sau `_storeMessage` → `this.emit('ai_incoming', { row, raw: message.data, isSelf, threadType })`; lưu `meta` (mentions, quote, msgType) vào `messages.meta`.
2. `src/services/zaloService.js` `sendText(threadId, msg, source, threadType, opts)` — `opts.quote`, `opts.mentions` (chỉ áp cho nhóm).
3. `src/routes/web.js` `/send` → `zaloChannel.emit('ai_human_reply', {threadId, by:'web'})`; `/threads` trả thêm `ai: aiEngine.threadStatesSummary()`; mount `router.use('/ai', require('./ai'))`.
4. `src/server.js`: `aiEngine.init({ channel })` + nối event `state/log/handoff/error` → SSE `ai_state/ai_log/ai_handoff/ai_error`. `src/db.js`: `ai = createAiStore(db)` export.

## 4. Dữ liệu

| Bảng / cột | Nội dung |
|---|---|
| `ai_settings(key, value JSON)` | Cấu hình (xem `DEFAULTS` trong `settings.js`) + key nội bộ `chatgpt_login_pending` (phiên OAuth, mã hóa) |
| `ai_providers` | `kind` (gemini/openai/openai_compat/chatgpt), `name` unique, `base_url`, `secret_enc` (API key hoặc JSON token OAuth, mã hóa), `chat_model`, `image_model`, `embed_model`, `embed_dims`, `is_enabled`, `status` (unverified/ok/error/needs_reauth), `status_note`, `meta` JSON (models, image_models, embedding_models, email, accountId, verified_at) |
| `ai_thread_state` | `ai_enabled` NULL/0/1 (ghi đè theo thread), `reset_at`, `reset_msg_id` (history chỉ lấy `messages.id >` giá trị này), `paused_until`, `needs_human`, `last_reply_at`, `reply_count_day/date` |
| `ai_logs` | Mỗi lượt: `status` ok/fallback/error/skipped, `skip_reason`, provider/model, tokens, `latency_ms`, `tool_calls` JSON, `reply_preview`, `error`. Dọn >30 ngày khi boot |
| `messages.meta` | JSON `{ mentions:[{uid,pos,len,type}], quote:{ownerId,globalMsgId,cliMsgId,msg}, msgType }` |
| `messages.source='ai'` | Tin do AI gửi (Inbox hiện nhãn 🤖 AI; policy bỏ qua) |

Vai trò provider lưu trong settings: `chat_provider_id`, `fallback_provider_id`, `image_provider_id`, `embedding_provider_id` (để dành RAG).

## 5. Luồng chi tiết một lượt (engine.runTurn)

1. `onIncoming`: isSelf + source `app` → lệnh chủ kênh hoặc `onHumanReply` (tạm dừng `human_pause_minutes`). Khách → `policy.decide()`.
2. `reply` → đẩy vào buffer thread, hẹn `debounce_ms`; `command_new` → reset + gửi `new_session_reply`; `non_text_reply` → gửi câu cố định (1 lần/10 phút/thread).
3. Hết debounce → `_enqueue` (lock theo thread) → `_withSemaphore` (`global_concurrency`) → `runTurn(threadId, rows)`.
4. `runTurn` kiểm tra lại enabled/paused/needs_human/connected; nếu buffer thread lại có tin mới → bỏ lượt này (lượt sau xử lý chung).
5. `context.build()` → `runAgent(provider chính)`; lỗi retryable/auth/4xx → `runAgent(fallback)`.
6. Gửi: delay giống người → `splitText(reply_max_chars)` → tin đầu trong nhóm quote + mention (nếu `group_quote_reply`) → ảnh tool tạo gửi sau text → `_touchReplyCounters` → `_log` → emit.
7. Lỗi hết đường → log `error`, emit `error`, gửi `error_reply` nếu có.

Chống lặp: bỏ qua `direction=out`, `source=ai`, `sender_id = zaloId`; cooldown; quota ngày.

## 6. API `/app/ai/*` (cookie web)

`GET/PUT settings` · `GET providers` · `POST providers` (verify thật rồi lưu) · `POST providers/preview` (kiểm tra key, tải model) · `PATCH providers/:id` · `POST providers/:id/verify` · `DELETE providers/:id` (chặn nếu đang có vai trò) · `POST chatgpt/login/start|complete|cancel`, `GET chatgpt/login/status` · `POST test` (không gửi Zalo) · `GET/PUT threads/:id/state`, `POST threads/:id/reset` · `GET logs`, `GET stats`.

## 7. Cách mở rộng

- **Tool mới**: tạo `tools/<ten>.js` theo mẫu, thêm vào mảng `TOOLS`; nếu muốn bật/tắt trong UI đặt `settingKey` và thêm key vào `DEFAULTS.tools`.
- **Provider mới OpenAI-compatible**: không cần code, chọn kind `openai_compat` + Base URL. Provider có API riêng: viết class theo hợp đồng `types.js`, đăng ký trong `manager.makeInstance()` và `KINDS`, thêm vào CHECK của cột `kind` trong `store.js`.
- **Setting mới**: `DEFAULTS` + `schema` trong `settings.js` → dùng trong engine → thêm field UI trong `ai.html`/`ai.js` (fill + save).
- **RAG**: implement retriever trong `knowledge/`, dùng `providers.getEmbedding().embed()`; schema đề xuất `knowledge_docs/knowledge_chunks/knowledge_files` (AI-PLAN mục 2.3); vector BLOB float32, cosine brute-force trong JS.

## 8. Vận hành production (ví dụ)

- Chạy cùng PM2 `zalo-inbox-<ten>`; không dependency mới. `.env` có `AI_SECRET_KEY` (mất = mất mọi key/token AI đã lưu; backup cùng `inbox.db`). `AI_OAUTH_LOCAL_CALLBACK` để trống trên server.
- Deploy: tar các file đổi → scp `/var/tmp` → trên VPS: backup DB nhất quán + tar source cũ vào `/var/backups/zalo-inbox/<ngày>-ai`, `pm2 stop`, giải nén, `pm2 restart`, kiểm tra `/health`, `/ai.html` 200, `/app/ai/settings` 401, MCP metadata 200, bảng `ai_*`; lỗi → rollback từ backup. File tĩnh (`public/*`) chỉ cần scp, không restart.
- Restart PM2 trong lúc người dùng đang đăng nhập ChatGPT không còn làm mất phiên (đã persist), nhưng request trúng lúc restart sẽ 502 → UI báo "thử lại sau vài giây".
- Đăng nhập ChatGPT trên VPS: dán URL callback `localhost:1455/...`; mã `code` dùng 1 lần, hết hạn phiên 10 phút.

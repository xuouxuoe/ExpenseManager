# Integration API (LINE OA / AI) — แผน

สถานะ: อนุมัติแผนและ schema ApiClients/ApiDrafts 2026-11-27; A1 ผ่านบน TEST ผ่าน gateway G1 (ping ด้วย key จริงได้ `db_target: "TEST"`, key ปิด/เปลี่ยนแล้วถูกปฏิเสธ, ทดสอบด้วย Postman) — การทดสอบผ่าน Make ผู้ใช้ให้ข้ามไปก่อน; หน้า "คู่มือ API" (A4 บางส่วน) ทำในเครื่องแล้ว; ApiDrafts จะเพิ่มใน A2

> **ปรับแผน 2026-11-27 (ผู้ใช้สั่ง): ไม่ใช้ Make — ใช้ Apps Script อย่างเดียว และเรียก AI จาก Apps Script โดยตรง** ข้อ 0 นี้แทนส่วนที่อ้างถึง Make ในข้อ 1, 3, 9, 10, 13; schema (ข้อ 7) และหลักการร่าง → ยืนยัน → บันทึก ยังเหมือนเดิม; **ข้อ 0.4–0.6 รออนุมัติ (§15) ก่อน implement**

## 0. แผนแบบไม่มี Make

### 0.1 การตัดสินใจของผู้ใช้ (2026-11-27)

| เรื่อง | ตัดสินใจ |
|---|---|
| ตัวกลาง | ไม่ใช้ Make; LINE ส่ง webhook ตรงเข้า gateway G1 (`doPost`) |
| ร่าง/ยืนยัน/ยกเลิก | อยู่บน Apps Script (ApiDrafts) ไม่อยู่ในระบบ flow ภายนอก |
| AI | เริ่มที่ OpenAI (GPT) และรองรับผู้ให้บริการอื่นหรือ endpoint แบบ custom ได้ด้วยการตั้งค่า |

### 0.2 สถาปัตยกรรม

```text
LINE ──webhook (?line_key=…)──> gateway doPost ──> Library (project หลัก)
                                   ├─ ตรวจ line_key (ApiClients) + LINE userId ที่อนุญาต
                                   ├─ AiParser: ข้อความ + ข้อมูลหลัก → ผู้ให้บริการ AI → JSON (ข้อ 6)
                                   ├─ Drafts.create: ตรวจ/resolve ID → ApiDrafts (PENDING)
                                   └─ LINE reply: สรุป + ปุ่ม [ยืนยัน][ยกเลิก] (postback มี draft_id + confirm_token)
LINE postback ──> doPost ──> Drafts.confirm → Transactions.create (idempotent) → reply "บันทึกแล้ว"
ผู้เรียกอื่น (สคริปต์/Postman) ──JSON + api_key──> doPost ──> actions ข้อ 5 เหมือนเดิม
```

- `doPost` แยกคำขอ: body มี `events` (รูปแบบ LINE) → LineWebhook; มี `api_key` → IntegrationApi เดิม
- ตอบ LINE ด้วย reply token ภายใน execution เดียว (เป้าหมาย 4–8 วินาที); ตอบ HTTP 200 เสมอ
- ใช้ `webhookEventId` ของ LINE เป็น idempotency key — LINE ส่งซ้ำ (redelivery) ไม่สร้างร่าง/รายการซ้ำ
- คำสั่งดูข้อมูลในแชต (เช่น "ยอดเดือนนี้") ใช้ read actions ของ A3 โดยไม่เรียก AI เมื่อจับคำสั่งได้

### 0.3 ผู้ให้บริการ AI (AiParser)

| AI_PROVIDER | ใช้กับ | หมายเหตุ |
|---|---|---|
| `OPENAI` | OpenAI API | ค่าเริ่มต้น; ขอผลเป็น JSON ตาม schema (structured output) |
| `OPENAI_COMPATIBLE` | endpoint ที่รองรับรูปแบบ OpenAI Chat Completions (custom) | ต้องตั้ง `AI_BASE_URL` (https เท่านั้น) |
| `ANTHROPIC` | Claude API | adapter แยก |
| `GEMINI` | Google Gemini API | adapter แยก |

- adapter ทุกตัวคืนผลรูปแบบเดียวกัน (JSON ข้อ 6) แล้วผ่าน `Validation` + resolve ID ของ Backend เสมอ — ผลจาก AI เป็นเพียงข้อเสนอ ไม่เคยบันทึกตรง (AGENTS.md §11)
- ชื่อโมเดลไม่ hardcode: ตั้งใน `AI_MODEL`
- ส่งให้ AI เฉพาะ: ข้อความของผู้ใช้, วันที่วันนี้, รายการชื่อ+ID บัญชี/หมวด/เจ้าของที่ active — ไม่ส่งยอดเงินคงเหลือหรือประวัติรายการ
- timeout/ข้อผิดพลาดจาก AI → ตอบ LINE ว่าแปลงข้อความไม่ได้ ให้พิมพ์ใหม่ ไม่สร้างร่าง; ไม่ log ข้อความผู้ใช้หรือคำตอบ AI

### 0.4 Script Properties ใหม่ (project หลัก; ตั้งโดยเจ้าของ — ผ่าน editor หรือหน้าเว็บที่จำกัดเฉพาะเจ้าของ ตามข้อ 0.10)

| key | ค่า |
|---|---|
| `AI_PROVIDER` | `OPENAI` / `OPENAI_COMPATIBLE` / `ANTHROPIC` / `GEMINI` |
| `AI_API_KEY` | API key ของผู้ให้บริการ AI |
| `AI_MODEL` | ชื่อโมเดล |
| `AI_BASE_URL` | เฉพาะ `OPENAI_COMPATIBLE` (https) |
| `LINE_CHANNEL_ACCESS_TOKEN` | token ของ LINE Messaging API สำหรับตอบกลับ |

เดิมกำหนดให้ตั้งใน editor เท่านั้น; ผู้ใช้ขอให้ตั้งผ่านหน้าเว็บได้ (2026-11-27) จึงจำกัดการแก้เฉพาะเจ้าของสคริปต์ ตรวจ `AI_BASE_URL` ต้องเป็น https และไม่ส่ง key กลับเบราว์เซอร์ (ข้อ 0.10)

### 0.5 ความปลอดภัยของ webhook (ข้อจำกัด Apps Script)

- `doPost` อ่าน header ไม่ได้ จึง **ตรวจ `X-Line-Signature` ไม่ได้** — ใช้แทนด้วย:
  1. `line_key` ใน query string ของ webhook URL = API key ของการเชื่อมต่อใน ApiClients (scope WRITE) — ปิด/เปลี่ยนได้จากหน้าเชื่อมต่อภายนอกเหมือนเดิม
  2. LINE userId ต้องอยู่ใน `allowed_channel_user_ids` ของการเชื่อมต่อนั้น (บังคับ ห้ามว่าง)
  3. ทุกการบันทึกต้องกดยืนยันจากแชตของ userId เดียวกัน และ confirm_token ตรง — webhook ปลอมสร้างได้แค่ร่างที่หมดอายุเอง
- ข้อเสีย: key อยู่ใน URL ที่ตั้งใน LINE Developers Console และอาจอยู่ใน log ของ Google; เปลี่ยน key ทันทีเมื่อสงสัยว่ารั่ว
- ปุ่ม Verify ใน LINE Console อาจแจ้งล้มเหลวเพราะ Apps Script ตอบ 302 แต่ webhook จริงทำงาน (ต้องยืนยันบน TEST)

### 0.6 สิทธิ์และความเป็นส่วนตัว

- เพิ่ม scope `https://www.googleapis.com/auth/script.external_request` ใน manifest ของ project หลักและ gateway แล้ว Authorize ใหม่
- ข้อความแชต (และสลิปในระยะหลัง) ถูกส่งไป LINE และผู้ให้บริการ AI ที่เลือก — ต้องได้รับอนุญาตจากผู้ใช้ (AGENTS.md §10)

### 0.7 ระยะพัฒนาใหม่ (แทนข้อ 9)

| ระยะ | งาน | Done เมื่อ |
|---|---|---|
| A1 | gateway, API key, `ping` | ผ่านแล้ว (ข้อ 9.1) |
| A2 | ApiDrafts, `masters.list`, `draft.create/confirm/cancel` ผ่าน API key (ทดสอบด้วย Postman) | ครบวงจรบน TEST, ยืนยันซ้ำไม่ซ้ำ, หมดอายุ/token ผิดถูกปฏิเสธ — **implement ในเครื่องแล้ว (ข้อ 0.8)** |
| A3 | AiParser + adapter OPENAI/OPENAI_COMPATIBLE/ANTHROPIC/GEMINI (ทดสอบด้วย fake UrlFetchApp) และ action `ai.parse` (ทดสอบผ่าน API ก่อนต่อ LINE) | ข้อความตัวอย่างได้ JSON ที่ผ่าน Validation; AI ล้มเหลวไม่สร้างร่าง — **implement ในเครื่องแล้ว (ข้อ 0.9)** |
| A4 | LineWebhook: ข้อความ → AI → ร่าง → reply ปุ่ม; postback ยืนยัน/ยกเลิก | ใช้จริงจาก LINE บน TEST, LINE ส่งซ้ำไม่ซ้ำ, userId อื่นถูกปฏิเสธ — **implement ในเครื่องแล้ว (ข้อ 0.11)** |
| A5 | read actions + คำสั่งในแชต (`summary.month`, `balances`, `transactions.recent`, `budget.remaining`) | ตัวเลขตรงกับ Dashboard — **ผ่านในแชต LINE บน TEST (ข้อ 0.12)** |
| A6 | อ่านสลิปจากรูป (LINE content API → AI ที่อ่านภาพได้) | สลิปตัวอย่างได้ร่างที่ถูกต้อง — **implement ในเครื่องแล้ว (ข้อ 0.13)** |

คู่มือ API ในแอปปรับตามแต่ละระยะ (ตัดส่วน Make ออก เพิ่มการตั้งค่า LINE webhook และ Script Properties ของ AI)


### 0.8 สถานะ A2 (2026-11-27)

- [x] Config/AGENTS.md/database-schema.md: ชีต ApiDrafts (สร้างอัตโนมัติ), enum DRAFT_STATUS, Script Property `API_DRAFT_SECRET` (ระบบสร้างเองครั้งแรก)
- [x] `ApiDraftService.gs`: `masters.list` (READ), `draft.create` / `draft.confirm` / `draft.cancel` (WRITE)
  - params รับ ID หรือชื่อ (ไม่สนตัวพิมพ์/ช่องว่าง) ไม่พบ/กำกวม → `VALIDATION_NOT_FOUND` / `VALIDATION_AMBIGUOUS` พร้อม `details.candidates`; ฟิลด์อื่น → `VALIDATION_UNKNOWN_FIELD`; หมวดหมู่ค้นเฉพาะประเภทที่ตรงกับรายการ
  - บัญชีเริ่มต้นใช้กับฝั่งหลักของประเภท (รายจ่าย/โอน/ซื้อด้วยบัตร = ต้นทาง, รายรับ = ปลายทาง); เจ้าของเริ่มต้นเมื่อไม่ระบุ; วันที่ว่าง = วันนี้
  - ตรวจด้วย `Transactions.validate` เดิมทั้งตอนสร้างร่างและตอนยืนยัน; Master ถูกปิดหลังสร้างร่าง → ร่าง FAILED พร้อม error_code
  - `draft.create` ต้องมี `request_id` (`INVALID_REQUEST_ID`); retry ได้ร่างและ token เดิม; คืนรายการที่อาจซ้ำ (`possible_duplicates`) และ `summary_text`
  - confirm_token = hash ของ secret + draft_id + client_id (คำนวณซ้ำได้ จึงไม่ต้องเก็บ token จริงใน journal/ชีต); ชีตเก็บ hash
  - ยืนยันใช้ idempotency key ผูกกับ draft_id และบันทึกธุรกรรม `source: AI` ผ่าน `Transactions.insertWithin` (แยกออกจาก `Transactions.create` เดิม พฤติกรรมเดิมไม่เปลี่ยน)
  - ยืนยัน/ยกเลิกได้เฉพาะการเชื่อมต่อและ LINE userId ที่สร้างร่าง (`DRAFT_NOT_FOUND`); token ผิด `INVALID_CONFIRM_TOKEN`; เกิน 24 ชม. `DRAFT_EXPIRED`; สถานะอื่น `DRAFT_NOT_PENDING`
- [x] `tests/api-drafts.test.js` 11 กรณี รวมจำลองระบบล้มทุกจุดเขียนระหว่างยืนยัน (ก่อนเขียน/คำตอบหาย) แล้วส่งซ้ำ → ธุรกรรมเดียว; `npm test` ผ่าน 198/198
- [x] คู่มือ API ในแอป: actions ใหม่ "ใช้ได้", params/ตัวอย่างคำขอ-คำตอบ, รหัสข้อผิดพลาดใหม่; ตัดส่วน Make ออกจากหน้าเว็บ
- [x] `clasp push` ไป HEAD (2026-11-27) และ clone กลับมาเทียบตรงกัน 29 ไฟล์; gateway @4 ยังตอบ `BAD_REQUEST`/`UNAUTHORIZED` ถูกต้อง (2.5–3.0 วินาที)
- [x] ผู้ใช้ทดสอบ Postman: การเชื่อมต่อที่ตั้ง LINE userId ได้ `FORBIDDEN_CHANNEL` เมื่อไม่ส่ง `channel_user_id` (ถูกต้อง); การเชื่อมต่อที่ไม่มีบัญชีเริ่มต้นได้ `VALIDATION_REQUIRED` ที่อ้าง `from_account_id` → ปรับข้อความให้อ้างฟิลด์ของ API (`from_account`/`to_account`/`category`/`owner`) พร้อมวิธีแก้ และ push แล้ว (2026-11-27, ตรงกัน 29 ไฟล์)
- [x] ผู้ใช้ทดสอบครบวงจรผ่าน gateway บน TEST ด้วย Postman: `masters.list` → `draft.create` → `draft.confirm` / `draft.cancel` ถูกต้อง (2026-11-27)
- ยังไม่ได้วัดเวลาตอบจริงของ draft.create/confirm บน Apps Script

### 0.9 สถานะ A3 (2026-11-27)

- [x] `AiService.gs` (`AiParser`): config จาก Script Properties (`AI_PROVIDER` ค่าเริ่มต้น OPENAI, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` เฉพาะ OPENAI_COMPATIBLE ต้องเป็น https)
  - OPENAI: `POST https://api.openai.com/v1/chat/completions` + `response_format: json_schema` (strict), `max_completion_tokens`
  - OPENAI_COMPATIBLE: `POST <AI_BASE_URL>/chat/completions` + `response_format: json_object` และใส่ schema ใน system prompt
  - ANTHROPIC: `POST https://api.anthropic.com/v1/messages` (`anthropic-version: 2023-06-01`) บังคับ schema ด้วย tool + `tool_choice`
  - GEMINI: `POST …/v1beta/models/<model>:generateContent` (key ใน header `x-goog-api-key` ไม่อยู่ใน URL) + `responseMimeType: application/json`
  - prompt มีวันที่วันนี้ (Asia/Bangkok), กฎแปลง พ.ศ./วันที่สัมพัทธ์, ประเภทรายการ และรายการ ID+ชื่อ+ประเภทของบัญชี/หมวด/เจ้าของที่ active + ค่าเริ่มต้นของการเชื่อมต่อ; ไม่ส่งยอดเงิน/ประวัติ
  - ผลลัพธ์ → `{ intent: TRANSACTION|OTHER, params (สำหรับ draft.create, มี source_text), message, provider }`; ข้อผิดพลาด `AI_NOT_CONFIGURED` / `AI_ERROR` (มี HTTP status) / `AI_INVALID_OUTPUT`; log เฉพาะผู้ให้บริการ + status ไม่ log ข้อความ/คำตอบ/key
- [x] action `ai.parse` (WRITE, ไม่เขียนข้อมูล, ข้อความไม่เกิน 500 ตัวอักษร) และฟังก์ชัน editor `testAiParse()` (ใช้ข้อมูลหลักของไฟล์ TEST)
- [x] `tests/ai-parser.test.js` 7 กรณี (UrlFetchApp จำลอง; เทสต์ไม่ออกเครือข่าย); `npm test` ผ่าน 209/209; คู่มือ API มี ai.parse, หัวข้อตั้งค่า AI และรหัสข้อผิดพลาดใหม่
- [x] manifest ของ gateway ในเครื่องเพิ่ม scope `script.external_request` (ยังไม่ push)
- [x] push project หลัก (2026-11-27, ตรงกัน 31 ไฟล์) และ gateway ด้วย `--force` (ได้รับอนุญาต: บนเว็บ manifest ยังไม่มี scope ใหม่ และ testPing ถูกแก้ให้มี API key จริงฝังอยู่ — push ทับกลับเป็น key ปลอม; แนะนำผู้ใช้เปลี่ยน key ของการเชื่อมต่อนั้น) clone กลับมาตรงกัน; gateway @4 ยังตอบ UNAUTHORIZED กับ key ปลอม
- [x] ผู้ใช้ (2026-11-27 รายงานว่าทดสอบผ่าน): ผู้ใช้ตั้ง Script Properties ของ AI, Run `testAiParse` เพื่อ Authorize project หลัก และ Run `testPing` ใน gateway เพื่อ Authorize scope ใหม่ แล้วทดสอบ `ai.parse` → `draft.create` ด้วย Postman
- ผู้ใช้ทดสอบกับผู้ให้บริการจริงผ่านหน้าเว็บ (ปุ่มทดสอบ) แล้วผ่าน; ยังไม่ได้วัดเวลาตอบเฉลี่ย/ค่าใช้จ่ายต่อข้อความอย่างเป็นระบบ

### 0.10 ตั้งค่า AI ผ่านหน้าเว็บ (ผู้ใช้ขอ 2026-11-27)

- การ์ด "ผู้ให้บริการ AI" ในหน้าเชื่อมต่อภายนอก: แสดงผู้ให้บริการ โมเดล Base URL และ "ตั้งแล้ว (…4 ตัวท้าย)"; ปุ่มตั้งค่า/ทดสอบแสดงเฉพาะเจ้าของ
- `AiSettings` (AiService.gs) + `api_getAiSettings` / `api_saveAiSettings` / `api_testAiSettings`
  - แก้/ทดสอบได้เฉพาะเจ้าของสคริปต์ (`Auth.isOwner`: ผู้ใช้หน้าเว็บ = effective user ของ Web App) ผู้ใช้อื่นใน ALLOWED_EMAILS ได้ `FORBIDDEN`
  - ค่าเก็บใน Script Properties (ไม่ใช่ชีต); API key เขียนได้อย่างเดียว ไม่ส่งกลับเบราว์เซอร์ เว้นว่าง = ใช้ key เดิม; journal/audit เก็บเฉพาะ hash
  - ตรวจ: ผู้ให้บริการใน enum, ชื่อโมเดล `[A-Za-z0-9._:/@+-]` ≤ 100, key 8–500 ตัวไม่มีช่องว่าง, Base URL https เฉพาะ OPENAI_COMPATIBLE (ล้างเมื่อเปลี่ยนเป็นแบบอื่น)
  - ปุ่มทดสอบแปลง "กาแฟ 65 บาท" ด้วยข้อมูลหลักของฐานที่ใช้ แสดงผลและเวลา ไม่เขียนข้อมูลธุรกิจ
- `tests/ai-settings.test.js` 4 กรณี; ตรวจบน preview desktop และมือถือ 375px

### 0.11 สถานะ A4 (2026-11-27)

- [x] `LineService.gs` (`LineWebhook`): `doPost` ที่มี `?line_key=` ส่งไป LINE webhook ส่วนอื่นเป็น JSON API เดิม (`IntegrationApi.handlePost`)
  - line_key = API key ของการเชื่อมต่อ; ต้องมีสิทธิ์ WRITE (`IntegrationApi.guard`: actor ยังอยู่ใน ALLOWED_EMAILS, scope, rate limit) และต้องกำหนด LINE userId (`FORBIDDEN_CHANNEL`)
  - รับเฉพาะ `source.type = user` จาก userId ที่อนุญาต; userId อื่นได้ข้อความแจ้ง userId ให้ผู้ดูแลเพิ่ม (ไม่เรียก AI)
  - ข้อความ → `AiParser.parse` → `ApiDrafts.create` (request_id = `line-<webhookEventId>`) → ตอบ Flex bubble สรุป + ปุ่ม postback `em=1&a=c|x&d=<draft_id>&t=<token>` (< 300 ตัว)
  - postback ยืนยัน → `ApiDrafts.confirm` (บันทึก source AI ครั้งเดียว) / ยกเลิก → `ApiDrafts.cancel`; ข้อผิดพลาดตอบเป็นข้อความภาษาไทย (ชื่อไม่พบแสดงตัวเลือก)
  - "วิธีใช้"/help และ follow → ข้อความแนะนำ; รูปภาพ → อ่านสลิป (ระยะ A6 ข้อ 0.13); กลุ่ม/ห้อง → ข้าม
  - กันเหตุการณ์ซ้ำด้วย webhookEventId ใน CacheService 6 ชั่วโมง (เรียก AI ครั้งเดียว)
  - ตอบกลับด้วย LINE Reply API (`LINE_CHANNEL_ACCESS_TOKEN`); ไม่ได้ตั้ง token → ประมวลผลได้แต่ไม่ตอบ และ log `LINE_NOT_CONFIGURED`; ไม่ log ข้อความ/token/key
- [x] `LineSettings` + การ์ด "LINE Official Account" ในหน้าเชื่อมต่อภายนอก: ตั้ง token (เฉพาะเจ้าของ, เขียนอย่างเดียว) และวิธีตั้ง Webhook URL; คู่มือ API มีหัวข้อ LINE
- [x] `tests/line-webhook.test.js` 10 กรณี; `npm test` ผ่าน 223/223; ตรวจ preview แล้ว
- [x] `clasp push` ไป HEAD (2026-11-27, ตรงกัน 32 ไฟล์); gateway @4: `?line_key=` ปลอม → `UNAUTHORIZED`, JSON API เดิมยังตอบ `BAD_REQUEST` ถูกต้อง
- [x] ทดสอบกับ LINE (2026-11-27): Verify ได้ `302 Found` (ข้อจำกัด Apps Script ที่คาดไว้; ข้อความจริงยังเข้า doPost) — execution และ log ของ webhook อยู่ที่ **project gateway** ไม่ใช่ project หลัก; ครั้งแรก doPost "เสร็จสมบูรณ์" แต่บอทไม่ตอบและไม่มี log → เพิ่ม log `LINE_WEBHOOK: <ผล>` ทุกครั้ง (เช่น UNAUTHORIZED, FORBIDDEN_SCOPE, FORBIDDEN_CHANNEL, draft, forbidden) โดยไม่มีข้อความแชต/userId/key/token และแก้คำแนะนำในการ์ด LINE
- [x] แก้ (2026-11-27): ผู้ใช้เปิดดู log ของ doPost ไม่ได้ เพราะ `Logger.log` เก็บเฉพาะการรันจาก editor → log ในเส้นทาง runtime (LINE webhook, Integration API, AI, handleApi_) ใช้ `console.log` ซึ่งไปที่ Cloud Logging และดูได้ใน Executions; ฟังก์ชันผู้ดูแลที่รันจาก editor ยังใช้ `Logger.log`
- [x] แก้ (2026-11-27): ผู้ใช้ยังเปิด log ของ execution webhook ใน gateway ไม่ได้ → บันทึก "ผลล่าสุดของ webhook" (เวลา + รหัสผล เช่น VERIFY, UNAUTHORIZED, draft, `forbidden / LINE_NOT_CONFIGURED`) ใน Script Property `LINE_LAST_WEBHOOK` และแสดงพร้อมคำอธิบายในการ์ด LINE (ไม่มีข้อความ/userId/key/token)
- [x] **ปิดแล้ว 2026-11-28 (ดูด้านล่าง):** webhook จริงจาก LINE เข้า gateway (`doPost` @4 เสร็จใน ~2.5 วินาที) แต่บอทไม่ตอบ และการ์ดยังไม่แสดงผลของข้อความจริง ผู้ใช้ยืนยันว่า URL มี `?line_key=`; Claude ส่งคำขอแบบ LINE ด้วย key ปลอมตอน 16:49:16 ได้ `UNAUTHORIZED` — รอผู้ใช้ตรวจว่าการ์ดแสดงผลนี้หรือไม่ เพื่อแยกว่าเป็นปัญหา key ใน URL หรือการบันทึกสถานะ
- [x] ตรวจการ์ด LINE บน `/dev` (2026-11-28): ผลล่าสุด VERIFY 27 พ.ย. 23:10:41 → gateway บันทึกสถานะได้ปกติ (ข้อค้าง 16:49 ไม่ใช่ปัญหาการบันทึก); token ตั้งแล้ว; การเชื่อมต่อเดียว (TEST) มีสิทธิ์ READ+WRITE แต่ **ไม่ได้กำหนด LINE userId**
- [x] แก้ (2026-11-28): เดิมการเชื่อมต่อที่ไม่มี LINE userId ถูกปฏิเสธทั้งคำขอ (`FORBIDDEN_CHANNEL`) โดยไม่ตอบในแชต ผู้ใช้จึงไม่มีทางรู้ userId ของตัวเอง → ตอบ userId ของผู้ส่งกลับไป (แชต 1:1 เท่านั้น ไม่เรียก AI ไม่สร้างร่าง) ผลบนการ์ดยังเป็น `FORBIDDEN_CHANNEL`; `tests/line-webhook.test.js` ปรับตาม — ผู้ใช้พิมพ์ใน LINE ก่อนแก้ได้การ์ด `FORBIDDEN_CHANNEL` 28 พ.ย. 00:18:51 ยืนยันสาเหตุ; `clasp push` 00:21 และ clone กลับมาเทียบตรงกัน 33 ไฟล์
- [x] แก้ (2026-11-28): `LINE_REPLY_FAILED` เดิมไม่เก็บข้อความ error → บันทึกสาเหตุในวงเล็บบนการ์ด (ปิด token/userId) push 00:26 ตรงกัน 33 ไฟล์
- [x] **สาเหตุที่บอทไม่ตอบ (2026-11-28 00:28):** `LINE_REPLY_FAILED [... UrlFetchApp.fetch ... 必要な権限: script.external_request]` — execution ของ gateway ไม่มีสิทธิ์ `script.external_request` (deployment @4 น่าจะสร้างก่อนเพิ่ม scope นี้ใน manifest ของ gateway และ Web App ใช้ manifest ของเวอร์ชันที่ deploy) ไม่ใช่ปัญหาโค้ด
- [x] (ผู้ใช้ 2026-11-28) แก้สิทธิ์และ deploy gateway ใหม่ → **บอทตอบได้แล้ว** ผู้ใช้แจ้งว่าสาเหตุเกี่ยวกับลิงก์ deployment ที่เปลี่ยน (Webhook URL ต้องชี้ไปยัง deployment ที่มีสิทธิ์ `script.external_request`); เมื่อสร้าง deployment ใหม่ต้องแก้ Webhook URL ใน LINE Developers ด้วย
- [ ] ผู้ใช้ตั้ง LINE token, สร้างการเชื่อมต่อสำหรับ LINE, ตั้ง Webhook URL ใน LINE Developers และทดสอบในแชต
- [x] แก้ (2026-11-27): ผู้ใช้พบว่าปุ่ม Verify ใน LINE timeout เมื่อ URL มี `?line_key=` (ไม่มี key ผ่าน) เพราะเส้นทาง LINE เปิด Spreadsheet ตรวจ key ก่อน → คำขอที่ `events` ว่างตอบ `ok` ทันทีโดยไม่ตรวจ key/ไม่แตะ Spreadsheet (ไม่มีการประมวลผล) — push แล้ว (ตรงกัน 32 ไฟล์); วัดผ่าน curl รวมการตาม redirect: Verify 2.0–3.0 วินาทีได้ `ok`, เหตุการณ์จริงกับ key ปลอม 3.5 วินาทีได้ `UNAUTHORIZED`
- ข้อจำกัด: ตรวจ X-Line-Signature ไม่ได้ (ข้อ 0.5); การกันซ้ำพึ่ง CacheService (หายได้ก่อนกำหนด แต่ร่างยังกันซ้ำด้วย request_id); เวลาตอบจริงยังไม่ได้วัด

### 0.12 สถานะ A5 (2026-11-27)

- [x] `ApiReadService.gs` (`ApiReads`) + actions สิทธิ์ READ (channel ไม่บังคับ) ไม่เขียนชีต ไม่เรียก AI:
  - `summary.month` params `{ month?, owner_id? }` → `income/expense/net`, `plan { scheduled, paid, outstanding, need_to_save, saved }`, `top_categories` (5 หมวดรายจ่ายสูงสุด) — คำนวณด้วย `FinanceReports.dashboard({ month, owner_id })` จึงตรงกับ Dashboard
  - `balances` → `totals { assets, reserved, available, liabilities }` (ทุกบัญชี เท่า `accountTotals` ของ Dashboard) และ `accounts` (บัญชีที่ใช้งาน หรือปิดแล้วแต่ยังมียอด)
  - `transactions.recent` params `{ limit 1–20 ค่าเริ่มต้น 5 }` → เรียงแบบหน้ารายการ มี `is_reversed`/`reversal_of`; ไม่คืน note/external_ref/created_at
  - `budget.remaining` params `{ month? }` → ยอดรวมและรายงบ (remaining, สัปดาห์นี้, ใช้ได้ต่อวัน) จาก `Budgets.list`
  - ไม่ระบุ month = เดือนปัจจุบัน (Asia/Bangkok); month ผิดรูปแบบ → `VALIDATION_YEAR_MONTH*`
- [x] LINE: คำสั่งตรงตัว (ไม่สนช่องว่าง/ตัวพิมพ์) `สรุป` / `ยอดเงิน` / `ล่าสุด` / `งบ` (และคำพ้อง) ตอบข้อความสรุปโดยไม่เรียก AI และไม่สร้างร่าง; การเชื่อมต่อต้องมีสิทธิ์ READ เพิ่มจาก WRITE ไม่งั้นตอบ `FORBIDDEN_SCOPE`; "วิธีใช้" แสดงคำสั่งใหม่
- [x] `tests/api-reads.test.js` 7 กรณี (เทียบกับ `api_dashboard`/`api_budgetPage`, สิทธิ์, ไม่เขียนชีต, รูปแบบข้อความ, คำสั่ง LINE); `npm test` ผ่าน 231/231; คู่มือ API แสดง 4 actions เป็น "ใช้ได้" พร้อมตัวอย่าง (ตรวจ preview แล้ว)
- [x] `clasp push` ไป HEAD (ผู้ใช้อนุญาต 2026-11-27, 23:00) และ clone กลับมาเทียบตรงกัน 33 ไฟล์; ครั้งแรกได้ `Skipping push.` เพราะ `appsscript.json` ต่างแค่ CRLF/LF → แปลงไฟล์ในเครื่องเป็น LF (เนื้อหาเดิม) แทนการใช้ `--force`; gateway ใช้ Library HEAD จึงไม่ต้อง push/deploy ใหม่
- [x] ผู้ใช้ทดสอบคำสั่ง `สรุป` / `ยอดเงิน` / `ล่าสุด` / `งบ` ในแชต LINE จริงด้วยฐาน TEST และรายงานว่าผ่านทั้งหมด (2026-11-28)
- ข้อจำกัด: ยอดเงินส่วนตัวถูกส่งกลับผ่าน LINE (ตอบเฉพาะ userId ที่อนุญาต); ยังไม่ได้วัดเวลาตอบจริง (`summary.month` อ่าน 7–8 ชีต)

### 0.13 สถานะ A6 อ่านสลิปจากรูป (2026-11-28)

- ผู้ใช้สั่งดำเนินการ A6 (2026-11-28) — ถือเป็นการอนุญาตให้ส่งรูปสลิปที่ผู้ใช้ส่งในแชตไปยังผู้ให้บริการ AI ที่ตั้งไว้ (AGENTS.md §10)
- [x] `LineService.onImage`: ข้อความชนิด image (เฉพาะ `contentProvider.type = line`) → GET `https://api-data.line.me/v2/bot/message/{id}/content` ด้วย Channel access token → ตรวจขนาด ≤ 5 MB และชนิด JPEG/PNG/WebP → `AiParser.parseImage` → ร่าง + Flex ยืนยันเหมือนข้อความ; รูปจากลิงก์ภายนอกไม่ดึง
- [x] `AiParser.parseImage` + `buildRequest(..., image)`: OPENAI/OPENAI_COMPATIBLE ใช้ `image_url` (data URL), ANTHROPIC ใช้ `image` base64, GEMINI ใช้ `inline_data`; prompt เพิ่มกฎอ่านสลิป (ยอดที่จ่าย, วันที่ พ.ศ., ชื่อผู้รับเป็น item_name, เลขอ้างอิงใน description, บัญชีต้นทางเฉพาะเมื่อชัดเจน, ไม่ใช่สลิป → OTHER)
- [x] ไม่เก็บรูปและไม่ log รูป/ข้อความ; draft_json เก็บเฉพาะค่าที่ resolve แล้ว (`source_text` = "(รูปสลิป)" ไม่ถูกเก็บ); การยืนยันยังผ่าน `draft.confirm` เดิม
- [x] ข้อผิดพลาดตอบในแชต: `LINE_CONTENT_ERROR` (ดึงรูปไม่ได้), `UNSUPPORTED_IMAGE` (ชนิด/ขนาด), `LINE_NOT_CONFIGURED`, `AI_ERROR` (แนะนำให้ใช้โมเดลที่อ่านภาพได้)
- [x] `tests/line-slip.test.js` 5 กรณี; test shim รองรับ `getBlob()` และ `Utilities.base64Encode`; `npm test` ผ่าน
- [x] `clasp push` ไป HEAD (ผู้ใช้อนุญาต 2026-11-28, 01:51) และ clone กลับมาเทียบตรงกัน 33 ไฟล์
- [x] ผู้ใช้ส่งสลิปจริง (2026-11-28): บอทตอบ "กรุณาระบุ category" เพราะ prompt เดิมบอก AI ว่าไม่แน่ใจให้ใส่ null แล้วใช้ค่าเริ่มต้น แต่หมวดไม่มีค่าเริ่มต้น และสลิปโอนเงินไม่บอกหมวด → แก้: prompt บังคับเลือกหมวดที่ใกล้สุด (หรือหมวดทั่วไป) สำหรับ INCOME/EXPENSE/CREDIT_PURCHASE; ถ้า AI ยังไม่เลือก ระบบใช้หมวดทั่วไปที่ชื่อตรง อื่น/ทั่วไป/เบ็ดเตล็ด เมื่อมีหมวดเดียว; ไม่มี → ตอบรายชื่อหมวดและวิธีพิมพ์ (ใช้กับข้อความด้วย)
- [ ] ทดสอบส่งรูปสลิปจริงอีกครั้งหลังแก้ (ต้อง clasp push ก่อน)
- ข้อจำกัด: ความแม่นยำขึ้นกับโมเดล AI — ผู้ใช้ต้องตรวจยอด วันที่ และบัญชีในสรุปก่อนยืนยัน; เวลาตอบเพิ่มขึ้นจากการดึงรูปและการอ่านภาพ (ยังไม่ได้วัด); ค่า AI ต่อรูปสูงกว่าข้อความ; ยังไม่รองรับสลิปผ่าน JSON API (`ai.parse` รับเฉพาะข้อความ)

## 1. เป้าหมายและการแบ่งหน้าที่ (เดิม — ส่วน Make ถูกแทนด้วยข้อ 0)

ผู้ใช้สั่งบันทึกหรือถามข้อมูลผ่าน LINE OA โดยใช้ **Make** เป็นตัวกลาง: Make รับข้อความจาก LINE → ส่งให้ AI แปลงเป็น JSON → เรียก API ของ Expense Manager → ตอบกลับใน LINE; บันทึกจริงเมื่อผู้ใช้กดยืนยันเท่านั้น (AGENTS.md §11)

| ส่วน | หน้าที่ |
|---|---|
| LINE OA | ช่องทางคุยกับผู้ใช้ (ข้อความ, รูปสลิป, ปุ่มยืนยัน) |
| Make | รับ webhook LINE, กรอง LINE userId, เรียก AI, เรียก API, ส่งข้อความตอบกลับ |
| AI (ผ่าน Make) | แปลงข้อความ/สลิปเป็น JSON ตามรูปแบบในข้อ 6 — ไม่มีสิทธิ์เขียนข้อมูลเอง |
| Expense Manager API | **ผู้ตัดสินเดียว**: ตรวจสิทธิ์ ตรวจข้อมูล แปลงชื่อเป็น ID เก็บร่าง ยืนยัน บันทึก และตอบข้อมูล |

หลักการ: Make และ AI เป็นแค่ตัวส่งต่อ — ห้ามมี business logic ฝั่ง Make ที่ข้ามการตรวจของ Backend; ทุกการเขียนผ่าน `TransactionService` + OperationService เดิม (lock, idempotency, journal, audit)

นอกขอบเขตรอบแรก: แก้/กลับรายการ, Payment Plan, Reservations, Budgets (เขียน)

## 2. การตัดสินใจที่ผู้ใช้เลือกแล้ว

| เรื่อง | ตัดสินใจ | วันที่ |
|---|---|---|
| ตัวกลาง/AI | ใช้ Make เรียก AI และคุยกับ LINE; ระบบให้บริการเป็น API | 2026-11-27 |
| การยืนยันตัวตนผู้เรียก | secret key (ไม่ใช้ proxy) — ส่งใน JSON body (`api_key`) แทน URL เพื่อไม่ให้ติดใน URL/log | 2026-11-27 |
| อนุมัติ schema และเริ่ม A1 | ApiClients/ApiDrafts ตามข้อ 7 | 2026-11-27 |
| ตัวกลาง/AI (แทนแถวแรก) | ไม่ใช้ Make; Apps Script รับ LINE webhook และเรียก AI เอง; AI เริ่มที่ OpenAI และรองรับผู้ให้บริการอื่น/custom (ข้อ 0) | 2026-11-27 |

เหตุผล: `doPost(e)` ของ Apps Script อ่าน HTTP header ไม่ได้ (ใช้ `Authorization` header ไม่ได้) และกำหนด HTTP status code ไม่ได้ — ทุกคำตอบเป็น 200 จึงต้องตรวจ `ok` ใน body เสมอ

## 3. สถาปัตยกรรม

```text
LINE ──webhook──> Make scenario ──(1) masters.list──────────> API
                     │          ──(2) AI module (ข้อความ + masters) → JSON
                     │          ──(3) draft.create (JSON) ───> API → ตรวจ/resolve/เก็บร่าง → คืนสรุป + draft_id + confirm_token
                     │<── reply Flex [ยืนยัน][ยกเลิก] (postback มี draft_id + confirm_token)
LINE postback ──> Make ──(4) draft.confirm ──────────────────> API → TransactionService.create (idempotent) → คืน transaction_id
                     │<── reply "บันทึกแล้ว"
LINE "ยอดเดือนนี้" ──> Make ──(5) summary.month / balances ──> API → reply
```

- API อยู่ใน Web App ที่เปิดแบบ anonymous (ไม่ต้องล็อกอิน Google) แยกจากแอปหลักซึ่งคง `access: MYSELF`
- ทางเลือก deployment (ตัดสินด้วย spike ใน A1 บน TEST เท่านั้น):
  - **G1 (เลือกแล้ว 2026-11-27)** Apps Script project แยก "Expense Manager Integration API" ใช้ project หลักเป็น Library (identifier `ExpenseManager`) มีเฉพาะ `doPost` ไม่มี `doGet` และไม่มีข้อมูล/Script Properties ของตัวเอง
    - ตาม [เอกสาร Libraries](https://developers.google.com/apps-script/guides/libraries) Script Properties, Lock และ Cache เป็น not-shared แต่ instance ที่สร้างจากโค้ดใน Library คือของ Library → โค้ดเดิมทั้งหมด (ซึ่งอยู่ใน Library) ใช้ Script Properties/ตัวนับ ID/Lock/Cache ของ project หลัก ไม่ต้องตั้งค่าซ้ำใน gateway
    - ต้องยืนยันบน TEST: `ping` ได้ `db_target: "TEST"` (พิสูจน์ว่าอ่าน Script Properties ของ project หลัก); ก่อนเปิด A2 ต้องทดสอบว่าเขียนพร้อมกันจากหน้าเว็บและ API ใช้ lock เดียวกัน
    - Library ใช้ HEAD (Development mode) ได้ระหว่างทดสอบเพราะ deployment รันเป็นเจ้าของ (มีสิทธิ์ editor); ก่อนใช้จริงให้ pin เวอร์ชันที่ตรงกับ Production
    - ข้อดีเทียบ G2: สิทธิ์ `access` อยู่ใน manifest ของแต่ละ project จึงแยก anonymous ออกจากแอปหลักได้จริง และ URL สาธารณะไม่มีหน้าเว็บ
  - G2 (ไม่ใช้) deployment ที่สองของ project เดิมแบบ anonymous — `webapp.access` อยู่ใน `appsscript.json` ของ project จึงเสี่ยงทำให้แอปหลักเป็นสาธารณะเมื่ออัปเดต deployment และทำให้ `clasp push` ชนกับ manifest
- การสร้าง project/deployment ใหม่ต้องได้รับอนุญาต (§13)
- ต้องตรวจว่าโมดูล HTTP ของ Make ตาม redirect ของ Apps Script (`/exec` → `script.googleusercontent.com`) และอ่าน JSON ได้

## 4. รูปแบบคำขอและคำตอบ

`POST https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`, `Content-Type: application/json`

```json
{ "api_key": "<secret>", "action": "draft.create", "request_id": "make-<execution-id>", "channel_user_id": "<LINE userId>", "params": { } }
```

- `request_id`: ใช้เป็น idempotency key ของคำขอเขียน (`/^[A-Za-z0-9_-]{8,128}$/`) — Make retry ต้องส่งค่าเดิม
- `channel_user_id`: LINE userId ต้องอยู่ใน whitelist ของ client นั้น (ป้องกันกรณีตั้งตัวกรองใน Make พลาด)

คำตอบ (HTTP 200 เสมอ):

```json
{ "ok": true, "data": { } }
{ "ok": false, "code": "VALIDATION_ERROR", "message": "ไม่พบบัญชี 'kbank'", "details": [ ] }
```

## 5. Actions

| action | สิทธิ์ (scope: `READ` / `WRITE`) | หน้าที่ | ใช้ service เดิม |
|---|---|---|---|
| `ping` | — | ตรวจ key/การเชื่อมต่อ | — |
| `masters.list` | read | บัญชี เจ้าของ หมวดหมู่ ที่ active (ID + ชื่อ + ชื่อเรียกอื่น) สำหรับใส่ใน prompt AI | `MasterData.listAll` |
| `draft.create` | write | รับ JSON จาก AI → ตรวจ → resolve ชื่อเป็น ID → เตือนรายการที่อาจซ้ำ → เก็บร่าง PENDING → คืน `draft_id`, `confirm_token`, `summary_text` | `Validation`, `Transactions` (validate) |
| `draft.confirm` | write | `draft_id` + `confirm_token` → บันทึกจริง → คืน `transaction_id`, `summary_text`; ยืนยันซ้ำคืนผลเดิม | `Transactions.create` |
| `draft.cancel` | write | ยกเลิกร่าง | — |
| `transactions.recent` | read | รายการล่าสุด N รายการ (สูงสุด 20) | `Transactions` page |
| `summary.month` | read | รายรับ รายจ่าย สุทธิ ของเดือน `YYYYMM` + หมวดที่ใช้มากสุด | `FinanceReports.dashboard` |
| `balances` | read | ยอดบัญชี เงินกันไว้ เงินที่ใช้ได้จริง | `Transactions.accountBalances` |
| `budget.remaining` | read | งบคงเหลือเดือน/สัปดาห์ | `Budgets.list` |

- ไม่มี action บันทึกตรงโดยไม่ผ่านร่าง — ทุกการเขียนต้อง `draft.create` → `draft.confirm`
- คำตอบมี `summary_text` ภาษาไทยที่ Make ส่งต่อ LINE ได้เลย ลด logic ฝั่ง Make
- `draft.create` ยอมรับชื่อแทน ID ได้ (AI มักส่งชื่อ) แต่ Backend เป็นผู้ resolve; ชื่อกำกวม/ไม่พบ → `ok:false` พร้อมตัวเลือก ไม่สร้างร่าง
- read action คืนข้อมูลน้อยที่สุดที่จำเป็น

## 6. JSON ที่ AI ต้องสร้าง (params ของ draft.create)

```json
{
  "transaction_type": "EXPENSE",
  "transaction_date": "2026-11-27",
  "amount": 65,
  "from_account": "kbank",
  "to_account": "",
  "category": "อาหาร",
  "owner": "",
  "item_name": "กาแฟ",
  "description": "",
  "note": "",
  "source_text": "กาแฟ 65 kbank"
}
```

- `transaction_type`: INCOME, EXPENSE, TRANSFER, CREDIT_PURCHASE (รอบแรก)
- บัญชี/หมวด/เจ้าของ ส่งเป็น ID หรือชื่อก็ได้; ว่าง = ใช้ค่าเริ่มต้นของ client (ข้อ 7)
- วันที่ว่าง = วันนี้ (Asia/Bangkok)
- ไม่รับ `*_name`, `source`, `created_at` จาก client; `source` = `AI`
- ข้อความ prompt ตัวอย่างสำหรับ Make อยู่ในคู่มือ (ข้อ 10)

## 7. Schema ที่เสนอเพิ่ม (ต้องอนุมัติ §15)

```text
ApiClients: client_id, client_name, actor_id, key_hash, scopes, allowed_channel_user_ids, default_account_id, default_owner_id, is_active, created_at, updated_at
ApiDrafts: draft_id, client_id, actor_id, channel_user_id, draft_status, draft_json, confirm_token_hash, transaction_id, error_code, expires_at, created_at, updated_at
```

- `actor_id` = email ผู้ใช้ที่สร้าง client (ใช้ใน journal/audit แทน Session ซึ่งว่างใน anonymous)
- `key_hash` = SHA-256 ของ key; key รูปแบบ `emk_` + base64url 43 ตัว (256 บิต) สร้างในเบราว์เซอร์ด้วย `crypto.getRandomValues` แล้วส่งให้ Backend คำนวณ hash; idempotency payload ใช้ hash แทน key จึงไม่มี key จริงใน journal/audit/log; แสดงผู้ใช้ครั้งเดียว
- `scopes`: `READ`, `WRITE` (คั่นด้วยจุลภาค)
- `draft_status`: PENDING, CONFIRMED, CANCELLED, EXPIRED, FAILED; `expires_at` = สร้าง + 24 ชม.
- `draft_json` เก็บเฉพาะ payload ที่ resolve แล้ว (ID เท่านั้น) — ไม่เก็บข้อความดิบหรือรูปสลิป
- `Transactions.source` ใช้ `AI` ที่มีอยู่แล้ว

## 8. ความปลอดภัย

1. หา client จาก hash ของ `api_key` (เทียบ hash จึงไม่รั่วข้อมูลจากเวลาเทียบ); ไม่พบ/inactive/รูปแบบผิด → `UNAUTHORIZED` ข้อความเดียวกัน; ผู้สร้างไม่อยู่ใน ALLOWED_EMAILS แล้ว → `FORBIDDEN`; ไม่ log ค่า key หรือ body
2. ตรวจ scope ต่อ action (`FORBIDDEN_SCOPE`); ถ้า client กำหนด `allowed_channel_user_ids` แล้ว `channel_user_id` ที่ส่งมาต้องอยู่ในรายการ (`FORBIDDEN_CHANNEL`) และ action เขียนข้อมูล (A2) ต้องส่งเสมอ
3. `confirm_token` สุ่ม 128 บิต เก็บเฉพาะ hash; ยืนยันได้เมื่อ client เดียวกัน, PENDING, ไม่หมดอายุ, token ตรง
4. `draft.confirm` ใช้ idempotency key ผูกกับ draft_id → กดยืนยันซ้ำ/Make retry ไม่เกิดรายการซ้ำ
5. จำกัดอัตราคำขอต่อ client ด้วย CacheService 60 ครั้ง/นาที (`RATE_LIMITED`; ตัวนับประมาณการ ไม่ atomic)
6. Input ทุกตัวผ่าน `Validation` เดิม รวมป้องกัน formula injection
7. หมุน/ปิด key ได้จากหน้าเว็บทันที
8. ความเป็นส่วนตัว (§10): ข้อความ/สลิปผ่าน LINE, Make และผู้ให้บริการ AI — ต้องได้รับความยินยอม; API ส่งให้ Make เฉพาะข้อมูลที่ action ต้องใช้

## 9. ระยะพัฒนา

| ระยะ | งาน | Done เมื่อ |
|---|---|---|
| A1 | Gateway G1 บน TEST, `doPost` + router, `ping`, ApiClients + หน้าเว็บสร้าง/ปิด key | Make เรียก `ping` สำเร็จ, key ผิด/ปิดแล้วถูกปฏิเสธ |
| A2 | `masters.list`, `draft.create`, `draft.confirm`, `draft.cancel` | ครบวงจรบน TEST, ยืนยันซ้ำไม่ซ้ำ, หมดอายุ/token ผิดถูกปฏิเสธ |
| A3 | read actions (`summary.month`, `balances`, `transactions.recent`, `budget.remaining`) | ตัวเลขตรงกับ Dashboard |
| A4 | หน้า "เชื่อมต่อภายนอก" + คู่มือ API ในแอป, Make scenario ตัวอย่าง (blueprint) | ผู้ใช้ตั้ง Make ตามคู่มือได้ |

ฝั่ง Make (ผู้ใช้สร้างตามคู่มือ): LINE Watch events → กรอง userId → Router (ข้อความบันทึก / คำสั่งดูข้อมูล / postback ยืนยัน-ยกเลิก / รูปสลิป)

### 9.1 สถานะ A1 (2026-11-27)

- [x] `ApiClients` ใน Config/AGENTS.md/database-schema.md (สร้างอัตโนมัติ)
- [x] `ApiClients` service: list/create/update/setActive/rotateKey/authenticate (IntegrationService.gs) ผ่าน Operation.run
- [x] `doPost` → `IntegrationApi.dispatch`: parse JSON, ตรวจ key/actor/scope/channel/rate limit, action `ping`
- [x] หน้า "เชื่อมต่อภายนอก" (PageIntegrations.html) ตรวจบน preview ทั้ง desktop และมือถือ 375px
- [x] `tests/integration-api.test.js` 10 กรณี; `npm test` ผ่านทั้งหมด
- [ ] (ผู้ใช้อนุญาต) `clasp push` ไป HEAD แล้วทดลองรูปแบบ deployment บน TEST:
  - [x] `clasp push` ไป HEAD (2026-11-27) และ pull กลับมาเทียบตรงกัน 27 ไฟล์
  - [ ] (ผู้ใช้) สร้าง gateway G1: project ใหม่ → Libraries + Script ID ของ project หลัก, Version HEAD (Development mode), Identifier `ExpenseManager` → Code.gs มีเพียง `function doPost(e) { return ExpenseManager.doPost(e); }` → Deploy เป็น Web app, Execute as: Me, Who has access: Anyone
  - [x] ผู้ใช้สร้าง gateway และ deploy แล้ว (2026-11-27); ตอนแรก Library ถูกตั้งเป็นเวอร์ชัน 1 (ยังไม่มี doPost) → แก้เป็น HEAD แล้ว deploy เวอร์ชันใหม่
  - [x] GET `/exec` ของ gateway ได้ "ไม่พบฟังก์ชันของสคริปต์: doGet" ไม่มีหน้าแอปหรือข้อมูล; deployment หลักยังมีแค่ @HEAD/@1 และ manifest ยังเป็น MYSELF
  - [x] POST ไม่มี key / key รูปแบบผิด → `UNAUTHORIZED`; JSON ผิด / array → `BAD_REQUEST` (2.4–4.3 วินาทีต่อคำขอ)
  - [x] POST key รูปแบบถูกเคยได้ `INTERNAL_ERROR`: log ระบุว่าไม่ได้รับอนุญาตให้เรียก `SpreadsheetApp.openById` (ต้องการ scope spreadsheets) แม้ manifest ของ gateway มี `oauthScopes` แล้ว → แก้โดยถอนสิทธิ์ gateway ที่ myaccount.google.com/connections แล้ว Run `testPing` ใน editor และอนุญาตครบทุก scope (2026-11-27); สิทธิ์ผูกกับ project ไม่ต้อง deploy ใหม่
  - [x] Claude ทดสอบหลังอนุญาต (2026-11-27) ทั้ง deployment @3 และ @4: JSON ผิด → `BAD_REQUEST`, ไม่มี key และ key ปลอมรูปแบบถูก → `UNAUTHORIZED` (1.8–2.6 วินาที); `testPing` ใน editor ได้ `UNAUTHORIZED`
  - โค้ด gateway เก็บที่ `D:\Git\Expense Manager Integration API` (git แยก, `.clasp.json` ไม่เข้า Git) มี `doPost` และ `testPing` (ใช้ key ปลอม ไม่เขียนข้อมูล); ควรเหลือ deployment ที่ใช้งานเพียงตัวเดียวแล้ว archive อีกตัว
  - [x] ผู้ใช้สร้างการเชื่อมต่อในหน้า "เชื่อมต่อภายนอก" บน `/dev` แล้ว POST `ping` ด้วย key จริงไปที่ gateway ได้ `ok: true` และ `db_target: "TEST"` (ผู้ใช้รายงาน 2026-11-27) — ยืนยันว่า Library อ่าน Script Properties ของ project หลัก
  - [x] key ที่ปิดใช้งาน/เปลี่ยน key แล้วถูกปฏิเสธ (`UNAUTHORIZED`) (ผู้ใช้รายงาน 2026-11-27)
- [x] Postman: POST `ping` ด้วย key จริงได้ `ok: true` (ผู้ใช้รายงาน 2026-11-27)
- [ ] Make: โมดูล HTTP "Make a request" POST JSON ไปที่ URL `/exec` → ยังไม่สำเร็จ (ยังไม่ทราบ status/คำตอบ) ผู้ใช้ให้ข้ามไปก่อน 2026-11-27; จุดที่ต้องตรวจ: Follow redirect = Yes แต่ Follow all redirects = No, Body Raw/JSON

## 10. เมนูคู่มือ API (ในแอป)

สถานะ 2026-11-27: ทำเป็นเมนูแยก "คู่มือ API" (`#api-guide`, `PageApiGuide.html`) ลิงก์จากหน้าเชื่อมต่อภายนอก มีขั้นเริ่มต้น, ช่อง URL ของ API (เก็บใน localStorage เพื่อเติมตัวอย่าง ไม่ส่งไป server), รูปแบบคำขอ/คำตอบ, ตาราง actions พร้อมสถานะ (ใช้ได้/เร็ว ๆ นี้), ตัวอย่าง curl/PowerShell/Node.js/Make/Postman, รหัสข้อผิดพลาด, ตาราง ID ข้อมูลหลัก (โหลดเมื่อกด) และข้อควรระวัง; `tests/api-guide.test.js` ตรวจว่า action ที่เปิดใช้และรหัสข้อผิดพลาดตรงกับ IntegrationService; ยังไม่มี prompt สำหรับ AI (รอ A2); `clasp push` ไป HEAD แล้ว (2026-11-27) และ clone กลับมาเทียบตรงกัน 28 ไฟล์ (ครั้งแรกได้ `Skipping push.` เพราะ appsscript.json ในเครื่องเป็น CRLF แต่บนเซิร์ฟเวอร์เป็น LF เนื้อหาเหมือนกัน → แปลงไฟล์ในเครื่องเป็น LF แทนการใช้ `--force`) ยังไม่ได้ดูหน้าบน `/dev`

ขอบเขตเดิม:

- สร้าง/ปิด/หมุน API key (แสดง key ครั้งเดียว), กำหนด scope, LINE userId ที่อนุญาต, บัญชี/เจ้าของเริ่มต้น
- Endpoint URL, ตัวอย่างคำขอ/คำตอบของทุก action (คัดลอกได้)
- Prompt สำหรับ AI module ใน Make (คัดลอกได้)
- ตาราง ID ของบัญชี/หมวด/เจ้าของ
- รายการรหัสข้อผิดพลาด
- รายละเอียดเชิงเทคนิคเต็มอยู่ในเอกสารนี้ (ไม่ push ขึ้น Apps Script)

## 11. ข้อจำกัดที่ต้องวัดบน `/dev`

- เวลาตอบต่อ action (~2–3 วินาทีต่อคำขอ Apps Script); หนึ่งข้อความ LINE = 2–3 คำขอ → reply token ของ LINE อาจหมดอายุ ใช้ push message ใน Make แทนได้ (นับโควตา OA)
- จำนวน operations ของ Make ต่อเดือน
- quota Apps Script ต่อวัน

## 12. การทดสอบ (เพิ่มใน tests/)

- key ผิด/ปิด/ไม่มี scope, channel_user_id ไม่อยู่ใน whitelist → ปฏิเสธ ไม่เขียนข้อมูล
- `draft.create`: จำนวนเงินผิด, วันที่ผิด, ไม่พบบัญชี, ชื่อกำกวม, ส่ง `*_name`/formula → ปฏิเสธ
- ยืนยัน 2 ครั้ง / request_id เดิม → ธุรกรรมเดียว; หลังหมดอายุ/ยกเลิก/token ผิด/client อื่น → ปฏิเสธ
- เขียนล้มเหลวกลางทาง → retry ด้วย key เดิม ไม่ซ้ำ, ร่างไม่ค้างสถานะผิด
- read actions ตรงกับ `FinanceReports.dashboard`; ร่างที่ยังไม่ยืนยันไม่กระทบยอด
- งบจำนวนการเรียก Sheets ต่อ action ใน `tests/performance.test.js`
- dev-server จำลอง `doPost` (ไม่เรียก LINE/Make/AI จริง)

## 13. สิ่งที่ผู้ใช้ต้องทำเอง

1. สร้าง LINE OA + Messaging API channel และบัญชี Make; เชื่อม LINE ใน Make
2. สร้าง API key จากหน้าเว็บ แล้วเก็บใน Make (เช่น Data store/ตัวแปรที่ซ่อน) — ห้ามส่ง key ในแชต
3. ตั้งค่า AI module ใน Make ด้วย prompt จากคู่มือ
4. อนุญาต: schema ข้อ 7, การสร้าง project/deployment ข้อ 3, การส่งข้อมูลผ่าน Make/AI (§10)

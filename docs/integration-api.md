# Integration API (Make / LINE OA / AI) — แผน (ร่าง รออนุมัติ)

สถานะ: อนุมัติแผนและ schema ApiClients/ApiDrafts 2026-11-27; A1 ผ่านบน TEST ผ่าน gateway G1 (ping ด้วย key จริงได้ `db_target: "TEST"`, key ปิด/เปลี่ยนแล้วถูกปฏิเสธ, ทดสอบด้วย Postman) — การทดสอบผ่าน Make ผู้ใช้ให้ข้ามไปก่อน; หน้า "คู่มือ API" (A4 บางส่วน) ทำในเครื่องแล้ว; ApiDrafts จะเพิ่มใน A2

## 1. เป้าหมายและการแบ่งหน้าที่

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

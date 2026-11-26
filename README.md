# Expense Manager V2

ระบบบันทึกรายรับรายจ่ายส่วนตัว/ครอบครัว บน Google Apps Script + Google Sheets

- ข้อกำหนดโครงการ: [AGENTS.md](AGENTS.md)
- เอกสารออกแบบ: [docs/](docs/) — database-schema, business-rules, system-architecture, development-plan, test-plan
- สถานะ: ปิด Phase 5 และ Phase 6 แล้ว (2026-11-26) ผ่านเทสต์ในเครื่อง 143/143 และทดสอบบน `/dev` ด้วยฐาน TEST; ยังไม่ deploy เป็น Production (ดู docs/development-plan.md และ docs/test-plan.md)

## โครงสร้างไฟล์ runtime (Phase 1)

| ไฟล์ | หน้าที่ |
|---|---|
| `Config.gs` | canonical headers, enum, ชนิดคอลัมน์, projection map |
| `Util.gs` | AppError, UUID, deterministic UUID, เวลา Asia/Bangkok, SHA-256 |
| `ValidationService.gs` | ตรวจข้อความ/ID/enum/เงิน (satang)/วันที่/YYYYMM, ป้องกัน formula injection |
| `Database.gs` | อ่าน/เขียนแบบ batch, ตรวจ header, `initialize()` แบบไม่ทำลายข้อมูล |
| `AuthService.gs` | ตรวจผู้ใช้จาก `ALLOWED_EMAILS` (fail closed), ตรวจเจ้าของสคริปต์ |
| `OperationService.gs` | LockService + idempotency + OperationJournal + AuditLogs |
| `ProjectionService.gs` | เติม/refresh คอลัมน์ `*_name` และข้อมูลแผนใน PaymentSchedules |
| `AccountService.gs` | Master Data (Accounts, Owners, Categories) |
| `TransactionService.gs` | ธุรกรรม (สร้าง/แก้ไข/กลับรายการ/ค้นหา) และ `Ledger` ยอดคงเหลือ |
| `Index.html` `Styles.html` `Scripts.html` `PageTransactions.html` `PageAccounts.html` | หน้าจอ Web App |
| `Code.gs` | `doGet`, Client API (`api_*`) และฟังก์ชันผู้ดูแล |

## ตั้งค่า (ครั้งแรก)

ตั้ง Script Properties ใน Apps Script editor → Project Settings → Script Properties (ห้ามใส่ค่าเหล่านี้ในโค้ดหรือ Git):

| Key | ค่า |
|---|---|
| `SPREADSHEET_ID` | ID ของ Google Sheets Production ("ExpenseManager") |
| `TEST_SPREADSHEET_ID` | ID ของ Google Sheets สำหรับทดสอบ (ต้องไม่ใช่ไฟล์เดียวกับ Production) |
| `ALLOWED_EMAILS` | อีเมล Google ที่ใช้งานได้ คั่นด้วยจุลภาค |
| `DB_TARGET` | (ไม่บังคับ) `TEST` = Web App/API ใช้ไฟล์ทดสอบ; `PRODUCTION` หรือว่าง = ใช้ไฟล์ Production — ฟังก์ชันผู้ดูแล `checkDatabase`/`initializeDatabase`/`refreshProjections` ใช้ Production เสมอ |

ตั้ง timezone ของ Spreadsheet ทั้งสองไฟล์เป็น `(GMT+07:00) Bangkok` (ไฟล์ → การตั้งค่า)

จากนั้นรันใน Apps Script editor (ต้องเป็นเจ้าของสคริปต์):

1. `checkTestDatabase()` แล้ว `initializeTestDatabase()` — เตรียม Spreadsheet ทดสอบ
2. `checkDatabase()` — ตรวจ Production แบบ read-only
3. `initializeDatabase()` — สร้างชีต/header ใน Production (**เมื่อพร้อมใช้งานจริงเท่านั้น**)

`initialize` สร้างเฉพาะชีตที่ขาดและเขียน header ให้ชีตว่าง ไม่ลบชีต (รวม `ชีต1`) ไม่เปลี่ยน header เดิม และไม่แตะแถวข้อมูล ชีตที่ header ไม่ตรงจะถูกรายงานเท่านั้น

## Preview หน้าจอในเครื่อง

```powershell
npm run dev
```

เปิด http://localhost:5178 — ใช้โค้ด .gs จริงกับ Spreadsheet จำลองในหน่วยความจำ (ไม่เชื่อมต่อ Google); `DEV_DELAY_MS` ปรับเวลาตอบกลับ, `DEV_FAIL_RATE` จำลองเครือข่ายล้มเหลว

## ทดสอบในเครื่อง

รายละเอียดเครื่องมือ ข้อควรระวัง และขั้นตอนทดสอบบน Apps Script `/dev` สำหรับนักพัฒนาและ AI agent อยู่ใน [AGENTS.md §21](AGENTS.md)

ต้องใช้ Node.js 20 ขึ้นไป (ไม่มี dependency):

```powershell
npm test
```

ชุดทดสอบใช้ fake Apps Script services ใน `tests/gas-shim.js` จึงตรวจได้เฉพาะ logic — พฤติกรรมของ Google Sheets จริง (การแปลงชนิดข้อมูล, apostrophe prefix, LockService) ต้องตรวจบน Spreadsheet ทดสอบ

## Deploy

`clasp push` / `clasp deploy` ทำเมื่อได้รับอนุญาตเท่านั้น (AGENTS.md §13) — `.claspignore` ส่งเฉพาะ `appsscript.json`, `*.gs`, `*.html` ที่ root

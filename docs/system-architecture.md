# System Architecture — Expense Manager V2

## บัญชีย่อยและรายงานสำหรับส่งต่อ

SubAccounts อ้างอิง Accounts ผ่าน account_id ส่วน Transactions ระบุบัญชีย่อยแยก from/to และ PaymentPlans ระบุ sub_account_id ที่คัดลอกไปทุก PaymentSchedules ทุกผลทางบัญชียังคำนวณที่บัญชีหลักเดิม รายงานบัญชีย่อยใช้ Ledger ชุดเดียวกันโดยจัด endpoint แต่ละฝั่งลงกลุ่ม รวมกลุ่มว่างสำหรับยอดยกมาและรายการเดิม

api_sharedAccountReport คืนเฉพาะชื่อบัญชีย่อย balance, income, expense และ isAsset สำหรับรายงานส่งต่อ หน้าเว็บสร้าง PNG และ CSV จาก payload นี้ การรวมยอดบัญชีหลักและรายงานรายละเอียดส่วนตัวยังมีชื่อบัญชีหลักเพื่อใช้ตรวจสอบ

สถานะ: **ร่างเพื่อขออนุมัติ**
ปรับปรุงล่าสุด: 2026-11-25

## 1. ภาพรวม

```text
Browser (HTML + Tailwind + Vanilla JS, IndexedDB queue)
   │  google.script.run (async, idempotency_key)
   ▼
Google Apps Script Web App
   Code.gs (doGet, routing) → AuthService → ValidationService
   → Service layer (Account/Transaction/Installment/Reservation/PaymentAllocation/Dashboard/Report/Setting)
   → ProjectionService (เติม/refresh *_name)
   → Database.gs (batch read/write, LockService, OperationJournal)
   ▼
Google Sheets (Accounts, Owners, Categories, Transactions, PaymentPlans, PaymentSchedules,
               Reservations, PaymentAllocations, Settings, AuditLogs, OperationJournal)
   ▼
Pivot_* (report views; ไม่อยู่ในเส้นทางบันทึก)
```

- Frontend: รับข้อมูล แสดงผล ตรวจสอบเบื้องต้น ส่งเฉพาะ ID ของ Master
- Backend: ตรวจสิทธิ์ ตรวจข้อมูล Business Logic เติม Projection คำนวณ Derived fields
- Google Sheets: จัดเก็บข้อมูล
- GitHub: Source of Truth ของ Source Code; Clasp เชื่อม Local กับ Apps Script

### 1.1 Spreadsheet เป้าหมาย

| รายการ | ค่า |
|---|---|
| Production database V2 | Google Sheets ชื่อ "ExpenseManager" (ผู้ใช้กำหนด 2026-11-25) — ตรวจแล้ว (read-only): มีเพียงชีตว่าง `ชีต1` ไม่มีข้อมูลเดิม |
| การอ้างอิงจากโค้ด | Apps Script เป็น standalone project จึงเปิดด้วย `SpreadsheetApp.openById()` โดยอ่าน ID จาก Script Properties key `SPREADSHEET_ID` — ไม่ hardcode ID ใน source code หรือเอกสาร |
| Spreadsheet ทดสอบ | แยกไฟล์ต่างหาก (Script Property `TEST_SPREADSHEET_ID` หรือ Script Properties ของ project ทดสอบ); ห้ามเขียนข้อมูลทดสอบลงไฟล์ Production |
| การสร้างชีต/header | ทำโดย `initializeDatabase()` เมื่อผู้ใช้อนุญาตเท่านั้น; ชีตว่าง `ชีต1` ไม่ถูกลบหรือเปลี่ยนชื่ออัตโนมัติ |

## 2. Module responsibilities

| Module | หน้าที่ |
|---|---|
| Config.gs | ชื่อชีต, canonical headers, enum, ค่าคงที่ |
| Util.gs | AppError, UUID, deterministic UUID, เวลา Asia/Bangkok, SHA-256 |
| OperationService.gs | `Operation.run()` (LockService + idempotency + OperationJournal) และ `Audit.log()` |
| Database.gs | อ่าน/เขียนแบบ batch, map header→index, ตรวจ header ตรง canonical, initializeDatabase() แบบไม่ทำลายข้อมูล |
| AuthService.gs | ตรวจผู้ใช้ Google และสิทธิ์ |
| ValidationService.gs | ตรวจ type, enum, YYYYMM, เงิน, FK, Formula Injection |
| ProjectionService.gs | `Projection.loadMasters()`, `apply(sheet, row, masters, {requireActive})`, `applyPlanToSchedule()`, `refresh({dryRun, masterKeys})` |
| AccountService.gs | `MasterData.listAll/create/update/setActive` สำหรับ Accounts/Owners/Categories; refresh projection ทุกครั้งที่แก้ไข (idempotent) |
| TransactionService.gs | `Transactions.create/update/reverse/list/accountBalances` และ `Ledger.effectsOf/balances` ตาม business-rules §3 |
| InstallmentService.gs | ตัวอย่างและสร้างแผนรายจ่ายในอนาคตใน PaymentPlans และ PaymentSchedules |
| PaymentActivity.gs | กัน/ปลดเงิน ชำระ/กลับรายการ ยกเลิก ต่ออายุ ปรับงวดและปิดยอด ผ่าน Operation.run และ recovery checkpoint |
| PlanRevision.gs | คำนวณเงินต้นคงค้าง ตรวจการปรับงวด สร้าง/คืน snapshot ปิดยอด และ version ของแผนกับงวด เป็น pure helpers ไม่เขียนฐานข้อมูล |
| ReservationService.gs | RESERVE/RELEASE/CONSUME |
| PaymentAllocationService.gs | จัดสรรธุรกรรมให้งวด |
| DashboardService.gs / ReportService.gs | อ่านข้อมูล/summary, Export CSV |
| MigrationService.gs | เลื่อนออกไป — ไม่มีข้อมูลระบบเดิม; สร้างเมื่อมีความต้องการนำเข้าข้อมูล |
| SettingService.gs | Settings |

ProjectionService เป็นจุดเดียวที่เขียนคอลัมน์ `*_name` และคอลัมน์ PROJ ของ PaymentSchedules เพื่อไม่ให้มีหลายเส้นทางเขียนค่าที่ขัดกัน

## 3. Projection flow

### 3.1 สร้าง/แก้รายการ

1. Client ส่ง payload ที่มีเฉพาะ ID (+ item_name, description, note, ยอด ฯลฯ)
2. ValidationService ตรวจ FK มีอยู่จริงและ active
3. ProjectionService อ่าน Master ที่ cache ไว้ (CacheService; invalidate เมื่อ Master เปลี่ยน) และเติม `*_name`
4. Database เขียนแถวแบบ batch

### 3.2 เปลี่ยนชื่อ Master (operation_type `RENAME_MASTER`)

1. รับ lock (LockService) และบันทึก OperationJournal `PENDING` พร้อม recovery_data = {entity_type, id, old_name, new_name}
2. อัปเดตแถว Master
3. สำหรับแต่ละตารางที่อ้างอิง (Transactions, PaymentPlans, PaymentSchedules): อ่านคอลัมน์ ID ทั้งคอลัมน์ครั้งเดียว, คำนวณคอลัมน์ชื่อใหม่ในหน่วยความจำ, เขียนกลับเฉพาะคอลัมน์ชื่อด้วย `setValues` ครั้งเดียวต่อคอลัมน์
4. ตรวจผลแล้วตั้ง `COMMITTED` และเขียน AuditLogs หนึ่งรายการ
5. หากล้มเหลวกลางทาง: สถานะ `NEEDS_RECOVERY`; การกู้คืนคือรัน refresh ซ้ำจาก Master (idempotent) ไม่ใช่ย้อนชื่อทีละแถว

### 3.3 สร้างแผน (operation_type `CREATE_PLAN`)

1. สร้าง plan_id และ schedule_id ทั้งหมดล่วงหน้า, บันทึก OperationJournal `PENDING`
2. บันทึกแผนที่ตรวจแล้ว ยอดรายงวด และวันอ้างอิงใน recovery_data ก่อนเขียนข้อมูลธุรกิจ
3. เขียน PaymentPlans 1 แถว แล้วเขียน PaymentSchedules ด้วย batch เดียว คัดลอกข้อมูลธุรกิจด้วย ProjectionService
4. ตรวจจำนวนงวด รหัส และยอดรายงวดเทียบกับแผนที่ตรวจผลรวมแล้วก่อนตั้ง `COMMITTED`
5. การลองใหม่ด้วย idempotency_key เดิมใช้ข้อมูลจาก checkpoint และ ID เดิม เติมเฉพาะแถวที่ขาด หน้ารายการแสดงแผนเมื่อมีจำนวนงวดครบ

## 3.4 Performance (2026-11-26)

- **Cache ภายใน execution** (`Database`): ตรวจ header ครั้งเดียวต่อชีต; อ่านทั้งตารางด้วย `getDataRange().getValues()` ครั้งเดียว (รวม header); การเขียน (append/update/writeColumn/writeRowAt) อัปเดต cache ทันทีจึงไม่ต้องอ่านซ้ำ
- `Operation.run` เรียก `Database.resetExecutionCache()` หลังได้ lock เพื่อไม่ใช้ข้อมูลที่อ่านก่อน lock; `handleApi_` reset ทุกคำขอ
- ตาราง append-only ที่โตเรื่อย ๆ (OperationJournal, AuditLogs) ไม่ถูกอ่านทั้งตาราง: append ใช้ `getLastRow()`, ค้น journal ด้วย `TextFinder` (`Database.findRowsByValue`)
- `MasterData.update` refresh projection เฉพาะเมื่อชื่อเปลี่ยนหรือเป็นการ replay (`ctx.replay`)
- `api_transactionPage` โหลดรายการ + ตัวช่วยกรอก (+ Master) ในคำขอเดียว
- เมื่อหน้ารายการสร้าง แก้ไข หรือกลับรายการ จะส่งตัวกรองปัจจุบันไปกับคำขอเขียน หลังยืนยันการเขียนแล้ว API ส่งแถวที่บันทึก รายการตามตัวกรอง ยอดสรุป และตัวช่วยกรอกกลับมาโดยใช้ cache ของ execution เดียวกัน ถ้าตัวกรองเปลี่ยนระหว่างรอหรืออ่านผลอัปเดตไม่สำเร็จ หน้าจอจะโหลดรายการแยกอีกครั้งตามตัวกรองล่าสุด
- การสร้างรายการใหม่เข้าคิวทันทีและแสดง “กำลังบันทึก…” แยกจากยอดสรุป เรียกเขียนตามลำดับ การส่งซ้ำหลังเครือข่ายล้มเหลวหรือระบบไม่ว่างใช้ payload และ idempotency key เดิม โดยลองอัตโนมัติอีกหนึ่งครั้งหลังหน่วง 1 วินาที จากนั้นผู้ใช้กดลองใหม่ได้
- คิวเก็บเฉพาะข้อมูลที่ต้องส่งและ idempotency key ใน IndexedDB แยกตามบัญชี Google และไฟล์ข้อมูล เมื่อเปิดหน้าใหม่จะให้ผู้ใช้ลองส่งคิวค้างเอง หาก IndexedDB ใช้ไม่ได้ คิวจะอยู่บนหน้าที่เปิดอยู่พร้อมข้อความแจ้งข้อจำกัด
- งบการเรียก Sheets ต่อคำขอถูกตรวจใน `tests/performance.test.js`; เครื่องมือวัด `node tests/perf-probe.js`

| คำขอ | ก่อน (fake calls) | หลัง |
|---|---:|---:|
| createTransaction | 107 | 38 (getValues 6, setValues 4) |
| updateMaster (ไม่เปลี่ยนชื่อ) | 156 | 33 |
| โหลดหน้ารายการ | 3 คำขอ ≈ 81 | 1 คำขอ, getValues 4 |

เวลาจริงบน `/dev` ก่อนรวมคำขอหลังเขียน: createTransaction 8.5 → 6.0 s, reverse 5.2 → 3.0 s, โหลดหน้า 3 คำขอ → 1 คำขอ 3.1–3.3 s (ดู test-plan)

## 4. Read path

- Dashboard/Report อ่านข้อมูลต้นฉบับหรือ summary cache ไม่พึ่ง Pivot
- ตารางรายการแสดง `*_name` จากแถวโดยตรง ไม่ต้อง join ฝั่ง Client
- Pagination และ Debounce การค้นหา; ค้นหา/กรองด้วยชื่อ แต่ส่ง filter เป็น ID เมื่อผู้ใช้เลือกจากรายการ

## 5. ความปลอดภัย

- ตรวจ Authentication/Authorization ที่ Backend ทุก request
- ไม่รับ `*_name`, DER, SYS fields จาก Client
- Escape output ป้องกัน XSS; ป้องกัน Formula Injection ตอนเขียนชีต
- recovery_data ไม่ส่งให้ Client; ไม่ log ข้อมูลการเงินเกินจำเป็น

## 6. ข้อจำกัด

- Google Sheets ไม่มี ACID ข้ามชีต: การ refresh ชื่อหรือสร้างแผนอาจค้างกลางทาง ต้องอาศัย OperationJournal + refresh/replay
- การ refresh ชื่อมีต้นทุนตามจำนวนแถว (อ่าน/เขียนทั้งคอลัมน์) ควรทดสอบเวลาเมื่อข้อมูลหลายหมื่นแถว
- ยังอ่าน Transactions ทั้งตารางในทุกคำขอที่ต้องใช้ (list/suggestions/create) — ถ้าข้อมูลโตมากต้องพิจารณา summary cache/แบ่งชีตตามปีในภายหลัง
- `appsscript.json` ตั้ง `timeZone` เป็น `Asia/Bangkok` แล้ว (2026-11-25) แต่ยังไม่ได้ push ไป Apps Script; Spreadsheet ต้องตั้ง timezone เป็น Asia/Bangkok แยกต่างหาก (File → Settings)

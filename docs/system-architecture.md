# System Architecture — Expense Manager V2

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

## 2. Module responsibilities

| Module | หน้าที่ |
|---|---|
| Config.gs | ชื่อชีต, canonical headers, enum, ค่าคงที่ |
| Database.gs | อ่าน/เขียนแบบ batch, map header→index, ตรวจ header ตรง canonical, initializeDatabase() แบบไม่ทำลายข้อมูล |
| AuthService.gs | ตรวจผู้ใช้ Google และสิทธิ์ |
| ValidationService.gs | ตรวจ type, enum, YYYYMM, เงิน, FK, Formula Injection |
| ProjectionService.gs (ใหม่) | `resolveNames(ids)`, `applyProjection(row)`, `refreshProjectionsFor(entityType, id)`, `refreshProjections()` (ซ่อมทั้งหมด) |
| AccountService.gs | Accounts/Owners/Categories; เรียก ProjectionService เมื่อชื่อเปลี่ยน |
| TransactionService.gs | Transactions ตาม business-rules §3 |
| InstallmentService.gs | PaymentPlans + PaymentSchedules, คัดลอกข้อมูลแผนไปงวด |
| ReservationService.gs | RESERVE/RELEASE/CONSUME |
| PaymentAllocationService.gs | จัดสรรธุรกรรมให้งวด |
| DashboardService.gs / ReportService.gs | อ่านข้อมูล/summary, Export CSV |
| MigrationService.gs | dry run, backup, migrate ระบบเดิม |
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
2. เขียน PaymentPlans 1 แถว
3. เขียน PaymentSchedules N แถวด้วย batch เดียว โดยคัดลอก Business Information จากแผน
4. ตรวจจำนวนแถวและผลรวม amount_due = total_amount แล้ว `COMMITTED`
5. retry ด้วย idempotency_key เดิมจะใช้ ID เดิม จึงไม่สร้างงวดซ้ำ

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
- `appsscript.json` ปัจจุบันตั้ง `timeZone` เป็น `America/New_York` ขัดกับข้อกำหนด Asia/Bangkok — ต้องแก้ในขั้น Implementation (ยังไม่แก้ในขั้นเอกสาร)

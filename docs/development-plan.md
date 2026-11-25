# Development Plan — Expense Manager V2

สถานะ: **ร่างเพื่อขออนุมัติ** — ยังไม่เริ่ม Implementation, ยังไม่แก้ฐานข้อมูลจริง, ยังไม่ Deploy
ปรับปรุงล่าสุด: 2026-11-25

## Phase 0 — เอกสารและการอนุมัติ (ขั้นปัจจุบัน)

- [x] AGENTS.md ปรับ canonical headers และ Data Management Rules
- [x] docs/database-schema.md, business-rules.md, system-architecture.md, development-plan.md, test-plan.md
- [x] จัดทำ docs/migration-plan.md (ร่าง: mapping ตามความหมาย, 2026-11-25)
- [x] ยืนยันว่าไม่มีข้อมูลระบบเดิม — เริ่ม V2 ใหม่ ไม่ต้อง Migration (2026-11-25)
- [x] ผู้ใช้อนุมัติ Final Database Schema (2026-11-25)
- [x] `appsscript.json` timeZone → Asia/Bangkok (2026-11-25; ยังไม่ clasp push)

**Gate:** Phase 0 ครบแล้ว; เริ่ม Phase 1 ได้เมื่อผู้ใช้สั่งเริ่ม Implementation (ต้องมี Spreadsheet ทดสอบแยกจาก Production)

## Phase 1 — Foundation (โค้ดเสร็จและ push แล้ว 2026-11-25; integration test บน Spreadsheet ทดสอบยังไม่ได้ทำ)

- Config.gs (canonical headers ตาม database-schema.md §3), Database.gs, initializeDatabase() แบบ idempotent ไม่ทำลายข้อมูล และตรวจ header ไม่ตรงโดยไม่แก้เอง
- AuthService, ValidationService (YYYYMM, Money, enum, FK, Formula Injection)
- OperationJournal + LockService + idempotency
- ProjectionService (resolveNames, applyProjection, refreshProjections)
- ใช้ Spreadsheet ทดสอบที่แยกจาก Production เท่านั้น
- Spreadsheet ทดสอบ: ผู้ใช้กำหนดแล้ว (2026-11-25) ตั้งเป็น Script Property `TEST_SPREADSHEET_ID`
- Unit tests ในเครื่อง (`npm test`) ผ่าน 44/44 กรณี
- 2026-11-25: clasp push แล้ว; Script Properties ตั้งแล้ว; รัน `initializeDatabase()` บน Production สำเร็จ (สร้าง 11 ชีต, ไม่มีข้อมูลธุรกิจ); รัน `initializeTestDatabase()` สำเร็จ (11 ชีต)
- Production = Google Sheets "ExpenseManager" ที่ผู้ใช้กำหนด (ปัจจุบันว่าง); ตั้ง Script Property `SPREADSHEET_ID` และรัน `initializeDatabase()` บน Production เมื่อผู้ใช้อนุญาตเท่านั้น

## Phase 2 — Master Data (Backend + API + หน้าจอเสร็จ 2026-11-25; ยังไม่ clasp push)

- `AccountService.gs` (`MasterData.listAll/create/update/setActive`) และ API `api_listMasters`, `api_createMaster`, `api_updateMaster`, `api_setMasterActive` ใน Code.gs
- หน้าจอ: `Index.html` (shell + nav), `Styles.html`, `Scripts.html` (App.call / submitter / toast / confirm), `PageAccounts.html`
- Dev preview ในเครื่อง: `npm run dev` (`tests/dev-server.js`, ข้อมูลจำลองในหน่วยความจำ)
- ยังเหลือ: integration test บน Spreadsheet ทดสอบหลัง clasp push; IndexedDB queue ยังไม่ทำ (จะทำพร้อม Transactions/Quick Entry)

- Accounts, Owners, Categories: เพิ่ม แก้ไข ปิดใช้งาน (is_active)
- เปลี่ยนชื่อ Master → refresh ชื่อใน Transactions/PaymentPlans/PaymentSchedules (RENAME_MASTER)
- ตรวจชื่อซ้ำตาม BR-DM-09

## Phase 3 — Transactions

- CRUD ตาม business-rules §3 (from/to account ตามประเภท), กลับรายการแทนการลบ
- Backend เติม from_account_name, to_account_name, owner_name, category_name
- ค้นหา/กรอง/Pagination, ป้องกันรายการซ้ำ

## Phase 4 — Payment Planner

- PaymentPlans + PaymentSchedules (คัดลอก Business Information ทุกงวด, note รายงวดแยก)
- ตัวอย่างงวดก่อนยืนยัน, แก้ยอดรายงวด, ปรับเศษงวดสุดท้าย
- Reservations, PaymentAllocations, ยกเลิกแผน/งวดโดยรักษาประวัติ
- Derived status/ยอด คำนวณใหม่หลังทุกเหตุการณ์

## Phase 5 — Dashboard, Reports, Pivot

- Dashboard ตาม AGENTS.md §6.1
- Pivot_Saving / Pivot_Payment / Pivot_Transactions จาก name columns และ derived report view
- Export CSV

## Phase 6 — Reliability

- ทดสอบล้มเหลวกลางทาง/กู้คืน/retry, เขียนพร้อมกัน
- ไม่มี Migration (ไม่มีข้อมูลระบบเดิม); การตั้งยอดยกมาทำผ่าน Accounts.opening_balance

## Phase 7 — Optional AI

- แปลงข้อความ/สลิปเป็น Structured JSON ที่มีเฉพาะ ID → Validation → ผู้ใช้ยืนยัน

## Definition of Done ต่อ Phase

ตาม AGENTS.md §18 และกรณีทดสอบที่เกี่ยวข้องใน [test-plan.md](test-plan.md)

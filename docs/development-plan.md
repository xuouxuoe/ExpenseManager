# Development Plan — Expense Manager V2

สถานะ: **ร่างเพื่อขออนุมัติ** — ยังไม่เริ่ม Implementation, ยังไม่แก้ฐานข้อมูลจริง, ยังไม่ Deploy
ปรับปรุงล่าสุด: 2026-11-25

## Phase 0 — เอกสารและการอนุมัติ (ขั้นปัจจุบัน)

- [x] AGENTS.md ปรับ canonical headers และ Data Management Rules
- [x] docs/database-schema.md, business-rules.md, system-architecture.md, development-plan.md, test-plan.md
- [ ] ตรวจ Spreadsheet ระบบเดิมแบบ read-only และจัดทำ docs/migration-plan.md (mapping ระดับคอลัมน์)
- [x] ผู้ใช้อนุมัติ Final Database Schema (2026-11-25)
- [x] `appsscript.json` timeZone → Asia/Bangkok (2026-11-25; ยังไม่ clasp push)

**Gate:** schema อนุมัติแล้ว; ก่อนเริ่ม Phase 1 ยังต้องมี migration-plan.md

## Phase 1 — Foundation

- Config.gs (canonical headers ตาม database-schema.md §3), Database.gs, initializeDatabase() แบบ idempotent ไม่ทำลายข้อมูล และตรวจ header ไม่ตรงโดยไม่แก้เอง
- AuthService, ValidationService (YYYYMM, Money, enum, FK, Formula Injection)
- OperationJournal + LockService + idempotency
- ProjectionService (resolveNames, applyProjection, refreshProjections)
- ใช้ Spreadsheet ทดสอบที่แยกจาก Production เท่านั้น

## Phase 2 — Master Data

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

## Phase 6 — Reliability & Migration

- ทดสอบล้มเหลวกลางทาง/กู้คืน/retry, เขียนพร้อมกัน
- Migration จากระบบเดิม: backup → dry run → ตรวจผล → migrate (ต้องได้รับอนุญาต)

## Phase 7 — Optional AI

- แปลงข้อความ/สลิปเป็น Structured JSON ที่มีเฉพาะ ID → Validation → ผู้ใช้ยืนยัน

## Definition of Done ต่อ Phase

ตาม AGENTS.md §18 และกรณีทดสอบที่เกี่ยวข้องใน [test-plan.md](test-plan.md)

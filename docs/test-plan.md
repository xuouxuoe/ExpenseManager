# Test Plan — Expense Manager V2

สถานะ: Phase 1 — unit tests ในเครื่องผ่านแล้ว; ยังไม่ทดสอบบน Google Sheets จริง
ปรับปรุงล่าสุด: 2026-11-25

ใช้ข้อมูลจำลองใน Spreadsheet ทดสอบเท่านั้น ห้ามใช้หรือสร้างข้อมูลทดสอบใน Production

## 0. ผลการทดสอบ Phase 1 (2026-11-25)

ระดับ: **Unit test ใน Node.js** (`npm test`, `tests/*.test.js`) ด้วย fake Apps Script services (`tests/gas-shim.js`) — **44/44 ผ่าน**

| กลุ่ม | ครอบคลุม |
|---|---|
| Validation | YYYYMM (ปฏิเสธ 202613/202600/20261), addMonths ข้ามปี, ตาราง 6 งวด AGENTS §6.3, due_date สิ้นเดือน/ปีอธิกสุรทิน, วันที่ ค.ศ. (ปฏิเสธปี พ.ศ.), เงิน satang, แบ่งงวด 600/6 และ 1000/3, ข้อความ, formula injection |
| Schema | TC-SC-01..04 (header ตรง AGENTS.md และ database-schema.md, initialize ซ้ำไม่ทำลาย, header ไม่ตรงถูกรายงานและปฏิเสธการอ่าน/เขียน) |
| Database | batch write ครั้งเดียว, updateRows รวมแถวติดกัน, appendRowsIfAbsent, แยก TEST/PRODUCTION |
| Auth | allowlist, fail closed, requireOwner, doGet ปฏิเสธผู้ไม่มีสิทธิ์ |
| Operation | COMMITTED + audit, retry key เดิม (TC-TX-07, TC-PP-16), payload ต่าง (TC-PP-17), ล้มเหลวกลางทาง → NEEDS_RECOVERY → replay ไม่ซ้ำ, FAILED, BUSY |
| Projection | TC-DM-01..05, TC-PP-04, TC-PP-05, TC-PP-07, refresh idempotent, FK กำพร้า |

**ยังไม่ได้ทดสอบ (ต้องทำบน Spreadsheet ทดสอบหลัง clasp push ที่ได้รับอนุญาต):** การแปลงชนิดข้อมูลของ Sheets จริงกับรูปแบบ `@`, apostrophe prefix (TC-DM-08), LockService พร้อมกันจริง, Session.getActiveUser ใน Web App, เวลา refresh กับข้อมูลจำนวนมาก

## 1. Schema

| ID | กรณี | ผลที่คาดหวัง |
|---|---|---|
| TC-SC-01 | initializeDatabase() บนไฟล์ว่าง | สร้างทุกชีตด้วย header ตรง database-schema.md §3 ทุกคอลัมน์ทุกลำดับ |
| TC-SC-02 | initializeDatabase() ซ้ำบนไฟล์ที่มีข้อมูล | ไม่ลบ/ไม่เขียนทับข้อมูล |
| TC-SC-03 | header ไม่ตรง canonical (ขาด/เกิน/สลับ) | รายงานความต่าง ไม่แก้ header เอง |
| TC-SC-04 | ตรวจ header ซ้ำทุกชีต | ไม่มี header ซ้ำ |

## 2. ID / Name / Projection

| ID | กรณี | ผลที่คาดหวัง |
|---|---|---|
| TC-DM-01 | สร้าง Transaction โดยส่งเฉพาะ ID | from/to_account_name, owner_name, category_name ตรงกับ Master |
| TC-DM-02 | Client ส่ง `owner_name` ปลอมมาด้วย | ถูกละเลย ใช้ชื่อจาก Master |
| TC-DM-03 | ส่ง account_id ที่ไม่มีอยู่ / inactive | ปฏิเสธ |
| TC-DM-04 | เปลี่ยนชื่อบัญชีที่ใช้ใน Transactions (ทั้ง from และ to), PaymentPlans, PaymentSchedules | ชื่อในทุกตารางเปลี่ยน, ID ไม่เปลี่ยน, ยอดเงินไม่เปลี่ยน, updated_at ของแถวที่ refresh ไม่เปลี่ยน, AuditLogs 1 รายการ |
| TC-DM-05 | เปลี่ยนชื่อเจ้าของ / หมวดหมู่ | เหมือน TC-DM-04 |
| TC-DM-06 | การเปลี่ยนชื่อล้มเหลวกลางทาง (จำลอง error หลังอัปเดต Transactions) | OperationJournal = NEEDS_RECOVERY; refreshProjections() ทำให้ทุกตารางตรงกับ Master |
| TC-DM-07 | ตั้งชื่อ Master ซ้ำกับรายการ active | ปฏิเสธ |
| TC-DM-08 | ชื่อหรือ note ขึ้นต้นด้วย `=SUM(A1)` | เก็บเป็นข้อความ ไม่ถูกประมวลผลเป็นสูตร |
| TC-DM-09 | ชื่อมี `<script>` | แสดงผลแบบ escape |

## 3. Payment Planner

| ID | กรณี | ผลที่คาดหวัง |
|---|---|---|
| TC-PP-01 | แผน 600 บาท 6 งวด เริ่มเก็บ 202611 เริ่มชำระ 202612 | 6 แถว, installment_no 1–6, installment_count = 6 ทุกแถว, ยอดรวม 600, เดือนตามตาราง AGENTS.md §6.3 |
| TC-PP-02 | งวดข้ามปี 202612 → 202701 | ถูกต้อง |
| TC-PP-03 | first_saving_month = 202613 / 202600 / 20261 | ปฏิเสธ |
| TC-PP-04 | ทุกงวดได้ account/owner/category id+name, item_name, description เดียวกับแผน | ตรงทุกแถว |
| TC-PP-05 | note ของแผนมีค่า | note ของทุกงวดว่าง |
| TC-PP-06 | แก้ note งวดที่ 3 | เฉพาะงวด 3 เปลี่ยน; ยอด/สถานะไม่เปลี่ยน |
| TC-PP-07 | แก้ item_name/description/category ของแผนหลังแก้ note งวด 3 | ทุกงวดได้ค่าใหม่, note งวด 3 ยังอยู่ |
| TC-PP-08 | แก้ account_id ของแผนที่มี RESERVE แล้ว | ปฏิเสธ |
| TC-PP-09 | 1000 บาท 3 งวด | 333.33, 333.33, 333.34 |
| TC-PP-10 | due_day = 31 ในเดือน 202702 | due_date = 2027-02-28 |
| TC-PP-11 | ไม่ระบุ due_day | due_date ว่าง |
| TC-PP-12 | saving_month ≠ payment_month | is_month_different = TRUE, ปี/เดือนแยกถูกต้อง |
| TC-PP-13 | ชำระบางส่วน + เลย due_date | payment_status = PARTIAL และ is_overdue = TRUE |
| TC-PP-14 | ONE_TIME | 1 แถว installment_no = 1, installment_count = 1 |
| TC-PP-15 | สถานะไม่ขึ้นกับ note (note = "จ่ายแล้ว" แต่ไม่มี allocation) | payment_status = UNPAID |
| TC-PP-16 | retry CREATE_PLAN ด้วย idempotency_key เดิม | ไม่เกิดงวดซ้ำ |
| TC-PP-17 | key เดิม payload ต่าง | ปฏิเสธ |

## 4. Reservations / Allocations

| ID | กรณี | ผลที่คาดหวัง |
|---|---|---|
| TC-RS-01 | กันเงินจาก 2 บัญชีให้งวดเดียว | amount_saved รวมถูกต้อง |
| TC-RS-02 | RELEASE เกินยอดที่กันในบัญชีนั้น | ปฏิเสธ |
| TC-RS-03 | CONSUME ไม่มี transaction_id | ปฏิเสธ |
| TC-RS-04 | ชำระครั้งเดียวครอบคลุม 2 งวด | 2 allocations, ผลรวม ≤ amount |
| TC-RS-05 | จัดสรรเกินยอดค้างงวด | ปฏิเสธ |
| TC-RS-06 | กลับรายการธุรกรรมชำระ | amount_paid/สถานะคำนวณใหม่, ประวัติยังอยู่ |

## 5. Transactions

| ID | กรณี | ผลที่คาดหวัง |
|---|---|---|
| TC-TX-01 | TRANSFER ระหว่างบัญชีสินทรัพย์ | from/to name ถูกต้อง, ไม่นับเป็นรายรับ/รายจ่าย |
| TC-TX-02 | TRANSFER from = to | ปฏิเสธ |
| TC-TX-03 | INCOME มี from_account_id | ปฏิเสธ |
| TC-TX-04 | EXPENSE ไม่มี category_id | ปฏิเสธ |
| TC-TX-05 | amount ≤ 0 / ไม่ใช่ตัวเลข / ทศนิยม 3 ตำแหน่ง | ปฏิเสธ |
| TC-TX-06 | CREDIT_PURCHASE + CREDIT_PAYMENT | รายจ่ายรับรู้ครั้งเดียว |
| TC-TX-07 | บันทึกซ้ำ (double submit) | บันทึกครั้งเดียว |

## 6. Pivot / Reports

| ID | กรณี | ผลที่คาดหวัง |
|---|---|---|
| TC-PV-01 | Pivot PaymentSchedules ตาม account_name × saving_month | ผลรวม amount_due ถูกต้อง ไม่ซ้ำ total_amount |
| TC-PV-02 | Pivot ตาม owner_name, category_name, item_name × payment_month | ถูกต้อง |
| TC-PV-03 | หลังเปลี่ยนชื่อบัญชี | Pivot รวมอยู่ใต้ชื่อใหม่ชื่อเดียว ไม่แตกเป็นสองแถว |
| TC-PV-04 | งวดที่ยกเลิก | ไม่ถูกนับในแผน |
| TC-PV-05 | รายงานชำระจริง | ใช้เดือนจาก transaction_date ไม่ใช่ payment_month |

## 7. Non-functional

- การเขียนพร้อมกัน 2 session (LockService)
- Backend ล้มเหลว / timeout → UI แสดง error และ retry ด้วย key เดิม
- ผู้ใช้ไม่มีสิทธิ์ → ปฏิเสธที่ Backend
- มือถือ: ฟอร์มสร้างแผนและรายการใช้งานได้ที่ 375px
- เวลา refresh ชื่อเมื่อข้อมูล 10,000+ แถว ต่ำกว่าขีดจำกัดเวลา Apps Script

### 7.1 Migration (อ้างอิง [migration-plan.md](migration-plan.md))

**เลื่อนออกไป** — ไม่มีข้อมูลระบบเดิม (2026-11-25); ใช้เมื่อมีการนำเข้าข้อมูลในอนาคตเท่านั้น ใช้ไฟล์จำลองเท่านั้น

| ID | กรณี | ผลที่คาดหวัง |
|---|---|---|
| TC-MG-01 | Dry run | ไม่มีการเขียนลง V1 หรือ V2; มีเฉพาะ Migration Report |
| TC-MG-02 | runMigration โดย target = source | ปฏิเสธ |
| TC-MG-03 | งวด V1 รูปแบบ "1/6" | installment_no = 1, installment_count = 6 แยกคอลัมน์ |
| TC-MG-04 | เดือน "12/2026" → "01/2027" และค่า 202613 | 202612, 202701; 202613 เข้า Review INVALID_MONTH |
| TC-MG-05 | วันที่ปี พ.ศ. 2569 | 2026-xx-xx |
| TC-MG-06 | งวดสถานะ "จ่ายแล้ว" ไม่มีวันที่/ยอดจ่าย | ไม่สร้าง Transaction; Review STATUS_ONLY; payment_status = UNPAID |
| TC-MG-07 | ผลรวมงวด ≠ ยอดรวมแผน | Review SUM_MISMATCH |
| TC-MG-08 | note มีเลข 16 หลัก | ไม่ถูก migrate; Review SENSITIVE_DATA |
| TC-MG-09 | รัน migrate ซ้ำ | ไม่เพิ่มแถว (ID deterministic) |
| TC-MG-10 | Reconciliation RC-01 ถึง RC-11 | ผ่านทั้งหมดบนชุดข้อมูลจำลองที่ถูกต้อง |

## 8. สถานะ

ยังไม่ได้ดำเนินการทดสอบใด ๆ — ห้ามรายงานว่าผ่านจนกว่าจะรันจริง

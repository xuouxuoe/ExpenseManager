# Business Rules — Expense Manager V2

สถานะ: **ร่างเพื่อขออนุมัติ**
ปรับปรุงล่าสุด: 2026-11-25
อ้างอิง schema: [database-schema.md](database-schema.md)

## 1. ID และ Name (Data Management Rules)

| รหัส | กฎ |
|---|---|
| BR-DM-01 | ใช้ `*_id` (UUID) เป็นรหัสอ้างอิงหลักระหว่างตารางเสมอ ห้ามอ้างอิงด้วยชื่อหรือเลขแถว |
| BR-DM-02 | ใช้ `*_name` สำหรับแสดงผล ค้นหา กรองข้อมูล และ Pivot Table เท่านั้น |
| BR-DM-03 | Backend ดึงชื่อจาก Master Data (Accounts, Owners, Categories) อัตโนมัติทุกครั้งที่สร้างหรือแก้ไขรายการ |
| BR-DM-04 | ผู้ใช้เลือกจากรายการ (UI ส่งเฉพาะ ID) ไม่ต้องกรอกชื่อและรหัสซ้ำ; API ไม่รับคอลัมน์ `*_name` จาก Client — หากส่งมาให้ละเลยและใช้ค่าจาก Master |
| BR-DM-05 | เมื่อแก้ชื่อบัญชี เจ้าของ หรือหมวดหมู่ ID ต้องไม่เปลี่ยน และ Backend refresh ชื่อใน Transactions, PaymentPlans, PaymentSchedules ทุกแถวที่อ้างอิง ID นั้น (รวมรายการในอดีต) ภายใน operation เดียว |
| BR-DM-06 | การ refresh ชื่อเป็นการปรับ Projection ไม่ใช่การแก้ไขธุรกิจ: ไม่เปลี่ยน `updated_at` ของแถวที่ถูก refresh, ไม่คำนวณยอดใหม่, บันทึก AuditLogs หนึ่งเหตุการณ์ (`RENAME_MASTER`) ต่อการเปลี่ยนชื่อ |
| BR-DM-07 | ต้องมีฟังก์ชันตรวจและซ่อม Projection (`refreshProjections`) ที่คำนวณชื่อใหม่จาก ID ได้ทุกเมื่อแบบ idempotent สำหรับกู้คืนเมื่อ refresh ล้มเหลวกลางทาง |
| BR-DM-08 | Master ที่ `is_active = FALSE` ยังแสดงชื่อในรายการเดิมได้ แต่ห้ามเลือกใช้ในรายการใหม่; ห้ามลบ Master ที่ถูกอ้างอิง |
| BR-DM-09 | ชื่อ Master ต้องไม่ว่าง ตัดช่องว่างหัวท้าย และไม่ซ้ำในกลุ่มเดียวกันที่ active (Accounts/Owners ทั้งตาราง, Categories ภายใน category_type) เพื่อไม่ให้ Pivot รวมคนละรายการเข้าด้วยกัน |
| BR-DM-10 | ข้อความทุกคอลัมน์ที่ผู้ใช้กรอก (item_name, description, note, ชื่อ Master) ต้องผ่านการป้องกัน Formula Injection (ค่าขึ้นต้นด้วย `=`, `+`, `-`, `@`, Tab, CR ให้เก็บเป็นข้อความ) และ escape ตอนแสดงผลเพื่อป้องกัน XSS |

## 2. description และ note

| รหัส | กฎ |
|---|---|
| BR-NT-01 | `description` เก็บรายละเอียดของรายการหลัก (สินค้า/บริการ/ธุรกรรม) |
| BR-NT-02 | `note` เก็บหมายเหตุเพิ่มเติม แต่ละแถวเป็นอิสระ ไม่ใช่ Projection |
| BR-NT-03 | `PaymentSchedules.description` คัดลอกจาก `PaymentPlans.description` และแก้ได้ที่แผนเท่านั้น |
| BR-NT-04 | `PaymentSchedules.note` แก้แยกรายงวดได้ เริ่มต้นว่าง ไม่คัดลอกจาก `PaymentPlans.note` และไม่ถูกเขียนทับเมื่อแก้แผนหรือ refresh projection |
| BR-NT-05 | การแก้ `note` เพียงอย่างเดียวไม่กระทบยอดหรือสถานะ และแก้ได้แม้งวดชำระแล้วหรือยกเลิกแล้ว (มี audit) |
| BR-NT-06 | ห้ามใช้ `note` หรือ `description` แทนสถานะเก็บเงิน/สถานะชำระ หรือเป็นข้อมูลที่ระบบใช้คำนวณ; สถานะต้องมาจาก `saving_status`, `payment_status`, `is_overdue`, `is_cancelled` เท่านั้น |

## 3. Transactions

### 3.1 ทั่วไป

- amount > 0 เสมอ ทิศทางกำหนดโดย Backend จาก transaction_type และประเภทบัญชี
- item_name บังคับ; description, note ไม่บังคับ
- ห้ามลบธุรกรรมจริง ใช้การกลับรายการ (`reversal_of`)
- ป้องกันรายการซ้ำด้วย idempotency_key และแจ้งเตือนรายการที่อาจซ้ำ (วันที่ + ประเภท + ยอด + บัญชีต้นทาง/ปลายทาง + item_name เดียวกัน) — ผู้ใช้ยืนยันบันทึกต่อได้ (`allow_duplicate`)
- client ส่งได้เฉพาะ: transaction_date, transaction_type, from/to_account_id, owner_id, category_id, item_name, description, amount, external_ref, note, source (MANUAL | QUICK_ENTRY); plan_id, reversal_of, *_name, timestamps กำหนดโดย Backend
- **แก้ไข** ได้เมื่อรายการไม่ใช่รายการกลับ, ยังไม่ถูกกลับรายการ, ไม่เชื่อมแผน (plan_id) และไม่ถูกจัดสรรให้งวด; ค่าก่อนแก้เก็บใน OperationJournal.recovery_data (server เท่านั้น)
- **กลับรายการ** แทนการลบ: สร้างรายการใหม่ `reversal_of` = ต้นฉบับ, ประเภท/บัญชี/หมวด/ยอดเดิม, item_name ขึ้นต้น "กลับรายการ: ", note = เหตุผล (บังคับ), วันที่ไม่ก่อนต้นฉบับ; **รายการที่มี reversal_of มีผลทางบัญชีตรงข้ามกับต้นฉบับทุกค่า**; กลับซ้ำ/กลับรายการกลับไม่ได้
- ผลต่อยอดบัญชี (balance ของสินทรัพย์ = เงินคงเหลือ, ของหนี้สิน = หนี้คงค้าง): INCOME to +; EXPENSE from −; TRANSFER from −, to +; CREDIT_PURCHASE from +; CREDIT_PAYMENT from −, to −; CASH_ADVANCE from +, to +; INTEREST/FEE from: สินทรัพย์ −, หนี้สิน +; REFUND to: สินทรัพย์ +, หนี้สิน −; ADJUSTMENT from −, to + (ตาม balance ของบัญชีนั้น)
- รายรับ = INCOME; รายจ่าย = EXPENSE + CREDIT_PURCHASE + INTEREST + FEE − REFUND (TRANSFER, CREDIT_PAYMENT, CASH_ADVANCE, ADJUSTMENT ไม่นับ)
- ระบบยังไม่ห้ามยอดเงินสด/เงินฝากติดลบ (แสดงยอดติดลบให้เห็น)

### 3.2 บัญชีต้นทาง/ปลายทางตามประเภท

ความหมาย: `from_account` = บัญชีที่มูลค่าไหลออกหรือหนี้เพิ่ม, `to_account` = บัญชีที่มูลค่าไหลเข้าหรือหนี้ลด

| transaction_type | from_account_id | to_account_id | category_id |
|---|---|---|---|
| INCOME | ว่าง | บังคับ (สินทรัพย์) | บังคับ (INCOME) |
| EXPENSE | บังคับ (สินทรัพย์) | ว่าง | บังคับ (EXPENSE) |
| TRANSFER | บังคับ (สินทรัพย์) | บังคับ (สินทรัพย์, ต่างจาก from) | ไม่ใช้ |
| CREDIT_PURCHASE | บังคับ (CREDIT_CARD / CASH_CARD / LOAN) | ว่าง | บังคับ (EXPENSE) |
| CREDIT_PAYMENT | บังคับ (สินทรัพย์) | บังคับ (หนี้สิน) | ไม่ใช้ |
| CASH_ADVANCE | บังคับ (CREDIT_CARD / CASH_CARD / LOAN) | บังคับ (สินทรัพย์) | ไม่ใช้ |
| INTEREST / FEE | บังคับ (บัญชีที่ถูกเรียกเก็บ) | ว่าง | บังคับ (EXPENSE) |
| REFUND | ว่าง | บังคับ (บัญชีที่รับคืน) | บังคับ (หมวดของรายการต้นฉบับ) |
| ADJUSTMENT | ระบุอย่างใดอย่างหนึ่ง | ระบุอย่างใดอย่างหนึ่ง | ไม่ใช้; note บังคับ (เหตุผล) |

`from_account_name` / `to_account_name` / `category_name` ว่างเมื่อ ID ที่คู่กันว่าง

ผลทางบัญชีของแต่ละประเภทเป็นไปตาม AGENTS.md §7.3

### 3.4 ตัวช่วยกรอก (2026-11-25)

- คำนวณจากประวัติ Transactions จริงทุกครั้ง **ไม่เก็บข้อมูลเพิ่มและไม่เปลี่ยน schema**
- จัดกลุ่มด้วย ประเภท + ชื่อรายการ (normalize) + บัญชีต้นทาง/ปลายทาง + หมวด + เจ้าของ; ใช้ยอดและวันที่ของรายการล่าสุดในกลุ่ม
- ตัดออก: รายการกลับรายการและที่ถูกกลับแล้ว, ADJUSTMENT, กลุ่มที่อ้างอิง Master ที่ปิดใช้งาน, รายการนอกช่วง lookback (ค่าเริ่มต้น 180 วัน) หรือหลังวันนี้
- **รายการล่าสุด**: เรียงตามวันที่/เวลาบันทึกล่าสุด; **ใช้ประจำ**: กลุ่มที่เกิดใน ≥ 2 เดือน หรือ ≥ 3 ครั้ง เรียงตามจำนวนเดือน → จำนวนครั้ง
- การแตะแม่แบบเพียงเติมฟอร์ม (วันที่คงเป็นวันนี้) ผู้ใช้ต้องตรวจและกดบันทึกเอง; การบันทึกผ่านกฎ §3.1–3.2 และการเตือนรายการซ้ำตามปกติ
- ไม่ใช่การตั้งรายจ่ายประจำอัตโนมัติ: รายจ่ายประจำที่มีกำหนดเวลาใช้ Payment Planner แบบ RECURRING (Phase 4); การปักหมุดแม่แบบเองต้องมีที่เก็บใหม่ (ต้องขออนุมัติ schema)

### 3.3 เงินกู้และการยืมเงินบุคคล (ตัดสินใจ 2026-11-25)

ใช้บัญชีประเภท `LOAN` หนึ่งบัญชีต่อเจ้าหนี้หนึ่งราย (เช่น "ยืมเงิน คุณสมชาย", institution = ชื่อผู้ให้ยืม); ไม่เพิ่มคอลัมน์หรือ enum ใหม่

| เหตุการณ์ | บันทึกเป็น | from → to | ผล |
|---|---|---|---|
| หนี้คงค้าง ณ วันเริ่มใช้ระบบ | `Accounts.opening_balance` ของบัญชี LOAN | — | ยอดหนี้ตั้งต้น |
| รับเงินกู้/ยืมเงินเพิ่ม | `CASH_ADVANCE` (หน้าจอแสดง "รับเงินกู้/เบิกเงินสด") | LOAN → บัญชีสินทรัพย์ที่รับเงิน | หนี้เพิ่ม + เงินเพิ่ม; **ไม่ใช่รายรับ** |
| คืนเงินต้น | `CREDIT_PAYMENT` (หน้าจอแสดง "ชำระหนี้/บัตร") | บัญชีสินทรัพย์ → LOAN | หนี้ลด + เงินลด; **ไม่ใช่รายจ่าย** |
| ดอกเบี้ยที่จ่ายจริง | `INTEREST` แยกรายการ | บัญชีสินทรัพย์ (จ่ายทันที) หรือ LOAN (ทบเข้าหนี้) | รับรู้รายจ่าย |
| ซื้อของโดยตรงด้วยสินเชื่อ (เช่น สินเชื่อผ่อนสินค้า) | `CREDIT_PURCHASE` | LOAN → — | หนี้เพิ่ม + รับรู้รายจ่าย |

- ยอดชำระหนึ่งครั้งที่มีทั้งเงินต้นและดอกเบี้ย ให้แยกเป็น CREDIT_PAYMENT (เงินต้น) + INTEREST (ดอกเบี้ย) เพื่อไม่นับเงินต้นเป็นรายจ่าย
- แผนคืนเงินกู้ใน Payment Planner ใช้ `account_id` = บัญชี LOAN และหมวดหมู่ประเภท EXPENSE ที่ตั้งชื่อชัดเจน เช่น "ชำระหนี้"; หมวดนี้เป็นป้ายสำหรับรายงานแผนเท่านั้น การจ่ายจริงยังเป็น CREDIT_PAYMENT/INTEREST จึงไม่สร้างรายจ่ายซ้ำ — รายงานรายรับรายจ่ายจริงอ่านจาก Transactions ไม่ใช่ยอดแผน
- ยอดหนี้คงเหลือของบัญชี LOAN = opening_balance + CASH_ADVANCE + CREDIT_PURCHASE + INTEREST/FEE ที่ทบเข้าหนี้ − CREDIT_PAYMENT (คำนวณจาก Transactions ไม่ใช่จากแผน)
- **ไม่อยู่ในขอบเขต:** การให้ผู้อื่นยืมเงิน (ลูกหนี้/สินทรัพย์) ต้องเพิ่มประเภทบัญชีใหม่และขออนุมัติ schema ก่อน

## 4. Payment Planner

### 4.1 การสร้างแผน

- ผู้ใช้กรอกครั้งเดียวที่ PaymentPlans: purchase_date, item_name, description, owner_id, category_id, account_id, principal/interest/fee, installment_count, first_saving_month, first_payment_month, due_day (ถ้าทราบ), note
- Backend เติม account_name, owner_name, category_name จาก Master และคำนวณ total_amount
- Backend สร้าง PaymentSchedules หนึ่งแถวต่อหนึ่งงวดด้วย Batch Write โดย **คัดลอกทุกงวด**: purchase_date, plan_type, account_id, account_name, owner_id, owner_name, category_id, category_name, item_name, description, installment_count
- ONE_TIME: installment_count = 1, installment_no = 1
- แสดงตัวอย่างงวดก่อนยืนยันเสมอ

### 4.2 งวดและเดือน

- installment_no และ installment_count แยกคอลัมน์ เป็น Integer; ห้ามเก็บรูปแบบ `1/6` (UI แสดงได้)
- saving_month, payment_month เป็น Integer YYYYMM; งวดที่ n = first_*_month + (n−1) เดือนด้วย calendar arithmetic (202612 → 202701); ปฏิเสธค่าเช่น 202613, 202600, 20261
- due_date = payment_month + due_day; ถ้า due_day เกินวันสุดท้ายของเดือนใช้วันสุดท้าย; ไม่ทราบ due_day ให้ว่าง
- amount_due = total_amount ÷ installment_count ปัดเป็นสตางค์ เศษปรับที่งวดสุดท้าย; แก้รายงวดได้แต่ผลรวมงวดที่ไม่ยกเลิกต้องเท่ากับ total_amount
- หนึ่งงวด = หนึ่งแถว

### 4.3 การแก้ไขแผน

| ฟิลด์ที่แก้ที่แผน | ผลต่อ PaymentSchedules |
|---|---|
| item_name, description, owner_id, category_id | Propagate ไปทุกงวด (รวมงวดที่ชำระแล้ว เพราะเป็นข้อมูลอธิบาย ไม่มีผลทางการเงิน) และ refresh ชื่อ |
| account_id | อนุญาตเฉพาะเมื่อแผนยังไม่มี Reservations และ PaymentAllocations; มิฉะนั้นต้องยกเลิกแผนและสร้างใหม่ |
| ยอดเงิน, installment_count, เดือนเริ่ม, due_day | สร้างงวดใหม่ได้เฉพาะงวดที่ยังไม่มีการกันเงินหรือชำระ; ห้ามแก้งวดที่ชำระแล้วอัตโนมัติ |
| note ของแผน | ไม่กระทบ note ของงวด |

- Transactions ที่เชื่อมกับแผน (plan_id) ไม่ถูกแก้ item_name/category อัตโนมัติ เพราะเป็นบันทึกธุรกรรมจริง
- ห้ามแก้คอลัมน์ PROJ ของ PaymentSchedules โดยตรง (ทั้งผ่าน API และในชีต)

### 4.4 สถานะและยอด (Derived)

ตาม AGENTS.md §6.3 และ §7.3:

- amount_saved = SUM(RESERVE) − SUM(RELEASE)
- amount_reserved = amount_saved − SUM(CONSUME)
- amount_paid = ผลรวม allocated_amount ของธุรกรรมที่มีผล (ไม่ถูกกลับรายการ)
- remaining_to_pay = MAX(0, amount_due − amount_paid)
- remaining_to_save = MAX(0, remaining_to_pay − amount_reserved)
- saving_status: CANCELLED ถ้า is_cancelled; NOT_REQUIRED ถ้า remaining_to_pay = 0; SAVED ถ้า remaining_to_save = 0; PARTIAL ถ้า amount_reserved > 0; มิฉะนั้น NOT_SAVED
- payment_status: CANCELLED ถ้า is_cancelled; PAID ถ้า remaining_to_pay = 0; PARTIAL ถ้า amount_paid > 0; มิฉะนั้น UNPAID
- is_overdue = ไม่ยกเลิก AND remaining_to_pay > 0 AND due_date < วันนี้ (Asia/Bangkok)
- remaining_installments = จำนวนงวดในแผนเดียวกันที่ไม่ยกเลิกและ remaining_to_pay > 0 (ค่าเดียวกันทุกงวดของแผน; ห้าม SUM)
- plan_status: CANCELLED เมื่อแผนถูกยกเลิก; COMPLETED เมื่อทุกงวดที่ไม่ยกเลิก PAID; มิฉะนั้น ACTIVE

### 4.5 Reservations และ Allocations

- RESERVE ไม่เกินเงินที่ใช้ได้ของบัญชี; RELEASE/CONSUME ไม่เกินยอดที่กันไว้ในบัญชีนั้นของงวดนั้น; CONSUME ต้องมี transaction_id
- ผลรวม allocation ต่อธุรกรรม ≤ amount ของธุรกรรม; ต่องวด ≤ amount_due; ยอดที่ยังไม่จัดสรรแสดงแยก
- การกันเงินไม่ใช่รายจ่าย; การชำระจริงสร้าง Transactions + PaymentAllocations + CONSUME เฉพาะเงินกันไว้ที่ใช้จริง

## 5. Pivot

- Pivot แยกได้ตาม account_name, owner_name, category_name, item_name, saving_month, payment_month โดยตรงจาก PaymentSchedules
- กรองงวดที่ `is_cancelled = TRUE` ออกจากรายงานแผน
- รายงานประวัติจริงใช้วันที่จริง (transaction_date, reservation_date) ไม่ใช้เดือนแผน
- ห้าม SUM installment_count, remaining_installments, total_amount ข้ามงวด
- Pivot ไม่อยู่ในเส้นทางบันทึกหลัก

# Database Schema — Expense Manager V2

สถานะ: **อนุมัติแล้ว (2026-11-25)** — ยังไม่สร้างหรือแก้ Google Sheets จริง; การเปลี่ยนแปลง schema หลังจากนี้ต้องขออนุมัติใหม่
ปรับปรุงล่าสุด: 2026-11-25
เอกสารที่เกี่ยวข้อง: [business-rules.md](business-rules.md), [system-architecture.md](system-architecture.md), [development-plan.md](development-plan.md), [test-plan.md](test-plan.md), [../AGENTS.md](../AGENTS.md) §7

> เอกสารนี้เป็น Canonical Schema ของ V2 หาก AGENTS.md §7.1 กับเอกสารนี้ไม่ตรงกัน ให้ถือว่าเป็นข้อบกพร่องของเอกสารและต้องแก้ให้ตรงกันก่อน Implementation

## 1. หลักการ

1. **ID เป็นรหัสอ้างอิงหลัก** ระหว่างตารางเสมอ (UUID แบบข้อความ) ห้ามใช้ชื่อหรือเลขแถวเป็น FK
2. **Name ใช้แสดงผล ค้นหา กรอง และ Pivot** — คอลัมน์ `*_name` ที่อยู่คู่กับ `*_id` ในตารางธุรกรรม/แผน/งวด เป็น **Projection** ที่ Backend เติมจาก Master Data อัตโนมัติ ผู้ใช้ไม่ต้องกรอกและ API ไม่รับค่าเหล่านี้จาก Client
3. Master Data (Accounts, Owners, Categories) เป็น Source of Truth ของชื่อ เมื่อเปลี่ยนชื่อ Backend refresh Projection ทุกตารางโดยไม่เปลี่ยน ID
4. หนึ่งแถวต่อหนึ่ง record, หนึ่งคอลัมน์ต่อหนึ่ง attribute, header เป็น snake_case ไม่ซ้ำ, ห้าม merge cell หรือแถวรวมยอด
5. Pivot Table เป็นรายงาน ไม่ใช่ฐานข้อมูลต้นฉบับ

### 1.1 ประเภทคอลัมน์ (Kind)

| Kind | ความหมาย | ใครเขียน |
|---|---|---|
| KEY | Primary key (UUID) | Backend สร้างล่วงหน้า |
| FK | อ้างอิง ID ของตารางอื่น ต้องมีอยู่จริง | ผู้ใช้เลือกจากรายการ, Backend ตรวจสอบ |
| INPUT | ข้อมูลที่ผู้ใช้กรอกหรือแก้ไขได้ | ผู้ใช้ผ่าน API ที่ตรวจสอบแล้ว |
| PROJ | Projection: สำเนาข้อมูลจาก Master หรือจาก PaymentPlans เพื่อรายงาน | Backend เท่านั้น ห้ามแก้ตรง |
| GEN | ค่าที่ Backend สร้างตอนสร้างแผน/งวด (แก้ผ่าน API เฉพาะที่ระบุ) | Backend |
| DER | ค่าคำนวณจากเหตุการณ์จริง คำนวณใหม่ได้ทุกเมื่อ | Backend เท่านั้น |
| SYS | timestamp / ข้อมูลระบบ | Backend เท่านั้น |

### 1.2 Data types

| Type | รูปแบบ | ตัวอย่าง |
|---|---|---|
| ID | ข้อความ UUID v4 | `3f2a…` |
| Text(n) | ข้อความ ความยาวไม่เกิน n ตัวอักษร ตัดช่องว่างหัวท้าย ป้องกัน Formula Injection | `iPhone 17` |
| Date | ข้อความ `YYYY-MM-DD` (ค.ศ.) ไม่ทราบให้ว่าง | `2026-11-25` |
| Timestamp | ISO 8601 พร้อม timezone | `2026-11-25T22:30:00+07:00` |
| YearMonth | Integer 6 หลัก `YYYYMM` เดือน 01–12 | `202611` |
| Int | Integer | `6` |
| Day | Integer 1–31 หรือว่าง | `25` |
| Money | Number หน่วยบาท 2 ตำแหน่ง (คำนวณภายในเป็น integer satang) | `100.00` |
| Bool | `TRUE` / `FALSE` | `FALSE` |
| Enum | ข้อความตามค่าที่กำหนด | `INSTALLMENT` |

### 1.3 Business Information Columns มาตรฐาน

ใช้ชุดเดียวกันใน PaymentPlans และ PaymentSchedules; Transactions ใช้ชุดเดียวกันแต่แยกบัญชีต้นทาง/ปลายทาง

| Column | Type | Kind | ความหมาย |
|---|---|---|---|
| account_id | ID | FK → Accounts | รหัสบัญชีหรือบัตร |
| account_name | Text(100) | PROJ ← Accounts.account_name | บัตร / ช่องทางทำรายการ |
| owner_id | ID | FK → Owners | รหัสเจ้าของรายการ |
| owner_name | Text(100) | PROJ ← Owners.owner_name | เจ้าของรายการ |
| category_id | ID | FK → Categories | รหัสหมวดหมู่ |
| category_name | Text(100) | PROJ ← Categories.category_name | ชื่อหมวดหมู่ |
| item_name | Text(200) | INPUT (Plans/Transactions), PROJ (Schedules) | ชื่อรายการ |
| description | Text(1000) | INPUT (Plans/Transactions), PROJ (Schedules) | รายละเอียดของรายการหลัก |
| note | Text(1000) | INPUT ในทุกตาราง (แยกอิสระต่อแถว) | หมายเหตุเพิ่มเติม ห้ามใช้แทนสถานะ |

Transactions: `from_account_id`/`from_account_name` และ `to_account_id`/`to_account_name` แทน `account_id`/`account_name`

ลำดับคอลัมน์มาตรฐาน: `*_id` ตามด้วย `*_name` เสมอ, `note` อยู่ท้ายคอลัมน์ธุรกิจก่อน `created_at`, `updated_at`

## 2. รายการตาราง

| Sheet | Grain | หมายเหตุ |
|---|---|---|
| Accounts | หนึ่งบัญชีหรือบัตร | Master |
| Owners | หนึ่งเจ้าของ | Master |
| Categories | หนึ่งหมวดหมู่ | Master |
| Transactions | หนึ่งธุรกรรมจริง | Fact |
| PaymentPlans | หนึ่งแผน | Plan header |
| PaymentSchedules | หนึ่งงวด | Pivot-ready |
| Reservations | หนึ่งเหตุการณ์กัน/ปลด/ใช้เงิน | Event (append-only) |
| PaymentAllocations | หนึ่งการจัดสรรธุรกรรมให้หนึ่งงวด | Bridge |
| Settings | หนึ่งค่าตั้งค่า | Config |
| AuditLogs | หนึ่งเหตุการณ์ตรวจสอบ | Append-only |
| OperationJournal | หนึ่งคำขอเขียนข้อมูล | Idempotency / Recovery |
| Budgets | — | ระยะถัดไป (ยังไม่กำหนด schema) |
| Pivot_Saving / Pivot_Payment / Pivot_Transactions | — | รายงาน ไม่ใช่ข้อมูลต้นฉบับ |

## 3. Canonical headers

```text
Accounts: account_id, account_name, account_type, account_subtype, owner_id, institution, opening_balance, opening_date, credit_limit, statement_day, due_day, is_active, note, created_at, updated_at
Owners: owner_id, owner_name, is_active, created_at, updated_at
Categories: category_id, category_name, category_type, icon, color, is_active, created_at, updated_at
Transactions: transaction_id, transaction_date, transaction_type, from_account_id, from_account_name, to_account_id, to_account_name, owner_id, owner_name, category_id, category_name, item_name, description, amount, plan_id, external_ref, source, reversal_of, note, created_at, updated_at
PaymentPlans: plan_id, purchase_date, plan_type, account_id, account_name, owner_id, owner_name, category_id, category_name, item_name, description, principal_amount, interest_amount, fee_amount, total_amount, installment_count, first_saving_month, first_payment_month, due_day, external_ref, plan_status, note, created_at, updated_at
PaymentSchedules: schedule_id, plan_id, purchase_date, plan_type, account_id, account_name, owner_id, owner_name, category_id, category_name, item_name, description, installment_no, installment_count, saving_month, payment_month, due_date, amount_due, amount_saved, amount_reserved, amount_paid, remaining_to_save, remaining_to_pay, saving_status, payment_status, is_overdue, is_cancelled, is_month_different, saving_year, saving_month_no, payment_year, payment_month_no, remaining_installments, saving_completed_date, paid_date, note, created_at, updated_at
Reservations: reservation_id, reservation_date, schedule_id, account_id, action_type, amount, transaction_id, note, created_at
PaymentAllocations: allocation_id, transaction_id, schedule_id, allocated_amount, created_at
Settings: setting_key, setting_value, description, updated_at
AuditLogs: audit_id, event_at, actor_id, action, entity_type, entity_id, operation_id, result
OperationJournal: operation_id, idempotency_key, request_hash, actor_id, operation_type, status, recovery_data, result_ref, created_at, updated_at
```

จำนวนคอลัมน์: Accounts 15, Owners 5, Categories 8, Transactions 21, PaymentPlans 24, PaymentSchedules 38, Reservations 9, PaymentAllocations 5, Settings 4, AuditLogs 8, OperationJournal 10

## 4. รายละเอียดตาราง

ตัวย่อ Req: Y = บังคับ, N = ไม่บังคับ, C = บังคับตามเงื่อนไข

### 4.1 Accounts

| # | Column | Type | Req | Kind | คำอธิบาย |
|---:|---|---|---|---|---|
| 1 | account_id | ID | Y | KEY | |
| 2 | account_name | Text(100) | Y | INPUT | ชื่อบัญชี/บัตร ไม่ซ้ำกันในบัญชีที่ active (case-insensitive) |
| 3 | account_type | Enum | Y | INPUT | CASH, BANK, E_WALLET, CREDIT_CARD, CASH_CARD, LOAN |
| 4 | account_subtype | Enum | N | INPUT | เช่น SAVINGS (ใช้กับ BANK) |
| 5 | owner_id | ID | N | FK → Owners | เจ้าของบัญชี |
| 6 | institution | Text(100) | N | INPUT | ชื่อธนาคาร/ผู้ให้บริการ |
| 7 | opening_balance | Money | Y | INPUT | ยอดยกมา ≥ 0 ตามประเภท (สินทรัพย์/หนี้) |
| 8 | opening_date | Date | N | INPUT | |
| 9 | credit_limit | Money | N | INPUT | ห้ามนับเป็นเงินที่ใช้ได้ |
| 10 | statement_day | Day | N | INPUT | วันตัดรอบ |
| 11 | due_day | Day | N | INPUT | วันครบกำหนดชำระ |
| 12 | is_active | Bool | Y | INPUT | soft delete |
| 13 | note | Text(1000) | N | INPUT | ห้ามเก็บเลขบัตรเต็ม, PIN, CVV, รหัสผ่าน |
| 14 | created_at | Timestamp | Y | SYS | |
| 15 | updated_at | Timestamp | Y | SYS | |

### 4.2 Owners

| # | Column | Type | Req | Kind | คำอธิบาย |
|---:|---|---|---|---|---|
| 1 | owner_id | ID | Y | KEY | |
| 2 | owner_name | Text(100) | Y | INPUT | ไม่ซ้ำในรายการที่ active |
| 3 | is_active | Bool | Y | INPUT | |
| 4 | created_at | Timestamp | Y | SYS | |
| 5 | updated_at | Timestamp | Y | SYS | |

### 4.3 Categories

| # | Column | Type | Req | Kind | คำอธิบาย |
|---:|---|---|---|---|---|
| 1 | category_id | ID | Y | KEY | |
| 2 | category_name | Text(100) | Y | INPUT | ไม่ซ้ำภายใน category_type เดียวกันที่ active |
| 3 | category_type | Enum | Y | INPUT | INCOME, EXPENSE |
| 4 | icon | Text(50) | N | INPUT | |
| 5 | color | Text(20) | N | INPUT | เช่น `#4F46E5` |
| 6 | is_active | Bool | Y | INPUT | |
| 7 | created_at | Timestamp | Y | SYS | |
| 8 | updated_at | Timestamp | Y | SYS | |

### 4.4 Transactions

| # | Column | Type | Req | Kind | คำอธิบาย |
|---:|---|---|---|---|---|
| 1 | transaction_id | ID | Y | KEY | |
| 2 | transaction_date | Date | Y | INPUT | วันที่ทำรายการจริง |
| 3 | transaction_type | Enum | Y | INPUT | INCOME, EXPENSE, TRANSFER, CREDIT_PURCHASE, CREDIT_PAYMENT, CASH_ADVANCE, INTEREST, FEE, REFUND, ADJUSTMENT |
| 4 | from_account_id | ID | C | FK → Accounts | บัญชีต้นทาง ตามตาราง business-rules §3.2 |
| 5 | from_account_name | Text(100) | C | PROJ | ว่างเมื่อ from_account_id ว่าง |
| 6 | to_account_id | ID | C | FK → Accounts | บัญชีปลายทาง ตาม business-rules §3.2 |
| 7 | to_account_name | Text(100) | C | PROJ | ว่างเมื่อ to_account_id ว่าง |
| 8 | owner_id | ID | Y | FK → Owners | |
| 9 | owner_name | Text(100) | Y | PROJ | |
| 10 | category_id | ID | C | FK → Categories | บังคับสำหรับประเภทที่รับรู้รายรับ/รายจ่าย |
| 11 | category_name | Text(100) | C | PROJ | ว่างเมื่อ category_id ว่าง |
| 12 | item_name | Text(200) | Y | INPUT | ชื่อรายการ |
| 13 | description | Text(1000) | N | INPUT | รายละเอียดรายการ |
| 14 | amount | Money | Y | INPUT | > 0 เสมอ ทิศทางกำหนดจากประเภท |
| 15 | plan_id | ID | N | FK → PaymentPlans | เชื่อมแผนผ่อน (CREDIT_PURCHASE ได้เพียงรายการเดียวต่อแผน) |
| 16 | external_ref | Text(100) | N | INPUT | เลขอ้างอิงภายนอก ไม่ใช่ PK |
| 17 | source | Enum | Y | SYS | MANUAL, QUICK_ENTRY, PLAN, MIGRATION, AI |
| 18 | reversal_of | ID | N | FK → Transactions | รายการที่ถูกกลับรายการ |
| 19 | note | Text(1000) | N | INPUT | หมายเหตุเพิ่มเติม |
| 20 | created_at | Timestamp | Y | SYS | |
| 21 | updated_at | Timestamp | Y | SYS | |

### 4.5 PaymentPlans

| # | Column | Type | Req | Kind | คำอธิบาย |
|---:|---|---|---|---|---|
| 1 | plan_id | ID | Y | KEY | |
| 2 | purchase_date | Date | N | INPUT | วันที่ทำรายการ/ซื้อ (ไม่ทราบให้ว่าง) |
| 3 | plan_type | Enum | Y | INPUT | INSTALLMENT, ONE_TIME, RECURRING |
| 4 | account_id | ID | Y | FK → Accounts | บัญชี/บัตรที่ใช้ชำระ |
| 5 | account_name | Text(100) | Y | PROJ | บัตร / ช่องทางทำรายการ |
| 6 | owner_id | ID | Y | FK → Owners | |
| 7 | owner_name | Text(100) | Y | PROJ | |
| 8 | category_id | ID | Y | FK → Categories | category_type ต้องเป็น EXPENSE |
| 9 | category_name | Text(100) | Y | PROJ | |
| 10 | item_name | Text(200) | Y | INPUT | ต้นฉบับของชื่อรายการ |
| 11 | description | Text(1000) | N | INPUT | ต้นฉบับของรายละเอียดรายการ |
| 12 | principal_amount | Money | Y | INPUT | ≥ 0 |
| 13 | interest_amount | Money | Y | INPUT | ≥ 0 (ค่าเริ่มต้น 0) |
| 14 | fee_amount | Money | Y | INPUT | ≥ 0 (ค่าเริ่มต้น 0) |
| 15 | total_amount | Money | Y | DER | principal + interest + fee; > 0 |
| 16 | installment_count | Int | Y | INPUT | ≥ 1; ONE_TIME = 1 |
| 17 | first_saving_month | YearMonth | Y | INPUT | |
| 18 | first_payment_month | YearMonth | Y | INPUT | |
| 19 | due_day | Day | N | INPUT | วันครบกำหนดของทุกงวด (ถ้าทราบ) |
| 20 | external_ref | Text(100) | N | INPUT | |
| 21 | plan_status | Enum | Y | DER | ACTIVE, COMPLETED, CANCELLED |
| 22 | note | Text(1000) | N | INPUT | หมายเหตุระดับแผน (ไม่คัดลอกไปงวด) |
| 23 | created_at | Timestamp | Y | SYS | |
| 24 | updated_at | Timestamp | Y | SYS | |

### 4.6 PaymentSchedules

| # | Column | Type | Req | Kind | คำอธิบาย |
|---:|---|---|---|---|---|
| 1 | schedule_id | ID | Y | KEY | |
| 2 | plan_id | ID | Y | FK → PaymentPlans | |
| 3 | purchase_date | Date | N | PROJ ← Plan | |
| 4 | plan_type | Enum | Y | PROJ ← Plan | |
| 5 | account_id | ID | Y | PROJ ← Plan | FK → Accounts |
| 6 | account_name | Text(100) | Y | PROJ ← Accounts | |
| 7 | owner_id | ID | Y | PROJ ← Plan | FK → Owners |
| 8 | owner_name | Text(100) | Y | PROJ ← Owners | |
| 9 | category_id | ID | Y | PROJ ← Plan | FK → Categories |
| 10 | category_name | Text(100) | Y | PROJ ← Categories | |
| 11 | item_name | Text(200) | Y | PROJ ← Plan | |
| 12 | description | Text(1000) | N | PROJ ← Plan | |
| 13 | installment_no | Int | Y | GEN | 1..installment_count |
| 14 | installment_count | Int | Y | PROJ ← Plan | ห้าม SUM ข้ามงวด |
| 15 | saving_month | YearMonth | Y | GEN | เดือนเก็บเงิน |
| 16 | payment_month | YearMonth | Y | GEN | เดือนชำระ |
| 17 | due_date | Date | N | GEN | ว่างถ้าไม่ทราบ due_day |
| 18 | amount_due | Money | Y | GEN (แก้รายงวดได้) | ยอดตามแผน ผลรวมทุกงวดที่ไม่ยกเลิก = total_amount |
| 19 | amount_saved | Money | Y | DER | SUM(RESERVE) − SUM(RELEASE) |
| 20 | amount_reserved | Money | Y | DER | amount_saved − SUM(CONSUME) |
| 21 | amount_paid | Money | Y | DER | ยอดจัดสรรสุทธิของธุรกรรมที่มีผล |
| 22 | remaining_to_save | Money | Y | DER | MAX(0, remaining_to_pay − amount_reserved) |
| 23 | remaining_to_pay | Money | Y | DER | MAX(0, amount_due − amount_paid) |
| 24 | saving_status | Enum | Y | DER | NOT_SAVED, PARTIAL, SAVED, NOT_REQUIRED, CANCELLED |
| 25 | payment_status | Enum | Y | DER | UNPAID, PARTIAL, PAID, CANCELLED |
| 26 | is_overdue | Bool | Y | DER | ยังค้างและเลย due_date |
| 27 | is_cancelled | Bool | Y | GEN | ข้อเท็จจริงการยกเลิกที่ได้รับอนุมัติ (สถานะ CANCELLED derived จากคอลัมน์นี้) |
| 28 | is_month_different | Bool | Y | DER | saving_month ≠ payment_month |
| 29 | saving_year | Int | Y | DER | INT(saving_month/100) |
| 30 | saving_month_no | Int | Y | DER | MOD(saving_month,100) |
| 31 | payment_year | Int | Y | DER | INT(payment_month/100) |
| 32 | payment_month_no | Int | Y | DER | MOD(payment_month,100) |
| 33 | remaining_installments | Int | Y | DER | จำนวนงวดของแผนที่ยังค้างและไม่ยกเลิก ห้าม SUM |
| 34 | saving_completed_date | Date | N | DER | จากเหตุการณ์จริง |
| 35 | paid_date | Date | N | DER | จากเหตุการณ์จริง |
| 36 | note | Text(1000) | N | INPUT | หมายเหตุรายงวด แก้แยกแต่ละงวดได้ เริ่มต้นว่าง |
| 37 | created_at | Timestamp | Y | SYS | |
| 38 | updated_at | Timestamp | Y | SYS | |

### 4.7 Reservations

| # | Column | Type | Req | Kind | คำอธิบาย |
|---:|---|---|---|---|---|
| 1 | reservation_id | ID | Y | KEY | |
| 2 | reservation_date | Date | Y | INPUT | วันที่กัน/ปลด/ใช้เงินจริง |
| 3 | schedule_id | ID | Y | FK → PaymentSchedules | |
| 4 | account_id | ID | Y | FK → Accounts | บัญชีที่กันเงิน (อาจต่างจากบัญชีของแผน) |
| 5 | action_type | Enum | Y | INPUT | RESERVE, RELEASE, CONSUME |
| 6 | amount | Money | Y | INPUT | > 0 |
| 7 | transaction_id | ID | C | FK → Transactions | บังคับเมื่อ CONSUME |
| 8 | note | Text(1000) | N | INPUT | |
| 9 | created_at | Timestamp | Y | SYS | |

ไม่เพิ่ม account_name ใน Reservations: เป็นตาราง event แบบ append-only; รายงานกันเงินใช้ derived report view ที่ join ชื่อจาก Accounts (ดู §6)

### 4.8 PaymentAllocations

| # | Column | Type | Req | Kind | คำอธิบาย |
|---:|---|---|---|---|---|
| 1 | allocation_id | ID | Y | KEY | |
| 2 | transaction_id | ID | Y | FK → Transactions | |
| 3 | schedule_id | ID | Y | FK → PaymentSchedules | |
| 4 | allocated_amount | Money | Y | INPUT | > 0 |
| 5 | created_at | Timestamp | Y | SYS | |

### 4.9 Settings / AuditLogs / OperationJournal

| Sheet | Column | Type | Kind | คำอธิบาย |
|---|---|---|---|---|
| Settings | setting_key | Text(100) | KEY | |
| Settings | setting_value | Text | INPUT | |
| Settings | description | Text(500) | INPUT | |
| Settings | updated_at | Timestamp | SYS | |
| AuditLogs | audit_id | ID | KEY | |
| AuditLogs | event_at | Timestamp | SYS | |
| AuditLogs | actor_id | Text | SYS | ผู้ใช้ Google ที่ทำรายการ (เก็บแบบไม่เปิดเผยเกินจำเป็น) |
| AuditLogs | action | Enum | SYS | CREATE, UPDATE, REVERSE, CANCEL, RENAME_MASTER, REFRESH_PROJECTION, MIGRATE ฯลฯ |
| AuditLogs | entity_type | Text | SYS | ชื่อตาราง |
| AuditLogs | entity_id | ID | SYS | |
| AuditLogs | operation_id | ID | SYS | FK → OperationJournal |
| AuditLogs | result | Enum | SYS | SUCCESS, FAILED |
| OperationJournal | operation_id | ID | KEY | |
| OperationJournal | idempotency_key | Text | SYS | ไม่ซ้ำต่อ actor |
| OperationJournal | request_hash | Text | SYS | |
| OperationJournal | actor_id | Text | SYS | |
| OperationJournal | operation_type | Enum | SYS | |
| OperationJournal | status | Enum | SYS | PENDING, COMMITTED, FAILED, NEEDS_RECOVERY |
| OperationJournal | recovery_data | Text(JSON) | SYS | ห้ามส่งให้ Client |
| OperationJournal | result_ref | Text | SYS | |
| OperationJournal | created_at | Timestamp | SYS | |
| OperationJournal | updated_at | Timestamp | SYS | |

## 5. Projection map

| ตารางปลายทาง | คอลัมน์ | แหล่งข้อมูล | Refresh เมื่อ |
|---|---|---|---|
| Transactions | from_account_name | Accounts.account_name ผ่าน from_account_id | สร้าง/แก้ธุรกรรม, เปลี่ยนชื่อบัญชี |
| Transactions | to_account_name | Accounts.account_name ผ่าน to_account_id | สร้าง/แก้ธุรกรรม, เปลี่ยนชื่อบัญชี |
| Transactions | owner_name | Owners.owner_name | สร้าง/แก้ธุรกรรม, เปลี่ยนชื่อเจ้าของ |
| Transactions | category_name | Categories.category_name | สร้าง/แก้ธุรกรรม, เปลี่ยนชื่อหมวดหมู่ |
| PaymentPlans | account_name, owner_name, category_name | Master ตาม ID | สร้าง/แก้แผน, เปลี่ยนชื่อ Master |
| PaymentSchedules | purchase_date, plan_type, account_id, owner_id, category_id, item_name, description, installment_count | PaymentPlans ตาม plan_id | สร้างงวด, แก้แผน |
| PaymentSchedules | account_name, owner_name, category_name | Master ตาม ID | สร้าง/แก้แผน, เปลี่ยนชื่อ Master |

ไม่ใช่ Projection: `note` ทุกตาราง (แต่ละแถวมีหมายเหตุของตัวเอง), `PaymentPlans.note` ไม่คัดลอกไป `PaymentSchedules.note`

## 6. Pivot-ready dimensions

PaymentSchedules มีคอลัมน์ครบสำหรับ Pivot โดยไม่ต้อง join:

| Dimension | Column |
|---|---|
| บัญชี/บัตร | account_name |
| เจ้าของรายการ | owner_name |
| หมวดหมู่ | category_name |
| ชื่อรายการ | item_name |
| ปีเดือนเก็บเงิน | saving_month (หรือ saving_year + saving_month_no) |
| ปีเดือนชำระ | payment_month (หรือ payment_year + payment_month_no) |
| ประเภทแผน | plan_type |

Transactions มี from_account_name, to_account_name, owner_name, category_name สำหรับ Pivot รายรับรายจ่าย; ยอดแบบมีเครื่องหมาย (signed amount) และ YYYYMM จาก transaction_date ให้สร้างใน derived report view ไม่เขียนกลับตารางต้นฉบับ

Reservations และ PaymentAllocations ใช้ derived report view (เช่น `Pivot_Saving`, `Pivot_Payment`) ที่ join ชื่อจาก Master/Schedules

## 7. การเปลี่ยนแปลงเทียบกับร่าง V2 เดิม (AGENTS.md ก่อน 2026-11-25)

| ตาราง | เพิ่ม | ย้ายตำแหน่ง | ยกเลิก |
|---|---|---|---|
| Transactions | from_account_name, to_account_name, owner_name, category_name, note | — | — |
| PaymentPlans | account_name, owner_name, category_name, note | — | — |
| PaymentSchedules | description | plan_type ย้ายไปต่อจาก purchase_date (จัดกลุ่มข้อมูลแผน) | — |
| ตารางอื่น | — | — | — |

ไม่มีการยกเลิกคอลัมน์; ไม่มีการเปลี่ยนชื่อคอลัมน์; V2 ยังไม่มีข้อมูลจริง การจัดลำดับใหม่จึงไม่กระทบข้อมูล

## 8. ข้อจำกัดของเอกสารนี้

- ไม่มีข้อมูลระบบเดิม (ยืนยัน 2026-11-25) — V2 เริ่มจาก Spreadsheet ว่าง; [migration-plan.md](migration-plan.md) เก็บไว้เป็นแนวทางนำเข้าข้อมูลในอนาคต
- ความยาวสูงสุดของ Text เป็นค่าที่เสนอ ปรับได้ก่อน Implementation
- Budgets ยังไม่กำหนด schema

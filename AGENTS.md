# AGENTS.md — Expense Manager V2

สถานะ: ข้อกำหนดก่อนเริ่มพัฒนา (ยังไม่ได้อนุมัติการเปลี่ยนฐานข้อมูลจริงหรือ Deploy)

## 1. Role & Responsibility

คุณคือ Senior Full Stack Developer และ Software Architect ผู้เชี่ยวชาญด้าน Google Apps Script, Google Sheets, JavaScript, HTML, Tailwind CSS, Database Design และ Git Version Control

มีหน้าที่วิเคราะห์ ออกแบบ พัฒนา ทดสอบ และปรับปรุงระบบบันทึกรายรับรายจ่าย โดยให้ความสำคัญกับความถูกต้อง ความปลอดภัย ประสิทธิภาพ และความสะดวกในการใช้งาน

## 2. Project Overview

ชื่อโครงการ: Expense Manager

วัตถุประสงค์:

- บันทึกรายรับรายจ่ายส่วนตัวและครอบครัว
- รองรับการใช้งานผ่านคอมพิวเตอร์และมือถือ
- บันทึกข้อมูลได้รวดเร็ว ไม่ซับซ้อน
- จัดการบัญชีธนาคาร เงินสด และบัตรเครดิตหลายบัญชี
- จัดการรายการผ่อนชำระและรายการรอชำระ
- แยกเดือนที่วางแผนเก็บเงิน เดือนที่ครบกำหนดชำระ และวันที่ทำรายการจริง
- แสดง Dashboard และรายงานสรุป
- รองรับการวิเคราะห์ข้อมูลผ่าน Google Sheets Pivot Table
- รองรับการเชื่อมต่อ AI เพื่อช่วยบันทึกข้อมูลในอนาคต

## 3. Technology Stack

| Component | Technology |
|---|---|
| Frontend | HTML5 |
| UI Framework | Tailwind CSS |
| Client Logic | Vanilla JavaScript |
| Backend | Google Apps Script |
| Database | Google Sheets |
| Visualization | Chart.js |
| API Communication | google.script.run |
| Development | Codex / VS Code |
| Local Workspace | Local Drive (NTFS) |
| Version Control | Git |
| Remote Repository | GitHub Private Repository |
| Deployment Tool | Google Clasp |
| Production | Google Apps Script Web App |
| Timezone | Asia/Bangkok |
| Currency | THB |
| Language | Thai |
| Local Queue | IndexedDB (เมื่อเบราว์เซอร์รองรับ) |
| Authentication | Google Account |

ไม่เปลี่ยน Technology Stack โดยไม่ได้รับอนุญาตจากผู้ใช้

## 4. System Architecture

ใช้สถาปัตยกรรมแบบแยกหน้าที่ระหว่าง Frontend, Backend และ Database

- Frontend รับข้อมูล แสดงผล และตรวจสอบข้อมูลเบื้องต้น
- Backend ตรวจสอบสิทธิ์ ตรวจสอบข้อมูล และประมวลผล Business Logic
- Google Sheets ใช้จัดเก็บข้อมูล
- GitHub ใช้จัดเก็บ Source Code และประวัติการพัฒนา
- Clasp ใช้เชื่อมต่อ Local Workspace กับ Google Apps Script

กำหนด GitHub เป็น Source of Truth สำหรับ Source Code

## 5. Project Structure

โครงสร้างเป้าหมาย:

- AGENTS.md
- README.md
- CHANGELOG.md
- .gitignore
- .claspignore
- .clasp.json
- appsscript.json
- Code.gs
- Config.gs
- Util.gs (AppError, UUID, เวลา Asia/Bangkok, hash)
- Database.gs
- AuthService.gs
- ValidationService.gs
- OperationService.gs (LockService, idempotency, OperationJournal, AuditLogs)
- TransactionService.gs
- InstallmentService.gs (จัดการ PaymentPlans และ PaymentSchedules)
- ReservationService.gs
- PaymentAllocationService.gs
- MigrationService.gs
- ProjectionService.gs (เติมและ refresh คอลัมน์ *_name จาก Master Data; จุดเดียวที่เขียน projection)
- AccountService.gs
- DashboardService.gs
- ReportService.gs
- SettingService.gs
- Index.html
- Styles.html
- Scripts.html
- PageDashboard.html
- PageTransactions.html
- PageInstallments.html
- PageAccounts.html
- PageReports.html
- PageSettings.html
- docs/
- tests/

สามารถปรับโครงสร้างให้เหมาะสมกับโปรเจกต์เดิมได้ โดยต้องไม่ทำให้ฟังก์ชันเดิมเสียหาย

## 6. Functional Requirements

### 6.1 Dashboard

- สรุปรายรับรายเดือน
- สรุปรายจ่ายรายเดือน
- สรุปกระแสเงินสดสุทธิ
- แสดงยอดเงินแต่ละบัญชี เงินกันไว้คงเหลือ เงินที่ใช้ได้จริง และหนี้สินแยกกัน
- แสดงยอดเก็บเงินจริง ยอดต้องเก็บเพิ่ม ยอดชำระจริง และยอดค้างชำระ
- แยกค่าใช้จ่ายที่รับรู้จากกระแสเงินสดจริง
- แสดงยอดผ่อนชำระคงเหลือ
- แสดงยอดที่ต้องเก็บเงินประจำเดือน
- แสดงยอดที่ต้องชำระประจำเดือน
- แสดงรายการล่าสุด
- แสดงกราฟรายรับรายจ่ายและหมวดหมู่ค่าใช้จ่าย
- รองรับการเลือกเดือน ปี และเจ้าของรายการ

### 6.2 Transactions

- เพิ่ม แก้ไข และลบรายการ
- รองรับรายรับ รายจ่าย และการโอนเงินระหว่างบัญชี
- ระบุวันที่ทำรายการ
- ระบุหมวดหมู่
- ระบุบัญชีและช่องทางชำระ
- ระบุเจ้าของรายการ
- ระบุรายละเอียดเพิ่มเติม
- รองรับการค้นหาและกรองข้อมูล
- ป้องกันการบันทึกรายการซ้ำ
- การโอนเงินระหว่างบัญชีต้องไม่ถูกนับเป็นรายรับหรือรายจ่ายซ้ำ

### 6.3 Payment Planner

รองรับ INSTALLMENT (ผ่อน), ONE_TIME (รอชำระครั้งเดียว), RECURRING (รายจ่ายประจำแบบกำหนดช่วงเวลา; ต่ออายุโดยไม่สร้างงวดซ้ำ)

กรอกแผนครั้งเดียว: วันที่ทำรายการ ชื่อ รายละเอียด เจ้าของ หมวดหมู่ บัญชี เงินต้น ดอกเบี้ย ค่าธรรมเนียม ยอดรวม จำนวนงวด เดือนเริ่มเก็บ เดือนเริ่มชำระ วันครบกำหนด (ถ้าทราบ) และหมายเหตุ พร้อมตัวอย่างก่อนยืนยัน; เลือกบัญชี เจ้าของ หมวดหมู่จากรายการ (ส่ง ID) แล้ว Backend เติมชื่อเอง และคัดลอกข้อมูลธุรกิจไปทุกงวดตาม §7.1.2

หนึ่งแผนต่อหนึ่งแถวใน PaymentPlans และหนึ่งงวดต่อหนึ่งแถวใน PaymentSchedules; แยก installment_no และ installment_count เป็น Integer ห้ามเก็บเป็น 1/6 ในฐานข้อมูล (UI แสดงได้)

| งวดที่ | งวดทั้งหมด | ปีเดือนเก็บ | ปีเดือนชำระ | ยอดต้องชำระ |
|---:|---:|---:|---:|---:|
| 1 | 6 | 202611 | 202612 | 100 |
| 2 | 6 | 202612 | 202701 | 100 |
| 3 | 6 | 202701 | 202702 | 100 |
| 4 | 6 | 202702 | 202703 | 100 |
| 5 | 6 | 202703 | 202704 | 100 |
| 6 | 6 | 202704 | 202705 | 100 |

- ONE_TIME ใช้ 1 และ 1; สร้างงวดทั้งหมดแบบ Batch Write; แก้ยอดรายงวดได้โดยผลรวมตรงกับแผน; ปรับเศษงวดสุดท้ายด้วยหน่วยสตางค์
- แยกเดือนเก็บและเดือนชำระ (YYYYMM); คำนวณข้ามปีด้วย calendar arithmetic ห้ามบวก 1 ตรง ๆ; วันครบกำหนดเกินวันสุดท้ายของเดือนให้ใช้วันสุดท้าย
- รองรับกันเงินหลายครั้ง หลายบัญชี ปลดเงิน ชำระบางส่วน ชำระหลายงวดพร้อมกัน และปิดยอดก่อนกำหนดโดยยืนยันยอดจริงก่อน
- ห้ามแก้งวดที่ชำระแล้วอัตโนมัติ; การยกเลิกต้องรักษาประวัติและจัดการเงินกันไว้/ยอดชำระเดิมอย่างถูกต้อง ไม่ลบธุรกรรมจริง
- สถานะเก็บเงินคำนวณ: NOT_SAVED, PARTIAL, SAVED, NOT_REQUIRED (ชำระครบ), CANCELLED
- สถานะชำระคำนวณ: UNPAID, PARTIAL, PAID, CANCELLED; is_overdue เป็น flag แยกเมื่อยังมียอดค้างและเลย due_date เพื่อไม่สูญเสียสถานะชำระบางส่วน
- จำนวนงวดคงเหลือนับงวดที่ยังมียอดค้างและไม่ยกเลิก ไม่ใช้จำนวนงวดทั้งหมดลบเลขงวดปัจจุบัน
- การกันเงินเป็นการจัดสรรเงินที่มีอยู่ ไม่ใช่ธุรกรรมรายจ่าย; การชำระจริงสร้าง Transactions และ PaymentAllocations พร้อม CONSUME เฉพาะเงินกันไว้ที่ใช้จริง

### 6.4 Account Management

รองรับประเภทบัญชี:

- เงินสด
- บัญชีธนาคาร
- E-Wallet
- บัตรเครดิต
- บัตรกดเงินสด
- บัญชีเงินออม (BANK พร้อม subtype SAVINGS)
- สินเชื่อ (LOAN)

รวมบัญชีและบัตรใน Accounts เดียว; ประเภท CASH, BANK, E_WALLET, CREDIT_CARD, CASH_CARD, LOAN; แยกสินทรัพย์และหนี้สิน ไม่รวมวงเงินเป็นเงินสด

รองรับยอดยกมา สถานะบัญชี และประวัติรายการ

ห้ามจัดเก็บรหัสผ่านธนาคาร PIN CVV หรือหมายเลขบัตรเครดิตเต็ม

### 6.5 Reports

- รายงานรายรับรายจ่ายรายเดือน
- รายงานรายรับรายจ่ายรายปี
- รายงานตามหมวดหมู่
- รายงานตามเจ้าของรายการ
- รายงานตามบัญชีและบัตร
- รายงานยอดเก็บเงินรายเดือน
- รายงานยอดชำระรายเดือน
- รายงานยอดผ่อนคงเหลือ
- Export CSV
- รองรับ Google Sheets Pivot Table

## 7. Database Design — V2 (Canonical Schema)

ใช้ 9 ตารางธุรกิจหลัก พร้อม AuditLogs และ OperationJournal สำหรับความปลอดภัย/กู้คืน; Budgets เป็นระยะถัดไป; Pivot เป็นรายงาน ไม่ใช่ฐานข้อมูลต้นฉบับ

| Sheet | Grain / หน้าที่ |
|---|---|
| Accounts | หนึ่งบัญชีหรือบัตร |
| Owners | หนึ่งเจ้าของ |
| Categories | หนึ่งหมวดหมู่ |
| Transactions | หนึ่งธุรกรรมจริง |
| PaymentPlans | หนึ่งแผน |
| PaymentSchedules | หนึ่งงวด |
| Reservations | หนึ่งเหตุการณ์กัน/ปลด/ใช้เงิน |
| PaymentAllocations | หนึ่งการจัดสรรธุรกรรมให้หนึ่งงวด |
| Settings | หนึ่งค่าตั้งค่า |
| AuditLogs | หนึ่งเหตุการณ์ตรวจสอบ |
| OperationJournal | หนึ่งคำขอเขียนข้อมูลเพื่อป้องกันซ้ำและกู้คืน |
| Budgets | ทางเลือกภายหลัง |
| Pivot_Saving / Pivot_Payment / Pivot_Transactions | รายงาน |

### 7.1 Canonical headers (เรียงตามลำดับ) — อนุมัติแล้ว 2026-11-25

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

รายละเอียด type, ความหมาย และ Kind ของทุกคอลัมน์อยู่ใน docs/database-schema.md ซึ่งต้องตรงกับรายการนี้เสมอ

### 7.1.1 Business Information Columns

PaymentPlans และ PaymentSchedules มีชุดคอลัมน์เดียวกัน; Transactions ใช้ชุดเดียวกันแต่แยกบัญชีเป็น from_account_id, from_account_name, to_account_id, to_account_name

| Column | ความหมาย | ผู้เขียนค่า |
|---|---|---|
| account_id | รหัสบัญชีหรือบัตร | ผู้ใช้เลือก (FK) |
| account_name | บัตร / ช่องทางทำรายการ | Backend จาก Accounts |
| owner_id | รหัสเจ้าของรายการ | ผู้ใช้เลือก (FK) |
| owner_name | เจ้าของรายการ | Backend จาก Owners |
| category_id | รหัสหมวดหมู่ | ผู้ใช้เลือก (FK) |
| category_name | ชื่อหมวดหมู่ | Backend จาก Categories |
| item_name | ชื่อรายการ | ผู้ใช้ (Schedules คัดลอกจาก Plan) |
| description | รายละเอียดของรายการหลัก | ผู้ใช้ (Schedules คัดลอกจาก Plan) |
| note | หมายเหตุเพิ่มเติม แยกอิสระต่อแถว | ผู้ใช้ |

ลำดับคอลัมน์: `*_id` ตามด้วย `*_name` เสมอ; note อยู่ท้ายคอลัมน์ธุรกิจก่อน created_at

### 7.1.2 Data Management Rules (ID / Name)

- ใช้ ID เป็นรหัสอ้างอิงหลักระหว่างตาราง; ใช้ Name สำหรับแสดงผล ค้นหา กรองข้อมูล และ Pivot Table เท่านั้น
- Backend ดึงชื่อจาก Master Data อัตโนมัติ; ผู้ใช้ไม่ต้องกรอกชื่อและรหัสซ้ำ; API ไม่รับ `*_name` จาก Client
- เมื่อแก้ชื่อบัญชี เจ้าของ หรือหมวดหมู่ ให้ refresh ชื่อใน Transactions, PaymentPlans และ PaymentSchedules ทุกแถวที่อ้างอิง (รวมรายการในอดีต) โดยไม่เปลี่ยน ID; เป็นการ refresh projection ไม่เปลี่ยน updated_at และไม่คำนวณยอดใหม่; บันทึก audit หนึ่งเหตุการณ์ และต้องมี refreshProjections() แบบ idempotent สำหรับกู้คืน
- เมื่อสร้างแผน ให้คัดลอก account, owner, category (ทั้ง ID และชื่อ), item_name, description และข้อมูลแผน (purchase_date, plan_type, installment_count) จาก PaymentPlans ไปยัง PaymentSchedules ทุกงวด; แก้ข้อมูลเหล่านี้ที่แผนแล้ว propagate ไปทุกงวด
- description เก็บรายละเอียดของรายการหลัก; note เก็บหมายเหตุเพิ่มเติม แก้แยกแต่ละงวดได้ เริ่มต้นว่าง ไม่คัดลอกจาก PaymentPlans.note และไม่ถูกเขียนทับเมื่อแก้แผน
- ห้ามใช้ note หรือ description แทนสถานะเก็บเงินหรือสถานะชำระเงิน
- กฎละเอียดอยู่ใน docs/business-rules.md

### 7.2 Types and integrity

- UUID เป็น text PK สำหรับ *_id หลัก; Settings ใช้ setting_key; FK ต้องมีอยู่จริง; external_ref เป็น text ไม่ใช่ PK; ห้ามใช้เลขแถวเป็น PK
- วันที่ธุรกิจเป็น YYYY-MM-DD (ค.ศ.) แบบข้อความ ISO ที่ตรวจสอบได้; timestamp เป็น ISO 8601 พร้อม timezone; ใช้ Asia/Bangkok สำหรับเดือนธุรกิจ
- ทุก field ปีเดือน (*_month ที่หมายถึงปีเดือน) เป็น Integer YYYYMM เช่น 202611; ตรวจสอบ 6 หลักและเดือน 01–12; ปีและเดือนแยกเป็น Integer; installment_no, installment_count, remaining_installments เป็น Integer; วันตัดรอบ/ครบกำหนด 1–31 หรือว่าง
- จำนวนเงินเป็น Number หน่วยบาท 2 ตำแหน่ง; คำนวณด้วย integer satang; boolean เป็น TRUE/FALSE; enum เป็น text; วันที่ไม่ทราบให้ว่าง ไม่สร้างวันที่เทียม
- หนึ่งแถวต่อ record, หนึ่งคอลัมน์ต่อ attribute, snake_case, header ไม่ซ้ำ, ห้าม merge หรือแถวรวมในฐานข้อมูล
- PaymentSchedules เป็นตาราง Pivot-ready แยกตามบัญชี เจ้าของ หมวดหมู่ ชื่อรายการ ปีเดือนเก็บเงิน และปีเดือนชำระได้โดยไม่ต้อง join; คอลัมน์ `*_name` ใน Transactions, PaymentPlans, PaymentSchedules และข้อมูลแผนที่ซ้ำใน PaymentSchedules เป็น derived projection จาก ID; refresh เมื่อข้อมูลหลักเปลี่ยน; ห้ามแก้ projection โดยตรง (ยกเว้น note ซึ่งเป็นข้อมูลของแต่ละแถว)
- amount_due คือยอดตามแผน ไม่ใช่ยอดจ่ายจริง; total_amount เก็บเฉพาะ PaymentPlans; installment_count และ remaining_installments ห้าม SUM ข้ามงวด
- plan_status: ACTIVE, COMPLETED, CANCELLED; สถานะ derived จากงวดและการยกเลิกที่ได้รับอนุมัติ
- ธุรกรรม/ประวัติที่มีผลทางการเงินใช้การกลับรายการที่ตรวจสอบได้แทนการลบจริง; master data ใช้ is_active; ห้ามลบ FK ที่ถูกใช้งาน

### 7.3 Accounting rules

| transaction_type | ผลทางบัญชี |
|---|---|
| INCOME | เพิ่มสินทรัพย์และรายรับ |
| EXPENSE | ลดสินทรัพย์และรับรู้รายจ่าย |
| TRANSFER | ย้ายเงินระหว่างบัญชีสินทรัพย์ ไม่ใช่รายรับ/รายจ่าย |
| CREDIT_PURCHASE | เพิ่มหนี้และรับรู้ค่าใช้จ่ายเมื่อซื้อ |
| CREDIT_PAYMENT | ลดสินทรัพย์และหนี้ ไม่รับรู้รายจ่ายซ้ำ (รวมการคืนเงินต้นของบัญชี LOAN; ดอกเบี้ยแยกเป็น INTEREST) |
| CASH_ADVANCE | บันทึกเงินที่ได้รับและหนี้ที่เกิดขึ้น ไม่ใช่รายรับ (รวมการรับเงินกู้/ยืมเงินจากบัญชี LOAN) |
| INTEREST / FEE | รับรู้ค่าใช้จ่ายเมื่อเกิดจริง เพิ่มหนี้หรือลดสินทรัพย์ตามกรณี |
| REFUND | กลับผลของรายการต้นฉบับตามบัญชีจริง |
| ADJUSTMENT | ปรับยอดโดยมีเหตุผลและ audit; ไม่ถือเป็นรายรับรายจ่ายโดยปริยาย |

- amount เป็นบวก; backend กำหนดทิศทางตามประเภทและบัญชี; opening_balance ของสินทรัพย์และหนี้แสดงเป็นยอดบวกตามประเภท; ห้ามใช้ credit_limit เป็นเงินที่ใช้ได้
- แผนผ่อนจากการซื้อจริงเชื่อม CREDIT_PURCHASE เพียงครั้งเดียว; แผนรายจ่ายอนาคตไม่สร้างรายจ่ายจนเกิดจริง; ดอกเบี้ย/ค่าธรรมเนียมตามแผนไม่รับรู้ซ้ำเมื่อเกิดจริง
- Reservations: RESERVE เพิ่มเงินกันไว้, RELEASE ปลดเงิน, CONSUME ใช้เงินกันไว้ชำระจริงและต้องเชื่อม transaction_id; ห้ามกันเกินยอดที่ใช้ได้หรือปลด/ใช้เกินยอดที่กันในบัญชี
- PaymentAllocations เชื่อมธุรกรรมชำระจริงกับงวด; ผลรวมจัดสรรไม่เกินยอดธุรกรรมหรือยอดค้างของงวด; ยอดที่ยังไม่จัดสรรต้องแสดงแยก; ไม่สร้างธุรกรรมซ้ำจาก allocation
- amount_saved = SUM(RESERVE) - SUM(RELEASE) (ไม่หัก CONSUME); amount_reserved = amount_saved - SUM(CONSUME ของธุรกรรมที่มีผลจริง) — เมื่อการชำระถูกกลับรายการ CONSUME เดิมไม่ถูกนับ เงินจึงกลับมาเป็นกันไว้ (ตัดสินใจ 2026-11-26); amount_paid = ยอดจัดสรรสุทธิของธุรกรรมที่มีผลจริง
- remaining_to_pay = MAX(0, amount_due - amount_paid); remaining_to_save = MAX(0, remaining_to_pay - amount_reserved); งวดยกเลิกไม่นับภาระอนาคต แต่ยังรักษาประวัติจริง
- เงินที่ใช้ได้จริง = เงินสดและเงินฝากรวม E_WALLET - เงินกันไว้คงเหลือ; แสดงแยกตามบัญชีและรวม; หนี้สินคำนวณจากธุรกรรม ไม่ใช่ SUM งวดซ้ำ
- saving_year = INT(saving_month/100); saving_month_no = MOD(saving_month,100); payment_year และ payment_month_no ใช้หลักเดียวกัน; is_month_different = saving_month != payment_month
- saving_completed_date และ paid_date มาจากเหตุการณ์จริงเมื่อครบ; ถ้าไม่ทราบให้ว่าง; สถานะและยอด derived คำนวณใหม่หลังแก้ไข/กลับรายการ

### 7.4 Pivot and reporting

| Report | Source | Rows | Columns | Values |
|---|---|---|---|---|
| แผนเก็บ | PaymentSchedules | account_name | saving_month | SUM amount_due, remaining_to_save |
| แผนจ่าย | PaymentSchedules | account_name | payment_month | SUM amount_due, remaining_to_pay |
| แยกเจ้าของ/สินค้า | PaymentSchedules | owner_name / item_name | saving_month / payment_month | SUM amount_due |
| กันเงินจริง | Reservations (ผ่าน derived view ที่ join account_name) | account_name | YYYYMM จาก reservation_date | RESERVE ลบ RELEASE (แยก CONSUME) |
| ชำระเงินจริง | Transactions / PaymentAllocations | บัญชีหรือแผน | YYYYMM จาก transaction_date | SUM ยอดจริงหรือ allocated_amount ตาม grain |
| รายรับรายจ่าย | Transactions | category_name / owner_name / from_account_name / to_account_name | YYYYMM จาก transaction_date | SUM รายรับ/รายจ่ายตาม accounting rules |

กรองงวดยกเลิกออกจากแผน; รายงานประวัติใช้วันที่จริง ไม่ใช้เดือนแผนแทน; ใช้ derived report view สำหรับ join และ signed amounts โดยไม่แก้ข้อมูลต้นฉบับ; Dashboard อ่านข้อมูลต้นฉบับ/summary cache ไม่พึ่ง Pivot ในเส้นทางบันทึก

### 7.5 Write consistency and migration

- ทุกคำขอเขียนมี idempotency_key คงเดิมเมื่อ retry; ตรวจ actor และ request_hash; key เดิมแต่ payload ต่างให้ปฏิเสธ
- ใช้ LockService และ OperationJournal สถานะ PENDING / COMMITTED / FAILED / NEEDS_RECOVERY; บันทึกแผนกู้คืนก่อนเขียนหลาย Sheet; ใช้ ID ที่กำหนดไว้ล่วงหน้าเพื่อ replay โดยไม่ซ้ำ; ยืนยันสำเร็จเมื่อทุกส่วนตรวจสอบครบเท่านั้น
- Google Sheets ไม่มี ACID transaction ข้าม Sheet; ห้ามอ้าง atomicity; ตรวจและกู้คืนงานค้างก่อนการเขียนที่เกี่ยวข้อง; ไม่เปิดเผย recovery_data ฝั่ง client
- ห้ามเปลี่ยน header หรือลบข้อมูลเดิมโดยไม่ได้รับอนุญาต; migration ต้องสำรองและ dry run; mapping Installments → PaymentPlans, InstallmentSchedule → PaymentSchedules, Cards → Accounts, InstallmentPayments → Transactions/PaymentAllocations ตามข้อมูลจริง; ไม่สร้างยอดหรือวันที่ย้อนหลังจากสถานะเพียงอย่างเดียว ให้แยกรายการที่ต้องตรวจสอบ
- สถานะ 2026-11-25: ไม่มีข้อมูลระบบเดิม V2 เริ่มจาก Spreadsheet ว่าง จึงไม่ต้อง Migration; ข้อกำหนด migration ข้างต้นใช้เมื่อมีการนำเข้าข้อมูลในอนาคตเท่านั้น

## 8. UI/UX Guidelines

- Modern Minimal Design
- Mobile First
- Responsive Design
- ใช้ธีม Indigo, White และ Slate
- ใช้ภาษาไทยเป็นหลัก
- ลดจำนวนขั้นตอนในการบันทึกข้อมูล
- รองรับ Quick Entry
- ปุ่มกดเหมาะสมกับหน้าจอสัมผัส
- มี Loading Indicator
- มี Empty State
- มี Error State
- มี Toast Notification
- มี Confirmation ก่อนลบข้อมูล
- ป้องกันการกด Submit ซ้ำ
- ไม่ Refresh ทั้งหน้าโดยไม่จำเป็น
- ไม่สร้าง HTML ID ซ้ำ
- ใช้ Label ที่สัมพันธ์กับ Input
- รองรับ Keyboard Navigation

## 9. Performance Guidelines

Google Apps Script และ Google Sheets มีข้อจำกัดด้านเวลาและ Quota จึงต้องออกแบบให้ลดจำนวนการเรียกใช้งาน

- ใช้ Batch Read และ Batch Write
- ใช้ getValues() และ setValues() เมื่อเหมาะสม
- หลีกเลี่ยงการอ่านหรือเขียน Cell ทีละรายการภายใน Loop
- หลีกเลี่ยงการเรียก SpreadsheetApp ซ้ำโดยไม่จำเป็น
- ใช้ CacheService สำหรับข้อมูลที่เหมาะสม
- ใช้ LockService สำหรับการเขียนข้อมูลที่อาจเกิดพร้อมกัน
- โหลดข้อมูลเฉพาะหน้าที่จำเป็น
- รองรับ Pagination
- ใช้ Debounce สำหรับการค้นหา
- หลีกเลี่ยงการโหลดข้อมูลทั้งระบบทุกครั้งที่เปลี่ยนหน้า
- จัดการ Timeout และ Error อย่างเหมาะสม
- ใช้ google.script.run แบบ asynchronous พร้อม success/failure handler; แสดง optimistic UI เป็น PENDING เท่านั้น
- ใช้ IndexedDB สำหรับคิวที่ยังไม่ยืนยันเมื่อรองรับ; retry แบบจำกัดจำนวนและ backoff โดยใช้ idempotency key เดิม; แสดงรายการล้มเหลวและให้ retry เองได้
- คิวต้องแยกตามผู้ใช้ ไม่เก็บข้อมูลละเอียดอ่อนเกินจำเป็น; หาก IndexedDB ใช้ไม่ได้ให้แจ้งข้อจำกัด; ไม่รับประกัน sync เมื่อปิดหน้าเว็บหรือ offline cold start
- ไม่เรียก AI หรือ refresh Pivot ในเส้นทางบันทึกหลัก
- ไม่แสดงสถานะบันทึกสำเร็จก่อน Backend ยืนยันผล

## 10. Security Guidelines

- ใช้ Google Account และกลไกการอนุญาตสิทธิ์ที่เหมาะสม
- ตรวจสอบ Authentication และ Authorization ที่ Backend
- ไม่เปิด Web App เป็นสาธารณะโดยไม่ได้รับอนุญาต
- ไม่เชื่อถือข้อมูลจาก Client โดยตรง
- ตรวจสอบ Input ทุกครั้ง
- ป้องกัน XSS
- ป้องกัน Spreadsheet Formula Injection
- ป้องกัน Duplicate Submission
- ไม่ Hardcode Secret หรือ API Key
- ใช้ Script Properties สำหรับค่าที่ต้องเก็บฝั่ง Server
- ไม่บันทึกข้อมูลการเงินส่วนตัวลง Debug Log โดยไม่จำเป็น
- ไม่ส่งข้อมูลการเงินจริงไปยัง AI หรือบริการภายนอกโดยไม่ได้รับอนุญาต
- ใช้ข้อมูลจำลองในการพัฒนาและทดสอบ
- ห้ามปิดหรือหลีกเลี่ยง Sandbox Controls

## 11. AI Integration Guidelines

ออกแบบระบบให้สามารถรองรับ AI Integration ในอนาคต เช่น:

- บันทึกรายจ่ายจากข้อความภาษาไทย
- วิเคราะห์และเสนอหมวดหมู่รายการ
- อ่านข้อมูลจากใบเสร็จหรือสลิป
- สรุปรายรับรายจ่าย
- ตรวจสอบรายการที่อาจซ้ำกัน

AI ต้องแปลงข้อมูลให้อยู่ในรูปแบบ Structured JSON และผ่าน Validation ก่อนบันทึก

ห้ามให้ AI แก้ไขหรือลบข้อมูลการเงินจริงโดยไม่มีการตรวจสอบและยืนยันจากผู้ใช้

## 12. Git & GitHub Guidelines

- ใช้ GitHub Private Repository
- ใช้ Local Drive เป็นพื้นที่พัฒนาหลัก
- ตรวจสอบ git status ก่อนเริ่มงาน
- ตรวจสอบ git diff หลังแก้ไข
- ไม่แก้ไขไฟล์ที่ไม่เกี่ยวข้องกับงาน
- ไม่เขียนทับการแก้ไขของผู้ใช้
- ใช้ Commit Message ที่สื่อความหมาย

รูปแบบ Commit Message:

- feat: เพิ่มฟังก์ชัน
- fix: แก้ไขข้อผิดพลาด
- refactor: ปรับโครงสร้าง
- perf: ปรับปรุงประสิทธิภาพ
- docs: ปรับปรุงเอกสาร
- test: เพิ่มหรือแก้ไขการทดสอบ
- chore: งานดูแลโปรเจกต์

ห้ามดำเนินการโดยไม่ได้รับอนุญาต:

- git push
- git push --force
- git reset --hard
- git clean -fd
- ลบ Branch
- เปลี่ยน Remote Repository
- เขียนทับประวัติ Git

## 13. Clasp Guidelines

ใช้ Clasp สำหรับเชื่อมต่อ Local Source Code กับ Google Apps Script

คำสั่งที่เกี่ยวข้อง:

- clasp status
- clasp pull
- clasp push
- clasp deploy
- clasp deployments

ข้อกำหนด:

- ตรวจสอบ Script ID และ Project เป้าหมายก่อนดำเนินการ
- ตรวจสอบเวอร์ชัน Clasp และคำสั่งที่รองรับ
- ตรวจสอบ .claspignore ก่อน Push
- ห้าม Pull หากอาจเขียนทับ Local Changes โดยไม่ได้รับอนุญาต
- ห้าม clasp push โดยไม่ได้รับอนุญาต
- ห้าม clasp push --force โดยไม่ได้รับอนุญาต
- ห้าม Deploy หรืออัปเดต Production Deployment โดยไม่ได้รับอนุญาต
- ห้ามสร้าง Apps Script Project ใหม่หากมีโปรเจกต์เดิมอยู่แล้วโดยไม่ได้รับอนุญาต

## 14. File Exclusion Rules

ไฟล์ที่ไม่ควรนำขึ้น GitHub:

- .env
- .env.*
- .clasprc.json
- .clasp.json
- credentials.json
- client_secret*.json
- token.json
- node_modules/
- backup/
- exports/
- ไฟล์ Log
- ไฟล์ข้อมูลการเงินจริง

ไฟล์ที่ไม่ควร Push ขึ้น Apps Script:

- AGENTS.md
- README.md
- CHANGELOG.md
- docs/
- tests/
- .git/
- ไฟล์ Credential
- ไฟล์สำรองข้อมูล
- ไฟล์ที่ไม่เกี่ยวข้องกับ Runtime

กำหนด .gitignore และ .claspignore แยกจากกัน

## 15. Development Workflow

ทุกครั้งที่ได้รับงาน ให้ดำเนินการดังนี้:

1. อ่าน AGENTS.md
2. ตรวจสอบโครงสร้างโปรเจกต์
3. ตรวจสอบ Source Code ที่เกี่ยวข้อง
4. ตรวจสอบ Git Status
5. วิเคราะห์ความต้องการและผลกระทบ
6. วางแผนการแก้ไข
7. แก้ไข Source Code จริง
8. ตรวจสอบ Syntax และ Business Logic
9. ทดสอบด้วยข้อมูลจำลอง
10. ตรวจสอบ Git Diff
11. ปรับปรุงเอกสารที่เกี่ยวข้อง
12. สรุปผลการดำเนินงาน

ก่อนเริ่มสร้างระบบ V2 ให้ตรวจ repo และ schema จริงแบบ read-only จัดทำ docs/database-schema.md, docs/business-rules.md, docs/system-architecture.md, docs/development-plan.md, docs/test-plan.md, docs/migration-plan.md ตามเอกสารนี้ (เอกสารทั้งหมดต้องสอดคล้องกับ §7.1) แล้วเสนอให้ผู้ใช้อนุมัติก่อนเปลี่ยน schema หรือเริ่ม implementation ครั้งแรก ห้ามสร้างหรือแก้ Production ในขั้นวางแผน

ลำดับพัฒนา: master data → transactions → payment planner/reservations/allocations → dashboard/pivot → reliability tests → optional AI; ใช้กลไกป้องกันข้อมูลซ้ำและความปลอดภัยตั้งแต่ระยะแรก

สำหรับงานขนาดเล็กหลังอนุมัติแผน สามารถแก้ไขได้ทันทีโดยไม่ต้องเสนอแผนยาว

สำหรับงานที่กระทบ Database Schema, Authentication, Security หรือ Production ต้องเสนอแผนและขออนุญาตก่อนดำเนินการ

## 16. Testing Requirements

ต้องตรวจสอบกรณีต่อไปนี้ตามความเกี่ยวข้องของงาน:

- การเพิ่ม แก้ไข และลบรายการ
- การกรอกข้อมูลไม่ครบ
- จำนวนเงินไม่ถูกต้อง
- การบันทึกซ้ำ
- การผ่อนชำระข้ามปี 202612 → 202701 และปฏิเสธ 202613
- แผน 600 บาท 6 งวด ต้องได้ 6 แถว งวดที่ 1–6 งวดทั้งหมด 6 ยอดรวม 600 และทุกงวดมีบัญชี เจ้าของ หมวดหมู่ (ID และชื่อ) ชื่อรายการ และรายละเอียดตรงกับแผน
- เปลี่ยนชื่อบัญชี เจ้าของ หมวดหมู่ แล้วชื่อในทุกตารางและ Pivot ตรงกัน โดย ID ไม่เปลี่ยน
- แก้ note รายงวดโดยไม่กระทบงวดอื่น ยอด และสถานะ
- กันเงินหลายบัญชี ปลดเงิน ใช้เงินกันไว้ ชำระหลายงวด และไม่จัดสรรเกินยอด
- การบันทึกข้าม Sheet ล้มเหลวกลางทาง การกู้คืน และ retry ด้วย key เดิม
- Pivot ไม่รวมยอดเต็มซ้ำและแยกเดือนจริงจากเดือนแผน
- การยกเลิกและกลับรายการโดยรักษาประวัติ
- การผ่อนชำระข้ามปี
- การผ่อนชำระที่มีเศษทศนิยม
- เดือนเก็บเงินและเดือนชำระไม่ตรงกัน
- การชำระบางส่วน
- การโอนเงินระหว่างบัญชี
- การคำนวณยอดคงเหลือ
- การนับรายจ่ายซ้ำ
- การใช้งานผ่านมือถือ
- การเชื่อมต่อ Backend ล้มเหลว
- การเขียนข้อมูลพร้อมกัน
- การเข้าถึงข้อมูลโดยไม่มีสิทธิ์

ห้ามอ้างว่าทดสอบสำเร็จ หากยังไม่ได้ดำเนินการทดสอบจริง

## 17. Data Protection & Migration

- ห้ามลบข้อมูลเดิมโดยพลการ
- ห้าม Reset Database โดยอัตโนมัติ
- ห้ามสร้างข้อมูลทดสอบลง Production
- สำรองข้อมูลก่อน Migration
- ฟังก์ชัน initializeDatabase() ต้องเรียกซ้ำได้โดยไม่ทำลายข้อมูลเดิม
- Migration ต้องตรวจสอบ Schema ปัจจุบันก่อนดำเนินการ
- รองรับ Dry Run สำหรับการเปลี่ยนแปลงที่มีความเสี่ยง
- ต้องมีแนวทาง Rollback เมื่อเหมาะสม

## 18. Definition of Done

งานจะถือว่าเสร็จเมื่อ:

- ทำงานตรงตามความต้องการ
- ไม่ทำให้ฟังก์ชันเดิมเสียหาย
- ไม่มี Syntax Error ที่ตรวจพบ
- ผ่านการทดสอบที่สามารถดำเนินการได้
- ไม่เปิดเผยข้อมูลสำคัญ
- ไม่ทำให้ข้อมูลทางการเงินถูกนับซ้ำ
- รองรับ Desktop และ Mobile ตามขอบเขตงาน
- มีการปรับปรุงเอกสารที่เกี่ยวข้อง
- ระบุข้อจำกัดและสิ่งที่ยังไม่ได้ทดสอบอย่างชัดเจน

## 19. Response Format

เมื่อดำเนินงานเสร็จ ให้สรุปเป็นภาษาไทย โดยประกอบด้วย:

1. สรุปสิ่งที่ดำเนินการ
2. ไฟล์ที่สร้างหรือแก้ไข
3. รายละเอียดการเปลี่ยนแปลง
4. ผลการทดสอบ
5. ผลกระทบต่อข้อมูลเดิม
6. ข้อจำกัดหรือความเสี่ยง
7. ขั้นตอนที่ผู้ใช้ต้องดำเนินการต่อ

## 20. Core Principles

- Simplicity First
- Security First
- Data Integrity
- Mobile First
- Performance Awareness
- Maintainability
- Backward Compatibility
- No Unauthorized Deployment

ให้ความสำคัญกับความถูกต้องของข้อมูลและความสะดวกในการใช้งานมากกว่าการเพิ่มความซับซ้อนของระบบโดยไม่จำเป็น

หากข้อกำหนดไม่ชัดเจน ให้เลือกแนวทางที่เรียบง่ายและปลอดภัยสำหรับการเปลี่ยนแปลงที่ย้อนกลับได้ แต่ต้องสอบถามผู้ใช้ก่อนดำเนินการที่มีผลกระทบสำคัญหรือย้อนกลับได้ยาก

## 21. Local Development & Testing Tools

เครื่องมือที่ใช้จริงในโปรเจกต์นี้ (ต้องมี Node.js 20+; ไม่มี npm dependency) — AI ทุกตัวต้องใช้ตามนี้ก่อนอ้างว่าทดสอบแล้ว

| คำสั่ง | ใช้ทำอะไร |
|---|---|
| `npm test` | Unit test ทั้งหมด (`node --test tests/*.test.js`) ต้องผ่านทุกกรณีก่อน commit/clasp push |
| `node --test tests/<file>.test.js` | รันเฉพาะไฟล์ |
| `npm run dev` | Preview หน้าเว็บที่ http://localhost:5178 (`tests/dev-server.js`) ใช้โค้ด `.gs`/`.html` จริงกับข้อมูลจำลองในหน่วยความจำ ไม่เชื่อมต่อ Google |
| `node tests/perf-probe.js` | นับจำนวนการเรียก Sheets API ต่อคำขอ (ใช้เทียบก่อน/หลังปรับประสิทธิภาพ) |

### 21.1 โครงสร้างการทดสอบ

- `tests/gas-shim.js`: fake Apps Script services (SpreadsheetApp, PropertiesService, LockService, Session, Utilities, HtmlService, Logger) และโหลดไฟล์ `.gs` ทุกไฟล์ใน root เข้า `vm` context; `createDbContext()` ให้ Spreadsheet จำลองที่ initialize แล้ว; `countCalls`/`resetCalls` สำหรับนับการเรียก API
- ค่าจาก vm context เป็นคนละ realm: แปลงด้วย `JSON.parse(JSON.stringify(x))` ก่อน `assert.deepEqual`
- idempotency key ในการทดสอบต้องตรง `/^[A-Za-z0-9_-]{8,128}$/`
- `tests/performance.test.js` คุมงบจำนวนการเรียก Sheets ต่อคำขอ — ถ้าเพิ่มการอ่าน/เขียนต้องปรับงบพร้อมเหตุผล
- `tests/html.test.js` ตรวจลิงก์ภายใน, include whitelist และ HTML id ซ้ำ
- `tests/dev-server.js` ตัวเลือก env: `DEV_EMPTY=1` (ไม่ seed ข้อมูล), `DEV_DELAY_MS` (หน่วงเวลาตอบกลับ), `DEV_FAIL_RATE` (0–1 จำลองเครือข่ายล้มเหลว); แก้ `.html` แล้วรีเฟรชได้ทันที แต่แก้ `.gs` ต้อง restart server; การ navigate ไป URL เดิมที่ต่างแค่ `#hash` ไม่ reload หน้า (เติม `?r=n` เพื่อบังคับ reload)
- `.claude/launch.json` มี configuration `expense-manager-preview` สำหรับเปิด preview

### 21.2 ทดสอบบน Apps Script จริง (`/dev`)

- ต้องได้รับอนุญาตจากผู้ใช้ก่อน `clasp push` ทุกครั้ง (§13); หลัง push ให้ `clasp pull` ลงโฟลเดอร์ชั่วคราวแยกจาก repo แล้ว diff ว่าตรงกับในเครื่อง (ห้าม pull ทับ repo)
- ถ้า `clasp push` ตอบ `Skipping push.` แปลว่า `appsscript.json` บนเซิร์ฟเวอร์ต่างจากในเครื่อง: ดึงมาเทียบก่อน ห้ามใช้ `--force` โดยไม่ได้รับอนุญาต
- Script Properties: `SPREADSHEET_ID`, `TEST_SPREADSHEET_ID`, `ALLOWED_EMAILS`, `DB_TARGET` (`TEST` = Web App ใช้ไฟล์ทดสอบ); ฟังก์ชันผู้ดูแล `checkDatabase`/`initializeDatabase`/`refreshProjections` ใช้ Production เสมอ — ห้ามเขียนข้อมูลทดสอบลง Production
- ทดสอบผ่าน Test deployment (URL ลงท้าย `/dev`, ใช้โค้ด HEAD ล่าสุด) ด้วย `DB_TARGET=TEST`; ห้ามสร้างหรืออัปเดต deployment แบบเปิดสาธารณะ
- ดูเวลาทำงานจริงที่ Apps Script → การเรียกใช้ (Executions)

### 21.3 ข้อควรระวังที่พบแล้ว

- หน้าเว็บอยู่ใน iframe ของ Apps Script และ `Index.html` ใช้ `<base target="_top">`: ลิงก์ภายใน (`#...`) ต้องมี `target="_self"` มิฉะนั้นทั้งแท็บจะเป็นหน้าว่าง (preview ในเครื่องจับไม่ได้)
- Tailwind class ที่กำหนด display (`grid`, `flex`) ชนะ attribute `hidden` — `Styles.html` มี `[hidden]{display:none!important}` แล้ว ห้ามลบ
- สร้าง DOM ด้วย `App.el` (textContent) เท่านั้น ห้ามใส่ข้อมูลผู้ใช้ผ่าน `innerHTML`
- ค่า derived ใน `PaymentSchedules` (amount_reserved, สถานะ ฯลฯ) ถูกคำนวณใหม่เมื่อมี activity กับแผนนั้น การเปลี่ยนสูตรจึงไม่ปรับค่าที่เก็บไว้จนกว่าจะมี activity ถัดไป
- Apps Script แต่ละคำขอมีต้นทุนคงที่ราว 2–3 วินาที: ลดจำนวน round trip (รวมหลายข้อมูลในคำขอเดียว) และใช้ cache ภายใน execution ของ `Database` (`resetExecutionCache` หลังได้ lock)

# Migration Plan — Expense Manager V1 → V2

สถานะ: **ไม่ต้องดำเนินการ** — ผู้ใช้ยืนยัน 2026-11-25 ว่าไม่มีข้อมูลระบบเดิม (V1) และเริ่ม V2 ใหม่ทั้งหมด

> เก็บเอกสารนี้ไว้เป็นแนวทางสำหรับการนำเข้าข้อมูลจากแหล่งภายนอกในอนาคตเท่านั้น ไม่อยู่ในขอบเขตพัฒนาปัจจุบัน และไม่ต้องสร้าง MigrationService.gs จนกว่าจะมีความต้องการนำเข้าข้อมูลจริง
ปรับปรุงล่าสุด: 2026-11-25
อ้างอิง: [database-schema.md](database-schema.md) (อนุมัติแล้ว), [business-rules.md](business-rules.md), [../AGENTS.md](../AGENTS.md) §7.5, §17

## 0. สิ่งที่ตรวจแล้ว (read-only)

| แหล่ง | ผล |
|---|---|
| Repo นี้ | ไม่มี source code ระบบเดิม |
| Apps Script project ตาม `.clasp.json` (pull ลงโฟลเดอร์ชั่วคราวแยกจาก repo) | มีเพียง `appsscript.json` — เป็นโปรเจกต์ใหม่ ไม่ใช่โค้ดระบบเดิม |
| Google Sheets "ExpenseManager" ที่ผู้ใช้กำหนด (2026-11-25) | ชีตว่าง `ชีต1` ไม่มีข้อมูล — เป็น **ปลายทาง V2** ไม่ใช่ระบบเดิม |
| Spreadsheet ระบบเดิม (V1) | **ไม่มี** (ผู้ใช้ยืนยัน 2026-11-25) |

ดังนั้น mapping ระดับตารางมาจาก AGENTS.md §7.5 ส่วน mapping ระดับคอลัมน์ในเอกสารนี้เป็น **mapping ตามความหมาย (semantic)** ที่ต้องยืนยันกับ header จริงใน Step M1 ก่อนเขียนโค้ด Migration

## 1. ขอบเขต

| ระบบเดิม (V1) | ปลายทาง V2 | หมายเหตุ |
|---|---|---|
| Cards | Accounts | บัตร/บัญชี |
| ค่าข้อความเจ้าของใน Installments / Cards | Owners | สร้างจากค่าที่ไม่ซ้ำ (ถ้า V1 ไม่มีตารางเจ้าของ) |
| ค่าข้อความหมวดหมู่ใน Installments | Categories | สร้างจากค่าที่ไม่ซ้ำ (ถ้า V1 ไม่มีตารางหมวดหมู่) |
| Installments | PaymentPlans | หนึ่งแผนต่อแถว |
| InstallmentSchedule | PaymentSchedules | หนึ่งงวดต่อแถว |
| InstallmentPayments | Transactions + PaymentAllocations | เฉพาะที่มีวันที่และยอดจริง |
| — | Reservations | **ไม่สร้างย้อนหลัง** เว้นแต่ V1 มีบันทึกการกันเงินจริงพร้อมวันที่และยอด |
| — | Settings, AuditLogs, OperationJournal | สร้างใหม่; Migration บันทึก AuditLogs `MIGRATE` และ OperationJournal |

ไม่อยู่ในขอบเขต: ข้อมูลที่ไม่มีใน V1, Budgets, Pivot (สร้างใหม่หลัง migrate)

## 2. หลักการ

1. **ห้ามแก้หรือลบ Spreadsheet เดิม** — อ่านอย่างเดียว; V2 เขียนลง Spreadsheet ใหม่ที่แยกจากเดิม
2. **Backup ก่อนทุกครั้ง** — ทำสำเนา Spreadsheet เดิมทั้งไฟล์ (Drive copy) และบันทึก file id ของสำเนา
3. **Dry run ก่อนเสมอ** — ผลลัพธ์ dry run เขียนลง Spreadsheet รายงานแยก ไม่เขียนลง V2
4. **ไม่สร้างข้อมูลเทียม** — ไม่สร้างยอด วันที่ หรือธุรกรรมย้อนหลังจากสถานะอย่างเดียว (เช่น "จ่ายแล้ว" ที่ไม่มีวันที่/ยอด); ส่งเข้า Review Queue
5. **ID ใหม่ทั้งหมดเป็น UUID**; เก็บ ID/เลขแถวเดิมใน `external_ref` เพื่อสืบย้อน (`V1:<sheet>:<legacy_id หรือ row>`)
6. **Deterministic** — ID ใหม่สร้างจาก legacy key แบบคงที่ (เช่น UUID v5 จาก namespace + legacy key) เพื่อให้รันซ้ำได้ผลเหมือนเดิมและไม่สร้างซ้ำ
7. **ชื่อเป็น projection** — เติม `*_name` จาก Master V2 ผ่าน ProjectionService ไม่คัดลอกชื่อจาก V1 ตรง ๆ
8. **Derived fields คำนวณใหม่ใน V2** — ไม่คัดลอก status/ยอดคงเหลือจาก V1 แต่ใช้เปรียบเทียบเพื่อตรวจความต่าง

## 3. ขั้นตอน

| Step | งาน | ผลลัพธ์ | ต้องได้รับอนุญาต |
|---|---|---|---|
| M1 | ผู้ใช้ส่ง header ของทุกชีต V1 (หรือไฟล์ export ที่ใช้ข้อมูลจำลอง/ตัดข้อมูลสำคัญ) | ยืนยัน mapping §4 และเติมคอลัมน์ "V1 column" | — |
| M2 | Profiling แบบ read-only: จำนวนแถว, ค่าว่าง, รูปแบบวันที่/เดือน/งวด, ค่าไม่ซ้ำของเจ้าของ/หมวด/บัตร | Profiling report | อนุญาตให้อ่าน Spreadsheet เดิม |
| M3 | Backup Spreadsheet เดิม | file id สำเนา | ✔ |
| M4 | เตรียมปลายทาง V2 ด้วย initializeDatabase() (staging แยก หรือไฟล์ Production "ExpenseManager" ที่ยังว่าง — ผู้ใช้เลือก) | ชีตว่าง header ตรง canonical | ✔ |
| M5 | Dry run: transform ทั้งหมดในหน่วยความจำ → เขียน Migration Report | ยอดเทียบ, Review Queue | — |
| M6 | ผู้ใช้ตรวจ Review Queue และตัดสินใจแต่ละรายการ (แก้ที่ mapping / ข้าม / ยืนยัน) | decisions | ✔ |
| M7 | Migrate ลง staging V2 (batch write, OperationJournal) | ข้อมูล V2 | ✔ |
| M8 | Reconciliation §6 ทุกข้อผ่าน | sign-off | ✔ |
| M9 | ใช้ staging เป็น Production V2 / ชี้ Web App ไป Spreadsheet ใหม่ | cut-over | ✔ (Production) |

ระหว่าง M5–M9 ให้ freeze การบันทึกใน V1 หรือจดรายการที่เพิ่มหลัง snapshot เพื่อ migrate รอบเสริม

## 4. Column mapping (ตามความหมาย — ต้องยืนยันใน M1)

สัญลักษณ์ "V1 column" = `?` คือยังไม่ทราบชื่อจริง

### 4.1 Cards → Accounts

| V2 column | V1 column | กฎแปลง |
|---|---|---|
| account_id | ? (id/แถว) | UUID v5 จาก legacy key |
| account_name | ? ชื่อบัตร | trim; ถ้าซ้ำกันให้เข้า Review |
| account_type | ? ประเภท | map เป็น CREDIT_CARD / CASH_CARD / BANK / CASH / E_WALLET / LOAN; ไม่ทราบ → Review (ค่าเริ่มต้นที่เสนอ: CREDIT_CARD) |
| account_subtype | — | ว่าง |
| owner_id | ? เจ้าของ | lookup Owners จากชื่อ |
| institution | ? ธนาคาร | |
| opening_balance | ? | ถ้าไม่มี → 0 และบันทึกใน Review ว่าต้องตั้งยอดยกมาเอง |
| opening_date | ? | ไม่มี → ว่าง |
| credit_limit | ? วงเงิน | |
| statement_day / due_day | ? วันตัดรอบ / วันครบกำหนด | Integer 1–31 หรือว่าง |
| is_active | ? สถานะ | ไม่มี → TRUE |
| note | ? หมายเหตุ | **ตัดเลขบัตรเต็ม/CVV/PIN ทิ้ง** (ตรวจด้วย pattern ตัวเลข 13–19 หลัก) และแจ้งใน Review |

ห้าม migrate เลขบัตรเต็ม, CVV, PIN, รหัสผ่าน แม้มีใน V1

### 4.2 Owners / Categories

| V2 column | แหล่ง | กฎแปลง |
|---|---|---|
| owner_id / category_id | ค่าข้อความที่ไม่ซ้ำ หรือตาราง V1 ถ้ามี | UUID v5 จากชื่อที่ normalize (trim, ช่องว่างเดี่ยว) |
| owner_name / category_name | ค่าข้อความ | ชื่อที่สะกดต่างแต่หมายถึงสิ่งเดียวกัน (เช่น "แม่" / "คุณแม่") → Review ให้ผู้ใช้ merge |
| category_type | — | EXPENSE (หมวดจากแผนผ่อนเป็นรายจ่าย) |
| is_active | — | TRUE |
| ค่าว่าง | — | Owner "ไม่ระบุ" / Category "ไม่ระบุหมวด" (สร้างเมื่อมีการใช้จริงเท่านั้น) |

### 4.3 Installments → PaymentPlans

| V2 column | V1 column | กฎแปลง |
|---|---|---|
| plan_id | ? | UUID v5 |
| purchase_date | ? วันที่ซื้อ | แปลงเป็น YYYY-MM-DD; ปี พ.ศ. (> 2400) → ลบ 543; แปลงไม่ได้ → ว่าง + Review |
| plan_type | — | INSTALLMENT ถ้าจำนวนงวด > 1, ONE_TIME ถ้า = 1 |
| account_id | ? บัตร | lookup Accounts; ไม่พบ → Review |
| owner_id / category_id | ? | lookup ตาม §4.2 |
| account_name / owner_name / category_name | — | ProjectionService |
| item_name | ? ชื่อสินค้า/รายการ | trim; ว่าง → Review |
| description | ? รายละเอียด | |
| principal_amount | ? ยอดซื้อ/เงินต้น | ถ้า V1 มีแค่ยอดรวม → principal = ยอดรวม, interest = fee = 0 |
| interest_amount / fee_amount | ? | ไม่มี → 0 |
| total_amount | — | คำนวณ; ต้องเท่ากับผลรวม amount_due ของงวด V1 ที่ไม่ยกเลิก มิฉะนั้น Review |
| installment_count | ? จำนวนงวด หรือแยกจาก "n/m" | Integer ≥ 1 |
| first_saving_month / first_payment_month | จากงวดที่ 1 ใน InstallmentSchedule | YYYYMM; ถ้า V1 ไม่มีเดือนเก็บ → ใช้เดือนชำระ และ Review |
| due_day | ? | ไม่มี → ว่าง |
| external_ref | — | `V1:Installments:<key>` (ถ้า V1 มีเลขอ้างอิงภายนอก ให้คงไว้ใน note) |
| plan_status | — | DER |
| note | ? หมายเหตุ | ห้ามแปลงข้อความใน note เป็นสถานะ |

### 4.4 InstallmentSchedule → PaymentSchedules

| V2 column | V1 column | กฎแปลง |
|---|---|---|
| schedule_id | ? | UUID v5 |
| plan_id | ? FK ไปแผน | ไม่พบแผน → Review (orphan) |
| Business info + purchase_date, plan_type, installment_count | — | คัดลอกจาก PaymentPlans ตาม BR (ไม่ใช้ค่าจากแถว V1) |
| installment_no | ? งวดที่ / "n/m" | แยก "1/6" → installment_no = 1; m ต้องเท่ากับ installment_count ของแผน |
| saving_month | ? เดือนเก็บ | แปลงเป็น YYYYMM Integer (รองรับ "11/2026", "2026-11", "พ.ย. 69", Date object) |
| payment_month | ? เดือนชำระ | เช่นเดียวกัน |
| due_date | ? วันครบกำหนด | ไม่มี → คำนวณจาก due_day ถ้ามี มิฉะนั้นว่าง |
| amount_due | ? ยอดต่องวด | Money; ผลรวมต่อแผนต้องตรง total_amount |
| is_cancelled | ? สถานะ | TRUE เฉพาะเมื่อ V1 ระบุยกเลิกชัดเจน |
| DER columns | — | คำนวณใหม่หลัง migrate Transactions/Allocations |
| note | ? หมายเหตุรายงวด | คงไว้ |

สถานะ V1 (เช่น "เก็บแล้ว", "จ่ายแล้ว") **ไม่** ถูกเขียนลง status ของ V2 โดยตรง; ใช้เทียบใน Reconciliation §6 เท่านั้น

### 4.5 InstallmentPayments → Transactions + PaymentAllocations

| V2 column | V1 column | กฎแปลง |
|---|---|---|
| transaction_id | ? | UUID v5 |
| transaction_date | ? วันที่จ่าย | ต้องมี; ไม่มี → Review (ไม่สร้างธุรกรรม) |
| transaction_type | — | CREDIT_PAYMENT เมื่อชำระหนี้บัตร; EXPENSE เมื่อจ่ายตรงจากบัญชีสินทรัพย์ (ตัดสินจากบัญชีต้นทาง; ไม่ชัด → Review) |
| from_account_id | ? บัญชีที่จ่าย | ไม่มี → Review |
| to_account_id | — | บัญชีบัตรของแผน (กรณี CREDIT_PAYMENT) |
| owner_id / category_id | จากแผน | category_id ว่างสำหรับ CREDIT_PAYMENT ตาม BR §3.2 |
| item_name / description | จากแผน | |
| amount | ? ยอดจ่าย | > 0 |
| plan_id | ? | |
| source | — | MIGRATION |
| external_ref | — | `V1:InstallmentPayments:<key>` |
| note | ? | |

PaymentAllocations: หนึ่งแถวต่อ (ธุรกรรม, งวด); ถ้า V1 ผูกการจ่ายกับงวดเดียว → allocated_amount = amount; ถ้าการจ่ายครั้งเดียวครอบคลุมหลายงวดแต่ไม่ระบุสัดส่วน → Review; ผลรวมต้องไม่เกินยอดธุรกรรมหรือ amount_due

**ข้อควรระวังการนับซ้ำ:** ถ้า V1 บันทึกค่าใช้จ่ายตอนซื้อด้วยบัตรไว้แล้ว ให้สร้าง CREDIT_PURCHASE หนึ่งรายการต่อแผน (amount = total_amount, วันที่ = purchase_date) เฉพาะเมื่อ purchase_date ทราบ; การชำระงวดเป็น CREDIT_PAYMENT ไม่รับรู้รายจ่ายซ้ำ — ต้องยืนยันนโยบายนี้กับผู้ใช้ใน M1

## 5. Review Queue

เขียนใน Migration Report (Spreadsheet แยก) ไม่เขียนลง V2

| คอลัมน์ | ความหมาย |
|---|---|
| review_id | ลำดับ |
| source_sheet / source_row / legacy_key | ตำแหน่งใน V1 |
| issue_code | ดูตารางด้านล่าง |
| detail | คำอธิบาย (ไม่ใส่ข้อมูลการเงินเกินจำเป็น) |
| proposed_action | SKIP / FIX_MAPPING / CONFIRM |
| decision | ผู้ใช้กรอก |

| issue_code | ตัวอย่าง |
|---|---|
| MISSING_DATE | จ่ายแล้วแต่ไม่มีวันที่ |
| INVALID_MONTH | 202613, ข้อความที่แปลงไม่ได้ |
| SUM_MISMATCH | ผลรวมงวด ≠ ยอดรวมแผน |
| COUNT_MISMATCH | "n/m" ไม่ตรงจำนวนแถวงวด |
| ORPHAN | งวด/การจ่ายที่หาแผนไม่พบ |
| UNKNOWN_ACCOUNT / UNKNOWN_OWNER / UNKNOWN_CATEGORY | lookup ไม่พบ |
| DUPLICATE_NAME | ชื่อ Master ซ้ำหรือสะกดต่าง |
| STATUS_ONLY | สถานะบอกว่าจ่าย/เก็บแล้วแต่ไม่มีเหตุการณ์จริง |
| SENSITIVE_DATA | พบเลขบัตรเต็มหรือข้อมูลต้องห้าม |
| AMBIGUOUS_ALLOCATION | การจ่ายครั้งเดียวหลายงวดโดยไม่ระบุสัดส่วน |

## 6. Reconciliation (ต้องผ่านทุกข้อก่อน cut-over)

| ID | ตรวจ |
|---|---|
| RC-01 | จำนวนแผน V2 = จำนวนแถว Installments − รายการที่ SKIP |
| RC-02 | จำนวนงวด V2 = จำนวนแถว InstallmentSchedule − SKIP; ต่อแผน = installment_count |
| RC-03 | SUM(amount_due) ต่อแผน = total_amount (เทียบสตางค์) |
| RC-04 | SUM(amount) ของ Transactions source = MIGRATION = SUM ยอดจ่าย V1 ที่ migrate |
| RC-05 | SUM(allocated_amount) ≤ ยอดธุรกรรม และ ≤ amount_due ทุกงวด |
| RC-06 | payment_status V2 เทียบสถานะ V1: รายการที่ต่างต้องอธิบายได้ทุกรายการ (ส่วนใหญ่มาจาก STATUS_ONLY) |
| RC-07 | ทุก FK มีอยู่จริง; ทุก `*_name` ตรง Master |
| RC-08 | header ทุกชีตตรง database-schema.md §3 |
| RC-09 | ไม่มีเลขบัตรเต็ม/CVV/PIN ในข้อมูล V2 |
| RC-10 | รัน migrate ซ้ำ (idempotent) ไม่เพิ่มแถว |
| RC-11 | ยอดคงเหลือแต่ละบัญชีหลัง migrate ตรงกับที่ผู้ใช้ยืนยัน (หรือบันทึก ADJUSTMENT พร้อมเหตุผล ตามที่ผู้ใช้อนุมัติ) |

## 7. Rollback

- V1 ไม่ถูกแก้ไข → rollback = กลับไปใช้ V1 และทิ้ง/เก็บ staging V2
- ถ้า M7 ล้มเหลวกลางทาง: ใช้ OperationJournal + ID แบบ deterministic replay ซ้ำ หรือสร้าง staging ใหม่จาก initializeDatabase() แล้วรันใหม่ทั้งหมด
- หลัง cut-over: เก็บ V1 แบบอ่านอย่างเดียวอย่างน้อยจนผู้ใช้ยืนยันว่า V2 ถูกต้อง 1 รอบบิล

## 8. MigrationService (สรุปการออกแบบ)

| ฟังก์ชัน | หน้าที่ |
|---|---|
| `profileLegacy(sourceId)` | M2 read-only profiling |
| `buildMigration(sourceId)` | อ่าน V1 แบบ batch, transform เป็นแถว V2 + Review Queue ในหน่วยความจำ |
| `dryRunMigration(sourceId, reportId)` | เรียก build แล้วเขียนเฉพาะ Migration Report |
| `runMigration(sourceId, targetId, decisions)` | เขียน V2 ด้วย batch + LockService + OperationJournal (`MIGRATE`); ต้องระบุ targetId ชัดเจนและปฏิเสธถ้า target = source |
| `reconcileMigration(sourceId, targetId)` | ตรวจ §6 และเขียนผล |

ข้อจำกัด Apps Script 6 นาที/ครั้ง: แบ่งเป็น chunk ตามตาราง และใช้ ID แบบ deterministic เพื่อรันต่อได้

## 9. Test cases (เพิ่มใน test-plan.md)

TC-MG-01 ถึง TC-MG-10 ใน [test-plan.md](test-plan.md) §7.1

## 10. สิ่งที่ต้องการจากผู้ใช้ (M1)

1. ชื่อชีตจริงและ header แถวแรกของ Cards, Installments, InstallmentSchedule, InstallmentPayments และชีตอื่นที่เกี่ยวข้อง (เช่น ตารางเจ้าของ/หมวดหมู่)
2. ตัวอย่างรูปแบบค่าของ: วันที่, เดือนเก็บ/เดือนชำระ, งวด (เช่น "1/6"), สถานะ — ใช้ข้อมูลจำลองได้
3. นโยบาย CREDIT_PURCHASE (§4.5): V1 ถือว่ารายจ่ายเกิดตอนซื้อหรือตอนจ่ายงวด
4. ยอดยกมาของแต่ละบัญชี ณ วันที่ cut-over (หรือยืนยันให้ใช้ 0 แล้วปรับทีหลัง)

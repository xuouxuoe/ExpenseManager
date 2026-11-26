# Development Plan — Expense Manager V2

สถานะ: **Phase 4 และ 5 มีโค้ดและผลทดสอบในเครื่อง** · Phase 3 ผ่านการทดสอบเส้นทางหลักบน `/dev` ด้วยฐาน TEST
ปรับปรุงล่าสุด: 2026-11-26

### งานเพิ่มบัญชีย่อย (อนุมัติ 2026-11-26)

- มีโค้ดข้อมูลหลักบัญชีย่อย การจัดกลุ่มรายการ/แผน มุมมองยอดรวมและแยกกลุ่ม และรายงานสำหรับส่งต่อ PNG/CSV
- ทดสอบในเครื่องด้วยข้อมูลจำลองและผ่าน normal UI สำหรับสร้างบัญชีย่อย บันทึกรายการ สร้างแผน ดาวน์โหลด PNG/CSV แล้ว
- clasp push และ pull กลับมาเทียบครบ 21 ไฟล์แล้ว (2026-11-26) ยังรอตรวจการบันทึกและ schema กับฐาน TEST บน Apps Script /dev

## Phase 0 — เอกสารและการอนุมัติ

- [x] AGENTS.md ปรับ canonical headers และ Data Management Rules
- [x] docs/database-schema.md, business-rules.md, system-architecture.md, development-plan.md, test-plan.md
- [x] จัดทำ docs/migration-plan.md (ร่าง: mapping ตามความหมาย, 2026-11-25)
- [x] ยืนยันว่าไม่มีข้อมูลระบบเดิม — เริ่ม V2 ใหม่ ไม่ต้อง Migration (2026-11-25)
- [x] ผู้ใช้อนุมัติ Final Database Schema (2026-11-25)
- [x] `appsscript.json` timeZone → Asia/Bangkok (2026-11-25; ยังไม่ clasp push)

**Gate:** Phase 0 ครบแล้ว; เริ่ม Phase 1 ได้เมื่อผู้ใช้สั่งเริ่ม Implementation (ต้องมี Spreadsheet ทดสอบแยกจาก Production)

## Phase 1 — Foundation (โค้ดและการตั้งฐานทดสอบเสร็จแล้ว)

- Config.gs (canonical headers ตาม database-schema.md §3), Database.gs, initializeDatabase() แบบ idempotent ไม่ทำลายข้อมูล และตรวจ header ไม่ตรงโดยไม่แก้เอง
- AuthService, ValidationService (YYYYMM, Money, enum, FK, Formula Injection)
- OperationJournal + LockService + idempotency
- ProjectionService (resolveNames, applyProjection, refreshProjections)
- ใช้ Spreadsheet ทดสอบที่แยกจาก Production เท่านั้น
- Spreadsheet ทดสอบ: ผู้ใช้กำหนดแล้ว (2026-11-25) ตั้งเป็น Script Property `TEST_SPREADSHEET_ID`
- Unit tests ในเครื่อง (`npm test`) ผ่าน 44/44 กรณี
- 2026-11-25: clasp push แล้ว; Script Properties ตั้งแล้ว; รัน `initializeDatabase()` บน Production สำเร็จ (สร้าง 11 ชีต, ไม่มีข้อมูลธุรกิจ); รัน `initializeTestDatabase()` สำเร็จ (11 ชีต)
- Production = Google Sheets "ExpenseManager" ที่ผู้ใช้กำหนด (ปัจจุบันว่าง); ตั้ง Script Property `SPREADSHEET_ID` และรัน `initializeDatabase()` บน Production เมื่อผู้ใช้อนุญาตเท่านั้น

## Phase 2 — Master Data (ผ่านการสร้างข้อมูลหลักบน /dev)

- `AccountService.gs` (`MasterData.listAll/create/update/setActive`) และ API `api_listMasters`, `api_createMaster`, `api_updateMaster`, `api_setMasterActive` ใน Code.gs
- หน้าจอ: `Index.html` (shell + nav), `Styles.html`, `Scripts.html` (App.call / submitter / toast / confirm), `PageAccounts.html`
- Dev preview ในเครื่อง: `npm run dev` (`tests/dev-server.js`, ข้อมูลจำลองในหน่วยความจำ)
- ยืนยันการสร้างบัญชี เจ้าของ และหมวดหมู่บน Spreadsheet ทดสอบ รวมการเก็บข้อความที่ขึ้นต้นด้วยเครื่องหมายสูตร ดู [แผนทดสอบ](test-plan.md)

- Accounts, Owners, Categories: เพิ่ม แก้ไข ปิดใช้งาน (is_active)
- เปลี่ยนชื่อ Master → refresh ชื่อใน Transactions/PaymentPlans/PaymentSchedules (RENAME_MASTER)
- ตรวจชื่อซ้ำตาม BR-DM-09

## Phase 3 — Transactions (ผ่านเส้นทางหลักบน /dev)

- `TransactionService.gs`: `Ledger.effectsOf/balances`, `Transactions.create/update/reverse/list/accountBalances`
- API: `api_listTransactions`, `api_createTransaction`, `api_updateTransaction`, `api_reverseTransaction`, `api_accountBalances`
- หน้าจอ `PageTransactions.html` + router (#transactions, #accounts) ใน Scripts.html; หน้าบัญชีแสดงยอดคงเหลือ/หนี้คงค้าง
- ตัวช่วยกรอก (ใช้ประจำ/รายการล่าสุด) จากประวัติจริง — `Transactions.suggestions`
- คิว IndexedDB สำหรับรายการที่รอผล และการอัปเดตหน้าหลังบันทึกในคำขอเดียวมีโค้ดและผลทดสอบแล้ว บันทึกจนเห็นผล 3.97 วินาทีบน `/dev` ในการวัดหนึ่งครั้ง การทดสอบเครือข่ายหลุดและเปิดหน้าใหม่เพื่อกู้คิวบน `/dev` ยังอยู่ในแผนทดสอบ
- งานภายหลัง: การนำเข้า/Export CSV (Phase 5), ปักหมุดแม่แบบเอง (ต้องอนุมัติ schema)

- CRUD ตาม business-rules §3 (from/to account ตามประเภท), กลับรายการแทนการลบ
- Backend เติม from_account_name, to_account_name, owner_name, category_name
- ค้นหา/กรอง/Pagination, ป้องกันรายการซ้ำ

## Phase 4 — Payment Planner

- [x] สร้างแผนรายจ่ายในอนาคตแบบผ่อน รอชำระครั้งเดียว และรายจ่ายประจำแบบกำหนดช่วงเวลา ดูตัวอย่างก่อนยืนยัน ปรับยอดรายงวด และปรับเศษสตางค์งวดสุดท้าย
- [x] เขียน PaymentPlans และ PaymentSchedules ด้วย schema ที่อนุมัติ คัดลอกข้อมูลจากแผนทุกงวดและเริ่มหมายเหตุรายงวดเป็นค่าว่าง กู้คืนการสร้างด้วยรหัสคำขอเดิมเมื่อเขียนค้าง
- [x] แก้รายละเอียดแผนและหมายเหตุรายงวด ต่ออายุรายจ่ายประจำแบบเพิ่มงวดต่อจากงวดเดิม
- [x] กันและปลดเงินหลายบัญชี บันทึกชำระบางส่วนหรือหลายงวด กลับรายการชำระ และยกเลิกภาระโดยเก็บประวัติ
- [x] เชื่อมแผนผ่อนกับรายการซื้อด้วยบัตร (สร้างใหม่หรือเชื่อมรายการเดิม) และชำระงวดเป็นชำระหนี้พร้อมรับรู้ดอกเบี้ย/ค่าธรรมเนียมตามสัดส่วน (2026-11-26, business-rules §4.6; ทดสอบในเครื่อง ยังไม่ทดสอบบน `/dev`)
- [ ] ปรับตารางงวดเดิมและปิดยอดก่อนกำหนดกรณียอดจริงต่างจากแผน
- [~] ทดสอบ Phase 4 บน `/dev` ด้วยฐาน TEST (2026-11-26): สร้างแผน 600 บาท 6 งวด + ตัวอย่างงวด + กันเงิน ผ่าน; ยังไม่ทดสอบ ปลดเงิน ชำระ กลับรายการชำระ ยกเลิก ต่ออายุ บน /dev

## Phase 5 — Dashboard, Reports, Pivot

- [x] ภาพรวมรายรับ รายจ่าย กระแสเงินสด ยอดบัญชีและหนี้ ยอดตามแผนและผลจริง และตัวกรองช่วงเวลา เจ้าของ หมวด และบัญชี
- [x] Export CSV และฟังก์ชัน `refreshTestFinancePivots()` สำหรับสร้าง Pivot_Saving / Pivot_Payment / Pivot_Transactions จาก derived view ในฐาน TEST
- [~] ตรวจหน้าจอภาพรวมบน `/dev` แล้ว (ตัวเลขสอดคล้องกับแผนและการกันเงิน, 2026-11-26); ยังไม่ตรวจ Export CSV, Pivot และปริมาณข้อมูลมาก

## Phase 6 — Reliability

- ทดสอบล้มเหลวกลางทาง/กู้คืน/retry, เขียนพร้อมกัน
- ไม่มี Migration (ไม่มีข้อมูลระบบเดิม); การตั้งยอดยกมาทำผ่าน Accounts.opening_balance

## Phase 7 — Optional AI

- แปลงข้อความ/สลิปเป็น Structured JSON ที่มีเฉพาะ ID → Validation → ผู้ใช้ยืนยัน

## Definition of Done ต่อ Phase

ตาม AGENTS.md §18 และกรณีทดสอบที่เกี่ยวข้องใน [test-plan.md](test-plan.md)

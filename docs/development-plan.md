# Development Plan — Expense Manager V2

สถานะ: **ปิด Phase 5 และ Phase 6 แล้ว (2026-11-26)** · ผ่านชุดทดสอบในเครื่อง 143/143 และผู้ใช้ทดสอบบน `/dev` ด้วยฐาน TEST ผ่าน · ถัดไป Phase 7 (ไม่บังคับ) หรือ Production deployment ซึ่งต้องได้รับอนุญาตแยก
ปรับปรุงล่าสุด: 2026-11-26

### งานรายการประจำเดือน (ผู้ใช้สั่งทำทั้ง 3 ระยะ 2026-11-26)

- [x] ระยะ 1: แท็บ "รายเดือน" ในหน้าแผนชำระ เลือกเดือน โหมดต้องจ่าย/ต้องเก็บ จัดกลุ่มตามบัญชี/บัตร บัญชีย่อย หรือเจ้าของ กรองเจ้าของ ยอดสรุป และงวดค้างจากเดือนก่อน (`PageMonthly.html`)
- [x] ระยะ 2: เลือกหลายรายการ แก้ยอดจ่ายบางส่วน เลือกบัญชีที่จ่าย/กันเงินต่อกลุ่ม หน้ายืนยันแบบเช็กลิสต์โอนเงิน และ `api_monthlyBatch` บันทึกในคำขอเดียวพร้อมคืนรายการแผนล่าสุด
- [x] ระยะ 3: การ์ด "งานแผนชำระเดือนนี้" บนหน้าภาพรวมลิงก์ไปมุมมองรายเดือน และ CSV ของมุมมองรายเดือน
- [x] `tests/monthly.test.js` 9 กรณี และ `npm test` ผ่าน 152/152; ทดสอบหน้าเว็บ local บนเดสก์ท็อปและมือถือ 375px รวมเส้นทาง reply หายแล้วส่งซ้ำด้วย key เดิม
- [ ] clasp push และทดสอบบน `/dev` ด้วยฐาน TEST (ต้องได้รับอนุญาต)
- ไม่เปลี่ยน schema; `api_paymentPlannerPage` อ่านชีต Reservations เพิ่มหนึ่งครั้งเพื่อส่งเงินกันไว้แยกบัญชี (`reserved_accounts`) ของแต่ละงวด

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
- [x] เชื่อมแผนผ่อนกับรายการซื้อด้วยบัตร (สร้างใหม่หรือเชื่อมรายการเดิม) และชำระงวดเป็นชำระหนี้พร้อมรับรู้ดอกเบี้ย/ค่าธรรมเนียมตามสัดส่วน (2026-11-26, business-rules §4.6; ทดสอบในเครื่องและเส้นทางสร้างรายการซื้อใหม่บน `/dev`)
- [x] ปรับยอด เดือนเก็บ เดือนชำระ และวันครบกำหนดของงวดที่ค้าง โดยคงผลรวมเดิม ไม่แก้งวดที่ชำระครบ และปลดเงินกันไว้ส่วนเกิน
- [x] ปิดยอดก่อนกำหนดด้วยเงินต้นคงค้างและดอกเบี้ย/ค่าธรรมเนียมที่ระบุตามยอดจริง มีตัวอย่างก่อนยืนยัน ตรวจข้อมูลเปลี่ยนระหว่างตรวจและบันทึก กู้คำขอเดิม และกลับรายการคืนตาราง/เงินกันไว้ได้
- [x] ทดสอบ logic ในเครื่องรวม 115 กรณี และทดสอบหน้าเว็บ local เส้นทางปรับงวด → ปิดยอด → กลับรายการ รวมตรวจมือถือ 375px (2026-11-26)
- [x] clasp push ไป Apps Script HEAD และ pull กลับมาเทียบ runtime ครบ 22 ไฟล์ตรงกัน (2026-11-26) ไม่มีการสร้างหรืออัปเดต Production Deployment
- [x] ทดสอบ Phase 4 บน `/dev` ด้วยฐาน TEST (2026-11-26): สร้างแผนทั้งสามประเภท กันเงินหลายบัญชี ปลดเงิน ชำระบางส่วน/หลายงวด กลับรายการ ปรับงวด ปิดยอด ยกเลิก ต่ออายุ แก้รายละเอียด/หมายเหตุ และแผนบัตรค่าธรรมเนียมงวดแรก ผ่าน

**สถานะปิดเฟส:** ปิด Phase 4 แล้ว (2026-11-26) ยืนยัน Script Properties `DB_TARGET=TEST` และไฟล์ทดสอบแยกจาก Production ก่อนสร้างชุด `P4-UAT` ทดสอบการอ่านกลับและยอดจริงผ่าน Web App ครบเส้นทางหลัก ดูผลและขอบเขตใน test-plan.md การจำลอง outage และ concurrent writes บน Google จริงเป็นงาน Phase 6

## Phase 5 — Dashboard, Reports, Pivot

- [x] ภาพรวมรายรับ รายจ่าย กระแสเงินสด ยอดบัญชีและหนี้ ยอดตามแผนและผลจริง และตัวกรองช่วงเวลา เจ้าของ หมวด และบัญชี
- [x] Export CSV และฟังก์ชัน `refreshTestFinancePivots()` สำหรับสร้าง Pivot_Saving / Pivot_Payment / Pivot_Transactions จาก derived view ในฐาน TEST
- [x] ตรวจ Dashboard และสร้าง Pivot ทั้งสามบน Google จริงด้วยฐาน TEST (2026-11-26): แผนรวม 1,651.66 บาท, ต้องเก็บเพิ่ม 540 บาท, ค้างชำระ 600 บาท, รายจ่ายจริง 1,051.66 บาท ตรงกับยอดบนเว็บ
- [x] tests/reports.test.js ผ่าน 5 กรณี: ปี/เดือนเก็บและชำระ งวดยกเลิก CSV และ formula injection, refresh Pivot ซ้ำ/ล้างแถวเก่า/ป้องกันเขียนทับชีตอื่น และ 10,000 ธุรกรรม (Dashboard อ่านชีต 9 ครั้ง ไม่เขียนข้อมูล; ไม่ใช่ latency ของ Google)
- [~] สร้างบัญชีย่อย `P5-UAT รายงาน 20261126` ในฐาน TEST และเปิดตัวอย่างภาพบน `/dev` ได้ กดส่งออก CSV/PNG ไม่พบ console error แต่เครื่องมือ browser ไม่ได้รับ download event จึงยังไม่ยืนยันไฟล์ปลายทาง
- [x] ตรวจเนื้อหาไฟล์ทั้ง 5 แบบใน local preview โดยดัก Blob ที่ส่งให้ลิงก์ดาวน์โหลด (2026-11-26): CSV ธุรกรรม/แผนเก็บ/แผนจ่ายมี UTF-8 BOM ชื่อไฟล์ถูกต้อง และกัน formula injection ส่วน PNG มี signature ถูกต้องขนาด 1000×300 ภาพตรงกับตัวอย่างบนหน้าเว็บ CSV บัญชีย่อยมียอดตรงกับธุรกรรม
- [x] แก้รายงานบัญชีย่อย: แท่งยอดติดลบเป็นสีแดงแทนแท่งเต็มสีน้ำเงิน และเมื่อตัวกรองไม่มีบัญชีย่อยจะซ่อนผลเก่าไม่ให้ดาวน์โหลดไฟล์ว่าง
- [x] ผู้ใช้ทดสอบดาวน์โหลด CSV/PNG บน `/dev` ด้วยฐาน TEST หลัง push และรายงานว่าผ่าน (2026-11-26)

**สถานะปิดเฟส:** ปิด Phase 5 แล้ว (2026-11-26)

**ผลตรวจรอบ Phase 5:** `npm test` ขณะนั้นผ่าน 119/120 (`tests/dev-server.test.js`: localhost ถูกปฏิเสธด้วย `EACCES`) ต่อมาในรอบ Phase 6 เทสต์นี้รันผ่านแล้วโดยไม่ skip หรือลดเงื่อนไข การทดสอบข้อมูลมากบน Google จริงยังไม่ได้ทำ

## Phase 6 — Reliability

- [x] เพิ่ม `tests/reliability.test.js` 8 กรณี จำลอง outage ก่อน/หลังทุก setValues ใน 6 เส้นทาง รวม 92 ครั้ง: สร้างรายการ สร้างแผนซื้อด้วยบัตร ชำระบางส่วนจากเงินกันหลายบัญชี กลับรายการ ปิดยอด และเปลี่ยนชื่อ Master
- [x] แก้ OperationService ให้เขียน success Audit ก่อน COMMITTED ใช้ Audit ID คงที่และตรวจประวัติเดิมเมื่อ retry; กู้ Audit ที่หายของ COMMITTED รุ่นเก่าโดยไม่รันธุรกิจซ้ำ รองรับ Audit ID แบบสุ่มเดิม
- [x] แก้ AccountService ให้ checkpoint เหตุการณ์เปลี่ยนชื่อก่อนเขียน Master และสร้าง RENAME_MASTER ครั้งเดียวแม้กู้คืนหลัง Master เปลี่ยนแล้ว
- [x] จำลองสอง execution ใช้ lock ร่วมกัน: ผู้แย่ง lock ได้ BUSY แล้ว retry หลังปลด lock สำเร็จ ไม่สร้างรายการซ้ำ (เป็น synchronous interleaving ใน fake ไม่ใช่คำขอพร้อมกันบน Google)
- [x] `npm test` ผ่าน 128/128 ไม่ skip รวมเทสต์ localhost ที่เคยติด EACCES; ไม่เปลี่ยน schema/authentication ไม่มีการเขียนข้อมูลจริง
- [x] `clasp push --force` (ได้รับอนุญาต 2026-11-26 เพราะ manifest ต่างแค่ CRLF/LF เนื้อหาเหมือนเดิม) และ pull กลับลงโฟลเดอร์ชั่วคราว เทียบตรงกันครบ 22 ไฟล์ ไม่สร้างหรืออัปเดต deployment
- [x] ผู้ใช้ทดสอบบน `/dev` กับฐาน TEST ตามเช็กลิสต์ (2026-11-26) และรายงานว่าผ่าน: สองแท็บบันทึกพร้อมกันได้ทีละรายการ ไม่เกิดรายการซ้ำ รวมเครือข่ายขาด/กลับมาและการยืนยันปิดยอดหลังเปลี่ยนชื่อบัญชี
- [x] ตรวจ outage ต่อเนื่อง (ล้มทุกการเขียนตั้งแต่จุดที่เลือก รวมการบันทึก journal/audit ตอน error) 46 กรณี และล้มเหลวซ้ำระหว่าง retry 227 คู่ ใน 6 เส้นทาง (2026-11-26)
- [x] ตรวจคำขอชนกับงานค้างต่างประเภท: เปลี่ยนชื่อ Master ระหว่างงานค้าง, แก้/กลับรายการธุรกรรมชำระที่เขียนค้าง (ถูกปฏิเสธ) และงานที่ไม่เกี่ยวข้องไม่ถูกบล็อก, กันเงินในแผนที่สร้างค้าง เทสต์พบและแก้ 2 จุด: ธุรกรรมจาก checkpoint ใช้ชื่อ Master เก่า และการเปลี่ยนชื่อทำให้ตัวอย่างปิดยอด/ปรับงวดใช้ไม่ได้
- ไม่มี Migration (ไม่มีข้อมูลระบบเดิม); การตั้งยอดยกมาทำผ่าน Accounts.opening_balance

**สถานะปิดเฟส:** ปิด Phase 6 แล้ว (2026-11-26) โค้ด runtime ที่แก้ (OperationService.gs, AccountService.gs, InstallmentService.gs, PaymentActivity.gs, PlanRevision.gs, PageReports.html) อยู่บน Apps Script HEAD และผ่านการทดสอบบน `/dev` โดยผู้ใช้ ยังไม่ deploy เป็น Production; ผลบน Google เป็นการทดสอบด้วยมือ ไม่ได้วัด latency หรือทดสอบ timeout 6 นาที

## Phase 7 — Optional AI

- แปลงข้อความ/สลิปเป็น Structured JSON ที่มีเฉพาะ ID → Validation → ผู้ใช้ยืนยัน
- Integration API สำหรับ Make / LINE OA / AI (อนุมัติ 2026-11-27; A1 implement ในเครื่องแล้ว ยังไม่ทดสอบบน Apps Script): ดู [integration-api.md](integration-api.md) — ระยะ A1 endpoint + API key, A2 ร่าง/ยืนยันบันทึก, A3 ดูข้อมูล, A4 หน้าเชื่อมต่อภายนอก + คู่มือ API

## Definition of Done ต่อ Phase

ตาม AGENTS.md §18 และกรณีทดสอบที่เกี่ยวข้องใน [test-plan.md](test-plan.md)

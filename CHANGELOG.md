# Changelog

## [Unreleased]

### Added — เชื่อมแผนผ่อนกับบัตรเครดิต (2026-11-26)

- สร้างแผนบนบัตรเครดิต/บัตรกดเงินสด/สินเชื่อพร้อมบันทึกรายการซื้อ (`CREDIT_PURCHASE`) ใหม่ หรือเชื่อมรายการซื้อที่บันทึกไว้แล้ว (`purchase_link`, `purchase_transaction_id`); ตัวอย่างงวดแสดงรายการซื้อที่จะบันทึก
- ชำระงวดของแผนแบบหนี้ (เชื่อมรายการซื้อ หรือบัญชี LOAN) เป็น `CREDIT_PAYMENT` ไม่นับรายจ่ายซ้ำ และรับรู้ดอกเบี้ย/ค่าธรรมเนียมตามสัดส่วนเป็น `INTEREST`/`FEE`; กลับรายการชำระพร้อมกัน
- `api_paymentPlannerPage` ส่งรายการซื้อด้วยบัตรที่ยังไม่เชื่อมแผน; การ์ดแผนแสดงป้ายรายการซื้อ
- ธุรกรรมที่มี plan_id กลับรายการจากหน้ารายการไม่ได้ (ซ่อนปุ่มและตรวจที่ backend)
- เพิ่ม `tests/card-plan.test.js` (5 กรณี รวม 98)
- **เปลี่ยนพฤติกรรม:** แผนบัญชี LOAN ชำระเป็น CREDIT_PAYMENT ตาม business-rules §3.3 (เดิมเป็น EXPENSE) ธุรกรรมเดิมไม่ถูกแก้

### Changed — ปรับหน้าภาพรวมและแผนชำระ (2026-11-26)

- ภาพรวม: ตัวกรองแบบย่อ (เดือน + ตัวกรองเพิ่มเติม), KPI รายรับ/รายจ่าย/สุทธิ, การ์ดแผนชำระและการเก็บเงินพร้อมแถบความคืบหน้า, ยอดบัญชีพร้อมไอคอนและยอดใช้ได้, กราฟรายรับ-รายจ่ายรายเดือน (Chart.js + ตารางสำรองสำหรับ screen reader), รายจ่ายตามหมวดเป็นสัดส่วน, รายการล่าสุดแบบมีเครื่องหมาย, error state พร้อมลองใหม่; โหลดใหม่อัตโนมัติเมื่อเปลี่ยนเดือน/ตัวกรอง
- แผนชำระ: แถบสรุป (แผนที่ดำเนินการ, ค้างทั้งหมด, ต้องชำระถึงเดือนนี้, เงินกันไว้, แจ้งงวดเกินกำหนด), ฟอร์มสร้างแผนแบบพับได้แบ่ง 3 ขั้น + ยอดรวม/งวดแบบสด, ตัวอย่างงวดตรวจผลรวมก่อนยืนยัน, การ์ดแผนพร้อมสถานะ แถบความคืบหน้า งวดถัดไป ปุ่มลัด "กันเงิน"/"บันทึกการชำระ", รายการงวดพร้อม badge สถานะ (คงสถานะเปิด/ปิดหลังทำรายการ), ซ่อนแผนที่จบ/ยกเลิก, dialog จัดการพร้อมคำอธิบายแต่ละการดำเนินการ ปุ่ม "เต็มงวด" และยอดรวมการชำระ
- `Styles.html`: `[hidden]` ชนะ class display ของ Tailwind
- `ReportService`: ส่ง account_id/type/is_active ของบัญชีให้หน้าภาพรวม

### Fixed — เงินกันไว้หลังกลับรายการชำระ (2026-11-26)

- `PaymentActivity.balances` ไม่นับ CONSUME ของธุรกรรมชำระที่ถูกกลับรายการแล้ว: เงินที่เคยกันไว้กลับมาเป็นกันไว้และใช้ชำระใหม่ได้; ภาพรวมแสดงยอดกันไว้/ใช้ได้ถูกต้อง; ปรับ AGENTS §7.3 และ business-rules §4.5

### Performance (2026-11-26)

- `Database`: cache ภายใน execution, อ่านทั้งตารางครั้งเดียวด้วย getDataRange, ตรวจ header ครั้งเดียว, append ไม่อ่านทั้งตาราง, `findRowsByValue` (TextFinder), `writeRowAt`, `lastRowNumber`, `resetExecutionCache`
- `Operation.run`: reset cache หลังได้ lock, ค้น journal ด้วย TextFinder, `ctx.replay`
- `MasterData.update` ไม่ refresh projection เมื่อชื่อไม่เปลี่ยน
- `api_transactionPage`: โหลดหน้ารายการในคำขอเดียว
- การเรียก Sheets: createTransaction 107 → 38, updateMaster 156 → 33; เพิ่ม `tests/performance.test.js` และ `tests/perf-probe.js`

### Added — ตัวช่วยกรอก (2026-11-25)

- `Transactions.suggestions` + `api_transactionSuggestions`: "ใช้ประจำ" และ "รายการล่าสุด" จากประวัติจริง (ไม่เปลี่ยน schema)
- ฟอร์มบันทึกรายการ: แถบแม่แบบแตะเพื่อเติมฟอร์ม และ autocomplete ชื่อรายการ

### Fixed

- หน้าบัญชีโหลดยอดคงเหลือใหม่หลังบันทึกบัญชี
- `appsscript.json` รับค่า `webapp` (executeAs USER_DEPLOYING, access MYSELF) จาก deployment ที่ผู้ใช้สร้าง

- ลิงก์ภายในหน้า (`#transactions`, `#accounts`, `#main`) ใช้ `target="_self"` — แก้หน้าว่างเมื่อกดเมนูบน Apps Script `/dev`; เพิ่ม `tests/html.test.js`

### Added — Phase 3 Transactions (2026-11-25)

- `TransactionService.gs`: กฎบัญชี/หมวดตามประเภท (รวม LOAN), เตือนรายการที่อาจซ้ำ, แก้ไขพร้อมเก็บค่าเดิมใน recovery_data, กลับรายการแทนการลบ, ค้นหา/กรอง/แบ่งหน้า/สรุปรายรับ-จ่าย, ยอดคงเหลือบัญชี (`Ledger`)
- API `api_listTransactions`, `api_createTransaction`, `api_updateTransaction`, `api_reverseTransaction`, `api_accountBalances`
- `PageTransactions.html`: บันทึกด่วน (ชิปประเภท, จำบัญชี/เจ้าของล่าสุด, บันทึกและเพิ่มต่อ), รายการจัดกลุ่มตามวัน, สรุปรายรับ/จ่าย/สุทธิ, ตัวกรองเดือน/ประเภท/บัญชี/ค้นหา, กลับรายการพร้อมเหตุผล
- Router หน้า (#transactions, #accounts); หน้าบัญชีแสดงยอดคงเหลือ/หนี้คงค้าง
- Unit tests เพิ่ม 14 กรณี (รวม 72)

### Changed — Business rules (2026-11-25)

- `CASH_ADVANCE` รับบัญชีต้นทางประเภท `LOAN` ได้ (รับเงินกู้/ยืมเงินบุคคล ไม่ใช่รายรับ); เพิ่ม business-rules §3.3 เงินกู้และการยืมเงินบุคคล และ TC-TX-08..11 — ไม่เปลี่ยน schema

### Added — Phase 2 Master Data UI (2026-11-25)

- `Index.html` (shell, เมนู, toast region, confirm dialog), `Styles.html`, `Scripts.html` (`App.call`, idempotent submitter, `App.el` แบบ textContent, toast, confirm, debounce)
- `PageAccounts.html`: แท็บ บัญชี/เจ้าของ/หมวดหมู่, ค้นหา (debounce), แสดงที่ปิดใช้งาน, ฟอร์มเพิ่ม/แก้ไขใน dialog, ปิด/เปิดใช้งานพร้อม confirm, loading/empty/error state
- `doGet` render template + `include()` แบบ whitelist
- `tests/dev-server.js` + `npm run dev` + `.claude/launch.json` สำหรับ preview ในเครื่องด้วยข้อมูลจำลอง

### Added — Phase 2 Master Data backend (2026-11-25)

- `AccountService.gs` (`MasterData`): สร้าง/แก้ไข/ปิด-เปิดใช้งาน Accounts, Owners, Categories ผ่าน `Operation.run`
- ตรวจชื่อซ้ำ, กฎประเภทบัญชี, ห้ามเลขบัตรเต็ม, ห้ามเปลี่ยนประเภทเมื่อถูกอ้างอิง, ไม่มีการลบจริง
- เปลี่ยนชื่อ Master → refresh projection ทุกตาราง + audit `RENAME_MASTER`
- Client API ใน `Code.gs`: `api_listMasters`, `api_createMaster`, `api_updateMaster`, `api_setMasterActive`
- Unit tests เพิ่ม 13 กรณี (รวม 57)

### Added — Phase 1 Foundation (2026-11-25)

- `Config.gs`: canonical headers 11 ตาราง (ตรง AGENTS.md §7.1), enum, ชนิดคอลัมน์, projection map
- `Util.gs`: AppError, UUID, deterministic UUID สำหรับ replay, timestamp Asia/Bangkok, SHA-256
- `ValidationService.gs`: ตรวจ YYYYMM (ปฏิเสธ 202613), calendar arithmetic, วันครบกำหนดสิ้นเดือน, เงินแบบ integer satang, แบ่งงวดปรับเศษงวดสุดท้าย, ป้องกัน formula injection
- `Database.gs`: batch read/write, ตรวจ header ก่อนอ่าน/เขียน, `initialize()` เรียกซ้ำได้ไม่ทำลายข้อมูล, `appendRowsIfAbsent` สำหรับ replay
- `AuthService.gs`: allowlist `ALLOWED_EMAILS` แบบ fail closed, `requireOwner` สำหรับฟังก์ชันผู้ดูแล
- `OperationService.gs`: LockService + idempotency key + OperationJournal (PENDING/COMMITTED/FAILED/NEEDS_RECOVERY) + AuditLogs
- `ProjectionService.gs`: เติมชื่อจาก Master, คัดลอกข้อมูลแผนไปงวด (ไม่รวม note), `refresh()` แบบ idempotent ไม่เปลี่ยน updated_at
- `Code.gs`: `doGet` (ตรวจสิทธิ์), `checkDatabase`, `initializeDatabase`, `refreshProjections`, `checkTestDatabase`, `initializeTestDatabase`
- `.claspignore`, `package.json` (`npm test`), unit tests 44 กรณีใน `tests/`

### Changed

- `appsscript.json`: timeZone → Asia/Bangkok

### Docs

- เอกสารออกแบบ V2 และ schema ที่อนุมัติแล้ว (2026-11-25); ไม่มี Migration (เริ่มใหม่)

# Changelog

## [Unreleased]

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

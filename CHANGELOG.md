# Changelog

## [Unreleased]

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

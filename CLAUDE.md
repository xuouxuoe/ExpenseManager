# CLAUDE.md

ข้อกำหนดทั้งหมดของโปรเจกต์นี้อยู่ใน [AGENTS.md](AGENTS.md) — อ่านและปฏิบัติตามทุกข้อก่อนเริ่มงาน

@AGENTS.md

สรุปสั้น (รายละเอียดอยู่ใน AGENTS.md):

- ตอบผู้ใช้เป็นภาษาไทยตามรูปแบบ §19
- ทดสอบในเครื่องด้วย `npm test` และ preview ด้วย `npm run dev` (§21)
- ห้าม `git push`, `clasp push`, `clasp deploy` หรือแก้ Production โดยไม่ได้รับอนุญาต (§12, §13)
- ห้ามเขียนข้อมูลทดสอบลง Production; ทดสอบบน `/dev` ด้วย `DB_TARGET=TEST` (§21.2)

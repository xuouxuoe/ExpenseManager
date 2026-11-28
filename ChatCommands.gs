/**
 * ChatCommands.gs — คำสั่งและข้อความที่ใช้ร่วมกันทุกช่องทางแชต (LINE, Telegram)
 *
 * เพิ่ม/แก้คำสั่งที่นี่ที่เดียว แล้วใช้ได้ทั้ง LINE และ Telegram:
 * - READ_COMMANDS: คำที่พิมพ์ → ฟังก์ชันดูข้อมูล (จับคำตรงตัวก่อนเรียก AI ไม่เสียค่า AI และไม่สร้างร่าง; ต้องมีสิทธิ์ READ)
 *   result = รหัสผลที่ log/แสดงในการ์ด "ผลล่าสุด"; help = บรรทัดในข้อความวิธีใช้
 * - HELP_WORDS: คำที่ตอบวิธีใช้
 * Telegram รองรับ /คำสั่ง และ /คำสั่ง@ชื่อบอท โดยอัตโนมัติ (ตัด / และ @ชื่อบอท ก่อนเทียบ)
 * Integration API (JSON action) แยกอยู่ใน IntegrationService.gs
 */
var ChatCommands = (function () {
  var HELP_WORDS = ['help', 'start', 'ช่วยเหลือ', 'วิธีใช้', '?'];

  var READ_COMMANDS = [
    { words: ['สรุป', 'สรุปเดือนนี้', 'summary'], result: 'summary', help: 'สรุป — รายรับรายจ่ายเดือนนี้',
      run: function () { return ApiReads.formatSummary(ApiReads.summaryMonth({})); } },
    { words: ['ยอดเงิน', 'ยอดคงเหลือ', 'คงเหลือ', 'balance', 'balances'], result: 'balances', help: 'ยอดเงิน — ยอดบัญชีและเงินที่ใช้ได้',
      run: function () { return ApiReads.formatBalances(ApiReads.balances()); } },
    { words: ['ล่าสุด', 'รายการล่าสุด', 'recent'], result: 'recent', help: 'ล่าสุด — 5 รายการล่าสุด',
      run: function () { return ApiReads.formatRecent(ApiReads.recentTransactions({})); } },
    { words: ['งบ', 'งบเหลือ', 'งบคงเหลือ', 'budget'], result: 'budget', help: 'งบ — งบใช้จ่ายคงเหลือ',
      run: function () { return ApiReads.formatBudgets(ApiReads.budgetRemaining({})); } },
    { words: ['หนี้', 'หนี้บัตร', 'ยอดหนี้', 'debt', 'debts'], result: 'debts', help: 'หนี้ — ยอดหนี้บัตร วงเงินคงเหลือ และยอดต้องจ่ายเดือนนี้',
      run: function () { return ApiReads.formatDebts(ApiReads.debts()); } }
  ];

  /** ตัดช่องว่าง ตัวพิมพ์ใหญ่ / นำหน้า และ @ชื่อบอท ท้ายคำสั่ง (Telegram) */
  function normalize(body) {
    return String(body || '').trim().toLowerCase().replace(/^\/(\S+?)@\w+$/, '/$1').replace(/^\//, '').replace(/\s+/g, '');
  }

  function isHelp(body) {
    var key = normalize(body);
    return !key || HELP_WORDS.indexOf(key) >= 0;
  }

  function find(body) {
    var key = normalize(body);
    return READ_COMMANDS.filter(function (c) { return c.words.indexOf(key) >= 0; })[0] || null;
  }

  /** รันคำสั่ง (ตรวจสิทธิ์ READ ของการเชื่อมต่อ) → ข้อความตอบกลับ */
  function run(command, client) {
    if (client.scopes.indexOf('READ') < 0) {
      throw Util.AppError('FORBIDDEN_SCOPE', 'การเชื่อมต่อนี้ไม่มีสิทธิ์ดูข้อมูล (READ) ให้ผู้ดูแลเพิ่มสิทธิ์ในหน้าเชื่อมต่อภายนอก');
    }
    return command.run();
  }

  function helpText() {
    return 'พิมพ์รายการที่ต้องการบันทึก เช่น\n• กาแฟ 65\n• ข้าวกลางวัน 120 จ่ายด้วย kbank\n• เงินเดือนเข้า 30000\n• โอนจาก kbank ไป scb 500\n• หรือส่งรูปสลิปโอนเงิน/ใบเสร็จ\n• สร้างแผนชำระ: "ผ่อนทีวี 12000 10 เดือน บัตร KTC"\n\n' +
      'ระบบจะสรุปให้ตรวจก่อน แล้วกด "ยืนยัน" เพื่อบันทึก (หรือยืนยันที่หน้าเว็บ เมนู "รอยืนยัน")\n\n' +
      'ใช้งบทริป: ใส่ชื่องบในข้อความ เช่น "ราเมน 350 งบญี่ปุ่น"\n\n' +
      'คำสั่งดูข้อมูล\n' + READ_COMMANDS.map(function (c) { return '• ' + c.help; }).join('\n');
  }

  /** ข้อผิดพลาด → ข้อความภาษาไทยสำหรับผู้ใช้แชต */
  function errorText(err) {
    var e = Util.toClientError(err);
    if (e.code === 'INTERNAL_ERROR') return 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง';
    if (e.code === 'AI_NOT_CONFIGURED') return 'ระบบยังไม่ได้ตั้งค่า AI กรุณาแจ้งผู้ดูแล';
    if (e.code === 'AI_ERROR' || e.code === 'AI_INVALID_OUTPUT') return 'แปลงข้อความ/รูปไม่สำเร็จ กรุณาลองใหม่อีกครั้ง (รูปสลิปต้องใช้โมเดล AI ที่อ่านภาพได้)';
    var msg = e.message;
    var candidates = e.details && e.details.candidates;
    if (candidates && candidates.length) {
      msg += '\nตัวเลือก: ' + candidates.slice(0, 10).map(function (c) { return c.name; }).join(', ');
    }
    if (e.details && e.details.field === 'category') {
      msg = msg.replace(/category \(([^)]*)\)/, '$1') + '\nพิมพ์รายการพร้อมหมวด เช่น "ร้านอาหาร 1250 หมวดอาหาร"';
    }
    return msg;
  }

  return { isHelp: isHelp, find: find, run: run, helpText: helpText, errorText: errorText, normalize: normalize };
})();

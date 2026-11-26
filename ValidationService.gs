/**
 * ValidationService.gs — ตรวจสอบและแปลงข้อมูลพื้นฐาน
 * ทุกฟังก์ชัน require* โยน AppError code 'VALIDATION_*' เมื่อข้อมูลไม่ถูกต้อง
 */
var Validation = (function () {
  // รหัสหลักเป็น running number ต่อตาราง เริ่มที่ 1 (เก็บเป็นข้อความตัวเลข)
  var ID_RE = /^[1-9][0-9]{0,14}$/;
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var MONEY_RE = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/;
  var FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;
  var CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
  var MAX_SATANG = 100000000000000; // 1 ล้านล้านบาท
  // ปี ค.ศ. ที่ยอมรับ: ตัดปี พ.ศ. (2400 ขึ้นไป) ที่กรอกผิดออก
  var MIN_YEAR = 1900;
  var MAX_YEAR = 2399;

  function fail(code, field, message) {
    return Util.AppError('VALIDATION_' + code, message, { field: field });
  }

  function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }

  // ---------- ข้อความ ----------

  /**
   * ตรวจข้อความ: trim, ความยาว, ห้าม control characters
   * options: { required, max, multiline }
   */
  function requireText(value, field, options) {
    var opts = options || {};
    if (isBlank(value)) {
      if (opts.required) throw fail('REQUIRED', field, 'กรุณากรอก ' + field);
      return '';
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw fail('TYPE', field, field + ' ต้องเป็นข้อความ');
    }
    var text = String(value).replace(/\r\n?/g, '\n').trim();
    if (!opts.multiline && text.indexOf('\n') >= 0) {
      throw fail('FORMAT', field, field + ' ต้องอยู่ในบรรทัดเดียว');
    }
    if (CONTROL_CHARS_RE.test(text)) {
      throw fail('FORMAT', field, field + ' มีอักขระที่ไม่อนุญาต');
    }
    var max = opts.max || Config.TEXT_LIMITS.NOTE;
    if (text.length > max) {
      throw fail('TOO_LONG', field, field + ' ยาวเกิน ' + max + ' ตัวอักษร');
    }
    return text;
  }

  /** ป้องกัน Spreadsheet Formula Injection: ข้อความที่ขึ้นต้นด้วย = + - @ Tab CR ให้เก็บเป็นข้อความ */
  function sanitizeForSheet(text) {
    if (typeof text !== 'string') return text;
    return FORMULA_PREFIX_RE.test(text) ? "'" + text : text;
  }

  /** ค่าที่อ่านกลับจากชีต: ตัด apostrophe ที่เติมโดย sanitizeForSheet ออก */
  function unsanitizeFromSheet(text) {
    if (typeof text !== 'string') return text;
    return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
  }

  // ---------- ID / Enum / Boolean ----------

  function requireId(value, field, options) {
    var opts = options || {};
    if (isBlank(value)) {
      if (opts.required === false) return '';
      throw fail('REQUIRED', field, 'กรุณาระบุ ' + field);
    }
    var id = String(value).trim();
    if (!ID_RE.test(id)) throw fail('FORMAT', field, field + ' ไม่ใช่รหัสที่ถูกต้อง');
    return id;
  }

  function requireEnum(value, allowed, field, options) {
    var opts = options || {};
    if (isBlank(value)) {
      if (opts.required === false) return '';
      throw fail('REQUIRED', field, 'กรุณาระบุ ' + field);
    }
    var v = String(value).trim().toUpperCase();
    if (allowed.indexOf(v) < 0) throw fail('ENUM', field, field + ' ต้องเป็นหนึ่งใน ' + allowed.join(', '));
    return v;
  }

  function requireBoolean(value, field) {
    if (value === true || value === false) return value;
    if (value === 'TRUE' || value === 'true') return true;
    if (value === 'FALSE' || value === 'false') return false;
    throw fail('TYPE', field, field + ' ต้องเป็น TRUE หรือ FALSE');
  }

  // ---------- ตัวเลข ----------

  function requireInt(value, field, options) {
    var opts = options || {};
    if (isBlank(value)) {
      if (opts.required === false) return '';
      throw fail('REQUIRED', field, 'กรุณาระบุ ' + field);
    }
    var s = String(value).trim();
    if (!/^-?\d+$/.test(s)) throw fail('TYPE', field, field + ' ต้องเป็นจำนวนเต็ม');
    var n = Number(s);
    if (!Number.isSafeInteger(n)) throw fail('RANGE', field, field + ' มีค่าไม่ถูกต้อง');
    if (opts.min !== undefined && n < opts.min) throw fail('RANGE', field, field + ' ต้องไม่น้อยกว่า ' + opts.min);
    if (opts.max !== undefined && n > opts.max) throw fail('RANGE', field, field + ' ต้องไม่เกิน ' + opts.max);
    return n;
  }

  /** วันตัดรอบ/ครบกำหนด 1–31 หรือว่าง */
  function requireDay(value, field) {
    return requireInt(value, field, { required: false, min: 1, max: 31 });
  }

  // ---------- เงิน (integer satang) ----------

  /**
   * แปลงจำนวนเงินเป็น integer satang โดยไม่ผ่านการคำนวณ float
   * options: { required (default true), allowZero (default false), allowNegative (default false) }
   */
  function toSatang(value, field, options) {
    var opts = options || {};
    if (isBlank(value)) {
      if (opts.required === false) return null;
      throw fail('REQUIRED', field, 'กรุณากรอก ' + field);
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw fail('TYPE', field, field + ' ต้องเป็นตัวเลข');
    }
    if (typeof value === 'number' && !isFinite(value)) {
      throw fail('TYPE', field, field + ' ต้องเป็นตัวเลข');
    }
    var s = String(value).trim().replace(/,/g, '');
    var m = MONEY_RE.exec(s);
    if (!m) throw fail('MONEY_FORMAT', field, field + ' ต้องเป็นตัวเลขทศนิยมไม่เกิน 2 ตำแหน่ง');
    var frac = (m[3] || '').length === 1 ? m[3] + '0' : (m[3] || '00');
    var satang = Number(m[2]) * 100 + Number(frac);
    if (m[1] === '-') satang = -satang;
    if (!Number.isSafeInteger(satang) || Math.abs(satang) > MAX_SATANG) {
      throw fail('RANGE', field, field + ' มีค่ามากเกินไป');
    }
    if (satang < 0 && !opts.allowNegative) throw fail('RANGE', field, field + ' ต้องไม่ติดลบ');
    if (satang === 0 && !opts.allowZero) throw fail('RANGE', field, field + ' ต้องมากกว่า 0');
    return satang === 0 ? 0 : satang;
  }

  /** integer satang → Number บาท 2 ตำแหน่ง */
  function fromSatang(satang) {
    return Math.round(satang) / 100;
  }

  /** แบ่งยอดเป็นงวด ปรับเศษที่งวดสุดท้าย (หน่วยสตางค์) */
  function splitSatang(totalSatang, count) {
    if (!Number.isSafeInteger(totalSatang) || totalSatang <= 0) throw fail('RANGE', 'total', 'ยอดรวมต้องมากกว่า 0');
    if (!Number.isSafeInteger(count) || count < 1) throw fail('RANGE', 'installment_count', 'จำนวนงวดต้องอย่างน้อย 1');
    var base = Math.floor(totalSatang / count);
    var parts = [];
    for (var i = 0; i < count; i++) parts.push(base);
    parts[count - 1] = totalSatang - base * (count - 1);
    return parts;
  }

  // ---------- วันที่ / ปีเดือน ----------

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  function daysInMonth(year, month) {
    return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** วันที่ธุรกิจ YYYY-MM-DD (ค.ศ.) ที่มีอยู่จริง */
  function requireDate(value, field, options) {
    var opts = options || {};
    if (isBlank(value)) {
      if (opts.required === false) return '';
      throw fail('REQUIRED', field, 'กรุณาระบุ ' + field);
    }
    var s = String(value).trim();
    var m = DATE_RE.exec(s);
    if (!m) throw fail('DATE_FORMAT', field, field + ' ต้องอยู่ในรูปแบบ YYYY-MM-DD');
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (y < MIN_YEAR || y > MAX_YEAR || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      throw fail('DATE_RANGE', field, field + ' ไม่ใช่วันที่ที่มีอยู่จริง (ใช้ปี ค.ศ.)');
    }
    return s;
  }

  /** ปีเดือน Integer YYYYMM เช่น 202611; ปฏิเสธ 202613, 202600, 20261 */
  function requireYearMonth(value, field, options) {
    var opts = options || {};
    if (isBlank(value)) {
      if (opts.required === false) return '';
      throw fail('REQUIRED', field, 'กรุณาระบุ ' + field);
    }
    var s = String(value).trim();
    if (!/^\d{6}$/.test(s)) throw fail('YEAR_MONTH_FORMAT', field, field + ' ต้องเป็นตัวเลข 6 หลักแบบ YYYYMM');
    var ym = Number(s);
    var y = Math.floor(ym / 100);
    var mo = ym % 100;
    if (y < MIN_YEAR || y > MAX_YEAR || mo < 1 || mo > 12) {
      throw fail('YEAR_MONTH_RANGE', field, field + ' มีเดือนไม่ถูกต้อง (ต้องเป็น 01–12, ปี ค.ศ.)');
    }
    return ym;
  }

  /** บวก/ลบเดือนด้วย calendar arithmetic: addMonths(202612, 1) = 202701 */
  function addMonths(yearMonth, months) {
    var ym = requireYearMonth(yearMonth, 'year_month');
    if (!Number.isSafeInteger(months)) throw fail('TYPE', 'months', 'จำนวนเดือนต้องเป็นจำนวนเต็ม');
    var index = Math.floor(ym / 100) * 12 + (ym % 100 - 1) + months;
    var y = Math.floor(index / 12);
    var mo = index - y * 12 + 1;
    return requireYearMonth(y * 100 + mo, 'year_month');
  }

  function yearOf(yearMonth) {
    return Math.floor(yearMonth / 100);
  }

  function monthOf(yearMonth) {
    return yearMonth % 100;
  }

  /** วันครบกำหนดจากปีเดือนและวัน; วันเกินสิ้นเดือนใช้วันสุดท้าย; ไม่ทราบวันให้ว่าง */
  function dueDateOf(yearMonth, dueDay) {
    if (isBlank(dueDay)) return '';
    var ym = requireYearMonth(yearMonth, 'payment_month');
    var day = requireDay(dueDay, 'due_day');
    var y = yearOf(ym);
    var mo = monthOf(ym);
    var d = Math.min(day, daysInMonth(y, mo));
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  return {
    isBlank: isBlank,
    requireText: requireText,
    sanitizeForSheet: sanitizeForSheet,
    unsanitizeFromSheet: unsanitizeFromSheet,
    requireId: requireId,
    requireEnum: requireEnum,
    requireBoolean: requireBoolean,
    requireInt: requireInt,
    requireDay: requireDay,
    toSatang: toSatang,
    fromSatang: fromSatang,
    splitSatang: splitSatang,
    daysInMonth: daysInMonth,
    requireDate: requireDate,
    requireYearMonth: requireYearMonth,
    addMonths: addMonths,
    yearOf: yearOf,
    monthOf: monthOf,
    dueDateOf: dueDateOf
  };
})();

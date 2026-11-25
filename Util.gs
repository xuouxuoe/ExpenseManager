/**
 * Util.gs — ฟังก์ชันช่วยทั่วไป (ID, เวลา, hash, error)
 * ห้ามอ้างถึงไฟล์อื่นที่ top level เพื่อไม่ขึ้นกับลำดับโหลดไฟล์ของ Apps Script
 */
var Util = (function () {
  /**
   * Error ของแอป มี code สำหรับแยกประเภท และ message ภาษาไทยที่แสดงผู้ใช้ได้
   * details ห้ามมีข้อมูลการเงินหรือ recovery_data
   */
  function AppError(code, message, details) {
    var err = new Error(message);
    err.name = 'AppError';
    err.code = code;
    err.details = details || null;
    return err;
  }

  function isAppError(err) {
    return !!err && err.name === 'AppError' && typeof err.code === 'string';
  }

  /** แปลง error เป็นรูปแบบที่ส่งให้ client ได้ (ไม่มี stack / ข้อมูลภายใน) */
  function toClientError(err) {
    if (isAppError(err)) {
      return { ok: false, code: err.code, message: err.message, details: err.details };
    }
    return { ok: false, code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง', details: null };
  }

  function uuid() {
    return Utilities.getUuid();
  }

  /** Timestamp ISO 8601 พร้อม timezone Asia/Bangkok เช่น 2026-11-25T22:30:00+07:00 */
  function nowIso(date) {
    return Utilities.formatDate(date || new Date(), Config.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }

  /** วันที่ธุรกิจ YYYY-MM-DD ตามเวลา Asia/Bangkok */
  function todayIso(date) {
    return Utilities.formatDate(date || new Date(), Config.TIMEZONE, 'yyyy-MM-dd');
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
  }

  function sha256Hex(text) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
    return bytesToHex(bytes);
  }

  /** JSON ที่เรียง key คงที่ เพื่อให้ hash ของ payload เดียวกันได้ค่าเดิมเสมอ */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value === undefined ? null : value);
    }
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(value[k]); }).join(',') + '}';
  }

  /**
   * UUID แบบกำหนดได้ล่วงหน้าจาก namespace + name (SHA-256, รูปแบบ UUID version 5 bits)
   * ใช้สร้าง ID ที่ replay แล้วได้ค่าเดิม เพื่อไม่สร้างแถวซ้ำ
   */
  function deterministicUuid(namespace, name) {
    var hex = sha256Hex(String(namespace) + '\u0000' + String(name)).slice(0, 32).split('');
    hex[12] = '5';
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    var h = hex.join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
  }

  return {
    AppError: AppError,
    isAppError: isAppError,
    toClientError: toClientError,
    uuid: uuid,
    nowIso: nowIso,
    todayIso: todayIso,
    sha256Hex: sha256Hex,
    stableStringify: stableStringify,
    deterministicUuid: deterministicUuid
  };
})();

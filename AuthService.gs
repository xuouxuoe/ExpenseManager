/**
 * AuthService.gs — ตรวจสอบผู้ใช้ที่ Backend (fail closed)
 * รายชื่อผู้มีสิทธิ์เก็บใน Script Property ALLOWED_EMAILS (คั่นด้วยจุลภาค)
 */
var Auth = (function () {
  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function getActiveEmail() {
    return normalizeEmail(Session.getActiveUser().getEmail());
  }

  function getAllowedEmails() {
    var raw = PropertiesService.getScriptProperties().getProperty(Config.PROPERTY_KEYS.ALLOWED_EMAILS) || '';
    return raw.split(',').map(normalizeEmail).filter(function (e) { return e !== ''; });
  }

  /**
   * ใช้กับทุกคำขอจาก Web App
   * ปฏิเสธเมื่อระบุตัวผู้ใช้ไม่ได้ หรือไม่อยู่ใน ALLOWED_EMAILS หรือยังไม่ได้ตั้ง ALLOWED_EMAILS
   */
  function requireAuthorizedUser() {
    var email = getActiveEmail();
    if (!email) {
      throw Util.AppError('AUTH_REQUIRED', 'ไม่สามารถระบุบัญชี Google ของผู้ใช้ได้ กรุณาเข้าสู่ระบบ');
    }
    var allowed = getAllowedEmails();
    if (!allowed.length || allowed.indexOf(email) < 0) {
      throw Util.AppError('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์ใช้งานระบบ');
    }
    return { actorId: email };
  }

  /** ใช้กับฟังก์ชันผู้ดูแลที่รันจาก Apps Script editor เท่านั้น (เช่น initializeDatabase) */
  function requireOwner() {
    var active = getActiveEmail();
    var effective = normalizeEmail(Session.getEffectiveUser().getEmail());
    if (!active || active !== effective) {
      throw Util.AppError('FORBIDDEN', 'ฟังก์ชันนี้ใช้ได้เฉพาะเจ้าของสคริปต์จาก Apps Script editor');
    }
    return { actorId: active };
  }

  return {
    getActiveEmail: getActiveEmail,
    requireAuthorizedUser: requireAuthorizedUser,
    requireOwner: requireOwner
  };
})();

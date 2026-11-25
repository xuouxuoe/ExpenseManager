/**
 * Code.gs — จุดเข้าใช้งาน Web App และฟังก์ชันผู้ดูแล
 *
 * ฟังก์ชันผู้ดูแล (รันจาก Apps Script editor โดยเจ้าของสคริปต์เท่านั้น):
 *   checkDatabase()            ตรวจ schema ของ Production (read-only)
 *   initializeDatabase()       สร้างชีต/header ที่ขาดใน Production (ไม่ลบหรือเขียนทับข้อมูล)
 *   refreshProjections()       ซ่อมคอลัมน์ *_name ใน Production ให้ตรง Master Data
 *   checkTestDatabase() / initializeTestDatabase()  ทำแบบเดียวกันกับ TEST_SPREADSHEET_ID
 *
 * Web App / api_* ใช้ไฟล์ตาม Script Property DB_TARGET: 'TEST' = TEST_SPREADSHEET_ID, 'PRODUCTION' หรือว่าง = SPREADSHEET_ID (ค่าอื่นถูกปฏิเสธ)
 */

function doGet() {
  try {
    Auth.requireAuthorizedUser();
  } catch (err) {
    return HtmlService.createHtmlOutput('<p>' + Util.toClientError(err).message + '</p>').setTitle(Config.APP_NAME);
  }
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(Config.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** ใช้ใน template เท่านั้น: รวมไฟล์ HTML ที่อนุญาต */
var INCLUDABLE_FILES_ = ['Styles', 'Scripts', 'PageAccounts'];

function include(name) {
  if (INCLUDABLE_FILES_.indexOf(name) < 0) throw new Error('include: ไม่อนุญาตไฟล์ ' + name);
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---------- Client API (google.script.run) ----------
// ทุกฟังก์ชันตรวจสิทธิ์ที่ Backend และคืน { ok: true, data } หรือ { ok: false, code, message }
// ไม่ส่ง stack trace หรือ recovery_data ให้ client

function handleApi_(fn) {
  try {
    var actor = Auth.requireAuthorizedUser();
    return { ok: true, data: fn(actor) };
  } catch (err) {
    var clientError = Util.toClientError(err);
    if (clientError.code === 'INTERNAL_ERROR') Logger.log('INTERNAL_ERROR: ' + (err && err.message));
    return clientError;
  }
}

function api_listMasters(options) {
  return handleApi_(function () {
    return MasterData.listAll({ includeInactive: !!(options && options.includeInactive) });
  });
}

/** type: 'account' | 'owner' | 'category' */
function api_createMaster(type, input, idempotencyKey) {
  return handleApi_(function (actor) {
    return MasterData.create(type, input, { idempotencyKey: idempotencyKey, actor: actor });
  });
}

function api_updateMaster(type, id, input, idempotencyKey) {
  return handleApi_(function (actor) {
    return MasterData.update(type, id, input, { idempotencyKey: idempotencyKey, actor: actor });
  });
}

function api_setMasterActive(type, id, isActive, idempotencyKey) {
  return handleApi_(function (actor) {
    return MasterData.setActive(type, id, isActive, { idempotencyKey: idempotencyKey, actor: actor });
  });
}

// ---------- ฟังก์ชันผู้ดูแล ----------

/** บันทึก audit ของงานผู้ดูแล โดยไม่ทำให้งานหลักล้มเหลวหาก AuditLogs ยังไม่พร้อม */
function tryAudit_(actorId, action) {
  try {
    Audit.log({ actorId: actorId, action: action, entityType: 'Spreadsheet', result: 'SUCCESS' });
  } catch (err) {
    Logger.log('AUDIT_SKIPPED: ' + Util.toClientError(err).code);
  }
}

function logReport_(title, report) {
  Logger.log(title + '\n' + JSON.stringify(report, null, 2));
  return report;
}

function checkDatabase() {
  Auth.requireOwner();
  Database.useProductionSpreadsheet();
  return logReport_('checkDatabase (PRODUCTION)', Database.checkSchema());
}

function initializeDatabase() {
  var actor = Auth.requireOwner();
  Database.useProductionSpreadsheet();
  var report = Database.initialize();
  tryAudit_(actor.actorId, 'INITIALIZE_DATABASE');
  return logReport_('initializeDatabase (PRODUCTION)', report);
}

function refreshProjections() {
  var actor = Auth.requireOwner();
  Database.useProductionSpreadsheet();
  var report = Database.checkSchema().every(function (r) { return r.status === 'OK'; })
    ? Projection.refresh({ dryRun: false })
    : { error: 'SCHEMA_NOT_READY' };
  if (!report.error) {
    tryAudit_(actor.actorId, 'REFRESH_PROJECTION');
  }
  return logReport_('refreshProjections (PRODUCTION)', report);
}

function checkTestDatabase() {
  Auth.requireOwner();
  Database.useTestSpreadsheet();
  return logReport_('checkDatabase (TEST)', Database.checkSchema());
}

function initializeTestDatabase() {
  var actor = Auth.requireOwner();
  Database.useTestSpreadsheet();
  var report = Database.initialize();
  tryAudit_(actor.actorId, 'INITIALIZE_DATABASE');
  return logReport_('initializeDatabase (TEST)', report);
}

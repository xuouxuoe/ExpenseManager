/**
 * Code.gs — จุดเข้าใช้งาน Web App และฟังก์ชันผู้ดูแล
 *
 * ฟังก์ชันผู้ดูแล (รันจาก Apps Script editor โดยเจ้าของสคริปต์เท่านั้น):
 *   checkDatabase()            ตรวจ schema ของ Production (read-only)
 *   initializeDatabase()       สร้างชีต/header ที่ขาดใน Production (ไม่ลบหรือเขียนทับข้อมูล)
 *   refreshProjections()       ซ่อมคอลัมน์ *_name ใน Production ให้ตรง Master Data
 *   checkTestDatabase() / initializeTestDatabase()  ทำแบบเดียวกันกับ TEST_SPREADSHEET_ID
 */

function doGet() {
  try {
    Auth.requireAuthorizedUser();
  } catch (err) {
    return HtmlService.createHtmlOutput('<p>' + Util.toClientError(err).message + '</p>').setTitle(Config.APP_NAME);
  }
  return HtmlService.createHtmlOutput('<p>Expense Manager V2 — อยู่ระหว่างพัฒนา (Phase 1)</p>').setTitle(Config.APP_NAME);
}

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
  return logReport_('checkDatabase (PRODUCTION)', Database.checkSchema());
}

function initializeDatabase() {
  var actor = Auth.requireOwner();
  var report = Database.initialize();
  tryAudit_(actor.actorId, 'INITIALIZE_DATABASE');
  return logReport_('initializeDatabase (PRODUCTION)', report);
}

function refreshProjections() {
  var actor = Auth.requireOwner();
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

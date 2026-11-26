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
var INCLUDABLE_FILES_ = ['Styles', 'Scripts', 'PageAccounts', 'PageTransactions', 'PageInstallments', 'PageReports'];

function include(name) {
  if (INCLUDABLE_FILES_.indexOf(name) < 0) throw new Error('include: ไม่อนุญาตไฟล์ ' + name);
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---------- Client API (google.script.run) ----------
// ทุกฟังก์ชันตรวจสิทธิ์ที่ Backend และคืน { ok: true, data } หรือ { ok: false, code, message }
// ไม่ส่ง stack trace หรือ recovery_data ให้ client

function handleApi_(fn) {
  try {
    Database.resetExecutionCache();
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

/** filters: { date_from, date_to, transaction_type, account_id, owner_id, category_id, q, page, page_size } */
function api_listTransactions(filters) {
  return handleApi_(function () {
    return Transactions.list(filters);
  });
}

/** input.allow_duplicate = true เมื่อผู้ใช้ยืนยันบันทึกแม้อาจซ้ำ */
function api_createTransaction(input, idempotencyKey, filters, queueScope) {
  return handleApi_(function (actor) {
    if (filters && queueScope !== transactionQueueScope_(actor)) {
      throw Util.AppError('QUEUE_CONTEXT_CHANGED', 'บัญชีหรือไฟล์ข้อมูลเปลี่ยนไป กรุณาเปิดหน้าใหม่ด้วยบัญชีเดิม');
    }
    var row = Transactions.create(input, { idempotencyKey: idempotencyKey, actor: actor });
    return transactionWriteResult_(row, filters);
  });
}

function api_updateTransaction(id, input, idempotencyKey, filters) {
  return handleApi_(function (actor) {
    var row = Transactions.update(id, input, { idempotencyKey: idempotencyKey, actor: actor });
    return transactionWriteResult_(row, filters);
  });
}

/** input: { reason, transaction_date } */
function api_reverseTransaction(id, input, idempotencyKey, filters) {
  return handleApi_(function (actor) {
    var row = Transactions.reverse(id, input, { idempotencyKey: idempotencyKey, actor: actor });
    return transactionWriteResult_(row, filters);
  });
}

function transactionPage_(filters) {
  return { list: Transactions.list(filters), suggestions: Transactions.suggestions({ limit: 8 }) };
}

/** เมื่อเขียนสำเร็จแล้ว ผลอ่านหน้าที่มีปัญหาไม่เปลี่ยนสถานะการบันทึก */
function transactionWriteResult_(row, filters) {
  if (!filters) return row;
  try {
    return { row: row, page: transactionPage_(filters) };
  } catch (err) {
    Logger.log('TRANSACTION_PAGE_AFTER_WRITE: ' + Util.toClientError(err).code);
    return { row: row, page: null };
  }
}

function transactionQueueScope_(actor) {
  var target = Database.currentTarget();
  var property = target === 'TEST' ? Config.PROPERTY_KEYS.TEST_SPREADSHEET_ID : Config.PROPERTY_KEYS.SPREADSHEET_ID;
  var fileId = PropertiesService.getScriptProperties().getProperty(property) || '';
  return Util.sha256Hex(JSON.stringify([actor.actorId, target, fileId]));
}

/**
 * โหลดหน้ารายการในคำขอเดียว (ลด round trip): { list, suggestions, masters? }
 * options.includeMasters = true เมื่อเปิดหน้าครั้งแรก
 */
function api_transactionPage(filters, options) {
  return handleApi_(function (actor) {
    var out = transactionPage_(filters);
    if (options && options.includeMasters) {
      out.masters = MasterData.listAll({ includeInactive: true });
      out.queueScope = transactionQueueScope_(actor);
    }
    return out;
  });
}

/** ตัวช่วยกรอก: { recent: [], frequent: [] } จากประวัติรายการ */
function api_transactionSuggestions(options) {
  return handleApi_(function () {
    return Transactions.suggestions({ limit: options && options.limit, lookback_days: options && options.lookback_days });
  });
}

function api_accountBalances() {
  return handleApi_(function () {
    return Transactions.accountBalances();
  });
}

function api_paymentPlannerPage() {
  return handleApi_(function () {
    return { plans: PaymentPlanner.list(), masters: MasterData.listAll({ includeInactive: true }) };
  });
}

function api_previewPaymentPlan(input) {
  return handleApi_(function () { return PaymentPlanner.preview(input); });
}

function api_createPaymentPlan(input, idempotencyKey) {
  return handleApi_(function (actor) {
    return PaymentPlanner.create(input, { idempotencyKey: idempotencyKey, actor: actor });
  });
}

function api_paymentActivity(input, idempotencyKey) {
  return handleApi_(function (actor) {
    return PaymentActivity.change(input, { idempotencyKey: idempotencyKey, actor: actor });
  });
}

function api_dashboard(filters) {
  return handleApi_(function () { return FinanceReports.dashboard(filters); });
}

function api_exportFinanceReport(kind, filters) {
  return handleApi_(function () { return FinanceReports.exportCsv(kind, filters); });
}

/** สร้างหรือปรับ Pivot เฉพาะใน Spreadsheet ทดสอบ จาก Apps Script editor */
function refreshTestFinancePivots() {
  Auth.requireOwner();
  Database.useTestSpreadsheet();
  return logReport_('refreshTestFinancePivots (TEST)', FinanceReports.refreshPivots());
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

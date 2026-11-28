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
var INCLUDABLE_FILES_ = ['Styles', 'Scripts', 'PageAccounts', 'PageBudgets', 'PageTransactions', 'PageInstallments', 'PageMonthly', 'PageReports', 'PageIntegrations', 'PageApiGuide', 'PageApprovals', 'PageConnectGuide'];

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
    if (clientError.code === 'INTERNAL_ERROR') console.log('INTERNAL_ERROR: ' + (err && err.message));
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

/** filters: { date_from, date_to, transaction_type, account_id, owner_id, category_id, budget_id, q, sort (DATE|CREATED), page, page_size } */
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
  return { list: Transactions.list(filters), suggestions: Transactions.suggestions({ limit: 8 }), accounts: Transactions.accountSummary(),
    budgets: Budgets.list(Number(Util.todayIso().slice(0, 7).replace('-', ''))),
    // งบทริปที่เลือก "ใช้จากงบ" ได้ (อ่าน Budgets/Accounts/Transactions จาก cache ของคำขอเดียวกัน)
    event_budgets: Budgets.eventOptions() };
}

/** เมื่อเขียนสำเร็จแล้ว ผลอ่านหน้าที่มีปัญหาไม่เปลี่ยนสถานะการบันทึก */
function transactionWriteResult_(row, filters) {
  if (!filters) return row;
  try {
    return { row: row, page: transactionPage_(filters) };
  } catch (err) {
    console.log('TRANSACTION_PAGE_AFTER_WRITE: ' + Util.toClientError(err).code);
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
  return handleApi_(function (actor) {
    var purchases = PaymentPlanner.purchaseCandidates().slice(0, 100).map(function (r) {
      return { transaction_id: r.transaction_id, transaction_date: r.transaction_date, from_account_id: r.from_account_id,
        from_sub_account_id: r.from_sub_account_id, owner_id: r.owner_id, category_id: r.category_id, item_name: r.item_name, description: r.description, amount: r.amount };
    });
    return { plans: PaymentPlanner.list(actor), masters: MasterData.listAll({ includeInactive: true }), purchases: purchases };
  });
}

function api_setPlanFavorite(planId, favorite, idempotencyKey) {
  return handleApi_(function (actor) {
    return PaymentPlanner.setFavorite(planId, favorite, { actor: actor, idempotencyKey: idempotencyKey });
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

/** กันเงินหรือชำระหลายงวดข้ามแผนในคำขอเดียว แล้วคืนรายการแผนล่าสุดเพื่อไม่ต้องโหลดหน้าใหม่ */
function api_monthlyBatch(input, idempotencyKey) {
  return handleApi_(function (actor) {
    var result = PaymentActivity.monthBatch(input, { idempotencyKey: idempotencyKey, actor: actor });
    return { result: result, plans: PaymentPlanner.list(actor) };
  });
}

/** ย้ายเงินกันไว้ระหว่างบัญชี (ปลด + กันใหม่ + โอนจริงถ้าเลือก) ในคำขอเดียว แล้วคืนรายการแผนล่าสุด */
function api_moveReserve(input, idempotencyKey) {
  return handleApi_(function (actor) {
    var result = PaymentActivity.moveReserve(input, { idempotencyKey: idempotencyKey, actor: actor });
    return { result: result, plans: PaymentPlanner.list(actor) };
  });
}

function api_previewPaymentActivity(input) {
  return handleApi_(function () { return PaymentActivity.preview(input); });
}

function api_dashboard(filters) {
  return handleApi_(function () {
    var out = FinanceReports.dashboard(filters);
    // งบใช้จ่ายของเดือนปัจจุบันเสมอ (การ์ด "งบใช้จ่ายเดือนนี้")
    out.budgets = Budgets.list(Number(Util.todayIso().slice(0, 7).replace('-', '')));
    // งบทริปที่ยังไม่จบ (การ์ดงบในหน้าภาพรวม)
    out.event_budgets = Budgets.eventOptions().filter(function (b) { return b.phase !== 'ENDED'; });
    return out;
  });
}

// ---------- งบใช้จ่าย ----------

function budgetPage_(month) {
  return { month: Number(month), budgets: Budgets.list(month), events: Budgets.listEvents({ includeInactive: true }) };
}

function api_budgetPage(month) {
  return handleApi_(function () {
    var out = budgetPage_(month);
    out.masters = MasterData.listAll({ includeInactive: true });
    out.accounts = Transactions.accountSummary(); // เงินที่ใช้ได้ของแต่ละบัญชีสำหรับกันเงินงบทริป
    return out;
  });
}

function api_saveBudget(input, idempotencyKey) {
  return handleApi_(function (actor) {
    var result = Budgets.save(input, { idempotencyKey: idempotencyKey, actor: actor });
    return { result: result, page: budgetPage_(input && input.budget_month) };
  });
}

/** งบทริป/โครงการ (EVENT): input { budget_id?, budget_name, owner_id, amount, start_date, end_date, note } */
function api_saveEventBudget(input, idempotencyKey, month) {
  return handleApi_(function (actor) {
    var result = Budgets.saveEvent(input, { idempotencyKey: idempotencyKey, actor: actor });
    return { result: result, page: budgetPage_(month || Number(Util.todayIso().slice(0, 7).replace('-', ''))) };
  });
}

/** กัน/ปลดเงินให้งบทริป (E3): input { budget_id, action, account_id, amount, reservation_date, note } */
function api_budgetReservation(input, idempotencyKey, month) {
  return handleApi_(function (actor) {
    var result = Budgets.reserveEvent(input, { idempotencyKey: idempotencyKey, actor: actor });
    var page = budgetPage_(month || Number(Util.todayIso().slice(0, 7).replace('-', '')));
    page.accounts = Transactions.accountSummary();
    return { result: result, page: page };
  });
}

function api_setBudgetActive(budgetId, active, idempotencyKey, month) {
  return handleApi_(function (actor) {
    var result = Budgets.setActive(budgetId, active, { idempotencyKey: idempotencyKey, actor: actor });
    return { result: result, page: budgetPage_(month) };
  });
}

function api_copyBudgets(fromMonth, toMonth, idempotencyKey) {
  return handleApi_(function (actor) {
    var result = Budgets.copyMonth(fromMonth, toMonth, { idempotencyKey: idempotencyKey, actor: actor });
    return { result: result, page: budgetPage_(toMonth) };
  });
}

// ---------- Integration API (Make / LINE OA) ----------
// docs/integration-api.md — doPost ใช้กับ deployment แบบไม่ต้องล็อกอิน ตรวจสิทธิ์ด้วย API key ใน body

function doPost(e) {
  return IntegrationApi.handlePost(e);
}

function api_listApiClients() {
  return handleApi_(function () { return ApiClients.list(); });
}

/** input.api_key สร้างฝั่งเบราว์เซอร์และแสดงผู้ใช้ครั้งเดียว Backend เก็บเฉพาะ hash */
function api_createApiClient(input, idempotencyKey) {
  return handleApi_(function (actor) {
    var client = ApiClients.create(input, { idempotencyKey: idempotencyKey, actor: actor });
    return { client: client, clients: ApiClients.list() };
  });
}

function api_updateApiClient(clientId, input, idempotencyKey) {
  return handleApi_(function (actor) {
    var client = ApiClients.update(clientId, input, { idempotencyKey: idempotencyKey, actor: actor });
    return { client: client, clients: ApiClients.list() };
  });
}

function api_setApiClientActive(clientId, active, idempotencyKey) {
  return handleApi_(function (actor) {
    var client = ApiClients.setActive(clientId, active, { idempotencyKey: idempotencyKey, actor: actor });
    return { client: client, clients: ApiClients.list() };
  });
}

function api_rotateApiClientKey(clientId, apiKey, idempotencyKey) {
  return handleApi_(function (actor) {
    var client = ApiClients.rotateKey(clientId, apiKey, { idempotencyKey: idempotencyKey, actor: actor });
    return { client: client, clients: ApiClients.list() };
  });
}

/** หน้า "รอยืนยัน": ร่างจาก LINE / Telegram / API ที่รอผู้ใช้ยืนยัน */
function api_listApiDrafts() {
  return handleApi_(function () { return ApiDrafts.listForWeb(); });
}

function api_approveApiDraft(draftId) {
  return handleApi_(function (actor) {
    var draft = ApiDrafts.approveFromWeb(draftId, { actor: actor });
    return { draft: draft, drafts: ApiDrafts.listForWeb() };
  });
}

function api_cancelApiDraft(draftId) {
  return handleApi_(function (actor) {
    var draft = ApiDrafts.cancelFromWeb(draftId, { actor: actor });
    return { draft: draft, drafts: ApiDrafts.listForWeb() };
  });
}

function api_getAiSettings() {
  return handleApi_(function (actor) { return AiSettings.view(actor); });
}

/** input.api_key ว่าง = ใช้ key เดิม; ไม่มีการคืนค่า key ให้เบราว์เซอร์ */
function api_saveAiSettings(input, idempotencyKey) {
  return handleApi_(function (actor) { return AiSettings.save(input, { idempotencyKey: idempotencyKey, actor: actor }); });
}

function api_getLineSettings() {
  return handleApi_(function (actor) { return LineSettings.view(actor); });
}

/** เฉพาะเจ้าของ; token ไม่ถูกส่งกลับให้เบราว์เซอร์ */
function api_saveLineSettings(input, idempotencyKey) {
  return handleApi_(function (actor) { return LineSettings.save(input, { idempotencyKey: idempotencyKey, actor: actor }); });
}

function api_getTelegramSettings() {
  return handleApi_(function (actor) { return TelegramSettings.view(actor); });
}

/** เฉพาะเจ้าของ; bot token ไม่ถูกส่งกลับให้เบราว์เซอร์ */
function api_saveTelegramSettings(input, idempotencyKey) {
  return handleApi_(function (actor) { return TelegramSettings.save(input, { idempotencyKey: idempotencyKey, actor: actor }); });
}

/** เฉพาะเจ้าของ; input.webhook_url มี API key — ใช้เรียก setWebhook แล้วทิ้ง ไม่เก็บ */
function api_setTelegramWebhook(input) {
  return handleApi_(function (actor) { return TelegramSettings.setWebhook(input, actor); });
}

function api_telegramWebhookInfo() {
  return handleApi_(function (actor) { return TelegramSettings.webhookInfo(actor); });
}

/** AI แบบเข้าสู่ระบบด้วยบัญชี ChatGPT (device code แบบ Codex) — เฉพาะเจ้าของ; ไม่มี token กลับไปที่เบราว์เซอร์ */
function api_chatgptStartLogin() {
  return handleApi_(function (actor) { return ChatGptAuth.startLogin(actor); });
}

function api_chatgptPollLogin() {
  return handleApi_(function (actor) { return ChatGptAuth.pollLogin(actor); });
}

function api_chatgptLogout() {
  return handleApi_(function (actor) { return ChatGptAuth.logout(actor); });
}

function api_testAiSettings() {
  return handleApi_(function (actor) { return AiSettings.test(actor); });
}

function api_exportFinanceReport(kind, filters) {
  return handleApi_(function () { return FinanceReports.exportCsv(kind, filters); });
}

function api_sharedAccountReport(filters) {
  return handleApi_(function () { return FinanceReports.sharedReport(filters); });
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

/** ตรวจว่าไฟล์ทดสอบมีรหัส UUID เดิมเท่าไร และจะเปลี่ยนแถวใดบ้าง (ไม่เขียนข้อมูล) */
function migrateTestIdsDryRun() {
  Auth.requireOwner();
  Database.useTestSpreadsheet();
  return logReport_('migrateTestIdsDryRun (TEST)', IdMigration.run({ dryRun: true }));
}

/** แปลงรหัส UUID เดิมในไฟล์ทดสอบเป็น running number (สำรองชีตที่เปลี่ยนก่อนเขียน) — ไม่มีฟังก์ชันนี้สำหรับ Production */
function migrateTestIds() {
  var actor = Auth.requireOwner();
  Database.useTestSpreadsheet();
  var report = IdMigration.run({ dryRun: false });
  if (Object.keys(report.changes).length) tryAudit_(actor.actorId, 'MIGRATE_LEGACY_IDS');
  return logReport_('migrateTestIds (TEST)', report);
}

/**
 * ทดสอบการตั้งค่า AI จาก editor: แปลงข้อความตัวอย่างด้วยข้อมูลหลักของไฟล์ทดสอบ (ไม่เขียนข้อมูล)
 * ส่งชื่อ+ID ของบัญชี/หมวด/เจ้าของในไฟล์ทดสอบไปยังผู้ให้บริการ AI ที่ตั้งไว้
 */
function testAiParse() {
  Auth.requireOwner();
  Database.useTestSpreadsheet();
  var result = AiParser.parse('กาแฟ 65 บาท', { client_id: '', default_account_id: '', default_owner_id: '' });
  return logReport_('testAiParse (TEST)', result);
}

function initializeTestDatabase() {
  var actor = Auth.requireOwner();
  Database.useTestSpreadsheet();
  var report = Database.initialize();
  tryAudit_(actor.actorId, 'INITIALIZE_DATABASE');
  return logReport_('initializeDatabase (TEST)', report);
}

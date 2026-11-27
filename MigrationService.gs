/**
 * MigrationService.gs — แปลงรหัสหลักแบบ UUID (ก่อน 2026-11-27) เป็น running number
 *
 * ใช้กับ Spreadsheet ทดสอบเท่านั้น (เรียกผ่าน migrateTestIdsDryRun / migrateTestIds ใน Code.gs)
 * - ตรวจก่อนเสมอ (dryRun) แล้วจึงเขียน; ก่อนเขียนสำรองทุกชีตที่จะเปลี่ยนเป็นชีต bak_<เวลา>_<ชื่อ> ในไฟล์เดียวกัน
 * - เลขใหม่จองผ่าน IdSequence ต่อจากเลขที่มีอยู่ จึงไม่ชนกับรหัสตัวเลขเดิม
 * - เปลี่ยน PK และทุก FK ที่อ้างถึง รวม key ใน Settings (account.display_name.<id>, plan.star.<hash>.<id>)
 *   และ ApiDrafts.draft_json
 * - ไม่แก้ AuditLogs และ OperationJournal (เป็นประวัติ; รหัสเดิมในประวัติไม่ถูกใช้อ้างอิงต่อ)
 * - เรียกซ้ำได้: เมื่อไม่มี UUID เหลือจะไม่เขียนอะไร
 */
var IdMigration = (function () {
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** ตารางที่มี PK ต้องแปลง และ FK: คอลัมน์ → ตารางปลายทาง */
  var TABLES = {
    Owners: {},
    Accounts: { owner_id: 'Owners' },
    SubAccounts: { account_id: 'Accounts' },
    Categories: {},
    PaymentPlans: { account_id: 'Accounts', owner_id: 'Owners', category_id: 'Categories', sub_account_id: 'SubAccounts' },
    PaymentSchedules: { plan_id: 'PaymentPlans', account_id: 'Accounts', owner_id: 'Owners', category_id: 'Categories', sub_account_id: 'SubAccounts' },
    Transactions: { from_account_id: 'Accounts', to_account_id: 'Accounts', owner_id: 'Owners', category_id: 'Categories', plan_id: 'PaymentPlans',
      reversal_of: 'Transactions', from_sub_account_id: 'SubAccounts', to_sub_account_id: 'SubAccounts' },
    Reservations: { schedule_id: 'PaymentSchedules', account_id: 'Accounts', transaction_id: 'Transactions' },
    PaymentAllocations: { transaction_id: 'Transactions', schedule_id: 'PaymentSchedules' },
    Budgets: { owner_id: 'Owners' },
    BudgetCategories: { budget_id: 'Budgets', category_id: 'Categories' },
    ApiClients: { default_account_id: 'Accounts', default_owner_id: 'Owners' },
    ApiDrafts: { client_id: 'ApiClients', transaction_id: 'Transactions' }
  };
  var DRAFT_JSON_FKS = { from_account_id: 'Accounts', to_account_id: 'Accounts', owner_id: 'Owners', category_id: 'Categories' };
  var SETTING_PREFIXES = [
    { re: /^(account\.display_name\.)(.+)$/, table: 'Accounts' },
    { re: /^(plan\.star\.[0-9a-f]+\.)(.+)$/, table: 'PaymentPlans' }
  ];

  function text(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  /** อ่านชีตแบบดิบ (รองรับ header รุ่นเก่าที่สั้นกว่า) คืน { sheet, headers, values } หรือ null ถ้ายังไม่มีชีต */
  function load(ss, name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 1) return null;
    var values = sheet.getDataRange().getValues();
    var headers = values[0].map(function (h) { return text(h); });
    return { name: name, sheet: sheet, headers: headers, values: values };
  }

  function col(table, column) {
    return table.headers.indexOf(column);
  }

  function plan(ss) {
    var tables = {};
    Object.keys(TABLES).concat(['Settings']).forEach(function (name) {
      var t = load(ss, name);
      if (t) tables[name] = t;
    });
    // 1) PK ที่เป็น UUID ต่อตาราง (เรียงตามลำดับแถว)
    var legacy = {};
    Object.keys(TABLES).forEach(function (name) {
      var t = tables[name];
      legacy[name] = [];
      if (!t) return;
      var pkCol = col(t, Config.PRIMARY_KEYS[name]);
      for (var r = 1; r < t.values.length; r++) {
        var v = text(t.values[r][pkCol]);
        if (UUID_RE.test(v)) legacy[name].push(v);
      }
    });
    return { tables: tables, legacy: legacy };
  }

  /**
   * ใช้ map กับข้อมูลในหน่วยความจำ; คืนจำนวนการเปลี่ยนต่อชีต และ FK ที่เป็น UUID แต่ไม่พบปลายทาง
   */
  function remap(p, maps) {
    var changes = {};
    var dangling = [];
    function bump(name) { changes[name] = (changes[name] || 0) + 1; }
    function mapped(table, value) {
      var v = text(value);
      if (!UUID_RE.test(v)) return null;
      var hit = maps[table] && maps[table][v];
      return hit || '';
    }
    Object.keys(TABLES).forEach(function (name) {
      var t = p.tables[name];
      if (!t) return;
      var columns = {};
      columns[Config.PRIMARY_KEYS[name]] = name;
      Object.keys(TABLES[name]).forEach(function (c) { columns[c] = TABLES[name][c]; });
      var jsonCol = name === 'ApiDrafts' ? col(t, 'draft_json') : -1;
      for (var r = 1; r < t.values.length; r++) {
        var row = t.values[r];
        Object.keys(columns).forEach(function (c) {
          var i = col(t, c);
          if (i < 0) return;
          var next = mapped(columns[c], row[i]);
          if (next === null) return;
          if (!next) { dangling.push({ sheet: name, row: r + 1, column: c }); return; }
          row[i] = next;
          bump(name);
        });
        if (jsonCol >= 0 && text(row[jsonCol])) {
          var parsed;
          try { parsed = JSON.parse(Validation.unsanitizeFromSheet(String(row[jsonCol]))); } catch (e) { parsed = null; }
          if (parsed && typeof parsed === 'object') {
            var touched = false;
            Object.keys(DRAFT_JSON_FKS).forEach(function (k) {
              var next = mapped(DRAFT_JSON_FKS[k], parsed[k]);
              if (next === null) return;
              if (!next) { dangling.push({ sheet: name, row: r + 1, column: 'draft_json.' + k }); return; }
              parsed[k] = next;
              touched = true;
            });
            if (touched) { row[jsonCol] = Util.stableStringify(parsed); bump(name); }
          }
        }
      }
    });
    var s = p.tables.Settings;
    if (s) {
      var keyCol = col(s, 'setting_key');
      for (var r2 = 1; r2 < s.values.length; r2++) {
        var key = text(s.values[r2][keyCol]);
        SETTING_PREFIXES.forEach(function (sp) {
          var m = sp.re.exec(key);
          if (!m) return;
          var next = mapped(sp.table, m[2]);
          if (next === null) return;
          if (!next) { dangling.push({ sheet: 'Settings', row: r2 + 1, column: 'setting_key' }); return; }
          s.values[r2][keyCol] = m[1] + next;
          bump('Settings');
        });
      }
    }
    return { changes: changes, dangling: dangling };
  }

  function stamp() {
    return Util.nowIso().replace(/\D/g, '').slice(0, 12); // yyyyMMddHHmm (Asia/Bangkok)
  }

  /**
   * options.dryRun = true: รายงานอย่างเดียว ไม่จองเลข ไม่เขียน
   * คืน { dryRun, uuidRows: {sheet: n}, changes: {sheet: n}, dangling: [...], backups: [...] }
   */
  function run(options) {
    var dryRun = !options || options.dryRun !== false;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(Config.LOCK_TIMEOUT_MS)) throw Util.AppError('BUSY', 'ระบบกำลังบันทึกรายการอื่น กรุณาลองใหม่อีกครั้ง');
    try {
      Database.resetExecutionCache();
      var ss = Database.getSpreadsheet();
      var p = plan(ss);
      var counts = {};
      var maps = {};
      Object.keys(p.legacy).forEach(function (name) {
        if (!p.legacy[name].length) return;
        counts[name] = p.legacy[name].length;
        maps[name] = {};
        p.legacy[name].forEach(function (uuid, i) {
          // dry run ใช้เลขสมมติเพื่อคำนวณผลกระทบ (ไม่จองเลขจริง)
          maps[name][uuid] = dryRun ? 'NEW-' + (i + 1) : IdSequence.next(name);
        });
      });
      var result = remap(p, maps);
      var report = { dryRun: dryRun, uuidRows: counts, changes: result.changes, dangling: result.dangling, backups: [] };
      if (dryRun || !Object.keys(result.changes).length) return report;

      IdSequence.flush(); // บันทึกตัวนับก่อนเขียนแถวที่ใช้เลขใหม่
      var when = stamp();
      Object.keys(result.changes).forEach(function (name) {
        var t = p.tables[name];
        var backupName = 'bak_' + when + '_' + name;
        t.sheet.copyTo(ss).setName(backupName);
        report.backups.push(backupName);
      });
      Object.keys(result.changes).forEach(function (name) {
        var t = p.tables[name];
        var body = t.values.slice(1).map(function (row) {
          return row.map(function (v, i) { return t.headers[i] ? Database.toCell(Database.fromCell(v, t.headers[i]), t.headers[i]) : v; });
        });
        if (body.length) t.sheet.getRange(2, 1, body.length, t.headers.length).setValues(body);
      });
      Database.resetExecutionCache();
      return report;
    } finally {
      lock.releaseLock();
    }
  }

  return { run: run, UUID_RE: UUID_RE };
})();

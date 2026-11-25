/**
 * ProjectionService.gs — จุดเดียวที่เขียนคอลัมน์ *_name และข้อมูลแผนที่คัดลอกไป PaymentSchedules
 * ID เป็นรหัสอ้างอิงหลัก; ชื่อดึงจาก Master Data (Accounts, Owners, Categories) เสมอ
 */
var Projection = (function () {
  var MASTER_SOURCES = {
    accounts: { sheet: 'Accounts', id: 'account_id', name: 'account_name', type: 'account_type' },
    owners: { sheet: 'Owners', id: 'owner_id', name: 'owner_name' },
    categories: { sheet: 'Categories', id: 'category_id', name: 'category_name', type: 'category_type' }
  };

  /** อ่าน Master ทั้งสามตาราง: { accounts: {id: {name, isActive, type}}, owners, categories } */
  function loadMasters() {
    var masters = {};
    Object.keys(MASTER_SOURCES).forEach(function (key) {
      var src = MASTER_SOURCES[key];
      var map = {};
      Database.readAll(src.sheet).rows.forEach(function (r) {
        map[r[src.id]] = { name: r[src.name], isActive: r.is_active === true, type: src.type ? r[src.type] : '' };
      });
      masters[key] = map;
    });
    return masters;
  }

  /**
   * ตรวจ FK และเติมชื่อให้ row ของตาราง (Transactions / PaymentPlans / PaymentSchedules)
   * ใช้ตอนสร้าง/แก้รายการ: ค่า *_name ที่ client ส่งมาจะถูกเขียนทับ
   * options.requireActive: ปฏิเสธ Master ที่ปิดใช้งาน (ใช้กับรายการใหม่)
   */
  function apply(sheetName, row, masters, options) {
    var opts = options || {};
    var specs = Config.NAME_PROJECTIONS[sheetName];
    if (!specs) throw Util.AppError('UNKNOWN_SHEET', 'ตาราง ' + sheetName + ' ไม่มี projection');
    specs.forEach(function (spec) {
      var idCol = spec[0];
      var nameCol = spec[1];
      var id = row[idCol];
      if (Validation.isBlank(id)) {
        row[nameCol] = '';
        return;
      }
      var master = masters[spec[2]][id];
      if (!master) {
        throw Util.AppError('VALIDATION_FK_NOT_FOUND', 'ไม่พบข้อมูลที่อ้างอิงใน ' + idCol, { field: idCol });
      }
      if (opts.requireActive && !master.isActive) {
        throw Util.AppError('VALIDATION_FK_INACTIVE', 'ข้อมูลที่เลือกใน ' + idCol + ' ถูกปิดใช้งานแล้ว', { field: idCol });
      }
      row[nameCol] = master.name;
    });
    return row;
  }

  /** คัดลอกข้อมูลจากแผนไปงวด (ไม่รวม note ของงวด) แล้วเติมชื่อ */
  function applyPlanToSchedule(schedule, plan, masters) {
    Config.PLAN_TO_SCHEDULE_FIELDS.forEach(function (f) { schedule[f] = plan[f]; });
    return apply('PaymentSchedules', schedule, masters);
  }

  /**
   * คำนวณ projection ใหม่ทั้งหมดจาก ID (idempotent) และเขียนเฉพาะคอลัมน์ที่มีค่าเปลี่ยน
   * ไม่เปลี่ยน updated_at และไม่คำนวณยอดใหม่ (BR-DM-06)
   * options: { dryRun, masterKeys: ['accounts'|'owners'|'categories'] (ค่าเริ่มต้น: ทั้งหมด) }
   * คืนรายงาน { dryRun, tables: [{sheet, column, changed}], orphans: [{sheet, column, rowNumber}] }
   */
  function refresh(options) {
    var opts = options || {};
    var masterKeys = opts.masterKeys || Object.keys(MASTER_SOURCES);
    var masters = loadMasters();
    var report = { dryRun: !!opts.dryRun, tables: [], orphans: [] };

    function writeIfChanged(sheetName, column, data, newValues) {
      var changed = 0;
      data.rows.forEach(function (r, i) { if (r[column] !== newValues[i]) changed++; });
      if (changed && !opts.dryRun) Database.writeColumn(sheetName, column, data.rowNumbers, newValues);
      if (changed) {
        data.rows.forEach(function (r, i) { r[column] = newValues[i]; });
        report.tables.push({ sheet: sheetName, column: column, changed: changed });
      }
    }

    function refreshNames(sheetName, data) {
      Config.NAME_PROJECTIONS[sheetName].forEach(function (spec) {
        if (masterKeys.indexOf(spec[2]) < 0) return;
        var values = data.rows.map(function (r, i) {
          var id = r[spec[0]];
          if (Validation.isBlank(id)) return '';
          var m = masters[spec[2]][id];
          if (!m) {
            report.orphans.push({ sheet: sheetName, column: spec[0], rowNumber: data.rowNumbers[i] });
            return r[spec[1]]; // ไม่ลบชื่อเดิมเมื่อหา Master ไม่พบ
          }
          return m.name;
        });
        writeIfChanged(sheetName, spec[1], data, values);
      });
    }

    refreshNames('Transactions', Database.readAll('Transactions'));

    var plans = Database.readAll('PaymentPlans');
    refreshNames('PaymentPlans', plans);

    var schedules = Database.readAll('PaymentSchedules');
    if (!opts.masterKeys) {
      var planById = {};
      plans.rows.forEach(function (p) { planById[p.plan_id] = p; });
      Config.PLAN_TO_SCHEDULE_FIELDS.forEach(function (field) {
        var values = schedules.rows.map(function (s, i) {
          var plan = planById[s.plan_id];
          if (!plan) {
            if (field === Config.PLAN_TO_SCHEDULE_FIELDS[0]) {
              report.orphans.push({ sheet: 'PaymentSchedules', column: 'plan_id', rowNumber: schedules.rowNumbers[i] });
            }
            return s[field];
          }
          return plan[field];
        });
        writeIfChanged('PaymentSchedules', field, schedules, values);
      });
    }
    refreshNames('PaymentSchedules', schedules);

    return report;
  }

  return {
    loadMasters: loadMasters,
    apply: apply,
    applyPlanToSchedule: applyPlanToSchedule,
    refresh: refresh
  };
})();

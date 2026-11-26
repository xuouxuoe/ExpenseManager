/**
 * AccountService.gs — Master Data: Accounts, Owners, Categories
 * - เพิ่ม / แก้ไข / ปิด-เปิดใช้งาน (ไม่มีการลบจริง: BR-DM-08)
 * - ตรวจชื่อซ้ำ (BR-DM-09) และห้ามเก็บข้อมูลบัตร/รหัสลับ (AGENTS §6.4)
 * - แก้ไขแล้ว refresh ชื่อในตารางที่อ้างอิงโดยไม่เปลี่ยน ID (BR-DM-05, BR-DM-06)
 * ทุกการเขียนผ่าน Operation.run (lock + idempotency + journal + audit)
 */
var MasterData = (function () {
  var LIABILITY_TYPES = ['CREDIT_CARD', 'CASH_CARD', 'LOAN'];
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  var TYPES = {
    subaccount: { sheet: 'SubAccounts', pk: 'sub_account_id', nameField: 'sub_account_name', projectionKey: 'subAccounts' },
    account: { sheet: 'Accounts', pk: 'account_id', nameField: 'account_name', projectionKey: 'accounts' },
    owner: { sheet: 'Owners', pk: 'owner_id', nameField: 'owner_name', projectionKey: 'owners' },
    category: { sheet: 'Categories', pk: 'category_id', nameField: 'category_name', projectionKey: 'categories' }
  };

  function typeDef(type) {
    var def = TYPES[type];
    if (!def) throw Util.AppError('VALIDATION_ENUM', 'ประเภทข้อมูลหลักไม่ถูกต้อง', { field: 'type' });
    return def;
  }

  function fail(code, field, message) {
    return Util.AppError('VALIDATION_' + code, message, { field: field });
  }

  /** ปฏิเสธข้อความที่มีลักษณะเลขบัตรเต็ม (ตัวเลข 13–19 หลัก อาจคั่นด้วยช่องว่าง/ขีด) */
  function rejectCardNumber(text, field) {
    var candidates = String(text || '').match(/\d[\d -]{11,}\d/g) || [];
    candidates.forEach(function (c) {
      var digits = c.replace(/[ -]/g, '');
      if (digits.length >= 13 && digits.length <= 19) {
        throw fail('SENSITIVE_DATA', field, 'ห้ามบันทึกหมายเลขบัตรเต็มใน ' + field + ' (ใช้เฉพาะ 4 หลักท้ายได้)');
      }
    });
    return text;
  }

  function safeText(value, field, options) {
    return rejectCardNumber(Validation.requireText(value, field, options), field);
  }

  function moneyOrBlank(value, field) {
    var satang = Validation.toSatang(value, field, { required: false, allowZero: true });
    return satang === null ? '' : Validation.fromSatang(satang);
  }

  function displayNames() {
    var names = Object.create(null);
    Database.readAll('Settings').rows.forEach(function (r) {
      if (r.setting_key.indexOf('account.display_name.') === 0) {
        names[r.setting_key.slice('account.display_name.'.length)] = r.setting_value;
      }
    });
    return names;
  }

  function displayAccount(row, names) {
    var alias = (names || displayNames())[row.account_id] || '';
    return Object.assign({}, row, { real_account_name: row.account_name, display_name: alias, account_name: alias || row.account_name });
  }

  function saveDisplayName(id, input, now) {
    if (input.display_name === undefined) return false;
    var name = safeText(input.display_name, 'display_name', { max: Config.TEXT_LIMITS.NAME });
    var settingKey = 'account.display_name.' + id;
    var hit = Database.findRowsByValue('Settings', 'setting_key', settingKey)[0];
    if ((!hit && !name) || (hit && hit.row.setting_value === name)) return false;
    var row = { setting_key: settingKey, setting_value: name, description: 'ชื่อบัญชีที่ใช้แสดง', updated_at: now };
    if (hit) Database.writeRowAt('Settings', hit.rowNumber, row);
    else Database.appendRows('Settings', [row]);
    return true;
  }

  // ---------- ตรวจ input ตามประเภท (รับเฉพาะ field ที่อนุญาต) ----------

  /** currentOwnerId: เจ้าของเดิมของบัญชีที่กำลังแก้ไข (คงไว้ได้แม้ถูกปิดใช้งานภายหลัง) */
  function validateAccount(input, masters, currentOwnerId) {
    var accountType = Validation.requireEnum(input.account_type, Config.ENUMS.ACCOUNT_TYPE, 'account_type');
    var subtype = Validation.requireEnum(input.account_subtype, Config.ENUMS.ACCOUNT_SUBTYPE, 'account_subtype', { required: false });
    if (subtype === 'SAVINGS' && accountType !== 'BANK') {
      throw fail('RULE', 'account_subtype', 'SAVINGS ใช้ได้กับบัญชีประเภท BANK เท่านั้น');
    }
    var ownerId = Validation.requireId(input.owner_id, 'owner_id', { required: false });
    if (ownerId) {
      var owner = masters.owners[ownerId];
      if (!owner) throw fail('FK_NOT_FOUND', 'owner_id', 'ไม่พบเจ้าของที่เลือก');
      if (!owner.isActive && ownerId !== currentOwnerId) throw fail('FK_INACTIVE', 'owner_id', 'เจ้าของที่เลือกถูกปิดใช้งานแล้ว');
    }
    var isLiability = LIABILITY_TYPES.indexOf(accountType) >= 0;
    var creditLimit = moneyOrBlank(input.credit_limit, 'credit_limit');
    if (creditLimit !== '' && !isLiability) {
      throw fail('RULE', 'credit_limit', 'วงเงินใช้ได้กับบัตรเครดิต บัตรกดเงินสด หรือสินเชื่อเท่านั้น');
    }
    var statementDay = Validation.requireDay(input.statement_day, 'statement_day');
    var dueDay = Validation.requireDay(input.due_day, 'due_day');
    if ((statementDay !== '' || dueDay !== '') && !isLiability) {
      throw fail('RULE', 'due_day', 'วันตัดรอบ/วันครบกำหนดใช้ได้กับบัญชีประเภทหนี้สินเท่านั้น');
    }
    var opening = Validation.toSatang(Validation.isBlank(input.opening_balance) ? 0 : input.opening_balance,
      'opening_balance', { allowZero: true });
    return {
      account_name: safeText(input.account_name, 'account_name', { required: true, max: Config.TEXT_LIMITS.NAME }),
      account_type: accountType,
      account_subtype: subtype,
      owner_id: ownerId,
      institution: safeText(input.institution, 'institution', { max: Config.TEXT_LIMITS.NAME }),
      opening_balance: Validation.fromSatang(opening),
      opening_date: Validation.requireDate(input.opening_date, 'opening_date', { required: false }),
      credit_limit: creditLimit,
      statement_day: statementDay,
      due_day: dueDay,
      note: safeText(input.note, 'note', { max: Config.TEXT_LIMITS.NOTE, multiline: true })
    };
  }

  function validateOwner(input) {
    return {
      owner_name: safeText(input.owner_name, 'owner_name', { required: true, max: Config.TEXT_LIMITS.NAME })
    };
  }

  function validateCategory(input) {
    var color = Validation.requireText(input.color, 'color', { max: 20 });
    if (color && !COLOR_RE.test(color)) throw fail('FORMAT', 'color', 'สีต้องอยู่ในรูปแบบ #RRGGBB');
    return {
      category_name: safeText(input.category_name, 'category_name', { required: true, max: Config.TEXT_LIMITS.NAME }),
      category_type: Validation.requireEnum(input.category_type, Config.ENUMS.CATEGORY_TYPE, 'category_type'),
      icon: Validation.requireText(input.icon, 'icon', { max: 50 }),
      color: color
    };
  }

  function validateInput(type, input, masters, current) {
    if (!input || typeof input !== 'object') throw fail('REQUIRED', 'input', 'ไม่พบข้อมูลที่ต้องบันทึก');
    if (type === 'subaccount') {
      var parent = Validation.requireId(input.account_id, 'account_id');
      if (!masters.accounts[parent] || (!masters.accounts[parent].isActive && (!current || current.account_id !== parent))) {
        throw fail('FK_INACTIVE', 'account_id', 'กรุณาเลือกบัญชีหลักที่ใช้งานได้');
      }
      if (current && current.account_id !== parent) throw fail('RULE', 'account_id', 'บัญชีย่อยที่สร้างแล้วต้องอยู่ภายใต้บัญชีหลักเดิม');
      return { account_id: parent, sub_account_name: safeText(input.sub_account_name, 'sub_account_name', { required: true, max: Config.TEXT_LIMITS.NAME }) };
    }
    if (type === 'account') return validateAccount(input, masters, current ? current.owner_id : '');
    if (type === 'owner') return validateOwner(input);
    return validateCategory(input);
  }

  // ---------- กฎความสมบูรณ์ของข้อมูล ----------

  function normalizeName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** ชื่อซ้ำในรายการที่ active (Categories เทียบภายใน category_type เดียวกัน) */
  function assertUniqueName(type, rows, candidate, selfId) {
    var def = typeDef(type);
    var name = normalizeName(candidate[def.nameField]);
    var dup = rows.some(function (r) {
      if (r[def.pk] === selfId || r.is_active !== true) return false;
      if (type === 'category' && r.category_type !== candidate.category_type) return false;
      if (type === 'subaccount' && r.account_id !== candidate.account_id) return false;
      return normalizeName(r[def.nameField]) === name;
    });
    if (dup) throw fail('DUPLICATE_NAME', def.nameField, 'มีชื่อนี้อยู่แล้ว กรุณาใช้ชื่ออื่น');
  }

  /** ID นี้ถูกอ้างอิงในข้อมูลธุรกรรม/แผนหรือไม่ */
  function isReferenced(type, id) {
    var checks = {
      account: [['Transactions', ['from_account_id', 'to_account_id']], ['PaymentPlans', ['account_id']], ['Reservations', ['account_id']]],
      owner: [['Transactions', ['owner_id']], ['PaymentPlans', ['owner_id']], ['Accounts', ['owner_id']]],
      category: [['Transactions', ['category_id']], ['PaymentPlans', ['category_id']]]
    }[type];
    return checks.some(function (c) {
      return Database.readAll(c[0]).rows.some(function (r) {
        return c[1].some(function (col) { return r[col] === id; });
      });
    });
  }

  function findRow(type, id) {
    var def = typeDef(type);
    var cleanId = Validation.requireId(id, def.pk);
    var data = Database.readAll(def.sheet);
    for (var i = 0; i < data.rows.length; i++) {
      if (data.rows[i][def.pk] === cleanId) return { row: data.rows[i], rows: data.rows };
    }
    throw Util.AppError('NOT_FOUND', 'ไม่พบข้อมูลที่ต้องการแก้ไข');
  }

  function requestOf(request, operationType, payload) {
    return {
      operationType: operationType,
      idempotencyKey: request.idempotencyKey,
      payload: payload,
      actor: request.actor
    };
  }

  // ---------- คำสั่ง ----------

  /** รายการ Master: { accounts: [], owners: [], categories: [] } */
  function listAll(options) {
    var includeInactive = !!(options && options.includeInactive);
    var out = {};
    var names = displayNames();
    Object.keys(TYPES).forEach(function (type) {
      var def = TYPES[type];
      out[def.sheet.charAt(0).toLowerCase() + def.sheet.slice(1)] = Database.readAll(def.sheet).rows.filter(function (r) {
        return includeInactive || r.is_active === true;
      }).map(function (r) {
        return type === 'account' ? displayAccount(r, names) : r;
      });
    });
    return out;
  }

  /** request: { idempotencyKey, actor } */
  function create(type, input, request) {
    var def = typeDef(type);
    return Operation.run(requestOf(request, 'CREATE_' + type.toUpperCase(), { type: type, input: input }), function (ctx) {
      var masters = Projection.loadMasters();
      var clean = validateInput(type, input, masters);
      if (type === 'account' && input.display_name !== undefined) safeText(input.display_name, 'display_name', { max: Config.TEXT_LIMITS.NAME });
      var rows = Database.readAll(def.sheet).rows;
      var id = ctx.id(def.sheet, type);
      if (!rows.some(function (r) { return r[def.pk] === id; })) {
        clean.is_active = true;
        assertUniqueName(type, rows, clean, id);
      }
      var row = Object.assign({}, clean);
      row[def.pk] = id;
      row.is_active = true;
      row.created_at = ctx.now;
      row.updated_at = ctx.now;
      Database.appendRowsIfAbsent(def.sheet, [row]);
      if (type === 'account') saveDisplayName(id, input, ctx.now);
      var saved = findRow(type, id).row;
      return type === 'account' ? displayAccount(saved) : saved;
    }).result;
  }

  /**
   * แก้ไขข้อมูล (ไม่รวม is_active)
   * เปลี่ยน account_type / category_type ไม่ได้เมื่อถูกอ้างอิงแล้ว เพราะกระทบผลทางบัญชีของรายการเดิม
   * refresh projection ทุกครั้ง (idempotent) เพื่อให้ replay หลังล้มเหลวกลางทางยังได้ชื่อที่ถูกต้อง
   */
  function update(type, id, input, request) {
    var def = typeDef(type);
    return Operation.run(requestOf(request, 'UPDATE_' + type.toUpperCase(), { type: type, id: id, input: input }), function (ctx) {
      var found = findRow(type, id);
      var current = found.row;
      var masters = Projection.loadMasters();
      var clean = validateInput(type, input, masters, current);
      if (current.is_active === true) assertUniqueName(type, found.rows, Object.assign({}, current, clean), current[def.pk]);
      var typeField = type === 'account' ? 'account_type' : (type === 'category' ? 'category_type' : null);
      if (typeField && clean[typeField] !== current[typeField] && isReferenced(type, current[def.pk])) {
        throw fail('RULE', typeField, 'เปลี่ยนประเภทไม่ได้ เพราะมีรายการที่ใช้ข้อมูลนี้แล้ว');
      }
      var renamed = clean[def.nameField] !== current[def.nameField];
      // Preserve the rename event before updating the master. On replay the stored
      // master may already have its new name even when its projections/audit are incomplete.
      var recordRename = renamed || !!(ctx.recoveryData && ctx.recoveryData.renamed);
      if (renamed && !ctx.recoveryData) ctx.checkpoint({ renamed: true });
      var updated = Object.assign({}, current, clean, { updated_at: ctx.now });
      var displayChanged = type === 'account' && saveDisplayName(id, input, ctx.now);
      Database.updateRows(def.sheet, [updated]);
      // refresh เฉพาะเมื่อชื่อเปลี่ยน หรือเป็นการ replay งานที่ค้าง (อาจ refresh ไม่ครบรอบก่อน)
      var report = (renamed || displayChanged || ctx.replay) ? Projection.refresh({ masterKeys: [def.projectionKey] }) : { tables: [], orphans: [] };
      if (recordRename) {
        Audit.log({ actorId: ctx.actorId, action: 'RENAME_MASTER', entityType: def.sheet, entityId: current[def.pk],
          operationId: ctx.operationId, result: 'SUCCESS', auditId: ctx.id('AuditLogs', 'master-rename-audit'), deduplicate: ctx.replay });
      }
      var saved = findRow(type, current[def.pk]).row;
      return { row: type === 'account' ? displayAccount(saved) : saved, projection: { changedColumns: report.tables.length, orphans: report.orphans.length } };
    }).result;
  }

  /** ปิด/เปิดใช้งาน (soft delete) — ข้อมูลเดิมยังแสดงชื่อได้ */
  function setActive(type, id, isActive, request) {
    var def = typeDef(type);
    var active = Validation.requireBoolean(isActive, 'is_active');
    return Operation.run(requestOf(request, 'SET_ACTIVE_' + type.toUpperCase(), { type: type, id: id, isActive: active }), function (ctx) {
      var found = findRow(type, id);
      var current = found.row;
      if (current.is_active === active) return type === 'account' ? displayAccount(current) : current;
      if (active) assertUniqueName(type, found.rows, current, current[def.pk]);
      var updated = Object.assign({}, current, { is_active: active, updated_at: ctx.now });
      Database.updateRows(def.sheet, [updated]);
      var saved = findRow(type, current[def.pk]).row;
      return type === 'account' ? displayAccount(saved) : saved;
    }).result;
  }

  return {
    TYPES: Object.keys(TYPES),
    displayNames: displayNames,
    listAll: listAll,
    create: create,
    update: update,
    setActive: setActive
  };
})();

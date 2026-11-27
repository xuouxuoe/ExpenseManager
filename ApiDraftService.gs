/**
 * ApiDraftService.gs — ร่างรายการจาก Integration API (ระยะ A2, docs/integration-api.md ข้อ 0, 5–8)
 *
 * ทุกการบันทึกจากภายนอกต้องผ่าน 2 ขั้น: draft.create (ตรวจ + resolve ชื่อเป็น ID + เก็บร่าง) → draft.confirm (บันทึกจริง)
 * - ผลจาก AI เป็นเพียงข้อเสนอ: Backend ตรวจด้วย Transactions.validate เดิมทั้งตอนสร้างร่างและตอนยืนยัน
 * - draft_json เก็บเฉพาะค่าที่ resolve เป็น ID แล้ว ไม่เก็บข้อความดิบ (source_text)
 * - confirm_token = hash(API_DRAFT_SECRET, draft_id, client_id) จึงคำนวณซ้ำได้เมื่อ retry โดยไม่ต้องเก็บ token จริง
 *   (journal/audit/ชีตเก็บเฉพาะ confirm_token_hash)
 * - ยืนยันซ้ำ/ส่งซ้ำได้ผลเดิม: idempotency key ของการยืนยันผูกกับ draft_id
 * - ระยะ E2 (docs/event-budget-plan.md): params.budget = ID หรือชื่องบทริปที่เปิดใช้ → budget_id ของรายการ
 */
var ApiDrafts = (function () {
  var SHEET = 'ApiDrafts';
  var TTL_MS = 24 * 60 * 60 * 1000;
  var TOKEN_RE = /^[a-f0-9]{32}$/;
  var TYPES = ['INCOME', 'EXPENSE', 'TRANSFER', 'CREDIT_PURCHASE'];
  var PARAM_KEYS = ['transaction_type', 'transaction_date', 'amount', 'from_account', 'to_account', 'category', 'owner',
    'item_name', 'description', 'note', 'source_text', 'budget'];
  /** บัญชีหลักของแต่ละประเภทที่ใช้ default_account_id ของการเชื่อมต่อเมื่อไม่ระบุ */
  var DEFAULT_SIDE = { INCOME: 'to', EXPENSE: 'from', TRANSFER: 'from', CREDIT_PURCHASE: 'from' };
  var TYPE_LABEL = { INCOME: 'รายรับ', EXPENSE: 'รายจ่าย', TRANSFER: 'โอนเงิน', CREDIT_PURCHASE: 'ซื้อด้วยบัตร' };
  var STATUS_LABEL = { CONFIRMED: 'ยืนยันแล้ว', CANCELLED: 'ถูกยกเลิกแล้ว', EXPIRED: 'หมดอายุแล้ว', FAILED: 'บันทึกไม่ได้แล้ว' };

  function invalid(code, field, message, extra) {
    var details = { field: field };
    if (extra) Object.keys(extra).forEach(function (k) { details[k] = extra[k]; });
    return Util.AppError('VALIDATION_' + code, message, details);
  }

  function normalize(text) {
    return String(text === null || text === undefined ? '' : text).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function money(amount) {
    var parts = Number(amount).toFixed(2).split('.');
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
  }

  // ---------- Secret / token ----------

  /** secret สำหรับคำนวณ token; สร้างครั้งแรกภายใน lock ของ Operation.run */
  function secret(create) {
    var props = PropertiesService.getScriptProperties();
    var value = props.getProperty(Config.PROPERTY_KEYS.API_DRAFT_SECRET);
    if (!value && create) {
      value = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
      props.setProperty(Config.PROPERTY_KEYS.API_DRAFT_SECRET, value);
    }
    if (!value) throw Util.AppError('CONFIG_MISSING', 'ยังไม่มีค่า API_DRAFT_SECRET');
    return value;
  }

  function tokenFor(draftId, clientId, create) {
    return Util.sha256Hex('expense-manager-draft\u0000' + secret(create) + '\u0000' + draftId + '\u0000' + clientId).slice(0, 32);
  }

  function hashToken(token) {
    return Util.sha256Hex('expense-manager-draft-token\u0000' + token);
  }

  // ---------- Master data ----------

  /** ข้อมูลหลักที่ใช้งานอยู่ สำหรับ masters.list และการแปลงชื่อเป็น ID */
  function activeMasters() {
    var all = MasterData.listAll({ includeInactive: false });
    return {
      accounts: all.accounts.map(function (a) {
        return { account_id: a.account_id, account_name: a.account_name, real_account_name: a.real_account_name || a.account_name, account_type: a.account_type };
      }),
      categories: all.categories.map(function (c) { return { category_id: c.category_id, category_name: c.category_name, category_type: c.category_type }; }),
      owners: all.owners.map(function (o) { return { owner_id: o.owner_id, owner_name: o.owner_name }; }),
      // งบทริป/โครงการที่เลือกได้ (เปิดใช้ และจบไม่เกิน 30 วัน) — ไม่ส่งยอดเงินของงบ
      budgets: Budgets.eventOptions().map(function (b) {
        return { budget_id: b.budget_id, budget_name: b.budget_name, owner_id: b.owner_id, start_date: b.start_date, end_date: b.end_date };
      })
    };
  }

  function mastersFor(client) {
    var m = activeMasters();
    return {
      accounts: m.accounts.map(function (a) { return { account_id: a.account_id, account_name: a.account_name, account_type: a.account_type }; }),
      categories: m.categories,
      owners: m.owners,
      budgets: m.budgets,
      defaults: { account_id: client.default_account_id || '', owner_id: client.default_owner_id || '' }
    };
  }

  /**
   * แปลงค่าที่ผู้เรียกส่ง (ID หรือชื่อ) เป็น ID ของ Master ที่ใช้งานอยู่
   * ชื่อเทียบแบบไม่สนตัวพิมพ์/ช่องว่าง; ไม่พบหรือกำกวม → ข้อผิดพลาดพร้อมตัวเลือก (ไม่สร้างร่าง)
   */
  function resolve(value, rows, idKey, nameKeys, field, label) {
    if (Validation.isBlank(value)) return '';
    var raw = String(value).trim();
    var byId = rows.filter(function (r) { return r[idKey] === raw; });
    if (byId.length) return byId[0][idKey];
    var key = normalize(raw);
    var hits = rows.filter(function (r) { return nameKeys.some(function (k) { return normalize(r[k]) === key; }); });
    var options = function (list) { return list.slice(0, 20).map(function (r) { return { id: r[idKey], name: r[nameKeys[0]] }; }); };
    if (hits.length === 1) return hits[0][idKey];
    if (hits.length > 1) throw invalid('AMBIGUOUS', field, 'ชื่อ' + label + ' "' + raw.slice(0, 50) + '" ตรงกับหลายรายการ กรุณาระบุ ID', { candidates: options(hits) });
    throw invalid('NOT_FOUND', field, 'ไม่พบ' + label + ' "' + raw.slice(0, 50) + '"', { candidates: options(rows) });
  }

  /** params (JSON จาก AI/ผู้เรียก) → input ของ Transactions ที่มีเฉพาะ ID */
  function toTransactionInput(params, client) {
    var src = params || {};
    Object.keys(src).forEach(function (k) {
      if (PARAM_KEYS.indexOf(k) < 0) throw invalid('UNKNOWN_FIELD', k, 'ไม่รองรับฟิลด์ ' + String(k).slice(0, 50));
    });
    var type = Validation.requireEnum(src.transaction_type, TYPES, 'transaction_type');
    var m = activeMasters();
    var accountNames = ['account_name', 'real_account_name'];
    var from = resolve(src.from_account, m.accounts, 'account_id', accountNames, 'from_account', 'บัญชี');
    var to = resolve(src.to_account, m.accounts, 'account_id', accountNames, 'to_account', 'บัญชี');
    var side = DEFAULT_SIDE[type];
    if (client.default_account_id) {
      if (side === 'from' && !from) from = client.default_account_id;
      if (side === 'to' && !to) to = client.default_account_id;
    }
    var wantCategory = type === 'INCOME' ? 'INCOME' : (type === 'TRANSFER' ? '' : 'EXPENSE');
    var categories = wantCategory ? m.categories.filter(function (c) { return c.category_type === wantCategory; }) : m.categories;
    var category = resolve(src.category, categories, 'category_id', ['category_name'], 'category', 'หมวดหมู่');
    var budget = resolve(src.budget, m.budgets, 'budget_id', ['budget_name'], 'budget', 'งบทริป');
    var budgetRow = budget ? m.budgets.filter(function (b) { return b.budget_id === budget; })[0] : null;
    // งบที่ระบุเจ้าของ: ใช้เจ้าของของงบเมื่อไม่ได้ระบุ owner (Transactions.validate ยังตรวจให้ตรงกันอีกชั้น)
    var owner = resolve(src.owner, m.owners, 'owner_id', ['owner_name'], 'owner', 'เจ้าของ') ||
      (budgetRow && budgetRow.owner_id) || client.default_owner_id || '';
    // แจ้งด้วยชื่อฟิลด์ของ API (ไม่ใช่ *_id ภายใน) และบอกทางแก้เมื่อไม่มีค่าเริ่มต้น
    var rule = Transactions.RULES[type];
    if (rule.from && !from) throw invalid('REQUIRED', 'from_account', 'กรุณาระบุ from_account (บัญชีต้นทาง) หรือตั้งบัญชีเริ่มต้นของการเชื่อมต่อ');
    if (rule.to && !to) throw invalid('REQUIRED', 'to_account', 'กรุณาระบุ to_account (บัญชีปลายทาง)' + (side === 'to' ? ' หรือตั้งบัญชีเริ่มต้นของการเชื่อมต่อ' : ''));
    if (rule.category && !category) throw invalid('REQUIRED', 'category', 'กรุณาระบุ category (หมวดหมู่' + (rule.category === 'INCOME' ? 'รายรับ' : 'รายจ่าย') + ')');
    if (!owner) throw invalid('REQUIRED', 'owner', 'กรุณาระบุ owner (เจ้าของ) หรือตั้งเจ้าของเริ่มต้นของการเชื่อมต่อ');
    return {
      transaction_type: type,
      transaction_date: Validation.isBlank(src.transaction_date) ? Util.todayIso() : src.transaction_date,
      from_account_id: from,
      to_account_id: to,
      category_id: category,
      owner_id: owner,
      item_name: src.item_name,
      description: src.description,
      note: src.note,
      amount: src.amount,
      budget_id: budget
    };
  }

  /** ตรวจด้วยกฎเดียวกับหน้าเว็บ แล้วคืนเฉพาะ field ที่เก็บในร่าง */
  function validateInput(input) {
    var clean = Transactions.validate(input, Projection.loadMasters(), null);
    return {
      transaction_type: clean.transaction_type,
      transaction_date: clean.transaction_date,
      from_account_id: clean.from_account_id,
      to_account_id: clean.to_account_id,
      category_id: clean.category_id,
      owner_id: clean.owner_id,
      item_name: clean.item_name,
      description: clean.description,
      note: clean.note,
      amount: clean.amount,
      budget_id: clean.budget_id || ''
    };
  }

  function duplicatesOf(tx) {
    return Transactions.findPossibleDuplicates(Database.readAll('Transactions').rows, tx, '').slice(0, 3).map(function (d) {
      return { transaction_id: d.transaction_id, transaction_date: d.transaction_date, item_name: d.item_name, amount: d.amount };
    });
  }

  // ---------- การแสดงผล ----------

  function withNames(tx) {
    var masters = Projection.loadMasters();
    var name = function (map, id) { return id && map[id] ? map[id].name : ''; };
    return {
      transaction_type: tx.transaction_type,
      transaction_date: tx.transaction_date,
      amount: tx.amount,
      from_account_id: tx.from_account_id, from_account_name: name(masters.accounts, tx.from_account_id),
      to_account_id: tx.to_account_id, to_account_name: name(masters.accounts, tx.to_account_id),
      category_id: tx.category_id, category_name: name(masters.categories, tx.category_id),
      owner_id: tx.owner_id, owner_name: name(masters.owners, tx.owner_id),
      item_name: tx.item_name,
      description: tx.description,
      note: tx.note,
      budget_id: tx.budget_id || '', budget_name: name(Projection.sourceOf(masters, 'budgets'), tx.budget_id)
    };
  }

  /** ข้อความสรุปภาษาไทยสำหรับส่งต่อในแชตได้ทันที */
  function summaryText(view, duplicates, status) {
    var lines = [];
    if (status === 'CONFIRMED') lines.push('บันทึกแล้ว ✅');
    lines.push((TYPE_LABEL[view.transaction_type] || view.transaction_type) + ' ' + money(view.amount) + ' บาท — ' + view.item_name);
    lines.push('วันที่ ' + view.transaction_date);
    if (view.from_account_name && view.to_account_name) lines.push('จาก ' + view.from_account_name + ' → ' + view.to_account_name);
    else if (view.from_account_name) lines.push('บัญชี ' + view.from_account_name);
    else if (view.to_account_name) lines.push('เข้าบัญชี ' + view.to_account_name);
    if (view.category_name) lines.push('หมวด ' + view.category_name);
    if (view.owner_name) lines.push('เจ้าของ ' + view.owner_name);
    if (view.budget_name) lines.push('ใช้จากงบ ' + view.budget_name);
    if (view.description) lines.push(view.description);
    if (status === 'PENDING' && duplicates && duplicates.length) lines.push('⚠️ พบรายการที่อาจซ้ำ ' + duplicates.length + ' รายการ ตรวจก่อนยืนยัน');
    return lines.join('\n');
  }

  function toPublic(row, extra) {
    var tx = JSON.parse(row.draft_json);
    var view = withNames(tx);
    var dups = (extra && extra.duplicates) || [];
    var out = {
      draft_id: row.draft_id,
      draft_status: row.draft_status,
      expires_at: row.expires_at,
      transaction_id: row.transaction_id || '',
      transaction: view,
      possible_duplicates: dups,
      summary_text: summaryText(view, dups, row.draft_status)
    };
    return out;
  }

  // ---------- ตาราง ----------

  function findDraft(id) {
    var draftId = Validation.requireId(id, 'draft_id');
    var all = Database.readAll(SHEET);
    for (var i = 0; i < all.rows.length; i++) {
      if (all.rows[i].draft_id === draftId) return { row: all.rows[i], rowNumber: all.rowNumbers[i] };
    }
    return null;
  }

  /** หาร่างของผู้เรียกนี้ และตรวจ token/ช่องทาง (ไม่บอกว่าร่างของผู้อื่นมีอยู่) */
  function findOwned(params, call) {
    var src = params || {};
    var found = findDraft(src.draft_id);
    if (!found || found.row.client_id !== call.client.client_id) throw Util.AppError('DRAFT_NOT_FOUND', 'ไม่พบร่างรายการนี้');
    if (found.row.channel_user_id && found.row.channel_user_id !== call.channelUserId) {
      throw Util.AppError('DRAFT_NOT_FOUND', 'ไม่พบร่างรายการนี้');
    }
    var token = typeof src.confirm_token === 'string' ? src.confirm_token.trim() : '';
    if (!TOKEN_RE.test(token) || hashToken(token) !== found.row.confirm_token_hash) {
      throw Util.AppError('INVALID_CONFIRM_TOKEN', 'confirm_token ไม่ถูกต้อง');
    }
    return found;
  }

  function isExpired(row) {
    var t = Date.parse(row.expires_at);
    return !isFinite(t) || Date.now() > t;
  }

  function setStatus(found, status, ctx, extra) {
    var row = Object.assign({}, found.row, extra || {}, { draft_status: status, updated_at: ctx.now });
    Database.writeRowAt(SHEET, found.rowNumber, row);
    return row;
  }

  /** เปลี่ยนร่างที่ค้าง PENDING เป็นสถานะสิ้นสุด (EXPIRED/FAILED) ในคำขอแยก แล้วผู้เรียกค่อยแจ้งข้อผิดพลาด */
  function closeDraft(draftId, status, errorCode, call) {
    Operation.run({ operationType: 'API_DRAFT_' + status, idempotencyKey: 'api-draft-' + status.toLowerCase() + '-' + draftId,
      payload: { draft_id: draftId, error_code: errorCode || '' }, actor: call.actor }, function (ctx) {
      var found = findDraft(draftId);
      if (found && found.row.draft_status === 'PENDING') setStatus(found, status, ctx, { error_code: errorCode || '' });
      return { draft_id: draftId };
    });
  }

  function assertPending(found, call) {
    var status = found.row.draft_status;
    if (status === 'PENDING' && isExpired(found.row)) {
      closeDraft(found.row.draft_id, 'EXPIRED', '', call);
      throw Util.AppError('DRAFT_EXPIRED', 'ร่างรายการนี้หมดอายุแล้ว กรุณาส่งรายการใหม่');
    }
    if (status !== 'PENDING') {
      throw Util.AppError('DRAFT_NOT_PENDING', 'ร่างรายการนี้' + (STATUS_LABEL[status] || 'ไม่อยู่ในสถานะรอยืนยัน'), { draft_status: status });
    }
  }

  // ---------- Actions ----------

  /** draft.create: คืนร่าง + confirm_token (token คำนวณใหม่ได้เมื่อ retry ด้วย request_id เดิม) */
  function create(params, call) {
    var client = call.client;
    var input = toTransactionInput(params, client);
    var tx = validateInput(input);
    var payload = { client_id: client.client_id, channel_user_id: call.channelUserId || '', tx: tx };
    var result = Operation.run({ operationType: 'API_DRAFT_CREATE', idempotencyKey: call.requestId, payload: payload, actor: call.actor }, function (ctx) {
      var id = ctx.id(SHEET, 'draft');
      var token = tokenFor(id, client.client_id, true);
      var row = {
        draft_id: id,
        client_id: client.client_id,
        actor_id: ctx.actorId,
        channel_user_id: call.channelUserId || '',
        draft_status: 'PENDING',
        draft_json: Util.stableStringify(tx),
        confirm_token_hash: hashToken(token),
        transaction_id: '',
        error_code: '',
        expires_at: Util.nowIso(new Date(Date.now() + TTL_MS)),
        created_at: ctx.now,
        updated_at: ctx.now
      };
      Database.appendRowsIfAbsent(SHEET, [row]);
      return { draft_id: id };
    }).result;
    var found = findDraft(result.draft_id);
    var out = toPublic(found.row, { duplicates: duplicatesOf(tx) });
    if (found.row.draft_status === 'PENDING') out.confirm_token = tokenFor(found.row.draft_id, client.client_id, false);
    return out;
  }

  /** draft.confirm: บันทึกจริงครั้งเดียว; ยืนยันซ้ำคืนผลเดิม */
  function confirm(params, call) {
    var found = findOwned(params, call);
    if (found.row.draft_status === 'CONFIRMED') return toPublic(found.row);
    assertPending(found, call);
    var tx = JSON.parse(found.row.draft_json);
    try {
      validateInput(tx); // Master อาจถูกปิดหลังสร้างร่าง
    } catch (err) {
      if (Util.toClientError(err).code.indexOf('VALIDATION_') === 0) closeDraft(found.row.draft_id, 'FAILED', Util.toClientError(err).code, call);
      throw err;
    }
    var draftId = found.row.draft_id;
    Operation.run({ operationType: 'API_DRAFT_CONFIRM', idempotencyKey: 'api-draft-confirm-' + draftId, payload: { draft_id: draftId }, actor: call.actor }, function (ctx) {
      var current = findDraft(draftId);
      if (current.row.draft_status === 'CONFIRMED') return { draft_id: draftId, transaction_id: current.row.transaction_id };
      if (current.row.draft_status !== 'PENDING') throw Util.AppError('DRAFT_NOT_PENDING', 'ร่างรายการนี้' + (STATUS_LABEL[current.row.draft_status] || 'ไม่อยู่ในสถานะรอยืนยัน'));
      // ผู้ใช้เห็นคำเตือนรายการซ้ำในสรุปของร่างแล้ว จึงยืนยันได้แม้พบรายการคล้ายกัน
      var saved = Transactions.insertWithin(ctx, Object.assign({}, tx, { allow_duplicate: true }), { source: 'AI' });
      setStatus(current, 'CONFIRMED', ctx, { transaction_id: saved.transaction_id });
      return { draft_id: draftId, transaction_id: saved.transaction_id };
    });
    return toPublic(findDraft(draftId).row);
  }

  /** draft.cancel: ยกเลิกร่างที่ยังไม่ยืนยัน (ยกเลิกซ้ำได้ผลเดิม) */
  function cancel(params, call) {
    var found = findOwned(params, call);
    if (found.row.draft_status === 'CANCELLED') return toPublic(found.row);
    assertPending(found, call);
    var draftId = found.row.draft_id;
    Operation.run({ operationType: 'API_DRAFT_CANCEL', idempotencyKey: 'api-draft-cancel-' + draftId, payload: { draft_id: draftId }, actor: call.actor }, function (ctx) {
      var current = findDraft(draftId);
      if (current.row.draft_status === 'PENDING') setStatus(current, 'CANCELLED', ctx);
      else if (current.row.draft_status !== 'CANCELLED') throw Util.AppError('DRAFT_NOT_PENDING', 'ร่างรายการนี้' + (STATUS_LABEL[current.row.draft_status] || 'ไม่อยู่ในสถานะรอยืนยัน'));
      return { draft_id: draftId };
    });
    return toPublic(findDraft(draftId).row);
  }

  return {
    TYPES: TYPES,
    masters: mastersFor,
    create: create,
    confirm: confirm,
    cancel: cancel
  };
})();

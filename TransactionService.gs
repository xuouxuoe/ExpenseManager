/**
 * TransactionService.gs — ธุรกรรมจริง (Transactions)
 * - กฎบัญชีต้นทาง/ปลายทาง/หมวดหมู่ตามประเภท: docs/business-rules.md §3.2, §3.3
 * - ไม่มีการลบจริง: ใช้การกลับรายการ (reversal_of) ที่มีผลตรงข้ามกับรายการต้นฉบับ
 * - Backend เติมชื่อจาก Master (ProjectionService); client ส่งเฉพาะ ID
 * - เตือนรายการที่อาจซ้ำ (วันที่ + ยอด + บัญชี + ชื่อรายการ) ก่อนบันทึก
 */
var Ledger = (function () {
  var ASSET = ['CASH', 'BANK', 'E_WALLET'];
  var LIABILITY = ['CREDIT_CARD', 'CASH_CARD', 'LOAN'];

  function isAsset(type) { return ASSET.indexOf(type) >= 0; }
  function isLiability(type) { return LIABILITY.indexOf(type) >= 0; }

  /**
   * ผลทางบัญชีของธุรกรรมหนึ่งรายการ (หน่วยสตางค์)
   * balance ของบัญชีสินทรัพย์ = เงินคงเหลือ; ของบัญชีหนี้สิน = ยอดหนี้คงค้าง (ค่าบวก)
   * รายการกลับรายการ (reversal_of ไม่ว่าง) มีผลตรงข้ามทุกค่า
   * คืน { accounts: { accountId: deltaSatang }, incomeSatang, expenseSatang }
   */
  function effectsOf(tx, accountTypeById) {
    var a = Validation.toSatang(tx.amount, 'amount');
    var sign = Validation.isBlank(tx.reversal_of) ? 1 : -1;
    var out = { accounts: {}, incomeSatang: 0, expenseSatang: 0 };

    function move(accountId, delta) {
      if (Validation.isBlank(accountId)) return;
      out.accounts[accountId] = (out.accounts[accountId] || 0) + delta * sign;
    }
    function typeOf(id) { return accountTypeById[id] || ''; }

    switch (tx.transaction_type) {
      case 'INCOME': move(tx.to_account_id, a); out.incomeSatang = a; break;
      case 'EXPENSE': move(tx.from_account_id, -a); out.expenseSatang = a; break;
      case 'TRANSFER': move(tx.from_account_id, -a); move(tx.to_account_id, a); break;
      case 'CREDIT_PURCHASE': move(tx.from_account_id, a); out.expenseSatang = a; break;
      case 'CREDIT_PAYMENT': move(tx.from_account_id, -a); move(tx.to_account_id, -a); break;
      case 'CASH_ADVANCE': move(tx.from_account_id, a); move(tx.to_account_id, a); break;
      case 'INTEREST':
      case 'FEE':
        move(tx.from_account_id, isLiability(typeOf(tx.from_account_id)) ? a : -a);
        out.expenseSatang = a;
        break;
      case 'REFUND':
        move(tx.to_account_id, isLiability(typeOf(tx.to_account_id)) ? -a : a);
        out.expenseSatang = -a;
        break;
      case 'ADJUSTMENT': move(tx.from_account_id, -a); move(tx.to_account_id, a); break;
      default: throw Util.AppError('VALIDATION_ENUM', 'ประเภทธุรกรรมไม่ถูกต้อง', { field: 'transaction_type' });
    }
    out.incomeSatang *= sign;
    out.expenseSatang *= sign;
    return out;
  }

  /** ยอดคงเหลือทุกบัญชี (satang): opening_balance + ผลของธุรกรรมทั้งหมด */
  function balances(accounts, transactions) {
    var typeById = {};
    var bal = {};
    accounts.forEach(function (acc) {
      typeById[acc.account_id] = acc.account_type;
      bal[acc.account_id] = Validation.toSatang(Validation.isBlank(acc.opening_balance) ? 0 : acc.opening_balance, 'opening_balance', { allowZero: true });
    });
    transactions.forEach(function (tx) {
      var eff = effectsOf(tx, typeById);
      Object.keys(eff.accounts).forEach(function (id) { bal[id] = (bal[id] || 0) + eff.accounts[id]; });
    });
    return bal;
  }

  return { ASSET: ASSET, LIABILITY: LIABILITY, isAsset: isAsset, isLiability: isLiability, effectsOf: effectsOf, balances: balances };
})();

var Transactions = (function () {
  var SHEET = 'Transactions';
  var CLIENT_SOURCES = ['MANUAL', 'QUICK_ENTRY'];
  var PAGE_SIZE_DEFAULT = 50;
  var PAGE_SIZE_MAX = 200;

  /**
   * กฎตามประเภท (business-rules §3.2)
   * from/to: null = ต้องว่าง; { classes: ['ASSET'|'LIABILITY'], types?: [...] }
   * category: null = ต้องว่าง; 'INCOME' | 'EXPENSE'
   */
  var ANY = { classes: ['ASSET', 'LIABILITY'] };
  var ASSET_ONLY = { classes: ['ASSET'] };
  var LIABILITY_ONLY = { classes: ['LIABILITY'] };
  var RULES = {
    INCOME: { from: null, to: ASSET_ONLY, category: 'INCOME' },
    EXPENSE: { from: ASSET_ONLY, to: null, category: 'EXPENSE' },
    TRANSFER: { from: ASSET_ONLY, to: ASSET_ONLY, category: null, distinct: true },
    CREDIT_PURCHASE: { from: LIABILITY_ONLY, to: null, category: 'EXPENSE' },
    CREDIT_PAYMENT: { from: ASSET_ONLY, to: LIABILITY_ONLY, category: null },
    CASH_ADVANCE: { from: LIABILITY_ONLY, to: ASSET_ONLY, category: null },
    INTEREST: { from: ANY, to: null, category: 'EXPENSE' },
    FEE: { from: ANY, to: null, category: 'EXPENSE' },
    REFUND: { from: null, to: ANY, category: 'EXPENSE' },
    ADJUSTMENT: { from: 'OPTIONAL', to: 'OPTIONAL', category: null, exactlyOneAccount: true, noteRequired: true }
  };

  function fail(code, field, message, extra) {
    var details = { field: field };
    if (extra) Object.keys(extra).forEach(function (k) { details[k] = extra[k]; });
    return Util.AppError('VALIDATION_' + code, message, details);
  }

  function classOf(accountType) {
    if (Ledger.isAsset(accountType)) return 'ASSET';
    if (Ledger.isLiability(accountType)) return 'LIABILITY';
    return '';
  }

  /** ตรวจบัญชีหนึ่งฝั่งตามกฎ; current = ค่าเดิมเมื่อแก้ไข (Master ที่ถูกปิดภายหลังคงไว้ได้) */
  function checkAccount(rule, id, field, accounts, currentId) {
    if (rule === null) {
      if (!Validation.isBlank(id)) throw fail('RULE', field, 'ประเภทนี้ไม่ใช้ ' + field);
      return '';
    }
    var cleanId = Validation.requireId(id, field, { required: rule !== 'OPTIONAL' });
    if (!cleanId) return '';
    var acc = accounts[cleanId];
    if (!acc) throw fail('FK_NOT_FOUND', field, 'ไม่พบบัญชีที่เลือกใน ' + field);
    if (!acc.isActive && cleanId !== currentId) throw fail('FK_INACTIVE', field, 'บัญชีที่เลือกใน ' + field + ' ถูกปิดใช้งานแล้ว');
    if (rule !== 'OPTIONAL' && rule.classes.indexOf(classOf(acc.type)) < 0) {
      var want = rule.classes.length === 2 ? 'บัญชีใดก็ได้' : (rule.classes[0] === 'ASSET' ? 'บัญชีเงินสด/ธนาคาร/อี-วอลเล็ต' : 'บัตรเครดิต/บัตรกดเงินสด/สินเชื่อ');
      throw fail('RULE', field, field + ' ต้องเป็น' + want);
    }
    return cleanId;
  }

  /** ตรวจ input ของธุรกรรม (รับเฉพาะ field ที่อนุญาต) */
  function validate(input, masters, current) {
    if (!input || typeof input !== 'object') throw fail('REQUIRED', 'input', 'ไม่พบข้อมูลที่ต้องบันทึก');
    var cur = current || {};
    var type = Validation.requireEnum(input.transaction_type, Config.ENUMS.TRANSACTION_TYPE, 'transaction_type');
    var rule = RULES[type];
    var from = checkAccount(rule.from, input.from_account_id, 'from_account_id', masters.accounts, cur.from_account_id);
    var to = checkAccount(rule.to, input.to_account_id, 'to_account_id', masters.accounts, cur.to_account_id);
    if (rule.distinct && from === to) throw fail('RULE', 'to_account_id', 'บัญชีต้นทางและปลายทางต้องไม่ใช่บัญชีเดียวกัน');
    if (rule.exactlyOneAccount && (!!from === !!to)) {
      throw fail('RULE', 'from_account_id', 'รายการปรับยอดต้องระบุบัญชีต้นทางหรือปลายทางอย่างใดอย่างหนึ่ง');
    }

    var categoryId = '';
    if (rule.category === null) {
      if (!Validation.isBlank(input.category_id)) throw fail('RULE', 'category_id', 'ประเภทนี้ไม่ใช้หมวดหมู่');
    } else {
      categoryId = Validation.requireId(input.category_id, 'category_id');
      var cat = masters.categories[categoryId];
      if (!cat) throw fail('FK_NOT_FOUND', 'category_id', 'ไม่พบหมวดหมู่ที่เลือก');
      if (!cat.isActive && categoryId !== cur.category_id) throw fail('FK_INACTIVE', 'category_id', 'หมวดหมู่ที่เลือกถูกปิดใช้งานแล้ว');
      if (cat.type !== rule.category) {
        throw fail('RULE', 'category_id', 'ต้องเลือกหมวดหมู่ประเภท' + (rule.category === 'INCOME' ? 'รายรับ' : 'รายจ่าย'));
      }
    }

    var ownerId = Validation.requireId(input.owner_id, 'owner_id');
    var owner = masters.owners[ownerId];
    if (!owner) throw fail('FK_NOT_FOUND', 'owner_id', 'ไม่พบเจ้าของที่เลือก');
    if (!owner.isActive && ownerId !== cur.owner_id) throw fail('FK_INACTIVE', 'owner_id', 'เจ้าของที่เลือกถูกปิดใช้งานแล้ว');

    var note = Validation.requireText(input.note, 'note', { max: Config.TEXT_LIMITS.NOTE, multiline: true, required: !!rule.noteRequired });
    var source = Validation.isBlank(input.source) ? (cur.source || 'MANUAL') : Validation.requireEnum(input.source, CLIENT_SOURCES, 'source');

    return {
      transaction_date: Validation.requireDate(input.transaction_date, 'transaction_date'),
      transaction_type: type,
      from_account_id: from,
      to_account_id: to,
      owner_id: ownerId,
      category_id: categoryId,
      item_name: Validation.requireText(input.item_name, 'item_name', { required: true, max: Config.TEXT_LIMITS.ITEM_NAME }),
      description: Validation.requireText(input.description, 'description', { max: Config.TEXT_LIMITS.DESCRIPTION, multiline: true }),
      amount: Validation.fromSatang(Validation.toSatang(input.amount, 'amount')),
      external_ref: Validation.requireText(input.external_ref, 'external_ref', { max: Config.TEXT_LIMITS.EXTERNAL_REF }),
      source: source,
      note: note
    };
  }

  function normalize(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** รายการที่อาจซ้ำ: วันที่ ยอด ประเภท บัญชี และชื่อรายการเดียวกัน (ไม่นับรายการกลับรายการและตัวเอง) */
  function findPossibleDuplicates(rows, candidate, selfId) {
    return rows.filter(function (r) {
      return r.transaction_id !== selfId &&
        Validation.isBlank(r.reversal_of) &&
        r.transaction_date === candidate.transaction_date &&
        r.transaction_type === candidate.transaction_type &&
        Validation.toSatang(r.amount, 'amount') === Validation.toSatang(candidate.amount, 'amount') &&
        r.from_account_id === candidate.from_account_id &&
        r.to_account_id === candidate.to_account_id &&
        normalize(r.item_name) === normalize(candidate.item_name);
    });
  }

  function reversedIds(rows) {
    var out = {};
    rows.forEach(function (r) { if (!Validation.isBlank(r.reversal_of)) out[r.reversal_of] = r.transaction_id; });
    return out;
  }

  function findById(rows, id) {
    var cleanId = Validation.requireId(id, 'transaction_id');
    for (var i = 0; i < rows.length; i++) if (rows[i].transaction_id === cleanId) return rows[i];
    throw Util.AppError('NOT_FOUND', 'ไม่พบรายการที่ต้องการ');
  }

  function assertEditable(row, rows) {
    if (!Validation.isBlank(row.reversal_of)) throw fail('RULE', 'transaction_id', 'รายการกลับรายการแก้ไขไม่ได้');
    if (reversedIds(rows)[row.transaction_id]) throw fail('RULE', 'transaction_id', 'รายการนี้ถูกกลับรายการแล้ว แก้ไขไม่ได้');
    if (!Validation.isBlank(row.plan_id)) throw fail('RULE', 'transaction_id', 'รายการที่เชื่อมกับแผนชำระต้องแก้ไขผ่านแผนชำระ');
    var allocated = Database.readAll('PaymentAllocations').rows.some(function (a) { return a.transaction_id === row.transaction_id; });
    if (allocated) throw fail('RULE', 'transaction_id', 'รายการนี้ถูกจัดสรรให้งวดชำระแล้ว ให้ใช้การกลับรายการแทน');
  }

  function stripControl(input) {
    var copy = {};
    Object.keys(input || {}).forEach(function (k) { if (k !== 'allow_duplicate') copy[k] = input[k]; });
    return copy;
  }

  function requestOf(request, operationType, payload, recoveryData) {
    return { operationType: operationType, idempotencyKey: request.idempotencyKey, payload: payload, actor: request.actor, recoveryData: recoveryData };
  }

  // ---------- คำสั่ง ----------

  /** input.allow_duplicate = true เพื่อยืนยันบันทึกแม้พบรายการที่อาจซ้ำ */
  function create(input, request) {
    return Operation.run(requestOf(request, 'CREATE_TRANSACTION', input), function (ctx) {
      var id = ctx.id('transaction');
      var rows = Database.readAll(SHEET).rows;
      var existing = rows.filter(function (r) { return r.transaction_id === id; })[0];
      if (existing) return existing; // replay หลังเขียนสำเร็จแล้ว
      var masters = Projection.loadMasters();
      var row = validate(stripControl(input), masters, null);
      var dups = findPossibleDuplicates(rows, row, id);
      if (dups.length && input.allow_duplicate !== true) {
        throw fail('POSSIBLE_DUPLICATE', 'item_name', 'พบรายการที่อาจซ้ำ ' + dups.length + ' รายการ', {
          duplicates: dups.slice(0, 3).map(function (d) { return { transaction_id: d.transaction_id, transaction_date: d.transaction_date, item_name: d.item_name, amount: d.amount }; })
        });
      }
      row.transaction_id = id;
      row.plan_id = '';
      row.reversal_of = '';
      row.created_at = ctx.now;
      row.updated_at = ctx.now;
      Projection.apply(SHEET, row, masters);
      Database.appendRowsIfAbsent(SHEET, [row]);
      return findById(Database.readAll(SHEET).rows, id);
    }).result;
  }

  /** แก้ไขรายการที่ยังไม่ถูกกลับรายการ/ไม่เชื่อมแผน; ข้อมูลก่อนแก้เก็บใน recovery_data (ฝั่ง server เท่านั้น) */
  function update(id, input, request) {
    var before = findById(Database.readAll(SHEET).rows, id);
    return Operation.run(requestOf(request, 'UPDATE_TRANSACTION', { id: id, input: input }, { before: before }), function (ctx) {
      var rows = Database.readAll(SHEET).rows;
      var current = findById(rows, id);
      assertEditable(current, rows);
      var masters = Projection.loadMasters();
      var clean = validate(stripControl(input), masters, current);
      var updated = Object.assign({}, current, clean, { updated_at: ctx.now });
      var dups = findPossibleDuplicates(rows, updated, current.transaction_id);
      if (dups.length && input.allow_duplicate !== true) {
        throw fail('POSSIBLE_DUPLICATE', 'item_name', 'พบรายการที่อาจซ้ำ ' + dups.length + ' รายการ', {
          duplicates: dups.slice(0, 3).map(function (d) { return { transaction_id: d.transaction_id, transaction_date: d.transaction_date, item_name: d.item_name, amount: d.amount }; })
        });
      }
      Projection.apply(SHEET, updated, masters);
      Database.updateRows(SHEET, [updated]);
      return findById(Database.readAll(SHEET).rows, current.transaction_id);
    }).result;
  }

  /**
   * กลับรายการ (แทนการลบ): สร้างรายการใหม่ที่ reversal_of = รายการต้นฉบับ และมีผลตรงข้าม
   * input: { reason (บังคับ), transaction_date (ไม่บังคับ, ค่าเริ่มต้น = วันนี้) }
   */
  function reverse(id, input, request) {
    return Operation.run(requestOf(request, 'REVERSE_TRANSACTION', { id: id, input: input }), function (ctx) {
      var newId = ctx.id('reversal');
      var rows = Database.readAll(SHEET).rows;
      var existing = rows.filter(function (r) { return r.transaction_id === newId; })[0];
      if (existing) return existing;
      var original = findById(rows, id);
      if (!Validation.isBlank(original.reversal_of)) throw fail('RULE', 'transaction_id', 'รายการกลับรายการกลับซ้ำไม่ได้');
      if (reversedIds(rows)[original.transaction_id]) throw fail('RULE', 'transaction_id', 'รายการนี้ถูกกลับรายการแล้ว');
      if (original.plan_id && Database.findRowsByValue('PaymentAllocations', 'transaction_id', original.transaction_id).length) {
        throw fail('RULE', 'transaction_id', 'ธุรกรรมนี้จัดสรรให้งวดชำระแล้ว ต้องจัดการผ่านแผนชำระ');
      }
      var reason = Validation.requireText(input && input.reason, 'reason', { required: true, max: Config.TEXT_LIMITS.NOTE, multiline: true });
      var date = Validation.isBlank(input && input.transaction_date) ? Util.todayIso() : Validation.requireDate(input.transaction_date, 'transaction_date');
      if (date < original.transaction_date) throw fail('RULE', 'transaction_date', 'วันที่กลับรายการต้องไม่ก่อนวันที่ของรายการต้นฉบับ');
      var reversal = Object.assign({}, original, {
        transaction_id: newId,
        transaction_date: date,
        item_name: ('กลับรายการ: ' + original.item_name).slice(0, Config.TEXT_LIMITS.ITEM_NAME),
        reversal_of: original.transaction_id,
        external_ref: '',
        source: 'MANUAL',
        note: reason,
        created_at: ctx.now,
        updated_at: ctx.now
      });
      Projection.apply(SHEET, reversal, Projection.loadMasters());
      Database.appendRowsIfAbsent(SHEET, [reversal]);
      return findById(Database.readAll(SHEET).rows, newId);
    }).result;
  }

  /**
   * ค้นหา/กรอง/แบ่งหน้า
   * filters: { date_from, date_to, transaction_type, account_id, owner_id, category_id, q, page, page_size }
   * คืน { rows, total, page, pageSize, hasMore, summary: { income, expense, net } }
   * rows มี flag is_reversed (ถูกกลับรายการแล้ว) สำหรับหน้าจอ
   */
  function list(filters) {
    var f = filters || {};
    var dateFrom = Validation.requireDate(f.date_from, 'date_from', { required: false });
    var dateTo = Validation.requireDate(f.date_to, 'date_to', { required: false });
    var type = Validation.requireEnum(f.transaction_type, Config.ENUMS.TRANSACTION_TYPE, 'transaction_type', { required: false });
    var accountId = Validation.requireId(f.account_id, 'account_id', { required: false });
    var ownerId = Validation.requireId(f.owner_id, 'owner_id', { required: false });
    var categoryId = Validation.requireId(f.category_id, 'category_id', { required: false });
    var q = normalize(Validation.requireText(f.q, 'q', { max: 100 }));
    var page = Validation.isBlank(f.page) ? 1 : Validation.requireInt(f.page, 'page', { min: 1 });
    var pageSize = Validation.isBlank(f.page_size) ? PAGE_SIZE_DEFAULT : Validation.requireInt(f.page_size, 'page_size', { min: 1, max: PAGE_SIZE_MAX });

    var rows = Database.readAll(SHEET).rows;
    var reversed = reversedIds(rows);
    var accountTypes = {};
    Database.readAll('Accounts').rows.forEach(function (a) { accountTypes[a.account_id] = a.account_type; });

    var matched = rows.filter(function (r) {
      if (dateFrom && r.transaction_date < dateFrom) return false;
      if (dateTo && r.transaction_date > dateTo) return false;
      if (type && r.transaction_type !== type) return false;
      if (accountId && r.from_account_id !== accountId && r.to_account_id !== accountId) return false;
      if (ownerId && r.owner_id !== ownerId) return false;
      if (categoryId && r.category_id !== categoryId) return false;
      if (q) {
        var hay = normalize([r.item_name, r.description, r.note, r.from_account_name, r.to_account_name, r.category_name, r.owner_name, r.external_ref].join(' '));
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) {
      if (a.transaction_date !== b.transaction_date) return a.transaction_date < b.transaction_date ? 1 : -1;
      return a.created_at < b.created_at ? 1 : (a.created_at > b.created_at ? -1 : 0);
    });

    var income = 0;
    var expense = 0;
    matched.forEach(function (r) {
      var eff = Ledger.effectsOf(r, accountTypes);
      income += eff.incomeSatang;
      expense += eff.expenseSatang;
    });

    var start = (page - 1) * pageSize;
    var pageRows = matched.slice(start, start + pageSize).map(function (r) {
      return Object.assign({}, r, { is_reversed: !!reversed[r.transaction_id] });
    });
    return {
      rows: pageRows,
      total: matched.length,
      page: page,
      pageSize: pageSize,
      hasMore: start + pageSize < matched.length,
      summary: {
        income: Validation.fromSatang(income),
        expense: Validation.fromSatang(expense),
        net: Validation.fromSatang(income - expense)
      }
    };
  }

  /** ยอดคงเหลือทุกบัญชี (บาท) */
  function accountBalances() {
    var accounts = Database.readAll('Accounts').rows;
    var bal = Ledger.balances(accounts, Database.readAll(SHEET).rows);
    var out = {};
    Object.keys(bal).forEach(function (id) { out[id] = Validation.fromSatang(bal[id]); });
    return out;
  }

  /**
   * ตัวช่วยกรอก: แม่แบบรายการจากประวัติจริง (ไม่เก็บข้อมูลเพิ่ม ไม่เปลี่ยน schema)
   * - กลุ่มรายการด้วย ประเภท + ชื่อรายการ + บัญชีต้นทาง/ปลายทาง + หมวด + เจ้าของ
   * - ไม่นับรายการกลับรายการ/ที่ถูกกลับแล้ว และตัดกลุ่มที่ใช้ Master ที่ปิดใช้งานแล้ว
   * - recent: ใช้ล่าสุด; frequent ("ใช้ประจำ"): เกิดใน ≥ 2 เดือน หรือ ≥ 3 ครั้ง ภายใน lookback_days
   * options: { limit (1–20, ค่าเริ่มต้น 8), lookback_days (30–730, ค่าเริ่มต้น 180), today }
   */
  function suggestions(options) {
    var o = options || {};
    var limit = Validation.isBlank(o.limit) ? 8 : Validation.requireInt(o.limit, 'limit', { min: 1, max: 20 });
    var lookback = Validation.isBlank(o.lookback_days) ? 180 : Validation.requireInt(o.lookback_days, 'lookback_days', { min: 30, max: 730 });
    var today = Validation.isBlank(o.today) ? Util.todayIso() : Validation.requireDate(o.today, 'today');
    var t = today.split('-');
    var since = new Date(Date.UTC(Number(t[0]), Number(t[1]) - 1, Number(t[2]) - lookback)).toISOString().slice(0, 10);

    var masters = Projection.loadMasters();
    function activeAccount(id) { return Validation.isBlank(id) || (masters.accounts[id] && masters.accounts[id].isActive); }
    function activeCategory(id) { return Validation.isBlank(id) || (masters.categories[id] && masters.categories[id].isActive); }
    function activeOwner(id) { return masters.owners[id] && masters.owners[id].isActive; }

    var rows = Database.readAll(SHEET).rows;
    var reversed = reversedIds(rows);
    var groups = {};
    rows.forEach(function (r) {
      if (!Validation.isBlank(r.reversal_of) || reversed[r.transaction_id]) return;
      if (r.transaction_date < since || r.transaction_date > today) return;
      if (r.transaction_type === 'ADJUSTMENT') return;
      if (!activeAccount(r.from_account_id) || !activeAccount(r.to_account_id) || !activeCategory(r.category_id) || !activeOwner(r.owner_id)) return;
      var key = [r.transaction_type, normalize(r.item_name), r.from_account_id, r.to_account_id, r.category_id, r.owner_id].join('|');
      var g = groups[key];
      if (!g) {
        g = groups[key] = { count: 0, months: {}, last: null };
      }
      g.count++;
      g.months[r.transaction_date.slice(0, 7)] = true;
      if (!g.last || r.transaction_date > g.last.transaction_date ||
          (r.transaction_date === g.last.transaction_date && r.created_at > g.last.created_at)) {
        g.last = r;
      }
    });

    var list = Object.keys(groups).map(function (k) {
      var g = groups[k];
      var r = g.last;
      return {
        transaction_type: r.transaction_type,
        item_name: r.item_name,
        from_account_id: r.from_account_id,
        from_account_name: r.from_account_id ? masters.accounts[r.from_account_id].name : '',
        to_account_id: r.to_account_id,
        to_account_name: r.to_account_id ? masters.accounts[r.to_account_id].name : '',
        category_id: r.category_id,
        category_name: r.category_id ? masters.categories[r.category_id].name : '',
        owner_id: r.owner_id,
        owner_name: masters.owners[r.owner_id].name,
        amount: r.amount,
        count: g.count,
        month_count: Object.keys(g.months).length,
        last_date: r.transaction_date,
        last_created_at: r.created_at
      };
    });

    var recent = list.slice().sort(function (a, b) {
      if (a.last_date !== b.last_date) return a.last_date < b.last_date ? 1 : -1;
      return a.last_created_at < b.last_created_at ? 1 : -1;
    }).slice(0, limit);
    var frequent = list.filter(function (s) { return s.month_count >= 2 || s.count >= 3; }).sort(function (a, b) {
      if (a.month_count !== b.month_count) return b.month_count - a.month_count;
      if (a.count !== b.count) return b.count - a.count;
      return a.last_date < b.last_date ? 1 : -1;
    }).slice(0, limit);

    function strip(s) {
      var copy = Object.assign({}, s);
      delete copy.last_created_at;
      return copy;
    }
    return { recent: recent.map(strip), frequent: frequent.map(strip) };
  }

  return {
    RULES: RULES,
    validate: validate,
    create: create,
    update: update,
    reverse: reverse,
    list: list,
    accountBalances: accountBalances,
    suggestions: suggestions
  };
})();

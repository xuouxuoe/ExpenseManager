/**
 * BudgetService.gs — งบใช้จ่ายรายเดือน แบ่งรายสัปดาห์ พร้อมยอดยกข้ามสัปดาห์ (อนุมัติ 2026-11-26)
 *
 * - ยอดใช้ไป = รายจ่ายที่รับรู้ (Ledger.effectsOf) ของหมวดในงบ ในเดือนของงบ (และเจ้าของ ถ้าระบุ)
 *   รายการกลับรายการหักออกตามวันที่ของรายการกลับ เหมือนรายงานอื่น
 * - สัปดาห์ = วันที่ 1–7, 8–14, 15–21, 22–28, 29–สิ้นเดือน
 * - งบต่อสัปดาห์: weekly_amount ต่อสัปดาห์ สัปดาห์สุดท้ายได้ส่วนที่เหลือของงบเดือน (ไม่ติดลบ)
 *   ถ้าไม่ระบุ weekly_amount แบ่งงบเดือนตามจำนวนวันของแต่ละสัปดาห์
 * - ยกยอด: สัปดาห์นี้ใช้ได้ = งบสะสมถึงสัปดาห์นี้ − ใช้ไปตั้งแต่ต้นเดือนถึงสิ้นสัปดาห์นี้
 * - แก้หมวดของงบ = ปิดงบเดิม (is_active = FALSE) แล้วสร้างงบใหม่ ไม่ลบแถว
 *
 * งบทริป/โครงการ (budget_kind = EVENT, อนุมัติ 2026-11-27, docs/event-budget-plan.md)
 * - ช่วงวันที่ start_date–end_date ไม่ใช้หมวด: ใช้ไป = รายจ่ายของรายการที่ Transactions.budget_id ตรงกับงบ (ไม่จำกัดวันที่/หมวด/บัญชี)
 * - รายการที่ใช้จากงบทริปไม่นับในงบรายเดือน
 */
var Budgets = (function () {
  var SHEET = 'Budgets';
  var LINKS = 'BudgetCategories';
  var MAX_CATEGORIES = 50;

  function sat(v) { return Validation.toSatang(v, 'amount', { allowZero: true }); }
  function baht(v) { return Validation.fromSatang(v); }
  function fail(field, message) { return Util.AppError('VALIDATION_BUDGET', message, { field: field }); }

  function daysIn(ym) {
    return new Date(Math.floor(ym / 100), ym % 100, 0).getDate();
  }

  /** ช่วงสัปดาห์ของเดือนและงบที่จัดสรร (สตางค์) */
  function weeksOf(ym, amount, weekly) {
    var days = daysIn(ym);
    var weeks = [];
    for (var start = 1; start <= days; start += 7) weeks.push({ no: weeks.length + 1, start: start, end: Math.min(days, start + 6) });
    var left = amount;
    weeks.forEach(function (w, i) {
      var last = i === weeks.length - 1;
      var share = weekly > 0 ? weekly : Math.round(amount * (w.end - w.start + 1) / days);
      w.alloc = last ? Math.max(0, left) : Math.min(share, Math.max(0, left));
      left -= w.alloc;
    });
    return weeks;
  }

  function isMonthly(b) {
    return !b.budget_kind || b.budget_kind === 'MONTHLY';
  }

  function read() {
    return { budgets: Database.readAll(SHEET).rows, links: Database.readAll(LINKS).rows };
  }

  function categoriesOf(state, budgetId) {
    return state.links.filter(function (l) { return l.budget_id === budgetId; });
  }

  /** ยอดใช้ไปรายวันของงบ (สตางค์) คีย์ = วันที่ของเดือน */
  function spentByDay(budget, categoryIds, transactions, types) {
    var set = Object.create(null);
    categoryIds.forEach(function (id) { set[id] = true; });
    var out = Object.create(null);
    transactions.forEach(function (t) {
      if (!set[t.category_id]) return;
      if (t.budget_id) return; // ใช้จากงบทริปแล้ว ไม่นับซ้ำในงบรายเดือน
      if (budget.owner_id && t.owner_id !== budget.owner_id) return;
      if (Number(t.transaction_date.slice(0, 7).replace('-', '')) !== budget.budget_month) return;
      var expense = Ledger.effectsOf(t, types).expenseSatang;
      if (!expense) return;
      var day = Number(t.transaction_date.slice(8, 10));
      out[day] = (out[day] || 0) + expense;
    });
    return out;
  }

  /**
   * สถานะของงบ ณ วันที่ today (YYYY-MM-DD)
   * เดือนอดีต = สรุปทั้งเดือน (current_week = สัปดาห์สุดท้าย) เดือนอนาคต = ยังไม่เริ่ม (current_week = 0)
   */
  function status(budget, links, transactions, types, today) {
    var ym = budget.budget_month;
    var amount = sat(budget.amount);
    var weeks = weeksOf(ym, amount, sat(budget.weekly_amount || 0));
    var byDay = spentByDay(budget, links.map(function (l) { return l.category_id; }), transactions, types);
    var nowYm = Number(today.slice(0, 7).replace('-', ''));
    var todayDay = Number(today.slice(8, 10));
    var days = daysIn(ym);
    var phase = ym < nowYm ? 'PAST' : ym > nowYm ? 'FUTURE' : 'CURRENT';
    var cumAlloc = 0;
    var cumSpent = 0;
    var spentMonth = 0;
    Object.keys(byDay).forEach(function (d) { spentMonth += byDay[d]; });
    var current = null;
    var out = weeks.map(function (w) {
      var spent = 0;
      for (var d = w.start; d <= w.end; d++) spent += byDay[d] || 0;
      var carryIn = cumAlloc - cumSpent;
      cumAlloc += w.alloc;
      cumSpent += spent;
      var row = { no: w.no, start: w.start, end: w.end, alloc: baht(w.alloc), carry_in: baht(carryIn),
        available: baht(w.alloc + carryIn), spent: baht(spent), remaining: baht(cumAlloc - cumSpent) };
      // เก็บยอดเหลือเป็นสตางค์ไว้คำนวณต่อวัน (อาจติดลบเมื่อใช้เกิน จึงไม่แปลงกลับผ่าน toSatang)
      if (phase === 'CURRENT' && todayDay >= w.start && todayDay <= w.end) current = { week: row, remaining: cumAlloc - cumSpent, daysLeft: w.end - todayDay + 1 };
      return row;
    });
    var remainingMonth = amount - spentMonth;
    var result = {
      budget_id: budget.budget_id, budget_month: ym, budget_name: budget.budget_name, owner_id: budget.owner_id || '',
      owner_name: budget.owner_name || '', amount: budget.amount, weekly_amount: budget.weekly_amount || 0, note: budget.note || '',
      is_active: budget.is_active === true,
      categories: links.map(function (l) { return { category_id: l.category_id, category_name: l.category_name }; }),
      phase: phase, days_in_month: days, spent: baht(spentMonth), remaining: baht(remainingMonth),
      weeks: out, current_week: current ? current.week.no : (phase === 'PAST' ? weeks.length : 0)
    };
    if (current) {
      var monthDaysLeft = days - todayDay + 1;
      result.week_remaining = current.week.remaining;
      result.week_days_left = current.daysLeft;
      result.per_day_week = baht(Math.max(0, Math.floor(current.remaining / current.daysLeft)));
      result.month_days_left = monthDaysLeft;
      result.per_day_month = baht(Math.max(0, Math.floor(remainingMonth / monthDaysLeft)));
    }
    return result;
  }

  /** งบที่ใช้งานของเดือน พร้อมสถานะ (อ่าน Accounts/Transactions จาก cache ของคำขอ) */
  function list(month, options) {
    var ym = Validation.requireYearMonth(month, 'month');
    var opts = options || {};
    // อ่าน Budgets ก่อน: เดือนที่ไม่มีงบไม่ต้องอ่านชีตหมวดของงบ (ลดการเรียก Sheets ในทุกหน้า)
    var budgets = Database.readAll(SHEET).rows;
    var active = budgets.filter(function (b) { return isMonthly(b) && b.budget_month === ym && (opts.includeInactive || b.is_active === true); });
    if (!active.length) return [];
    var state = { budgets: budgets, links: Database.readAll(LINKS).rows };
    var types = Object.create(null);
    Database.readAll('Accounts').rows.forEach(function (a) { types[a.account_id] = a.account_type; });
    var transactions = Database.readAll('Transactions').rows;
    var today = opts.today || Util.todayIso();
    return active.map(function (b) { return status(b, categoriesOf(state, b.budget_id), transactions, types, today); })
      .sort(function (a, b) { return String(a.budget_name).localeCompare(String(b.budget_name)); });
  }

  /** ตรวจข้อมูลงบจาก client (ไม่รับ *_name) */
  function validate(input, masters) {
    var f = input || {};
    var month = Validation.requireYearMonth(f.budget_month, 'budget_month');
    var name = Validation.requireText(f.budget_name, 'budget_name', { required: true, max: Config.TEXT_LIMITS.NAME });
    var ownerId = Validation.requireId(f.owner_id, 'owner_id', { required: false }) || '';
    if (ownerId) {
      var owner = masters.owners[ownerId];
      if (!owner || !owner.isActive) throw fail('owner_id', 'เจ้าของที่เลือกใช้ไม่ได้');
    }
    var amount = Validation.toSatang(f.amount, 'amount');
    var weekly = Validation.isBlank(f.weekly_amount) ? 0 : Validation.toSatang(f.weekly_amount, 'weekly_amount', { allowZero: true });
    if (weekly > amount) throw fail('weekly_amount', 'งบต่อสัปดาห์ต้องไม่เกินงบทั้งเดือน');
    var ids = Array.isArray(f.category_ids) ? f.category_ids : [];
    if (!ids.length) throw fail('category_ids', 'กรุณาเลือกหมวดหมู่อย่างน้อยหนึ่งหมวด');
    if (ids.length > MAX_CATEGORIES) throw fail('category_ids', 'เลือกหมวดได้ไม่เกิน ' + MAX_CATEGORIES + ' หมวด');
    var seen = Object.create(null);
    var categoryIds = ids.map(function (raw) {
      var id = Validation.requireId(raw, 'category_ids');
      var c = masters.categories[id];
      if (!c || c.type !== 'EXPENSE') throw fail('category_ids', 'เลือกได้เฉพาะหมวดรายจ่าย');
      if (seen[id]) throw fail('category_ids', 'หมวดที่เลือกซ้ำกัน');
      seen[id] = true;
      return id;
    });
    return { budget_month: month, budget_name: name, owner_id: ownerId, amount: baht(amount), weekly_amount: baht(weekly),
      note: Validation.requireText(f.note, 'note', { max: Config.TEXT_LIMITS.NOTE, multiline: true }), category_ids: categoryIds };
  }

  function linkRows(ctx, budgetId, categoryIds, masters, at) {
    return categoryIds.map(function (id, i) {
      return Projection.apply(LINKS, { budget_category_id: ctx.id(LINKS, 'budget-category-' + budgetId + '-' + i), budget_id: budgetId,
        category_id: id, created_at: at }, masters);
    });
  }

  function newBudget(ctx, clean, masters, label) {
    var id = ctx.id(SHEET, label || 'budget');
    var row = Projection.apply(SHEET, { budget_id: id, budget_month: clean.budget_month, budget_name: clean.budget_name,
      owner_id: clean.owner_id, amount: clean.amount, weekly_amount: clean.weekly_amount, note: clean.note, is_active: true,
      budget_kind: 'MONTHLY', start_date: '', end_date: '', created_at: ctx.now, updated_at: ctx.now }, masters);
    return { row: row, links: linkRows(ctx, id, clean.category_ids, masters, ctx.now) };
  }

  /**
   * สร้างหรือแก้งบ: input.budget_id ว่าง = สร้างใหม่
   * แก้ชื่อ/เจ้าของ/ยอด/หมายเหตุ = แก้แถวเดิม; เปลี่ยนเดือนหรือชุดหมวด = ปิดงบเดิมแล้วสร้างงบใหม่
   */
  function save(input, request) {
    return Operation.run({ operationType: 'SAVE_BUDGET', idempotencyKey: request.idempotencyKey, actor: request.actor, payload: input },
      function (ctx) {
        var masters = Projection.loadMasters();
        var clean = validate(input, masters);
        var state = read();
        var id = Validation.requireId(input && input.budget_id, 'budget_id', { required: false });
        if (!id) {
          var created = newBudget(ctx, clean, masters);
          Database.appendRowsIfAbsent(SHEET, [created.row]);
          Database.appendRowsIfAbsent(LINKS, created.links);
          return { budget_id: created.row.budget_id };
        }
        var current = state.budgets.find(function (b) { return b.budget_id === id; });
        if (!current || !isMonthly(current)) throw Util.AppError('NOT_FOUND', 'ไม่พบงบที่ต้องการแก้');
        if (!current.is_active) throw fail('budget_id', 'งบนี้ถูกปิดแล้ว');
        var oldIds = categoriesOf(state, id).map(function (l) { return l.category_id; }).sort();
        var sameSet = oldIds.join('|') === clean.category_ids.slice().sort().join('|');
        if (sameSet && clean.budget_month === current.budget_month) {
          var updated = Projection.apply(SHEET, Object.assign({}, current, { budget_name: clean.budget_name, owner_id: clean.owner_id,
            amount: clean.amount, weekly_amount: clean.weekly_amount, note: clean.note, updated_at: ctx.now }), masters);
          Database.updateRows(SHEET, [updated]);
          return { budget_id: id };
        }
        // เปลี่ยนหมวดหรือเดือน: เขียนงบใหม่ก่อน แล้วปิดงบเดิม (retry ใช้ ID เดิมจาก ctx.id จึงไม่สร้างซ้ำ)
        var replacement = newBudget(ctx, clean, masters, 'budget-replacement');
        Database.appendRowsIfAbsent(SHEET, [replacement.row]);
        Database.appendRowsIfAbsent(LINKS, replacement.links);
        Database.updateRows(SHEET, [Object.assign({}, current, { is_active: false, updated_at: ctx.now })]);
        return { budget_id: replacement.row.budget_id, replaced: id };
      }).result;
  }

  function setActive(budgetId, active, request) {
    var id = Validation.requireId(budgetId, 'budget_id');
    var on = Validation.requireBoolean(active, 'is_active');
    return Operation.run({ operationType: 'SET_BUDGET_ACTIVE', idempotencyKey: request.idempotencyKey, actor: request.actor,
      payload: { budget_id: id, is_active: on } }, function (ctx) {
      var current = read().budgets.find(function (b) { return b.budget_id === id; });
      if (!current) throw Util.AppError('NOT_FOUND', 'ไม่พบงบที่ต้องการ');
      if (current.is_active !== on) Database.updateRows(SHEET, [Object.assign({}, current, { is_active: on, updated_at: ctx.now })]);
      return { budget_id: id, is_active: on };
    }).result;
  }

  /** คัดลอกงบที่ใช้งานของเดือนต้นทางไปเดือนปลายทาง ข้ามชื่อที่มีอยู่แล้วในเดือนปลายทาง */
  function copyMonth(fromMonth, toMonth, request) {
    var from = Validation.requireYearMonth(fromMonth, 'from_month');
    var to = Validation.requireYearMonth(toMonth, 'to_month');
    if (from === to) throw fail('to_month', 'เดือนต้นทางและปลายทางต้องต่างกัน');
    return Operation.run({ operationType: 'COPY_BUDGETS', idempotencyKey: request.idempotencyKey, actor: request.actor,
      payload: { from: from, to: to } }, function (ctx) {
      var masters = Projection.loadMasters();
      var state = read();
      var existing = Object.create(null);
      state.budgets.forEach(function (b) { if (b.budget_month === to && b.is_active) existing[String(b.budget_name).toLowerCase()] = true; });
      var rows = [];
      var links = [];
      state.budgets.filter(function (b) { return isMonthly(b) && b.budget_month === from && b.is_active; }).forEach(function (b, i) {
        if (existing[String(b.budget_name).toLowerCase()]) return;
        var categoryIds = categoriesOf(state, b.budget_id).map(function (l) { return l.category_id; })
          .filter(function (cid) { var c = masters.categories[cid]; return c && c.isActive; });
        if (!categoryIds.length) return;
        var copy = newBudget(ctx, { budget_month: to, budget_name: b.budget_name, owner_id: b.owner_id || '', amount: b.amount,
          weekly_amount: b.weekly_amount || 0, note: b.note || '', category_ids: categoryIds }, masters, 'budget-copy-' + i);
        rows.push(copy.row);
        links = links.concat(copy.links);
      });
      if (rows.length) {
        Database.appendRowsIfAbsent(SHEET, rows);
        Database.appendRowsIfAbsent(LINKS, links);
      }
      return { copied: rows.length };
    }).result;
  }

  // ---------- งบทริป / โครงการ (EVENT) ----------

  var MAX_EVENT_DAYS = 366;

  function dayNumber(iso) {
    var p = iso.split('-');
    return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
  }

  function validateEvent(input, masters) {
    var f = input || {};
    var name = Validation.requireText(f.budget_name, 'budget_name', { required: true, max: Config.TEXT_LIMITS.NAME });
    var ownerId = Validation.requireId(f.owner_id, 'owner_id', { required: false }) || '';
    if (ownerId) {
      var owner = masters.owners[ownerId];
      if (!owner || !owner.isActive) throw fail('owner_id', 'เจ้าของที่เลือกใช้ไม่ได้');
    }
    var amount = Validation.toSatang(f.amount, 'amount');
    var start = Validation.requireDate(f.start_date, 'start_date');
    var end = Validation.requireDate(f.end_date, 'end_date');
    if (end < start) throw fail('end_date', 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
    if (dayNumber(end) - dayNumber(start) + 1 > MAX_EVENT_DAYS) throw fail('end_date', 'ช่วงวันที่ของงบทริปต้องไม่เกิน ' + MAX_EVENT_DAYS + ' วัน');
    return { budget_name: name, owner_id: ownerId, amount: baht(amount), start_date: start, end_date: end,
      budget_month: Number(start.slice(0, 7).replace('-', '')),
      note: Validation.requireText(f.note, 'note', { max: Config.TEXT_LIMITS.NOTE, multiline: true }) };
  }

  /** รายการของงบ (รวมรายการกลับรายการ ซึ่ง Ledger ให้ผลตรงข้าม) */
  function eventTransactions(budgetId, transactions) {
    return transactions.filter(function (t) { return t.budget_id === budgetId; });
  }

  /**
   * สร้างหรือแก้งบทริป: input.budget_id ว่าง = สร้างใหม่; แก้ = แก้แถวเดิม
   * เปลี่ยนชื่อ → refresh Transactions.budget_name (projection) + audit RENAME_BUDGET
   */
  function saveEvent(input, request) {
    return Operation.run({ operationType: 'SAVE_EVENT_BUDGET', idempotencyKey: request.idempotencyKey, actor: request.actor, payload: input },
      function (ctx) {
        var masters = Projection.loadMasters();
        var clean = validateEvent(input, masters);
        var id = Validation.requireId(input && input.budget_id, 'budget_id', { required: false });
        var budgets = Database.readAll(SHEET).rows;
        function duplicateOf(selfId) {
          return budgets.some(function (b) {
            return !isMonthly(b) && b.is_active === true && b.budget_id !== selfId &&
              String(b.budget_name).trim().toLowerCase() === clean.budget_name.toLowerCase();
          });
        }
        if (!id) {
          var newId = ctx.id(SHEET, 'event-budget');
          if (budgets.some(function (b) { return b.budget_id === newId; })) return { budget_id: newId }; // replay
          if (duplicateOf(newId)) throw fail('budget_name', 'มีงบทริปชื่อนี้ที่เปิดใช้อยู่แล้ว');
          var row = Projection.apply(SHEET, Object.assign({ budget_id: newId, weekly_amount: 0, is_active: true, budget_kind: 'EVENT',
            created_at: ctx.now, updated_at: ctx.now }, clean), masters);
          Database.appendRowsIfAbsent(SHEET, [row]);
          return { budget_id: newId };
        }
        var current = budgets.find(function (b) { return b.budget_id === id; });
        if (!current || isMonthly(current)) throw Util.AppError('NOT_FOUND', 'ไม่พบงบทริปที่ต้องการแก้');
        if (!current.is_active) throw fail('budget_id', 'งบนี้ถูกปิดแล้ว เปิดใช้งานก่อนแก้ไข');
        if (duplicateOf(id)) throw fail('budget_name', 'มีงบทริปชื่อนี้ที่เปิดใช้อยู่แล้ว');
        if (clean.owner_id && clean.owner_id !== current.owner_id) {
          var mismatch = eventTransactions(id, Database.readAll('Transactions').rows).some(function (t) { return t.owner_id !== clean.owner_id; });
          if (mismatch) throw fail('owner_id', 'มีรายการของเจ้าของคนอื่นใช้งบนี้อยู่ เปลี่ยนเจ้าของงบไม่ได้');
        }
        var renamed = clean.budget_name !== current.budget_name;
        var recordRename = renamed || !!(ctx.recoveryData && ctx.recoveryData.renamed);
        if (renamed && !ctx.recoveryData) ctx.checkpoint({ renamed: true });
        var updated = Projection.apply(SHEET, Object.assign({}, current, clean, { updated_at: ctx.now }), masters);
        Database.updateRows(SHEET, [updated]);
        if (renamed || ctx.replay) Projection.refresh({ masterKeys: ['budgets'] });
        if (recordRename) {
          Audit.log({ actorId: ctx.actorId, action: 'RENAME_BUDGET', entityType: SHEET, entityId: id, operationId: ctx.operationId,
            result: 'SUCCESS', auditId: ctx.id('AuditLogs', 'budget-rename-audit'), deduplicate: ctx.replay });
        }
        return { budget_id: id };
      }).result;
  }

  /** สถานะของงบทริป ณ today: ใช้ไป คงเหลือ ช่วงเวลา และยอดแยกหมวด/บัญชี */
  function eventStatus(budget, transactions, types, today) {
    var amount = sat(budget.amount);
    var spent = 0;
    var count = 0;
    var byCategory = Object.create(null);
    var byAccount = Object.create(null);
    eventTransactions(budget.budget_id, transactions).forEach(function (t) {
      var expense = Ledger.effectsOf(t, types).expenseSatang;
      if (!t.reversal_of) count++;
      if (!expense) return;
      spent += expense;
      var cat = t.category_name || 'ไม่ระบุหมวด';
      byCategory[cat] = (byCategory[cat] || 0) + expense;
      var acc = t.from_account_name || t.to_account_name || 'ไม่ระบุบัญชี';
      byAccount[acc] = (byAccount[acc] || 0) + expense;
    });
    function rows(map) {
      return Object.keys(map).filter(function (k) { return map[k] !== 0; })
        .map(function (k) { return { name: k, amount: baht(map[k]) }; })
        .sort(function (a, b) { return b.amount - a.amount || a.name.localeCompare(b.name); });
    }
    var remaining = amount - spent;
    var t0 = dayNumber(today);
    var s0 = dayNumber(budget.start_date);
    var e0 = dayNumber(budget.end_date);
    var phase = t0 < s0 ? 'UPCOMING' : (t0 > e0 ? 'ENDED' : 'ACTIVE');
    var out = {
      budget_id: budget.budget_id, budget_kind: 'EVENT', budget_name: budget.budget_name, owner_id: budget.owner_id || '',
      owner_name: budget.owner_name || '', amount: budget.amount, note: budget.note || '', is_active: budget.is_active === true,
      start_date: budget.start_date, end_date: budget.end_date, days_total: e0 - s0 + 1, phase: phase,
      spent: baht(spent), remaining: baht(remaining), transaction_count: count,
      by_category: rows(byCategory), by_account: rows(byAccount)
    };
    if (phase === 'UPCOMING') out.days_until = s0 - t0;
    if (phase === 'ACTIVE') {
      out.days_left = e0 - t0 + 1;
      out.per_day = baht(Math.max(0, Math.floor(remaining / out.days_left)));
    }
    return out;
  }

  /**
   * งบทริป: เปิดใช้งาน (กำลังดำเนิน → กำลังจะถึง → จบแล้ว) ตามด้วยงบที่ปิด (ถ้า includeInactive)
   * options: { includeInactive, today }
   */
  function listEvents(options) {
    var opts = options || {};
    var events = Database.readAll(SHEET).rows.filter(function (b) { return !isMonthly(b) && (opts.includeInactive || b.is_active === true); });
    if (!events.length) return [];
    var types = Object.create(null);
    Database.readAll('Accounts').rows.forEach(function (a) { types[a.account_id] = a.account_type; });
    var transactions = Database.readAll('Transactions').rows;
    var today = opts.today || Util.todayIso();
    var order = { ACTIVE: 0, UPCOMING: 1, ENDED: 2 };
    return events.map(function (b) { return eventStatus(b, transactions, types, today); }).sort(function (a, b) {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      if (a.phase !== b.phase) return order[a.phase] - order[b.phase];
      return a.phase === 'ENDED' ? b.end_date.localeCompare(a.end_date) : a.start_date.localeCompare(b.start_date);
    });
  }

  /** งบทริปที่เลือกได้ในฟอร์มรายการ (เปิดใช้งาน และยังไม่จบเกิน 30 วัน) แบบย่อ */
  function eventOptions(today) {
    var day = today || Util.todayIso();
    var cutoff = dayNumber(day) - 30;
    return listEvents({ today: day }).filter(function (b) { return dayNumber(b.end_date) >= cutoff; }).map(function (b) {
      return { budget_id: b.budget_id, budget_name: b.budget_name, owner_id: b.owner_id, start_date: b.start_date, end_date: b.end_date,
        phase: b.phase, amount: b.amount, spent: b.spent, remaining: b.remaining };
    });
  }

  return { list: list, save: save, setActive: setActive, copyMonth: copyMonth, weeksOf: weeksOf, status: status,
    saveEvent: saveEvent, listEvents: listEvents, eventStatus: eventStatus, eventOptions: eventOptions };

})();

/** การกันเงินและชำระแผนรายจ่ายในอนาคต ใช้จำนวนเงินหน่วยสตางค์ */
var PaymentActivity = (function () {
  var ACTIONS = ['RESERVE', 'RELEASE', 'PAY', 'REVERSE_PAY', 'CANCEL', 'NOTE', 'EDIT_PLAN', 'RENEW'];
  var TYPE = 'PAYMENT_ACTIVITY';

  function sat(value) {
    return Validation.toSatang(value, 'amount', { allowZero: true });
  }

  function fail(message) {
    throw Util.AppError('VALIDATION_PAYMENT', message);
  }

  function read() {
    return {
      accounts: Database.readAll('Accounts').rows,
      transactions: Database.readAll('Transactions').rows,
      reservations: Database.readAll('Reservations').rows,
      allocations: Database.readAll('PaymentAllocations').rows,
      schedules: Database.readAll('PaymentSchedules').rows,
      plans: Database.readAll('PaymentPlans').rows
    };
  }

  function balances(reservations) {
    var accounts = Object.create(null);
    var schedules = Object.create(null);
    reservations.forEach(function (r) {
      var amount = sat(r.amount);
      var net = r.action_type === 'RESERVE' ? amount : -amount;
      var s = schedules[r.schedule_id] || (schedules[r.schedule_id] = { saved: 0, reserved: 0, accounts: Object.create(null) });
      if (r.action_type !== 'CONSUME') s.saved += net;
      s.reserved += net;
      s.accounts[r.account_id] = (s.accounts[r.account_id] || 0) + net;
      accounts[r.account_id] = (accounts[r.account_id] || 0) + net;
    });
    return { accounts: accounts, schedules: schedules };
  }

  function derive(rows, state, date) {
    var today = Util.todayIso();
    var reserved = balances(state.reservations).schedules;
    var reversed = new Set(state.transactions.filter(function (t) { return t.reversal_of; }).map(function (t) { return t.reversal_of; }));
    var transactions = new Map(state.transactions.filter(function (t) { return !reversed.has(t.transaction_id) && !t.reversal_of; })
      .map(function (t) { return [t.transaction_id, t]; }));
    var paid = Object.create(null);
    state.allocations.forEach(function (allocation) {
      var tx = transactions.get(allocation.transaction_id);
      if (!tx) return;
      var record = paid[allocation.schedule_id] || (paid[allocation.schedule_id] = { satang: 0, lastDate: '' });
      record.satang += sat(allocation.allocated_amount);
      if (tx.transaction_date > record.lastDate) record.lastDate = tx.transaction_date;
    });
    rows.forEach(function (r) {
      var saving = reserved[r.schedule_id] || { reserved: 0, saved: 0 };
      var payment = paid[r.schedule_id] || { satang: 0, lastDate: '' };
      var remaining = Math.max(0, sat(r.amount_due) - payment.satang);
      var toSave = Math.max(0, remaining - saving.reserved);
      r.amount_saved = Validation.fromSatang(saving.saved);
      r.amount_reserved = Validation.fromSatang(saving.reserved);
      r.amount_paid = Validation.fromSatang(payment.satang);
      r.remaining_to_pay = Validation.fromSatang(remaining);
      r.remaining_to_save = Validation.fromSatang(toSave);
      r.saving_status = r.is_cancelled ? 'CANCELLED' : !remaining ? 'NOT_REQUIRED' : !toSave ? 'SAVED' : saving.reserved > 0 ? 'PARTIAL' : 'NOT_SAVED';
      r.payment_status = r.is_cancelled ? 'CANCELLED' : !remaining ? 'PAID' : payment.satang ? 'PARTIAL' : 'UNPAID';
      r.is_overdue = !r.is_cancelled && remaining > 0 && !!r.due_date && r.due_date < today;
      if (r.saving_status === 'SAVED') r.saving_completed_date = r.saving_completed_date || date || '';
      else if (remaining) r.saving_completed_date = '';
      r.paid_date = !remaining ? payment.lastDate : '';
    });
    var remainingCount = rows.filter(function (r) { return !r.is_cancelled && r.remaining_to_pay > 0; }).length;
    rows.forEach(function (r) { r.remaining_installments = remainingCount; });
    return remainingCount;
  }

  function requireAsset(accounts, rawId, active) {
    var id = Validation.requireId(rawId, 'account_id');
    var account = accounts.find(function (r) { return r.account_id === id; });
    if (!account || !Ledger.isAsset(account.account_type) || (active && !account.is_active)) {
      fail('กรุณาเลือกบัญชีสินทรัพย์ที่ใช้งานได้');
    }
    return id;
  }

  function prepare(input, ctx, state) {
    var f = input || {};
    var action = Validation.requireEnum(f.action, ACTIONS, 'action');
    var id = Validation.requireId(f.plan_id, 'plan_id');
    var plan = state.plans.find(function (row) { return row.plan_id === id; });
    var rows = state.schedules.filter(function (r) { return r.plan_id === id; });
    if (!plan || rows.length !== plan.installment_count) fail('ไม่พบแผนที่บันทึกครบ');
    if (plan.plan_status === 'CANCELLED' && ['NOTE', 'EDIT_PLAN', 'REVERSE_PAY'].indexOf(action) < 0) fail('แผนถูกยกเลิกแล้ว');
    var date = Validation.requireDate(f.date, 'transaction_date', { required: false }) || Util.todayIso();
    if (date > Util.todayIso()) fail('วันที่เหตุการณ์ต้องไม่เป็นวันในอนาคต');
    var note = Validation.requireText(f.note, 'note', { max: Config.TEXT_LIMITS.NOTE, multiline: true });
    if (action === 'PAY' && (!Array.isArray(f.lines) || !f.lines.length || f.lines.length > rows.length)) {
      fail('กรุณาระบุยอดชำระของแต่ละงวด');
    }
    var ids = Array.isArray(f.lines) && action === 'PAY' ? f.lines.map(function (line) { return line && line.schedule_id; })
      : f.schedule_id ? [f.schedule_id] : [];
    var targets = ids.map(function (rawId) {
      var scheduleId = Validation.requireId(rawId, 'schedule_id');
      var row = rows.find(function (r) { return r.schedule_id === scheduleId; });
      if (!row) fail('ไม่พบงวดในแผนนี้');
      return row;
    });
    if (new Set(ids).size !== ids.length || targets.length > rows.length) fail('งวดที่เลือกซ้ำกัน');
    if (!targets.length && ['CANCEL', 'EDIT_PLAN', 'RENEW', 'REVERSE_PAY'].indexOf(action) < 0) fail('กรุณาระบุงวด');
    if (action === 'CANCEL' && !targets.length) targets = rows.filter(function (r) { return !r.is_cancelled && r.remaining_to_pay > 0; });
    if (action !== 'NOTE' && targets.some(function (r) { return r.is_cancelled || (r.remaining_to_pay <= 0 && action !== 'RELEASE'); })) {
      fail('งวดถูกยกเลิกหรือชำระครบแล้ว');
    }

    var reserved = balances(state.reservations);
    var batch = { planId: id, date: date, at: ctx.now, reservations: [], allocations: [], transactions: [], edits: [] };
    var ledger = Ledger.balances(state.accounts, state.transactions);
    function reservation(row, account, event, amount, transaction) {
      if (!amount) return;
      batch.reservations.push({
        reservation_id: ctx.id('reservation-' + batch.reservations.length), reservation_date: date,
        schedule_id: row.schedule_id, account_id: account, action_type: event, amount: Validation.fromSatang(amount),
        transaction_id: transaction || '', note: note, created_at: ctx.now
      });
    }
    function accountReservations(row) {
      return (reserved.schedules[row.schedule_id] || {}).accounts || {};
    }

    if (action === 'REVERSE_PAY') {
      var originalId = Validation.requireId(f.transaction_id, 'transaction_id');
      var original = state.transactions.find(function (t) { return t.transaction_id === originalId && t.plan_id === id; });
      if (!original || original.reversal_of || original.source !== 'PLAN' || original.transaction_type !== 'EXPENSE' ||
          !state.allocations.some(function (r) { return r.transaction_id === originalId; }) ||
          state.transactions.some(function (r) { return r.reversal_of === originalId; })) fail('ไม่พบธุรกรรมชำระที่กลับรายการได้');
      if (date < original.transaction_date || !note) fail('กรุณาระบุเหตุผลและวันที่ที่ไม่ก่อนวันชำระ');
      var reversal = Object.assign({}, original, {
        transaction_id: ctx.id('reverse-payment'),
        transaction_date: date,
        reversal_of: originalId,
        item_name: ('กลับรายการ: ' + original.item_name).slice(0, Config.TEXT_LIMITS.ITEM_NAME),
        external_ref: '',
        note: note,
        created_at: ctx.now,
        updated_at: ctx.now
      });
      batch.transactions.push(Projection.apply('Transactions', reversal, Projection.loadMasters()));
    } else if (action === 'EDIT_PLAN') {
      var detail = { note: note };
      ['item_name', 'description'].forEach(function (key) {
        detail[key] = Validation.requireText(f[key], key, { required: key === 'item_name', max: key === 'item_name'
          ? Config.TEXT_LIMITS.ITEM_NAME : Config.TEXT_LIMITS.DESCRIPTION, multiline: key === 'description' });
      });
      var current = Projection.loadMasters();
      [['owner_id', 'owners'], ['category_id', 'categories'], ['account_id', 'accounts']].forEach(function (pair) {
        var key = pair[0];
        var newId = Validation.requireId(f[key], key, { required: false }) || plan[key];
        var record = current[pair[1]][newId];
        if (!record || (newId !== plan[key] && !record.isActive)) fail('ข้อมูลหลักที่เลือกใช้ไม่ได้');
        if (key === 'category_id' && record.type !== 'EXPENSE') fail('กรุณาเลือกหมวดหมู่รายจ่าย');
        if (key === 'account_id' && newId !== plan[key]) {
          var scheduleIds = new Set(rows.map(function (r) { return r.schedule_id; }));
          if (state.reservations.concat(state.allocations).some(function (r) { return scheduleIds.has(r.schedule_id); }) ||
              state.transactions.some(function (r) { return r.plan_id === id; })) fail('เปลี่ยนบัญชีไม่ได้หลังแผนมีประวัติทางการเงิน');
        }
        detail[key] = newId;
      });
      batch.planChanges = detail;
    } else if (action === 'RENEW') {
      var updated = Object.assign({}, plan);
      batch.extension = { plan: plan, input: { additional_count: f.additional_count, renewal_amount: f.renewal_amount } };
      PaymentPlanner.extension(updated, batch.extension.input, ctx, Projection.loadMasters());
      batch.planChanges = { installment_count: updated.installment_count, total_amount: updated.total_amount, principal_amount: updated.principal_amount };
    } else if (action === 'NOTE') {
      batch.edits.push({ id: targets[0].schedule_id, note: note });
    } else if (action === 'CANCEL') {
      if (!note) fail('กรุณาระบุเหตุผลการยกเลิก');
      if (!targets.length) fail('ไม่มีงวดคงค้างให้ยกเลิก');
      batch.cancelPlan = !f.schedule_id;
      batch.reason = note;
      targets.forEach(function (row) {
        var held = accountReservations(row);
        Object.keys(held).sort().forEach(function (account) { reservation(row, account, 'RELEASE', held[account]); });
        batch.edits.push({ id: row.schedule_id, is_cancelled: true });
      });
    } else {
      var account = requireAsset(state.accounts, f.account_id, action !== 'RELEASE');
      var available = (ledger[account] || 0) - (reserved.accounts[account] || 0);
      var row = targets[0];
      if (action === 'RESERVE' || action === 'RELEASE') {
        var amount = Validation.toSatang(f.amount, 'amount');
        if (action === 'RESERVE' && (amount > available || amount > sat(row.remaining_to_save))) fail('ยอดกันเงินเกินเงินที่ใช้ได้หรือยอดที่ยังต้องเก็บ');
        if (action === 'RELEASE' && amount > (accountReservations(row)[account] || 0)) fail('ยอดปลดเงินเกินที่กันไว้ในบัญชีนี้');
        reservation(row, account, action, amount);
      } else {
        if (state.transactions.some(function (t) { return t.plan_id === id && t.transaction_type === 'CREDIT_PURCHASE'; })) {
          fail('แผนที่มีธุรกรรมซื้อด้วยบัตรต้องชำระผ่านขั้นตอนชำระหนี้');
        }
        var transactionId = ctx.id('payment');
        var cashNeeded = 0;
        var total = 0;
        targets.forEach(function (schedule, i) {
          var amount = Validation.toSatang(f.lines[i].amount, 'allocated_amount');
          var outstanding = sat(schedule.remaining_to_pay);
          if (amount > outstanding) fail('ยอดชำระเกินยอดค้างของงวด');
          var held = accountReservations(schedule);
          var used = Math.min(amount, held[account] || 0);
          cashNeeded += amount - used;
          total += amount;
          reservation(schedule, account, 'CONSUME', used, transactionId);
          if (amount === outstanding) Object.keys(held).sort().forEach(function (accountId) {
            reservation(schedule, accountId, 'RELEASE', held[accountId] - (accountId === account ? used : 0));
          });
          batch.allocations.push({ allocation_id: ctx.id('allocation-' + i), transaction_id: transactionId,
            schedule_id: schedule.schedule_id, allocated_amount: Validation.fromSatang(amount), created_at: ctx.now });
        });
        if (cashNeeded > available) fail('เงินที่ใช้ได้ในบัญชีชำระไม่เพียงพอ');
        var masters = Projection.loadMasters();
        var tx = Transactions.validate({
          transaction_date: date, transaction_type: 'EXPENSE', from_account_id: account, owner_id: plan.owner_id,
          category_id: plan.category_id, item_name: plan.item_name, amount: Validation.fromSatang(total), note: note
        }, masters);
        batch.transactions.push(Projection.apply('Transactions', Object.assign(tx, {
          transaction_id: transactionId, plan_id: id, source: 'PLAN', reversal_of: '', created_at: ctx.now, updated_at: ctx.now
        }), masters));
      }
    }
    return batch;
  }

  function change(input, request) {
    return Operation.run({
      operationType: TYPE, idempotencyKey: request.idempotencyKey, actor: request.actor, payload: input
    }, function (ctx) {
      var journal = Database.findRowsByValue('OperationJournal', 'operation_type', TYPE);
      if (journal.some(function (match) {
        var row = match.row;
        return row.operation_id !== ctx.operationId && (row.status === 'PENDING' || row.status === 'NEEDS_RECOVERY') && row.recovery_data;
      })) throw Util.AppError('BUSY', 'มีการอัปเดตแผนค้าง กรุณาลองส่งคำขอเดิมที่ค้างก่อน');

      var batch = ctx.recoveryData;
      if (!batch) {
        batch = prepare(input, ctx, read());
        ctx.checkpoint(batch);
      }
      if (batch.transactions.length) Database.appendRowsIfAbsent('Transactions', batch.transactions);
      if (batch.reservations.length) Database.appendRowsIfAbsent('Reservations', batch.reservations);
      if (batch.allocations.length) Database.appendRowsIfAbsent('PaymentAllocations', batch.allocations);
      if (batch.extension) {
        var extensionCtx = { id: ctx.id, now: batch.at };
        var extra = PaymentPlanner.extension(Object.assign({}, batch.extension.plan), batch.extension.input, extensionCtx, Projection.loadMasters());
        Database.appendRowsIfAbsent('PaymentSchedules', extra);
      }
      var state = read();
      var plan = state.plans.find(function (p) { return p.plan_id === batch.planId; });
      var rows = state.schedules.filter(function (r) { return r.plan_id === batch.planId; });
      if (batch.planChanges) {
        var masters = Projection.loadMasters();
        Projection.apply('PaymentPlans', Object.assign(plan, batch.planChanges), masters);
        rows.forEach(function (r) { Projection.applyPlanToSchedule(r, plan, masters); });
      }
      var edits = Object.create(null);
      batch.edits.forEach(function (edit) { edits[edit.id] = edit; });
      rows.forEach(function (row) {
        var edit = edits[row.schedule_id];
        if (!edit) return;
        if (edit.note !== undefined) row.note = edit.note;
        if (edit.is_cancelled) row.is_cancelled = true;
      });
      var stillDue = derive(rows, state, batch.date);
      plan.plan_status = plan.plan_status === 'CANCELLED' || batch.cancelPlan || rows.every(function (r) { return r.is_cancelled; })
        ? 'CANCELLED' : stillDue ? 'ACTIVE' : 'COMPLETED';
      plan.updated_at = batch.at;
      rows.forEach(function (row) { row.updated_at = batch.at; });
      Database.updateRows('PaymentSchedules', rows);
      Database.updateRows('PaymentPlans', [plan]);
      return { plan_id: batch.planId };
    }).result;
  }

  return { change: change, balances: balances };
})();

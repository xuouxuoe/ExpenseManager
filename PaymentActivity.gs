/** การกันเงินและชำระแผนรายจ่ายในอนาคต ใช้จำนวนเงินหน่วยสตางค์ */
var PaymentActivity = (function () {
  var ACTIONS = ['RESERVE', 'RELEASE', 'PAY', 'REVERSE_PAY', 'CANCEL', 'NOTE', 'EDIT_PLAN', 'RENEW', 'RESCHEDULE', 'SETTLE'];
  var TYPE = 'PAYMENT_ACTIVITY';
  var PAYMENT_TYPES = ['EXPENSE', 'CREDIT_PAYMENT'];

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
      plans: Database.readAll('PaymentPlans').rows,
      settings: Database.readAll('Settings').rows
    };
  }

  /**
   * ยอดกันเงินต่องวดและต่อบัญชี (สตางค์)
   * transactions (ถ้าส่งมา): CONSUME และ RELEASE อัตโนมัติของการชำระที่ถูกกลับรายการแล้วไม่ถูกนับ
   * เงินที่เคยกันไว้จึงกลับมาเป็น "กันไว้" เมื่อการชำระถูกยกเลิก (ผู้ใช้ตัดสินใจ 2026-11-26)
   */
  function balances(reservations, transactions) {
    var accounts = Object.create(null);
    var schedules = Object.create(null);
    var reversedTx = Object.create(null);
    (transactions || []).forEach(function (t) { if (t.reversal_of) reversedTx[t.reversal_of] = true; });
    reservations.forEach(function (r) {
      if ((r.action_type === 'CONSUME' || r.action_type === 'RELEASE') && r.transaction_id && reversedTx[r.transaction_id]) return;
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
    var reserved = balances(state.reservations, state.transactions).schedules;
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

  function effective(transactions) {
    var reversed = new Set(transactions.filter(function (t) { return t.reversal_of; }).map(function (t) { return t.reversal_of; }));
    return transactions.filter(function (t) { return !t.reversal_of && !reversed.has(t.transaction_id); });
  }

  /**
   * แผนที่ชำระแบบหนี้ (CREDIT_PAYMENT): บัญชีของแผนเป็นหนี้สิน และเชื่อมรายการซื้อ (CREDIT_PURCHASE) หรือเป็นสินเชื่อ (LOAN)
   * แผนอื่นชำระเป็น EXPENSE จากบัญชีสินทรัพย์
   */
  function isDebtPlan(plan, state) {
    var account = state.accounts.find(function (a) { return a.account_id === plan.account_id; });
    if (!account || !Ledger.isLiability(account.account_type)) return false;
    return account.account_type === 'LOAN' || effective(state.transactions).some(function (t) {
      return t.plan_id === plan.plan_id && t.transaction_type === 'CREDIT_PURCHASE';
    });
  }

  /** ดอกเบี้ย/ค่าธรรมเนียมที่รับรู้พร้อมการชำระหนึ่งครั้ง */
  function companionsOf(transactions, planId, paymentId) {
    return effective(transactions).filter(function (t) {
      return t.plan_id === planId && t.source === 'PLAN' && t.external_ref === paymentId &&
        (t.transaction_type === 'INTEREST' || t.transaction_type === 'FEE');
    });
  }

  /**
   * ส่วนดอกเบี้ย/ค่าธรรมเนียมที่รับรู้ในการชำระครั้งนี้ (สตางค์)
   * FIRST ใช้เฉพาะยอดจัดสรรให้งวด 1 สำหรับค่าธรรมเนียม ส่วนแผนทั่วไปใช้สัดส่วนสะสมทั้งแผน
   */
  function chargeShares(plan, state, paymentSatang, allocations) {
    var live = effective(state.transactions).filter(function (t) { return t.plan_id === plan.plan_id && t.source === 'PLAN'; });
    var payments = new Set(live.filter(function (t) { return t.transaction_type === 'CREDIT_PAYMENT'; }).map(function (t) { return t.transaction_id; }));
    var paid = state.allocations.filter(function (a) { return payments.has(a.transaction_id); })
      .reduce(function (s, a) { return s + sat(a.allocated_amount); }, 0);
    var total = sat(plan.total_amount);
    if (plan.fee_amount > 0 && PaymentPlanner.hasFirstInstallmentFee(plan.plan_id)) {
      var first = state.schedules.find(function (r) { return r.plan_id === plan.plan_id && r.installment_no === 1; });
      var firstLine = allocations.find(function (a) { return a.schedule_id === first.schedule_id; });
      var feeLeft = sat(plan.fee_amount) - recognized('FEE');
      var fee = firstLine ? shareOfRemaining(feeLeft, sat(firstLine.allocated_amount), sat(first.remaining_to_pay)) : 0;
      var interestLeft = sat(plan.interest_amount) - recognized('INTEREST');
      return { FEE: fee, INTEREST: shareOfRemaining(interestLeft, paymentSatang - fee, total - paid - feeLeft) };
    }

    function recognized(type) {
      return live.filter(function (t) { return t.transaction_type === type; }).reduce(function (s, t) { return s + sat(t.amount); }, 0);
    }

    var after = paid + paymentSatang;
    var out = {};
    [['INTEREST', 'interest_amount'], ['FEE', 'fee_amount']].forEach(function (pair) {
      var planned = sat(plan[pair[1]] || 0);
      var target = after >= total ? planned : Number(BigInt(planned) * BigInt(after) / BigInt(total));
      out[pair[0]] = Math.max(0, target - recognized(pair[0]));
    });
    return out;
  }

  // Allocate only from the unpaid balance. Paying its last satang picks up all rounding residue.
  function shareOfRemaining(charge, payment, balance) {
    if (!charge || !payment) return 0;
    return Number(BigInt(charge) * BigInt(payment) / BigInt(balance));
  }

  function requireAsset(accounts, rawId, active) {
    var id = Validation.requireId(rawId, 'account_id');
    var account = accounts.find(function (r) { return r.account_id === id; });
    if (!account || !Ledger.isAsset(account.account_type) || (active && !account.is_active)) {
      fail('กรุณาเลือกบัญชีสินทรัพย์ที่ใช้งานได้');
    }
    return id;
  }

  function firstFee(plan, state) {
    return state.settings.some(function (s) { return s.setting_key === 'plan.fee_timing.' + plan.plan_id && s.setting_value === 'FIRST'; });
  }

  function position(plan, state) {
    return PlanRevision.position(plan, state, isDebtPlan(plan, state), firstFee(plan, state));
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
    var version = PlanRevision.version(plan, rows);
    var activeSettlement = PlanRevision.activeSettlement(id, state);
    if (activeSettlement && ['NOTE', 'EDIT_PLAN', 'REVERSE_PAY'].indexOf(action) < 0) {
      fail('แผนนี้ปิดยอดก่อนกำหนดแล้ว หากต้องการเปลี่ยนยอดให้กลับรายการปิดยอดก่อน');
    }
    if (activeSettlement && action === 'REVERSE_PAY' && f.transaction_id !== activeSettlement.paymentId) {
      fail('กรุณากลับรายการปิดยอดก่อนกำหนดก่อนกลับรายการชำระครั้งอื่น');
    }
    var settlement = null;
    if (action === 'RESCHEDULE' || action === 'SETTLE') {
      if (plan.plan_status !== 'ACTIVE') fail('ปรับงวดหรือปิดยอดได้เฉพาะแผนที่กำลังดำเนินการ');
      if (!note) fail('กรุณาระบุเหตุผลการปรับแผนหรือปิดยอด');
      if (!ctx.preview && f.preview_version !== version) {
        throw Util.AppError('VALIDATION_PLAN_CHANGED', 'ข้อมูลแผนเปลี่ยนไป กรุณาตรวจสอบตัวอย่างใหม่ก่อนยืนยัน');
      }
    }
    if (action === 'SETTLE') {
      settlement = PlanRevision.settle(plan, rows, state, f, position(plan, state), ctx.id('payment'));
      PlanRevision.applySettlement(plan, rows, settlement, false);
      derive(rows, state, date);
      f = Object.assign({}, f, { lines: [{ schedule_id: settlement.anchorId, amount: Validation.fromSatang(settlement.amount) }] });
      action = 'PAY';
    }
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
    if (!targets.length && ['CANCEL', 'EDIT_PLAN', 'RENEW', 'REVERSE_PAY', 'RESCHEDULE'].indexOf(action) < 0) fail('กรุณาระบุงวด');
    if (action === 'CANCEL' && !targets.length) targets = rows.filter(function (r) { return !r.is_cancelled && r.remaining_to_pay > 0; });
    if (action !== 'NOTE' && targets.some(function (r) { return r.is_cancelled || (r.remaining_to_pay <= 0 && action !== 'RELEASE'); })) {
      fail('งวดถูกยกเลิกหรือชำระครบแล้ว');
    }

    var reserved = balances(state.reservations, state.transactions);
    var batch = { planId: id, date: date, at: ctx.now, reservations: [], allocations: [], transactions: [], edits: [] };
    var released = Object.create(null);
    if (settlement) batch.settlement = settlement;
    var ledger = Ledger.balances(state.accounts, state.transactions);
    function reservation(row, account, event, amount, transaction) {
      if (!amount) return;
      if (event === 'RELEASE') released[account] = (released[account] || 0) + amount;
      batch.reservations.push({
        reservation_id: ctx.id('reservation-' + batch.reservations.length), reservation_date: date,
        schedule_id: row.schedule_id, account_id: account, action_type: event, amount: Validation.fromSatang(amount),
        transaction_id: transaction || '', note: note, created_at: ctx.now
      });
    }
    function accountReservations(row) {
      return (reserved.schedules[row.schedule_id] || {}).accounts || {};
    }

    if (settlement) rows.filter(function (r) { return r.schedule_id !== settlement.anchorId; }).forEach(function (row) {
      var held = accountReservations(row);
      Object.keys(held).sort().forEach(function (account) { reservation(row, account, 'RELEASE', held[account], settlement.paymentId); });
    });

    if (action === 'RESCHEDULE') {
      batch.scheduleChanges = PlanRevision.amend(plan, rows, f, firstFee(plan, state));
      var newAmounts = new Map(batch.scheduleChanges.map(function (c) { return [c[0], sat(c[1])]; }));
      rows.forEach(function (row) {
        if (!newAmounts.has(row.schedule_id)) return;
        var excess = Math.max(0, sat(row.amount_reserved) - (newAmounts.get(row.schedule_id) - sat(row.amount_paid)));
        var held = accountReservations(row);
        Object.keys(held).sort().forEach(function (account) {
          var amount = Math.min(excess, held[account]);
          reservation(row, account, 'RELEASE', amount);
          excess -= amount;
        });
      });
    } else if (action === 'REVERSE_PAY') {
      var originalId = Validation.requireId(f.transaction_id, 'transaction_id');
      var original = state.transactions.find(function (t) { return t.transaction_id === originalId && t.plan_id === id; });
      if (!original || original.reversal_of || original.source !== 'PLAN' || PAYMENT_TYPES.indexOf(original.transaction_type) < 0 ||
          !state.allocations.some(function (r) { return r.transaction_id === originalId; }) ||
          state.transactions.some(function (r) { return r.reversal_of === originalId; })) fail('ไม่พบธุรกรรมชำระที่กลับรายการได้');
      if (date < original.transaction_date || !note) fail('กรุณาระบุเหตุผลและวันที่ที่ไม่ก่อนวันชำระ');
      if (activeSettlement) batch.restoreSettlement = activeSettlement;
      var reverseMasters = Projection.loadMasters();
      // กลับรายการชำระพร้อมดอกเบี้ย/ค่าธรรมเนียมที่รับรู้ในการชำระครั้งนั้น (external_ref = รหัสธุรกรรมชำระ)
      [original].concat(companionsOf(state.transactions, id, originalId)).forEach(function (source, n) {
        var reversal = Object.assign({}, source, {
          transaction_id: ctx.id(n ? 'reverse-payment-' + n : 'reverse-payment'),
          transaction_date: date,
          reversal_of: source.transaction_id,
          item_name: ('กลับรายการ: ' + source.item_name).slice(0, Config.TEXT_LIMITS.ITEM_NAME),
          external_ref: '',
          note: note,
          created_at: ctx.now,
          updated_at: ctx.now
        });
        batch.transactions.push(Projection.apply('Transactions', reversal, reverseMasters));
      });
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
      detail.sub_account_id = Projection.validateSubAccount(f.sub_account_id === undefined && detail.account_id === plan.account_id ? plan.sub_account_id : f.sub_account_id,
        detail.account_id, current, plan.sub_account_id);
      if (detail.sub_account_id !== (plan.sub_account_id || '')) batch.reclassify = { accountId: plan.account_id, subAccountId: detail.sub_account_id };
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
      var available = (ledger[account] || 0) - (reserved.accounts[account] || 0) + (released[account] || 0);
      var row = targets[0];
      if (action === 'RESERVE' || action === 'RELEASE') {
        var amount = Validation.toSatang(f.amount, 'amount');
        if (action === 'RESERVE' && (amount > available || amount > sat(row.remaining_to_save))) fail('ยอดกันเงินเกินเงินที่ใช้ได้หรือยอดที่ยังต้องเก็บ');
        if (action === 'RELEASE' && amount > (accountReservations(row)[account] || 0)) fail('ยอดปลดเงินเกินที่กันไว้ในบัญชีนี้');
        reservation(row, account, action, amount);
      } else {
        var debtMode = isDebtPlan(plan, state);
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
            reservation(schedule, accountId, 'RELEASE', held[accountId] - (accountId === account ? used : 0), transactionId);
          });
          batch.allocations.push({ allocation_id: ctx.id('allocation-' + i), transaction_id: transactionId,
            schedule_id: schedule.schedule_id, allocated_amount: Validation.fromSatang(amount), created_at: ctx.now });
        });
        if (cashNeeded > available) fail('เงินที่ใช้ได้ในบัญชีชำระไม่เพียงพอ');
        var masters = Projection.loadMasters();
        var payerSub = Projection.validateSubAccount(f.payment_sub_account_id, account, masters, account === plan.account_id ? plan.sub_account_id : '');
        // ข้อมูลหลักของแผนที่ถูกปิดภายหลังยังใช้ชำระแผนเดิมได้
        var current = { owner_id: plan.owner_id, category_id: plan.category_id, to_account_id: plan.account_id, from_account_id: plan.account_id,
          from_sub_account_id: plan.sub_account_id, to_sub_account_id: plan.sub_account_id };
        function planTransaction(fields, txId) {
          var tx = Transactions.validate(Object.assign({
            transaction_date: date, owner_id: plan.owner_id, item_name: plan.item_name, note: note
          }, fields), masters, current);
          batch.transactions.push(Projection.apply('Transactions', Object.assign(tx, {
            transaction_id: txId, plan_id: id, source: 'PLAN', reversal_of: '', created_at: ctx.now, updated_at: ctx.now
          }), masters));
        }
        if (debtMode) {
          // ชำระหนี้บัตร/สินเชื่อ: ลดหนี้ ไม่รับรู้รายจ่ายซ้ำกับ CREDIT_PURCHASE (AGENTS §7.3)
          planTransaction({ transaction_type: 'CREDIT_PAYMENT', from_account_id: account, to_account_id: plan.account_id,
            from_sub_account_id: payerSub, to_sub_account_id: plan.sub_account_id,
            amount: Validation.fromSatang(total) }, transactionId);
          var shares = settlement ? { INTEREST: settlement.interest, FEE: settlement.fee } : chargeShares(plan, state, total, batch.allocations);
          [['INTEREST', 'ดอกเบี้ย: '], ['FEE', 'ค่าธรรมเนียม: ']].forEach(function (pair) {
            if (!shares[pair[0]]) return;
            planTransaction({ transaction_type: pair[0], from_account_id: plan.account_id, category_id: plan.category_id,
              from_sub_account_id: plan.sub_account_id,
              item_name: (pair[1] + plan.item_name).slice(0, Config.TEXT_LIMITS.ITEM_NAME),
              amount: Validation.fromSatang(shares[pair[0]]), external_ref: transactionId }, ctx.id('payment-' + pair[0].toLowerCase()));
          });
        } else {
          planTransaction({ transaction_type: 'EXPENSE', from_account_id: account, category_id: plan.category_id,
            from_sub_account_id: payerSub,
            amount: Validation.fromSatang(total) }, transactionId);
        }
      }
    }
    batch.previewVersion = version;
    return batch;
  }

  function preview(input) {
    if (!input || ['RESCHEDULE', 'SETTLE'].indexOf(input.action) < 0) fail('กรุณาเลือกการปรับงวดหรือปิดยอด');
    var batch = prepare(input, { preview: true, now: Util.nowIso(), id: function (label) { return Util.deterministicUuid('plan-preview', label); } }, read());
    return { version: batch.previewVersion, settlement_amount: batch.settlement ? Validation.fromSatang(batch.settlement.amount) : null,
      total_amount: batch.settlement ? batch.settlement.money[3] : null,
      interest_amount: batch.settlement ? Validation.fromSatang(batch.settlement.interest) : null,
      fee_amount: batch.settlement ? Validation.fromSatang(batch.settlement.fee) : null,
      changed_schedules: batch.scheduleChanges ? batch.scheduleChanges.length : 0,
      released_amount: Validation.fromSatang(batch.reservations.filter(function (r) { return r.action_type === 'RELEASE'; })
        .reduce(function (sum, r) { return sum + sat(r.amount); }, 0)) };
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
      if (batch.settlement) {
        Database.appendRowsIfAbsent('Settings', [{ setting_key: PlanRevision.settlementKey(batch.settlement.paymentId),
          setting_value: Util.stableStringify(batch.settlement), description: 'ประวัติปรับแผนเมื่อปิดยอดก่อนกำหนด', updated_at: batch.at }]);
      }
      if (batch.transactions.length) {
        // The checkpoint may predate a master rename made while this request was pending.
        var currentNames = Projection.loadMasters();
        Database.appendRowsIfAbsent('Transactions', batch.transactions.map(function (t) {
          return Projection.apply('Transactions', t, currentNames);
        }));
      }
      if (batch.reservations.length) Database.appendRowsIfAbsent('Reservations', batch.reservations);
      if (batch.allocations.length) Database.appendRowsIfAbsent('PaymentAllocations', batch.allocations);
      if (batch.reclassify) {
        var names = Projection.loadMasters();
        var reclassified = Database.readAll('Transactions').rows.filter(function (t) { return t.plan_id === batch.planId; }).map(function (t) {
          ['from', 'to'].forEach(function (side) {
            if (t[side + '_account_id'] === batch.reclassify.accountId) t[side + '_sub_account_id'] = batch.reclassify.subAccountId;
          });
          return Projection.apply('Transactions', t, names);
        });
        Database.updateRows('Transactions', reclassified);
      }
      if (batch.extension) {
        var extensionCtx = { id: ctx.id, now: batch.at };
        var extra = PaymentPlanner.extension(Object.assign({}, batch.extension.plan), batch.extension.input, extensionCtx, Projection.loadMasters());
        Database.appendRowsIfAbsent('PaymentSchedules', extra);
      }
      var state = read();
      var plan = state.plans.find(function (p) { return p.plan_id === batch.planId; });
      var rows = state.schedules.filter(function (r) { return r.plan_id === batch.planId; });
      if (batch.settlement) PlanRevision.applySettlement(plan, rows, batch.settlement, false);
      if (batch.restoreSettlement) PlanRevision.applySettlement(plan, rows, batch.restoreSettlement, true);
      if (batch.scheduleChanges) PlanRevision.applyAmendment(rows, batch.scheduleChanges);
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

  return { change: change, balances: balances, preview: preview, position: position };
})();

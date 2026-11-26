/** Pure calculations for schedule amendments and early settlement. Money is in satang internally. */
var PlanRevision = (function () {
  function sat(value) { return Validation.toSatang(value || 0, 'amount', { allowZero: true }); }
  function fail(message) { throw Util.AppError('VALIDATION_REVISION', message); }
  function fraction(amount, paid, total) {
    if (!amount || !paid) return 0;
    return Number(BigInt(amount) * BigInt(Math.min(paid, total)) / BigInt(total));
  }

  function liveTransactions(transactions) {
    var reversed = new Set(transactions.filter(function (t) { return t.reversal_of; }).map(function (t) { return t.reversal_of; }));
    return transactions.filter(function (t) { return !t.reversal_of && !reversed.has(t.transaction_id); });
  }

  function position(plan, state, debt, firstFee) {
    var live = liveTransactions(state.transactions).filter(function (t) { return t.plan_id === plan.plan_id && t.source === 'PLAN'; });
    var paymentIds = new Set(live.filter(function (t) { return ['EXPENSE', 'CREDIT_PAYMENT'].indexOf(t.transaction_type) >= 0; })
      .map(function (t) { return t.transaction_id; }));
    var allocations = state.allocations.filter(function (a) { return paymentIds.has(a.transaction_id); });
    var paid = allocations.reduce(function (sum, a) { return sum + sat(a.allocated_amount); }, 0);
    var interest = fraction(sat(plan.interest_amount), paid, sat(plan.total_amount));
    var fee = fraction(sat(plan.fee_amount), paid, sat(plan.total_amount));
    if (firstFee) {
      var first = state.schedules.find(function (s) { return s.plan_id === plan.plan_id && s.installment_no === 1; });
      var firstPaid = allocations.filter(function (a) { return a.schedule_id === first.schedule_id; })
        .reduce(function (sum, a) { return sum + sat(a.allocated_amount); }, 0);
      fee = fraction(sat(plan.fee_amount), firstPaid, sat(first.amount_due));
      interest = fraction(sat(plan.interest_amount), paid - fee, sat(plan.total_amount) - sat(plan.fee_amount));
    }
    if (debt) {
      interest = live.filter(function (t) { return t.transaction_type === 'INTEREST'; }).reduce(function (s, t) { return s + sat(t.amount); }, 0);
      fee = live.filter(function (t) { return t.transaction_type === 'FEE'; }).reduce(function (s, t) { return s + sat(t.amount); }, 0);
    }
    var interestRemaining = Math.max(0, sat(plan.interest_amount) - interest);
    var feeRemaining = Math.max(0, sat(plan.fee_amount) - fee);
    var principalRemaining = Math.max(0, sat(plan.principal_amount) - (paid - interest - fee));
    var schedules = state.schedules.filter(function (s) { return s.plan_id === plan.plan_id; });
    // Cancelling a future expense removes that obligation; cancelling a card schedule leaves the actual debt intact.
    if (!debt && schedules.some(function (s) { return s.is_cancelled && s.remaining_to_pay > 0; })) {
      var outstanding = schedules.filter(function (s) { return !s.is_cancelled; })
        .reduce(function (sum, s) { return sum + sat(s.remaining_to_pay); }, 0);
      var totalRemaining = Math.max(0, sat(plan.total_amount) - paid);
      if (firstFee) {
        var originalFeeRemaining = feeRemaining;
        feeRemaining = first.is_cancelled ? 0 : feeRemaining;
        interestRemaining = fraction(interestRemaining, Math.max(0, outstanding - feeRemaining), totalRemaining - originalFeeRemaining);
      } else {
        interestRemaining = fraction(interestRemaining, outstanding, totalRemaining);
        feeRemaining = fraction(feeRemaining, outstanding, totalRemaining);
      }
      principalRemaining = Math.max(0, outstanding - interestRemaining - feeRemaining);
    }
    return { paid: paid, interestPaid: interest, feePaid: fee,
      principalRemaining: principalRemaining, interestRemaining: interestRemaining, feeRemaining: feeRemaining };
  }

  function version(plan, rows) {
    return Util.sha256Hex(Util.stableStringify({ plan: plan, schedules: rows }));
  }

  function settlementKey(paymentId) { return 'plan.settlement.' + paymentId; }

  function activeSettlement(planId, state) {
    var payments = new Set(liveTransactions(state.transactions).filter(function (t) {
      return t.plan_id === planId && t.source === 'PLAN' && ['EXPENSE', 'CREDIT_PAYMENT'].indexOf(t.transaction_type) >= 0;
    }).map(function (t) { return t.transaction_id; }));
    var found = null;
    (state.settings || []).forEach(function (row) {
      if (row.setting_key.indexOf('plan.settlement.') !== 0 || !payments.has(row.setting_key.slice('plan.settlement.'.length))) return;
      var saved = JSON.parse(row.setting_value);
      if (saved.planId === planId) found = saved;
    });
    return found;
  }

  function settle(plan, rows, state, input, position, paymentId) {
    var anchor = rows.filter(function (s) { return !s.is_cancelled && s.remaining_to_pay > 0; })
      .sort(function (a, b) { return a.installment_no - b.installment_no; })[0];
    if (!anchor) fail('ไม่มีงวดคงค้างให้ปิดยอด');
    var interest = Validation.toSatang(input.settlement_interest_amount, 'settlement_interest_amount', { allowZero: true });
    var fee = Validation.toSatang(input.settlement_fee_amount, 'settlement_fee_amount', { allowZero: true });
    var amount = position.principalRemaining + interest + fee;
    if (!amount) fail('ยอดปิดแผนต้องมากกว่า 0 บาท');
    Validation.toSatang(Validation.fromSatang(position.paid + amount), 'total_amount');
    return {
      planId: plan.plan_id, paymentId: paymentId, anchorId: anchor.schedule_id, amount: amount, interest: interest, fee: fee,
      before: {
        money: [plan.principal_amount, plan.interest_amount, plan.fee_amount, plan.total_amount],
        schedules: rows.map(function (s) { return [s.schedule_id, s.amount_due, !!s.is_cancelled, s.amount_paid]; })
      },
      money: [Validation.fromSatang(position.paid - position.interestPaid - position.feePaid + position.principalRemaining), Validation.fromSatang(position.interestPaid + interest),
        Validation.fromSatang(position.feePaid + fee), Validation.fromSatang(position.paid + amount)]
    };
  }

  function applySettlement(plan, rows, saved, restore) {
    var money = restore ? saved.before.money : saved.money;
    ['principal_amount', 'interest_amount', 'fee_amount', 'total_amount'].forEach(function (key, i) { plan[key] = money[i]; });
    var original = new Map(saved.before.schedules.map(function (s) { return [s[0], s]; }));
    rows.forEach(function (row) {
      var before = original.get(row.schedule_id);
      if (!before) fail('ตารางงวดเปลี่ยนไป กรุณาตรวจสอบประวัติแผน');
      row.amount_due = restore ? before[1] : Validation.fromSatang(sat(before[3]) + (row.schedule_id === saved.anchorId ? saved.amount : 0));
      row.is_cancelled = restore ? before[2] : before[2] || (row.schedule_id !== saved.anchorId && !sat(before[3]));
    });
  }

  function amend(plan, rows, input, firstFee) {
    var pending = rows.filter(function (s) { return !s.is_cancelled && s.remaining_to_pay > 0; });
    var changes = input.schedule_changes;
    if (!pending.length || !Array.isArray(changes) || changes.length !== pending.length) fail('กรุณาระบุงวดที่ค้างให้ครบ');
    var originals = new Map(pending.map(function (s) { return [s.schedule_id, s]; }));
    var seen = new Set();
    var beforeTotal = pending.reduce(function (sum, s) { return sum + sat(s.amount_due); }, 0);
    var afterTotal = 0;
    var edits = changes.map(function (c) {
      var row = originals.get(c.schedule_id);
      if (!row || seen.has(c.schedule_id)) fail('มีงวดซ้ำหรือมีงวดที่แก้ไขไม่ได้');
      seen.add(c.schedule_id);
      var amount = Validation.toSatang(c.amount_due, 'amount_due');
      if (amount < sat(row.amount_paid)) fail('ยอดงวดใหม่ต้องไม่น้อยกว่ายอดที่จ่ายไปแล้ว');
      if (firstFee && row.installment_no === 1 && amount < sat(plan.fee_amount)) fail('งวดแรกต้องครอบคลุมค่าธรรมเนียมทั้งหมด');
      var saving = Validation.requireYearMonth(c.saving_month, 'saving_month');
      var payment = Validation.requireYearMonth(c.payment_month, 'payment_month');
      var dueDay = Validation.requireDay(c.due_day, 'due_day', { required: false });
      afterTotal += amount;
      // Compact before/after data keeps the journal bounded for plans with many schedules.
      return [row.schedule_id, Validation.fromSatang(amount), saving, payment, Validation.dueDateOf(payment, dueDay),
        row.amount_due, row.saving_month, row.payment_month, row.due_date];
    });
    if (afterTotal !== beforeTotal) fail('ผลรวมยอดงวดใหม่ต้องเท่ากับผลรวมงวดเดิม หากต้องการลดหนี้และปิดแผนให้เลือกปิดยอดก่อนกำหนด');
    return edits;
  }

  function applyAmendment(rows, changes) {
    var edits = new Map(changes.map(function (c) { return [c[0], c]; }));
    rows.forEach(function (row) {
      var c = edits.get(row.schedule_id);
      if (!c) return;
      row.amount_due = c[1];
      row.saving_month = c[2];
      row.payment_month = c[3];
      row.due_date = c[4];
      row.is_month_different = c[2] !== c[3];
      row.saving_year = Validation.yearOf(c[2]);
      row.saving_month_no = Validation.monthOf(c[2]);
      row.payment_year = Validation.yearOf(c[3]);
      row.payment_month_no = Validation.monthOf(c[3]);
    });
  }

  return { position: position, version: version, settlementKey: settlementKey, activeSettlement: activeSettlement,
    settle: settle, applySettlement: applySettlement, amend: amend, applyAmendment: applyAmendment };
})();

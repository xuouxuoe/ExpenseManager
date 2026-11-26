'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');
const plain = (v) => JSON.parse(JSON.stringify(v));

function addMonths(ym, n) {
  const total = Math.floor(ym / 100) * 12 + (ym % 100) - 1 + n;
  return Math.floor(total / 12) * 100 + (total % 12) + 1;
}

/** Two card plans (different owners), one cash plan, all due from this month. */
function fixture() {
  const ctx = createDbContext();
  const today = ctx.Util.todayIso();
  const month = Number(today.slice(0, 7).replace('-', ''));
  const create = (type, input, suffix) => ctx.MasterData.create(type, input,
    { actor: { actorId: 'owner@example.com' }, idempotencyKey: 'monthly-seed-' + suffix });
  const ids = {
    dad: create('owner', { owner_name: 'พ่อ' }, 'dad'),
    mom: create('owner', { owner_name: 'แม่' }, 'mom'),
    cash: create('account', { account_name: 'เงินสด', account_type: 'CASH', opening_balance: 10000 }, 'cash'),
    bank: create('account', { account_name: 'ธนาคาร', account_type: 'BANK', opening_balance: 300 }, 'bank'),
    card: create('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD' }, 'card'),
    category: create('category', { category_name: 'ของใช้', category_type: 'EXPENSE' }, 'category')
  };
  const plan = (key, fields) => {
    const res = ctx.api_createPaymentPlan({ purchase_date: today, plan_type: 'INSTALLMENT', category_id: ids.category.category_id,
      first_saving_month: addMonths(month, -1), first_payment_month: month, ...fields }, 'monthly-plan-' + key);
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.data.plan_id;
  };
  const plans = {
    phone: plan('phone', { item_name: 'โทรศัพท์', account_id: ids.card.account_id, owner_id: ids.dad.owner_id,
      principal_amount: 600, interest_amount: 60, fee_amount: 30, installment_count: 3, purchase_link: 'NEW' }),
    fridge: plan('fridge', { item_name: 'ตู้เย็น', account_id: ids.card.account_id, owner_id: ids.mom.owner_id,
      principal_amount: 900, installment_count: 3, purchase_link: 'NEW' }),
    net: plan('net', { item_name: 'อินเทอร์เน็ต', plan_type: 'ONE_TIME', account_id: ids.cash.account_id, owner_id: ids.dad.owner_id,
      principal_amount: 500, installment_count: 1 })
  };
  const schedules = () => plain(ctx.Database.readAll('PaymentSchedules').rows);
  const due = (planId, no = 1) => schedules().find((r) => r.plan_id === planId && r.installment_no === no);
  return { ctx, today, month, ids, plans, schedules, due };
}

function payItems(f, accountId) {
  return Object.values(f.plans).map((planId) => {
    const row = f.due(planId);
    return { schedule_id: row.schedule_id, account_id: accountId || f.ids.cash.account_id, amount: row.remaining_to_pay };
  });
}

/** Financial outcome without generated IDs/timestamps, for batch-vs-single comparison. */
function outcome(ctx) {
  const read = (name) => plain(ctx.Database.readAll(name).rows);
  return {
    transactions: read('Transactions').filter((t) => t.source === 'PLAN')
      .map((t) => [t.transaction_type, t.from_account_name, t.to_account_name, t.owner_name, t.item_name, t.amount, t.category_name]).sort(),
    reservations: read('Reservations').map((r) => [r.action_type, r.account_id, r.amount]).sort(),
    allocations: read('PaymentAllocations').map((r) => r.allocated_amount).sort(),
    schedules: read('PaymentSchedules').map((r) => [r.item_name, r.installment_no, r.amount_paid, r.amount_reserved,
      r.remaining_to_pay, r.payment_status, r.saving_status, r.remaining_installments]).sort(),
    plans: read('PaymentPlans').map((r) => [r.item_name, r.plan_status]).sort(),
    balances: Object.values(plain(ctx.Transactions.accountBalances())).sort((a, b) => a - b)
  };
}

test('ชำระหลายแผนในคำขอเดียวได้ผลเหมือนบันทึกทีละแผน และคืนรายการแผนล่าสุด', () => {
  const batch = fixture();
  const res = batch.ctx.api_monthlyBatch({ action: 'PAY', date: batch.today, items: payItems(batch) }, 'monthly-pay-all');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.result.items, 3);
  assert.equal(res.data.result.total, 230 + 300 + 500);
  assert.equal(res.data.plans.length, 3);
  const net = res.data.plans.find((r) => r.plan.plan_id === batch.plans.net);
  assert.equal(net.plan.plan_status, 'COMPLETED');
  assert.ok(res.data.plans.every((r) => r.schedules.find((s) => s.installment_no === 1).payment_status === 'PAID'));

  const single = fixture();
  payItems(single).forEach((item, i) => {
    const planId = Object.values(single.plans)[i];
    const r = single.ctx.api_paymentActivity({ action: 'PAY', plan_id: planId, date: single.today, account_id: item.account_id,
      lines: [{ schedule_id: item.schedule_id, amount: item.amount }] }, 'monthly-single-' + i);
    assert.equal(r.ok, true, JSON.stringify(r));
  });
  assert.deepEqual(outcome(batch.ctx), outcome(single.ctx));
  const types = outcome(batch.ctx).transactions.map((t) => t[0]);
  assert.deepEqual(types.filter((t) => t === 'CREDIT_PAYMENT').length, 2);
  assert.deepEqual(types.filter((t) => t === 'EXPENSE').length, 1);
});

test('ส่งซ้ำด้วย key เดิมไม่บันทึกซ้ำ ส่วน key เดิมแต่ข้อมูลต่างถูกปฏิเสธ', () => {
  const f = fixture();
  const input = { action: 'PAY', date: f.today, items: payItems(f) };
  const first = f.ctx.api_monthlyBatch(input, 'monthly-replay-key');
  const before = outcome(f.ctx);
  const again = f.ctx.api_monthlyBatch(input, 'monthly-replay-key');
  assert.equal(again.ok, true);
  assert.deepEqual(plain(again.data.result), plain(first.data.result));
  assert.deepEqual(outcome(f.ctx), before);
  const changed = f.ctx.api_monthlyBatch({ ...input, note: 'อื่น' }, 'monthly-replay-key');
  assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT');
});

test('ชำระสองงวดของแผนเดียวกันจากบัญชีเดียวกันรวมเป็นธุรกรรมเดียว', () => {
  const f = fixture();
  const items = [1, 2].map((no) => ({ schedule_id: f.due(f.plans.fridge, no).schedule_id, account_id: f.ids.cash.account_id, amount: 300 }));
  assert.equal(f.ctx.api_monthlyBatch({ action: 'PAY', date: f.today, items }, 'monthly-two-lines').ok, true);
  const payments = plain(f.ctx.Database.readAll('Transactions').rows).filter((t) => t.transaction_type === 'CREDIT_PAYMENT');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amount, 600);
  assert.equal(plain(f.ctx.Database.readAll('PaymentAllocations').rows).length, 2);
});

test('กันเงินหลายงวดแล้วชำระด้วยเงินกันไว้ เงินกันถูกใช้ (CONSUME) และยอดกันไว้เหลือ 0', () => {
  const f = fixture();
  const reserve = Object.values(f.plans).map((planId) => {
    const row = f.due(planId);
    return { schedule_id: row.schedule_id, account_id: f.ids.cash.account_id, amount: row.remaining_to_save };
  });
  const saved = f.ctx.api_monthlyBatch({ action: 'RESERVE', date: f.today, items: reserve }, 'monthly-reserve');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.data.result.total, 1030);
  assert.ok(f.schedules().filter((r) => r.installment_no === 1).every((r) => r.saving_status === 'SAVED'));
  assert.equal(f.ctx.api_monthlyBatch({ action: 'PAY', date: f.today, items: payItems(f) }, 'monthly-pay-reserved').ok, true);
  const first = f.schedules().filter((r) => r.installment_no === 1);
  assert.ok(first.every((r) => r.amount_reserved === 0 && r.payment_status === 'PAID'));
  const consumed = plain(f.ctx.Database.readAll('Reservations').rows).filter((r) => r.action_type === 'CONSUME')
    .reduce((s, r) => s + r.amount, 0);
  assert.equal(consumed, 1030);
});

test('ตรวจสอบทั้งชุดก่อนเขียน: ข้อมูลผิดข้อเดียวไม่บันทึกอะไรเลย', () => {
  const f = fixture();
  const items = payItems(f);
  const cases = [
    ['ซ้ำ', { items: [items[0], items[0]] }],
    ['เกินยอดค้าง', { items: [{ ...items[0], amount: 99999 }] }],
    ['ว่าง', { items: [] }],
    ['เกินจำนวน', { items: Array.from({ length: 31 }, () => items[0]) }],
    ['ประเภทผิด', { action: 'RELEASE' }],
    ['วันอนาคต', { date: '2999-01-01' }],
    // ธนาคารมี 300: แผนแรก 230 ผ่าน แต่ยอดรวมเกิน จึงต้องไม่บันทึกแม้แต่แผนแรก
    ['เงินไม่พอรวมทั้งชุด', { items: payItems(f, f.ids.bank.account_id) }],
    ['บัญชีหนี้จ่ายแทนเงินสด', { items: [{ ...items[0], account_id: f.ids.card.account_id }] }]
  ];
  const before = outcome(f.ctx);
  cases.forEach(([label, patch], i) => {
    const res = f.ctx.api_monthlyBatch({ action: 'PAY', date: f.today, items, ...patch }, 'monthly-invalid-' + i);
    assert.equal(res.ok, false, label);
    assert.match(res.code, /^VALIDATION_/, label + ' ' + res.code);
  });
  assert.deepEqual(outcome(f.ctx), before);
});

// One-shot outage at a physical write; "after" means the write landed but the reply was lost.
function writes(ctx, failAt, timing) {
  const calls = [];
  let fired = false;
  const restores = ctx.__ss.getSheets().map((sheet) => {
    const original = sheet.getRange;
    sheet.getRange = function (...args) {
      const range = original.apply(this, args);
      const set = range.setValues;
      range.setValues = function (values) {
        calls.push(sheet.name);
        const fail = !fired && calls.length === failAt;
        if (fail) fired = true;
        if (fail && timing === 'before') throw new Error('Injected outage');
        const result = set.call(this, values);
        if (fail) throw new Error('Injected lost reply');
        return result;
      };
      return range;
    };
    return () => { sheet.getRange = original; };
  });
  return { calls, fired: () => fired, stop: () => restores.forEach((r) => r()) };
}

test('กู้คืนทุกจุดเขียนของการชำระหลายแผน และงานค้างบล็อกการชำระทีละแผนจนกว่าจะ retry', () => {
  const reference = fixture();
  const measure = writes(reference.ctx, Infinity, 'before');
  assert.equal(reference.ctx.api_monthlyBatch({ action: 'PAY', date: reference.today, items: payItems(reference) }, 'monthly-fault-key').ok, true);
  measure.stop();
  const expected = outcome(reference.ctx);
  for (const timing of ['before', 'after']) {
    for (let point = 1; point <= measure.calls.length; point++) {
      const f = fixture();
      const input = { action: 'PAY', date: f.today, items: payItems(f) };
      const fault = writes(f.ctx, point, timing);
      const failed = f.ctx.api_monthlyBatch(input, 'monthly-fault-key');
      fault.stop();
      const label = `${timing} #${point} (${measure.calls[point - 1]})`;
      assert.equal(failed.ok, false, label);
      const journal = plain(f.ctx.Database.readAll('OperationJournal').rows).find((r) => r.idempotency_key === 'monthly-fault-key');
      if (journal && journal.status !== 'COMMITTED' && journal.recovery_data) {
        const other = f.ctx.api_paymentActivity({ action: 'NOTE', plan_id: f.plans.net, schedule_id: f.due(f.plans.net).schedule_id,
          note: 'ระหว่างค้าง' }, 'monthly-blocked-' + point);
        assert.equal(other.code, 'BUSY', label + ' pending batch blocks single-plan activity');
      }
      const retry = f.ctx.api_monthlyBatch(input, 'monthly-fault-key');
      assert.equal(retry.ok, true, label + ' ' + JSON.stringify(retry));
      assert.deepEqual(outcome(f.ctx), expected, label);
      assert.equal(f.ctx.__state.locks, 0, label);
    }
  }
});

test('การชำระทีละแผนที่ค้างอยู่บล็อกการบันทึกหลายรายการ', () => {
  const f = fixture();
  const row = f.due(f.plans.net);
  const single = { action: 'PAY', plan_id: f.plans.net, date: f.today, account_id: f.ids.cash.account_id,
    lines: [{ schedule_id: row.schedule_id, amount: 500 }] };
  const probe = fixture();
  const measure = writes(probe.ctx, Infinity, 'before');
  probe.ctx.api_paymentActivity({ ...single, plan_id: probe.plans.net, account_id: probe.ids.cash.account_id,
    lines: [{ schedule_id: probe.due(probe.plans.net).schedule_id, amount: 500 }] }, 'monthly-probe');
  measure.stop();
  const checkpoint = measure.calls.indexOf('Transactions') + 1;
  const fault = writes(f.ctx, checkpoint, 'before');
  assert.equal(f.ctx.api_paymentActivity(single, 'monthly-single-pending').ok, false);
  fault.stop();
  const batch = f.ctx.api_monthlyBatch({ action: 'PAY', date: f.today, items: payItems(f).slice(0, 2) }, 'monthly-after-pending');
  assert.equal(batch.code, 'BUSY');
  assert.equal(f.ctx.api_paymentActivity(single, 'monthly-single-pending').ok, true);
  assert.equal(f.ctx.api_monthlyBatch({ action: 'PAY', date: f.today, items: payItems(f).slice(0, 2) }, 'monthly-after-pending').ok, true);
});

test('ข้อมูลกู้คืนของ 30 งวดบัตร (มีดอกเบี้ย/ค่าธรรมเนียม) ยังอยู่ในขนาดที่ journal รับได้', () => {
  const f = fixture();
  const items = [];
  for (let i = 0; i < 10; i++) {
    const res = f.ctx.api_createPaymentPlan({ purchase_date: f.today, plan_type: 'INSTALLMENT', item_name: 'ผ่อนชิ้นที่ ' + i,
      description: 'รายละเอียดยาวเพื่อทดสอบขนาด '.repeat(10), account_id: f.ids.card.account_id, owner_id: f.ids.dad.owner_id,
      category_id: f.ids.category.category_id, principal_amount: 300, interest_amount: 30, fee_amount: 15, installment_count: 3,
      first_saving_month: f.month, first_payment_month: f.month, purchase_link: 'NEW' }, 'monthly-many-' + i);
    assert.equal(res.ok, true, JSON.stringify(res));
    f.schedules().filter((r) => r.plan_id === res.data.plan_id).forEach((r) =>
      items.push({ schedule_id: r.schedule_id, account_id: f.ids.cash.account_id, amount: r.remaining_to_pay }));
  }
  assert.equal(items.length, 30);
  const res = f.ctx.api_monthlyBatch({ action: 'PAY', date: f.today, note: 'ปิดเดือน', items }, 'monthly-thirty');
  assert.equal(res.ok, true, JSON.stringify(res));
  const journal = plain(f.ctx.Database.readAll('OperationJournal').rows).find((r) => r.idempotency_key === 'monthly-thirty');
  assert.ok(journal.recovery_data.length < f.ctx.Config.MAX_RESULT_REF_LENGTH, String(journal.recovery_data.length));
  const tx = plain(f.ctx.Database.readAll('Transactions').rows).filter((t) => t.source === 'PLAN' && t.note === 'ปิดเดือน');
  assert.ok(tx.length >= 10);
  // Names compacted out of the checkpoint are restored on write (CREDIT_PAYMENT has no category by rule).
  assert.ok(tx.every((t) => t.owner_name === 'พ่อ' && t.item_name && t.from_account_name && t.to_account_name !== undefined));
  assert.ok(tx.filter((t) => t.transaction_type !== 'CREDIT_PAYMENT').every((t) => t.category_name === 'ของใช้'));
  assert.ok(tx.filter((t) => t.transaction_type === 'CREDIT_PAYMENT').every((t) => t.to_account_name === 'บัตร'));
});

test('Dashboard นับงานเดือนนี้ รวมงวดค้างจากเดือนก่อน และตามตัวกรองเจ้าของ', () => {
  const f = fixture();
  const all = plain(f.ctx.api_dashboard({ month: f.month }).data.monthPlan);
  assert.equal(all.month, f.month);
  assert.equal(all.payCount, 3);
  assert.equal(all.pay, 1030);
  assert.ok(all.saveCount >= 3);
  const mom = plain(f.ctx.api_dashboard({ month: f.month, owner_id: f.ids.mom.owner_id }).data.monthPlan);
  assert.equal(mom.payCount, 1);
  assert.equal(mom.pay, 300);
  assert.equal(f.ctx.api_monthlyBatch({ action: 'PAY', date: f.today, items: payItems(f) }, 'monthly-dash-pay').ok, true);
  assert.equal(plain(f.ctx.api_dashboard({ month: f.month }).data.monthPlan).payCount, 0);
});

test('เลขแผนสำหรับแสดงผลเรียงตามลำดับที่สร้าง ไม่ซ้ำ และไม่เปลี่ยนเมื่อยกเลิกแผนหรือสร้างแผนใหม่', () => {
  const f = fixture();
  const numbers = () => Object.fromEntries(plain(f.ctx.api_paymentPlannerPage().data.plans).map((r) => [r.plan.item_name, r.plan_no]));
  const before = numbers();
  assert.deepEqual(Object.values(before).sort((a, b) => a - b), [1, 2, 3]);
  assert.ok(before['โทรศัพท์'] < before['ตู้เย็น'] && before['ตู้เย็น'] < before['อินเทอร์เน็ต'], JSON.stringify(before));
  const cancel = f.ctx.api_paymentActivity({ action: 'CANCEL', plan_id: f.plans.fridge, note: 'ยกเลิกทดสอบ' }, 'monthly-no-cancel');
  assert.equal(cancel.ok, true, JSON.stringify(cancel));
  const added = f.ctx.api_createPaymentPlan({ purchase_date: f.today, plan_type: 'ONE_TIME', item_name: 'โทรศัพท์', account_id: f.ids.cash.account_id,
    owner_id: f.ids.mom.owner_id, category_id: f.ids.category.category_id, principal_amount: 100, installment_count: 1,
    first_saving_month: f.month, first_payment_month: f.month }, 'monthly-no-same-name');
  assert.equal(added.ok, true, JSON.stringify(added));
  const after = plain(f.ctx.api_paymentPlannerPage().data.plans);
  const byId = Object.fromEntries(after.map((r) => [r.plan.plan_id, r.plan_no]));
  assert.equal(byId[f.plans.phone], before['โทรศัพท์']);
  assert.equal(byId[f.plans.fridge], before['ตู้เย็น']);
  assert.equal(byId[f.plans.net], before['อินเทอร์เน็ต']);
  assert.equal(byId[added.data.plan_id], 4, 'same item name gets its own next number');
});

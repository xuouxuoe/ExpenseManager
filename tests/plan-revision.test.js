'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture({ card = false, count = 6, principal = 600, interest = 0, fee = 0 } = {}) {
  const ctx = createDbContext();
  let seq = 0;
  const key = () => 'revision-test-' + (++seq);
  const req = () => ({ actor: { actorId: 'owner@example.com' }, idempotencyKey: key() });
  const master = (type, fields) => ctx.MasterData.create(type, fields, req());
  const cash = master('account', { account_name: 'เงินทดสอบ', account_type: 'BANK', opening_balance: 10000 });
  const other = master('account', { account_name: 'อีกบัญชี', account_type: 'CASH', opening_balance: 1000 });
  const debt = card ? master('account', { account_name: 'บัตรทดสอบ', account_type: 'CREDIT_CARD' }) : cash;
  const owner = master('owner', { owner_name: 'เจ้าของ' });
  const category = master('category', { category_name: 'ของใช้', category_type: 'EXPENSE' });
  const created = ctx.api_createPaymentPlan({ item_name: 'แผนทดสอบ', plan_type: 'INSTALLMENT', purchase_date: ctx.Util.todayIso(),
    owner_id: owner.owner_id, category_id: category.category_id, account_id: debt.account_id, principal_amount: principal,
    interest_amount: interest, fee_amount: fee, fee_timing: fee ? 'FIRST' : 'SPREAD', installment_count: count,
    first_saving_month: 202611, first_payment_month: 202612, due_day: 31, purchase_link: card ? 'NEW' : 'NONE' }, key());
  assert.equal(created.ok, true, JSON.stringify(created));
  const planId = created.data.plan_id;
  const record = () => plain(ctx.api_paymentPlannerPage()).data.plans.find((r) => r.plan.plan_id === planId);
  const input = (fields) => ({ plan_id: planId, date: ctx.Util.todayIso(), note: 'ทดสอบปรับแผน', ...fields });
  const act = (fields, requestKey = key()) => ctx.api_paymentActivity(input(fields), requestKey);
  const preview = (fields) => ctx.api_previewPaymentActivity(input(fields));
  const commit = (fields, requestKey = key()) => {
    const quote = preview(fields);
    assert.equal(quote.ok, true, JSON.stringify(quote));
    const result = act({ ...fields, preview_version: quote.data.version }, requestKey);
    assert.equal(result.ok, true, JSON.stringify(result));
    return { result, quote: quote.data };
  };
  return { ctx, key, cash, other, debt, planId, record, act, preview, commit };
}

test('ปรับยอดและเดือนของงวดค้าง รักษาผลรวม ปลดเงินส่วนเกิน และตรวจ stale preview', () => {
  const { ctx, cash, record, act, preview, commit } = fixture();
  let rows = record().schedules;
  assert.equal(act({ action: 'RESERVE', schedule_id: rows[0].schedule_id, account_id: cash.account_id, amount: 70 }).ok, true);
  assert.equal(act({ action: 'PAY', account_id: cash.account_id, lines: [{ schedule_id: rows[0].schedule_id, amount: 20 }] }).ok, true);
  rows = record().schedules;
  const fields = { action: 'RESCHEDULE', schedule_changes: rows.map((s, i) => ({ schedule_id: s.schedule_id,
    amount_due: i === 0 ? 50 : i === 1 ? 150 : 100, saving_month: 202701, payment_month: 202702, due_day: 31 })) };
  const beforeTransactions = plain(ctx.Database.readAll('Transactions').rows);
  const quote = preview(fields);
  assert.equal(quote.data.released_amount, 20);
  assert.equal(record().schedules[0].amount_due, 100, 'preview ไม่มีการเขียนข้อมูล');
  assert.equal(act({ action: 'NOTE', schedule_id: rows[0].schedule_id, note: 'เปลี่ยนหลัง preview' }).ok, true);
  assert.equal(act({ ...fields, preview_version: quote.data.version }).code, 'VALIDATION_PLAN_CHANGED');
  commit(fields);
  const after = record();
  assert.equal(after.plan.total_amount, 600);
  assert.deepEqual(after.schedules.map((s) => s.amount_due), [50, 150, 100, 100, 100, 100]);
  assert.equal(after.schedules[0].amount_paid, 20);
  assert.equal(after.schedules[0].amount_reserved, 30);
  assert.equal(after.schedules[0].due_date, '2027-02-28');
  assert.equal(after.schedules[0].saving_year, 2027);
  assert.equal(after.schedules[0].payment_month_no, 2);
  assert.equal(after.schedules[0].is_month_different, true);
  assert.equal(after.schedules[0].note, 'เปลี่ยนหลัง preview');
  assert.deepEqual(plain(ctx.Database.readAll('Transactions').rows), beforeTransactions);
  assert.equal(preview({ ...fields, schedule_changes: fields.schedule_changes.map((c) => ({ ...c, amount_due: 1 })) }).ok, false);
});

test('ปิดยอดบัตรหลังจ่ายบางส่วน รับรู้ดอกและค่าธรรมเนียมจริง ไม่ซ้ำ และกลับรายการคืนตารางกับเงินกันไว้', () => {
  const { ctx, cash, other, debt, record, act, preview, key, commit } = fixture({ card: true, principal: 1000, interest: 100, fee: 20 });
  const first = record().schedules[0];
  assert.equal(act({ action: 'PAY', account_id: cash.account_id, lines: [{ schedule_id: first.schedule_id, amount: first.amount_due }] }).ok, true);
  const rows = record().schedules;
  assert.equal(act({ action: 'RESERVE', account_id: cash.account_id, schedule_id: rows[2].schedule_id, amount: 100 }).ok, true);
  assert.equal(act({ action: 'RESERVE', account_id: other.account_id, schedule_id: rows[3].schedule_id, amount: 70 }).ok, true);
  const before = record();
  const cashBefore = plain(ctx.Transactions.accountBalances());
  const savedBefore = ctx.api_dashboard({}).data.summary.saved;
  const fields = { action: 'SETTLE', account_id: cash.account_id, settlement_interest_amount: 10, settlement_fee_amount: 5 };
  const requestKey = key();
  const { quote } = commit(fields, requestKey);
  assert.equal(quote.settlement_amount, 848.33);
  assert.equal(record().plan.total_amount, 1051.66);
  assert.equal(record().plan.plan_status, 'COMPLETED');
  assert.equal(ctx.Transactions.accountBalances()[debt.account_id], 0);
  assert.equal(act({ ...fields, preview_version: quote.version }, requestKey).ok, true);
  const paymentId = record().settlement_payment_id;
  assert.ok(paymentId);
  const tx = ctx.Database.readAll('Transactions').rows;
  assert.equal(tx.filter((r) => r.transaction_id === paymentId).length, 1);
  assert.equal(tx.filter((r) => r.external_ref === paymentId && r.transaction_type === 'INTEREST')[0].amount, 10);
  assert.equal(tx.filter((r) => r.external_ref === paymentId && r.transaction_type === 'FEE')[0].amount, 5);
  assert.equal(ctx.api_dashboard({}).data.summary.expense, 1051.66);
  assert.equal(preview(fields).ok, false);
  const oldPayment = before.payments[0].transaction_id;
  assert.equal(act({ action: 'REVERSE_PAY', transaction_id: oldPayment }).ok, false);
  assert.equal(act({ action: 'REVERSE_PAY', transaction_id: paymentId }).ok, true);
  const restored = record();
  assert.equal(restored.plan.total_amount, before.plan.total_amount);
  assert.equal(restored.plan.plan_status, 'ACTIVE');
  assert.deepEqual(restored.schedules.map((s) => [s.amount_due, s.is_cancelled, s.amount_paid, s.amount_reserved]),
    before.schedules.map((s) => [s.amount_due, s.is_cancelled, s.amount_paid, s.amount_reserved]));
  assert.deepEqual(plain(ctx.Transactions.accountBalances()), cashBefore);
  assert.equal(ctx.api_dashboard({}).data.summary.saved, savedBefore);
});

test('ปิดแผนแบบรายจ่ายและ retry หลังเขียนเงินสำเร็จแต่ตารางล้มเหลว ไม่เกิดธุรกรรมหรือ allocation ซ้ำ', () => {
  const { ctx, cash, record, act, preview, key } = fixture();
  const fields = { action: 'SETTLE', account_id: cash.account_id, settlement_interest_amount: 0, settlement_fee_amount: 0 };
  const quote = preview(fields);
  assert.equal(quote.data.settlement_amount, 600);
  const payload = { ...fields, preview_version: quote.data.version };
  const requestKey = key();
  const original = ctx.Database.updateRows;
  ctx.Database.updateRows = (name, rows) => {
    if (name === 'PaymentSchedules') throw new Error('injected schedule failure');
    return original(name, rows);
  };
  assert.equal(act(payload, requestKey).ok, false);
  ctx.Database.updateRows = original;
  assert.equal(act(payload, requestKey).ok, true);
  assert.equal(record().plan.plan_status, 'COMPLETED');
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 1);
  assert.equal(ctx.Database.readAll('PaymentAllocations').rows.length, 1);
  assert.equal(ctx.api_dashboard({}).data.summary.expense, 600);
  assert.equal(act({ action: 'REVERSE_PAY', transaction_id: record().settlement_payment_id }).ok, true);
  assert.equal(record().plan.plan_status, 'ACTIVE');
});

test('แผน 360 งวดปิดยอดและกลับรายการได้ และปฏิเสธข้อมูลไม่ครบหรือยอดติดลบ', () => {
  const { record, cash, commit, act, preview } = fixture({ count: 360, principal: 3600 });
  assert.equal(preview({ action: 'SETTLE', account_id: cash.account_id, settlement_interest_amount: -1, settlement_fee_amount: 0 }).ok, false);
  assert.equal(act({ action: 'SETTLE', account_id: cash.account_id, settlement_interest_amount: 0, settlement_fee_amount: 0 }).code, 'VALIDATION_PLAN_CHANGED');
  commit({ action: 'SETTLE', account_id: cash.account_id, settlement_interest_amount: 0, settlement_fee_amount: 0 });
  assert.equal(record().plan.plan_status, 'COMPLETED');
  assert.equal(act({ action: 'REVERSE_PAY', transaction_id: record().settlement_payment_id }).ok, true);
  assert.ok(record().schedules.every((s) => !s.is_cancelled && s.amount_due === 10));
});

test('ปิดยอดหลังยกเลิกงวดรายจ่าย ไม่เรียกเก็บภาระที่ยกเลิก แต่หนี้บัตรยังต้องชำระเงินต้นจริง', () => {
  for (const card of [false, true]) {
    const { ctx, cash, debt, record, act, commit } = fixture({ card });
    const first = record().schedules[0];
    assert.equal(act({ action: 'PAY', account_id: cash.account_id,
      lines: [{ schedule_id: first.schedule_id, amount: 20 }] }).ok, true);
    assert.equal(act({ action: 'CANCEL', schedule_id: first.schedule_id }).ok, true);
    const before = record();
    const { quote } = commit({ action: 'SETTLE', account_id: cash.account_id,
      settlement_interest_amount: 0, settlement_fee_amount: 0 });
    assert.equal(quote.settlement_amount, card ? 580 : 500);
    assert.equal(record().plan.principal_amount, card ? 600 : 520);
    assert.equal(record().plan.total_amount, card ? 600 : 520);
    assert.equal(record().plan.plan_status, 'COMPLETED');
    if (card) assert.equal(ctx.Transactions.accountBalances()[debt.account_id], 0);
    assert.equal(act({ action: 'REVERSE_PAY', transaction_id: record().settlement_payment_id }).ok, true);
    assert.deepEqual(record().schedules.map((s) => [s.amount_due, s.amount_paid, s.is_cancelled]),
      before.schedules.map((s) => [s.amount_due, s.amount_paid, s.is_cancelled]));
    assert.equal(record().plan.total_amount, 600);
  }
});

test('ปรับงวดที่ค้างแล้วเขียนล้มเหลว กู้คำขอเดิมได้ครั้งเดียวและเก็บงวดที่ชำระครบไว้เดิม', () => {
  const { ctx, cash, record, act, preview, key } = fixture();
  const first = record().schedules[0];
  assert.equal(act({ action: 'PAY', account_id: cash.account_id,
    lines: [{ schedule_id: first.schedule_id, amount: first.amount_due }] }).ok, true);
  const before = record();
  const fields = { action: 'RESCHEDULE', schedule_changes: before.schedules.slice(1).map((s, i) => ({
    schedule_id: s.schedule_id, amount_due: i === 0 ? 50 : i === 1 ? 150 : 100,
    saving_month: 202612, payment_month: 202701, due_day: 31 })) };
  const quote = preview(fields);
  assert.equal(quote.ok, true);
  const payload = { ...fields, preview_version: quote.data.version };
  const requestKey = key();
  const original = ctx.Database.updateRows;
  ctx.Database.updateRows = (name, rows) => {
    if (name === 'PaymentPlans') throw new Error('injected plan failure after schedules');
    return original(name, rows);
  };
  assert.equal(act(payload, requestKey).ok, false);
  ctx.Database.updateRows = original;
  assert.equal(act(payload, requestKey).ok, true);
  assert.equal(act(payload, requestKey).ok, true);
  const after = record();
  assert.deepEqual(after.schedules.map((s) => s.amount_due), [100, 50, 150, 100, 100, 100]);
  ['amount_due', 'amount_paid', 'saving_month', 'payment_month', 'due_date', 'note'].forEach((field) =>
    assert.equal(after.schedules[0][field], before.schedules[0][field]));
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 1);
  assert.equal(ctx.Database.readAll('PaymentAllocations').rows.length, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const ctx = createDbContext();
  const actor = { actorId: 'owner@example.com' };
  const owner = ctx.MasterData.create('owner', { owner_name: 'เจ้าของ' }, { actor, idempotencyKey: 'planner-seed-owner' });
  const account = ctx.MasterData.create('account', { account_name: 'เงินสด', account_type: 'CASH', opening_balance: 1000 }, { actor, idempotencyKey: 'planner-seed-account' });
  const category = ctx.MasterData.create('category', { category_name: 'ของใช้', category_type: 'EXPENSE' }, { actor, idempotencyKey: 'planner-seed-category' });
  const input = {
    item_name: 'ของใช้รายเดือน', purchase_date: '2026-11-25', plan_type: 'INSTALLMENT',
    owner_id: owner.owner_id, account_id: account.account_id, category_id: category.category_id,
    principal_amount: '570', interest_amount: '20', fee_amount: '10', installment_count: 6,
    first_saving_month: 202611, first_payment_month: 202612, due_day: 31,
    description: 'รายละเอียดแผน', note: 'หมายเหตุแผน', owner_name: 'ค่าที่ส่งจาก client'
  };
  return { ctx, input, actor, account };
}

test('ตัวอย่าง 600 บาท 6 งวด ข้ามปีและครบกำหนดปลายเดือน โดยไม่เขียนชีต', () => {
  const { ctx, input } = fixture();
  const preview = plain(ctx.api_previewPaymentPlan(input));
  assert.equal(preview.ok, true);
  assert.equal(preview.data.plan.total_amount, 600);
  const rows = preview.data.schedules;
  assert.deepEqual(rows.map((r) => r.installment_no), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows.map((r) => r.saving_month), [202611, 202612, 202701, 202702, 202703, 202704]);
  assert.deepEqual(rows.map((r) => r.payment_month), [202612, 202701, 202702, 202703, 202704, 202705]);
  assert.equal(rows[2].due_date, '2027-02-28');
  assert.ok(rows.every((r) => r.installment_count === 6 && r.amount_due === 100 && r.note === '' &&
    r.account_name === 'เงินสด' && r.owner_name === 'เจ้าของ' && r.category_name === 'ของใช้' && r.description === input.description));
  assert.equal(ctx.Database.readAll('PaymentPlans').rows.length, 0);
  assert.equal(ctx.Database.readAll('PaymentSchedules').rows.length, 0);
});

test('รองรับแผนครั้งเดียว แผนประจำ เศษสตางค์ และปฏิเสธเดือนหรือยอดรายงวดผิด', () => {
  const { ctx, input } = fixture();
  const f = { ...input, principal_amount: 1000, interest_amount: '', fee_amount: '', due_day: '', installment_count: 3, plan_type: 'RECURRING' };
  const rows = plain(ctx.api_previewPaymentPlan(f)).data.schedules;
  assert.deepEqual(rows.map((r) => r.amount_due), [333.33, 333.33, 333.34]);
  assert.ok(rows.every((r) => r.due_date === '' && !r.is_overdue));
  assert.equal(ctx.api_previewPaymentPlan({ ...f, plan_type: 'ONE_TIME', installment_count: 1 }).data.schedules.length, 1);
  assert.equal(ctx.api_previewPaymentPlan({ ...f, plan_type: 'ONE_TIME' }).ok, false);
  for (const invalidMonth of [202613, 202600, 20261]) {
    assert.equal(ctx.api_previewPaymentPlan({ ...f, first_saving_month: invalidMonth }).ok, false);
  }
  assert.equal(ctx.api_previewPaymentPlan({ ...f, schedule_amounts: [400, 300, 299] }).ok, false);
  assert.equal(ctx.api_previewPaymentPlan({ ...f, schedule_amounts: [400, 300, 300] }).ok, true);
});

test('สร้างแผนและคืนหน้ารายการจริงด้วย ID เดิมเมื่อส่งซ้ำ โดยไม่มีธุรกรรมจริง', () => {
  const { ctx, input } = fixture();
  const payload = { ...input, schedule_amounts: [50, 150, 100, 100, 100, 100] };
  const first = ctx.api_createPaymentPlan(payload, 'planner-create-key');
  const replay = ctx.api_createPaymentPlan(payload, 'planner-create-key');
  assert.equal(first.ok, true);
  assert.equal(replay.data.plan_id, first.data.plan_id);
  assert.equal(ctx.api_createPaymentPlan({ ...payload, note: 'แก้' }, 'planner-create-key').code, 'IDEMPOTENCY_CONFLICT');
  const page = plain(ctx.api_paymentPlannerPage()).data;
  assert.equal(page.plans.length, 1);
  assert.deepEqual(page.plans[0].schedules.map((r) => r.amount_due), payload.schedule_amounts);
  assert.ok(page.plans[0].schedules.every((r) => r.plan_id === first.data.plan_id));
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 0);
});

test('เขียนงวดล้มเหลว กู้คืนโดยใช้แผนเดิมและไม่ซ้ำ แม้บัญชีถูกปิดภายหลัง', () => {
  const { ctx, input, actor, account } = fixture();
  const append = ctx.Database.appendRowsIfAbsent;
  ctx.Database.appendRowsIfAbsent = (name, rows) => {
    if (name === 'PaymentSchedules') throw new Error('injected schedule write error');
    return append(name, rows);
  };
  const key = 'planner-recovery-key';
  assert.equal(ctx.api_createPaymentPlan(input, key).ok, false);
  const row = ctx.Database.readAll('PaymentPlans').rows[0];
  assert.equal(ctx.api_paymentPlannerPage().data.plans.length, 0);
  const journal = ctx.Database.readAll('OperationJournal').rows.find((entry) => entry.idempotency_key === key);
  assert.equal(journal.status, 'NEEDS_RECOVERY');
  assert.equal(JSON.parse(journal.recovery_data).plan.plan_id, row.plan_id);
  ctx.MasterData.setActive('account', account.account_id, false, { actor, idempotencyKey: 'planner-inactivate-account' });
  ctx.Database.appendRowsIfAbsent = append;
  const retry = ctx.api_createPaymentPlan(input, key);
  assert.equal(retry.ok, true);
  assert.equal(retry.data.plan_id, row.plan_id);
  const schedules = ctx.Database.readAll('PaymentSchedules').rows;
  assert.equal(schedules.length, 6);
  assert.ok(schedules.every((schedule) => schedule.created_at === row.created_at));
  assert.equal(ctx.Database.readAll('PaymentPlans').rows.length, 1);
});

test('API หน้าตัวอย่างและการเขียนตรวจสิทธิ์', () => {
  const { ctx, input } = fixture();
  ctx.__state.activeEmail = 'other@example.com';
  assert.equal(ctx.api_paymentPlannerPage().code, 'FORBIDDEN');
  assert.equal(ctx.api_previewPaymentPlan(input).code, 'FORBIDDEN');
  assert.equal(ctx.api_createPaymentPlan(input, 'planner-forbidden').code, 'FORBIDDEN');
});

test('กันเงินหลายบัญชี ชำระหลายงวด และยกเลิกเฉพาะภาระคงค้าง', () => {
  const { ctx, input, actor, account } = fixture();
  const second = ctx.MasterData.create('account', { account_name: 'บัญชีสอง', account_type: 'BANK', opening_balance: 500 }, {
    actor, idempotencyKey: 'planner-fund-second'
  });
  const planId = ctx.api_createPaymentPlan(input, 'planner-full-activity').data.plan_id;
  const schedules = () => plain(ctx.api_paymentPlannerPage().data.plans[0].schedules);
  const [one, two] = schedules();
  const date = ctx.Util.todayIso();
  const act = (action, key, fields) => ctx.api_paymentActivity({ action, plan_id: planId, date, ...fields }, 'activity-' + key);
  assert.equal(act('RESERVE', 'one-first', { schedule_id: one.schedule_id, account_id: account.account_id, amount: 40 }).ok, true);
  assert.equal(act('RESERVE', 'one-second', { schedule_id: one.schedule_id, account_id: second.account_id, amount: 50 }).ok, true);
  assert.equal(act('RESERVE', 'too-much', { schedule_id: one.schedule_id, account_id: second.account_id, amount: 11 }).ok, false);
  assert.equal(act('RELEASE', 'release', { schedule_id: one.schedule_id, account_id: second.account_id, amount: 10 }).ok, true);
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 0);
  assert.equal(schedules()[0].amount_reserved, 80);

  const pay = { account_id: account.account_id, lines: [{ schedule_id: one.schedule_id, amount: 100 }, { schedule_id: two.schedule_id, amount: 25 }] };
  assert.equal(act('PAY', 'multiline', pay).ok, true);
  assert.equal(act('PAY', 'multiline', pay).ok, true);
  const result = schedules();
  assert.equal(result[0].payment_status, 'PAID');
  assert.equal(result[0].saving_status, 'NOT_REQUIRED');
  assert.equal(result[0].amount_reserved, 0);
  assert.equal(result[1].payment_status, 'PARTIAL');
  assert.equal(result[1].remaining_to_pay, 75);
  assert.equal(ctx.Database.readAll('PaymentAllocations').rows.length, 2);
  const transactions = ctx.Database.readAll('Transactions').rows;
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].amount, 125);
  assert.equal(ctx.api_reverseTransaction(transactions[0].transaction_id, { reason: 'ทดสอบ' }, 'activity-reverse-rejected').ok, false);

  const month = Number(date.slice(0, 7).replace('-', ''));
  const dashboard = plain(ctx.api_dashboard({ month, owner_id: input.owner_id })).data;
  assert.equal(dashboard.summary.expense, 125);
  assert.equal(dashboard.summary.cashFlow, -125);
  assert.equal(dashboard.summary.paid, 125);
  assert.equal(dashboard.accounts.find((a) => a.name === 'เงินสด').available, 875);
  const csv = ctx.api_exportFinanceReport('TRANSACTIONS', { month }).data;
  assert.match(csv, /125,0,125/);
  assert.equal(act('CANCEL', 'whole', { note: 'ยกเลิกงวดคงเหลือ' }).ok, true);
  assert.equal(schedules()[0].is_cancelled, false);
  assert.equal(schedules()[1].is_cancelled, true);
  assert.equal(schedules()[1].amount_paid, 25);
  assert.equal(act('REVERSE_PAY', 'reverse-allocated', { transaction_id: transactions[0].transaction_id, note: 'แก้รายการชำระทดสอบ' }).ok, true);
  assert.equal(schedules()[1].is_cancelled, true);
  assert.equal(schedules()[1].amount_paid, 0);
  assert.equal(ctx.api_dashboard({ month }).data.summary.paid, 0);
  assert.equal(ctx.api_dashboard({ month }).data.summary.expense, 0);
  assert.equal(ctx.Database.readAll('PaymentAllocations').rows.length, 2);
});

test('หมายเหตุรายงวดอยู่ครบเมื่อแก้แผนและต่ออายุด้วย key เดิม', () => {
  const { ctx, input } = fixture();
  const plan = ctx.api_createPaymentPlan({ ...input, plan_type: 'RECURRING' }, 'planner-renew-create').data.plan_id;
  const initial = ctx.api_paymentPlannerPage().data.plans[0].schedules[0].schedule_id;
  const apply = (action, key, details) => ctx.api_paymentActivity({ action, plan_id: plan, ...details }, 'planner-renew-' + key);
  assert.equal(apply('NOTE', 'note', { schedule_id: initial, note: 'งวดแรก' }).ok, true);
  assert.equal(apply('EDIT_PLAN', 'edit', { item_name: 'ชื่อใหม่', note: 'หมายเหตุหลัก' }).ok, true);
  assert.equal(apply('RENEW', 'extend', { additional_count: 2, renewal_amount: 200 }).ok, true);
  assert.equal(apply('RENEW', 'extend', { additional_count: 2, renewal_amount: 200 }).ok, true);
  const record = plain(ctx.api_paymentPlannerPage()).data.plans[0];
  assert.equal(record.plan.total_amount, 800);
  assert.equal(record.schedules.length, 8);
  assert.equal(record.schedules[0].note, 'งวดแรก');
  assert.ok(record.schedules.every((r) => r.installment_count === 8 && r.item_name === 'ชื่อใหม่'));
  assert.deepEqual(record.schedules.slice(-2).map((r) => r.payment_month), [202706, 202707]);
});

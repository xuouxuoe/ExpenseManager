'use strict';

// เชื่อมแผนผ่อนกับรายการซื้อด้วยบัตร (CREDIT_PURCHASE) และชำระงวดเป็นชำระหนี้ (CREDIT_PAYMENT)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (value) => JSON.parse(JSON.stringify(value));

function cardFixture() {
  const ctx = createDbContext();
  const actor = { actorId: 'owner@example.com' };
  const owner = ctx.MasterData.create('owner', { owner_name: 'เจ้าของ' }, { actor, idempotencyKey: 'card-seed-owner' });
  const account = ctx.MasterData.create('account', { account_name: 'เงินสด', account_type: 'CASH', opening_balance: 1000 }, { actor, idempotencyKey: 'card-seed-cash' });
  const card = ctx.MasterData.create('account', { account_name: 'บัตรเครดิต', account_type: 'CREDIT_CARD' }, { actor, idempotencyKey: 'card-seed-card' });
  const category = ctx.MasterData.create('category', { category_name: 'เครื่องใช้ไฟฟ้า', category_type: 'EXPENSE' }, { actor, idempotencyKey: 'card-seed-category' });
  const today = ctx.Util.todayIso();
  const input = {
    item_name: 'ทีวี', purchase_date: today, plan_type: 'INSTALLMENT',
    owner_id: owner.owner_id, account_id: card.account_id, category_id: category.category_id,
    principal_amount: '600', interest_amount: '', fee_amount: '', installment_count: 6,
    first_saving_month: 202611, first_payment_month: 202612, due_day: 25, description: 'ผ่อน 0%'
  };
  const balances = () => plain(ctx.Transactions.accountBalances());
  const month = Number(today.slice(0, 7).replace('-', ''));
  const expense = () => plain(ctx.api_dashboard({ month })).data.summary.expense;
  return { ctx, actor, account, card, input, today, balances, expense };
}

test('ผ่อนบัตร: สร้างรายการซื้อพร้อมแผนครั้งเดียว ชำระงวดเป็นชำระหนี้ ไม่นับรายจ่ายซ้ำ', () => {
  const { ctx, input, card, account, today, balances, expense } = cardFixture();
  const payload = { ...input, purchase_link: 'NEW' };
  const preview = plain(ctx.api_previewPaymentPlan(payload)).data;
  assert.equal(preview.purchase.mode, 'NEW');
  assert.equal(preview.purchase.amount, 600);
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 0, 'ตัวอย่างไม่เขียนชีต');

  const planId = ctx.api_createPaymentPlan(payload, 'card-link-new').data.plan_id;
  assert.equal(ctx.api_createPaymentPlan(payload, 'card-link-new').data.plan_id, planId);
  const purchases = ctx.Database.readAll('Transactions').rows;
  assert.equal(purchases.length, 1, 'replay ไม่สร้างรายการซื้อซ้ำ');
  assert.equal(purchases[0].transaction_type, 'CREDIT_PURCHASE');
  assert.equal(purchases[0].plan_id, planId);
  assert.equal(purchases[0].source, 'PLAN');
  assert.equal(purchases[0].from_account_name, 'บัตรเครดิต');
  assert.equal(purchases[0].transaction_date, today);
  assert.equal(balances()[card.account_id], 600);
  assert.equal(expense(), 600);
  const record = plain(ctx.api_paymentPlannerPage()).data.plans[0];
  assert.equal(record.purchase.transaction_id, purchases[0].transaction_id);
  assert.equal(ctx.api_reverseTransaction(purchases[0].transaction_id, { reason: 'ทดสอบ' }, 'card-link-manual-reverse').code, 'VALIDATION_RULE');

  const act = (action, key, fields) => ctx.api_paymentActivity({ action, plan_id: planId, date: today, ...fields }, 'card-link-' + key);
  const first = record.schedules[0];
  assert.equal(act('RESERVE', 'reserve', { schedule_id: first.schedule_id, account_id: account.account_id, amount: 100 }).ok, true);
  assert.equal(act('PAY', 'pay', { account_id: account.account_id, lines: [{ schedule_id: first.schedule_id, amount: 100 }] }).ok, true);
  const payment = ctx.Database.readAll('Transactions').rows.find((r) => r.transaction_type === 'CREDIT_PAYMENT');
  assert.equal(payment.from_account_id, account.account_id);
  assert.equal(payment.to_account_id, card.account_id);
  assert.equal(payment.category_id, '');
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 2, 'แผน 0% ไม่มีดอกเบี้ยแยก');
  assert.equal(balances()[card.account_id], 500);
  assert.equal(balances()[account.account_id], 900);
  assert.equal(expense(), 600, 'ชำระหนี้ไม่รับรู้รายจ่ายซ้ำ');
  const paid = plain(ctx.api_paymentPlannerPage()).data.plans[0];
  assert.equal(paid.schedules[0].payment_status, 'PAID');
  assert.equal(paid.schedules[0].amount_reserved, 0);
  assert.equal(paid.payments.length, 1);

  assert.equal(act('REVERSE_PAY', 'reverse', { transaction_id: payment.transaction_id, note: 'บันทึกผิด' }).ok, true);
  assert.equal(balances()[card.account_id], 600);
  assert.equal(balances()[account.account_id], 1000);
  assert.equal(plain(ctx.api_paymentPlannerPage()).data.plans[0].schedules[0].amount_reserved, 100);
});

test('ผ่อนบัตรมีดอกเบี้ย/ค่าธรรมเนียม: รับรู้ตามสัดส่วนเมื่อชำระ ครบพอดีเมื่อชำระครบ และกลับรายการพร้อมกัน', () => {
  const { ctx, input, card, account, today, balances, expense } = cardFixture();
  const payload = { ...input, principal_amount: '570', interest_amount: '20', fee_amount: '10', purchase_link: 'NEW' };
  const planId = ctx.api_createPaymentPlan(payload, 'card-interest-create').data.plan_id;
  assert.equal(expense(), 570, 'ตอนซื้อรับรู้เฉพาะเงินต้น');
  const rows = plain(ctx.api_paymentPlannerPage()).data.plans[0].schedules;
  const act = (action, key, fields) => ctx.api_paymentActivity({ action, plan_id: planId, date: today, ...fields }, 'card-interest-' + key);
  assert.equal(act('PAY', 'first', { account_id: account.account_id, lines: [{ schedule_id: rows[0].schedule_id, amount: 100 }] }).ok, true);
  const charges = () => {
    const all = ctx.Database.readAll('Transactions').rows;
    const reversed = new Set(all.map((r) => r.reversal_of).filter(Boolean));
    return all.filter((r) => ['INTEREST', 'FEE'].includes(r.transaction_type) && !r.reversal_of && !reversed.has(r.transaction_id));
  };
  assert.deepEqual(plain(charges().map((r) => [r.transaction_type, r.amount])), [['INTEREST', 3.33], ['FEE', 1.66]]);
  assert.ok(charges().every((r) => r.from_account_id === card.account_id && r.plan_id === planId && r.category_id === input.category_id));
  assert.equal(balances()[card.account_id], 474.99);

  const rest = rows.slice(1).map((r) => ({ schedule_id: r.schedule_id, amount: r.amount_due }));
  assert.equal(act('PAY', 'rest', { account_id: account.account_id, lines: rest }).ok, true);
  const total = (type) => charges().filter((r) => r.transaction_type === type).reduce((s, r) => s + Math.round(r.amount * 100), 0);
  assert.equal(total('INTEREST'), 2000);
  assert.equal(total('FEE'), 1000);
  assert.equal(balances()[card.account_id], 0);
  assert.equal(balances()[account.account_id], 400);
  assert.equal(expense(), 600, 'รายจ่ายรวม = เงินต้น + ดอกเบี้ย + ค่าธรรมเนียม ครั้งเดียว');
  assert.equal(plain(ctx.api_paymentPlannerPage()).data.plans[0].plan.plan_status, 'COMPLETED');

  const last = ctx.Database.readAll('Transactions').rows.filter((r) => r.transaction_type === 'CREDIT_PAYMENT').pop();
  assert.equal(act('REVERSE_PAY', 'reverse-rest', { transaction_id: last.transaction_id, note: 'บันทึกผิด' }).ok, true);
  assert.equal(total('INTEREST'), 333);
  assert.equal(total('FEE'), 166);
  assert.equal(balances()[card.account_id], 474.99);
  assert.equal(expense(), 574.99);
  assert.equal(plain(ctx.api_paymentPlannerPage()).data.plans[0].plan.plan_status, 'ACTIVE');
});

test('เชื่อมรายการซื้อด้วยบัตรที่บันทึกไว้แล้ว และปฏิเสธกรณีไม่ตรงกัน', () => {
  const { ctx, input, card, account, today } = cardFixture();
  const created = ctx.api_createTransaction({
    transaction_date: today, transaction_type: 'CREDIT_PURCHASE', from_account_id: card.account_id,
    owner_id: input.owner_id, category_id: input.category_id, item_name: 'ทีวีห้องนั่งเล่น', amount: 600
  }, 'card-existing-purchase');
  assert.equal(created.ok, true);
  const purchaseId = ctx.Database.readAll('Transactions').rows[0].transaction_id;
  assert.deepEqual(plain(ctx.api_paymentPlannerPage()).data.purchases.map((r) => r.transaction_id), [purchaseId]);

  const link = { ...input, purchase_link: 'EXISTING', purchase_transaction_id: purchaseId };
  assert.equal(ctx.api_previewPaymentPlan({ ...link, principal_amount: 500 }).code, 'VALIDATION_PLAN');
  assert.equal(ctx.api_previewPaymentPlan({ ...link, account_id: account.account_id }).code, 'VALIDATION_PLAN');
  assert.equal(ctx.api_previewPaymentPlan({ ...input, purchase_link: 'NEW', plan_type: 'RECURRING' }).code, 'VALIDATION_PLAN');
  assert.equal(ctx.api_previewPaymentPlan({ ...input, purchase_link: 'NEW', purchase_date: '2099-01-01' }).code, 'VALIDATION_PLAN');

  const planId = ctx.api_createPaymentPlan(link, 'card-existing-link').data.plan_id;
  const rows = ctx.Database.readAll('Transactions').rows;
  assert.equal(rows.length, 1, 'ไม่สร้างรายการซื้อใหม่');
  assert.equal(rows[0].plan_id, planId);
  assert.equal(rows[0].item_name, 'ทีวีห้องนั่งเล่น', 'ไม่แก้ข้อมูลธุรกรรมจริง');
  assert.equal(plain(ctx.api_paymentPlannerPage()).data.purchases.length, 0);
  assert.equal(ctx.api_createPaymentPlan(link, 'card-existing-again').code, 'VALIDATION_PLAN', 'หนึ่งรายการซื้อเชื่อมได้หนึ่งแผน');
  assert.equal(ctx.api_updateTransaction(purchaseId, {
    transaction_date: today, transaction_type: 'CREDIT_PURCHASE', from_account_id: card.account_id,
    owner_id: input.owner_id, category_id: input.category_id, item_name: 'แก้', amount: 600
  }, 'card-existing-edit').ok, false);
});

test('แผนบัตรที่ไม่เชื่อมรายการซื้อยังชำระเป็นรายจ่าย ส่วนแผนสินเชื่อชำระเป็นชำระหนี้', () => {
  const { ctx, input, account, actor, today, balances, expense } = cardFixture();
  const planId = ctx.api_createPaymentPlan(input, 'card-unlinked').data.plan_id;
  const first = ctx.api_paymentPlannerPage().data.plans[0].schedules[0];
  assert.equal(ctx.api_paymentActivity({ action: 'PAY', plan_id: planId, date: today, account_id: account.account_id,
    lines: [{ schedule_id: first.schedule_id, amount: 100 }] }, 'card-unlinked-pay').ok, true);
  assert.equal(ctx.Database.readAll('Transactions').rows[0].transaction_type, 'EXPENSE');
  assert.equal(expense(), 100);

  const loan = ctx.MasterData.create('account', { account_name: 'สินเชื่อ', account_type: 'LOAN', opening_balance: 1200 }, { actor, idempotencyKey: 'card-seed-loan' });
  const loanPlan = ctx.api_createPaymentPlan({ ...input, account_id: loan.account_id, principal_amount: 1200, installment_count: 12 }, 'loan-plan').data.plan_id;
  const loanRow = plain(ctx.api_paymentPlannerPage()).data.plans.find((r) => r.plan.plan_id === loanPlan).schedules[0];
  assert.equal(ctx.api_paymentActivity({ action: 'PAY', plan_id: loanPlan, date: today, account_id: account.account_id,
    lines: [{ schedule_id: loanRow.schedule_id, amount: 100 }] }, 'loan-plan-pay').ok, true);
  const loanPayment = ctx.Database.readAll('Transactions').rows.find((r) => r.plan_id === loanPlan);
  assert.equal(loanPayment.transaction_type, 'CREDIT_PAYMENT');
  assert.equal(balances()[loan.account_id], 1100);
  assert.equal(expense(), 100, 'คืนเงินต้นสินเชื่อไม่ใช่รายจ่าย');
});

test('สร้างแผนพร้อมรายการซื้อ: เขียนรายการซื้อล้มเหลวแล้ว retry ด้วย key เดิมไม่ซ้ำ', () => {
  const { ctx, input } = cardFixture();
  const append = ctx.Database.appendRowsIfAbsent;
  ctx.Database.appendRowsIfAbsent = (name, rows) => {
    if (name === 'Transactions') throw new Error('injected purchase write error');
    return append(name, rows);
  };
  const payload = { ...input, purchase_link: 'NEW' };
  assert.equal(ctx.api_createPaymentPlan(payload, 'card-link-recover').ok, false);
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 0);
  ctx.Database.appendRowsIfAbsent = append;
  const retry = ctx.api_createPaymentPlan(payload, 'card-link-recover');
  assert.equal(retry.ok, true);
  assert.equal(ctx.Database.readAll('PaymentPlans').rows.length, 1);
  const tx = ctx.Database.readAll('Transactions').rows;
  assert.equal(tx.length, 1);
  assert.equal(tx[0].plan_id, retry.data.plan_id);
});

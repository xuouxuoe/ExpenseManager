'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');
const plain = (v) => JSON.parse(JSON.stringify(v));

function fixture() {
  const ctx = createDbContext();
  const today = ctx.Util.todayIso();
  const month = Number(today.slice(0, 7).replace('-', ''));
  const create = (type, input, suffix) => ctx.MasterData.create(type, input,
    { actor: { actorId: 'owner@example.com' }, idempotencyKey: 'plan-edit-seed-' + suffix });
  const ids = {
    dad: create('owner', { owner_name: 'พ่อ' }, 'dad'),
    mom: create('owner', { owner_name: 'แม่' }, 'mom'),
    cash: create('account', { account_name: 'เงินสด', account_type: 'CASH', opening_balance: 5000 }, 'cash'),
    bank: create('account', { account_name: 'ธนาคาร', account_type: 'BANK', opening_balance: 5000 }, 'bank'),
    card: create('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD' }, 'card'),
    food: create('category', { category_name: 'อาหาร', category_type: 'EXPENSE' }, 'food'),
    home: create('category', { category_name: 'บ้าน', category_type: 'EXPENSE' }, 'home')
  };
  const plan = (key, fields) => {
    const res = ctx.api_createPaymentPlan({ purchase_date: today, plan_type: 'INSTALLMENT', category_id: ids.food.category_id,
      owner_id: ids.dad.owner_id, first_saving_month: month, first_payment_month: month, ...fields }, 'plan-edit-' + key);
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.data.plan_id;
  };
  const act = (planId, key, fields) => ctx.api_paymentActivity({ plan_id: planId, date: today, ...fields }, 'plan-edit-act-' + key);
  const rows = (name, planId) => plain(ctx.Database.readAll(name).rows).filter((r) => r.plan_id === planId);
  return { ctx, today, ids, plan, act, rows };
}

function editInput(plan, patch) {
  return { action: 'EDIT_PLAN', item_name: plan.item_name, description: plan.description || '', ...patch };
}

test('แก้เจ้าของและหมวดหมู่ของแผนบัตรที่มีรายการซื้อและการชำระ: ทุกงวดและธุรกรรมของแผนเปลี่ยนตาม ยอดไม่เปลี่ยน', () => {
  const f = fixture();
  const id = f.plan('card', { item_name: 'ตู้เย็น', account_id: f.ids.card.account_id, principal_amount: 900, interest_amount: 90,
    installment_count: 3, purchase_link: 'NEW' });
  const first = f.rows('PaymentSchedules', id).find((r) => r.installment_no === 1);
  assert.equal(f.act(id, 'pay', { action: 'PAY', account_id: f.ids.cash.account_id,
    lines: [{ schedule_id: first.schedule_id, amount: first.amount_due }] }).ok, true);
  const balancesBefore = plain(f.ctx.Transactions.accountBalances());
  const amountsBefore = f.rows('Transactions', id).map((t) => [t.transaction_type, t.amount]).sort();

  const plan = f.rows('PaymentPlans', id)[0];
  const res = f.act(id, 'edit', editInput(plan, { owner_id: f.ids.mom.owner_id, category_id: f.ids.home.category_id }));
  assert.equal(res.ok, true, JSON.stringify(res));

  const after = f.rows('PaymentPlans', id)[0];
  assert.equal(after.owner_name, 'แม่');
  assert.equal(after.category_name, 'บ้าน');
  assert.equal(after.account_id, f.ids.card.account_id);
  assert.ok(f.rows('PaymentSchedules', id).every((r) => r.owner_name === 'แม่' && r.category_name === 'บ้าน'));
  const tx = f.rows('Transactions', id);
  assert.ok(tx.length >= 3);
  assert.ok(tx.every((t) => t.owner_id === f.ids.mom.owner_id && t.owner_name === 'แม่'));
  assert.ok(tx.filter((t) => t.transaction_type !== 'CREDIT_PAYMENT').every((t) => t.category_name === 'บ้าน'));
  assert.ok(tx.filter((t) => t.transaction_type === 'CREDIT_PAYMENT').every((t) => t.category_id === ''));
  // รายงานรายจ่ายตามหมวดย้ายไปหมวดใหม่ทั้งหมด
  const report = plain(f.ctx.api_dashboard({ month: Number(f.today.slice(0, 7).replace('-', '')) }).data.categories);
  assert.ok(!report.some((c) => c.name === 'อาหาร'), JSON.stringify(report));
  assert.deepEqual(tx.map((t) => [t.transaction_type, t.amount]).sort(), amountsBefore);
  assert.deepEqual(plain(f.ctx.Transactions.accountBalances()), balancesBefore);
});

test('เปลี่ยนบัญชีได้เมื่อแผนยังไม่มีประวัติการเงิน และถูกปฏิเสธเมื่อมีรายการซื้อหรือกันเงินแล้ว', () => {
  const f = fixture();
  const fresh = f.plan('fresh', { item_name: 'ค่าเทอม', plan_type: 'ONE_TIME', account_id: f.ids.cash.account_id,
    principal_amount: 1000, installment_count: 1 });
  const freshPlan = f.rows('PaymentPlans', fresh)[0];
  const moved = f.act(fresh, 'move', editInput(freshPlan, { account_id: f.ids.bank.account_id }));
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(f.rows('PaymentPlans', fresh)[0].account_name, 'ธนาคาร');
  assert.ok(f.rows('PaymentSchedules', fresh).every((r) => r.account_name === 'ธนาคาร'));

  const card = f.plan('linked', { item_name: 'ทีวี', account_id: f.ids.card.account_id, principal_amount: 600, installment_count: 2, purchase_link: 'NEW' });
  const blocked = f.act(card, 'move-card', editInput(f.rows('PaymentPlans', card)[0], { account_id: f.ids.bank.account_id }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /เปลี่ยนบัญชีไม่ได้/);

  const reserved = f.plan('reserved', { item_name: 'ค่าน้ำ', plan_type: 'ONE_TIME', account_id: f.ids.cash.account_id, principal_amount: 300, installment_count: 1 });
  const row = f.rows('PaymentSchedules', reserved)[0];
  assert.equal(f.act(reserved, 'reserve', { action: 'RESERVE', account_id: f.ids.cash.account_id, schedule_id: row.schedule_id, amount: 100 }).ok, true);
  const again = f.act(reserved, 'move-reserved', editInput(f.rows('PaymentPlans', reserved)[0], { account_id: f.ids.bank.account_id }));
  assert.equal(again.ok, false);
});

test('เลือกหมวดหมู่รายรับหรือเจ้าของที่ปิดใช้งานแล้วถูกปฏิเสธ', () => {
  const f = fixture();
  const id = f.plan('rules', { item_name: 'ของใช้', plan_type: 'ONE_TIME', account_id: f.ids.cash.account_id, principal_amount: 200, installment_count: 1 });
  const plan = f.rows('PaymentPlans', id)[0];
  const salary = f.ctx.MasterData.create('category', { category_name: 'เงินเดือน', category_type: 'INCOME' },
    { actor: { actorId: 'owner@example.com' }, idempotencyKey: 'plan-edit-salary' });
  assert.equal(f.act(id, 'income-cat', editInput(plan, { category_id: salary.category_id })).ok, false);
  assert.equal(f.ctx.api_setMasterActive('owner', f.ids.mom.owner_id, false, 'plan-edit-off-mom').ok, true);
  assert.equal(f.act(id, 'inactive-owner', editInput(plan, { owner_id: f.ids.mom.owner_id })).ok, false);
  assert.equal(f.rows('PaymentPlans', id)[0].owner_name, 'พ่อ');
});

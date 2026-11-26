'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');
const plain = (v) => JSON.parse(JSON.stringify(v));

function fixture() {
  const ctx = createDbContext();
  const create = (type, input, suffix) => ctx.MasterData.create(type, input,
    { actor: { actorId: 'owner@example.com' }, idempotencyKey: 'overview-seed-' + suffix });
  const ids = {
    dad: create('owner', { owner_name: 'พ่อ' }, 'dad'),
    mom: create('owner', { owner_name: 'แม่' }, 'mom'),
    bank: create('account', { account_name: 'ธนาคาร', account_type: 'BANK', opening_balance: 10000 }, 'bank'),
    card: create('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD' }, 'card'),
    food: create('category', { category_name: 'อาหาร', category_type: 'EXPENSE' }, 'food'),
    salary: create('category', { category_name: 'เงินเดือน', category_type: 'INCOME' }, 'salary')
  };
  let n = 0;
  const tx = (date, type, amount, owner = ids.dad) => {
    const input = type === 'INCOME'
      ? { transaction_type: 'INCOME', to_account_id: ids.bank.account_id, category_id: ids.salary.category_id }
      : type === 'CREDIT_PURCHASE'
        ? { transaction_type: 'CREDIT_PURCHASE', from_account_id: ids.card.account_id, category_id: ids.food.category_id }
        : { transaction_type: 'EXPENSE', from_account_id: ids.bank.account_id, category_id: ids.food.category_id };
    const res = ctx.api_createTransaction({ ...input, transaction_date: date, owner_id: owner.owner_id, item_name: 'รายการ ' + (++n), amount }, 'overview-tx-' + n);
    assert.equal(res.ok, true, JSON.stringify(res));
  };
  tx('2025-12-20', 'INCOME', 1000);
  tx('2025-12-21', 'EXPENSE', 400);
  tx('2026-01-05', 'INCOME', 2000);
  tx('2026-01-06', 'EXPENSE', 500);
  tx('2026-01-07', 'CREDIT_PURCHASE', 300, ids.mom);
  tx('2026-03-01', 'EXPENSE', 100);
  return { ctx, ids };
}

const view = (ctx, filters) => plain(ctx.api_dashboard(filters).data.overview);

test('รายเดือน: เทียบเดือนก่อนข้ามปี และแนวโน้ม 6 เดือนถึงเดือนที่เลือก', () => {
  const { ctx } = fixture();
  const ov = view(ctx, { month: 202601 });
  assert.equal(ov.mode, 'MONTH');
  assert.deepEqual(ov.current, { income: 2000, expense: 800, net: 1200 });
  assert.deepEqual(ov.previous, { income: 1000, expense: 400, net: 600 });
  assert.deepEqual(ov.trend.map((r) => r.month), [202508, 202509, 202510, 202511, 202512, 202601]);
  assert.deepEqual(ov.trend.slice(-2).map((r) => [r.income, r.expense, r.net]), [[1000, 400, 600], [2000, 800, 1200]]);
});

test('รายปี: 12 เดือนครบรวมเดือนที่ไม่มีรายการ และเทียบปีก่อน', () => {
  const { ctx } = fixture();
  const ov = view(ctx, { year: 2026 });
  assert.equal(ov.mode, 'YEAR');
  assert.equal(ov.trend.length, 12);
  assert.equal(ov.trend[1].income, 0);
  assert.deepEqual(ov.current, { income: 2000, expense: 900, net: 1100 });
  assert.deepEqual(ov.previous, { income: 1000, expense: 400, net: 600 });
  assert.equal(ov.plan.length, 12);
});

test('ตัวกรองเจ้าของใช้กับภาพรวมด้วย และไม่ระบุช่วงไม่มีการเทียบ', () => {
  const { ctx, ids } = fixture();
  const mom = view(ctx, { year: 2026, owner_id: ids.mom.owner_id });
  assert.deepEqual(mom.current, { income: 0, expense: 300, net: -300 });
  const all = view(ctx, {});
  assert.equal(all.mode, 'ALL');
  assert.equal(all.previous, null);
  assert.equal(all.trend.length, 0);
});

test('แผนรายเดือน: ตามแผนตามเดือนชำระ จ่ายแล้ว คงค้าง และยังต้องเก็บตามเดือนเก็บ', () => {
  const { ctx, ids } = fixture();
  const res = ctx.api_createPaymentPlan({ purchase_date: '2026-01-10', plan_type: 'INSTALLMENT', item_name: 'ผ่อน', account_id: ids.card.account_id,
    owner_id: ids.dad.owner_id, category_id: ids.food.category_id, principal_amount: 300, installment_count: 3,
    first_saving_month: 202601, first_payment_month: 202602, purchase_link: 'NEW' }, 'overview-plan');
  assert.equal(res.ok, true, JSON.stringify(res));
  const ov = view(ctx, { year: 2026 });
  const byMonth = Object.fromEntries(ov.plan.map((r) => [r.month, r]));
  assert.equal(byMonth[202601].scheduled, 0);
  assert.equal(byMonth[202601].toSave, 100);
  assert.deepEqual([byMonth[202602].scheduled, byMonth[202602].paid, byMonth[202602].outstanding], [100, 0, 100]);
  assert.equal(ov.plan.reduce((s, r) => s + r.scheduled, 0), 300);
});

test('แผนแยกเจ้าของ: ยอดตามแผนต่อคนต่อเดือนชำระ ผลรวมเท่ายอดแผนรวม และตามตัวกรองเจ้าของ', () => {
  const { ctx, ids } = fixture();
  const plan = (key, owner, principal, count) => {
    const res = ctx.api_createPaymentPlan({ purchase_date: '2026-01-10', plan_type: 'INSTALLMENT', item_name: key, account_id: ids.bank.account_id,
      owner_id: owner.owner_id, category_id: ids.food.category_id, principal_amount: principal, installment_count: count,
      first_saving_month: 202602, first_payment_month: 202602 }, 'overview-owner-' + key);
    assert.equal(res.ok, true, JSON.stringify(res));
  };
  plan('dadplan', ids.dad, 600, 3);
  plan('momplan', ids.mom, 200, 2);
  const ov = view(ctx, { year: 2026 });
  const byName = Object.fromEntries(ov.planByOwner.map((o) => [o.name, o]));
  assert.deepEqual(Object.keys(byName), ['พ่อ', 'แม่']);
  assert.equal(byName['พ่อ'].total, 600);
  assert.deepEqual(byName['พ่อ'].scheduled.slice(1, 4), [200, 200, 200]);
  assert.deepEqual(byName['แม่'].scheduled.slice(1, 3), [100, 100]);
  ov.plan.forEach((m, i) => assert.equal(ov.planByOwner.reduce((s, o) => s + o.scheduled[i], 0), m.scheduled));
  const mom = view(ctx, { year: 2026, owner_id: ids.mom.owner_id });
  assert.deepEqual(mom.planByOwner.map((o) => o.name), ['แม่']);
});

'use strict';
// งบทริป ระยะ E3: กันเงินจริง (BudgetReservations) — docs/event-budget-plan.md ข้อ 10
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `e3-test-${String(++seq).padStart(6, '0')}`;

function setup() {
  const ctx = createDbContext();
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const ids = {
    dad: mk('owner', { owner_name: 'พ่อ' }),
    bank: mk('account', { account_name: 'KBank', account_type: 'BANK', opening_balance: 50000 }),
    cash: mk('account', { account_name: 'เงินสด', account_type: 'CASH', opening_balance: 10000 }),
    card: mk('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD' }),
    food: mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' })
  };
  const today = ctx.Util.todayIso();
  const saved = plain(ctx.api_saveEventBudget({ budget_name: 'เที่ยวญี่ปุ่น', amount: 20000, start_date: today, end_date: today }, key(), 202612));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const budgetId = saved.data.result.budget_id;
  const reserve = (input, k = key()) => plain(ctx.api_budgetReservation({ budget_id: budgetId, action: 'RESERVE', account_id: ids.bank.account_id, amount: 1000, ...input }, k, 202612));
  let n = 0;
  const spend = (input) => {
    const res = plain(ctx.api_createTransaction({ transaction_date: today, transaction_type: 'EXPENSE', from_account_id: ids.bank.account_id, owner_id: ids.dad.owner_id,
      category_id: ids.food.category_id, item_name: 'จ่าย ' + (++n), amount: 100, allow_duplicate: true, budget_id: budgetId, ...input }, key()));
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.data;
  };
  const avail = (accountId) => plain(ctx.Transactions.accountSummary()).find((a) => a.account_id === accountId);
  const event = () => plain(ctx.Budgets.listEvents({ includeInactive: true }))[0];
  const totals = () => plain(ctx.api_dashboard({}).data.accountTotals);
  return { ctx, ids, budgetId, reserve, spend, avail, event, totals, today };
}

test('กันเงินแล้ว "ใช้ได้จริง" ของบัญชีลดลงทุกจุด (แถบยอด, Dashboard, API balances) ยอดบัญชีไม่เปลี่ยน', () => {
  const s = setup();
  const res = s.reserve({ amount: 20000 });
  assert.equal(res.ok, true, JSON.stringify(res));
  const bank = s.avail(s.ids.bank.account_id);
  assert.deepEqual([bank.balance, bank.reserved, bank.available], [50000, 20000, 30000]);
  assert.deepEqual(s.totals(), { assets: 60000, reserved: 20000, available: 40000, liabilities: 0 });
  const api = plain(s.ctx.ApiReads.balances());
  assert.deepEqual(api.totals, s.totals());
  const ev = s.event();
  assert.deepEqual([ev.reserved, ev.reserved_net, ev.to_reserve], [20000, 20000, 0]);
  assert.deepEqual(ev.reserved_accounts, [{ account_id: s.ids.bank.account_id, name: 'KBank', net: 20000, effective: 20000 }]);
  const row = plain(s.ctx.Database.readAll('BudgetReservations').rows)[0];
  assert.deepEqual([row.budget_id, row.action_type, row.amount], [s.budgetId, 'RESERVE', 20000]);
  assert.equal(plain(s.ctx.Database.readAll('Transactions').rows).length, 0, 'การกันเงินไม่ใช่ธุรกรรม');
});

test('ใช้จ่ายในงบ: เงินกันลดลงอัตโนมัติ ใช้ได้จริงไม่ถูกหักซ้ำ; รูดบัตรลดเงินกันด้วย; กลับรายการคืนเงินกัน', () => {
  const s = setup();
  s.reserve({ amount: 20000 });
  const t = s.spend({ amount: 1500 });
  let bank = s.avail(s.ids.bank.account_id);
  assert.deepEqual([bank.balance, bank.reserved, bank.available], [48500, 18500, 30000], 'จ่ายจากบัญชีที่กันไว้: ใช้ได้เท่าเดิม');
  s.spend({ amount: 1000, transaction_type: 'CREDIT_PURCHASE', from_account_id: s.ids.card.account_id });
  bank = s.avail(s.ids.bank.account_id);
  assert.deepEqual([bank.balance, bank.reserved, bank.available], [48500, 17500, 31000]);
  assert.equal(s.event().reserved, 17500);
  assert.equal(s.event().reserved_net, 20000);
  assert.equal(plain(s.ctx.api_reverseTransaction(t.transaction_id, { reason: 'ยกเลิก', transaction_date: s.today }, key())).ok, true);
  bank = s.avail(s.ids.bank.account_id);
  assert.deepEqual([bank.balance, bank.reserved, bank.available], [50000, 19000, 31000]);
  s.spend({ amount: 25000 });
  assert.equal(s.event().reserved, 0, 'ใช้เกินงบ เงินกันเป็น 0 ไม่ติดลบ');
});

test('กันจากสองบัญชี: เงินกันที่มีผลแบ่งตามสัดส่วน ปัดสตางค์ รวมเท่ายอดที่มีผล', () => {
  const s = setup();
  s.reserve({ amount: 15000 });
  s.reserve({ amount: 5000, account_id: s.ids.cash.account_id });
  s.spend({ amount: 1000.01, from_account_id: s.ids.cash.account_id });
  const ev = s.event();
  assert.equal(ev.reserved, 18999.99);
  const parts = Object.fromEntries(ev.reserved_accounts.map((a) => [a.name, a.effective]));
  assert.equal(Math.round((parts.KBank + parts['เงินสด']) * 100), 1899999);
  assert.equal(parts.KBank, 14249.99);
});

test('ตรวจยอด: กันเกินที่ต้องกัน/เกินเงินที่ใช้ได้, ปลดเกินที่กัน, บัญชีบัตร, งบปิด → ปฏิเสธ; ปลดบางส่วนได้', () => {
  const s = setup();
  assert.equal(s.reserve({ amount: 20000.01 }).code, 'VALIDATION_BUDGET');
  assert.equal(s.reserve({ amount: 10000.01, account_id: s.ids.cash.account_id }).code, 'VALIDATION_BUDGET', 'เงินสดมีแค่ 10,000');
  assert.equal(s.reserve({ account_id: s.ids.card.account_id }).code, 'VALIDATION_BUDGET');
  assert.equal(s.reserve({ amount: 12000 }).ok, true);
  assert.equal(s.reserve({ amount: 8000.01 }).code, 'VALIDATION_BUDGET', 'ยังต้องกันอีก 8,000');
  assert.equal(s.reserve({ action: 'RELEASE', amount: 12000.01 }).code, 'VALIDATION_BUDGET');
  assert.equal(s.reserve({ action: 'RELEASE', amount: 2000 }).ok, true);
  assert.equal(s.event().reserved, 10000);
  assert.equal(s.event().to_reserve, 10000);
  assert.equal(s.reserve({ action: 'RELEASE', amount: 1, account_id: s.ids.cash.account_id }).code, 'VALIDATION_BUDGET');
  assert.equal(plain(s.ctx.api_setBudgetActive(s.budgetId, false, key(), 202612)).ok, true);
  assert.equal(s.reserve({ amount: 1 }).code, 'VALIDATION_BUDGET');
});

test('ปิดงบทริป: เงินกันหมดผลทันที (ไม่เขียน RELEASE); เปิดใช้อีกครั้ง: กลับมามีผล', () => {
  const s = setup();
  s.reserve({ amount: 20000 });
  assert.equal(plain(s.ctx.api_setBudgetActive(s.budgetId, false, key(), 202612)).ok, true);
  assert.equal(s.avail(s.ids.bank.account_id).available, 50000);
  assert.equal(s.event().reserved, 0);
  assert.equal(plain(s.ctx.Database.readAll('BudgetReservations').rows).length, 1);
  assert.equal(plain(s.ctx.api_setBudgetActive(s.budgetId, true, key(), 202612)).ok, true);
  assert.equal(s.avail(s.ids.bank.account_id).available, 30000);
});

test('แผนชำระกันเงิน/ชำระด้วยเงินที่กันให้งบทริปไม่ได้', () => {
  const s = setup();
  s.reserve({ amount: 20000 });
  const ym = Number(s.today.slice(0, 7).replace('-', ''));
  const plan = plain(s.ctx.api_createPaymentPlan({ item_name: 'ค่าประกัน', purchase_date: s.today, plan_type: 'ONE_TIME', owner_id: s.ids.dad.owner_id,
    account_id: s.ids.bank.account_id, category_id: s.ids.food.category_id, principal_amount: '45000', installment_count: 1,
    first_saving_month: ym, first_payment_month: ym, due_day: 28 }, key()));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const sch = plain(s.ctx.Database.readAll('PaymentSchedules').rows)[0];
  const over = plain(s.ctx.api_paymentActivity({ action: 'RESERVE', plan_id: plan.data.plan_id, schedule_id: sch.schedule_id, account_id: s.ids.bank.account_id, amount: 30000.01, date: s.today }, key()));
  assert.equal(over.ok, false);
  const ok = plain(s.ctx.api_paymentActivity({ action: 'RESERVE', plan_id: plan.data.plan_id, schedule_id: sch.schedule_id, account_id: s.ids.bank.account_id, amount: 30000, date: s.today }, key()));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(s.avail(s.ids.bank.account_id).available, 0);
  assert.equal(s.reserve({ action: 'RELEASE', amount: 20000 }).ok, true);
  assert.equal(s.reserve({ amount: 1 }).ok, true, 'ปลดแล้วกันใหม่ได้เท่าที่มีเงินใช้ได้');
  assert.equal(s.reserve({ amount: 20000 }).code, 'VALIDATION_BUDGET');
});

test('retry ด้วย key เดิมไม่สร้างแถวซ้ำ; หน้างบคืนเงินที่ใช้ได้ของบัญชี', () => {
  const s = setup();
  const k = key();
  assert.equal(s.reserve({ amount: 5000 }, k).ok, true);
  assert.equal(s.reserve({ amount: 5000 }, k).ok, true);
  assert.equal(plain(s.ctx.Database.readAll('BudgetReservations').rows).length, 1);
  const page = plain(s.ctx.api_budgetPage(202612).data);
  assert.equal(page.accounts.find((a) => a.account_id === s.ids.bank.account_id).available, 45000);
  assert.equal(page.events[0].reserved, 5000);
});

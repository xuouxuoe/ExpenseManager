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
    { actor: { actorId: 'owner@example.com' }, idempotencyKey: 'move-seed-' + suffix });
  const ids = {
    owner: create('owner', { owner_name: 'พ่อ' }, 'owner'),
    scb: create('account', { account_name: 'SCB', account_type: 'BANK', opening_balance: 5000 }, 'scb'),
    kbank: create('account', { account_name: 'KBank', account_type: 'BANK', opening_balance: 100 }, 'kbank'),
    card: create('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD' }, 'card'),
    category: create('category', { category_name: 'ของใช้', category_type: 'EXPENSE' }, 'category')
  };
  const plan = ctx.api_createPaymentPlan({ purchase_date: today, plan_type: 'INSTALLMENT', item_name: 'ทีวี', account_id: ids.card.account_id,
    owner_id: ids.owner.owner_id, category_id: ids.category.category_id, principal_amount: 900, installment_count: 3,
    first_saving_month: month, first_payment_month: month, purchase_link: 'NEW' }, 'move-plan');
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const planId = plan.data.plan_id;
  const rows = () => plain(ctx.Database.readAll('PaymentSchedules').rows).filter((r) => r.plan_id === planId)
    .sort((a, b) => a.installment_no - b.installment_no);
  rows().slice(0, 2).forEach((row, i) => {
    const res = ctx.api_paymentActivity({ action: 'RESERVE', plan_id: planId, date: today, account_id: ids.scb.account_id,
      schedule_id: row.schedule_id, amount: 300 }, 'move-reserve-' + i);
    assert.equal(res.ok, true, JSON.stringify(res));
  });
  const held = () => {
    const out = {};
    plain(ctx.Database.readAll('Reservations').rows).forEach((r) => {
      const sign = r.action_type === 'RESERVE' ? 1 : -1;
      out[r.account_id] = (out[r.account_id] || 0) + sign * r.amount;
    });
    return out;
  };
  const balances = () => plain(ctx.Transactions.accountBalances());
  return { ctx, today, ids, planId, rows, held, balances };
}

test('ย้ายเงินกันไว้พร้อมโอนจริง: โอน 600, ปลดจาก SCB และกันที่ KBank สถานะงวดไม่เปลี่ยน แล้วจ่ายจาก KBank ใช้เงินกันไว้', () => {
  const f = fixture();
  const [first, second] = f.rows();
  const before = f.rows().map((r) => [r.amount_reserved, r.saving_status]);
  const res = f.ctx.api_moveReserve({ from_account_id: f.ids.scb.account_id, to_account_id: f.ids.kbank.account_id, date: f.today, transfer: true,
    items: [{ schedule_id: first.schedule_id, amount: 300 }, { schedule_id: second.schedule_id, amount: 300 }] }, 'move-with-transfer');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.result.total, 600);
  assert.equal(res.data.result.transfer, true);
  assert.ok(Array.isArray(res.data.plans));
  assert.equal(f.held()[f.ids.scb.account_id], 0);
  assert.equal(f.held()[f.ids.kbank.account_id], 600);
  assert.deepEqual(f.rows().map((r) => [r.amount_reserved, r.saving_status]), before);
  assert.equal(f.balances()[f.ids.scb.account_id], 4400);
  assert.equal(f.balances()[f.ids.kbank.account_id], 700);
  const transfer = plain(f.ctx.Database.readAll('Transactions').rows).filter((t) => t.transaction_type === 'TRANSFER');
  assert.equal(transfer.length, 1);
  assert.equal(transfer[0].amount, 600);

  const pay = f.ctx.api_paymentActivity({ action: 'PAY', plan_id: f.planId, date: f.today, account_id: f.ids.kbank.account_id,
    lines: [{ schedule_id: first.schedule_id, amount: 300 }] }, 'move-pay-after');
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const consumed = plain(f.ctx.Database.readAll('Reservations').rows).filter((r) => r.action_type === 'CONSUME');
  assert.deepEqual(consumed.map((r) => [r.account_id, r.amount]), [[f.ids.kbank.account_id, 300]]);
});

test('ย้ายเฉพาะเงินกันไว้ (ไม่โอน) ต้องมีเงินใช้ได้ที่ปลายทางพอ มิฉะนั้นปฏิเสธทั้งชุด', () => {
  const f = fixture();
  const [first, second] = f.rows();
  const items = [{ schedule_id: first.schedule_id, amount: 300 }, { schedule_id: second.schedule_id, amount: 300 }];
  const before = plain(f.ctx.Database.readAll('Reservations').rows).length;
  const rejected = f.ctx.api_moveReserve({ from_account_id: f.ids.scb.account_id, to_account_id: f.ids.kbank.account_id, items }, 'move-no-cash');
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /บัญชีปลายทางไม่พอ/);
  assert.equal(plain(f.ctx.Database.readAll('Reservations').rows).length, before);
  const ok = f.ctx.api_moveReserve({ from_account_id: f.ids.scb.account_id, to_account_id: f.ids.kbank.account_id,
    items: [{ schedule_id: first.schedule_id, amount: 100 }] }, 'move-label-only');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.data.result.transfer, false);
  assert.equal(f.held()[f.ids.kbank.account_id], 100);
  assert.equal(f.held()[f.ids.scb.account_id], 500);
  assert.equal(plain(f.ctx.Database.readAll('Transactions').rows).filter((t) => t.transaction_type === 'TRANSFER').length, 0);
});

test('ตรวจข้อมูล: ยอดเกินที่กันไว้ บัญชีเดียวกัน บัญชีหนี้ งวดซ้ำ และวันอนาคต ถูกปฏิเสธ', () => {
  const f = fixture();
  const [first, , third] = f.rows();
  const base = { from_account_id: f.ids.scb.account_id, to_account_id: f.ids.kbank.account_id, transfer: true };
  const cases = [
    ['เกินที่กันไว้', { items: [{ schedule_id: first.schedule_id, amount: 301 }] }, /เกินเงินที่กันไว้/],
    ['งวดที่ไม่ได้กันไว้', { items: [{ schedule_id: third.schedule_id, amount: 1 }] }, /เกินเงินที่กันไว้/],
    ['บัญชีเดียวกัน', { to_account_id: f.ids.scb.account_id, items: [{ schedule_id: first.schedule_id, amount: 1 }] }, /ต่างกัน/],
    ['บัญชีหนี้', { to_account_id: f.ids.card.account_id, items: [{ schedule_id: first.schedule_id, amount: 1 }] }, /สินทรัพย์/],
    ['งวดซ้ำ', { items: [{ schedule_id: first.schedule_id, amount: 1 }, { schedule_id: first.schedule_id, amount: 1 }] }, /ซ้ำ/],
    ['วันอนาคต', { date: `${Number(f.today.slice(0, 4)) + 1}-01-01`, items: [{ schedule_id: first.schedule_id, amount: 1 }] }, /อนาคต/]
  ];
  cases.forEach(([label, patch, message], i) => {
    const res = f.ctx.api_moveReserve({ ...base, ...patch }, 'move-invalid-' + i);
    assert.equal(res.ok, false, label);
    assert.match(res.message, message, label + ' ' + res.message);
  });
  assert.equal(f.held()[f.ids.scb.account_id], 600);
});

test('ส่งซ้ำ key เดิมไม่ย้ายซ้ำ และกลับรายการโอนภายหลังไม่ทำให้เงินกันไว้นับซ้ำสองบัญชี', () => {
  const f = fixture();
  const [first] = f.rows();
  const input = { from_account_id: f.ids.scb.account_id, to_account_id: f.ids.kbank.account_id, transfer: true, date: f.today,
    items: [{ schedule_id: first.schedule_id, amount: 300 }] };
  assert.equal(f.ctx.api_moveReserve(input, 'move-replay').ok, true);
  const snapshot = plain(f.ctx.Database.readAll('Reservations').rows).length;
  assert.equal(f.ctx.api_moveReserve(input, 'move-replay').ok, true);
  assert.equal(plain(f.ctx.Database.readAll('Reservations').rows).length, snapshot);
  const transfer = plain(f.ctx.Database.readAll('Transactions').rows).find((t) => t.transaction_type === 'TRANSFER');
  const reversed = f.ctx.api_reverseTransaction(transfer.transaction_id, { reason: 'โอนผิด', transaction_date: f.today }, 'move-reverse-transfer');
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  const firstRow = f.rows()[0];
  assert.equal(firstRow.amount_reserved, 300, 'schedule still has exactly one reserve after reversing the transfer');
  assert.equal(f.held()[f.ids.kbank.account_id] + f.held()[f.ids.scb.account_id], 600);
});

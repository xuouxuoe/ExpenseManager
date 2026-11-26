'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `tx-key-${String(++seq).padStart(6, '0')}`;
const ACTOR = { actorId: 'owner@example.com' };

function throwsCode(fn, code) {
  assert.throws(fn, (err) => err.code === code, `expected ${code}`);
}

function setup() {
  const ctx = createDbContext();
  const M = ctx.MasterData;
  const T = ctx.Transactions;
  const req = () => ({ idempotencyKey: key(), actor: ACTOR });
  const owner = M.create('owner', { owner_name: 'พ่อ' }, req());
  const a = {
    cash: M.create('account', { account_name: 'เงินสด', account_type: 'CASH', opening_balance: '1000' }, req()),
    bank: M.create('account', { account_name: 'SCB', account_type: 'BANK', opening_balance: '50000' }, req()),
    card: M.create('account', { account_name: 'KBank Credit', account_type: 'CREDIT_CARD' }, req()),
    loan: M.create('account', { account_name: 'ยืมเงิน คุณสมชาย', account_type: 'LOAN', opening_balance: '0' }, req())
  };
  const c = {
    food: M.create('category', { category_name: 'อาหาร', category_type: 'EXPENSE' }, req()),
    salary: M.create('category', { category_name: 'เงินเดือน', category_type: 'INCOME' }, req()),
    interest: M.create('category', { category_name: 'ดอกเบี้ย', category_type: 'EXPENSE' }, req())
  };
  const base = { transaction_date: '2026-11-25', owner_id: owner.owner_id };
  const tx = (fields) => Object.assign({}, base, fields);
  return { ctx, M, T, req, owner, a, c, tx };
}

function balances(ctx) {
  return plain(ctx.Transactions.accountBalances());
}

test('INCOME / EXPENSE: เติมชื่อจาก Master, amount เป็นบาท 2 ตำแหน่ง, source เริ่มต้น MANUAL', () => {
  const { ctx, T, req, a, c, tx } = setup();
  const inc = T.create(tx({ transaction_type: 'income', to_account_id: a.bank.account_id, category_id: c.salary.category_id, item_name: 'เงินเดือน พ.ย.', amount: '30000' }), req());
  assert.equal(inc.transaction_type, 'INCOME');
  assert.equal(inc.to_account_name, 'SCB');
  assert.equal(inc.from_account_name, '');
  assert.equal(inc.category_name, 'เงินเดือน');
  assert.equal(inc.owner_name, 'พ่อ');
  assert.equal(inc.amount, 30000);
  assert.equal(inc.source, 'MANUAL');
  const exp = T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'ข้าวมันไก่', amount: '50.5', source: 'QUICK_ENTRY' }), req());
  assert.equal(exp.amount, 50.5);
  assert.equal(exp.source, 'QUICK_ENTRY');
  const bal = balances(ctx);
  assert.equal(bal[a.bank.account_id], 80000);
  assert.equal(bal[a.cash.account_id], 949.5);
});

test('TC-TX-01/02: TRANSFER ไม่ใช่รายรับ/รายจ่าย และบัญชีเดียวกันถูกปฏิเสธ', () => {
  const { ctx, T, req, a, tx } = setup();
  T.create(tx({ transaction_type: 'TRANSFER', from_account_id: a.bank.account_id, to_account_id: a.cash.account_id, item_name: 'ถอนเงิน', amount: 2000 }), req());
  const bal = balances(ctx);
  assert.equal(bal[a.bank.account_id], 48000);
  assert.equal(bal[a.cash.account_id], 3000);
  const s = plain(T.list({ date_from: '2026-11-01', date_to: '2026-11-30' })).summary;
  assert.deepEqual(s, { income: 0, expense: 0, net: 0 });
  throwsCode(() => T.create(tx({ transaction_type: 'TRANSFER', from_account_id: a.cash.account_id, to_account_id: a.cash.account_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_RULE');
  throwsCode(() => T.create(tx({ transaction_type: 'TRANSFER', from_account_id: a.cash.account_id, to_account_id: a.card.account_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_RULE');
});

test('TC-TX-03/04/05: กฎบัญชี/หมวด/ยอดเงิน', () => {
  const { T, req, a, c, tx } = setup();
  throwsCode(() => T.create(tx({ transaction_type: 'INCOME', from_account_id: a.cash.account_id, to_account_id: a.bank.account_id, category_id: c.salary.category_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_RULE');
  throwsCode(() => T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_REQUIRED');
  throwsCode(() => T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.salary.category_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_RULE');
  throwsCode(() => T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.card.account_id, category_id: c.food.category_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_RULE');
  throwsCode(() => T.create(tx({ transaction_type: 'TRANSFER', from_account_id: a.cash.account_id, to_account_id: a.bank.account_id, category_id: c.food.category_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_RULE');
  for (const amount of ['0', '-1', 'abc', '1.234', '']) {
    assert.throws(() => T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'x', amount }), req()),
      (e) => e.code.startsWith('VALIDATION_'), amount);
  }
  throwsCode(() => T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: '', amount: 1 }), req()), 'VALIDATION_REQUIRED');
  throwsCode(() => T.create(tx({ transaction_type: 'EXPENSE', transaction_date: '2569-11-25', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_DATE_RANGE');
  throwsCode(() => T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'x', amount: 1, source: 'AI' }), req()), 'VALIDATION_ENUM');
});

test('TC-TX-06: CREDIT_PURCHASE + CREDIT_PAYMENT รับรู้รายจ่ายครั้งเดียว', () => {
  const { ctx, T, req, a, c, tx } = setup();
  T.create(tx({ transaction_type: 'CREDIT_PURCHASE', from_account_id: a.card.account_id, category_id: c.food.category_id, item_name: 'ซื้อของ', amount: 1500 }), req());
  T.create(tx({ transaction_type: 'CREDIT_PAYMENT', from_account_id: a.bank.account_id, to_account_id: a.card.account_id, item_name: 'จ่ายบัตร', amount: 1500 }), req());
  const s = plain(T.list({})).summary;
  assert.equal(s.expense, 1500);
  assert.equal(s.income, 0);
  const bal = balances(ctx);
  assert.equal(bal[a.card.account_id], 0);
  assert.equal(bal[a.bank.account_id], 48500);
});

test('TC-TX-07: double submit ด้วย key เดิมบันทึกครั้งเดียว', () => {
  const { ctx, T, a, c, tx } = setup();
  const r = { idempotencyKey: 'double-submit-01', actor: ACTOR };
  const input = tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'กาแฟ', amount: 60 });
  const x = T.create(input, r);
  const y = T.create(input, r);
  assert.equal(x.transaction_id, y.transaction_id);
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 1);
});

test('เตือนรายการที่อาจซ้ำ และบันทึกได้เมื่อยืนยัน allow_duplicate', () => {
  const { ctx, T, req, a, c, tx } = setup();
  const input = tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'กาแฟ', amount: 60 });
  T.create(input, req());
  let caught;
  try { T.create(Object.assign({}, input, { item_name: '  กาแฟ ' }), req()); } catch (e) { caught = e; }
  assert.equal(caught.code, 'VALIDATION_POSSIBLE_DUPLICATE');
  assert.equal(plain(caught.details).duplicates.length, 1);
  T.create(Object.assign({}, input, { allow_duplicate: true }), req());
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 2);
  // ยอดต่างกันไม่ถือว่าซ้ำ
  T.create(Object.assign({}, input, { amount: 65 }), req());
});

test('TC-TX-08: รับเงินกู้ CASH_ADVANCE จาก LOAN ไม่ใช่รายรับ', () => {
  const { ctx, T, req, a, tx } = setup();
  T.create(tx({ transaction_type: 'CASH_ADVANCE', from_account_id: a.loan.account_id, to_account_id: a.cash.account_id, item_name: 'ยืมเงินคุณสมชาย', amount: 20000 }), req());
  const bal = balances(ctx);
  assert.equal(bal[a.loan.account_id], 20000);
  assert.equal(bal[a.cash.account_id], 21000);
  assert.equal(plain(T.list({})).summary.income, 0);
});

test('TC-TX-09/11: คืนเงินต้น + ดอกเบี้ย รายจ่ายเฉพาะดอกเบี้ย; ยอดหนี้คงเหลือถูกต้อง', () => {
  const { ctx, T, req, a, c, tx } = setup();
  T.create(tx({ transaction_type: 'CASH_ADVANCE', from_account_id: a.loan.account_id, to_account_id: a.bank.account_id, item_name: 'ยืม', amount: 20000 }), req());
  T.create(tx({ transaction_type: 'CREDIT_PAYMENT', from_account_id: a.cash.account_id, to_account_id: a.loan.account_id, item_name: 'คืนเงินต้น', amount: 5000 }), req());
  T.create(tx({ transaction_type: 'INTEREST', from_account_id: a.cash.account_id, category_id: c.interest.category_id, item_name: 'ดอกเบี้ย', amount: 200 }), req());
  T.create(tx({ transaction_type: 'INTEREST', from_account_id: a.loan.account_id, category_id: c.interest.category_id, item_name: 'ดอกเบี้ยทบต้น', amount: 100 }), req());
  const bal = balances(ctx);
  assert.equal(bal[a.loan.account_id], 15100);
  assert.equal(bal[a.cash.account_id], 1000 - 5200);
  const s = plain(T.list({})).summary;
  assert.equal(s.expense, 300);
  assert.equal(s.income, 0);
});

test('TC-TX-10: CASH_ADVANCE จากบัญชีสินทรัพย์ หรือไปบัญชีหนี้สิน ถูกปฏิเสธ', () => {
  const { T, req, a, tx } = setup();
  throwsCode(() => T.create(tx({ transaction_type: 'CASH_ADVANCE', from_account_id: a.bank.account_id, to_account_id: a.cash.account_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_RULE');
  throwsCode(() => T.create(tx({ transaction_type: 'CASH_ADVANCE', from_account_id: a.loan.account_id, to_account_id: a.card.account_id, item_name: 'x', amount: 1 }), req()), 'VALIDATION_RULE');
});

test('REFUND เข้าบัตรเครดิตลดหนี้และลดรายจ่าย; ADJUSTMENT ต้องมีบัญชีเดียวและเหตุผล', () => {
  const { ctx, T, req, a, c, tx } = setup();
  T.create(tx({ transaction_type: 'CREDIT_PURCHASE', from_account_id: a.card.account_id, category_id: c.food.category_id, item_name: 'ซื้อ', amount: 1000 }), req());
  T.create(tx({ transaction_type: 'REFUND', to_account_id: a.card.account_id, category_id: c.food.category_id, item_name: 'คืนสินค้า', amount: 400 }), req());
  assert.equal(balances(ctx)[a.card.account_id], 600);
  assert.equal(plain(T.list({})).summary.expense, 600);
  throwsCode(() => T.create(tx({ transaction_type: 'ADJUSTMENT', to_account_id: a.cash.account_id, item_name: 'ปรับยอด', amount: 10 }), req()), 'VALIDATION_REQUIRED');
  throwsCode(() => T.create(tx({ transaction_type: 'ADJUSTMENT', item_name: 'ปรับยอด', amount: 10, note: 'นับเงินจริง' }), req()), 'VALIDATION_RULE');
  throwsCode(() => T.create(tx({ transaction_type: 'ADJUSTMENT', from_account_id: a.bank.account_id, to_account_id: a.cash.account_id, item_name: 'ปรับยอด', amount: 10, note: 'x' }), req()), 'VALIDATION_RULE');
  T.create(tx({ transaction_type: 'ADJUSTMENT', to_account_id: a.cash.account_id, item_name: 'ปรับยอด', amount: 10, note: 'นับเงินจริงเกิน' }), req());
  assert.equal(balances(ctx)[a.cash.account_id], 1010);
  const s = plain(T.list({})).summary;
  assert.equal(s.income, 0);
});

test('แก้ไขรายการ: ค่าใหม่ + ชื่อ refresh, recovery_data เก็บค่าเดิม, Master ที่ปิดภายหลังคงไว้ได้', () => {
  const { ctx, M, T, req, a, c, tx } = setup();
  const t1 = T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'ข้าว', amount: 50 }), req());
  M.setActive('category', c.food.category_id, false, req());
  const edited = T.update(t1.transaction_id, tx({ transaction_type: 'EXPENSE', from_account_id: a.bank.account_id, category_id: c.food.category_id, item_name: 'ข้าวเย็น', amount: 80 }), req());
  assert.equal(edited.transaction_id, t1.transaction_id);
  assert.equal(edited.from_account_name, 'SCB');
  assert.equal(edited.amount, 80);
  assert.equal(edited.created_at, t1.created_at);
  const journal = ctx.Database.readAll('OperationJournal').rows.find((j) => j.operation_type === 'UPDATE_TRANSACTION');
  assert.equal(JSON.parse(journal.recovery_data).before.amount, 50);
  // หมวดที่ปิดแล้วใช้กับรายการใหม่ไม่ได้
  throwsCode(() => T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'ใหม่', amount: 1 }), req()), 'VALIDATION_FK_INACTIVE');
});

test('กลับรายการแทนการลบ: ผลตรงข้าม, ประวัติคงอยู่, แก้ไข/กลับซ้ำไม่ได้', () => {
  const { ctx, T, req, a, c, tx } = setup();
  const t1 = T.create(tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'ข้าว', amount: 100 }), req());
  throwsCode(() => T.reverse(t1.transaction_id, { reason: '' }, req()), 'VALIDATION_REQUIRED');
  throwsCode(() => T.reverse(t1.transaction_id, { reason: 'x', transaction_date: '2026-11-01' }, req()), 'VALIDATION_RULE');
  const rev = T.reverse(t1.transaction_id, { reason: 'บันทึกผิด', transaction_date: '2026-11-26' }, req());
  assert.equal(rev.reversal_of, t1.transaction_id);
  assert.equal(rev.note, 'บันทึกผิด');
  assert.match(rev.item_name, /^กลับรายการ: ข้าว/);
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 2);
  assert.equal(balances(ctx)[a.cash.account_id], 1000);
  const listed = plain(T.list({}));
  assert.deepEqual(listed.summary, { income: 0, expense: 0, net: 0 });
  assert.equal(listed.rows.find((r) => r.transaction_id === t1.transaction_id).is_reversed, true);
  throwsCode(() => T.reverse(t1.transaction_id, { reason: 'x' }, req()), 'VALIDATION_RULE');
  throwsCode(() => T.reverse(rev.transaction_id, { reason: 'x' }, req()), 'VALIDATION_RULE');
  throwsCode(() => T.update(t1.transaction_id, tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'ข้าว', amount: 1 }), req()), 'VALIDATION_RULE');
  assert.equal(typeof T.delete, 'undefined');
});

test('list: กรอง วันที่/ประเภท/บัญชี/ค้นหา และแบ่งหน้าเรียงวันที่ล่าสุดก่อน', () => {
  const { T, req, a, c, tx } = setup();
  for (let d = 1; d <= 12; d++) {
    T.create(tx({ transaction_date: `2026-11-${String(d).padStart(2, '0')}`, transaction_type: 'EXPENSE', from_account_id: d % 2 ? a.cash.account_id : a.bank.account_id,
      category_id: c.food.category_id, item_name: d === 7 ? 'ก๋วยเตี๋ยวเรือ' : `อาหาร ${d}`, amount: d }), req());
  }
  T.create(tx({ transaction_date: '2026-10-31', transaction_type: 'INCOME', to_account_id: a.bank.account_id, category_id: c.salary.category_id, item_name: 'เงินเดือน', amount: 30000 }), req());
  const p1 = plain(T.list({ date_from: '2026-11-01', date_to: '2026-11-30', page_size: 5 }));
  assert.equal(p1.total, 12);
  assert.equal(p1.rows.length, 5);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.rows[0].transaction_date, '2026-11-12');
  assert.equal(p1.summary.expense, 78);
  const p3 = plain(T.list({ date_from: '2026-11-01', date_to: '2026-11-30', page_size: 5, page: 3 }));
  assert.equal(p3.rows.length, 2);
  assert.equal(p3.hasMore, false);
  assert.equal(plain(T.list({ account_id: a.cash.account_id, transaction_type: 'EXPENSE' })).total, 6);
  assert.equal(plain(T.list({ q: 'เรือ' })).total, 1);
  assert.equal(plain(T.list({ q: 'SCB' })).total, 7);
  assert.equal(plain(T.list({ transaction_type: 'INCOME' })).summary.income, 30000);
  throwsCode(() => T.list({ page_size: 1000 }), 'VALIDATION_RANGE');
});

test('API ธุรกรรม: ผู้ไม่มีสิทธิ์ถูกปฏิเสธ; ผู้มีสิทธิ์ได้ ok:true', () => {
  const { ctx, a, c, tx } = setup();
  const input = tx({ transaction_type: 'EXPENSE', from_account_id: a.cash.account_id, category_id: c.food.category_id, item_name: 'ขนม', amount: 20 });
  const ok = plain(ctx.api_createTransaction(input, key()));
  assert.equal(ok.ok, true);
  const listed = plain(ctx.api_listTransactions({}));
  assert.equal(listed.data.total, 1);
  ctx.__state.activeEmail = 'stranger@example.com';
  const denied = plain(ctx.api_createTransaction(input, key()));
  assert.equal(denied.code, 'FORBIDDEN');
  assert.equal(plain(ctx.api_listTransactions({})).code, 'FORBIDDEN');
});

test('ตัวช่วยกรอก: recent เรียงล่าสุด, frequent = ≥2 เดือนหรือ ≥3 ครั้ง, ตัดรายการกลับ/Master ปิด/นอกช่วงเวลา', () => {
  const { M, T, req, a, c, tx } = setup();
  const exp = (date, item, amount, from) => T.create(tx({ transaction_date: date, transaction_type: 'EXPENSE', from_account_id: from || a.cash.account_id,
    category_id: c.food.category_id, item_name: item, amount }), req());
  exp('2026-09-25', 'ค่าอินเทอร์เน็ต', 599, a.bank.account_id);
  exp('2026-10-25', 'ค่าอินเทอร์เน็ต', 599, a.bank.account_id);
  exp('2026-11-25', 'ค่าอินเทอร์เน็ต', 649, a.bank.account_id);
  exp('2026-11-20', 'กาแฟ', 60);
  exp('2026-11-21', 'กาแฟ', 65);
  exp('2026-11-22', 'กาแฟ', 70);
  exp('2026-11-23', 'ข้าวผัด', 50);
  exp('2025-01-01', 'ของเก่ามาก', 10);
  const wrong = exp('2026-11-24', 'บันทึกผิด', 999);
  T.reverse(wrong.transaction_id, { reason: 'ผิด', transaction_date: '2026-11-24' }, req());
  T.create(tx({ transaction_date: '2026-11-24', transaction_type: 'INCOME', to_account_id: a.bank.account_id, category_id: c.salary.category_id, item_name: 'เงินเดือน', amount: 30000 }), req());
  const s = plain(T.suggestions({ today: '2026-11-25' }));
  const names = (list) => list.map((x) => x.item_name);
  assert.deepEqual(names(s.recent), ['ค่าอินเทอร์เน็ต', 'เงินเดือน', 'ข้าวผัด', 'กาแฟ']);
  assert.deepEqual(names(s.frequent), ['ค่าอินเทอร์เน็ต', 'กาแฟ']);
  const net = s.frequent[0];
  assert.equal(net.amount, 649, 'ใช้ยอดล่าสุด');
  assert.equal(net.count, 3);
  assert.equal(net.month_count, 3);
  assert.equal(net.from_account_name, 'SCB');
  assert.equal(net.category_name, 'อาหาร');
  assert.equal(net.owner_name, 'พ่อ');
  assert.equal(net.transaction_type, 'EXPENSE');
  assert.equal(s.recent.find((x) => x.item_name === 'เงินเดือน').to_account_id, a.bank.account_id);
  // บัญชีปิดใช้งาน → ตัดออก
  M.setActive('account', a.bank.account_id, false, req());
  const after = plain(T.suggestions({ today: '2026-11-25' }));
  assert.deepEqual(names(after.frequent), ['กาแฟ']);
  assert.ok(!names(after.recent).includes('เงินเดือน'));
  assert.equal(plain(T.suggestions({ today: '2026-11-25', limit: 1 })).recent.length, 1);
  throwsCode(() => T.suggestions({ limit: 50 }), 'VALIDATION_RANGE');
});

test('API ตัวช่วยกรอก ตรวจสิทธิ์', () => {
  const { ctx } = setup();
  assert.equal(plain(ctx.api_transactionSuggestions({})).ok, true);
  ctx.__state.activeEmail = 'stranger@example.com';
  assert.equal(plain(ctx.api_transactionSuggestions({})).code, 'FORBIDDEN');
});

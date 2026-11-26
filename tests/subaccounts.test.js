'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');
const plain = (x) => JSON.parse(JSON.stringify(x));

function fixture() {
  const ctx = createDbContext();
  let sequence = 0;
  const req = () => ({ actor: { actorId: 'owner@example.com' }, idempotencyKey: 'sub-account-test-' + (++sequence) });
  const key = () => req().idempotencyKey;
  const master = (type, input) => ctx.MasterData.create(type, input, req());
  const owner = master('owner', { owner_name: 'เจ้าของ' });
  const category = master('category', { category_name: 'ค่าใช้จ่าย', category_type: 'EXPENSE' });
  const bank = master('account', { account_name: 'PRIVATE BANK *1234', account_type: 'BANK', opening_balance: 1000 });
  const a = master('subaccount', { account_id: bank.account_id, sub_account_name: 'บัญชี A' });
  const b = master('subaccount', { account_id: bank.account_id, sub_account_name: 'บัญชี B' });
  const tx = (input, requestKey = key()) => {
    const result = ctx.api_createTransaction({ transaction_date: ctx.Util.todayIso(), item_name: 'ทดสอบ', owner_id: owner.owner_id,
      category_id: '', ...input }, requestKey);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const report = () => plain(ctx.api_dashboard({ account_view: 'SUB' }).data);
  return { ctx, req, key, master, tx, report, bank, a, b, owner, category };
}

test('โอนจัดกลุ่มภายในบัญชีเดียวกัน ยอดบัญชีย่อยและยังไม่ระบุรวมตรงบัญชีหลัก และส่งรายงานเฉพาะชื่อย่อย', () => {
  const { ctx, tx, bank, a, b, category, report, key } = fixture();
  tx({ transaction_type: 'TRANSFER', from_account_id: bank.account_id, to_account_id: bank.account_id, to_sub_account_id: a.sub_account_id, amount: 300 });
  tx({ transaction_type: 'TRANSFER', from_account_id: bank.account_id, to_account_id: bank.account_id, to_sub_account_id: b.sub_account_id, amount: 500 });
  const expense = tx({ transaction_type: 'EXPENSE', from_account_id: bank.account_id, from_sub_account_id: a.sub_account_id,
    category_id: category.category_id, amount: 20 });
  assert.equal(ctx.Transactions.accountBalances()[bank.account_id], 980);
  const data = report();
  assert.equal(data.summary.expense, 20);
  assert.equal(data.summary.income, 0);
  assert.deepEqual(data.accounts.map((r) => r.balance), [200, 280, 500]);
  assert.equal(data.accounts.reduce((sum, r) => sum + r.balance, 0), 980);
  const share = plain(ctx.api_sharedAccountReport({}).data);
  assert.deepEqual(share.accounts, [
    { name: 'บัญชี A', balance: 280, income: 0, expense: 20, isAsset: true },
    { name: 'บัญชี B', balance: 500, income: 0, expense: 0, isAsset: true }
  ]);
  assert.ok(!JSON.stringify(share).includes('PRIVATE'));
  assert.ok(!JSON.stringify(share).includes(bank.account_id));
  assert.equal(ctx.api_sharedAccountReport({ sub_account_id: a.sub_account_id }).data.accounts.length, 1);
  assert.equal(ctx.api_reverseTransaction(expense.transaction_id, { reason: 'คืนยอด' }, key()).ok, true);
  assert.equal(report().accounts.find((r) => r.sub_account_id === a.sub_account_id).balance, 300);
});

test('ตรวจ parent ของบัญชีย่อย ปิดใช้ เปลี่ยนชื่อ และการจัดกลุ่มรายการเก่า', () => {
  const { ctx, tx, bank, a, category, master, req, key, owner } = fixture();
  const other = master('account', { account_name: 'OTHER', account_type: 'CASH' });
  const invalid = ctx.api_createTransaction({ transaction_type: 'EXPENSE', transaction_date: ctx.Util.todayIso(), owner_id: owner.owner_id,
    category_id: category.category_id, from_account_id: other.account_id, from_sub_account_id: a.sub_account_id, item_name: 'ผิดบัญชี', amount: 10 }, key());
  assert.equal(invalid.code, 'VALIDATION_SUB_ACCOUNT');
  const old = tx({ transaction_type: 'EXPENSE', from_account_id: bank.account_id, category_id: category.category_id, amount: 10 });
  const updated = ctx.api_updateTransaction(old.transaction_id, { ...old, from_sub_account_id: a.sub_account_id }, key());
  assert.equal(updated.data.from_sub_account_name, 'บัญชี A');
  ctx.MasterData.update('subaccount', a.sub_account_id, { account_id: bank.account_id, sub_account_name: 'ชื่อใหม่' }, req());
  assert.equal(ctx.Database.readAll('Transactions').rows[0].from_sub_account_name, 'ชื่อใหม่');
  ctx.MasterData.setActive('subaccount', a.sub_account_id, false, req());
  assert.equal(ctx.api_updateTransaction(old.transaction_id, { ...old, from_sub_account_id: a.sub_account_id }, key()).ok, true);
  assert.throws(() => master('subaccount', { account_id: bank.account_id, sub_account_name: 'บัตร 4111 1111 1111 1111' }));
  assert.throws(() => ctx.MasterData.update('subaccount', a.sub_account_id, { account_id: other.account_id, sub_account_name: 'ย้าย' }, req()));
});

test('แผนบัตรส่งบัญชีย่อยไปงวด การซื้อ การจ่าย ดอกเบี้ย กลับรายการ และเปลี่ยนกลุ่มย้อนหลัง', () => {
  const { ctx, bank, a, master, req, key, owner, category, report } = fixture();
  const card = master('account', { account_name: 'PRIVATE CARD', account_type: 'CREDIT_CARD' });
  const cardSub = master('subaccount', { account_id: card.account_id, sub_account_name: 'บัตร A' });
  const nextSub = master('subaccount', { account_id: card.account_id, sub_account_name: 'บัตร B' });
  const planId = ctx.api_createPaymentPlan({ account_id: card.account_id, sub_account_id: cardSub.sub_account_id,
    plan_type: 'INSTALLMENT', purchase_date: ctx.Util.todayIso(), item_name: 'เครื่องใช้', owner_id: owner.owner_id, category_id: category.category_id,
    principal_amount: 600, interest_amount: 20, fee_amount: 10, fee_timing: 'FIRST', installment_count: 2,
    first_saving_month: 202611, first_payment_month: 202612, purchase_link: 'NEW' }, key()).data.plan_id;
  const record = () => ctx.api_paymentPlannerPage().data.plans.find((r) => r.plan.plan_id === planId);
  assert.ok(record().schedules.every((s) => s.sub_account_id === cardSub.sub_account_id));
  const activity = (input, requestKey = key()) => ctx.api_paymentActivity({ date: ctx.Util.todayIso(), plan_id: planId, ...input }, requestKey);
  const payment = activity({ action: 'PAY', account_id: bank.account_id, payment_sub_account_id: a.sub_account_id,
    lines: [{ schedule_id: record().schedules[0].schedule_id, amount: 320 }] });
  assert.equal(payment.ok, true, JSON.stringify(payment));
  const current = ctx.Database.readAll('Transactions').rows;
  assert.ok(current.filter((t) => t.from_account_id === card.account_id).every((t) => t.from_sub_account_id === cardSub.sub_account_id));
  const paid = current.find((t) => t.transaction_type === 'CREDIT_PAYMENT');
  assert.equal(paid.to_sub_account_id, cardSub.sub_account_id);
  assert.equal(paid.from_sub_account_id, a.sub_account_id);
  assert.equal(activity({ action: 'EDIT_PLAN', sub_account_id: nextSub.sub_account_id, item_name: 'เครื่องใช้', description: '', note: '' }).ok, true);
  assert.ok(record().schedules.every((s) => s.sub_account_id === nextSub.sub_account_id));
  assert.equal(report().accounts.find((r) => r.sub_account_id === cardSub.sub_account_id).balance, 0);
  assert.equal(activity({ action: 'REVERSE_PAY', transaction_id: paid.transaction_id, note: 'ทดสอบกลับรายการ' }).ok, true);
  assert.equal(report().accounts.find((r) => r.sub_account_id === nextSub.sub_account_id).balance, 600);
  assert.equal(ctx.Transactions.accountBalances()[card.account_id], 600);
});

test('RECLASSIFY จัดกลุ่มยอดยกมาของหนี้สิน คืนเงินลดรายจ่าย และ retry หลังเขียนล้มเหลวไม่ซ้ำ', () => {
  const { ctx, tx, bank, a, master, key, category, owner, report } = fixture();
  const card = master('account', { account_name: 'บัตรหลัก', account_type: 'CREDIT_CARD', opening_balance: 100 });
  const child = master('subaccount', { account_id: card.account_id, sub_account_name: 'บัตรย่อย' });
  const move = tx({ transaction_type: 'RECLASSIFY', from_account_id: card.account_id, to_account_id: card.account_id,
    to_sub_account_id: child.sub_account_id, amount: 70 });
  assert.equal(ctx.Transactions.accountBalances()[card.account_id], 100);
  assert.equal(report().accounts.find((r) => r.sub_account_id === child.sub_account_id).balance, 70);
  tx({ transaction_type: 'REFUND', to_account_id: card.account_id, to_sub_account_id: child.sub_account_id,
    category_id: category.category_id, amount: 10 });
  const share = ctx.api_sharedAccountReport({}).data.accounts.find((r) => r.name === 'บัตรย่อย');
  assert.equal(share.balance, 60);
  assert.equal(share.expense, -10);
  assert.equal(ctx.api_reverseTransaction(move.transaction_id, { reason: 'คืนการจัดกลุ่ม' }, key()).ok, true);
  assert.equal(report().accounts.find((r) => r.sub_account_id === child.sub_account_id).balance, -10);
  const differentParents = ctx.api_createTransaction({ transaction_type: 'RECLASSIFY', transaction_date: ctx.Util.todayIso(), owner_id: owner.owner_id,
    from_account_id: bank.account_id, to_account_id: card.account_id, item_name: 'ผิดบัญชี', amount: 1 }, key());
  assert.equal(differentParents.ok, false);
  const append = ctx.Database.appendRowsIfAbsent;
  let inject = true;
  ctx.Database.appendRowsIfAbsent = (name, rows) => {
    const result = append(name, rows);
    if (name === 'Transactions' && inject) { inject = false; throw new Error('failure after write'); }
    return result;
  };
  const input = { transaction_type: 'RECLASSIFY', transaction_date: ctx.Util.todayIso(), owner_id: owner.owner_id,
    from_account_id: bank.account_id, to_account_id: bank.account_id, to_sub_account_id: a.sub_account_id, item_name: 'retry grouping', amount: 12.34 };
  const requestKey = key();
  assert.equal(ctx.api_createTransaction(input, requestKey).ok, false);
  assert.equal(ctx.api_createTransaction(input, requestKey).ok, true);
  assert.equal(report().accounts.find((r) => r.sub_account_id === a.sub_account_id).balance, 12.34);
  assert.equal(ctx.Transactions.accountBalances()[bank.account_id], 1000);
});

test('อ่าน schema เดิมได้โดยไม่แก้ชีต เติมคอลัมน์ส่วนท้ายเมื่อเขียน และ initialize ซ้ำได้', () => {
  const { ctx, tx, bank, category } = fixture();
  tx({ transaction_type: 'EXPENSE', from_account_id: bank.account_id, category_id: category.category_id, amount: 10 });
  ['Transactions', 'PaymentPlans', 'PaymentSchedules'].forEach((name) => {
    const sheet = ctx.__ss.getSheetByName(name);
    const legacy = plain(ctx.Config.LEGACY_HEADERS[name]);
    sheet.data = sheet.data.map((row) => row.slice(0, legacy.length));
  });
  const sheet = ctx.__ss.getSheetByName('Transactions');
  const legacyHeader = sheet.data[0].slice();
  ctx.Database.resetExecutionCache();
  assert.equal(ctx.api_listTransactions({}).ok, true);
  assert.deepEqual(sheet.data[0], legacyHeader);
  tx({ transaction_type: 'EXPENSE', from_account_id: bank.account_id, category_id: category.category_id, item_name: 'ใหม่', amount: 12 });
  assert.deepEqual(sheet.data[0], plain(ctx.Config.HEADERS.Transactions));
  assert.equal(ctx.Database.readAll('Transactions').rows[0].amount, 10);
  assert.equal(ctx.Database.readAll('Transactions').rows[0].from_sub_account_id, '');
  ctx.Database.initialize();
  assert.ok(ctx.Database.checkSchema().every((r) => r.status === 'OK'));
  assert.ok(ctx.Database.initialize().every((r) => r.status === 'OK'));
});

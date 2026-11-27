'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `event-test-${String(++seq).padStart(6, '0')}`;

function fixture() {
  const ctx = createDbContext();
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const ids = {
    dad: mk('owner', { owner_name: 'พ่อ' }),
    mom: mk('owner', { owner_name: 'แม่' }),
    bank: mk('account', { account_name: 'KBank', account_type: 'BANK', opening_balance: 50000 }),
    cash: mk('account', { account_name: 'เงินสด', account_type: 'CASH', opening_balance: 5000 }),
    card: mk('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD' }),
    food: mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' }),
    hotel: mk('category', { category_name: 'ที่พัก', category_type: 'EXPENSE' }),
    salary: mk('category', { category_name: 'เงินเดือน', category_type: 'INCOME' })
  };
  const saveEvent = (input) => {
    const res = ctx.api_saveEventBudget({ budget_name: 'เที่ยวญี่ปุ่น', amount: 20000, start_date: '2026-12-10', end_date: '2026-12-15', ...input }, key(), 202612);
    return plain(res);
  };
  let n = 0;
  const tx = (input) => plain(ctx.api_createTransaction({ transaction_date: '2026-12-11', transaction_type: 'EXPENSE', from_account_id: ids.bank.account_id,
    owner_id: ids.dad.owner_id, category_id: ids.food.category_id, item_name: 'รายการ ' + (++n), amount: 100, allow_duplicate: true, ...input }, key()));
  const events = (today) => plain(ctx.Budgets.listEvents({ includeInactive: true, today }));
  const rows = (sheet) => plain(ctx.Database.readAll(sheet).rows);
  return { ctx, ids, saveEvent, tx, events, rows };
}

test('สร้างงบทริป: budget_kind EVENT, budget_month = เดือนของวันเริ่ม, ไม่มีหมวด; ตรวจช่วงวันที่ ยอด และชื่อซ้ำ', () => {
  const s = fixture();
  const res = s.saveEvent({});
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = s.rows('Budgets')[0];
  assert.equal(row.budget_kind, 'EVENT');
  assert.equal(row.budget_month, 202612);
  assert.equal(row.start_date, '2026-12-10');
  assert.equal(row.end_date, '2026-12-15');
  assert.equal(row.weekly_amount, 0);
  assert.equal(s.rows('BudgetCategories').length, 0);
  assert.equal(res.data.page.events.length, 1);
  assert.equal(res.data.page.budgets.length, 0, 'งบทริปไม่แสดงเป็นงบรายเดือน');
  assert.equal(s.saveEvent({ budget_name: 'อื่น', end_date: '2026-12-09' }).code, 'VALIDATION_BUDGET');
  assert.equal(s.saveEvent({ budget_name: 'ยาว', end_date: '2027-12-11' }).code, 'VALIDATION_BUDGET');
  assert.equal(s.saveEvent({ budget_name: 'ศูนย์', amount: 0 }).ok, false);
  assert.equal(s.saveEvent({ budget_name: 'ไม่มีวัน', start_date: '' }).code, 'VALIDATION_REQUIRED');
  assert.equal(s.saveEvent({ budget_name: ' เที่ยวญี่ปุ่น ' }).code, 'VALIDATION_BUDGET', 'ชื่อซ้ำกับงบทริปที่เปิดอยู่');
  assert.equal(s.rows('Budgets').length, 1);
});

test('ใช้จากงบ: นับรายจ่ายทุกบัญชี (รวมบัตรเครดิต/เงินสด) ทุกหมวด และทุกวันที่; ยอดแยกหมวด/บัญชี; ต่อวันระหว่างทริป', () => {
  const s = fixture();
  const id = s.saveEvent({}).data.result.budget_id;
  assert.equal(s.tx({ budget_id: id, amount: 6000, category_id: s.ids.hotel.category_id, transaction_date: '2026-11-20' }).ok, true, 'จ่ายที่พักล่วงหน้า');
  assert.equal(s.tx({ budget_id: id, amount: 1500, transaction_type: 'CREDIT_PURCHASE', from_account_id: s.ids.card.account_id }).ok, true);
  assert.equal(s.tx({ budget_id: id, amount: 500.5, from_account_id: s.ids.cash.account_id }).ok, true);
  s.tx({ amount: 999 }); // ไม่ได้เลือกงบ
  const [ev] = s.events('2026-12-12');
  assert.equal(ev.phase, 'ACTIVE');
  assert.equal(ev.spent, 8000.5);
  assert.equal(ev.remaining, 11999.5);
  assert.equal(ev.transaction_count, 3);
  assert.equal(ev.days_left, 4);
  assert.equal(ev.per_day, 2999.87);
  assert.deepEqual(ev.by_category, [{ name: 'ที่พัก', amount: 6000 }, { name: 'อาหาร', amount: 2000.5 }]);
  assert.deepEqual(ev.by_account.map((a) => a.name), ['KBank', 'บัตร', 'เงินสด']);
  const tr = s.rows('Transactions').find((t) => t.amount === 1500);
  assert.equal(tr.budget_name, 'เที่ยวญี่ปุ่น');
  assert.equal(s.events('2026-12-01')[0].phase, 'UPCOMING');
  assert.equal(s.events('2026-12-01')[0].days_until, 9);
  assert.equal(s.events('2026-12-20')[0].phase, 'ENDED');
  const list = plain(s.ctx.api_listTransactions({ budget_id: id }).data);
  assert.equal(list.total, 3);
  assert.equal(plain(s.ctx.api_listTransactions({ q: 'ญี่ปุ่น' }).data).total, 3);
});

test('ตรวจการเลือกงบ: ประเภทที่ไม่ใช่รายจ่าย, งบรายเดือน, งบปิด, เจ้าของไม่ตรง, ID ไม่มี → ปฏิเสธ', () => {
  const s = fixture();
  const id = s.saveEvent({ owner_id: s.ids.dad.owner_id }).data.result.budget_id;
  const monthly = plain(s.ctx.api_saveBudget({ budget_month: 202612, budget_name: 'อาหาร', amount: 5000, category_ids: [s.ids.food.category_id] }, key()));
  assert.equal(monthly.ok, true, JSON.stringify(monthly));
  const monthlyId = monthly.data.result.budget_id;
  assert.equal(s.tx({ budget_id: id, transaction_type: 'INCOME', from_account_id: '', to_account_id: s.ids.bank.account_id, category_id: s.ids.salary.category_id }).code, 'VALIDATION_RULE');
  assert.equal(s.tx({ budget_id: id, transaction_type: 'TRANSFER', to_account_id: s.ids.cash.account_id, category_id: '' }).code, 'VALIDATION_RULE');
  assert.equal(s.tx({ budget_id: monthlyId }).code, 'VALIDATION_FK_NOT_FOUND');
  assert.equal(s.tx({ budget_id: '999' }).code, 'VALIDATION_FK_NOT_FOUND');
  const momTx = s.tx({ budget_id: id, owner_id: s.ids.mom.owner_id });
  assert.equal(momTx.code, 'VALIDATION_RULE');
  assert.match(momTx.message, /เป็นของพ่อ/);
  const ok = s.tx({ budget_id: id });
  assert.equal(ok.ok, true);
  assert.equal(plain(s.ctx.api_setBudgetActive(id, false, key(), 202612)).ok, true);
  assert.equal(s.tx({ budget_id: id }).code, 'VALIDATION_FK_INACTIVE');
  // แก้รายการเดิมที่อ้างงบที่ปิดแล้วได้ (คงค่าเดิม)
  const upd = plain(s.ctx.api_updateTransaction(ok.data.transaction_id, { transaction_date: '2026-12-11', transaction_type: 'EXPENSE', from_account_id: s.ids.bank.account_id,
    owner_id: s.ids.dad.owner_id, category_id: s.ids.food.category_id, item_name: 'แก้ชื่อ', amount: 120 }, key()));
  assert.equal(upd.ok, true, JSON.stringify(upd));
  assert.equal(upd.data.budget_id, id);
});

test('กลับรายการและคืนเงิน (REFUND) ลดยอดใช้ไป; แก้รายการย้ายงบ/เอางบออกได้', () => {
  const s = fixture();
  const a = s.saveEvent({}).data.result.budget_id;
  const b = s.saveEvent({ budget_name: 'ทริปเชียงใหม่' }).data.result.budget_id;
  const t1 = s.tx({ budget_id: a, amount: 1000 }).data;
  const t2 = s.tx({ budget_id: a, amount: 300 }).data;
  assert.equal(plain(s.ctx.api_reverseTransaction(t1.transaction_id, { reason: 'ยกเลิก', transaction_date: '2026-12-12' }, key())).ok, true);
  assert.equal(s.rows('Transactions').find((t) => t.reversal_of === t1.transaction_id).budget_id, a);
  assert.equal(s.tx({ budget_id: a, transaction_type: 'REFUND', from_account_id: '', to_account_id: s.ids.bank.account_id, amount: 50 }).ok, true);
  const spent = () => Object.fromEntries(s.events('2026-12-12').map((e) => [e.budget_id, e.spent]));
  assert.deepEqual(spent(), { [a]: 250, [b]: 0 });
  const base = { transaction_date: '2026-12-11', transaction_type: 'EXPENSE', from_account_id: s.ids.bank.account_id, owner_id: s.ids.dad.owner_id,
    category_id: s.ids.food.category_id, item_name: t2.item_name, amount: 300 };
  assert.equal(plain(s.ctx.api_updateTransaction(t2.transaction_id, { ...base, budget_id: b }, key())).ok, true);
  assert.deepEqual(spent(), { [a]: -50, [b]: 300 });
  assert.equal(plain(s.ctx.api_updateTransaction(t2.transaction_id, { ...base, budget_id: '' }, key())).ok, true);
  assert.deepEqual(spent(), { [a]: -50, [b]: 0 });
  assert.equal(s.rows('Transactions').find((t) => t.transaction_id === t2.transaction_id).budget_name, '');
});

test('เปลี่ยนชื่องบทริป: budget_name ทุกรายการเปลี่ยน ID และ updated_at ไม่เปลี่ยน, audit RENAME_BUDGET หนึ่งครั้ง; เปลี่ยนเจ้าของเมื่อมีรายการคนอื่นไม่ได้', () => {
  const s = fixture();
  const id = s.saveEvent({}).data.result.budget_id;
  s.tx({ budget_id: id });
  s.tx({ budget_id: id, owner_id: s.ids.mom.owner_id });
  const before = s.rows('Transactions').map((t) => t.updated_at);
  const res = s.saveEvent({ budget_id: id, budget_name: 'ญี่ปุ่น 2569', amount: 25000 });
  assert.equal(res.ok, true, JSON.stringify(res));
  const txs = s.rows('Transactions');
  assert.deepEqual(txs.map((t) => t.budget_name), ['ญี่ปุ่น 2569', 'ญี่ปุ่น 2569']);
  assert.deepEqual(txs.map((t) => t.budget_id), [id, id]);
  assert.deepEqual(txs.map((t) => t.updated_at), before);
  assert.equal(s.rows('AuditLogs').filter((a) => a.action === 'RENAME_BUDGET').length, 1);
  assert.equal(s.events('2026-12-12')[0].amount, 25000);
  assert.equal(s.saveEvent({ budget_id: id, budget_name: 'ญี่ปุ่น 2569', owner_id: s.ids.dad.owner_id }).code, 'VALIDATION_BUDGET');
  const report = plain(s.ctx.Projection.refresh({ dryRun: true }));
  assert.equal(report.tables.length, 0, 'refreshProjections ไม่มีอะไรต้องแก้ (idempotent)');
});

test('งบรายเดือนไม่นับรายการที่ใช้จากงบทริป และงบรายเดือนเดิมทำงานเหมือนเดิม', () => {
  const s = fixture();
  const ev = s.saveEvent({}).data.result.budget_id;
  assert.equal(plain(s.ctx.api_saveBudget({ budget_month: 202612, budget_name: 'อาหาร', amount: 5000, category_ids: [s.ids.food.category_id] }, key())).ok, true);
  s.tx({ amount: 200 });
  s.tx({ amount: 700, budget_id: ev });
  const monthly = plain(s.ctx.Budgets.list(202612, { today: '2026-12-12' }));
  assert.equal(monthly.length, 1);
  assert.equal(monthly[0].spent, 200);
  assert.equal(s.events('2026-12-12')[0].spent, 700);
  // คัดลอกงบรายเดือนไม่คัดลอกงบทริป
  assert.equal(plain(s.ctx.api_copyBudgets(202612, 202701, key())).data.result.copied, 1);
  assert.equal(s.rows('Budgets').filter((b) => b.budget_kind === 'EVENT').length, 1);
});

test('ชีตรุ่นเก่า (Budgets 11 คอลัมน์, Transactions 25 คอลัมน์) อ่านได้โดยไม่แก้ชีต และเติม header เมื่อเขียน', () => {
  const s = fixture();
  assert.equal(plain(s.ctx.api_saveBudget({ budget_month: 202612, budget_name: 'อาหาร', amount: 5000, category_ids: [s.ids.food.category_id] }, key())).ok, true);
  s.tx({ amount: 10 });
  const cut = { Budgets: 11, Transactions: 25 };
  Object.entries(cut).forEach(([name, width]) => {
    const sheet = s.ctx.__ss.getSheetByName(name);
    sheet.data = sheet.data.map((row) => row.slice(0, width));
  });
  s.ctx.Database.resetExecutionCache();
  assert.ok(plain(s.ctx.Database.checkSchema()).filter((r) => cut[r.sheet]).every((r) => r.status === 'UPGRADE_AVAILABLE'));
  assert.equal(plain(s.ctx.api_budgetPage(202612)).data.budgets.length, 1);
  assert.equal(s.ctx.__ss.getSheetByName('Budgets').data[0].length, 11);
  const id = s.saveEvent({}).data.result.budget_id;
  assert.equal(s.tx({ budget_id: id, amount: 20 }).ok, true);
  assert.deepEqual(s.ctx.__ss.getSheetByName('Budgets').data[0], plain(s.ctx.Config.HEADERS.Budgets));
  assert.deepEqual(s.ctx.__ss.getSheetByName('Transactions').data[0], plain(s.ctx.Config.HEADERS.Transactions));
  assert.equal(s.rows('Budgets')[0].budget_kind, '', 'แถวเดิมว่าง = MONTHLY');
  assert.equal(plain(s.ctx.Budgets.list(202612)).length, 1);
  assert.ok(plain(s.ctx.Database.checkSchema()).every((r) => r.status === 'OK'));
});

test('retry ด้วย key เดิมไม่สร้างงบซ้ำ; หน้ารายการคืน event_budgets ที่เลือกได้', () => {
  const s = fixture();
  const k = key();
  const input = { budget_name: 'ทะเล', amount: 3000, start_date: '2026-12-01', end_date: '2026-12-03' };
  const r1 = plain(s.ctx.api_saveEventBudget(input, k, 202612));
  const r2 = plain(s.ctx.api_saveEventBudget(input, k, 202612));
  assert.equal(r1.data.result.budget_id, r2.data.result.budget_id);
  assert.equal(s.rows('Budgets').length, 1);
  const page = plain(s.ctx.api_transactionPage({}, { includeMasters: true }).data);
  assert.equal(page.event_budgets.length, 1);
  assert.equal(page.event_budgets[0].budget_name, 'ทะเล');
  assert.ok('remaining' in page.event_budgets[0]);
});

test('CSV/Pivot รายการมีคอลัมน์ budget_name', () => {
  const s = fixture();
  const id = s.saveEvent({}).data.result.budget_id;
  s.tx({ budget_id: id, amount: 42 });
  const lines = String(s.ctx.FinanceReports.exportCsv('TRANSACTIONS', { month: 202612 })).replace(/^﻿/, '').split(/\r?\n/);
  const cells = (line) => line.split(',').map((c) => c.replace(/^"|"$/g, ''));
  const col = cells(lines[0]).indexOf('budget_name');
  assert.ok(col >= 0, lines[0]);
  assert.equal(cells(lines[1])[col], 'เที่ยวญี่ปุ่น');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createDbContext, resetCalls, countCalls } = require('./gas-shim');
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  const ctx = createDbContext();
  const actor = { actorId: 'owner@example.com' };
  const create = (type, input) => ctx.MasterData.create(type, input, { actor, idempotencyKey: 'report-seed-' + type });
  const owner = create('owner', { owner_name: 'ผู้ทดสอบ' });
  const account = create('account', { account_name: 'เงินทดสอบ', account_type: 'CASH', opening_balance: 10000 });
  const category = create('category', { category_name: '=SUM(1,1)', category_type: 'EXPENSE' });
  const input = { item_name: 'ทดสอบ,"รายงาน"', purchase_date: '2026-11-26', plan_type: 'INSTALLMENT',
    account_id: account.account_id, owner_id: owner.owner_id, category_id: category.category_id,
    principal_amount: 600, installment_count: 6, first_saving_month: 202611, first_payment_month: 202612 };
  const created = ctx.api_createPaymentPlan(input, 'report-create-plan');
  assert.equal(created.ok, true, JSON.stringify(created));
  return { ctx, actor, owner, account, category, planId: created.data.plan_id };
}

function csvRows(csv) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\r' || c === '\n')) {
      row.push(value); value = '';
      if (c !== ',') { if (c === '\r' && csv[i + 1] === '\n') i++; rows.push(row); row = []; }
    } else value += c;
  }
  row.push(value); rows.push(row);
  const headers = rows.shift();
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

test('รายงานแผนใช้เดือนเก็บ/เดือนชำระแยกกัน ข้ามปี และไม่รวมงวดที่ยกเลิก', () => {
  const { ctx, planId } = fixture();
  const read = (kind, filters) => csvRows(ctx.api_exportFinanceReport(kind, filters).data);
  assert.equal(read('SAVING', { year: 2026 }).length, 2);
  assert.equal(read('PAYMENT', { year: 2026 }).length, 1);
  assert.equal(read('PAYMENT', { month: 202701 })[0].amount_due, '100');
  assert.equal(read('PAYMENT', { year: 2027 }).length, 5);
  const cancelled = ctx.api_paymentActivity({ action: 'CANCEL', plan_id: planId, date: '2026-11-26', note: 'ทดสอบรายงาน' }, 'report-cancel-plan');
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(read('SAVING', {}).length, 0);
  assert.equal(read('PAYMENT', {}).length, 0);
});

test('CSV คงข้อความไทย comma/quote และป้องกัน formula injection โดยยอดเงินยังเป็นตัวเลข', () => {
  const { ctx, account, owner, category } = fixture();
  const result = ctx.api_createTransaction({ transaction_date: '2026-11-26', transaction_type: 'EXPENSE',
    from_account_id: account.account_id, owner_id: owner.owner_id, category_id: category.category_id,
    item_name: 'สินค้า,"หนึ่ง"', amount: 12.34 }, 'report-csv-transaction');
  assert.equal(result.ok, true);
  const rows = csvRows(ctx.api_exportFinanceReport('TRANSACTIONS', { month: 202611 }).data);
  assert.equal(rows[0].item_name, 'สินค้า,"หนึ่ง"');
  assert.equal(rows[0].category_name, "'=SUM(1,1)");
  assert.equal(rows[0].expense, '12.34');
  assert.equal(rows[0].month, '202611');
  assert.equal(ctx.api_dashboard({ month: 202611 }).data.summary.expense, 12.34);
});

test('Pivot refresh ซ้ำไม่เพิ่ม Pivot และล้างแถวเก่าหลังยกเลิก โดยข้อมูลธุรกิจไม่เปลี่ยน', () => {
  const { ctx, planId } = fixture();
  const before = JSON.stringify(ctx.__ss.getSheets().map((s) => ({ name: s.name, data: s.data })));
  const result = plain(ctx.FinanceReports.refreshPivots());
  assert.deepEqual(result.map((r) => r.sourceRows), [6, 6, 0]);
  const saving = ctx.__ss.getSheetByName('View_Pivot_Saving');
  const payment = ctx.__ss.getSheetByName('View_Pivot_Payment');
  assert.equal(saving.data[2][6], 202611);
  assert.equal(payment.data[2][6], 202612);
  assert.equal(saving.data.slice(2).reduce((sum, r) => sum + r[7], 0), 600);
  const pivot = ctx.__ss.getSheetByName('Pivot_Saving').pivots[0];
  assert.deepEqual(plain(pivot.groups), [3, 10]);
  assert.deepEqual(plain(pivot.columns), [7]);
  assert.deepEqual(plain(pivot.values), [{ column: 8, summary: 'SUM' }, { column: 9, summary: 'SUM' }]);
  ctx.FinanceReports.refreshPivots();
  assert.equal(ctx.__ss.getSheetByName('Pivot_Saving').pivots.length, 1);
  assert.equal(JSON.stringify(ctx.__ss.getSheets().filter((s) => !/^(View_)?Pivot_/.test(s.name)).map((s) => ({ name: s.name, data: s.data }))), before);
  const cancelled = ctx.api_paymentActivity({ action: 'CANCEL', plan_id: planId, date: '2026-11-26', note: 'ทดสอบรายงาน' }, 'report-pivot-cancel');
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  ctx.FinanceReports.refreshPivots();
  assert.equal(saving.getLastRow(), 2);
  assert.equal(payment.getLastRow(), 2);
  assert.equal(ctx.__ss.getSheetByName('Pivot_Saving').pivots.length, 0);
  assert.equal(ctx.__state.locks, 0);
});

test('Pivot ปฏิเสธชื่อชีตที่ผู้ใช้มีอยู่และ lock ไม่พร้อม โดยไม่เขียนทับข้อมูล', () => {
  const { ctx } = fixture();
  const sheet = ctx.__ss.insertSheet('Pivot_Payment');
  sheet.getRange(1, 1).setValue('ข้อมูลของผู้ใช้');
  resetCalls(ctx.__ss);
  assert.throws(() => ctx.FinanceReports.refreshPivots(), (e) => e.code === 'PIVOT_NAME_IN_USE');
  assert.equal(countCalls(ctx.__ss).setValues, 0);
  assert.equal(ctx.__ss.getSheetByName('Pivot_Saving'), null);
  assert.equal(ctx.__state.locks, 0);
  ctx.__state.lockAvailable = false;
  assert.throws(() => ctx.FinanceReports.refreshPivots(), (e) => e.code === 'BUSY');
});

test('รายงาน 10,000 ธุรกรรม: ยอดตรง จำนวนอ่านคงที่ ไม่เขียนชีต และ Pivot ขยายแถวได้', (t) => {
  const { ctx, account, owner, category } = fixture();
  const rows = Array.from({ length: 10000 }, (_, i) => ({ transaction_id: ctx.Util.uuid(),
    transaction_date: i % 2 ? '2026-11-26' : '2027-01-01', transaction_type: 'EXPENSE',
    from_account_id: account.account_id, from_account_name: account.account_name,
    owner_id: owner.owner_id, owner_name: owner.owner_name, category_id: category.category_id, category_name: category.category_name,
    item_name: 'รายการ ' + i, amount: 1.01, created_at: '2026-11-26T10:00:00+07:00' }));
  ctx.Database.appendRows('Transactions', rows);
  ctx.Database.resetExecutionCache(); resetCalls(ctx.__ss);
  const start = performance.now();
  const result = ctx.api_dashboard({ year: 2026 });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.expense, 5050);
  assert.equal(result.data.accounts[0].balance, -100);
  assert.equal(result.data.recent.length, 8);
  const calls = countCalls(ctx.__ss);
  assert.ok(calls.getValues <= 9, JSON.stringify(calls));
  assert.equal(calls.setValues, 0);
  const csv = csvRows(ctx.api_exportFinanceReport('TRANSACTIONS', { year: 2026 }).data);
  assert.equal(csv.length, 5000);
  assert.equal(csv.reduce((sum, r) => sum + Math.round(Number(r.expense) * 100), 0), 505000);
  ctx.FinanceReports.refreshPivots();
  const source = ctx.__ss.getSheetByName('View_Pivot_Transactions');
  assert.equal(source.getMaxRows(), 10002);
  assert.equal(source.getLastRow(), 10002);
  t.diagnostic(JSON.stringify({ transactions: rows.length, dashboardReads: calls.getValues, elapsedMs: Math.round(performance.now() - start), engine: 'Node fake Sheets; not Google latency' }));
});

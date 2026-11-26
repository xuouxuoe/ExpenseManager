'use strict';
/**
 * งบจำนวนการเรียก Sheets API ต่อคำขอ (กันประสิทธิภาพถดถอย)
 * นับจาก FakeSpreadsheet: getSheetByName / getValues / setValues / textFinder
 * (getLastRow/getLastColumn ของ fake ถูกเรียกภายใน getDataRange จึงไม่นำมานับ)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext, countCalls, resetCalls } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `perf-key-${String(++seq).padStart(6, '0')}`;
const ACTOR = { actorId: 'owner@example.com' };

function seeded(rows) {
  const ctx = createDbContext();
  const req = () => ({ idempotencyKey: key(), actor: ACTOR });
  const owner = ctx.MasterData.create('owner', { owner_name: 'A' }, req());
  const acc = ctx.MasterData.create('account', { account_name: 'Cash', account_type: 'CASH' }, req());
  const cat = ctx.MasterData.create('category', { category_name: 'Food', category_type: 'EXPENSE' }, req());
  for (let i = 0; i < rows; i++) {
    ctx.Transactions.create({ transaction_date: '2026-11-25', transaction_type: 'EXPENSE', from_account_id: acc.account_id, category_id: cat.category_id,
      owner_id: owner.owner_id, item_name: 'item ' + i, amount: 10 + i }, req());
  }
  return { ctx, owner, acc, cat };
}

function measure(ctx, fn) {
  resetCalls(ctx.__ss);
  const result = fn();
  return { calls: countCalls(ctx.__ss), result };
}

test('createTransaction: อ่านแต่ละชีตไม่เกินครั้งเดียว และงบการเรียก', () => {
  const { ctx, owner, acc, cat } = seeded(30);
  const { calls, result } = measure(ctx, () => ctx.api_createTransaction({ transaction_date: '2026-11-26', transaction_type: 'EXPENSE', from_account_id: acc.account_id,
    category_id: cat.category_id, owner_id: owner.owner_id, item_name: 'ใหม่', amount: 1 }, key()));
  assert.equal(plain(result).ok, true);
  // Display names and SubAccounts each add one cached master-table read.
  assert.ok(calls.getSheetByName <= 8, JSON.stringify(calls));
  assert.ok(calls.getValues <= 8, JSON.stringify(calls));
  assert.ok(calls.setValues <= 4, JSON.stringify(calls));
  assert.ok(calls.textFinder <= 1, JSON.stringify(calls));
});

test('จำนวนการอ่านไม่โตตามจำนวน OperationJournal (journal ใช้ TextFinder ไม่อ่านทั้งตาราง)', () => {
  const small = seeded(5);
  const big = seeded(60);
  const input = (s) => ({ transaction_date: '2026-11-27', transaction_type: 'EXPENSE', from_account_id: s.acc.account_id,
    category_id: s.cat.category_id, owner_id: s.owner.owner_id, item_name: 'x', amount: 1 });
  const a = measure(small.ctx, () => small.ctx.api_createTransaction(input(small), key())).calls;
  const b = measure(big.ctx, () => big.ctx.api_createTransaction(input(big), key())).calls;
  assert.equal(a.getValues, b.getValues);
  assert.equal(a.setValues, b.setValues);
});

test('transactionPage อ่าน 6 ชีตรวม Settings และ SubAccounts ครั้งละครั้ง', () => {
  const { ctx } = seeded(10);
  const { calls, result } = measure(ctx, () => ctx.api_transactionPage({}, { includeMasters: true }));
  const data = plain(result).data;
  assert.equal(data.list.total, 10);
  assert.ok(Array.isArray(data.suggestions.recent));
  assert.equal(data.masters.accounts.length, 1);
  assert.equal(calls.getValues, 6, JSON.stringify(calls));
  assert.equal(calls.setValues, 0);
});

test('create + page: คืนรายการ ยอดสรุป และตัวช่วยจาก cache ในคำขอเดียว และ replay โดยไม่เขียนซ้ำ', () => {
  const { ctx, owner, acc, cat } = seeded(0);
  const scope = ctx.api_transactionPage({}, { includeMasters: true }).data.queueScope;
  const input = { transaction_date: ctx.Util.todayIso(), transaction_type: 'EXPENSE', from_account_id: acc.account_id,
    category_id: cat.category_id, owner_id: owner.owner_id, item_name: 'รายการล่าสุด', amount: '85.50' };
  const operationKey = key();
  const { calls, result } = measure(ctx, () => ctx.api_createTransaction(input, operationKey, {}, scope));
  assert.equal(result.ok, true);
  assert.equal(result.data.page.list.rows[0].transaction_id, result.data.row.transaction_id);
  assert.equal(result.data.page.list.summary.expense, 85.50);
  assert.equal(result.data.page.suggestions.recent[0].item_name, input.item_name);
  assert.ok(calls.getValues <= 8, JSON.stringify(calls));
  assert.ok(calls.setValues <= 4, JSON.stringify(calls));

  const replay = measure(ctx, () => ctx.api_createTransaction(input, operationKey, { q: 'nomatch' }, scope));
  assert.equal(replay.calls.setValues, 0);
  assert.equal(replay.result.data.row.transaction_id, result.data.row.transaction_id);
  assert.equal(replay.result.data.page.list.total, 0);
});

test('ผลอ่านหน้าล้มเหลวไม่เปลี่ยนสถานะการเขียน และขอบเขตคิวจากไฟล์หรือผู้ใช้อื่นไม่เขียนชีต', () => {
  const { ctx, owner, acc, cat } = seeded(0);
  const scope = ctx.api_transactionPage({}, { includeMasters: true }).data.queueScope;
  const input = { transaction_date: ctx.Util.todayIso(), transaction_type: 'EXPENSE', from_account_id: acc.account_id,
    category_id: cat.category_id, owner_id: owner.owner_id, item_name: 'รายการทดสอบ', amount: 85 };
  const operationKey = key();
  ctx.__props.DB_TARGET = 'TEST';
  assert.equal(ctx.api_createTransaction(input, operationKey, {}, scope).code, 'QUEUE_CONTEXT_CHANGED');
  ctx.__props.DB_TARGET = 'PRODUCTION';
  ctx.__props.ALLOWED_EMAILS += ',someone@example.com';
  ctx.__state.activeEmail = 'someone@example.com';
  assert.equal(ctx.api_createTransaction(input, operationKey, {}, scope).code, 'QUEUE_CONTEXT_CHANGED');
  ctx.__state.activeEmail = ACTOR.actorId;
  assert.equal(ctx.api_listTransactions({}).data.total, 0);

  const saved = ctx.api_createTransaction(input, operationKey, { page: -1 }, scope);
  assert.equal(saved.ok, true);
  assert.equal(saved.data.page, null);
  const edited = ctx.api_updateTransaction(saved.data.row.transaction_id, { ...input, amount: 90 }, key(), {});
  assert.equal(edited.data.page.list.summary.expense, 90);
  const reversed = ctx.api_reverseTransaction(saved.data.row.transaction_id, { reason: 'ทดสอบ' }, key(), {});
  assert.equal(reversed.data.page.list.summary.expense, 0);
  assert.equal(reversed.data.page.list.rows.find((row) => row.transaction_id === saved.data.row.transaction_id).is_reversed, true);
});

test('updateMaster ที่ไม่เปลี่ยนชื่อไม่ refresh projection (ไม่เขียน Transactions)', () => {
  const { ctx, owner } = seeded(10);
  const txSheet = ctx.__ss.getSheetByName('Transactions');
  const { calls } = measure(ctx, () => ctx.api_updateMaster('owner', owner.owner_id, { owner_name: 'A' }, key()));
  assert.equal(txSheet.calls.setValues, 0);
  assert.ok(calls.getValues <= 7, JSON.stringify(calls));
});

test('cache ไม่ทำให้ใช้ข้อมูลเก่า: ข้อมูลที่ execution อื่นเขียนก่อนได้ lock ถูกอ่านใหม่', () => {
  const { ctx } = seeded(0);
  ctx.Database.readAll('Owners'); // เติม cache
  // จำลองอีก execution เพิ่มเจ้าของชื่อ "B" ลงชีตโดยตรง
  const sheet = ctx.__ss.getSheetByName('Owners');
  sheet.data.push(['00000000-0000-4000-8000-0000000000bb', 'B', true, 'x', 'x']);
  assert.throws(() => ctx.MasterData.create('owner', { owner_name: 'b' }, { idempotencyKey: key(), actor: ACTOR }),
    (e) => e.code === 'VALIDATION_DUPLICATE_NAME');
});

test('cache สอดคล้องหลังเขียน: append/update/writeColumn แล้วอ่านได้ค่าใหม่โดยไม่อ่านชีตซ้ำ', () => {
  const { ctx } = seeded(0);
  const D = ctx.Database;
  D.resetExecutionCache();
  const before = D.readAll('Owners').rows.length;
  const sheet = ctx.__ss.getSheetByName('Owners');
  resetCalls(ctx.__ss);
  D.appendRows('Owners', [{ owner_id: 'o-x', owner_name: 'X', is_active: true, created_at: 'c', updated_at: 'u' }]);
  const rows = D.readAll('Owners');
  assert.equal(rows.rows.length, before + 1);
  D.updateRows('Owners', [Object.assign({}, rows.rows[before], { owner_name: 'Y' })]);
  D.writeColumn('Owners', 'owner_name', [rows.rowNumbers[before]], ['Z']);
  assert.equal(D.readAll('Owners').rows[before].owner_name, 'Z');
  assert.equal(sheet.calls.getValues || 0, 0, 'ไม่ควรอ่านชีตซ้ำหลังเขียน');
  assert.equal(sheet.data[rows.rowNumbers[before] - 1][1], 'Z', 'ข้อมูลในชีตต้องตรงกับ cache');
});

'use strict';
// เรียงรายการตามเวลาที่บันทึก (รายการจาก LINE/สลิปที่วันที่ย้อนหลังต้องเห็นบนสุด)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `sort-test-${String(++seq).padStart(6, '0')}`;

test('sort=CREATED เรียงตามเวลาที่บันทึกล่าสุดก่อน; ค่าเริ่มต้นยังเรียงตามวันที่ทำรายการ; ค่าอื่นถูกปฏิเสธ', () => {
  const ctx = createDbContext();
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const dad = mk('owner', { owner_name: 'พ่อ' });
  const bank = mk('account', { account_name: 'KBank', account_type: 'BANK' });
  const food = mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' });
  const add = (date, name) => assert.equal(ctx.api_createTransaction({ transaction_date: date, transaction_type: 'EXPENSE', from_account_id: bank.account_id,
    owner_id: dad.owner_id, category_id: food.category_id, item_name: name, amount: 10 }, key()).ok, true);
  add('2026-11-28', 'วันนี้');
  add('2026-11-20', 'สลิปย้อนหลัง');
  // บังคับเวลาบันทึกให้ต่างกันชัดเจน (การบันทึกจริงอยู่ในวินาทีเดียวกันในเทสต์)
  const sheet = ctx.__ss.getSheetByName('Transactions');
  const col = sheet.data[0].indexOf('created_at');
  sheet.data[1][col] = '2026-11-28T08:00:00+07:00';
  sheet.data[2][col] = '2026-11-28T09:30:00+07:00';
  ctx.Database.resetExecutionCache();
  const names = (filters) => plain(ctx.api_listTransactions(filters).data.rows).map((r) => r.item_name);
  assert.deepEqual(names({}), ['วันนี้', 'สลิปย้อนหลัง']);
  assert.deepEqual(names({ sort: 'DATE' }), ['วันนี้', 'สลิปย้อนหลัง']);
  assert.deepEqual(names({ sort: 'CREATED' }), ['สลิปย้อนหลัง', 'วันนี้']);
  assert.equal(ctx.api_listTransactions({ sort: 'AMOUNT' }).code, 'VALIDATION_ENUM');
  const row = plain(ctx.api_listTransactions({ sort: 'CREATED' }).data.rows)[0];
  assert.equal(row.created_at, '2026-11-28T09:30:00+07:00');
  assert.equal(row.source, 'MANUAL');
});

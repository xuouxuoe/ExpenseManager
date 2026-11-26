'use strict';
/** วัดจำนวนการเรียก Sheets API ต่อคำขอ (dev tool: node tests/perf-probe.js) */
const { createDbContext, countCalls, resetCalls } = require('./gas-shim');

const ctx = createDbContext();
let n = 0;
const key = () => `probe-key-${String(++n).padStart(4, '0')}`;
const actor = { actorId: 'owner@example.com' };
const M = ctx.MasterData;
const owner = M.create('owner', { owner_name: 'A' }, { idempotencyKey: key(), actor });
const acc = M.create('account', { account_name: 'Cash', account_type: 'CASH' }, { idempotencyKey: key(), actor });
const cat = M.create('category', { category_name: 'Food', category_type: 'EXPENSE' }, { idempotencyKey: key(), actor });
for (let i = 0; i < 20; i++) {
  ctx.Transactions.create({ transaction_date: '2026-11-25', transaction_type: 'EXPENSE', from_account_id: acc.account_id, category_id: cat.category_id,
    owner_id: owner.owner_id, item_name: 'x' + i, amount: 10 }, { idempotencyKey: key(), actor });
}

function measure(label, fn) {
  ctx.Database.resetExecutionCache && ctx.Database.resetExecutionCache();
  resetCalls(ctx.__ss);
  fn();
  const c = countCalls(ctx.__ss);
  console.log(label.padEnd(28), JSON.stringify(c));
  return c;
}

measure('createTransaction', () => ctx.api_createTransaction({ transaction_date: '2026-11-25', transaction_type: 'EXPENSE', from_account_id: acc.account_id,
  category_id: cat.category_id, owner_id: owner.owner_id, item_name: 'probe', amount: 11 }, key()));
measure('listTransactions', () => ctx.api_listTransactions({}));
measure('listMasters', () => ctx.api_listMasters({ includeInactive: true }));
measure('suggestions', () => ctx.api_transactionSuggestions({}));
measure('updateMaster(no rename)', () => ctx.api_updateMaster('owner', owner.owner_id, { owner_name: 'A' }, key()));
if (ctx.api_transactionPage) measure('transactionPage', () => ctx.api_transactionPage({}, { includeMasters: true }));

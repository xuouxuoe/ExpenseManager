'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `read-test-${String(++seq).padStart(6, '0')}`;
const newApiKey = () => 'emk_' + crypto.randomBytes(32).toString('base64url');
const USER = 'U' + 'b'.repeat(32);
const LINE_TOKEN = 'line-token-' + 'R'.repeat(40);

function setup() {
  const ctx = createDbContext();
  Object.assign(ctx.__props, { DB_TARGET: 'TEST', AI_API_KEY: 'sk-test-xxxxxxxxxxxx', AI_MODEL: 'test-model', LINE_CHANNEL_ACCESS_TOKEN: LINE_TOKEN });
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const ids = {
    dad: mk('owner', { owner_name: 'พ่อ' }),
    mom: mk('owner', { owner_name: 'แม่' }),
    bank: mk('account', { account_name: 'KBank', account_type: 'BANK', opening_balance: 10000 }),
    card: mk('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD' }),
    old: mk('account', { account_name: 'บัญชีเก่า', account_type: 'CASH' }),
    food: mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' }),
    travel: mk('category', { category_name: 'เดินทาง', category_type: 'EXPENSE' }),
    salary: mk('category', { category_name: 'เงินเดือน', category_type: 'INCOME' })
  };
  ctx.api_setMasterActive('account', ids.old.account_id, false, key());
  let n = 0;
  const tx = (date, type, amount, extra = {}) => {
    const input = type === 'INCOME'
      ? { transaction_type: 'INCOME', to_account_id: ids.bank.account_id, category_id: ids.salary.category_id }
      : type === 'CREDIT_PURCHASE'
        ? { transaction_type: 'CREDIT_PURCHASE', from_account_id: ids.card.account_id, category_id: ids.food.category_id }
        : { transaction_type: 'EXPENSE', from_account_id: ids.bank.account_id, category_id: ids.food.category_id };
    const res = ctx.api_createTransaction({ ...input, transaction_date: date, owner_id: ids.dad.owner_id, item_name: 'รายการ ' + (++n), amount, allow_duplicate: true, ...extra }, key());
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.data;
  };
  const apiKey = newApiKey();
  const created = ctx.api_createApiClient({ client_name: 'LINE', scopes: ['READ', 'WRITE'], api_key: apiKey, allowed_channel_user_ids: USER,
    default_account_id: ids.bank.account_id, default_owner_id: ids.dad.owner_id }, key());
  assert.equal(created.ok, true, JSON.stringify(created));
  const post = (action, params = {}, extra = {}) => plain(ctx.IntegrationApi.dispatch({ postData: { contents: JSON.stringify({ api_key: apiKey, action, params, ...extra }) } }));
  return { ctx, ids, tx, post, apiKey, clientId: created.data.client.client_id };
}

test('summary.month: ตัวเลขตรงกับ Dashboard ของเดือนเดียวกัน, หมวดสูงสุดเรียงมากไปน้อย, กรองเจ้าของได้', () => {
  const s = setup();
  s.tx('2026-10-31', 'EXPENSE', 999);
  s.tx('2026-11-01', 'INCOME', 30000);
  s.tx('2026-11-02', 'EXPENSE', 120);
  s.tx('2026-11-03', 'EXPENSE', 80.5, { category_id: s.ids.travel.category_id });
  s.tx('2026-11-04', 'CREDIT_PURCHASE', 1500);
  s.tx('2026-11-05', 'EXPENSE', 50, { owner_id: s.ids.mom.owner_id });
  const res = s.post('summary.month', { month: 202611 });
  assert.equal(res.ok, true, JSON.stringify(res));
  const dash = plain(s.ctx.api_dashboard({ month: 202611 }).data.summary);
  assert.equal(res.data.month, 202611);
  assert.equal(res.data.income, dash.income);
  assert.equal(res.data.expense, dash.expense);
  assert.equal(res.data.net, dash.net);
  assert.equal(res.data.income, 30000);
  assert.equal(res.data.expense, 1750.5);
  assert.deepEqual(res.data.plan, { scheduled: dash.scheduled, paid: dash.paid, outstanding: dash.outstanding, need_to_save: dash.needToSave, saved: dash.saved });
  assert.deepEqual(res.data.top_categories, [{ name: 'อาหาร', amount: 1670 }, { name: 'เดินทาง', amount: 80.5 }]);
  const mom = s.post('summary.month', { month: 202611, owner_id: s.ids.mom.owner_id });
  assert.equal(mom.data.expense, 50);
  assert.equal(mom.data.income, 0);
  assert.equal(s.post('summary.month', { month: 202613 }).code, 'VALIDATION_YEAR_MONTH_RANGE');
  const current = s.post('summary.month');
  assert.equal(current.ok, true);
  assert.equal(current.data.month, Number(s.ctx.Util.todayIso().slice(0, 7).replace('-', '')));
});

test('balances: ยอดรวมตรงกับ Dashboard, ใช้ได้จริง = สินทรัพย์ − กันไว้, หนี้แยก, ซ่อนบัญชีที่ปิดและไม่มียอด', () => {
  const s = setup();
  s.tx('2026-11-01', 'INCOME', 5000);
  s.tx('2026-11-02', 'EXPENSE', 300);
  s.tx('2026-11-04', 'CREDIT_PURCHASE', 1500);
  const res = s.post('balances');
  assert.equal(res.ok, true, JSON.stringify(res));
  const dash = plain(s.ctx.api_dashboard({}).data.accountTotals);
  assert.deepEqual(res.data.totals, dash);
  assert.deepEqual(res.data.totals, { assets: 14700, reserved: 0, available: 14700, liabilities: 1500 });
  const names = res.data.accounts.map((a) => a.name);
  assert.deepEqual(names, ['KBank', 'บัตร']);
  const card = res.data.accounts.find((a) => a.name === 'บัตร');
  assert.equal(card.is_asset, false);
  assert.equal(card.available, null);
  assert.equal(card.balance, 1500);
});

test('transactions.recent: ล่าสุดก่อน, จำกัดจำนวน 1–20, แสดงการกลับรายการ, ไม่มีข้อมูลภายใน', () => {
  const s = setup();
  s.tx('2026-11-01', 'EXPENSE', 10);
  const second = s.tx('2026-11-03', 'EXPENSE', 20);
  s.tx('2026-11-02', 'EXPENSE', 30);
  const rev = s.ctx.api_reverseTransaction(second.transaction_id, { reason: 'ผิด' }, key());
  assert.equal(rev.ok, true, JSON.stringify(rev));
  const res = s.post('transactions.recent', { limit: 3 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.transactions.length, 3);
  assert.equal(res.data.total, 4);
  const [a, b, c] = res.data.transactions;
  assert.ok(a.transaction_date >= b.transaction_date && b.transaction_date >= c.transaction_date);
  const original = res.data.transactions.find((t) => t.transaction_id === second.transaction_id);
  assert.equal(original.is_reversed, true);
  assert.ok(res.data.transactions.some((t) => t.reversal_of === second.transaction_id));
  Object.keys(a).forEach((k) => assert.ok(!['created_at', 'updated_at', 'note', 'external_ref', 'source'].includes(k), 'ไม่ควรมี ' + k));
  assert.equal(s.post('transactions.recent').data.transactions.length, 4);
  assert.equal(s.post('transactions.recent', { limit: 21 }).ok, false);
  assert.equal(s.post('transactions.recent', { limit: 0 }).ok, false);
});

test('budget.remaining: ค่าเดียวกับหน้างบ และรวมทุกงบของเดือน; เดือนที่ไม่มีงบคืนรายการว่าง', () => {
  const s = setup();
  const save = (name, amount, cats) => {
    const res = s.ctx.api_saveBudget({ budget_month: 202611, budget_name: name, amount, category_ids: cats }, key());
    assert.equal(res.ok, true, JSON.stringify(res));
  };
  save('กิน', 3000, [s.ids.food.category_id]);
  save('เดินทาง', 1000, [s.ids.travel.category_id]);
  s.tx('2026-11-02', 'EXPENSE', 250);
  s.tx('2026-11-03', 'EXPENSE', 100, { category_id: s.ids.travel.category_id });
  const res = s.post('budget.remaining', { month: 202611 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.data.totals, { amount: 4000, spent: 350, remaining: 3650 });
  const page = plain(s.ctx.api_budgetPage(202611).data.budgets);
  res.data.budgets.forEach((b) => {
    const p = page.find((x) => x.budget_id === b.budget_id);
    assert.equal(b.remaining, p.remaining);
    assert.equal(b.spent, p.spent);
  });
  const empty = s.post('budget.remaining', { month: 202501 });
  assert.deepEqual(empty.data, { month: 202501, totals: { amount: 0, spent: 0, remaining: 0 }, budgets: [] });
});

test('action อ่านข้อมูลต้องมีสิทธิ์ READ และไม่เขียนชีตใด', () => {
  const s = setup();
  s.tx('2026-11-02', 'EXPENSE', 250);
  const writeOnly = newApiKey();
  assert.equal(s.ctx.api_createApiClient({ client_name: 'W', scopes: ['WRITE'], api_key: writeOnly }, key()).ok, true);
  const call = (action) => plain(s.ctx.IntegrationApi.dispatch({ postData: { contents: JSON.stringify({ api_key: writeOnly, action }) } }));
  ['summary.month', 'balances', 'transactions.recent', 'budget.remaining', 'debts'].forEach((a) => assert.equal(call(a).code, 'FORBIDDEN_SCOPE', a));
  const before = JSON.stringify(s.ctx.__ss.sheets.map((sh) => sh.data));
  ['summary.month', 'balances', 'transactions.recent', 'budget.remaining', 'debts'].forEach((a) => assert.equal(s.post(a).ok, true, a));
  assert.equal(JSON.stringify(s.ctx.__ss.sheets.map((sh) => sh.data)), before);
});

test('ข้อความสำหรับแชต: จัดรูปเงินมีจุลภาค 2 ตำแหน่ง และเดือนเป็น พ.ศ.', () => {
  const s = setup();
  assert.equal(s.ctx.ApiReads.money(1234567.5), '1,234,567.50');
  assert.equal(s.ctx.ApiReads.money(-80), '-80.00');
  s.tx('2026-11-01', 'INCOME', 30000);
  s.tx('2026-11-02', 'EXPENSE', 1234.5);
  const text = s.ctx.ApiReads.formatSummary(s.ctx.ApiReads.summaryMonth({ month: 202611 }));
  assert.match(text, /^สรุป พ\.ย\. 2569/);
  assert.match(text, /รายรับ 30,000\.00/);
  assert.match(text, /• อาหาร 1,234\.50/);
  assert.equal(s.ctx.ApiReads.formatBudgets(s.ctx.ApiReads.budgetRemaining({ month: 202501 })), 'ยังไม่มีงบใช้จ่ายของ ม.ค. 2568');
});

test('LINE: คำสั่ง สรุป / ยอดเงิน / ล่าสุด / งบ ตอบข้อมูลโดยไม่เรียก AI และไม่สร้างร่าง; ไม่มีสิทธิ์ READ ถูกปฏิเสธ', () => {
  const s = setup();
  s.tx('2026-11-02', 'EXPENSE', 250);
  let aiCalls = 0;
  const replies = [];
  s.ctx.__state.fetch = (url, options) => {
    if (url === 'https://api.line.me/v2/bot/message/reply') { replies.push(JSON.parse(options.payload)); return { code: 200, body: {} }; }
    aiCalls += 1;
    return { code: 500, body: {} };
  };
  let n = 0;
  const send = (text, lineKey = s.apiKey) => plain(s.ctx.LineWebhook.handle({ parameter: { line_key: lineKey }, postData: { contents: JSON.stringify({ events: [
    { type: 'message', webhookEventId: '01HZZZREAD' + String(++n).padStart(16, '0'), replyToken: 'rt-' + n, source: { type: 'user', userId: USER }, message: { type: 'text', id: 'm' + n, text } }
  ] }) } }));
  const last = () => replies[replies.length - 1].messages[0].text;
  assert.deepEqual(send('สรุป').results, ['summary']);
  assert.equal(last(), s.ctx.ApiReads.formatSummary(s.ctx.ApiReads.summaryMonth({})));
  assert.deepEqual(send(' ยอดเงิน ').results, ['balances']);
  assert.match(last(), /ใช้ได้จริง 9,750\.00/);
  assert.deepEqual(send('รายการ ล่าสุด').results, ['recent']);
  assert.match(last(), /รายจ่าย 250\.00 รายการ 1/);
  assert.deepEqual(send('BUDGET').results, ['budget']);
  assert.deepEqual(send('วิธีใช้').results, ['help']);
  assert.match(last(), /ยอดเงิน — ยอดบัญชี/);
  assert.equal(aiCalls, 0);
  assert.equal(s.ctx.Database.readAll('ApiDrafts').rows.length, 0);

  const writeOnly = newApiKey();
  assert.equal(s.ctx.api_createApiClient({ client_name: 'LINE W', scopes: ['WRITE'], api_key: writeOnly, allowed_channel_user_ids: USER }, key()).ok, true);
  assert.deepEqual(send('ยอดเงิน', writeOnly).results, ['error:FORBIDDEN_SCOPE']);
  assert.match(last(), /ไม่มีสิทธิ์ดูข้อมูล/);
  assert.doesNotMatch(last(), /9,750/);
});

test('คำสั่ง หนี้: ยอดหนี้บัตรหลังชำระบางส่วน, วงเงินคงเหลือ, วันครบกำหนด และสินเชื่อแยก', () => {
  const s = setup();
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(s.ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const ktc = mk('account', { account_name: 'KTC', account_type: 'CREDIT_CARD', credit_limit: 50000, due_day: 25 });
  const loan = mk('account', { account_name: 'กู้บ้าน', account_type: 'LOAN' });
  s.tx('2026-11-04', 'CREDIT_PURCHASE', 1500);
  s.tx('2026-11-05', 'CREDIT_PURCHASE', 12000.5, { from_account_id: ktc.account_id });
  const pay = s.ctx.api_createTransaction({ transaction_type: 'CREDIT_PAYMENT', from_account_id: s.ids.bank.account_id, to_account_id: ktc.account_id,
    transaction_date: '2026-11-20', item_name: 'จ่ายบัตร', amount: 2000, owner_id: s.ids.dad.owner_id, allow_duplicate: true }, key());
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const adv = s.ctx.api_createTransaction({ transaction_type: 'CASH_ADVANCE', from_account_id: loan.account_id, to_account_id: s.ids.bank.account_id,
    transaction_date: '2026-11-21', item_name: 'กู้', amount: 100000, owner_id: s.ids.dad.owner_id, allow_duplicate: true }, key());
  assert.equal(adv.ok, true, JSON.stringify(adv));

  const d = plain(s.ctx.ApiReads.debts());
  assert.deepEqual(d.totals, { cards: 11500.5, loans: 100000, due_this_month: 0, overdue: 0 });
  assert.deepEqual(d.cards.map((c) => [c.name, c.balance, c.available_credit, c.due_day]), [['KTC', 10000.5, 39999.5, 25], ['บัตร', 1500, null, null]]);
  const text = s.ctx.ApiReads.formatDebts(s.ctx.ApiReads.debts());
  assert.match(text, /^หนี้บัตร 11,500\.50/);
  assert.match(text, /• KTC 10,000\.50 \(วงเงินเหลือ 39,999\.50, ครบกำหนดวันที่ 25\)/);
  assert.match(text, /สินเชื่อ 100,000\.00\n• กู้บ้าน 100,000\.00/);

  const api = s.post('debts');
  assert.equal(api.ok, true, JSON.stringify(api));
  assert.deepEqual(api.data, d, 'action debts คืนข้อมูลเดียวกับคำสั่งแชต');

  const cmd = s.ctx.ChatCommands.find('หนี้');
  assert.equal(cmd.result, 'debts');
  assert.equal(s.ctx.ChatCommands.run(cmd, { scopes: ['READ'] }), text);
});

test('คำสั่ง หนี้: ยอดต้องจ่ายเดือนนี้ตามแผนชำระ แยกงวดค้างจากเดือนก่อน ไม่นับงวดอนาคต', () => {
  const s = setup();
  const actor = { actorId: 'owner@example.com' };
  const ktc = plain(s.ctx.MasterData.create('account', { account_name: 'KTC', account_type: 'CREDIT_CARD' }, { idempotencyKey: key(), actor }));
  const today = s.ctx.Util.todayIso();
  const thisMonth = Number(today.slice(0, 4) + today.slice(5, 7));
  const prev = thisMonth % 100 === 1 ? thisMonth - 89 : thisMonth - 1;
  const plan = s.ctx.api_createPaymentPlan({ item_name: 'ทีวี', purchase_date: today, plan_type: 'INSTALLMENT', owner_id: s.ids.dad.owner_id,
    account_id: ktc.account_id, category_id: s.ids.food.category_id, principal_amount: '900', interest_amount: '0', fee_amount: '0',
    installment_count: 3, first_saving_month: prev, first_payment_month: prev }, key());
  assert.equal(plan.ok, true, JSON.stringify(plan));

  const d = plain(s.ctx.ApiReads.debts());
  const card = d.cards.find((c) => c.account_id === ktc.account_id);
  assert.equal(d.month, thisMonth);
  assert.equal(card.due_this_month, 300);
  assert.equal(card.overdue, 300);
  assert.equal(d.totals.due_this_month, 300);
  assert.equal(d.totals.overdue, 300);
  const text = s.ctx.ApiReads.formatDebts(s.ctx.ApiReads.debts());
  assert.match(text, /\nต้องจ่าย .+ 300\.00 \+ ค้างจากเดือนก่อน 300\.00\n/);
  assert.match(text, /• KTC [\d,.]+.*\n {3}ต้องจ่ายเดือนนี้ 300\.00 · ค้าง 300\.00/);
});

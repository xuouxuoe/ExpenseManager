'use strict';
// งบทริป ระยะ E2: เลือกงบผ่าน Integration API / AI / LINE (docs/event-budget-plan.md)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `e2-test-${String(++seq).padStart(6, '0')}`;
const newApiKey = () => 'emk_' + crypto.randomBytes(32).toString('base64url');
const USER = 'U' + 'c'.repeat(32);
const LINE_TOKEN = 'line-token-' + 'E'.repeat(40);

function setup() {
  const ctx = createDbContext();
  Object.assign(ctx.__props, { DB_TARGET: 'TEST', AI_API_KEY: 'sk-test-xxxxxxxxxxxx', AI_MODEL: 'test-model', LINE_CHANNEL_ACCESS_TOKEN: LINE_TOKEN });
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const ids = {
    dad: mk('owner', { owner_name: 'พ่อ' }),
    mom: mk('owner', { owner_name: 'แม่' }),
    kbank: mk('account', { account_name: 'KBank', account_type: 'BANK', opening_balance: 10000 }),
    card: mk('account', { account_name: 'บัตร KTC', account_type: 'CREDIT_CARD' }),
    food: mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' }),
    salary: mk('category', { category_name: 'เงินเดือน', category_type: 'INCOME' })
  };
  const today = ctx.Util.todayIso();
  const event = (input) => {
    const res = plain(ctx.api_saveEventBudget({ amount: 20000, start_date: today, end_date: today, ...input }, key(), 202612));
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.data.result.budget_id;
  };
  const japan = event({ budget_name: 'เที่ยวญี่ปุ่น' });
  const momTrip = event({ budget_name: 'ทริปแม่', owner_id: ids.mom.owner_id });
  const apiKey = newApiKey();
  assert.equal(ctx.api_createApiClient({ client_name: 'LINE', scopes: ['READ', 'WRITE'], api_key: apiKey, allowed_channel_user_ids: USER,
    default_account_id: ids.kbank.account_id, default_owner_id: ids.dad.owner_id }, key()).ok, true);
  const post = (action, params, extra = {}) => plain(ctx.IntegrationApi.dispatch({ postData: { contents: JSON.stringify({ api_key: apiKey, action, channel_user_id: USER, params, ...extra }) } }));
  const draft = (params) => post('draft.create', { transaction_type: 'EXPENSE', amount: 350, category: 'อาหาร', item_name: 'ราเมน', ...params }, { request_id: key() });
  const rows = (sheet) => plain(ctx.Database.readAll(sheet).rows);
  return { ctx, ids, japan, momTrip, apiKey, post, draft, rows };
}

test('masters.list มีงบทริปที่เปิดใช้ (ID ชื่อ ช่วงวันที่ เจ้าของ) โดยไม่มียอดเงิน', () => {
  const s = setup();
  const res = s.post('masters.list', {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.data.budgets.map((b) => b.budget_name).sort(), ['ทริปแม่', 'เที่ยวญี่ปุ่น'].sort());
  assert.deepEqual(Object.keys(res.data.budgets[0]).sort(), ['budget_id', 'budget_name', 'end_date', 'owner_id', 'start_date']);
});

test('draft.create รับงบเป็นชื่อหรือ ID → สรุปแสดงงบ → ยืนยันแล้วรายการผูกงบและนับในงบทริป', () => {
  const s = setup();
  const res = s.draft({ budget: 'เที่ยวญี่ปุ่น' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.transaction.budget_id, s.japan);
  assert.equal(res.data.transaction.budget_name, 'เที่ยวญี่ปุ่น');
  assert.match(res.data.summary_text, /ใช้จากงบ เที่ยวญี่ปุ่น/);
  const confirmed = s.post('draft.confirm', { draft_id: res.data.draft_id, confirm_token: res.data.confirm_token });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const tx = s.rows('Transactions')[0];
  assert.equal(tx.budget_id, s.japan);
  assert.equal(tx.budget_name, 'เที่ยวญี่ปุ่น');
  assert.equal(tx.source, 'AI');
  const ev = plain(s.ctx.Budgets.listEvents({})).find((b) => b.budget_id === s.japan);
  assert.equal(ev.spent, 350);
  const byId = s.draft({ budget: s.japan, item_name: 'ซูชิ' });
  assert.equal(byId.data.transaction.budget_id, s.japan);
  const none = s.draft({ item_name: 'ข้าว' });
  assert.equal(none.data.transaction.budget_id, '');
  assert.doesNotMatch(none.data.summary_text, /ใช้จากงบ/);
});

test('งบที่ระบุเจ้าของ: ไม่ระบุ owner ใช้เจ้าของของงบ; ระบุ owner คนอื่นถูกปฏิเสธ', () => {
  const s = setup();
  const res = s.draft({ budget: 'ทริปแม่' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.transaction.owner_id, s.ids.mom.owner_id, 'ไม่ใช้เจ้าของเริ่มต้นของการเชื่อมต่อ (พ่อ)');
  const bad = s.draft({ budget: 'ทริปแม่', owner: 'พ่อ' });
  assert.equal(bad.code, 'VALIDATION_RULE');
});

test('งบไม่พบ/ประเภทที่ใช้งบไม่ได้/งบปิดแล้ว → ปฏิเสธ ไม่สร้างร่าง; ยืนยันหลังงบถูกปิด → ร่าง FAILED', () => {
  const s = setup();
  const missing = s.draft({ budget: 'เกาหลี' });
  assert.equal(missing.code, 'VALIDATION_NOT_FOUND');
  assert.ok(missing.details.candidates.some((c) => c.name === 'เที่ยวญี่ปุ่น'));
  const income = s.post('draft.create', { transaction_type: 'INCOME', amount: 100, category: 'เงินเดือน', item_name: 'โบนัส', budget: 'เที่ยวญี่ปุ่น' }, { request_id: key() });
  assert.equal(income.code, 'VALIDATION_RULE');
  assert.equal(s.rows('ApiDrafts').length, 0);
  const d = s.draft({ budget: 'เที่ยวญี่ปุ่น' }).data;
  assert.equal(plain(s.ctx.api_setBudgetActive(s.japan, false, key(), 202612)).ok, true);
  assert.equal(s.post('draft.confirm', { draft_id: d.draft_id, confirm_token: d.confirm_token }).code, 'VALIDATION_FK_INACTIVE');
  assert.equal(s.rows('ApiDrafts')[0].draft_status, 'FAILED');
  assert.equal(s.rows('Transactions').length, 0);
  assert.equal(s.draft({ budget: 'เที่ยวญี่ปุ่น' }).code, 'VALIDATION_NOT_FOUND', 'งบที่ปิดแล้วเลือกใหม่ไม่ได้');
});

test('AI: prompt มีรายการงบทริปและ schema มีฟิลด์ budget; ผลจาก AI ส่งต่อเป็น params.budget', () => {
  const s = setup();
  const requests = [];
  s.ctx.__state.fetch = (url, options) => {
    requests.push(JSON.parse(options.payload));
    return { code: 200, body: { choices: [{ message: { content: JSON.stringify({ intent: 'TRANSACTION', transaction_type: 'EXPENSE', transaction_date: null, amount: 350,
      from_account: null, to_account: null, category: s.ids.food.category_id, owner: null, item_name: 'ราเมน', description: null, note: null, budget: s.japan, message: null }) } }] } };
  };
  const res = s.post('ai.parse', { text: 'ราเมน 350 งบญี่ปุ่น' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.params.budget, s.japan);
  const body = requests[0];
  const system = body.messages[0].content;
  assert.match(system, /Trip budgets \(budget_id \| name/);
  assert.match(system, new RegExp(s.japan + ' \\| เที่ยวญี่ปุ่น'));
  assert.doesNotMatch(system, /20000/, 'ไม่ส่งยอดงบให้ AI');
  const schema = body.response_format.json_schema.schema;
  assert.ok(schema.required.includes('budget'));
  const d = s.post('draft.create', res.data.params, { request_id: key() });
  assert.equal(d.data.transaction.budget_id, s.japan);
});

test('LINE: ข้อความระบุงบ → ร่างใน Flex แสดง "ใช้จากงบ" → กดยืนยันบันทึกพร้อมงบ', () => {
  const s = setup();
  const replies = [];
  s.ctx.__state.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    if (url === 'https://api.line.me/v2/bot/message/reply') { replies.push(body); return { code: 200, body: {} }; }
    return { code: 200, body: { choices: [{ message: { content: JSON.stringify({ intent: 'TRANSACTION', transaction_type: 'CREDIT_PURCHASE', transaction_date: null, amount: 1200,
      from_account: s.ids.card.account_id, to_account: null, category: s.ids.food.category_id, owner: null, item_name: 'ร้านยากินิกุ', description: null, note: null, budget: s.japan, message: null }) } }] } };
  };
  const send = (ev) => plain(s.ctx.LineWebhook.handle({ parameter: { line_key: s.apiKey }, postData: { contents: JSON.stringify({ events: [ev] }) } }));
  const r1 = send({ type: 'message', webhookEventId: '01HZZZE2TEST000000000000001', replyToken: 'rt-1', source: { type: 'user', userId: USER }, message: { type: 'text', id: 'm1', text: 'ยากินิกุ 1200 บัตร งบญี่ปุ่น' } });
  assert.deepEqual(r1.results, ['draft']);
  const flex = replies[0].messages[0];
  assert.match(flex.contents.body.contents[1].text, /ใช้จากงบ เที่ยวญี่ปุ่น/);
  const confirm = flex.contents.footer.contents[1].action.data;
  const r2 = send({ type: 'postback', webhookEventId: '01HZZZE2TEST000000000000002', replyToken: 'rt-2', source: { type: 'user', userId: USER }, postback: { data: confirm } });
  assert.deepEqual(r2.results, ['confirmed']);
  const tx = s.rows('Transactions')[0];
  assert.equal(tx.transaction_type, 'CREDIT_PURCHASE');
  assert.equal(tx.budget_id, s.japan);
});

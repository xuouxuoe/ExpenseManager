'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `draft-test-${String(++seq).padStart(6, '0')}`;
const newApiKey = () => 'emk_' + crypto.randomBytes(32).toString('base64url');
const LINE_USER = 'U' + 'a'.repeat(32);
const OTHER_USER = 'U' + 'b'.repeat(32);

function setup(clientInput = {}) {
  const ctx = createDbContext();
  ctx.__props.DB_TARGET = 'TEST';
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const dad = mk('owner', { owner_name: 'พ่อ' });
  const mom = mk('owner', { owner_name: 'แม่' });
  const kbank = mk('account', { account_name: 'KBank', account_type: 'BANK' });
  const cash = mk('account', { account_name: 'เงินสด', account_type: 'CASH' });
  const card = mk('account', { account_name: 'บัตร KTC', account_type: 'CREDIT_CARD' });
  const food = mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' });
  const salary = mk('category', { category_name: 'เงินเดือน', category_type: 'INCOME' });
  const post = (body) => plain(ctx.IntegrationApi.dispatch({ postData: { contents: JSON.stringify(body) } }));
  const createClient = (input = {}) => {
    const apiKey = newApiKey();
    const res = ctx.api_createApiClient({ client_name: 'LINE', scopes: ['READ', 'WRITE'], api_key: apiKey, ...input }, key());
    assert.equal(res.ok, true, JSON.stringify(res));
    return { apiKey, client: plain(res.data.client) };
  };
  const main = createClient({ allowed_channel_user_ids: LINE_USER, default_account_id: kbank.account_id, default_owner_id: dad.owner_id, ...clientInput });
  const call = (action, params, extra = {}) => post({ api_key: main.apiKey, action, channel_user_id: LINE_USER, params, ...extra });
  const draft = (params, requestId = key()) => call('draft.create', params, { request_id: requestId });
  const rows = (sheet) => plain(ctx.Database.readAll(sheet).rows);
  return { ctx, actor, mk, dad, mom, kbank, cash, card, food, salary, post, createClient, main, call, draft, rows };
}

const coffee = { transaction_type: 'EXPENSE', transaction_date: '2026-11-27', amount: 65, category: 'อาหาร', item_name: 'กาแฟ', source_text: 'กาแฟ 65' };

test('masters.list: คืนเฉพาะข้อมูลหลักที่ใช้งานอยู่และค่าเริ่มต้นของการเชื่อมต่อ; ต้องมีสิทธิ์ READ', () => {
  const s = setup();
  s.ctx.MasterData.setActive('owner', s.mom.owner_id, false, { idempotencyKey: key(), actor: s.actor });
  const res = s.call('masters.list', {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.data.owners.map((o) => o.owner_name), ['พ่อ']);
  assert.deepEqual(res.data.accounts.map((a) => a.account_name), ['KBank', 'เงินสด', 'บัตร KTC']);
  assert.deepEqual(Object.keys(res.data.accounts[0]).sort(), ['account_id', 'account_name', 'account_type']);
  assert.deepEqual(res.data.defaults, { account_id: s.kbank.account_id, owner_id: s.dad.owner_id });
  const writeOnly = s.createClient({ scopes: ['WRITE'] });
  assert.equal(s.post({ api_key: writeOnly.apiKey, action: 'masters.list' }).code, 'FORBIDDEN_SCOPE');
});

test('draft.create: แปลงชื่อเป็น ID ใช้ค่าเริ่มต้น เก็บร่าง PENDING ยังไม่บันทึกธุรกรรม และไม่เก็บ token/ข้อความดิบ', () => {
  const s = setup();
  const res = s.draft(coffee);
  assert.equal(res.ok, true, JSON.stringify(res));
  const d = res.data;
  assert.equal(d.draft_status, 'PENDING');
  assert.match(d.confirm_token, /^[a-f0-9]{32}$/);
  assert.equal(d.transaction.from_account_id, s.kbank.account_id);
  assert.equal(d.transaction.from_account_name, 'KBank');
  assert.equal(d.transaction.category_id, s.food.category_id);
  assert.equal(d.transaction.owner_name, 'พ่อ');
  assert.equal(d.transaction.amount, 65);
  assert.match(d.summary_text, /รายจ่าย 65\.00 บาท — กาแฟ/);
  assert.equal(s.rows('Transactions').length, 0);
  const row = s.rows('ApiDrafts')[0];
  assert.equal(row.channel_user_id, LINE_USER);
  assert.equal(row.draft_json.includes('กาแฟ 65'), false, 'ไม่เก็บ source_text');
  assert.deepEqual(Object.keys(JSON.parse(row.draft_json)).filter((k) => /_name$/.test(k) && k !== 'item_name'), [], 'draft_json เก็บเฉพาะ ID');
  const everything = JSON.stringify(s.ctx.__ss.sheets.map((x) => x.data)) + JSON.stringify(s.ctx.__state.logs);
  assert.equal(everything.includes(d.confirm_token), false, 'ไม่มี confirm_token จริงในชีตหรือ log');
});

test('draft.create: ระบุ ID หรือชื่อบัญชีได้, ชื่อไม่สนตัวพิมพ์, วันที่ว่างใช้วันนี้, รายรับใช้บัญชีเริ่มต้นเป็นบัญชีปลายทาง', () => {
  const s = setup();
  const a = s.draft({ ...coffee, from_account: s.cash.account_id }).data.transaction;
  assert.equal(a.from_account_id, s.cash.account_id);
  const b = s.draft({ ...coffee, from_account: '  kbank ', item_name: 'ข้าว' }).data.transaction;
  assert.equal(b.from_account_id, s.kbank.account_id);
  const income = s.draft({ transaction_type: 'INCOME', amount: '30000', category: 'เงินเดือน', item_name: 'เงินเดือน', transaction_date: '' });
  assert.equal(income.ok, true, JSON.stringify(income));
  assert.equal(income.data.transaction.to_account_id, s.kbank.account_id);
  assert.equal(income.data.transaction.category_id, s.salary.category_id);
  assert.match(income.data.transaction.transaction_date, /^\d{4}-\d{2}-\d{2}$/);
  const purchase = s.draft({ transaction_type: 'CREDIT_PURCHASE', amount: 1200, from_account: 'บัตร KTC', category: 'อาหาร', item_name: 'ร้านอาหาร' });
  assert.equal(purchase.data.transaction.from_account_id, s.card.account_id);
});

test('draft.create: ข้อมูลผิดถูกปฏิเสธโดยไม่สร้างร่าง', () => {
  const s = setup();
  const code = (params) => s.draft(params).code;
  assert.equal(code({ ...coffee, category_name: 'อาหาร' }), 'VALIDATION_UNKNOWN_FIELD');
  assert.equal(code({ ...coffee, source: 'MANUAL' }), 'VALIDATION_UNKNOWN_FIELD');
  assert.equal(code({ ...coffee, transaction_type: 'ADJUSTMENT' }), 'VALIDATION_ENUM');
  assert.equal(code({ ...coffee, amount: -5 }).indexOf('VALIDATION_'), 0);
  assert.equal(code({ ...coffee, amount: 'abc' }).indexOf('VALIDATION_'), 0);
  assert.equal(code({ ...coffee, transaction_date: '2026-13-01' }).indexOf('VALIDATION_'), 0);
  assert.equal(code({ ...coffee, item_name: '' }), 'VALIDATION_REQUIRED');
  assert.equal(code({ ...coffee, category: 'เงินเดือน' }), 'VALIDATION_NOT_FOUND', 'หมวดรายรับใช้กับรายจ่ายไม่ได้');
  const notFound = s.draft({ ...coffee, from_account: 'SCB' });
  assert.equal(notFound.code, 'VALIDATION_NOT_FOUND');
  assert.ok(notFound.details.candidates.some((c) => c.name === 'KBank'));
  assert.equal(code({ ...coffee, from_account: 'บัตร KTC' }), 'VALIDATION_RULE', 'รายจ่ายต้องใช้บัญชีสินทรัพย์');
  // ระบบปกติไม่ให้ชื่อซ้ำ: จำลองข้อมูลเดิมที่ชื่อซ้ำกันเพื่อทดสอบการปฏิเสธชื่อกำกวม
  const now = '2026-11-27T00:00:00+07:00';
  s.ctx.Database.appendRows('Accounts', [{ account_id: '90', account_name: 'kbank', account_type: 'E_WALLET', is_active: true, opening_balance: 0, created_at: now, updated_at: now }]);
  const ambiguous = s.draft({ ...coffee, from_account: 'KBANK' });
  assert.equal(ambiguous.code, 'VALIDATION_AMBIGUOUS');
  assert.equal(ambiguous.details.candidates.length, 2);
  assert.equal(s.post({ api_key: s.main.apiKey, action: 'draft.create', channel_user_id: LINE_USER, params: coffee }).code, 'INVALID_REQUEST_ID');
  assert.equal(s.post({ api_key: s.main.apiKey, action: 'draft.create', request_id: key(), params: coffee }).code, 'FORBIDDEN_CHANNEL');
  assert.equal(s.rows('ApiDrafts').length, 0);
});

test('draft.create: retry ด้วย request_id เดิมได้ร่างและ token เดิม; payload ต่างถูกปฏิเสธ', () => {
  const s = setup();
  const id = key();
  const first = s.draft(coffee, id).data;
  const again = s.draft(coffee, id).data;
  assert.equal(again.draft_id, first.draft_id);
  assert.equal(again.confirm_token, first.confirm_token);
  assert.equal(s.draft({ ...coffee, amount: 70 }, id).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(s.rows('ApiDrafts').length, 1);
});

test('draft.confirm: บันทึกธุรกรรม source AI ครั้งเดียว ยืนยันซ้ำได้ผลเดิม และเก็บข้อความสูตรเป็นข้อความ', () => {
  const s = setup();
  const d = s.draft({ ...coffee, item_name: '=SUM(A1:A2)', description: 'ร้านหน้าบ้าน' }).data;
  const ok = s.call('draft.confirm', { draft_id: d.draft_id, confirm_token: d.confirm_token });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.data.draft_status, 'CONFIRMED');
  assert.ok(ok.data.transaction_id);
  assert.match(ok.data.summary_text, /^บันทึกแล้ว/);
  const again = s.call('draft.confirm', { draft_id: d.draft_id, confirm_token: d.confirm_token });
  assert.equal(again.data.transaction_id, ok.data.transaction_id);
  const txs = s.rows('Transactions');
  assert.equal(txs.length, 1);
  assert.equal(txs[0].source, 'AI');
  assert.equal(txs[0].item_name, '=SUM(A1:A2)');
  assert.equal(txs[0].from_account_name, 'KBank');
  assert.equal(txs[0].owner_id, s.dad.owner_id);
  const raw = s.ctx.__ss.sheets.find((x) => x.name === 'Transactions').data.find((r) => r.includes("'=SUM(A1:A2)"));
  assert.ok(raw, 'เก็บเป็นข้อความที่ขึ้นต้นด้วย apostrophe');
  assert.equal(s.call('draft.cancel', { draft_id: d.draft_id, confirm_token: d.confirm_token }).code, 'DRAFT_NOT_PENDING');
});

test('draft.confirm/cancel: token ผิด, การเชื่อมต่ออื่น, LINE userId อื่น → ปฏิเสธโดยไม่บันทึก', () => {
  const s = setup();
  const d = s.draft(coffee).data;
  assert.equal(s.call('draft.confirm', { draft_id: d.draft_id, confirm_token: '0'.repeat(32) }).code, 'INVALID_CONFIRM_TOKEN');
  assert.equal(s.call('draft.confirm', { draft_id: d.draft_id }).code, 'INVALID_CONFIRM_TOKEN');
  assert.equal(s.call('draft.confirm', { draft_id: '999', confirm_token: d.confirm_token }).code, 'DRAFT_NOT_FOUND');
  const other = s.createClient();
  assert.equal(s.post({ api_key: other.apiKey, action: 'draft.confirm', params: { draft_id: d.draft_id, confirm_token: d.confirm_token } }).code, 'DRAFT_NOT_FOUND');
  const multi = setup({ allowed_channel_user_ids: `${LINE_USER},${OTHER_USER}` });
  const d2 = multi.draft(coffee).data;
  const asOther = multi.post({ api_key: multi.main.apiKey, action: 'draft.confirm', channel_user_id: OTHER_USER, params: { draft_id: d2.draft_id, confirm_token: d2.confirm_token } });
  assert.equal(asOther.code, 'DRAFT_NOT_FOUND');
  const readOnly = s.createClient({ scopes: ['READ'] });
  assert.equal(s.post({ api_key: readOnly.apiKey, action: 'draft.confirm', params: { draft_id: d.draft_id, confirm_token: d.confirm_token } }).code, 'FORBIDDEN_SCOPE');
  assert.equal(s.rows('Transactions').length, 0);
  assert.equal(s.rows('ApiDrafts')[0].draft_status, 'PENDING');
});

test('draft.cancel: ยกเลิกแล้วยืนยันไม่ได้ ยกเลิกซ้ำได้ผลเดิม', () => {
  const s = setup();
  const d = s.draft(coffee).data;
  const c = s.call('draft.cancel', { draft_id: d.draft_id, confirm_token: d.confirm_token });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.data.draft_status, 'CANCELLED');
  assert.equal(s.call('draft.cancel', { draft_id: d.draft_id, confirm_token: d.confirm_token }).data.draft_status, 'CANCELLED');
  const confirm = s.call('draft.confirm', { draft_id: d.draft_id, confirm_token: d.confirm_token });
  assert.equal(confirm.code, 'DRAFT_NOT_PENDING');
  assert.equal(s.rows('Transactions').length, 0);
});

test('ร่างหมดอายุ → EXPIRED ยืนยันไม่ได้; Master ถูกปิดหลังสร้างร่าง → FAILED', () => {
  const s = setup();
  const d = s.draft(coffee).data;
  const found = s.ctx.Database.readAll('ApiDrafts');
  const row = Object.assign({}, found.rows[0], { expires_at: '2020-01-01T00:00:00+07:00' });
  s.ctx.Database.writeRowAt('ApiDrafts', found.rowNumbers[0], row);
  assert.equal(s.call('draft.confirm', { draft_id: d.draft_id, confirm_token: d.confirm_token }).code, 'DRAFT_EXPIRED');
  assert.equal(s.rows('ApiDrafts')[0].draft_status, 'EXPIRED');
  assert.equal(s.call('draft.confirm', { draft_id: d.draft_id, confirm_token: d.confirm_token }).code, 'DRAFT_NOT_PENDING');

  const d2 = s.draft({ ...coffee, item_name: 'ข้าว' }).data;
  s.ctx.MasterData.setActive('category', s.food.category_id, false, { idempotencyKey: key(), actor: s.actor });
  const res = s.call('draft.confirm', { draft_id: d2.draft_id, confirm_token: d2.confirm_token });
  assert.equal(res.code, 'VALIDATION_FK_INACTIVE');
  const failed = s.rows('ApiDrafts').find((r) => r.draft_id === d2.draft_id);
  assert.equal(failed.draft_status, 'FAILED');
  assert.equal(failed.error_code, 'VALIDATION_FK_INACTIVE');
  assert.equal(s.rows('Transactions').length, 0);
});

test('ร่างที่อาจซ้ำกับรายการเดิม: แจ้งเตือนในร่าง และยืนยันบันทึกได้', () => {
  const s = setup();
  const first = s.draft(coffee).data;
  s.call('draft.confirm', { draft_id: first.draft_id, confirm_token: first.confirm_token });
  const second = s.draft(coffee).data;
  assert.equal(second.possible_duplicates.length, 1);
  assert.match(second.summary_text, /อาจซ้ำ 1 รายการ/);
  const ok = s.call('draft.confirm', { draft_id: second.draft_id, confirm_token: second.confirm_token });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(s.rows('Transactions').length, 2);
});

// ล้มเหลวที่การเขียนแต่ละครั้งระหว่างยืนยัน (ก่อนเขียน / เขียนแล้วแต่คำตอบหาย) แล้วผู้เรียกส่งซ้ำ
function injectOutage(ctx, failAt, timing) {
  let count = 0;
  const restores = ctx.__ss.getSheets().map((sheet) => {
    const original = sheet.getRange;
    sheet.getRange = function (...args) {
      const range = original.apply(this, args);
      const set = range.setValues;
      range.setValues = function (values) {
        count += 1;
        const fail = count === failAt;
        if (fail && timing === 'before') throw new Error('Injected outage before ' + sheet.name);
        const result = set.call(this, values);
        if (fail) throw new Error('Injected lost reply after ' + sheet.name);
        return result;
      };
      return range;
    };
    return () => { sheet.getRange = original; };
  });
  return { count: () => count, stop: () => restores.forEach((r) => r()) };
}

test('draft.confirm: ระบบล้มกลางทางทุกจุดแล้วส่งซ้ำ → ธุรกรรมเดียวและร่าง CONFIRMED', () => {
  const probe = setup();
  const pd = probe.draft(coffee).data;
  const counter = injectOutage(probe.ctx, Infinity, 'before');
  probe.call('draft.confirm', { draft_id: pd.draft_id, confirm_token: pd.confirm_token });
  counter.stop();
  const total = counter.count();
  assert.ok(total >= 3, 'ยืนยันต้องเขียนหลายครั้ง: ' + total);
  for (let failAt = 1; failAt <= total; failAt++) {
    for (const timing of ['before', 'after']) {
      const s = setup();
      const d = s.draft(coffee).data;
      const params = { draft_id: d.draft_id, confirm_token: d.confirm_token };
      const outage = injectOutage(s.ctx, failAt, timing);
      const first = s.call('draft.confirm', params);
      outage.stop();
      assert.equal(first.ok, false, `failAt=${failAt} ${timing}`);
      const retry = s.call('draft.confirm', params);
      assert.equal(retry.ok, true, `failAt=${failAt} ${timing}: ${JSON.stringify(retry)}`);
      assert.equal(s.rows('Transactions').length, 1, `failAt=${failAt} ${timing}`);
      assert.equal(s.rows('ApiDrafts')[0].draft_status, 'CONFIRMED');
      assert.equal(s.rows('ApiDrafts')[0].transaction_id, retry.data.transaction_id);
    }
  }
});

test('draft.create: ไม่มีบัญชี/หมวด/เจ้าของ และไม่มีค่าเริ่มต้น → แจ้งด้วยชื่อฟิลด์ของ API', () => {
  const s = setup();
  const bare = s.createClient();
  const send = (params) => s.post({ api_key: bare.apiKey, action: 'draft.create', request_id: key(), params });
  const base = { transaction_type: 'EXPENSE', amount: 65, item_name: 'กาแฟ', category: 'อาหาร', owner: 'พ่อ' };
  let res = send(base);
  assert.equal(res.code, 'VALIDATION_REQUIRED');
  assert.equal(res.details.field, 'from_account');
  assert.match(res.message, /from_account/);
  res = send({ ...base, from_account: 'KBank', category: '' });
  assert.equal(res.details.field, 'category');
  res = send({ ...base, from_account: 'KBank', owner: '' });
  assert.equal(res.details.field, 'owner');
  res = send({ transaction_type: 'INCOME', amount: 10, item_name: 'ขายของ', category: 'เงินเดือน', owner: 'พ่อ' });
  assert.equal(res.details.field, 'to_account');
  res = send({ transaction_type: 'TRANSFER', amount: 10, item_name: 'โอน', from_account: 'KBank', owner: 'พ่อ' });
  assert.equal(res.details.field, 'to_account');
  assert.equal(send({ ...base, from_account: 'KBank' }).ok, true);
});

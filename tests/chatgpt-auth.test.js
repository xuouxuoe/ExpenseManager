'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `cg-test-${String(++seq).padStart(6, '0')}`;
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => b64url({ alg: 'none' }) + '.' + b64url(payload) + '.sig';
const ISSUER = 'https://auth.openai.com';

function setup() {
  const ctx = createDbContext();
  Object.assign(ctx.__props, { DB_TARGET: 'TEST', AI_PROVIDER: 'CHATGPT_OAUTH', AI_MODEL: 'gpt-5' });
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const food = mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' });
  const fake = { approved: false, accessExp: Math.floor(Date.now() / 1000) + 3600, refreshCount: 0, requests: [], aiText: null, aiCode: 200 };
  const tokens = (n) => ({
    id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' } }),
    access_token: jwt({ exp: fake.accessExp, n }),
    refresh_token: 'rt-' + n
  });
  ctx.__state.fetch = (url, options) => {
    fake.requests.push({ url, options });
    if (url === ISSUER + '/api/accounts/deviceauth/usercode') return { code: 200, body: { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '5' } };
    if (url === ISSUER + '/api/accounts/deviceauth/token') {
      return fake.approved ? { code: 200, body: { authorization_code: 'auth-code', code_verifier: 'verifier', code_challenge: 'ch' } } : { code: 403, body: { error: 'pending' } };
    }
    if (url === ISSUER + '/oauth/token') {
      if (String(options.payload).includes('refresh_token')) { fake.refreshCount += 1; return { code: 200, body: tokens('r' + fake.refreshCount) }; }
      return { code: 200, body: tokens('0') };
    }
    if (url === 'https://chatgpt.com/backend-api/codex/responses') {
      if (fake.aiCode !== 200) return { code: fake.aiCode, body: { detail: 'bad things' } };
      const text = JSON.stringify(fake.aiText);
      const half = Math.floor(text.length / 2);
      const sse = [
        'event: response.created', 'data: {"type":"response.created"}', '',
        'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: text.slice(0, half) }), '',
        'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: text.slice(half) }), '',
        'data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } }), ''
      ].join('\n');
      return { code: 200, body: sse };
    }
    throw new Error('unexpected url ' + url);
  };
  return { ctx, food, fake };
}

test('device code login: ขอรหัส → รอ (403) → เชื่อมสำเร็จ; token ไม่ถูกส่งกลับเบราว์เซอร์', () => {
  const s = setup();
  const start = s.ctx.api_chatgptStartLogin();
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.deepEqual(plain(start.data), { user_code: 'ABCD-1234', verification_url: ISSUER + '/codex/device', interval: 5, expires_in: 900 });
  assert.equal(JSON.parse(s.fake.requests[0].options.payload).client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');

  assert.equal(s.ctx.api_chatgptPollLogin().data.state, 'PENDING');
  s.fake.approved = true;
  const done = s.ctx.api_chatgptPollLogin();
  assert.equal(done.data.state, 'CONNECTED', JSON.stringify(done));
  assert.equal(done.data.status.email, 'me@example.com');
  assert.equal(done.data.status.plan, 'plus');
  const exchange = s.fake.requests.find((r) => r.url === ISSUER + '/oauth/token');
  assert.match(exchange.options.payload, /grant_type=authorization_code/);
  assert.match(exchange.options.payload, /code_verifier=verifier/);
  assert.match(exchange.options.payload, new RegExp('redirect_uri=' + encodeURIComponent(ISSUER + '/deviceauth/callback')));
  const stored = JSON.parse(s.ctx.__props.CHATGPT_OAUTH_TOKENS);
  assert.equal(stored.account_id, 'acct-1');
  assert.equal(s.ctx.__props.CHATGPT_DEVICE_AUTH, undefined, 'ล้างสถานะ device code');

  const view = s.ctx.api_getAiSettings();
  assert.equal(view.data.configured, true);
  assert.equal(view.data.chatgpt.connected, true);
  assert.equal(JSON.stringify(view).includes('rt-0'), false);
  assert.equal(JSON.stringify(done).includes('rt-0'), false);
});

test('AI parse ผ่าน ChatGPT: header บัญชี, stream SSE, store:false และได้ร่าง TRANSACTION', () => {
  const s = setup();
  s.ctx.api_chatgptStartLogin();
  s.fake.approved = true;
  s.ctx.api_chatgptPollLogin();
  s.fake.aiText = { intent: 'TRANSACTION', transaction_type: 'EXPENSE', amount: 65, category: s.food.category_id, item_name: 'กาแฟ' };
  const res = s.ctx.api_testAiSettings();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.result.intent, 'TRANSACTION');
  assert.equal(res.data.result.params.amount, 65);
  assert.equal(res.data.result.provider, 'CHATGPT_OAUTH');
  const call = s.fake.requests.find((r) => r.url.endsWith('/codex/responses'));
  assert.equal(call.options.headers['chatgpt-account-id'], 'acct-1');
  assert.match(call.options.headers.Authorization, /^Bearer ey/);
  const body = JSON.parse(call.options.payload);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'gpt-5');
  assert.match(body.instructions, /JSON schema/);
});

test('access token ใกล้หมดอายุ → refresh ครั้งเดียวแล้วใช้ token ใหม่', () => {
  const s = setup();
  s.fake.accessExp = Math.floor(Date.now() / 1000) + 60; // หมดใน 1 นาที (< margin 5 นาที)
  s.ctx.api_chatgptStartLogin();
  s.fake.approved = true;
  s.ctx.api_chatgptPollLogin();
  s.fake.accessExp = Math.floor(Date.now() / 1000) + 3600;
  s.fake.aiText = { intent: 'OTHER', message: 'สวัสดี' };
  assert.equal(s.ctx.api_testAiSettings().ok, true);
  assert.equal(s.ctx.api_testAiSettings().ok, true);
  assert.equal(s.fake.refreshCount, 1);
  assert.equal(JSON.parse(s.ctx.__props.CHATGPT_OAUTH_TOKENS).refresh_token, 'rt-r1');
});

test('ข้อผิดพลาด: ยังไม่เข้าสู่ระบบ, HTTP 401, ไม่ใช่เจ้าของ, ออกจากระบบ', () => {
  const s = setup();
  assert.equal(s.ctx.api_testAiSettings().code, 'AI_NOT_CONFIGURED');
  s.ctx.api_chatgptStartLogin();
  s.fake.approved = true;
  s.ctx.api_chatgptPollLogin();
  s.fake.aiCode = 401;
  assert.equal(s.ctx.api_testAiSettings().code, 'AI_NOT_CONFIGURED');
  s.fake.aiCode = 500;
  const e500 = s.ctx.api_testAiSettings();
  assert.equal(e500.code, 'AI_ERROR');
  assert.match(e500.message, /bad things/);

  s.ctx.__props.ALLOWED_EMAILS = 'owner@example.com,member@example.com';
  s.ctx.__state.activeEmail = 'member@example.com';
  assert.equal(s.ctx.api_chatgptStartLogin().ok, false);
  assert.equal(s.ctx.api_chatgptLogout().ok, false);
  s.ctx.__state.activeEmail = 'owner@example.com';
  const out = s.ctx.api_chatgptLogout();
  assert.equal(out.data.connected, false);
  assert.equal(s.ctx.__props.CHATGPT_OAUTH_TOKENS, undefined);
});

test('บันทึกการตั้งค่า CHATGPT_OAUTH ไม่ต้องมี API key', () => {
  const s = setup();
  delete s.ctx.__props.AI_PROVIDER;
  const res = s.ctx.api_saveAiSettings({ provider: 'CHATGPT_OAUTH', model: 'gpt-5', base_url: '', api_key: '' }, key());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.provider, 'CHATGPT_OAUTH');
  assert.equal(res.data.configured, false, 'ยังไม่เข้าสู่ระบบ');
});

test('textFromStream: ใช้ข้อความจาก delta เมื่อไม่มี response.completed และแจ้ง response.failed', () => {
  const s = setup();
  assert.equal(s.ctx.ChatGptAuth.textFromStream('data: {"type":"response.output_text.delta","delta":"{\\"a\\":"}\ndata: {"type":"response.output_text.delta","delta":"1}"}\n'), '{"a":1}');
  assert.throws(() => s.ctx.ChatGptAuth.textFromStream('data: {"type":"response.failed","response":{"error":{"message":"quota"}}}\n'), /quota/);
});

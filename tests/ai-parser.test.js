'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `ai-test-${String(++seq).padStart(6, '0')}`;
const AI_KEY = 'sk-test-' + 'x'.repeat(24);
const TEXT = 'กาแฟ 65 บาท จ่ายด้วย kbank';

function setup(props = {}) {
  const ctx = createDbContext();
  Object.assign(ctx.__props, { DB_TARGET: 'TEST', AI_API_KEY: AI_KEY, AI_MODEL: 'test-model' }, props);
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const dad = mk('owner', { owner_name: 'พ่อ' });
  const kbank = mk('account', { account_name: 'KBank', account_type: 'BANK' });
  const food = mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' });
  const apiKey = 'emk_' + crypto.randomBytes(32).toString('base64url');
  const created = ctx.api_createApiClient({ client_name: 'LINE', scopes: ['READ', 'WRITE'], api_key: apiKey, default_owner_id: dad.owner_id }, key());
  assert.equal(created.ok, true, JSON.stringify(created));
  const readKey = 'emk_' + crypto.randomBytes(32).toString('base64url');
  ctx.api_createApiClient({ client_name: 'READ', scopes: ['READ'], api_key: readKey }, key());
  const requests = [];
  const respond = (fn) => { ctx.__state.fetch = (url, options) => { requests.push({ url, options, body: JSON.parse(options.payload) }); return fn(url, options); }; };
  const post = (body, k = apiKey) => plain(ctx.IntegrationApi.dispatch({ postData: { contents: JSON.stringify({ api_key: k, ...body }) } }));
  return { ctx, dad, kbank, food, apiKey, readKey, requests, respond, post };
}

const parsed = (s, extra = {}) => ({ intent: 'TRANSACTION', transaction_type: 'EXPENSE', transaction_date: null, amount: 65, from_account: s.kbank.account_id, to_account: null,
  category: s.food.category_id, owner: null, item_name: 'กาแฟ', description: null, note: null, message: null, ...extra });
const openAiReply = (obj) => ({ code: 200, body: { choices: [{ message: { content: JSON.stringify(obj) } }] } });

test('OPENAI: ส่ง structured output แบบ strict พร้อมข้อมูลหลัก และคืน params ที่ใช้กับ draft.create ได้', () => {
  const s = setup();
  s.respond(() => openAiReply(parsed(s)));
  const res = s.post({ action: 'ai.parse', params: { text: TEXT } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.intent, 'TRANSACTION');
  assert.equal(res.data.provider, 'OPENAI');
  assert.deepEqual(res.data.params, { transaction_type: 'EXPENSE', amount: 65, from_account: s.kbank.account_id, category: s.food.category_id, item_name: 'กาแฟ', source_text: TEXT });
  const req = s.requests[0];
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(req.options.method, 'post');
  assert.equal(req.options.muteHttpExceptions, true);
  assert.equal(req.options.headers.Authorization, 'Bearer ' + AI_KEY);
  assert.equal(req.body.model, 'test-model');
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.equal(req.body.response_format.json_schema.strict, true);
  const schema = req.body.response_format.json_schema.schema;
  assert.deepEqual(schema.required.slice().sort(), Object.keys(schema.properties).sort());
  assert.equal(schema.additionalProperties, false);
  const system = req.body.messages[0].content;
  assert.match(system, new RegExp(`${s.kbank.account_id} \\| KBank \\| BANK`));
  assert.match(system, /อาหาร \| EXPENSE/);
  assert.match(system, new RegExp(`owner_id=${s.dad.owner_id}`));
  assert.equal(req.body.messages[1].content.includes(TEXT), true);
  assert.equal(req.options.payload.includes('opening_balance'), false, 'ไม่ส่งยอดเงิน');

  const draft = s.post({ action: 'draft.create', request_id: key(), params: res.data.params });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  assert.equal(draft.data.transaction.from_account_name, 'KBank');
  assert.equal(draft.data.transaction.owner_id, s.dad.owner_id);
  assert.equal(s.ctx.Database.readAll('Transactions').rows.length, 0, 'ai.parse/draft.create ยังไม่บันทึก');
});

test('ANTHROPIC: ใช้ tool_use บังคับ schema และอ่านผลจาก tool input', () => {
  const s = setup({ AI_PROVIDER: 'anthropic' });
  s.respond(() => ({ code: 200, body: { content: [{ type: 'tool_use', name: 'record_transaction', input: parsed(s, { amount: 120 }) }] } }));
  const res = s.post({ action: 'ai.parse', params: { text: TEXT } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.params.amount, 120);
  const req = s.requests[0];
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.options.headers['x-api-key'], AI_KEY);
  assert.equal(req.options.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(req.body.tool_choice, { type: 'tool', name: 'record_transaction' });
  assert.equal(req.body.tools[0].input_schema.type, 'object');
  assert.ok(req.body.max_tokens > 0);
  assert.equal(typeof req.body.system, 'string');
});

test('GEMINI: ขอผลเป็น JSON และรองรับคำตอบที่ห่อด้วย ```json', () => {
  const s = setup({ AI_PROVIDER: 'GEMINI', AI_MODEL: 'gemini-test' });
  s.respond(() => ({ code: 200, body: { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(parsed(s)) + '\n```' }] } }] } }));
  const res = s.post({ action: 'ai.parse', params: { text: TEXT } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.params.item_name, 'กาแฟ');
  const req = s.requests[0];
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(req.options.headers['x-goog-api-key'], AI_KEY);
  assert.equal(req.url.includes(AI_KEY), false, 'key ไม่อยู่ใน URL');
  assert.equal(req.body.generationConfig.responseMimeType, 'application/json');
});

test('OPENAI_COMPATIBLE: ใช้ AI_BASE_URL และ json_object; base URL ต้องเป็น https', () => {
  const s = setup({ AI_PROVIDER: 'OPENAI_COMPATIBLE', AI_BASE_URL: 'https://llm.example.com/v1/' });
  s.respond(() => openAiReply(parsed(s)));
  const res = s.post({ action: 'ai.parse', params: { text: TEXT } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(s.requests[0].url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(s.requests[0].body.response_format.type, 'json_object');
  assert.match(s.requests[0].body.messages[0].content, /JSON schema/);
  s.ctx.__props.AI_BASE_URL = 'http://llm.example.com/v1';
  assert.equal(s.post({ action: 'ai.parse', params: { text: TEXT } }).code, 'AI_NOT_CONFIGURED');
  s.ctx.__props.AI_BASE_URL = '';
  assert.equal(s.post({ action: 'ai.parse', params: { text: TEXT } }).code, 'AI_NOT_CONFIGURED');
});

test('ข้อความที่ไม่ใช่รายการ → intent OTHER ไม่มี params', () => {
  const s = setup();
  s.respond(() => openAiReply({ intent: 'OTHER', message: 'ไม่พบจำนวนเงิน', transaction_type: null, transaction_date: null, amount: null, from_account: null, to_account: null,
    category: null, owner: null, item_name: null, description: null, note: null }));
  const res = s.post({ action: 'ai.parse', params: { text: 'สวัสดี' } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { intent: 'OTHER', params: null, message: 'ไม่พบจำนวนเงิน', provider: 'OPENAI' });
});

test('ตั้งค่าไม่ครบ / ผู้ให้บริการผิดพลาด / คำตอบผิดรูปแบบ → ปฏิเสธโดยไม่ log ข้อความหรือ key', () => {
  const s = setup({ AI_API_KEY: '' });
  assert.equal(s.post({ action: 'ai.parse', params: { text: TEXT } }).code, 'AI_NOT_CONFIGURED');
  s.ctx.__props.AI_API_KEY = AI_KEY;
  s.ctx.__props.AI_PROVIDER = 'OTHER_AI';
  assert.equal(s.post({ action: 'ai.parse', params: { text: TEXT } }).code, 'AI_NOT_CONFIGURED');
  s.ctx.__props.AI_PROVIDER = 'OPENAI';
  s.respond(() => ({ code: 429, body: { error: { message: 'rate limit ' + TEXT } } }));
  const http = s.post({ action: 'ai.parse', params: { text: TEXT } });
  assert.equal(http.code, 'AI_ERROR');
  assert.match(http.message, /429/);
  s.respond(() => { throw new Error('timeout'); });
  assert.equal(s.post({ action: 'ai.parse', params: { text: TEXT } }).code, 'AI_ERROR');
  s.respond(() => ({ code: 200, body: { choices: [{ message: { content: 'ขออภัย ไม่เข้าใจ' } }] } }));
  assert.equal(s.post({ action: 'ai.parse', params: { text: TEXT } }).code, 'AI_INVALID_OUTPUT');
  s.respond(() => ({ code: 200, body: 'not json' }));
  assert.equal(s.post({ action: 'ai.parse', params: { text: TEXT } }).code, 'AI_INVALID_OUTPUT');
  const logs = s.ctx.__state.logs.join('\n');
  assert.match(logs, /AI_ERROR: OPENAI HTTP 429/);
  assert.equal(logs.includes(TEXT), false);
  assert.equal(logs.includes(AI_KEY), false);
});

test('ai.parse: ต้องมีสิทธิ์ WRITE, ต้องมีข้อความ และไม่เกิน 500 ตัวอักษร โดยไม่เรียก AI', () => {
  const s = setup();
  s.respond(() => openAiReply(parsed(s)));
  assert.equal(s.post({ action: 'ai.parse', params: { text: TEXT } }, s.readKey).code, 'FORBIDDEN_SCOPE');
  assert.equal(s.post({ action: 'ai.parse', params: {} }).code, 'VALIDATION_REQUIRED');
  assert.match(s.post({ action: 'ai.parse', params: { text: 'ก'.repeat(501) } }).code, /^VALIDATION_/);
  assert.equal(s.requests.length, 0);
});

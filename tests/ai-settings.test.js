'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `ai-set-${String(++seq).padStart(6, '0')}`;
const SECRET = 'sk-live-' + 'S'.repeat(30) + 'WXYZ';

function setup(activeEmail = 'owner@example.com') {
  const ctx = createDbContext({ activeEmail, properties: { ALLOWED_EMAILS: 'owner@example.com,family@example.com' } });
  return ctx;
}

const everything = (ctx) => JSON.stringify(ctx.__ss.sheets.map((s) => s.data)) + ctx.__state.logs.join('\n');

test('เจ้าของ: ตั้งค่าได้ key ไม่ถูกส่งกลับ (แสดงเฉพาะ 4 ตัวท้าย) และไม่อยู่ในชีต/journal/audit/log', () => {
  const ctx = setup();
  const before = plain(ctx.api_getAiSettings());
  assert.equal(before.ok, true);
  assert.deepEqual([before.data.can_edit, before.data.has_key, before.data.configured, before.data.provider], [true, false, false, 'OPENAI']);
  assert.equal(ctx.api_saveAiSettings({ provider: 'OPENAI', model: 'gpt-test' }, key()).code, 'VALIDATION_AI_SETTINGS', 'ครั้งแรกต้องมี key');
  const saved = plain(ctx.api_saveAiSettings({ provider: 'openai', model: 'gpt-test', api_key: SECRET }, key()));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual([saved.data.has_key, saved.data.key_hint, saved.data.configured, saved.data.model], [true, 'WXYZ', true, 'gpt-test']);
  assert.equal(JSON.stringify(saved).includes(SECRET), false);
  assert.equal(ctx.__props.AI_API_KEY, SECRET);
  assert.equal(ctx.__props.AI_PROVIDER, 'OPENAI');
  assert.equal(everything(ctx).includes(SECRET), false);
  assert.ok(ctx.Database.readAll('AuditLogs').rows.some((r) => r.action === 'UPDATE_AI_SETTINGS'));
  assert.equal(JSON.stringify(plain(ctx.api_getAiSettings())).includes(SECRET), false);
});

test('เว้น key ว่าง = ใช้ key เดิม; Base URL ต้องเป็น https เฉพาะ Custom และถูกล้างเมื่อเปลี่ยนผู้ให้บริการ; โมเดลต้องถูกรูปแบบ', () => {
  const ctx = setup();
  ctx.api_saveAiSettings({ provider: 'OPENAI', model: 'gpt-test', api_key: SECRET }, key());
  const keep = plain(ctx.api_saveAiSettings({ provider: 'ANTHROPIC', model: 'claude-test', api_key: '' }, key()));
  assert.equal(keep.ok, true, JSON.stringify(keep));
  assert.equal(ctx.__props.AI_API_KEY, SECRET);
  assert.equal(ctx.__props.AI_PROVIDER, 'ANTHROPIC');
  const bad = (input) => ctx.api_saveAiSettings({ provider: 'OPENAI', model: 'gpt-test', ...input }, key());
  assert.equal(bad({ provider: 'OPENAI_COMPATIBLE', base_url: 'http://llm.example.com/v1' }).details.field, 'base_url');
  assert.equal(bad({ provider: 'OPENAI_COMPATIBLE', base_url: '' }).details.field, 'base_url');
  assert.equal(bad({ model: 'gpt test' }).details.field, 'model');
  assert.equal(bad({ model: '=cmd()' }).details.field, 'model');
  assert.equal(bad({ api_key: 'short' }).details.field, 'api_key');
  assert.equal(bad({ provider: 'OTHER' }).code, 'VALIDATION_ENUM');
  const custom = plain(ctx.api_saveAiSettings({ provider: 'OPENAI_COMPATIBLE', model: 'llama-3', base_url: 'https://llm.example.com/v1/' }, key()));
  assert.equal(custom.data.base_url, 'https://llm.example.com/v1');
  ctx.api_saveAiSettings({ provider: 'GEMINI', model: 'gemini-test', base_url: 'https://llm.example.com/v1' }, key());
  assert.equal(ctx.__props.AI_BASE_URL, '');
});

test('ผู้ใช้อื่นใน ALLOWED_EMAILS: ดูสถานะได้แต่แก้/ทดสอบไม่ได้', () => {
  const ctx = setup('family@example.com');
  const view = plain(ctx.api_getAiSettings());
  assert.equal(view.ok, true);
  assert.equal(view.data.can_edit, false);
  assert.equal(ctx.api_saveAiSettings({ provider: 'OPENAI', model: 'gpt-test', api_key: SECRET }, key()).code, 'FORBIDDEN');
  assert.equal(ctx.api_testAiSettings().code, 'FORBIDDEN');
  assert.equal(ctx.__props.AI_API_KEY, undefined);
});

test('ทดสอบการตั้งค่า: เรียก AI ด้วยข้อความตัวอย่างและคืนผลพร้อมเวลา โดยไม่เขียนข้อมูลธุรกิจ', () => {
  const ctx = setup();
  ctx.api_saveAiSettings({ provider: 'OPENAI', model: 'gpt-test', api_key: SECRET }, key());
  ctx.__state.fetch = () => ({ code: 200, body: { choices: [{ message: { content: JSON.stringify({ intent: 'TRANSACTION', transaction_type: 'EXPENSE', transaction_date: null,
    amount: 65, from_account: null, to_account: null, category: null, owner: null, item_name: 'กาแฟ', description: null, note: null, message: null }) } }] } });
  const res = plain(ctx.api_testAiSettings());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.sample_text, 'กาแฟ 65 บาท');
  assert.equal(res.data.result.params.amount, 65);
  assert.equal(typeof res.data.elapsed_ms, 'number');
  assert.equal(ctx.Database.readAll('Transactions').rows.length, 0);
  ctx.__state.fetch = () => ({ code: 401, body: {} });
  const fail = plain(ctx.api_testAiSettings());
  assert.equal(fail.code, 'AI_ERROR');
  assert.match(fail.message, /401/);
});

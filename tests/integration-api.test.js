'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `api-test-${String(++seq).padStart(6, '0')}`;
const newApiKey = () => 'emk_' + crypto.randomBytes(32).toString('base64url');
const LINE_USER = 'U' + 'a'.repeat(32);

function setup() {
  const ctx = createDbContext();
  ctx.__props.DB_TARGET = 'TEST';
  const actor = { actorId: 'owner@example.com' };
  const owner = ctx.MasterData.create('owner', { owner_name: 'พ่อ' }, { idempotencyKey: key(), actor });
  const bank = ctx.MasterData.create('account', { account_name: 'ธนาคาร', account_type: 'BANK' }, { idempotencyKey: key(), actor });
  const post = (body) => plain(ctx.IntegrationApi.dispatch({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }));
  const createClient = (input = {}) => {
    const apiKey = newApiKey();
    const res = ctx.api_createApiClient({ client_name: 'Make LINE', scopes: ['READ', 'WRITE'], api_key: apiKey, ...input }, key());
    assert.equal(res.ok, true, JSON.stringify(res));
    return { apiKey, client: plain(res.data.client) };
  };
  return { ctx, owner, bank, post, createClient };
}

test('สร้างการเชื่อมต่อ: เก็บเฉพาะ hash ของ key ไม่มี key จริงในชีตใด ๆ และไม่คืน key_hash ให้หน้าเว็บ', () => {
  const { ctx, owner, bank, createClient } = setup();
  const { apiKey, client } = createClient({ allowed_channel_user_ids: `${LINE_USER}, ${LINE_USER}`, default_account_id: bank.account_id, default_owner_id: owner.owner_id });
  assert.equal(client.client_id, '1');
  assert.equal(client.actor_id, 'owner@example.com');
  assert.deepEqual(client.scopes, ['READ', 'WRITE']);
  assert.deepEqual(client.allowed_channel_user_ids, [LINE_USER]);
  assert.equal(client.default_account_id, bank.account_id);
  assert.equal('key_hash' in client, false);
  const row = ctx.Database.readAll('ApiClients').rows[0];
  assert.equal(row.key_hash, ctx.ApiClients.hashKey(apiKey));
  const everything = JSON.stringify(ctx.__ss.sheets.map((s) => s.data)) + JSON.stringify(ctx.__props) + ctx.__state.logs.join('\n');
  assert.equal(everything.includes(apiKey), false);
  const list = plain(ctx.api_listApiClients().data);
  assert.equal(list.length, 1);
  assert.equal('key_hash' in list[0], false);
});

test('ตรวจข้อมูลการเชื่อมต่อ: key รูปแบบผิด, ไม่มีสิทธิ์, scope ไม่รู้จัก, userId ผิดรูปแบบ, บัญชีไม่มีอยู่ → ปฏิเสธ', () => {
  const { ctx } = setup();
  const base = { client_name: 'Make', scopes: ['READ'], api_key: newApiKey() };
  const codeOf = (input) => ctx.api_createApiClient({ ...base, api_key: newApiKey(), ...input }, key()).code;
  assert.equal(codeOf({ api_key: 'short' }), 'VALIDATION_API_CLIENT');
  assert.equal(codeOf({ scopes: [] }), 'VALIDATION_API_CLIENT');
  assert.equal(codeOf({ scopes: ['ADMIN'] }), 'VALIDATION_ENUM');
  assert.equal(codeOf({ client_name: '' }), 'VALIDATION_REQUIRED');
  assert.equal(codeOf({ allowed_channel_user_ids: 'U123<script>' }), 'VALIDATION_API_CLIENT');
  assert.equal(codeOf({ default_account_id: '999' }), 'VALIDATION_API_CLIENT');
  assert.equal(ctx.Database.readAll('ApiClients').rows.length, 0);
});

test('retry ด้วย idempotency key เดิมไม่สร้างการเชื่อมต่อซ้ำ; key เดียวกันใช้กับสองการเชื่อมต่อไม่ได้', () => {
  const { ctx } = setup();
  const apiKey = newApiKey();
  const input = { client_name: 'Make', scopes: 'READ', api_key: apiKey };
  const k = key();
  assert.equal(ctx.api_createApiClient(input, k).ok, true);
  assert.equal(ctx.api_createApiClient(input, k).ok, true);
  assert.equal(ctx.Database.readAll('ApiClients').rows.length, 1);
  const dup = ctx.api_createApiClient({ ...input, client_name: 'อีกตัว' }, key());
  assert.equal(dup.code, 'VALIDATION_API_CLIENT');
  assert.equal(ctx.Database.readAll('ApiClients').rows.length, 1);
});

test('ping: key ถูกต้องได้ข้อมูลการเชื่อมต่อและฐานข้อมูลที่ใช้ ไม่มีการเขียนข้อมูล', () => {
  const { ctx, post, createClient } = setup();
  const { apiKey } = createClient();
  const before = JSON.stringify(ctx.__ss.sheets.map((s) => s.data));
  const res = post({ api_key: apiKey, action: 'ping' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.api_version, 1);
  assert.equal(res.data.client_name, 'Make LINE');
  assert.equal(res.data.db_target, 'TEST');
  assert.deepEqual(res.data.scopes, ['READ', 'WRITE']);
  assert.equal(JSON.stringify(ctx.__ss.sheets.map((s) => s.data)), before);
});

test('ปฏิเสธ: ไม่มี body, JSON ผิด, key ผิด/ไม่มี/ปิดแล้ว, action ไม่รู้จัก, ผู้สร้างถูกถอดสิทธิ์', () => {
  const { ctx, post, createClient } = setup();
  const { apiKey, client } = createClient();
  assert.equal(plain(ctx.IntegrationApi.dispatch({})).code, 'BAD_REQUEST');
  assert.equal(post('{not json').code, 'BAD_REQUEST');
  assert.equal(post('[1,2]').code, 'BAD_REQUEST');
  assert.equal(post({ action: 'ping' }).code, 'UNAUTHORIZED');
  assert.equal(post({ api_key: newApiKey(), action: 'ping' }).code, 'UNAUTHORIZED');
  assert.equal(post({ api_key: apiKey, action: 'toString' }).code, 'UNKNOWN_ACTION');
  assert.equal(post({ api_key: apiKey, action: '__proto__' }).code, 'UNKNOWN_ACTION');
  assert.equal(post('x'.repeat(100001)).code, 'PAYLOAD_TOO_LARGE');

  assert.equal(ctx.api_setApiClientActive(client.client_id, false, key()).ok, true);
  assert.equal(post({ api_key: apiKey, action: 'ping' }).code, 'UNAUTHORIZED');
  assert.equal(ctx.api_setApiClientActive(client.client_id, true, key()).ok, true);
  assert.equal(post({ api_key: apiKey, action: 'ping' }).ok, true);

  ctx.__props.ALLOWED_EMAILS = 'someone-else@example.com';
  assert.equal(post({ api_key: apiKey, action: 'ping' }).code, 'FORBIDDEN');
});

test('หมุน key: key เดิมใช้ไม่ได้ทันที key ใหม่ใช้ได้', () => {
  const { ctx, post, createClient } = setup();
  const { apiKey, client } = createClient();
  const next = newApiKey();
  const res = ctx.api_rotateApiClientKey(client.client_id, next, key());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(post({ api_key: apiKey, action: 'ping' }).code, 'UNAUTHORIZED');
  assert.equal(post({ api_key: next, action: 'ping' }).ok, true);
});

test('channel_user_id: เมื่อกำหนด whitelist แล้ว userId อื่นถูกปฏิเสธ; ไม่กำหนดก็ ping ได้', () => {
  const { post, createClient } = setup();
  const { apiKey } = createClient({ allowed_channel_user_ids: [LINE_USER] });
  assert.equal(post({ api_key: apiKey, action: 'ping', channel_user_id: LINE_USER }).ok, true);
  assert.equal(post({ api_key: apiKey, action: 'ping' }).ok, true);
  assert.equal(post({ api_key: apiKey, action: 'ping', channel_user_id: 'U' + 'b'.repeat(32) }).code, 'FORBIDDEN_CHANNEL');
});

test('แก้ไขการเชื่อมต่อ: เปลี่ยนชื่อและสิทธิ์ได้ โดย key เดิมยังใช้ได้', () => {
  const { ctx, post, createClient } = setup();
  const { apiKey, client } = createClient();
  const res = ctx.api_updateApiClient(client.client_id, { client_name: 'Make อ่านอย่างเดียว', scopes: ['READ'] }, key());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(plain(res.data.client.scopes), ['READ']);
  const ping = post({ api_key: apiKey, action: 'ping' });
  assert.equal(ping.data.client_name, 'Make อ่านอย่างเดียว');
});

test('จำกัดอัตรา: เกิน 60 คำขอต่อนาทีต่อการเชื่อมต่อถูกปฏิเสธ', () => {
  const { post, createClient } = setup();
  const { apiKey } = createClient();
  for (let i = 0; i < 60; i++) assert.equal(post({ api_key: apiKey, action: 'ping' }).ok, true);
  assert.equal(post({ api_key: apiKey, action: 'ping' }).code, 'RATE_LIMITED');
});

test('doPost คืน JSON ผ่าน ContentService', () => {
  const { ctx } = setup();
  const out = ctx.doPost({ postData: { contents: '{}' } });
  assert.equal(out.mimeType, 'application/json');
  assert.equal(JSON.parse(out.getContent()).code, 'UNAUTHORIZED');
});

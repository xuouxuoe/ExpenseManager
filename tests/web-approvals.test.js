'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `apv-test-${String(++seq).padStart(6, '0')}`;
const newApiKey = () => 'emk_' + crypto.randomBytes(32).toString('base64url');

function setup() {
  const ctx = createDbContext({ properties: { ALLOWED_EMAILS: 'owner@example.com,member@example.com' } });
  ctx.__props.DB_TARGET = 'TEST';
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const dad = mk('owner', { owner_name: 'พ่อ' });
  const kbank = mk('account', { account_name: 'KBank', account_type: 'BANK' });
  const food = mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' });
  const apiKey = newApiKey();
  const res = ctx.api_createApiClient({ client_name: 'Telegram บ้าน', scopes: ['READ', 'WRITE'], api_key: apiKey, allowed_channel_user_ids: 'tg_123',
    default_account_id: kbank.account_id, default_owner_id: dad.owner_id }, key());
  assert.equal(res.ok, true, JSON.stringify(res));
  const api = (body) => plain(ctx.IntegrationApi.dispatch({ postData: { contents: JSON.stringify({ api_key: apiKey, ...body }) } }));
  const draft = (params, extra = {}) => {
    const out = api({ action: 'draft.create', request_id: key(), channel_user_id: 'tg_123', params, ...extra });
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.data;
  };
  const rows = (sheet) => plain(ctx.Database.readAll(sheet).rows);
  return { ctx, dad, kbank, food, api, draft, rows };
}

const coffee = (s, amount = 65) => ({ transaction_type: 'EXPENSE', amount, category: s.food.category_id, item_name: 'กาแฟ' });

test('หน้า รอยืนยัน: แสดงร่าง PENDING พร้อมช่องทาง/ชื่อการเชื่อมต่อ ไม่มี confirm_token', () => {
  const s = setup();
  const d = s.draft(coffee(s));
  const res = s.ctx.api_listApiDrafts();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.pending.length, 1);
  const p = res.data.pending[0];
  assert.equal(p.draft_id, d.draft_id);
  assert.equal(p.channel, 'Telegram');
  assert.equal(p.client_name, 'Telegram บ้าน');
  assert.equal(p.kind, 'TRANSACTION');
  assert.match(p.summary_text, /65\.00/);
  assert.equal('confirm_token' in p, false);
  assert.equal(JSON.stringify(res).includes(d.confirm_token), false);
});

test('ยืนยันจากหน้าเว็บ: บันทึกครั้งเดียว actor = ผู้ใช้เว็บ; ยืนยันซ้ำ/ยืนยันในแชตหลังจากนั้นไม่ซ้ำ', () => {
  const s = setup();
  const d = s.draft(coffee(s));
  s.ctx.__state.activeEmail = 'member@example.com';
  const res = s.ctx.api_approveApiDraft(d.draft_id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.draft.draft_status, 'CONFIRMED');
  assert.equal(res.data.drafts.pending.length, 0);
  assert.equal(res.data.drafts.recent[0].draft_status, 'CONFIRMED');
  const tx = s.rows('Transactions');
  assert.equal(tx.length, 1);
  assert.equal(tx[0].source, 'AI');
  const journal = s.rows('OperationJournal').filter((j) => j.operation_type === 'API_DRAFT_CONFIRM');
  assert.equal(journal[0].actor_id, 'member@example.com');

  assert.equal(s.ctx.api_approveApiDraft(d.draft_id).ok, true, 'กดซ้ำได้ผลเดิม');
  const chat = s.api({ action: 'draft.confirm', request_id: key(), channel_user_id: 'tg_123', params: { draft_id: d.draft_id, confirm_token: d.confirm_token } });
  assert.equal(chat.ok, true);
  assert.equal(s.rows('Transactions').length, 1);
});

test('ยกเลิกจากหน้าเว็บ; ยืนยันร่างที่ยกเลิกแล้วถูกปฏิเสธ; ร่างไม่มีอยู่', () => {
  const s = setup();
  const d = s.draft(coffee(s));
  const res = s.ctx.api_cancelApiDraft(d.draft_id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.draft.draft_status, 'CANCELLED');
  const again = s.ctx.api_approveApiDraft(d.draft_id);
  assert.equal(again.code, 'DRAFT_NOT_PENDING');
  assert.equal(s.ctx.api_approveApiDraft('9999').code, 'DRAFT_NOT_FOUND');
  assert.equal(s.rows('Transactions').length, 0);
});

test('ร่างหมดอายุ: ไม่อยู่ในรายการรอยืนยัน และยืนยันไม่ได้', () => {
  const s = setup();
  const d = s.draft(coffee(s));
  const sheet = s.ctx.Database.readAll('ApiDrafts');
  const row = Object.assign({}, sheet.rows[0], { expires_at: '2020-01-01T00:00:00+07:00' });
  s.ctx.Database.writeRowAt('ApiDrafts', sheet.rowNumbers[0], row);
  const list = s.ctx.api_listApiDrafts().data;
  assert.equal(list.pending.length, 0);
  assert.equal(list.recent[0].draft_status, 'EXPIRED');
  assert.equal(s.ctx.api_approveApiDraft(d.draft_id).code, 'DRAFT_EXPIRED');
});

test('ผู้ใช้ที่ไม่อยู่ใน ALLOWED_EMAILS เรียกไม่ได้', () => {
  const s = setup();
  const d = s.draft(coffee(s));
  s.ctx.__state.activeEmail = 'stranger@example.com';
  assert.equal(s.ctx.api_listApiDrafts().ok, false);
  assert.equal(s.ctx.api_approveApiDraft(d.draft_id).ok, false);
  assert.equal(s.rows('Transactions').length, 0);
});

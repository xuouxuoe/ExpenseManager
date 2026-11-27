'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `line-test-${String(++seq).padStart(6, '0')}`;
const USER = 'U' + 'a'.repeat(32);
const STRANGER = 'U' + 'f'.repeat(32);
const LINE_TOKEN = 'line-token-' + 'T'.repeat(40);
const newApiKey = () => 'emk_' + crypto.randomBytes(32).toString('base64url');

function setup(clientInput = {}, props = {}) {
  const ctx = createDbContext();
  Object.assign(ctx.__props, { DB_TARGET: 'TEST', AI_API_KEY: 'sk-test-xxxxxxxxxxxx', AI_MODEL: 'test-model', LINE_CHANNEL_ACCESS_TOKEN: LINE_TOKEN }, props);
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const dad = mk('owner', { owner_name: 'พ่อ' });
  const kbank = mk('account', { account_name: 'KBank', account_type: 'BANK' });
  const food = mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' });
  const createClient = (input) => {
    const apiKey = newApiKey();
    const res = ctx.api_createApiClient({ client_name: 'LINE', scopes: ['READ', 'WRITE'], api_key: apiKey, ...input }, key());
    assert.equal(res.ok, true, JSON.stringify(res));
    return apiKey;
  };
  const lineKey = createClient({ allowed_channel_user_ids: USER, default_account_id: kbank.account_id, default_owner_id: dad.owner_id, ...clientInput });
  const ai = { reply: null, calls: 0 };
  const replies = [];
  ctx.__state.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    if (url === 'https://api.line.me/v2/bot/message/reply') {
      assert.equal(options.headers.Authorization, 'Bearer ' + LINE_TOKEN);
      replies.push(body);
      return { code: 200, body: {} };
    }
    ai.calls += 1;
    return { code: 200, body: { choices: [{ message: { content: JSON.stringify(ai.reply) } }] } };
  };
  const send = (events, k = lineKey) => plain(ctx.LineWebhook.handle({ parameter: { line_key: k }, postData: { contents: JSON.stringify({ destination: 'Uxxx', events }) } }));
  let n = 0;
  const textEvent = (t, userId = USER) => ({ type: 'message', webhookEventId: '01HZZZTEST' + String(++n).padStart(16, '0'), replyToken: 'rt-' + n,
    source: { type: 'user', userId }, message: { type: 'text', id: 'm' + n, text: t } });
  const postback = (data, userId = USER) => ({ type: 'postback', webhookEventId: '01HZZZPOST' + String(++n).padStart(16, '0'), replyToken: 'rt-' + n,
    source: { type: 'user', userId }, postback: { data } });
  const rows = (sheet) => plain(ctx.Database.readAll(sheet).rows);
  const lastReply = () => replies[replies.length - 1];
  const buttonsOf = (msg) => msg.contents.footer.contents.map((b) => b.action);
  return { ctx, dad, kbank, food, lineKey, createClient, ai, replies, send, textEvent, postback, rows, lastReply, buttonsOf };
}

const coffee = (s) => ({ intent: 'TRANSACTION', transaction_type: 'EXPENSE', transaction_date: null, amount: 65, from_account: null, to_account: null,
  category: s.food.category_id, owner: null, item_name: 'กาแฟ', description: null, note: null, message: null });

test('ข้อความ → AI → ร่าง → ตอบ Flex พร้อมปุ่มยืนยัน/ยกเลิก โดยยังไม่บันทึก', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  const res = s.send([s.textEvent('กาแฟ 65')]);
  assert.deepEqual(res, { ok: true, results: ['draft'] });
  const msg = s.lastReply().messages[0];
  assert.equal(s.lastReply().replyToken, 'rt-1');
  assert.equal(msg.type, 'flex');
  assert.match(msg.contents.body.contents[1].text, /รายจ่าย 65\.00 บาท — กาแฟ/);
  const [cancel, confirm] = s.buttonsOf(msg);
  assert.equal(confirm.label, 'ยืนยัน');
  assert.ok(confirm.data.length <= 300);
  assert.match(confirm.data, /^em=1&a=c&d=\d+&t=[a-f0-9]{32}$/);
  assert.match(cancel.data, /^em=1&a=x&/);
  const draft = s.rows('ApiDrafts')[0];
  assert.equal(draft.channel_user_id, USER);
  assert.equal(draft.draft_status, 'PENDING');
  assert.equal(s.rows('Transactions').length, 0);
  assert.equal(s.ctx.__state.logs.join('\n').includes('กาแฟ'), false, 'ไม่ log ข้อความผู้ใช้');
  assert.ok(s.ctx.__state.logs.includes('LINE_WEBHOOK: draft'));
});

test('กดยืนยัน → บันทึกธุรกรรม source AI ครั้งเดียว; กดซ้ำได้ผลเดิม; กดยกเลิกหลังยืนยันแจ้งสถานะ', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  s.send([s.textEvent('กาแฟ 65')]);
  const [cancel, confirm] = s.buttonsOf(s.lastReply().messages[0]);
  assert.deepEqual(s.send([s.postback(confirm.data)]).results, ['confirmed']);
  assert.match(s.lastReply().messages[0].text, /^บันทึกแล้ว/);
  assert.deepEqual(s.send([s.postback(confirm.data)]).results, ['confirmed']);
  const txs = s.rows('Transactions');
  assert.equal(txs.length, 1);
  assert.equal(txs[0].source, 'AI');
  assert.equal(txs[0].from_account_id, s.kbank.account_id);
  assert.deepEqual(s.send([s.postback(cancel.data)]).results, ['error:DRAFT_NOT_PENDING']);
  assert.match(s.lastReply().messages[0].text, /ยืนยันแล้ว/);
});

test('กดยกเลิก → ร่าง CANCELLED ไม่บันทึก; postback ที่ token ผิดหรือไม่ใช่ของระบบถูกปฏิเสธ/ข้าม', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  s.send([s.textEvent('กาแฟ 65')]);
  const [cancel, confirm] = s.buttonsOf(s.lastReply().messages[0]);
  assert.deepEqual(s.send([s.postback(confirm.data.replace(/t=[a-f0-9]+/, 't=' + '0'.repeat(32)))]).results, ['error:INVALID_CONFIRM_TOKEN']);
  assert.deepEqual(s.send([s.postback('action=other')]).results, ['ignored']);
  assert.deepEqual(s.send([s.postback(cancel.data)]).results, ['cancelled']);
  assert.equal(s.rows('ApiDrafts')[0].draft_status, 'CANCELLED');
  assert.equal(s.rows('Transactions').length, 0);
});

test('userId ที่ไม่ได้รับอนุญาต: ตอบ userId ให้ผู้ดูแลเพิ่ม โดยไม่เรียก AI และกดปุ่มของคนอื่นไม่ได้', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  assert.deepEqual(s.send([s.textEvent('กาแฟ 65', STRANGER)]).results, ['forbidden']);
  assert.match(s.lastReply().messages[0].text, new RegExp(STRANGER));
  assert.equal(s.ai.calls, 0);
  s.send([s.textEvent('กาแฟ 65')]);
  const [, confirm] = s.buttonsOf(s.lastReply().messages[0]);
  assert.deepEqual(s.send([s.postback(confirm.data, STRANGER)]).results, ['forbidden']);
  assert.equal(s.rows('Transactions').length, 0);
});

test('LINE ส่งเหตุการณ์ซ้ำ (webhookEventId เดิม) → เรียก AI และสร้างร่างครั้งเดียว', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  const ev = s.textEvent('กาแฟ 65');
  s.send([ev]);
  assert.deepEqual(s.send([{ ...ev, deliveryContext: { isRedelivery: true } }]).results, ['duplicate']);
  assert.equal(s.ai.calls, 1);
  assert.equal(s.rows('ApiDrafts').length, 1);
});

test('ข้อความที่ไม่ใช่รายการ / ข้อมูลผิด / วิธีใช้ / รูปภาพ / กลุ่ม', () => {
  const s = setup();
  s.ai.reply = { ...coffee(s), intent: 'OTHER', message: 'ไม่พบจำนวนเงิน' };
  assert.deepEqual(s.send([s.textEvent('สวัสดี')]).results, ['other']);
  assert.match(s.lastReply().messages[0].text, /ไม่พบจำนวนเงิน/);
  s.ai.reply = { ...coffee(s), from_account: 'SCB' };
  assert.deepEqual(s.send([s.textEvent('กาแฟ 65 scb')]).results, ['error:VALIDATION_NOT_FOUND']);
  assert.match(s.lastReply().messages[0].text, /ตัวเลือก: .*KBank/);
  const before = s.ai.calls;
  assert.deepEqual(s.send([s.textEvent('วิธีใช้')]).results, ['help']);
  assert.equal(s.ai.calls, before);
  assert.deepEqual(s.send([{ type: 'message', webhookEventId: '01HZZZIMAGE000000000000001', replyToken: 'rt-img', source: { type: 'user', userId: USER }, message: { type: 'image', id: 'i1' } }]).results, ['unsupported']);
  assert.deepEqual(s.send([{ type: 'message', webhookEventId: '01HZZZGROUP000000000000001', replyToken: 'rt-g', source: { type: 'group', groupId: 'C1', userId: USER }, message: { type: 'text', text: 'กาแฟ 65' } }]).results, ['ignored']);
  assert.deepEqual(s.send([{ type: 'follow', webhookEventId: '01HZZZFOLLOW00000000000001', replyToken: 'rt-f', source: { type: 'user', userId: USER } }]).results, ['help']);
  s.ctx.__props.AI_API_KEY = '';
  assert.deepEqual(s.send([s.textEvent('กาแฟ 65')]).results, ['error:AI_NOT_CONFIGURED']);
  assert.match(s.lastReply().messages[0].text, /ยังไม่ได้ตั้งค่า AI/);
  assert.equal(s.rows('ApiDrafts').length, 0);
});

test('การยืนยันตัวตนของ webhook: line_key ผิด, ไม่มีสิทธิ์ WRITE, ไม่กำหนด userId → ไม่ประมวลผล; ปุ่ม Verify (events ว่าง) ตอบ ok', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  assert.deepEqual(s.send([], s.lineKey), { ok: true, results: [] });
  // Verify ตอบทันทีโดยไม่เปิด Spreadsheet (LINE รอคำตอบไม่นาน) แม้ key ผิด เพราะไม่มีการประมวลผล
  const { countCalls, resetCalls } = require('./gas-shim');
  resetCalls(s.ctx.__ss);
  assert.deepEqual(s.send([], newApiKey()), { ok: true, results: [] });
  const calls = countCalls(s.ctx.__ss);
  assert.equal(calls.getRange + calls.getSheetByName, 0, JSON.stringify(calls));
  assert.equal(s.send([s.textEvent('กาแฟ 65')], newApiKey()).code, 'UNAUTHORIZED');
  const readOnly = s.createClient({ scopes: ['READ'], allowed_channel_user_ids: USER });
  assert.equal(s.send([s.textEvent('กาแฟ 65')], readOnly).code, 'FORBIDDEN_SCOPE');
  const noUsers = s.createClient({});
  assert.equal(s.send([s.textEvent('กาแฟ 65')], noUsers).code, 'FORBIDDEN_CHANNEL');
  assert.equal(plain(s.ctx.LineWebhook.handle({ parameter: { line_key: s.lineKey }, postData: { contents: '{bad' } })).code, 'BAD_REQUEST');
  assert.equal(s.ai.calls, 0);
  assert.equal(s.replies.length, 0);
  const logs = s.ctx.__state.logs.join('\n');
  ['LINE_WEBHOOK: UNAUTHORIZED', 'LINE_WEBHOOK: FORBIDDEN_SCOPE', 'LINE_WEBHOOK: FORBIDDEN_CHANNEL', 'LINE_WEBHOOK: BAD_REQUEST'].forEach((l) => assert.ok(logs.includes(l), l));
  assert.equal(logs.includes(s.lineKey), false);
  assert.equal(logs.includes(USER), false);
});

test('doPost แยกเส้นทาง: มี ?line_key → LINE webhook, ไม่มี → JSON API เดิม', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  const lineOut = JSON.parse(s.ctx.doPost({ parameter: { line_key: s.lineKey }, postData: { contents: JSON.stringify({ events: [] }) } }).getContent());
  assert.deepEqual(lineOut, { ok: true, results: [] });
  const apiOut = JSON.parse(s.ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify({ api_key: s.lineKey, action: 'ping' }) } }).getContent());
  assert.equal(apiOut.ok, true);
  assert.equal(apiOut.data.db_target, 'TEST');
});

test('ไม่ได้ตั้ง LINE token: ประมวลผลได้แต่ไม่ส่งข้อความตอบ และ log เฉพาะสถานะ', () => {
  const s = setup({}, { LINE_CHANNEL_ACCESS_TOKEN: '' });
  s.ai.reply = coffee(s);
  assert.deepEqual(s.send([s.textEvent('กาแฟ 65')]).results, ['draft']);
  assert.equal(s.replies.length, 0);
  assert.match(s.ctx.__state.logs.join('\n'), /LINE_NOT_CONFIGURED/);
});

test('LineSettings: เจ้าของตั้ง token ได้ ไม่ส่งค่ากลับ; ผู้ใช้อื่นตั้งไม่ได้', () => {
  const owner = createDbContext({ properties: { ALLOWED_EMAILS: 'owner@example.com,family@example.com' } });
  assert.equal(owner.api_saveLineSettings({ channel_access_token: 'short' }, key()).code, 'VALIDATION_LINE_SETTINGS');
  const saved = plain(owner.api_saveLineSettings({ channel_access_token: LINE_TOKEN }, key()));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(saved.data, { has_token: true, token_hint: LINE_TOKEN.slice(-4), can_edit: true, last_webhook: null });
  assert.equal(owner.__props.LINE_CHANNEL_ACCESS_TOKEN, LINE_TOKEN);
  assert.equal(JSON.stringify(owner.__ss.sheets.map((x) => x.data)).includes(LINE_TOKEN), false);
  const family = createDbContext({ activeEmail: 'family@example.com', properties: { ALLOWED_EMAILS: 'owner@example.com,family@example.com' } });
  assert.equal(plain(family.api_getLineSettings()).data.can_edit, false);
  assert.equal(family.api_saveLineSettings({ channel_access_token: LINE_TOKEN }, key()).code, 'FORBIDDEN');
});

test('ผลล่าสุดของ webhook แสดงในหน้าเว็บ: Verify, ถูกปฏิเสธ, ร่าง, และปัญหาการตอบกลับ โดยไม่มีข้อมูลลับ', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  const last = () => plain(s.ctx.api_getLineSettings()).data.last_webhook;
  s.send([]);
  assert.equal(last().outcome, 'VERIFY');
  assert.match(last().at, /^\d{4}-\d{2}-\d{2}T/);
  s.send([s.textEvent('กาแฟ 65')], newApiKey());
  assert.equal(last().outcome, 'UNAUTHORIZED');
  s.send([s.textEvent('กาแฟ 65')]);
  assert.equal(last().outcome, 'draft');
  s.ctx.__props.LINE_CHANNEL_ACCESS_TOKEN = '';
  s.send([s.textEvent('ข้าว 50', STRANGER)]);
  assert.equal(last().outcome, 'forbidden / LINE_NOT_CONFIGURED');
  const stored = s.ctx.__props.LINE_LAST_WEBHOOK;
  assert.equal(stored.includes(s.lineKey) || stored.includes(STRANGER) || stored.includes('ข้าว'), false);
});

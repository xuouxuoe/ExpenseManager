'use strict';
// Integration API ระยะ A6: อ่านรูปสลิปจาก LINE (docs/integration-api.md ข้อ 0.13)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `slip-test-${String(++seq).padStart(6, '0')}`;
const USER = 'U' + 'd'.repeat(32);
const LINE_TOKEN = 'line-token-' + 'S'.repeat(40);
const IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x80, 0xfe, 0x7f]); // JPEG header + bytes > 127

function setup(props = {}) {
  const ctx = createDbContext();
  Object.assign(ctx.__props, { DB_TARGET: 'TEST', AI_API_KEY: 'sk-test-xxxxxxxxxxxx', AI_MODEL: 'vision-model', LINE_CHANNEL_ACCESS_TOKEN: LINE_TOKEN }, props);
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const dad = mk('owner', { owner_name: 'พ่อ' });
  const bbl = mk('account', { account_name: 'กรุงเทพ', account_type: 'BANK' });
  const food = mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' });
  const apiKey = 'emk_' + crypto.randomBytes(32).toString('base64url');
  assert.equal(ctx.api_createApiClient({ client_name: 'LINE', scopes: ['READ', 'WRITE'], api_key: apiKey, allowed_channel_user_ids: USER,
    default_account_id: bbl.account_id, default_owner_id: dad.owner_id }, key()).ok, true);
  const calls = { content: [], ai: [], replies: [] };
  const state = { image: { code: 200, bytes: IMAGE, contentType: 'image/jpeg' }, ai: null, provider: 'OPENAI' };
  ctx.__state.fetch = (url, options) => {
    if (url.startsWith('https://api-data.line.me/v2/bot/message/')) {
      calls.content.push({ url, options });
      return state.image;
    }
    if (url === 'https://api.line.me/v2/bot/message/reply') { calls.replies.push(JSON.parse(options.payload)); return { code: 200, body: {} }; }
    calls.ai.push({ url, body: JSON.parse(options.payload) });
    return { code: 200, body: { choices: [{ message: { content: JSON.stringify(state.ai) } }] } };
  };
  let n = 0;
  const sendImage = (message = {}) => plain(ctx.LineWebhook.handle({ parameter: { line_key: apiKey }, postData: { contents: JSON.stringify({ events: [
    { type: 'message', webhookEventId: '01HZZZSLIP' + String(++n).padStart(16, '0'), replyToken: 'rt-' + n, source: { type: 'user', userId: USER },
      message: { type: 'image', id: '5550' + n, contentProvider: { type: 'line' }, ...message } }] }) } }));
  const slip = (extra = {}) => ({ intent: 'TRANSACTION', transaction_type: 'EXPENSE', transaction_date: '2026-11-28', amount: 1250, from_account: bbl.account_id, to_account: null,
    category: food.category_id, owner: null, item_name: 'ร้านอาหารสมใจ', description: 'Ref 0123', note: null, budget: null, message: null, ...extra });
  const rows = (sheet) => plain(ctx.Database.readAll(sheet).rows);
  const lastReply = () => calls.replies[calls.replies.length - 1].messages[0];
  return { ctx, dad, bbl, food, apiKey, calls, state, sendImage, slip, rows, lastReply };
}

test('รูปสลิป → ดึงจาก LINE content API → AI อ่านรูป → ร่างพร้อมปุ่มยืนยัน ยังไม่บันทึก ไม่เก็บและไม่ log รูป', () => {
  const s = setup();
  s.state.ai = s.slip();
  const res = s.sendImage();
  assert.deepEqual(res.results, ['draft']);
  assert.equal(s.calls.content.length, 1);
  assert.match(s.calls.content[0].url, /\/v2\/bot\/message\/55501\/content$/);
  assert.equal(s.calls.content[0].options.method, 'get');
  assert.equal(s.calls.content[0].options.headers.Authorization, 'Bearer ' + LINE_TOKEN);
  const body = s.calls.ai[0].body;
  const parts = body.messages[1].content;
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, 'data:image/jpeg;base64,' + IMAGE.toString('base64'));
  assert.match(body.messages[0].content, /payment slip/);
  const flex = s.lastReply();
  assert.equal(flex.type, 'flex');
  assert.match(flex.contents.body.contents[1].text, /รายจ่าย 1,250\.00 บาท — ร้านอาหารสมใจ/);
  const draft = s.rows('ApiDrafts')[0];
  assert.equal(draft.draft_status, 'PENDING');
  assert.equal(JSON.stringify(s.rows('ApiDrafts')).includes(IMAGE.toString('base64')), false, 'ไม่เก็บรูป');
  assert.equal(s.ctx.__state.logs.join('\n').includes(IMAGE.toString('base64')), false, 'ไม่ log รูป');
  assert.equal(s.rows('Transactions').length, 0);
});

test('ANTHROPIC และ GEMINI แนบรูปตามรูปแบบของผู้ให้บริการ', () => {
  const a = setup({ AI_PROVIDER: 'ANTHROPIC' });
  const req = plain(a.ctx.AiParser.buildRequest({ provider: 'ANTHROPIC', key: 'k', model: 'm' }, 'sys', 'read', { type: 'object' }, { mime: 'image/png', data: 'QUJD' }));
  const content = JSON.parse(req.options.payload).messages[0].content;
  assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  const g = plain(a.ctx.AiParser.buildRequest({ provider: 'GEMINI', key: 'k', model: 'm' }, 'sys', 'read', { type: 'object' }, { mime: 'image/png', data: 'QUJD' }));
  assert.deepEqual(JSON.parse(g.options.payload).contents[0].parts[0], { inline_data: { mime_type: 'image/png', data: 'QUJD' } });
  const t = plain(a.ctx.AiParser.buildRequest({ provider: 'GEMINI', key: 'k', model: 'm' }, 'sys', 'hello', { type: 'object' }));
  assert.deepEqual(JSON.parse(t.options.payload).contents[0].parts, [{ text: 'Message:\nhello' }], 'ข้อความเดิมไม่เปลี่ยน');
});

test('รูปที่ไม่ใช่สลิป → AI ตอบ OTHER → ตอบคำอธิบาย ไม่สร้างร่าง', () => {
  const s = setup();
  s.state.ai = { ...s.slip(), intent: 'OTHER', message: 'รูปนี้ไม่ใช่สลิปหรือใบเสร็จ' };
  assert.deepEqual(s.sendImage().results, ['other']);
  assert.match(s.lastReply().text, /ไม่ใช่สลิป/);
  assert.equal(s.rows('ApiDrafts').length, 0);
});

test('ดึงรูปไม่สำเร็จ / ชนิดไฟล์ไม่รองรับ / ใหญ่เกิน / รูปจากลิงก์ภายนอก / ไม่ได้ตั้ง token → ตอบข้อความ ไม่เรียก AI', () => {
  const s = setup();
  s.state.ai = s.slip();
  s.state.image = { code: 404, bytes: Buffer.alloc(0) };
  assert.deepEqual(s.sendImage().results, ['error:LINE_CONTENT_ERROR']);
  assert.match(s.lastReply().text, /ดึงรูปจาก LINE ไม่สำเร็จ/);
  s.state.image = { code: 200, bytes: Buffer.from('GIF89a'), contentType: 'image/gif' };
  assert.deepEqual(s.sendImage().results, ['error:UNSUPPORTED_IMAGE']);
  s.state.image = { code: 200, bytes: Buffer.alloc(5 * 1024 * 1024 + 1), contentType: 'image/jpeg' };
  assert.deepEqual(s.sendImage().results, ['error:UNSUPPORTED_IMAGE']);
  assert.match(s.lastReply().text, /ใหญ่เกินไป/);
  const before = s.calls.content.length;
  assert.deepEqual(s.sendImage({ contentProvider: { type: 'external', originalContentUrl: 'https://example.com/a.jpg' } }).results, ['unsupported']);
  assert.equal(s.calls.content.length, before, 'ไม่ดึงรูปจากลิงก์ภายนอก');
  assert.equal(s.calls.ai.length, 0);
  s.ctx.__props.LINE_CHANNEL_ACCESS_TOKEN = '';
  assert.deepEqual(s.sendImage().results, ['error:LINE_NOT_CONFIGURED']);
  assert.equal(s.rows('ApiDrafts').length, 0);
});

test('AI อ่านรูปไม่ได้ (เช่น โมเดลไม่รองรับภาพ) → แจ้งให้ใช้โมเดลที่อ่านภาพได้', () => {
  const s = setup();
  s.ctx.__state.fetch = (url, options) => {
    if (url.startsWith('https://api-data.line.me/')) return { code: 200, bytes: IMAGE, contentType: 'image/jpeg' };
    if (url === 'https://api.line.me/v2/bot/message/reply') { s.calls.replies.push(JSON.parse(options.payload)); return { code: 200, body: {} }; }
    return { code: 400, body: { error: { message: 'model does not support image input' } } };
  };
  assert.deepEqual(s.sendImage().results, ['error:AI_ERROR']);
  assert.match(s.lastReply().text, /โมเดล AI ที่อ่านภาพได้/);
});

test('สลิปที่ AI ไม่เลือกหมวด: มีหมวดทั่วไป ("อื่นๆ") → ใช้หมวดนั้นในร่าง; prompt บังคับให้เลือกหมวด', () => {
  const s = setup();
  const other = plain(s.ctx.MasterData.create('category', { category_name: 'อื่นๆ', category_type: 'EXPENSE' }, { idempotencyKey: key(), actor: { actorId: 'owner@example.com' } }));
  s.state.ai = s.slip({ category: null });
  assert.deepEqual(s.sendImage().results, ['draft']);
  assert.match(s.lastReply().contents.body.contents[1].text, /หมวด อื่นๆ/);
  assert.equal(JSON.parse(s.rows('ApiDrafts')[0].draft_json).category_id, other.category_id);
  assert.match(s.calls.ai[0].body.messages[0].content, /category is REQUIRED/);
});

test('สลิปที่ไม่มีหมวดและไม่มีหมวดทั่วไป → ตอบรายชื่อหมวดให้เลือกและวิธีพิมพ์ ไม่สร้างร่าง', () => {
  const s = setup();
  s.state.ai = s.slip({ category: null });
  assert.deepEqual(s.sendImage().results, ['error:VALIDATION_REQUIRED']);
  const msg = s.lastReply().text;
  assert.match(msg, /กรุณาระบุ หมวดหมู่รายจ่าย/);
  assert.match(msg, /ตัวเลือก: อาหาร/);
  assert.match(msg, /หมวดอาหาร/);
  assert.doesNotMatch(msg, /category/);
  assert.equal(s.rows('ApiDrafts').length, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `tg-test-${String(++seq).padStart(6, '0')}`;
const TG_USER = 111222333;
const STRANGER = 999888777;
const BOT_TOKEN = '123456789:' + 'A'.repeat(35);
const API = 'https://api.telegram.org/bot' + BOT_TOKEN + '/';
const newApiKey = () => 'emk_' + crypto.randomBytes(32).toString('base64url');

function setup(clientInput = {}, props = {}) {
  const ctx = createDbContext();
  Object.assign(ctx.__props, { DB_TARGET: 'TEST', AI_API_KEY: 'sk-test-xxxxxxxxxxxx', AI_MODEL: 'test-model', TELEGRAM_BOT_TOKEN: BOT_TOKEN }, props);
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const dad = mk('owner', { owner_name: 'พ่อ' });
  const kbank = mk('account', { account_name: 'KBank', account_type: 'BANK' });
  const food = mk('category', { category_name: 'อาหาร', category_type: 'EXPENSE' });
  const createClient = (input) => {
    const apiKey = newApiKey();
    const res = ctx.api_createApiClient({ client_name: 'Telegram', scopes: ['READ', 'WRITE'], api_key: apiKey, ...input }, key());
    assert.equal(res.ok, true, JSON.stringify(res));
    return apiKey;
  };
  const tgKey = createClient({ allowed_channel_user_ids: 'tg_' + TG_USER, default_account_id: kbank.account_id, default_owner_id: dad.owner_id, ...clientInput });
  const ai = { reply: null, calls: 0, lastImage: null };
  const calls = [];
  const files = {};
  ctx.__state.fetch = (url, options) => {
    if (url.startsWith(API)) {
      const method = url.slice(API.length);
      const body = options.payload ? JSON.parse(options.payload) : {};
      calls.push({ method, body });
      if (method === 'getFile') return { code: 200, body: { ok: true, result: { file_path: 'photos/file_1.jpg' } } };
      return { code: 200, body: { ok: true, result: { message_id: 1 } } };
    }
    if (url.startsWith('https://api.telegram.org/file/bot' + BOT_TOKEN + '/')) {
      return { code: 200, body: '', bytes: files.bytes || Buffer.from([1, 2, 3]), contentType: 'application/octet-stream' };
    }
    ai.calls += 1;
    const req = JSON.parse(options.payload);
    const userContent = req.messages && req.messages[1] && req.messages[1].content;
    ai.lastImage = Array.isArray(userContent) ? userContent.find((c) => c.type === 'image_url') : null;
    return { code: 200, body: { choices: [{ message: { content: JSON.stringify(ai.reply) } }] } };
  };
  let n = 0;
  const send = (update, k = tgKey) => plain(ctx.TelegramWebhook.handle({ parameter: { tg_key: k }, postData: { contents: JSON.stringify(update) } }));
  const textUpdate = (t, userId = TG_USER) => ({ update_id: 1000 + (++n), message: { message_id: n, from: { id: userId, is_bot: false }, chat: { id: userId, type: 'private' }, text: t } });
  const callback = (data, userId = TG_USER) => ({ update_id: 1000 + (++n), callback_query: { id: 'cq' + n, from: { id: userId, is_bot: false }, data,
    message: { message_id: 77, chat: { id: userId, type: 'private' } } } });
  const sent = () => calls.filter((c) => c.method === 'sendMessage');
  const lastSent = () => sent()[sent().length - 1];
  const rows = (sheet) => plain(ctx.Database.readAll(sheet).rows);
  return { ctx, dad, kbank, food, tgKey, createClient, ai, calls, files, send, textUpdate, callback, sent, lastSent, rows };
}

const coffee = (s) => ({ intent: 'TRANSACTION', transaction_type: 'EXPENSE', transaction_date: null, amount: 65, from_account: null, to_account: null,
  category: s.food.category_id, owner: null, item_name: 'กาแฟ', description: null, note: null, message: null });

test('Telegram: ข้อความ → ร่าง → ปุ่ม inline (callback_data ≤ 64 ไบต์) โดยยังไม่บันทึก; ยืนยันแล้วบันทึกครั้งเดียว', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  assert.deepEqual(s.send(s.textUpdate('กาแฟ 65')), { ok: true, results: ['draft'] });
  const msg = s.lastSent().body;
  assert.equal(msg.chat_id, TG_USER);
  assert.match(msg.text, /รายจ่าย 65\.00 บาท — กาแฟ/);
  const [cancel, confirm] = msg.reply_markup.inline_keyboard[0];
  assert.match(confirm.callback_data, /^em\|c\|\d+\|[a-f0-9]{32}$/);
  assert.ok(Buffer.byteLength(confirm.callback_data) <= 64);
  assert.match(cancel.callback_data, /^em\|x\|/);
  assert.equal(s.rows('ApiDrafts')[0].channel_user_id, 'tg_' + TG_USER);
  assert.equal(s.rows('Transactions').length, 0);

  assert.deepEqual(s.send(s.callback(confirm.callback_data)), { ok: true, results: ['confirmed'] });
  assert.ok(s.calls.some((c) => c.method === 'answerCallbackQuery'));
  assert.ok(s.calls.some((c) => c.method === 'editMessageReplyMarkup'));
  const tx = s.rows('Transactions');
  assert.equal(tx.length, 1);
  assert.equal(tx[0].source, 'AI');
  assert.deepEqual(s.send(s.callback(confirm.callback_data)), { ok: true, results: ['confirmed'] }, 'กดซ้ำได้ผลเดิม');
  assert.equal(s.rows('Transactions').length, 1);
  assert.equal(s.ctx.__state.logs.join('\n').includes('กาแฟ'), false, 'ไม่ log ข้อความผู้ใช้');
  assert.equal(s.ctx.__state.logs.join('\n').includes(BOT_TOKEN), false, 'ไม่ log token');
});

test('Telegram: กดยกเลิก → ไม่บันทึก; token ปลอมถูกปฏิเสธ', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  s.send(s.textUpdate('กาแฟ 65'));
  const [cancel, confirm] = s.lastSent().body.reply_markup.inline_keyboard[0];
  const forged = confirm.callback_data.replace(/[a-f0-9]{32}$/, '0'.repeat(32));
  assert.deepEqual(s.send(s.callback(forged)), { ok: true, results: ['error:INVALID_CONFIRM_TOKEN'] });
  assert.deepEqual(s.send(s.callback(cancel.callback_data)), { ok: true, results: ['cancelled'] });
  assert.equal(s.rows('ApiDrafts')[0].draft_status, 'CANCELLED');
  assert.equal(s.rows('Transactions').length, 0);
});

test('Telegram: ผู้ใช้ที่ไม่อนุญาต / กลุ่ม / key ผิด / update ซ้ำ', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  assert.deepEqual(s.send(s.textUpdate('กาแฟ 65', STRANGER)), { ok: true, results: ['forbidden'] });
  assert.match(s.lastSent().body.text, new RegExp('tg_' + STRANGER));
  const group = s.textUpdate('กาแฟ 65');
  group.message.chat = { id: -100123, type: 'group' };
  assert.deepEqual(s.send(group), { ok: true, results: ['ignored'] });
  assert.deepEqual(s.send(s.textUpdate('กาแฟ 65'), newApiKey()), { ok: false, code: 'UNAUTHORIZED' });
  const u = s.textUpdate('กาแฟ 65');
  assert.deepEqual(s.send(u), { ok: true, results: ['draft'] });
  assert.deepEqual(s.send(u), { ok: true, results: ['duplicate'] });
  assert.equal(s.rows('ApiDrafts').length, 1);
  assert.equal(s.ai.calls, 1);
  assert.deepEqual(plain(s.ctx.TelegramWebhook.handle({ parameter: { tg_key: s.tgKey }, postData: { contents: '{"x":1}' } })), { ok: false, code: 'BAD_REQUEST' });
});

test('Telegram: การเชื่อมต่อยังไม่มีผู้ใช้ Telegram → ตอบรหัส tg_ ของผู้ส่ง ไม่สร้างร่าง', () => {
  const s = setup({ allowed_channel_user_ids: '' });
  const res = s.send(s.textUpdate('กาแฟ 65'));
  assert.deepEqual(res, { ok: false, code: 'FORBIDDEN_CHANNEL', results: ['setup'] });
  assert.match(s.lastSent().body.text, new RegExp('tg_' + TG_USER));
  assert.equal(s.ai.calls, 0);
  assert.equal(s.rows('ApiDrafts').length, 0);
});

test('Telegram: คำสั่งดูข้อมูลและ /start ไม่เรียก AI', () => {
  const s = setup();
  assert.deepEqual(s.send(s.textUpdate('/start')), { ok: true, results: ['help'] });
  assert.deepEqual(s.send(s.textUpdate('ยอดเงิน')), { ok: true, results: ['balances'] });
  assert.deepEqual(s.send(s.textUpdate('/summary@my_bot')), { ok: true, results: ['summary'] });
  assert.equal(s.ai.calls, 0);
});

test('Telegram: รูปสลิป → getFile → ดาวน์โหลด → AI อ่านรูป → ร่าง', () => {
  const s = setup();
  s.ai.reply = coffee(s);
  const u = { update_id: 5555, message: { message_id: 9, from: { id: TG_USER, is_bot: false }, chat: { id: TG_USER, type: 'private' },
    photo: [{ file_id: 'small', file_size: 1000, width: 90 }, { file_id: 'big', file_size: 50000, width: 800 }] } };
  assert.deepEqual(s.send(u), { ok: true, results: ['draft'] });
  assert.equal(s.calls.find((c) => c.method === 'getFile').body.file_id, 'big');
  assert.match(s.ai.lastImage.image_url.url, /^data:image\/jpeg;base64,/);
});

test('Telegram: ไม่ได้ตั้ง bot token → บันทึกสาเหตุในผลล่าสุด', () => {
  const s = setup({}, { TELEGRAM_BOT_TOKEN: '' });
  s.send(s.textUpdate('วิธีใช้'));
  const last = JSON.parse(s.ctx.__props.TELEGRAM_LAST_WEBHOOK);
  assert.equal(last.outcome, 'help / TELEGRAM_NOT_CONFIGURED');
});

test('Telegram ผ่าน doPost: route ด้วย ?tg_key=', () => {
  const s = setup();
  const out = s.ctx.doPost({ parameter: { tg_key: s.tgKey }, postData: { contents: JSON.stringify(s.textUpdate('วิธีใช้')) } });
  assert.deepEqual(JSON.parse(out.getContent()), { ok: true, results: ['help'] });
});

test('TelegramSettings: เฉพาะเจ้าของ, ตรวจ token กับ getMe, setWebhook ตรวจ key และไม่คืน URL เต็ม', () => {
  const s = setup({}, { TELEGRAM_BOT_TOKEN: '' });
  const getMe = [];
  const base = s.ctx.__state.fetch;
  s.ctx.__state.fetch = (url, options) => {
    if (url.endsWith('/getMe')) { getMe.push(url); return { code: 200, body: { ok: true, result: { is_bot: true, username: 'home_bot' } } }; }
    if (url.endsWith('/getWebhookInfo')) return { code: 200, body: { ok: true, result: { url: 'https://script.google.com/macros/s/ABCDEFGHIJKLMNOP/exec?tg_key=secret', pending_update_count: 2 } } };
    return base(url, options);
  };
  const bad = s.ctx.api_saveTelegramSettings({ bot_token: 'nope' }, key());
  assert.equal(bad.code, 'VALIDATION_TELEGRAM_SETTINGS');
  const saved = s.ctx.api_saveTelegramSettings({ bot_token: BOT_TOKEN }, key());
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.data.bot_username, 'home_bot');
  assert.equal(JSON.stringify(saved).includes(BOT_TOKEN), false);
  assert.equal(s.ctx.__props.TELEGRAM_BOT_TOKEN, BOT_TOKEN);

  const wrongUrl = s.ctx.api_setTelegramWebhook({ webhook_url: 'https://evil.example.com/exec?tg_key=' + s.tgKey });
  assert.equal(wrongUrl.code, 'VALIDATION_TELEGRAM_SETTINGS');
  const wrongKey = s.ctx.api_setTelegramWebhook({ webhook_url: 'https://script.google.com/macros/s/ABCDEFGHIJKLMNOP/exec?tg_key=' + newApiKey().replace(/[^A-Za-z0-9_-]/g, '') });
  assert.equal(wrongKey.code, 'UNAUTHORIZED');
  const ok = s.ctx.api_setTelegramWebhook({ webhook_url: 'https://script.google.com/macros/s/ABCDEFGHIJKLMNOP/exec?tg_key=' + s.tgKey });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const hook = s.calls.find((c) => c.method === 'setWebhook').body;
  assert.equal(hook.url.endsWith('?tg_key=' + s.tgKey), true);
  assert.deepEqual(hook.allowed_updates, ['message', 'callback_query']);
  assert.equal(JSON.stringify(ok).includes('secret'), false, 'ไม่คืน key ใน URL');
  assert.equal(ok.data.pending_update_count, 2);

  s.ctx.__state.activeEmail = 'other@example.com';
  s.ctx.__props.ALLOWED_EMAILS = 'owner@example.com,other@example.com';
  const notOwner = s.ctx.api_saveTelegramSettings({ bot_token: BOT_TOKEN }, key());
  assert.equal(notOwner.ok, false);
});

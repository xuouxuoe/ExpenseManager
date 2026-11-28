'use strict';
// สร้างแผนชำระผ่าน LINE / Integration API (ร่าง → ยืนยัน)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `plan-draft-${String(++seq).padStart(6, '0')}`;
const USER = 'U' + 'e'.repeat(32);
const LINE_TOKEN = 'line-token-' + 'P'.repeat(40);

function setup() {
  const ctx = createDbContext();
  Object.assign(ctx.__props, { DB_TARGET: 'TEST', AI_API_KEY: 'sk-test-xxxxxxxxxxxx', AI_MODEL: 'test-model', LINE_CHANNEL_ACCESS_TOKEN: LINE_TOKEN });
  const actor = { actorId: 'owner@example.com' };
  const mk = (type, input) => plain(ctx.MasterData.create(type, input, { idempotencyKey: key(), actor }));
  const dad = mk('owner', { owner_name: 'พ่อ' });
  const bank = mk('account', { account_name: 'KBank', account_type: 'BANK' });
  const ktc = mk('account', { account_name: 'บัตร KTC', account_type: 'CREDIT_CARD' });
  const appliance = mk('category', { category_name: 'เครื่องใช้ไฟฟ้า', category_type: 'EXPENSE' });
  const apiKey = 'emk_' + crypto.randomBytes(32).toString('base64url');
  assert.equal(ctx.api_createApiClient({ client_name: 'LINE', scopes: ['READ', 'WRITE'], api_key: apiKey, allowed_channel_user_ids: USER,
    default_account_id: bank.account_id, default_owner_id: dad.owner_id }, key()).ok, true);
  const post = (action, params, extra = {}) => plain(ctx.IntegrationApi.dispatch({ postData: { contents: JSON.stringify({ api_key: apiKey, action, channel_user_id: USER, params, ...extra }) } }));
  const draft = (params) => post('draft.create', { kind: 'PAYMENT_PLAN', item_name: 'ทีวี', account: 'บัตร KTC', category: 'เครื่องใช้ไฟฟ้า',
    principal_amount: 12000, installment_count: 10, ...params }, { request_id: key() });
  const rows = (sheet) => plain(ctx.Database.readAll(sheet).rows);
  const ym = (offset) => ctx.Validation.addMonths(Number(ctx.Util.todayIso().slice(0, 7).replace('-', '')), offset);
  return { ctx, dad, bank, ktc, appliance, apiKey, post, draft, rows, ym };
}

test('ไม่ระบุว่าเดือนเก็บต่างจากเดือนชำระ → ใช้เดือนเดียวกัน', () => {
  const s = setup();
  const onlyPay = s.draft({ first_payment_month: 202703 }).data.plan;
  assert.deepEqual([onlyPay.first_saving_month, onlyPay.first_payment_month], [202703, 202703]);
  const onlySave = s.draft({ first_saving_month: 202702 }).data.plan;
  assert.deepEqual([onlySave.first_saving_month, onlySave.first_payment_month], [202702, 202702]);
  const both = s.draft({ first_saving_month: 202701, first_payment_month: 202703 }).data.plan;
  assert.deepEqual([both.first_saving_month, both.first_payment_month], [202701, 202703]);
});

test('AI: ดอกเบี้ยแบบอัตรา (ต่อเดือน/ต่อปี) แปลงเป็นยอดดอกเบี้ยรวม; ยอดดอกเบี้ยที่ระบุใช้ตามนั้น', () => {
  const s = setup();
  const base = { intent: 'PLAN', amount: 12000, installment_count: 10, item_name: 'ทีวี', category: s.appliance.category_id };
  const norm = (extra) => plain(s.ctx.AiParser.normalize({ ...base, ...extra }, 'x')).params;
  assert.equal(norm({ interest_rate: 0.8, interest_rate_period: 'MONTH' }).interest_amount, 960);
  assert.equal(norm({ interest_rate: 12, interest_rate_period: 'YEAR' }).interest_amount, 1200);
  assert.equal(norm({ interest_amount: 500, interest_rate: 0.8, interest_rate_period: 'MONTH' }).interest_amount, 500);
  assert.equal(norm({}).interest_amount, undefined);
  const d = s.draft({ interest_amount: 960 }).data;
  assert.equal(d.plan.total_amount, 12960);
  assert.match(d.summary_text, /เงินต้น 12,000\.00 \+ ดอกเบี้ย 960\.00/);
});

test('draft.create แผนผ่อน: ค่าเริ่มต้นเริ่มชำระและเก็บเงินเดือนหน้า; สรุปแสดงงวด; ยังไม่สร้างแผน', () => {
  const s = setup();
  const res = s.draft({});
  assert.equal(res.ok, true, JSON.stringify(res));
  const d = res.data;
  assert.equal(d.plan.plan_type, 'INSTALLMENT');
  assert.equal(d.plan.installment_count, 10);
  assert.equal(d.plan.first_amount, 1200);
  assert.equal(d.plan.first_payment_month, s.ym(1));
  assert.equal(d.plan.first_saving_month, s.ym(1));
  assert.equal(d.plan.account_name, 'บัตร KTC');
  assert.match(d.summary_text, /แผนผ่อนชำระ — ทีวี/);
  assert.match(d.summary_text, /10 งวด งวดละ 1,200\.00 บาท/);
  assert.match(d.summary_text, /ยังไม่บันทึกรายการซื้อด้วยบัตร/);
  assert.equal(s.rows('PaymentPlans').length, 0);
  assert.equal(JSON.parse(s.rows('ApiDrafts')[0].draft_json).kind, 'PAYMENT_PLAN');
});

test('ยืนยัน → สร้างแผน 10 งวด ยอดรวมตรงกับแผน (เศษสตางค์งวดสุดท้าย) ครั้งเดียว ไม่สร้างรายการซื้อ; ยืนยันซ้ำได้ผลเดิม', () => {
  const s = setup();
  const d = s.draft({ interest_amount: 0.03 }).data;
  const c1 = s.post('draft.confirm', { draft_id: d.draft_id, confirm_token: d.confirm_token });
  assert.equal(c1.ok, true, JSON.stringify(c1));
  assert.equal(c1.data.draft_status, 'CONFIRMED');
  assert.match(c1.data.summary_text, /^สร้างแผนแล้ว ✅/);
  const c2 = s.post('draft.confirm', { draft_id: d.draft_id, confirm_token: d.confirm_token });
  assert.equal(c2.ok, true);
  assert.equal(s.rows('PaymentPlans').length, 1);
  const schedules = s.rows('PaymentSchedules');
  assert.equal(schedules.length, 10);
  assert.equal(Math.round(schedules.reduce((sum, r) => sum + r.amount_due * 100, 0)), 1200003);
  assert.equal(schedules[9].amount_due, 1200.03, 'เศษสตางค์อยู่งวดสุดท้าย');
  assert.equal(s.rows('Transactions').length, 0);
});

test('แผนครั้งเดียว/กำหนดเดือนและวันครบกำหนด; ข้อมูลผิดถูกปฏิเสธไม่สร้างร่าง', () => {
  const s = setup();
  const one = s.draft({ item_name: 'ค่าประกันรถ', account: 'KBank', installment_count: 1, principal_amount: 8500, first_payment_month: 202703, due_day: 31 });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(one.data.plan.plan_type, 'ONE_TIME');
  assert.match(one.data.summary_text, /ชำระ มี\.ค\. 2570 วันที่ 31/);
  assert.equal(s.draft({ first_payment_month: 202613 }).code, 'VALIDATION_YEAR_MONTH_RANGE');
  assert.equal(s.draft({ category: 'ไม่มีหมวดนี้' }).code, 'VALIDATION_NOT_FOUND');
  const noCat = s.draft({ category: undefined });
  assert.equal(noCat.code, 'VALIDATION_REQUIRED');
  assert.ok(noCat.details.candidates.some((c) => c.name === 'เครื่องใช้ไฟฟ้า'));
  assert.equal(s.draft({ installment_count: 361 }).ok, false);
  assert.equal(s.draft({ budget: 'x' }).code, 'VALIDATION_UNKNOWN_FIELD');
  assert.equal(s.rows('ApiDrafts').length, 1);
});

test('LINE: ข้อความผ่อน → AI intent PLAN → Flex สรุปแผน → กดยืนยันสร้างแผน', () => {
  const s = setup();
  const replies = [];
  const aiBodies = [];
  s.ctx.__state.fetch = (url, options) => {
    const body = JSON.parse(options.payload);
    if (url === 'https://api.line.me/v2/bot/message/reply') { replies.push(body); return { code: 200, body: {} }; }
    aiBodies.push(body);
    return { code: 200, body: { choices: [{ message: { content: JSON.stringify({ intent: 'PLAN', transaction_type: null, transaction_date: null, amount: 12000,
      from_account: s.ktc.account_id, to_account: null, category: s.appliance.category_id, owner: null, item_name: 'ทีวี', description: null, note: null,
      budget: null, plan_type: 'INSTALLMENT', installment_count: 10, interest_amount: null, fee_amount: null, first_payment_month: null,
      first_saving_month: null, due_day: 25, message: null }) } }] } };
  };
  const send = (ev) => plain(s.ctx.LineWebhook.handle({ parameter: { line_key: s.apiKey }, postData: { contents: JSON.stringify({ events: [ev] }) } }));
  const r1 = send({ type: 'message', webhookEventId: '01HZZZPLAN0000000000000001', replyToken: 'rt-1', source: { type: 'user', userId: USER },
    message: { type: 'text', id: 'm1', text: 'ผ่อนทีวี 12000 10 เดือน บัตร KTC ทุกวันที่ 25' } });
  assert.deepEqual(r1.results, ['draft']);
  assert.ok(aiBodies[0].response_format.json_schema.schema.required.includes('installment_count'));
  assert.match(aiBodies[0].messages[0].content, /intent PLAN/);
  const flex = replies[0].messages[0];
  assert.match(flex.contents.body.contents[1].text, /10 งวด งวดละ 1,200\.00 บาท/);
  assert.match(flex.contents.body.contents[1].text, /ทุกวันที่ 25/);
  const r2 = send({ type: 'postback', webhookEventId: '01HZZZPLAN0000000000000002', replyToken: 'rt-2', source: { type: 'user', userId: USER },
    postback: { data: flex.contents.footer.contents[1].action.data } });
  assert.deepEqual(r2.results, ['confirmed']);
  assert.match(replies[1].messages[0].text, /^สร้างแผนแล้ว ✅/);
  const plan = s.rows('PaymentPlans')[0];
  assert.deepEqual([plan.item_name, plan.installment_count, plan.total_amount, plan.account_id, plan.due_day], ['ทีวี', 10, 12000, s.ktc.account_id, 25]);
});

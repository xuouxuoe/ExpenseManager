'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const key = () => `test-key-${String(++seq).padStart(6, '0')}`;
const ACTOR = { actorId: 'owner@example.com' };

function setup() {
  const ctx = createDbContext();
  const M = ctx.MasterData;
  const req = () => ({ idempotencyKey: key(), actor: ACTOR });
  return { ctx, M, req };
}

function throwsCode(fn, code) {
  assert.throws(fn, (err) => err.code === code, `expected ${code}`);
}

test('สร้าง Owner / Category / Account และ list เฉพาะที่ active', () => {
  const { M, req } = setup();
  const owner = M.create('owner', { owner_name: '  พ่อ  ' }, req());
  assert.equal(owner.owner_name, 'พ่อ');
  assert.equal(owner.is_active, true);
  assert.match(owner.created_at, /\+07:00$/);
  const cat = M.create('category', { category_name: 'อาหาร', category_type: 'expense', color: '#4F46E5' }, req());
  assert.equal(cat.category_type, 'EXPENSE');
  const acc = M.create('account', { account_name: 'KBank Credit', account_type: 'CREDIT_CARD', owner_id: owner.owner_id, credit_limit: '50000', due_day: 25 }, req());
  assert.equal(acc.opening_balance, 0);
  assert.equal(acc.credit_limit, 50000);
  assert.equal(acc.due_day, 25);
  const all = plain(M.listAll());
  assert.equal(all.accounts.length, 1);
  assert.equal(all.owners.length, 1);
  assert.equal(all.categories.length, 1);
});

test('ไม่รับ field ที่ client ไม่ควรกำหนด (id, is_active, created_at)', () => {
  const { M, req } = setup();
  const fakeId = '11111111-1111-4111-8111-111111111111';
  const owner = M.create('owner', { owner_name: 'แม่', owner_id: fakeId, is_active: false, created_at: '1999' }, req());
  assert.notEqual(owner.owner_id, fakeId);
  assert.equal(owner.is_active, true);
  assert.notEqual(owner.created_at, '1999');
});

test('TC-DM-07: ชื่อซ้ำ (ไม่สนตัวพิมพ์/ช่องว่าง) ถูกปฏิเสธ; Categories แยกตาม type', () => {
  const { M, req } = setup();
  M.create('owner', { owner_name: 'Dad' }, req());
  throwsCode(() => M.create('owner', { owner_name: '  dad ' }, req()), 'VALIDATION_DUPLICATE_NAME');
  M.create('category', { category_name: 'อื่น ๆ', category_type: 'EXPENSE' }, req());
  M.create('category', { category_name: 'อื่น ๆ', category_type: 'INCOME' }, req());
  throwsCode(() => M.create('category', { category_name: 'อื่น ๆ', category_type: 'EXPENSE' }, req()), 'VALIDATION_DUPLICATE_NAME');
});

test('ชื่อซ้ำกับรายการที่ปิดใช้งานแล้วสร้างได้ แต่เปิดใช้งานรายการเดิมซ้ำไม่ได้', () => {
  const { M, req } = setup();
  const old = M.create('owner', { owner_name: 'ลูก' }, req());
  M.setActive('owner', old.owner_id, false, req());
  M.create('owner', { owner_name: 'ลูก' }, req());
  throwsCode(() => M.setActive('owner', old.owner_id, true, req()), 'VALIDATION_DUPLICATE_NAME');
});

test('Accounts: กฎประเภทบัญชี', () => {
  const { M, req } = setup();
  throwsCode(() => M.create('account', { account_name: 'A', account_type: 'WALLET' }, req()), 'VALIDATION_ENUM');
  throwsCode(() => M.create('account', { account_name: 'A', account_type: 'CASH', account_subtype: 'SAVINGS' }, req()), 'VALIDATION_RULE');
  throwsCode(() => M.create('account', { account_name: 'A', account_type: 'BANK', credit_limit: 1000 }, req()), 'VALIDATION_RULE');
  throwsCode(() => M.create('account', { account_name: 'A', account_type: 'CASH', due_day: 5 }, req()), 'VALIDATION_RULE');
  throwsCode(() => M.create('account', { account_name: 'A', account_type: 'BANK', opening_balance: '-1' }, req()), 'VALIDATION_RANGE');
  throwsCode(() => M.create('account', { account_name: 'A', account_type: 'BANK', opening_date: '2569-01-01' }, req()), 'VALIDATION_DATE_RANGE');
  const savings = M.create('account', { account_name: 'ออมทรัพย์', account_type: 'BANK', account_subtype: 'savings', opening_balance: '1234.50' }, req());
  assert.equal(savings.account_subtype, 'SAVINGS');
  assert.equal(savings.opening_balance, 1234.5);
});

test('ห้ามบันทึกเลขบัตรเต็มในชื่อ/สถาบัน/หมายเหตุ แต่ 4 หลักท้ายได้', () => {
  const { M, req } = setup();
  throwsCode(() => M.create('account', { account_name: 'บัตร 4111 1111 1111 1111', account_type: 'CREDIT_CARD' }, req()), 'VALIDATION_SENSITIVE_DATA');
  throwsCode(() => M.create('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD', note: 'เลข 4111-1111-1111-1111' }, req()), 'VALIDATION_SENSITIVE_DATA');
  const ok = M.create('account', { account_name: 'KTC *1234', account_type: 'CREDIT_CARD', note: 'ตัดรอบ 20' }, req());
  assert.equal(ok.account_name, 'KTC *1234');
});

test('Account อ้างอิง owner ที่ไม่มีอยู่/ปิดใช้งาน ถูกปฏิเสธ; แต่บัญชีเดิมยังแก้ไขได้', () => {
  const { M, req } = setup();
  const owner = M.create('owner', { owner_name: 'ป้า' }, req());
  throwsCode(() => M.create('account', { account_name: 'A', account_type: 'CASH', owner_id: '22222222-2222-4222-8222-222222222222' }, req()), 'VALIDATION_FK_NOT_FOUND');
  const acc = M.create('account', { account_name: 'กระเป๋าป้า', account_type: 'CASH', owner_id: owner.owner_id }, req());
  M.setActive('owner', owner.owner_id, false, req());
  throwsCode(() => M.create('account', { account_name: 'B', account_type: 'CASH', owner_id: owner.owner_id }, req()), 'VALIDATION_FK_INACTIVE');
  const res = M.update('account', acc.account_id, { account_name: 'กระเป๋าป้า (เก่า)', account_type: 'CASH', owner_id: owner.owner_id }, req());
  assert.equal(res.row.account_name, 'กระเป๋าป้า (เก่า)');
});

test('TC-DM-04: เปลี่ยนชื่อบัญชีแล้ว refresh ใน Transactions/Plans/Schedules ID ไม่เปลี่ยน และมี audit RENAME_MASTER', () => {
  const { ctx, M, req } = setup();
  const owner = M.create('owner', { owner_name: 'พ่อ' }, req());
  const cat = M.create('category', { category_name: 'ไอที', category_type: 'EXPENSE' }, req());
  const card = M.create('account', { account_name: 'KBank', account_type: 'CREDIT_CARD' }, req());
  const cash = M.create('account', { account_name: 'เงินสด', account_type: 'CASH' }, req());
  const masters = ctx.Projection.loadMasters();
  const now = '2026-11-25T00:00:00+07:00';
  ctx.Database.appendRows('Transactions', [ctx.Projection.apply('Transactions', {
    transaction_id: ctx.Util.uuid(), transaction_date: '2026-11-25', transaction_type: 'CREDIT_PAYMENT',
    from_account_id: cash.account_id, to_account_id: card.account_id, owner_id: owner.owner_id, category_id: '',
    item_name: 'จ่ายบัตร', amount: 100, source: 'MANUAL', created_at: now, updated_at: now
  }, masters)]);
  const plan = ctx.Projection.apply('PaymentPlans', {
    plan_id: ctx.Util.uuid(), plan_type: 'ONE_TIME', account_id: card.account_id, owner_id: owner.owner_id, category_id: cat.category_id,
    item_name: 'หูฟัง', principal_amount: 100, interest_amount: 0, fee_amount: 0, total_amount: 100, installment_count: 1,
    first_saving_month: 202611, first_payment_month: 202612, plan_status: 'ACTIVE', created_at: now, updated_at: now
  }, masters);
  ctx.Database.appendRows('PaymentPlans', [plan]);
  ctx.Database.appendRows('PaymentSchedules', [ctx.Projection.applyPlanToSchedule({
    schedule_id: ctx.Util.uuid(), plan_id: plan.plan_id, installment_no: 1, saving_month: 202611, payment_month: 202612,
    amount_due: 100, note: 'หมายเหตุงวด', created_at: now, updated_at: now
  }, plan, masters)]);

  const res = M.update('account', card.account_id, { account_name: 'KBank Platinum', account_type: 'CREDIT_CARD' }, req());
  assert.equal(res.row.account_id, card.account_id);
  assert.ok(res.projection.changedColumns >= 3);
  const tx = ctx.Database.readAll('Transactions').rows[0];
  assert.equal(tx.to_account_name, 'KBank Platinum');
  assert.equal(tx.from_account_name, 'เงินสด');
  assert.equal(tx.updated_at, now);
  assert.equal(ctx.Database.readAll('PaymentPlans').rows[0].account_name, 'KBank Platinum');
  const sch = ctx.Database.readAll('PaymentSchedules').rows[0];
  assert.equal(sch.account_name, 'KBank Platinum');
  assert.equal(sch.note, 'หมายเหตุงวด');
  const audits = ctx.Database.readAll('AuditLogs').rows.filter((a) => a.action === 'RENAME_MASTER');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].entity_id, card.account_id);

  // TC-DM-05: เปลี่ยนชื่อหมวดหมู่และเจ้าของ
  M.update('category', cat.category_id, { category_name: 'อุปกรณ์ไอที', category_type: 'EXPENSE' }, req());
  M.update('owner', owner.owner_id, { owner_name: 'คุณพ่อ' }, req());
  const sch2 = ctx.Database.readAll('PaymentSchedules').rows[0];
  assert.equal(sch2.category_name, 'อุปกรณ์ไอที');
  assert.equal(sch2.owner_name, 'คุณพ่อ');
  assert.equal(ctx.Database.readAll('Transactions').rows[0].owner_name, 'คุณพ่อ');

  // เปลี่ยนประเภทบัญชี/หมวดที่ถูกใช้แล้วไม่ได้
  throwsCode(() => M.update('account', card.account_id, { account_name: 'KBank Platinum', account_type: 'BANK' }, req()), 'VALIDATION_RULE');
  throwsCode(() => M.update('category', cat.category_id, { category_name: 'อุปกรณ์ไอที', category_type: 'INCOME' }, req()), 'VALIDATION_RULE');
});

test('เปลี่ยนประเภทได้เมื่อยังไม่มีการอ้างอิง', () => {
  const { M, req } = setup();
  const acc = M.create('account', { account_name: 'X', account_type: 'CASH' }, req());
  assert.equal(M.update('account', acc.account_id, { account_name: 'X', account_type: 'E_WALLET' }, req()).row.account_type, 'E_WALLET');
});

test('Idempotency: retry create ด้วย key เดิมไม่สร้างซ้ำ; key เดิม payload ต่างถูกปฏิเสธ', () => {
  const { ctx, M } = setup();
  const r = { idempotencyKey: 'same-key-0001', actor: ACTOR };
  const a = M.create('owner', { owner_name: 'ตา' }, r);
  const b = M.create('owner', { owner_name: 'ตา' }, r);
  assert.equal(a.owner_id, b.owner_id);
  assert.equal(ctx.Database.readAll('Owners').rows.length, 1);
  throwsCode(() => M.create('owner', { owner_name: 'ยาย' }, r), 'IDEMPOTENCY_CONFLICT');
});

test('Replay หลังล้มเหลวกลางทางของการเปลี่ยนชื่อ: ชื่อในตารางอ้างอิงถูกซ่อมเมื่อ retry (TC-DM-06)', () => {
  const { ctx, M, req } = setup();
  const owner = M.create('owner', { owner_name: 'น้า' }, req());
  const now = '2026-11-25T00:00:00+07:00';
  ctx.Database.appendRows('Transactions', [{
    transaction_id: ctx.Util.uuid(), transaction_date: '2026-11-25', transaction_type: 'INCOME', owner_id: owner.owner_id, owner_name: 'น้า',
    item_name: 'เงินเดือน', amount: 1, source: 'MANUAL', created_at: now, updated_at: now
  }]);
  const r = { idempotencyKey: 'rename-key-0001', actor: ACTOR };
  const realRefresh = ctx.Projection.refresh;
  ctx.Projection.refresh = () => { throw new Error('simulated timeout'); };
  assert.throws(() => M.update('owner', owner.owner_id, { owner_name: 'น้าชาย' }, r), /simulated timeout/);
  ctx.Projection.refresh = realRefresh;
  assert.equal(ctx.Database.readAll('Owners').rows[0].owner_name, 'น้าชาย');
  assert.equal(ctx.Database.readAll('Transactions').rows[0].owner_name, 'น้า', 'ยังค้างก่อน retry');
  M.update('owner', owner.owner_id, { owner_name: 'น้าชาย' }, r);
  assert.equal(ctx.Database.readAll('Transactions').rows[0].owner_name, 'น้าชาย');
  assert.equal(ctx.Database.readAll('OperationJournal').rows.find((j) => j.idempotency_key === 'rename-key-0001').status, 'COMMITTED');
});

test('ไม่มีฟังก์ชันลบ Master (soft delete เท่านั้น) และ type ที่ไม่รู้จักถูกปฏิเสธ', () => {
  const { M, req } = setup();
  assert.equal(typeof M.delete, 'undefined');
  throwsCode(() => M.create('budget', {}, req()), 'VALIDATION_ENUM');
});

test('API: ผู้ไม่มีสิทธิ์ได้ ok:false FORBIDDEN; ผู้มีสิทธิ์ได้ ok:true; error ภายในไม่รั่ว', () => {
  const denied = createDbContext({ activeEmail: 'x@example.com' });
  const r1 = plain(denied.api_createMaster('owner', { owner_name: 'A' }, key()));
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'FORBIDDEN');
  assert.equal(denied.Database.readAll('Owners').rows.length, 0);

  const ctx = createDbContext();
  const r2 = plain(ctx.api_createMaster('owner', { owner_name: 'A' }, key()));
  assert.equal(r2.ok, true);
  assert.equal(r2.data.owner_name, 'A');
  const r3 = plain(ctx.api_createMaster('owner', { owner_name: '' }, key()));
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'VALIDATION_REQUIRED');
  const r4 = plain(ctx.api_listMasters());
  assert.equal(r4.ok, true);
  assert.equal(r4.data.owners.length, 1);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// ค่าจาก vm context เป็นคนละ realm: แปลงเป็น plain JSON ก่อนเปรียบเทียบ
const plain = (x) => JSON.parse(JSON.stringify(x));
const { createContext, createDbContext } = require('./gas-shim');

const ACTOR = { actorId: 'owner@example.com' };
const id = (n) => String(n);

// ---------------- Auth ----------------

test('Auth: ผู้ใช้ใน ALLOWED_EMAILS ผ่าน (ไม่สนตัวพิมพ์)', () => {
  const ctx = createContext({ activeEmail: 'Wife@Example.com', properties: { ALLOWED_EMAILS: 'owner@example.com, wife@example.com' } });
  assert.equal(ctx.Auth.requireAuthorizedUser().actorId, 'wife@example.com');
});

test('Auth: fail closed เมื่อไม่มีอีเมล / ไม่อยู่ในรายชื่อ / ไม่ได้ตั้ง ALLOWED_EMAILS', () => {
  const noEmail = createContext({ activeEmail: '', properties: { ALLOWED_EMAILS: 'owner@example.com' } });
  assert.throws(() => noEmail.Auth.requireAuthorizedUser(), (e) => e.code === 'AUTH_REQUIRED');
  const stranger = createContext({ activeEmail: 'x@example.com', properties: { ALLOWED_EMAILS: 'owner@example.com' } });
  assert.throws(() => stranger.Auth.requireAuthorizedUser(), (e) => e.code === 'FORBIDDEN');
  const unset = createContext({ properties: {} });
  assert.throws(() => unset.Auth.requireAuthorizedUser(), (e) => e.code === 'FORBIDDEN');
});

test('Auth.requireOwner: ต้องเป็นเจ้าของสคริปต์', () => {
  assert.equal(createContext().Auth.requireOwner().actorId, 'owner@example.com');
  const other = createContext({ activeEmail: 'x@example.com' });
  assert.throws(() => other.Auth.requireOwner(), (e) => e.code === 'FORBIDDEN');
});

test('doGet: ผู้ไม่มีสิทธิ์ได้ข้อความปฏิเสธ ไม่ใช่หน้าแอป', () => {
  const ctx = createContext({ activeEmail: 'x@example.com', properties: { ALLOWED_EMAILS: 'owner@example.com' } });
  assert.match(ctx.doGet().html, /ไม่มีสิทธิ์/);
});

// ---------------- Util ----------------

test('Util.deterministicUuid คงที่และเป็นรูปแบบ UUID', () => {
  const { Util } = createContext();
  const a = Util.deterministicUuid('op-1', 'schedule:1');
  assert.equal(a, Util.deterministicUuid('op-1', 'schedule:1'));
  assert.notEqual(a, Util.deterministicUuid('op-1', 'schedule:2'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('Util.stableStringify ไม่ขึ้นกับลำดับ key', () => {
  const { Util } = createContext();
  assert.equal(Util.stableStringify({ b: 1, a: { d: 2, c: 3 } }), Util.stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
});

test('Util.nowIso เป็น ISO 8601 พร้อม +07:00', () => {
  assert.match(createContext().Util.nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
});

test('Util.toClientError ไม่เปิดเผยรายละเอียด error ภายใน', () => {
  const { Util } = createContext();
  const out = Util.toClientError(new Error('secret stack detail'));
  assert.equal(out.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(out.message, /secret/);
});

// ---------------- Operation ----------------

function ownerRow(ctxOp, label, name) {
  return { owner_id: ctxOp.id('Owners', label), owner_name: name, is_active: true, created_at: ctxOp.now, updated_at: ctxOp.now };
}

test('Operation: COMMITTED + audit + retry ด้วย key เดิมไม่เขียนซ้ำ (TC-TX-07, TC-PP-16)', () => {
  const ctx = createDbContext();
  let calls = 0;
  const work = (op) => { calls++; ctx.Database.appendRowsIfAbsent('Owners', [ownerRow(op, 'owner', 'พ่อ')]); return { ownerId: op.id('Owners', 'owner') }; };
  const req = { operationType: 'CREATE_OWNER', idempotencyKey: 'key-0001-abc', payload: { name: 'พ่อ' }, actor: ACTOR };
  const first = ctx.Operation.run(req, work);
  const second = ctx.Operation.run(req, work);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.result.ownerId, first.result.ownerId);
  assert.equal(calls, 1);
  assert.equal(ctx.Database.readAll('Owners').rows.length, 1);
  const journal = ctx.Database.readAll('OperationJournal').rows;
  assert.equal(journal.length, 1);
  assert.equal(journal[0].status, 'COMMITTED');
  const audits = ctx.Database.readAll('AuditLogs').rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].result, 'SUCCESS');
  assert.equal(ctx.__state.locks, 0);
});

test('Operation: key เดิมแต่ payload ต่าง ถูกปฏิเสธ (TC-PP-17)', () => {
  const ctx = createDbContext();
  const base = { operationType: 'CREATE_OWNER', idempotencyKey: 'key-0002-abc', actor: ACTOR };
  ctx.Operation.run(Object.assign({ payload: { name: 'A' } }, base), () => ({}));
  assert.throws(() => ctx.Operation.run(Object.assign({ payload: { name: 'B' } }, base), () => ({})),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT');
});

test('Operation: key เดียวกันของผู้ใช้อื่นเป็นคนละคำขอ', () => {
  const ctx = createDbContext();
  const req = (actorId) => ({ operationType: 'X', idempotencyKey: 'key-0003-abc', payload: {}, actor: { actorId } });
  assert.equal(ctx.Operation.run(req('a@example.com'), () => 1).replayed, false);
  assert.equal(ctx.Operation.run(req('b@example.com'), () => 2).replayed, false);
});

test('Operation: ล้มเหลวกลางทาง → NEEDS_RECOVERY แล้ว replay ด้วย ID เดิมโดยไม่สร้างซ้ำ', () => {
  const ctx = createDbContext();
  const req = { operationType: 'CREATE_TWO', idempotencyKey: 'key-0004-abc', payload: { n: 2 }, actor: ACTOR };
  let crash = true;
  const work = (op) => {
    ctx.Database.appendRowsIfAbsent('Owners', [ownerRow(op, 'a', 'A')]);
    if (crash) throw new Error('simulated timeout');
    ctx.Database.appendRowsIfAbsent('Owners', [ownerRow(op, 'b', 'B')]);
    return { ok: true };
  };
  assert.throws(() => ctx.Operation.run(req, work), /simulated timeout/);
  assert.equal(ctx.Database.readAll('OperationJournal').rows[0].status, 'NEEDS_RECOVERY');
  assert.equal(ctx.Operation.listPendingRecovery().length, 1);
  assert.equal(ctx.Operation.listPendingRecovery()[0].recovery_data, undefined);
  assert.equal(ctx.__state.locks, 0);

  crash = false;
  const res = ctx.Operation.run(req, work);
  assert.equal(res.replayed, false);
  assert.deepEqual(plain(ctx.Database.readAll('Owners').rows.map((r) => r.owner_name)), ['A', 'B']);
  assert.equal(ctx.Database.readAll('OperationJournal').rows[0].status, 'COMMITTED');
  assert.equal(ctx.Operation.listPendingRecovery().length, 0);
});

test('Operation: validation error → FAILED และ audit FAILED', () => {
  const ctx = createDbContext();
  const req = { operationType: 'X', idempotencyKey: 'key-0005-abc', payload: {}, actor: ACTOR };
  assert.throws(() => ctx.Operation.run(req, () => ctx.Validation.toSatang('-1', 'amount')), (e) => e.code === 'VALIDATION_RANGE');
  assert.equal(ctx.Database.readAll('OperationJournal').rows[0].status, 'FAILED');
  assert.equal(ctx.Database.readAll('AuditLogs').rows[0].result, 'FAILED');
});

test('Operation: lock ไม่ว่าง → BUSY; key ไม่ถูกต้อง → ปฏิเสธ; ไม่มี actor → ปฏิเสธ', () => {
  const busy = createDbContext();
  busy.__state.lockAvailable = false;
  assert.throws(() => busy.Operation.run({ operationType: 'X', idempotencyKey: 'key-0006-abc', payload: {}, actor: ACTOR }, () => 1),
    (e) => e.code === 'BUSY');
  const ctx = createDbContext();
  assert.throws(() => ctx.Operation.run({ operationType: 'X', idempotencyKey: 'short', payload: {}, actor: ACTOR }, () => 1),
    (e) => e.code === 'VALIDATION_IDEMPOTENCY_KEY');
  assert.throws(() => ctx.Operation.run({ operationType: 'X', idempotencyKey: 'key-0007-abc', payload: {} }, () => 1),
    (e) => e.code === 'AUTH_REQUIRED');
});

// ---------------- Projection ----------------

function seedMasters(ctx) {
  const now = '2026-11-25T00:00:00+07:00';
  ctx.Database.appendRows('Accounts', [
    { account_id: id(1), account_name: 'KBank Credit', account_type: 'CREDIT_CARD', opening_balance: 0, is_active: true, created_at: now, updated_at: now },
    { account_id: id(2), account_name: 'เงินสด', account_type: 'CASH', opening_balance: 0, is_active: true, created_at: now, updated_at: now },
    { account_id: id(3), account_name: 'บัตรเก่า', account_type: 'CREDIT_CARD', opening_balance: 0, is_active: false, created_at: now, updated_at: now }
  ]);
  ctx.Database.appendRows('Owners', [{ owner_id: id(11), owner_name: 'พ่อ', is_active: true, created_at: now, updated_at: now }]);
  ctx.Database.appendRows('Categories', [{ category_id: id(21), category_name: 'ไอที', category_type: 'EXPENSE', is_active: true, created_at: now, updated_at: now }]);
  return now;
}

test('Projection.apply: เติมชื่อจาก Master และเขียนทับชื่อที่ client ส่งมา (TC-DM-01, TC-DM-02)', () => {
  const ctx = createDbContext();
  seedMasters(ctx);
  const masters = ctx.Projection.loadMasters();
  const tx = ctx.Projection.apply('Transactions', {
    from_account_id: id(2), to_account_id: '', owner_id: id(11), owner_name: 'ชื่อปลอม', category_id: id(21)
  }, masters, { requireActive: true });
  assert.equal(tx.from_account_name, 'เงินสด');
  assert.equal(tx.to_account_name, '');
  assert.equal(tx.owner_name, 'พ่อ');
  assert.equal(tx.category_name, 'ไอที');
});

test('Projection.apply: FK ไม่มีจริง / ปิดใช้งาน ถูกปฏิเสธ (TC-DM-03)', () => {
  const ctx = createDbContext();
  seedMasters(ctx);
  const masters = ctx.Projection.loadMasters();
  assert.throws(() => ctx.Projection.apply('PaymentPlans', { account_id: id(99), owner_id: id(11), category_id: id(21) }, masters),
    (e) => e.code === 'VALIDATION_FK_NOT_FOUND');
  assert.throws(() => ctx.Projection.apply('PaymentPlans', { account_id: id(3), owner_id: id(11), category_id: id(21) }, masters, { requireActive: true }),
    (e) => e.code === 'VALIDATION_FK_INACTIVE');
  const old = ctx.Projection.apply('PaymentPlans', { account_id: id(3), owner_id: id(11), category_id: id(21) }, masters);
  assert.equal(old.account_name, 'บัตรเก่า');
});

function seedPlanWithSchedules(ctx, now) {
  const masters = ctx.Projection.loadMasters();
  const plan = ctx.Projection.apply('PaymentPlans', {
    plan_id: id(31), purchase_date: '2026-11-01', plan_type: 'INSTALLMENT', account_id: id(1), owner_id: id(11), category_id: id(21),
    item_name: 'iPhone', description: 'ผ่อน 0%', principal_amount: 600, interest_amount: 0, fee_amount: 0, total_amount: 600,
    installment_count: 6, first_saving_month: 202611, first_payment_month: 202612, due_day: 25, plan_status: 'ACTIVE',
    note: 'โน้ตของแผน', created_at: now, updated_at: now
  }, masters);
  ctx.Database.appendRows('PaymentPlans', [plan]);
  const schedules = [1, 2, 3, 4, 5, 6].map((n) => ctx.Projection.applyPlanToSchedule({
    schedule_id: id(40 + n), plan_id: plan.plan_id, installment_no: n,
    saving_month: ctx.Validation.addMonths(202611, n - 1), payment_month: ctx.Validation.addMonths(202612, n - 1),
    amount_due: 100, note: '', created_at: now, updated_at: now
  }, plan, masters));
  ctx.Database.appendRows('PaymentSchedules', schedules);
  return plan;
}

test('applyPlanToSchedule: ทุกงวดได้ข้อมูลธุรกิจเดียวกับแผน แต่ note ไม่ถูกคัดลอก (TC-PP-04, TC-PP-05)', () => {
  const ctx = createDbContext();
  const now = seedMasters(ctx);
  seedPlanWithSchedules(ctx, now);
  const rows = ctx.Database.readAll('PaymentSchedules').rows;
  assert.equal(rows.length, 6);
  rows.forEach((s, i) => {
    assert.equal(s.installment_no, i + 1);
    assert.equal(s.installment_count, 6);
    assert.equal(s.account_id, id(1));
    assert.equal(s.account_name, 'KBank Credit');
    assert.equal(s.owner_name, 'พ่อ');
    assert.equal(s.category_name, 'ไอที');
    assert.equal(s.item_name, 'iPhone');
    assert.equal(s.description, 'ผ่อน 0%');
    assert.equal(s.note, '');
  });
});

test('Projection.refresh: เปลี่ยนชื่อ Master แล้วทุกตารางตรงกัน ID/updated_at/note ไม่เปลี่ยน (TC-DM-04, TC-DM-05)', () => {
  const ctx = createDbContext();
  const now = seedMasters(ctx);
  seedPlanWithSchedules(ctx, now);
  const masters = ctx.Projection.loadMasters();
  ctx.Database.appendRows('Transactions', [ctx.Projection.apply('Transactions', {
    transaction_id: id(51), transaction_date: '2026-12-25', transaction_type: 'CREDIT_PAYMENT', from_account_id: id(2), to_account_id: id(1),
    owner_id: id(11), category_id: '', item_name: 'จ่ายบัตร', amount: 100, source: 'MANUAL', created_at: now, updated_at: now
  }, masters)]);
  const schedules = ctx.Database.readAll('PaymentSchedules').rows;
  schedules[2].note = 'งวดนี้จ่ายช้า';
  ctx.Database.updateRows('PaymentSchedules', [schedules[2]]);

  const accounts = ctx.Database.readAll('Accounts').rows;
  accounts[0].account_name = 'KBank Platinum';
  ctx.Database.updateRows('Accounts', [accounts[0]]);
  const owners = ctx.Database.readAll('Owners').rows;
  owners[0].owner_name = 'คุณพ่อ';
  ctx.Database.updateRows('Owners', [owners[0]]);

  const dry = ctx.Projection.refresh({ dryRun: true });
  assert.ok(dry.tables.length > 0);
  assert.equal(ctx.Database.readAll('PaymentPlans').rows[0].account_name, 'KBank Credit');

  const report = ctx.Projection.refresh();
  assert.equal(report.orphans.length, 0);
  const tx = ctx.Database.readAll('Transactions').rows[0];
  assert.equal(tx.to_account_name, 'KBank Platinum');
  assert.equal(tx.from_account_name, 'เงินสด');
  assert.equal(tx.owner_name, 'คุณพ่อ');
  assert.equal(tx.to_account_id, id(1));
  assert.equal(tx.updated_at, now);
  const plan = ctx.Database.readAll('PaymentPlans').rows[0];
  assert.equal(plan.account_name, 'KBank Platinum');
  assert.equal(plan.updated_at, now);
  const after = ctx.Database.readAll('PaymentSchedules').rows;
  assert.ok(after.every((s) => s.account_name === 'KBank Platinum' && s.owner_name === 'คุณพ่อ' && s.updated_at === now));
  assert.equal(after[2].note, 'งวดนี้จ่ายช้า');
  assert.equal(after.filter((s) => s.note !== '').length, 1);

  const again = ctx.Projection.refresh();
  assert.equal(again.tables.length, 0, 'refresh ซ้ำต้องไม่มีอะไรเปลี่ยน (idempotent)');
});

test('Projection.refresh: แก้แผนแล้ว propagate ไปทุกงวดโดย note รายงวดยังอยู่ (TC-PP-07)', () => {
  const ctx = createDbContext();
  const now = seedMasters(ctx);
  seedPlanWithSchedules(ctx, now);
  const schedules = ctx.Database.readAll('PaymentSchedules').rows;
  schedules[2].note = 'โน้ตงวด 3';
  ctx.Database.updateRows('PaymentSchedules', [schedules[2]]);
  const plan = ctx.Database.readAll('PaymentPlans').rows[0];
  plan.item_name = 'iPhone 17 Pro';
  plan.description = 'ผ่อน 0% 6 เดือน';
  ctx.Database.updateRows('PaymentPlans', [plan]);

  ctx.Projection.refresh();
  const after = ctx.Database.readAll('PaymentSchedules').rows;
  assert.ok(after.every((s) => s.item_name === 'iPhone 17 Pro' && s.description === 'ผ่อน 0% 6 เดือน'));
  assert.equal(after[2].note, 'โน้ตงวด 3');
});

test('Projection.refresh: FK กำพร้าถูกรายงาน และไม่ลบชื่อเดิม', () => {
  const ctx = createDbContext();
  const now = seedMasters(ctx);
  ctx.Database.appendRows('Transactions', [{
    transaction_id: id(61), transaction_date: '2026-11-25', transaction_type: 'EXPENSE', from_account_id: id(98), from_account_name: 'ชื่อเดิม',
    owner_id: id(11), owner_name: 'พ่อ', item_name: 'x', amount: 1, source: 'MANUAL', created_at: now, updated_at: now
  }]);
  const report = ctx.Projection.refresh();
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0].column, 'from_account_id');
  assert.equal(ctx.Database.readAll('Transactions').rows[0].from_account_name, 'ชื่อเดิม');
});

// ---------------- Running number IDs ----------------

test('ID เป็น running number ต่อตาราง เริ่มที่ 1 และไม่ใช้เลขซ้ำแม้คำขอล้มเหลว', () => {
  const ctx = createDbContext();
  const req = (k) => ({ idempotencyKey: 'running-id-' + k, actor: ACTOR });
  const owner = ctx.MasterData.create('owner', { owner_name: 'พ่อ' }, req('owner-1'));
  const owner2 = ctx.MasterData.create('owner', { owner_name: 'แม่' }, req('owner-2'));
  const cat = ctx.MasterData.create('category', { category_name: 'อาหาร', category_type: 'EXPENSE' }, req('cat-1'));
  const acc = ctx.MasterData.create('account', { account_name: 'เงินสด', account_type: 'CASH', opening_balance: 1000 }, req('acc-1'));
  assert.deepEqual([owner.owner_id, owner2.owner_id, cat.category_id, acc.account_id], ['1', '2', '1', '1']);
  const input = { transaction_date: '2026-11-27', transaction_type: 'EXPENSE', from_account_id: acc.account_id,
    category_id: cat.category_id, owner_id: owner.owner_id, item_name: 'ข้าว', amount: 50 };
  const t1 = ctx.Transactions.create(input, req('tx-1'));
  assert.equal(t1.transaction_id, '1');
  const journal = ctx.Database.readAll('OperationJournal').rows;
  assert.deepEqual(plain(journal.map((r) => r.operation_id)), ['1', '2', '3', '4', '5']);
  assert.deepEqual(plain(ctx.Database.readAll('AuditLogs').rows.map((r) => r.audit_id)), ['1', '2', '3', '4', '5']);

  // เขียนล้มเหลวหลังจองเลข: คำขออื่นได้เลขถัดไป ส่วน retry key เดิมได้เลขเดิม ไม่ซ้ำกัน
  const append = ctx.Database.appendRowsIfAbsent;
  ctx.Database.appendRowsIfAbsent = (name, rows) => {
    if (name === 'Transactions') throw new Error('injected write error');
    return append(name, rows);
  };
  assert.throws(() => ctx.Transactions.create({ ...input, item_name: 'ค้าง' }, req('tx-pending')), /injected/);
  ctx.Database.appendRowsIfAbsent = append;
  const other = ctx.Transactions.create({ ...input, item_name: 'อื่น' }, req('tx-other'));
  assert.equal(other.transaction_id, '3');
  const retried = ctx.Transactions.create({ ...input, item_name: 'ค้าง' }, req('tx-pending'));
  assert.equal(retried.transaction_id, '2');
  const ids = ctx.Database.readAll('Transactions').rows.map((r) => r.transaction_id);
  assert.deepEqual(plain(ids), ['1', '3', '2']);
  assert.equal(new Set(ids).size, ids.length);
});

test('ตัวนับแยกตามไฟล์ Spreadsheet และเริ่มต่อจากเลขสูงสุดในตารางเมื่อยังไม่มีตัวนับ', () => {
  const ctx = createDbContext();
  ctx.Database.appendRows('Owners', [{ owner_id: '7', owner_name: 'เดิม', is_active: true, created_at: 'x', updated_at: 'x' }]);
  const owner = ctx.MasterData.create('owner', { owner_name: 'ใหม่' }, { idempotencyKey: 'running-id-seed', actor: ACTOR });
  assert.equal(owner.owner_id, '8');
  const keys = Object.keys(ctx.__props).filter((k) => k.indexOf('ID_SEQ_') === 0);
  assert.ok(keys.some((k) => /_Owners$/.test(k) && ctx.__props[k] === '8'), JSON.stringify(keys));
});

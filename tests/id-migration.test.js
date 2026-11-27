'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createDbContext } = require('./gas-shim');

const plain = (x) => JSON.parse(JSON.stringify(x));
const uuid = () => crypto.randomUUID();
const NOW = '2026-11-20T10:00:00+07:00';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ข้อมูลแบบที่สร้างก่อนเปลี่ยนเป็น running number (UUID) ปนกับข้อมูลใหม่ (ตัวเลข) */
function legacyFixture() {
  const ctx = createDbContext();
  const actor = { actorId: 'owner@example.com' };
  let n = 0;
  const req = () => ({ idempotencyKey: 'mig-seed-' + String(++n).padStart(4, '0'), actor });
  const newOwner = plain(ctx.MasterData.create('owner', { owner_name: 'แม่' }, req()));
  const newAccount = plain(ctx.MasterData.create('account', { account_name: 'บัญชีใหม่', account_type: 'BANK' }, req()));
  const ids = { o: uuid(), a: uuid(), card: uuid(), c: uuid(), p: uuid(), s: uuid(), t1: uuid(), t2: uuid(), r: uuid(), al: uuid(), sub: uuid(), b: uuid(), bc: uuid() };
  const D = ctx.Database;
  D.appendRows('Owners', [{ owner_id: ids.o, owner_name: 'พ่อ', is_active: true, created_at: NOW, updated_at: NOW }]);
  D.appendRows('Accounts', [
    { account_id: ids.a, account_name: 'KBank', account_type: 'BANK', owner_id: ids.o, opening_balance: 1000, is_active: true, created_at: NOW, updated_at: NOW },
    { account_id: ids.card, account_name: 'บัตร', account_type: 'CREDIT_CARD', owner_id: ids.o, opening_balance: 0, is_active: true, created_at: NOW, updated_at: NOW }
  ]);
  D.appendRows('SubAccounts', [{ sub_account_id: ids.sub, sub_account_name: 'ค่าบ้าน', account_id: ids.a, is_active: true, created_at: NOW, updated_at: NOW }]);
  D.appendRows('Categories', [{ category_id: ids.c, category_name: 'อาหาร', category_type: 'EXPENSE', is_active: true, created_at: NOW, updated_at: NOW }]);
  D.appendRows('PaymentPlans', [{ plan_id: ids.p, purchase_date: '2026-11-01', plan_type: 'ONE_TIME', account_id: ids.card, account_name: 'บัตร', owner_id: ids.o, owner_name: 'พ่อ',
    category_id: ids.c, category_name: 'อาหาร', item_name: 'ทีวี', principal_amount: 300, total_amount: 300, installment_count: 1, first_saving_month: 202611, first_payment_month: 202612,
    plan_status: 'ACTIVE', created_at: NOW, updated_at: NOW }]);
  D.appendRows('PaymentSchedules', [{ schedule_id: ids.s, plan_id: ids.p, account_id: ids.card, owner_id: ids.o, category_id: ids.c, item_name: 'ทีวี', installment_no: 1, installment_count: 1,
    saving_month: 202611, payment_month: 202612, amount_due: 300, created_at: NOW, updated_at: NOW }]);
  D.appendRows('Transactions', [
    { transaction_id: ids.t1, transaction_date: '2026-11-02', transaction_type: 'EXPENSE', from_account_id: ids.a, from_account_name: 'KBank', owner_id: ids.o, owner_name: 'พ่อ',
      category_id: ids.c, category_name: 'อาหาร', item_name: 'ข้าว', amount: 50, source: 'MANUAL', created_at: NOW, updated_at: NOW, from_sub_account_id: ids.sub },
    { transaction_id: ids.t2, transaction_date: '2026-11-03', transaction_type: 'EXPENSE', from_account_id: ids.a, from_account_name: 'KBank', owner_id: ids.o, owner_name: 'พ่อ',
      category_id: ids.c, category_name: 'อาหาร', item_name: 'ข้าว', amount: 50, source: 'MANUAL', reversal_of: ids.t1, created_at: NOW, updated_at: NOW }
  ]);
  D.appendRows('Reservations', [{ reservation_id: ids.r, reservation_date: '2026-11-05', schedule_id: ids.s, account_id: ids.a, action_type: 'RESERVE', amount: 100, created_at: NOW }]);
  D.appendRows('PaymentAllocations', [{ allocation_id: ids.al, transaction_id: ids.t1, schedule_id: ids.s, allocated_amount: 50, created_at: NOW }]);
  D.appendRows('Budgets', [{ budget_id: ids.b, budget_month: 202611, budget_name: 'กิน', owner_id: ids.o, owner_name: 'พ่อ', amount: 5000, is_active: true, created_at: NOW, updated_at: NOW }]);
  D.appendRows('BudgetCategories', [{ budget_category_id: ids.bc, budget_id: ids.b, category_id: ids.c, category_name: 'อาหาร', created_at: NOW }]);
  D.appendRows('Settings', [
    { setting_key: 'account.display_name.' + ids.a, setting_value: 'กสิกร', updated_at: NOW },
    { setting_key: 'plan.star.' + 'ab'.repeat(16) + '.' + ids.p, setting_value: 'ON', updated_at: NOW }
  ]);
  D.appendRows('ApiClients', [{ client_id: '1', client_name: 'LINE', actor_id: 'owner@example.com', key_hash: 'x', scopes: 'READ,WRITE', default_account_id: ids.a, default_owner_id: ids.o, is_active: true, created_at: NOW, updated_at: NOW }]);
  D.appendRows('ApiDrafts', [{ draft_id: '1', client_id: '1', actor_id: 'owner@example.com', draft_status: 'PENDING',
    draft_json: JSON.stringify({ transaction_type: 'EXPENSE', from_account_id: ids.a, to_account_id: '', owner_id: ids.o, category_id: ids.c, amount: 1 }),
    confirm_token_hash: 'h', expires_at: NOW, created_at: NOW, updated_at: NOW }]);
  D.resetExecutionCache();
  return { ctx, ids, newOwner, newAccount };
}

const BUSINESS = ['Owners', 'Accounts', 'SubAccounts', 'Categories', 'PaymentPlans', 'PaymentSchedules', 'Transactions', 'Reservations', 'PaymentAllocations',
  'Budgets', 'BudgetCategories', 'ApiClients', 'ApiDrafts', 'Settings'];
const sheetText = (ctx, name) => JSON.stringify(ctx.__ss.getSheetByName(name).data);
const rows = (ctx, name) => plain(ctx.Database.readAll(name).rows);

test('dry run: รายงานจำนวน UUID และแถวที่จะเปลี่ยน โดยไม่เขียนข้อมูลและไม่จองเลข', () => {
  const { ctx, ids } = legacyFixture();
  const before = BUSINESS.map((n) => sheetText(ctx, n));
  const props = JSON.stringify(ctx.__props);
  const report = plain(ctx.IdMigration.run({ dryRun: true }));
  assert.equal(report.dryRun, true);
  assert.equal(report.uuidRows.Accounts, 2);
  assert.equal(report.uuidRows.Transactions, 2);
  assert.ok(report.changes.Settings >= 2);
  assert.deepEqual(report.dangling, []);
  assert.deepEqual(report.backups, []);
  assert.deepEqual(BUSINESS.map((n) => sheetText(ctx, n)), before);
  assert.equal(JSON.stringify(ctx.__props), props);
  assert.ok(sheetText(ctx, 'Accounts').includes(ids.a));
});

test('แปลงจริง: ไม่มี UUID เหลือในตารางธุรกิจ เลขใหม่ไม่ชนของเดิม FK ทุกตารางตรงกัน และสำรองชีตก่อนเขียน', () => {
  const { ctx, ids, newOwner, newAccount } = legacyFixture();
  const report = plain(ctx.IdMigration.run({ dryRun: false }));
  assert.equal(report.dryRun, false);
  assert.ok(report.backups.length >= 10);
  report.backups.forEach((b) => assert.ok(ctx.__ss.getSheetByName(b), b));
  assert.ok(sheetText(ctx, report.backups.find((b) => b.endsWith('_Accounts'))).includes(ids.a), 'ชีตสำรองเก็บค่าเดิม');
  Object.values(ids).forEach((id) => BUSINESS.forEach((n) => assert.equal(sheetText(ctx, n).includes(id), false, `${n} ยังมี ${id}`)));

  const owners = rows(ctx, 'Owners');
  const accounts = rows(ctx, 'Accounts');
  assert.deepEqual(owners.map((o) => o.owner_id), ['1', '2']);
  assert.equal(owners.find((o) => o.owner_id === newOwner.owner_id).owner_name, 'แม่');
  assert.equal(accounts.find((a) => a.account_id === newAccount.account_id).account_name, 'บัญชีใหม่');
  const kbank = accounts.find((a) => a.account_name === 'KBank');
  const card = accounts.find((a) => a.account_name === 'บัตร');
  const dad = owners.find((o) => o.owner_name === 'พ่อ');
  assert.deepEqual([kbank.account_id, card.account_id], ['2', '3']);
  assert.equal(kbank.owner_id, dad.owner_id);
  const food = rows(ctx, 'Categories')[0];
  const sub = rows(ctx, 'SubAccounts')[0];
  assert.equal(sub.account_id, kbank.account_id);
  const plan = rows(ctx, 'PaymentPlans')[0];
  assert.equal(plan.account_id, card.account_id);
  const sch = rows(ctx, 'PaymentSchedules')[0];
  assert.equal(sch.plan_id, plan.plan_id);
  const [t1, t2] = rows(ctx, 'Transactions');
  assert.equal(t1.from_account_id, kbank.account_id);
  assert.equal(t1.category_id, food.category_id);
  assert.equal(t1.from_sub_account_id, sub.sub_account_id);
  assert.equal(t2.reversal_of, t1.transaction_id);
  const res = rows(ctx, 'Reservations')[0];
  assert.deepEqual([res.schedule_id, res.account_id], [sch.schedule_id, kbank.account_id]);
  const al = rows(ctx, 'PaymentAllocations')[0];
  assert.deepEqual([al.transaction_id, al.schedule_id], [t1.transaction_id, sch.schedule_id]);
  const budget = rows(ctx, 'Budgets')[0];
  assert.equal(rows(ctx, 'BudgetCategories')[0].budget_id, budget.budget_id);
  const client = rows(ctx, 'ApiClients')[0];
  assert.deepEqual([client.default_account_id, client.default_owner_id], [kbank.account_id, dad.owner_id]);
  const draft = JSON.parse(rows(ctx, 'ApiDrafts')[0].draft_json);
  assert.deepEqual([draft.from_account_id, draft.owner_id, draft.category_id], [kbank.account_id, dad.owner_id, food.category_id]);
  const keys = rows(ctx, 'Settings').map((s) => s.setting_key);
  assert.ok(keys.includes('account.display_name.' + kbank.account_id));
  assert.ok(keys.includes('plan.star.' + 'ab'.repeat(16) + '.' + plan.plan_id));
  assert.equal(plain(ctx.MasterData.listAll({ includeInactive: true })).accounts.find((a) => a.account_id === kbank.account_id).account_name, 'กสิกร');

  // หลังแปลง: ตั้งบัญชีเริ่มต้นและบันทึกรายการด้วยบัญชีเดิมได้ และเลขใหม่ต่อจากเลขที่ใช้ไป
  const actor = { actorId: 'owner@example.com' };
  const upd = ctx.api_updateApiClient('1', { client_name: 'LINE', scopes: ['READ'], default_account_id: kbank.account_id, default_owner_id: dad.owner_id }, 'mig-after-0001');
  assert.equal(upd.ok, true, JSON.stringify(upd));
  const tx = plain(ctx.Transactions.create({ transaction_date: '2026-11-27', transaction_type: 'EXPENSE', from_account_id: kbank.account_id, owner_id: dad.owner_id,
    category_id: food.category_id, item_name: 'กาแฟ', amount: 65 }, { idempotencyKey: 'mig-after-0002', actor }));
  assert.equal(tx.transaction_id, '3');
  assert.equal(plain(ctx.MasterData.create('account', { account_name: 'ใหม่อีก', account_type: 'CASH' }, { idempotencyKey: 'mig-after-0003', actor })).account_id, '4');

  const again = plain(ctx.IdMigration.run({ dryRun: false }));
  assert.deepEqual(again.changes, {});
  assert.deepEqual(again.backups, []);
});

test('FK ที่เป็น UUID แต่ไม่พบปลายทางถูกรายงานและคงค่าเดิม', () => {
  const { ctx } = legacyFixture();
  const orphan = uuid();
  ctx.Database.appendRows('Transactions', [{ transaction_id: '99', transaction_date: '2026-11-04', transaction_type: 'EXPENSE', from_account_id: orphan, owner_id: '1',
    item_name: 'x', amount: 1, source: 'MANUAL', created_at: NOW, updated_at: NOW }]);
  ctx.Database.resetExecutionCache();
  const report = plain(ctx.IdMigration.run({ dryRun: false }));
  assert.ok(report.dangling.some((d) => d.sheet === 'Transactions' && d.column === 'from_account_id'));
  assert.ok(sheetText(ctx, 'Transactions').includes(orphan));
  assert.ok(rows(ctx, 'Transactions').every((t) => !UUID_RE.test(t.transaction_id)));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// ค่าจาก vm context เป็นคนละ realm: แปลงเป็น plain JSON ก่อนเปรียบเทียบ
const plain = (x) => JSON.parse(JSON.stringify(x));
const fs = require('fs');
const path = require('path');
const { createContext, createDbContext } = require('./gas-shim');

function canonicalFrom(file) {
  const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const block = text.split('```text')[1].split('```')[0];
  const out = {};
  block.trim().split('\n').forEach((line) => {
    const [name, cols] = line.split(':');
    out[name.trim()] = cols.split(',').map((c) => c.trim());
  });
  return out;
}

test('TC-SC-04: Config.HEADERS ตรงกับ AGENTS.md §7.1 และ docs/database-schema.md §3 และไม่มี header ซ้ำ', () => {
  const ctx = createContext();
  const headers = JSON.parse(JSON.stringify(ctx.Config.HEADERS));
  assert.deepEqual(plain(headers), canonicalFrom('AGENTS.md'));
  assert.deepEqual(plain(headers), canonicalFrom('docs/database-schema.md'));
  Object.entries(headers).forEach(([name, cols]) => assert.equal(new Set(cols).size, cols.length, name));
});

test('Config.columnKind จัดชนิดคอลัมน์ตัวเลข/boolean ถูกต้อง', () => {
  const { Config } = createContext();
  const kinds = {};
  Object.values(Config.HEADERS).flat().forEach((c) => { kinds[c] = Config.columnKind(c); });
  ['amount', 'amount_due', 'amount_saved', 'amount_reserved', 'amount_paid', 'allocated_amount', 'principal_amount',
    'interest_amount', 'fee_amount', 'total_amount', 'remaining_to_save', 'remaining_to_pay', 'opening_balance', 'credit_limit']
    .forEach((c) => assert.equal(kinds[c], 'money', c));
  ['saving_month', 'payment_month', 'first_saving_month', 'first_payment_month', 'saving_year', 'saving_month_no',
    'payment_year', 'payment_month_no', 'installment_no', 'installment_count', 'remaining_installments', 'due_day', 'statement_day']
    .forEach((c) => assert.equal(kinds[c], 'int', c));
  ['is_active', 'is_overdue', 'is_cancelled', 'is_month_different'].forEach((c) => assert.equal(kinds[c], 'bool', c));
  ['due_date', 'purchase_date', 'transaction_date', 'created_at', 'account_id', 'note', 'setting_value']
    .forEach((c) => assert.equal(kinds[c], 'text', c));
});

test('TC-SC-01: initialize บนไฟล์ว่างสร้างครบ 11 ชีต header ตรง และไม่แตะ ชีต1', () => {
  const ctx = createDbContext({ initialize: false });
  const report = ctx.Database.initialize();
  assert.equal(report.length, 11);
  assert.ok(report.every((r) => r.status === 'CREATED'));
  assert.ok(ctx.__ss.getSheetByName('ชีต1'));
  Object.entries(ctx.Config.HEADERS).forEach(([name, cols]) => {
    const sheet = ctx.__ss.getSheetByName(name);
    assert.deepEqual(plain(sheet.data[0]), plain(cols));
    assert.equal(sheet.frozen, 1);
  });
  assert.ok(ctx.Database.checkSchema().every((r) => r.status === 'OK'));
});

test('TC-SC-02: initialize ซ้ำไม่ลบหรือเขียนทับข้อมูล', () => {
  const ctx = createDbContext();
  ctx.Database.appendRows('Owners', [{ owner_id: 'o1', owner_name: 'พ่อ', is_active: true, created_at: 'x', updated_at: 'x' }]);
  const report = ctx.Database.initialize();
  assert.ok(report.every((r) => r.status === 'OK'));
  assert.equal(ctx.Database.readAll('Owners').rows[0].owner_name, 'พ่อ');
});

test('TC-SC-03: header ไม่ตรงถูกรายงาน ไม่ถูกแก้ และการอ่าน/เขียนถูกปฏิเสธ', () => {
  const ctx = createDbContext({ initialize: false });
  const sheet = ctx.__ss.insertSheet('Owners');
  sheet.data = [['owner_id', 'name', 'is_active', 'created_at', 'updated_at', 'extra']];
  const report = ctx.Database.initialize();
  const owners = report.find((r) => r.sheet === 'Owners');
  assert.equal(owners.status, 'MISMATCH');
  assert.deepEqual(plain(Array.from(owners.missing)), ['owner_name']);
  assert.deepEqual(plain(Array.from(owners.unexpected)), ['name', 'extra']);
  assert.deepEqual(plain(sheet.data[0]), ['owner_id', 'name', 'is_active', 'created_at', 'updated_at', 'extra']);
  assert.throws(() => ctx.Database.readAll('Owners'), (e) => e.code === 'SCHEMA_MISMATCH');
  assert.throws(() => ctx.Database.appendRows('Owners', [{ owner_id: 'x' }]), (e) => e.code === 'SCHEMA_MISMATCH');
});

test('TC-SC-03: ชีตที่มีอยู่แต่ว่างได้รับ header', () => {
  const ctx = createDbContext({ initialize: false });
  ctx.__ss.insertSheet('Settings');
  const report = ctx.Database.initialize();
  assert.equal(report.find((r) => r.sheet === 'Settings').status, 'HEADERS_WRITTEN');
});

test('appendRows เขียนด้วย setValues ครั้งเดียว และแปลง boolean/formula injection', () => {
  const ctx = createDbContext();
  const sheet = ctx.__ss.getSheetByName('Owners');
  const before = sheet.calls.setValues;
  ctx.Database.appendRows('Owners', [
    { owner_id: 'o1', owner_name: '=HYPERLINK("x")', is_active: true, created_at: 'c', updated_at: 'u' },
    { owner_id: 'o2', owner_name: 'แม่', is_active: false, created_at: 'c', updated_at: 'u' }
  ]);
  assert.equal(sheet.calls.setValues - before, 1);
  assert.equal(sheet.data[1][1], '\'=HYPERLINK("x")');
  const rows = ctx.Database.readAll('Owners').rows;
  assert.equal(rows[0].owner_name, '=HYPERLINK("x")');
  assert.equal(rows[0].is_active, true);
  assert.equal(rows[1].is_active, false);
});

test('appendRowsIfAbsent ไม่สร้างแถวซ้ำเมื่อ replay', () => {
  const ctx = createDbContext();
  const rows = [{ owner_id: 'o1', owner_name: 'A', is_active: true, created_at: 'c', updated_at: 'u' }];
  assert.equal(ctx.Database.appendRowsIfAbsent('Owners', rows).appended, 1);
  const again = ctx.Database.appendRowsIfAbsent('Owners', rows);
  assert.equal(again.appended, 0);
  assert.equal(again.skipped, 1);
  assert.equal(ctx.Database.readAll('Owners').rows.length, 1);
});

test('updateRows แทนที่ตาม primary key และรวมแถวติดกันเป็น setValues เดียว', () => {
  const ctx = createDbContext();
  const make = (id, name) => ({ owner_id: id, owner_name: name, is_active: true, created_at: 'c', updated_at: 'u' });
  ctx.Database.appendRows('Owners', [make('o1', 'A'), make('o2', 'B'), make('o3', 'C')]);
  const sheet = ctx.__ss.getSheetByName('Owners');
  const before = sheet.calls.setValues;
  ctx.Database.updateRows('Owners', [make('o2', 'B2'), make('o1', 'A2')]);
  assert.equal(sheet.calls.setValues - before, 1);
  assert.deepEqual(plain(ctx.Database.readAll('Owners').rows.map((r) => r.owner_name)), ['A2', 'B2', 'C']);
  assert.throws(() => ctx.Database.updateRows('Owners', [make('nope', 'x')]), (e) => e.code === 'NOT_FOUND');
});

test('Database ต้องมี SPREADSHEET_ID และ TEST ต้องไม่ใช่ไฟล์เดียวกับ Production', () => {
  const noProps = createContext({ properties: {} });
  assert.throws(() => noProps.Database.getSpreadsheet(), (e) => e.code === 'CONFIG_MISSING');
  const same = createContext({ properties: { SPREADSHEET_ID: 'A', TEST_SPREADSHEET_ID: 'A' } });
  assert.throws(() => same.Database.useTestSpreadsheet(), (e) => e.code === 'CONFIG_INVALID');
  const ok = createContext({ properties: { SPREADSHEET_ID: 'A', TEST_SPREADSHEET_ID: 'B' } });
  ok.Database.useTestSpreadsheet();
  assert.equal(ok.Database.getSpreadsheet(), ok.__state.spreadsheets.B);
});

test('DB_TARGET: Web App ใช้ไฟล์ตาม DB_TARGET; ฟังก์ชันผู้ดูแล Production ไม่สนใจ DB_TARGET', () => {
  const props = { SPREADSHEET_ID: 'PROD', TEST_SPREADSHEET_ID: 'TEST', ALLOWED_EMAILS: 'owner@example.com' };
  const def = createContext({ properties: props });
  assert.equal(def.Database.getSpreadsheet(), def.__state.spreadsheets.PROD);

  const t = createContext({ properties: Object.assign({}, props, { DB_TARGET: 'test' }) });
  assert.equal(t.Database.currentTarget(), 'TEST');
  assert.equal(t.Database.getSpreadsheet(), t.__state.spreadsheets.TEST);
  t.Database.useProductionSpreadsheet();
  assert.equal(t.Database.getSpreadsheet(), t.__state.spreadsheets.PROD);

  const admin = createContext({ properties: Object.assign({}, props, { DB_TARGET: 'TEST' }) });
  admin.initializeDatabase();
  assert.ok(admin.__state.spreadsheets.PROD.getSheetByName('Accounts'), 'initializeDatabase ต้องเขียน Production');
  assert.equal(admin.__state.spreadsheets.TEST, undefined, 'ต้องไม่เปิดไฟล์ทดสอบ');

  const bad = createContext({ properties: Object.assign({}, props, { DB_TARGET: 'STAGING' }) });
  assert.throws(() => bad.Database.getSpreadsheet(), (e) => e.code === 'CONFIG_INVALID');
});

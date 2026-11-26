'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// ค่าจาก vm context เป็นคนละ realm: แปลงเป็น plain JSON ก่อนเปรียบเทียบ
const plain = (x) => JSON.parse(JSON.stringify(x));
const { createContext } = require('./gas-shim');

const ctx = createContext();
const V = ctx.Validation;

function throwsCode(fn, code) {
  assert.throws(fn, (err) => err.code === code, `expected ${code}`);
}

test('YYYYMM: ยอมรับ 202611 และ "202701"', () => {
  assert.equal(V.requireYearMonth(202611, 'm'), 202611);
  assert.equal(V.requireYearMonth('202701', 'm'), 202701);
});

test('YYYYMM: ปฏิเสธ 202613, 202600, 20261, 2026-11, 202611.5', () => {
  throwsCode(() => V.requireYearMonth(202613, 'm'), 'VALIDATION_YEAR_MONTH_RANGE');
  throwsCode(() => V.requireYearMonth(202600, 'm'), 'VALIDATION_YEAR_MONTH_RANGE');
  throwsCode(() => V.requireYearMonth(20261, 'm'), 'VALIDATION_YEAR_MONTH_FORMAT');
  throwsCode(() => V.requireYearMonth('2026-11', 'm'), 'VALIDATION_YEAR_MONTH_FORMAT');
  throwsCode(() => V.requireYearMonth(202611.5, 'm'), 'VALIDATION_YEAR_MONTH_FORMAT');
});

test('addMonths ข้ามปีด้วย calendar arithmetic', () => {
  assert.equal(V.addMonths(202612, 1), 202701);
  assert.equal(V.addMonths(202611, 5), 202704);
  assert.equal(V.addMonths(202701, -1), 202612);
  assert.equal(V.addMonths(202612, 13), 202801);
});

test('ตารางตัวอย่าง AGENTS §6.3: 6 งวด เก็บ 202611 ชำระ 202612', () => {
  const saving = [0, 1, 2, 3, 4, 5].map((i) => V.addMonths(202611, i));
  const payment = [0, 1, 2, 3, 4, 5].map((i) => V.addMonths(202612, i));
  assert.deepEqual(plain(saving), [202611, 202612, 202701, 202702, 202703, 202704]);
  assert.deepEqual(plain(payment), [202612, 202701, 202702, 202703, 202704, 202705]);
});

test('dueDateOf ใช้วันสุดท้ายของเดือนเมื่อเกิน และว่างเมื่อไม่ทราบวัน', () => {
  assert.equal(V.dueDateOf(202702, 31), '2027-02-28');
  assert.equal(V.dueDateOf(202802, 31), '2028-02-29');
  assert.equal(V.dueDateOf(202611, 25), '2026-11-25');
  assert.equal(V.dueDateOf(202611, ''), '');
  throwsCode(() => V.dueDateOf(202611, 32), 'VALIDATION_RANGE');
});

test('requireDate ตรวจวันที่จริงแบบ ค.ศ.', () => {
  assert.equal(V.requireDate('2026-11-25', 'd'), '2026-11-25');
  throwsCode(() => V.requireDate('2026-02-30', 'd'), 'VALIDATION_DATE_RANGE');
  throwsCode(() => V.requireDate('2569-11-25', 'd'), 'VALIDATION_DATE_RANGE');
  throwsCode(() => V.requireDate('25/11/2026', 'd'), 'VALIDATION_DATE_FORMAT');
  assert.equal(V.requireDate('', 'd', { required: false }), '');
});

test('toSatang: แปลงเงินโดยไม่ใช้ float', () => {
  assert.equal(V.toSatang('100', 'a'), 10000);
  assert.equal(V.toSatang(0.1, 'a'), 10);
  assert.equal(V.toSatang('1,234.5', 'a'), 123450);
  assert.equal(V.toSatang('333.33', 'a'), 33333);
  assert.equal(V.toSatang(0, 'a', { allowZero: true }), 0);
});

test('toSatang: ปฏิเสธค่าที่ไม่ถูกต้อง', () => {
  throwsCode(() => V.toSatang('', 'a'), 'VALIDATION_REQUIRED');
  throwsCode(() => V.toSatang('abc', 'a'), 'VALIDATION_MONEY_FORMAT');
  throwsCode(() => V.toSatang('1.234', 'a'), 'VALIDATION_MONEY_FORMAT');
  throwsCode(() => V.toSatang('1e5', 'a'), 'VALIDATION_MONEY_FORMAT');
  throwsCode(() => V.toSatang(NaN, 'a'), 'VALIDATION_TYPE');
  throwsCode(() => V.toSatang('-5', 'a'), 'VALIDATION_RANGE');
  throwsCode(() => V.toSatang(0, 'a'), 'VALIDATION_RANGE');
});

test('splitSatang: 600 บาท 6 งวด = 100 x 6', () => {
  const parts = V.splitSatang(60000, 6);
  assert.equal(parts.length, 6);
  assert.ok(parts.every((p) => p === 10000));
});

test('splitSatang: 1000 บาท 3 งวด = 333.33, 333.33, 333.34 และผลรวมตรง', () => {
  const parts = V.splitSatang(100000, 3);
  assert.deepEqual(plain(parts.map(V.fromSatang)), [333.33, 333.33, 333.34]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100000);
});

test('splitSatang: ONE_TIME 1 งวด', () => {
  assert.deepEqual(plain(V.splitSatang(12345, 1)), [12345]);
});

test('requireText: trim, ความยาว, บรรทัดเดียว', () => {
  assert.equal(V.requireText('  iPhone  ', 'item_name', { required: true, max: 200 }), 'iPhone');
  throwsCode(() => V.requireText('', 'item_name', { required: true }), 'VALIDATION_REQUIRED');
  throwsCode(() => V.requireText('x'.repeat(201), 'item_name', { max: 200 }), 'VALIDATION_TOO_LONG');
  throwsCode(() => V.requireText('a\nb', 'item_name', {}), 'VALIDATION_FORMAT');
  assert.equal(V.requireText('a\r\nb', 'note', { multiline: true }), 'a\nb');
});

test('Formula Injection: ข้อความขึ้นต้นด้วย = + - @ ถูกเก็บเป็นข้อความ', () => {
  for (const s of ['=SUM(A1)', '+1', '-2', '@x', '\tx']) {
    assert.equal(V.sanitizeForSheet(s), "'" + s);
    assert.equal(V.unsanitizeFromSheet("'" + s), s);
  }
  assert.equal(V.sanitizeForSheet('ปกติ'), 'ปกติ');
});

test('requireId / requireEnum / requireDay', () => {
  assert.equal(V.requireId('1', 'id'), '1');
  assert.equal(V.requireId(' 42 ', 'id'), '42');
  assert.equal(V.requireId(7, 'id'), '7');
  throwsCode(() => V.requireId('0', 'id'), 'VALIDATION_FORMAT');
  throwsCode(() => V.requireId('01', 'id'), 'VALIDATION_FORMAT');
  throwsCode(() => V.requireId('1.5', 'id'), 'VALIDATION_FORMAT');
  throwsCode(() => V.requireId('3f2a1b4c-1111-4222-8333-444455556666', 'id'), 'VALIDATION_FORMAT');
  throwsCode(() => V.requireId('row-5', 'id'), 'VALIDATION_FORMAT');
  assert.equal(V.requireEnum('installment', ['INSTALLMENT'], 'plan_type'), 'INSTALLMENT');
  throwsCode(() => V.requireEnum('X', ['INSTALLMENT'], 'plan_type'), 'VALIDATION_ENUM');
  assert.equal(V.requireDay('', 'due_day'), '');
  throwsCode(() => V.requireDay(0, 'due_day'), 'VALIDATION_RANGE');
});

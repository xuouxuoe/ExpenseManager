'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createDbContext } = require('./gas-shim');

const root = path.join(__dirname, '..');
const guide = fs.readFileSync(path.join(root, 'PageApiGuide.html'), 'utf8');
const service = fs.readFileSync(path.join(root, 'IntegrationService.gs'), 'utf8');

test('คู่มือ API: action ที่เปิดใช้จริงทุกตัวแสดงเป็น "ใช้ได้" และ action ที่ยังไม่มีไม่แสดงว่าใช้ได้', () => {
  const ctx = createDbContext();
  const implemented = JSON.parse(JSON.stringify(ctx.IntegrationApi.actions()));
  const rows = [...guide.matchAll(/data-apig-action="([^"]+)" data-apig-status="(available|planned)"/g)].map((m) => ({ action: m[1], status: m[2] }));
  assert.ok(rows.length > 0);
  implemented.forEach((a) => {
    const row = rows.find((r) => r.action === a);
    assert.ok(row, `คู่มือไม่มี action ${a}`);
    assert.equal(row.status, 'available', `action ${a} เปิดใช้แล้วแต่คู่มือยังไม่แสดงว่าใช้ได้`);
  });
  rows.filter((r) => r.status === 'available').forEach((r) => {
    assert.ok(implemented.includes(r.action), `คู่มือแสดง ${r.action} ว่าใช้ได้ แต่ระบบยังไม่มี`);
  });
});

test('คู่มือ API: มีคำอธิบายรหัสข้อผิดพลาดทุกตัวที่ IntegrationApi ตอบได้', () => {
  const codes = new Set([...service.matchAll(/reject\('([A-Z_]+)'/g)].map((m) => m[1]));
  codes.add('INTERNAL_ERROR');
  const documented = new Set([...guide.matchAll(/data-apig-error="([A-Z_]+)"/g)].map((m) => m[1]));
  codes.forEach((c) => assert.ok(documented.has(c), `คู่มือไม่มีรหัส ${c}`));
});

test('คู่มือ API: ไม่มีตัวอย่าง API key จริงในหน้า', () => {
  assert.doesNotMatch(guide, /emk_[A-Za-z0-9_-]{43}/);
});

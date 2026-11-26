'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

test('ลิงก์ภายในหน้า (#...) ต้องมี target="_self" เพราะ Index.html ใช้ <base target="_top"> ใน iframe ของ Apps Script', () => {
  const offenders = [];
  htmlFiles.forEach((f) => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    (text.match(/<a\b[^>]*href="#[^"]*"[^>]*>/g) || []).forEach((tag) => {
      if (!/target="_self"/.test(tag)) offenders.push(`${f}: ${tag}`);
    });
    (text.match(/el\('a',\s*\{[^}]*href:\s*'#[^']*'[^}]*\}/g) || []).forEach((call) => {
      if (!/target:\s*'_self'/.test(call)) offenders.push(`${f}: ${call}`);
    });
  });
  assert.deepEqual(offenders, []);
});

test('include() ใน Index.html อ้างถึงเฉพาะไฟล์ที่มีอยู่และอยู่ใน whitelist ของ Code.gs', () => {
  const index = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
  const code = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const whitelist = JSON.parse(/INCLUDABLE_FILES_ = (\[[^\]]*\])/.exec(code)[1].replace(/'/g, '"'));
  const included = [...index.matchAll(/include\('(\w+)'\)/g)].map((m) => m[1]);
  included.forEach((name) => {
    assert.ok(whitelist.includes(name), `${name} ไม่อยู่ใน INCLUDABLE_FILES_`);
    assert.ok(fs.existsSync(path.join(ROOT, `${name}.html`)), `${name}.html ไม่มีอยู่`);
  });
});

test('ไม่มี HTML id ซ้ำกันข้ามไฟล์ที่ถูกรวมเป็นหน้าเดียว', () => {
  const ids = {};
  htmlFiles.forEach((f) => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    [...text.matchAll(/\sid="([^"]+)"/g)].forEach((m) => { (ids[m[1]] = ids[m[1]] || []).push(f); });
  });
  const dupes = Object.entries(ids).filter(([, files]) => files.length > 1);
  assert.deepEqual(dupes, []);
});

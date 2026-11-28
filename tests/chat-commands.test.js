'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');

test('ChatCommands: ทำคำให้เป็นรูปเดียวกัน (/คำสั่ง, @ชื่อบอท, ตัวพิมพ์, ช่องว่าง)', () => {
  const { ChatCommands } = createDbContext();
  assert.equal(ChatCommands.normalize('/Summary@my_bot'), 'summary');
  assert.equal(ChatCommands.normalize('  ยอด เงิน '), 'ยอดเงิน');
  assert.equal(ChatCommands.find('/balance').result, 'balances');
  assert.equal(ChatCommands.find('ล่าสุด').result, 'recent');
  assert.equal(ChatCommands.find('กาแฟ 65'), null);
  ['', 'วิธีใช้', '/start', '/help@my_bot', 'HELP', '?'].forEach((w) => assert.equal(ChatCommands.isHelp(w), true, w));
  assert.equal(ChatCommands.isHelp('กาแฟ 65'), false);
});

test('ChatCommands: ข้อความวิธีใช้สร้างจากรายการคำสั่งเดียว และต้องมีสิทธิ์ READ', () => {
  const { ChatCommands } = createDbContext();
  const help = ChatCommands.helpText();
  ['สรุป', 'ยอดเงิน', 'ล่าสุด', 'งบ'].forEach((w) => assert.match(help, new RegExp('• ' + w + ' — ')));
  assert.match(help, /รอยืนยัน/);
  assert.throws(() => ChatCommands.run(ChatCommands.find('สรุป'), { scopes: ['WRITE'] }), /READ/);
});

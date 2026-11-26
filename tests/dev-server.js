'use strict';
/**
 * Local preview server — ใช้พัฒนาหน้าจอเท่านั้น (ไม่ถูก push ขึ้น Apps Script)
 * - render Index.html แบบเดียวกับ HtmlService template (<?!= include('X'); ?>)
 * - จำลอง google.script.run ให้เรียกฟังก์ชัน api_* ของโค้ด .gs จริงผ่าน HTTP
 * - ข้อมูลเก็บใน FakeSpreadsheet ในหน่วยความจำ (ข้อมูลจำลองเท่านั้น ไม่เชื่อมต่อ Google)
 *
 * ใช้: node tests/dev-server.js [port]   (ค่าเริ่มต้น 5178)
 * ตัวเลือก env: DEV_DELAY_MS (หน่วงเวลาตอบกลับ), DEV_FAIL_RATE (0–1 สุ่มให้ล้มเหลวแบบเครือข่าย)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createDbContext } = require('./gas-shim');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 5178);
const DELAY = Number(process.env.DEV_DELAY_MS || 350);
const FAIL_RATE = Number(process.env.DEV_FAIL_RATE || 0);

const ctx = createDbContext();

function seed() {
  const actor = { actorId: 'owner@example.com' };
  let n = 0;
  const req = () => ({ idempotencyKey: `seed-key-${String(++n).padStart(4, '0')}`, actor });
  const M = ctx.MasterData;
  const dad = M.create('owner', { owner_name: 'พ่อ' }, req());
  M.create('owner', { owner_name: 'แม่' }, req());
  M.create('account', { account_name: 'เงินสด', account_type: 'CASH', owner_id: dad.owner_id }, req());
  M.create('account', { account_name: 'ออมทรัพย์ SCB *1234', account_type: 'BANK', account_subtype: 'SAVINGS', institution: 'SCB', opening_balance: '15000' }, req());
  M.create('account', { account_name: 'KBank Credit *5678', account_type: 'CREDIT_CARD', institution: 'KBank', credit_limit: '50000', statement_day: 20, due_day: 5 }, req());
  const food = M.create('category', { category_name: 'อาหาร', category_type: 'EXPENSE', icon: '🍜', color: '#fde68a' }, req());
  const salary = M.create('category', { category_name: 'เงินเดือน', category_type: 'INCOME', icon: '💼', color: '#bbf7d0' }, req());
  const accounts = ctx.Database.readAll('Accounts').rows;
  const byName = (n) => accounts.find((a) => a.account_name === n).account_id;
  const today = ctx.Util.todayIso();
  const month = today.slice(0, 8);
  const T = ctx.Transactions;
  T.create({ transaction_date: month + '01', transaction_type: 'INCOME', to_account_id: byName('ออมทรัพย์ SCB *1234'), category_id: salary.category_id, owner_id: dad.owner_id, item_name: 'เงินเดือน', amount: '30000' }, req());
  T.create({ transaction_date: today, transaction_type: 'EXPENSE', from_account_id: byName('เงินสด'), category_id: food.category_id, owner_id: dad.owner_id, item_name: 'ข้าวมันไก่', amount: '55' }, req());
  const monthsAgo = (n) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 8) + '05'; };
  [2, 1, 0].forEach((n) => T.create({ transaction_date: monthsAgo(n), transaction_type: 'EXPENSE', from_account_id: byName('ออมทรัพย์ SCB *1234'), category_id: food.category_id, owner_id: dad.owner_id, item_name: 'ค่าอินเทอร์เน็ต', amount: n ? '599' : '649' }, req()));
  [3, 2, 1].forEach((d) => T.create({ transaction_date: month + String(d).padStart(2, '0'), transaction_type: 'EXPENSE', from_account_id: byName('เงินสด'), category_id: food.category_id, owner_id: dad.owner_id, item_name: 'กาแฟ', amount: '65' }, req()));
  T.create({ transaction_date: today, transaction_type: 'CREDIT_PURCHASE', from_account_id: byName('KBank Credit *5678'), category_id: food.category_id, owner_id: dad.owner_id, item_name: 'ซูเปอร์มาร์เก็ต', amount: '1250.75' }, req());
}
if (!process.env.DEV_EMPTY) seed();

function renderTemplate(name, depth = 0) {
  if (depth > 5) throw new Error('include depth exceeded');
  const html = fs.readFileSync(path.join(ROOT, `${name}.html`), 'utf8');
  return html.replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, inc) => renderTemplate(inc, depth + 1));
}

const MOCK_RUN = `<script>
  // DEV ONLY: จำลอง google.script.run
  window.google = { script: { run: (function () {
    function make(success, failure) {
      return new Proxy({}, { get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (fn) { return make(fn, failure); };
        if (prop === 'withFailureHandler') return function (fn) { return make(success, fn); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/api/' + prop, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) { success && success(d); }, function (e) { failure && failure(e); });
        };
      } });
    }
    return make(null, null);
  })() } };
</script>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    const page = renderTemplate('Index').replace('<head>', '<head>' + MOCK_RUN);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  const m = /^\/api\/(api_\w+)$/.exec(req.url);
  if (req.method === 'POST' && m) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      setTimeout(() => {
        if (Math.random() < FAIL_RATE) { res.writeHead(503); res.end(); return; }
        const fn = ctx[m[1]];
        if (typeof fn !== 'function') { res.writeHead(404); res.end(); return; }
        try {
          const result = fn.apply(null, JSON.parse(body || '[]'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500); res.end(String(e && e.message));
        }
      }, DELAY);
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Expense Manager dev preview: http://localhost:${PORT} (ข้อมูลจำลองในหน่วยความจำ)`);
});

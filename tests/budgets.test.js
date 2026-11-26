'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDbContext } = require('./gas-shim');
const plain = (v) => JSON.parse(JSON.stringify(v));

function fixture(options = {}) {
  const ctx = createDbContext();
  if (options.withoutBudgetSheets) {
    // Same as Production before this release: the two new sheets do not exist yet.
    ctx.__ss.sheets = ctx.__ss.sheets.filter((s) => s.name !== 'Budgets' && s.name !== 'BudgetCategories');
    ctx.Database.resetExecutionCache();
  }
  const create = (type, input, suffix) => ctx.MasterData.create(type, input,
    { actor: { actorId: 'owner@example.com' }, idempotencyKey: 'budget-seed-' + suffix });
  const ids = {
    dad: create('owner', { owner_name: 'พ่อ' }, 'dad'),
    mom: create('owner', { owner_name: 'แม่' }, 'mom'),
    bank: create('account', { account_name: 'ธนาคาร', account_type: 'BANK', opening_balance: 20000 }, 'bank'),
    card: create('account', { account_name: 'บัตร', account_type: 'CREDIT_CARD' }, 'card'),
    food: create('category', { category_name: 'อาหาร', category_type: 'EXPENSE' }, 'food'),
    travel: create('category', { category_name: 'เดินทาง', category_type: 'EXPENSE' }, 'travel'),
    rent: create('category', { category_name: 'ค่าเช่า', category_type: 'EXPENSE' }, 'rent'),
    salary: create('category', { category_name: 'เงินเดือน', category_type: 'INCOME' }, 'salary')
  };
  let n = 0;
  const spend = (date, amount, category = ids.food, owner = ids.dad, type = 'EXPENSE') => {
    const res = ctx.api_createTransaction({ transaction_date: date, transaction_type: type,
      from_account_id: type === 'CREDIT_PURCHASE' ? ids.card.account_id : ids.bank.account_id,
      owner_id: owner.owner_id, category_id: category.category_id, item_name: 'จ่าย ' + (++n), amount, allow_duplicate: true }, 'budget-tx-' + n);
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.data;
  };
  const save = (input, key) => ctx.api_saveBudget({ budget_month: 202611, budget_name: 'ค่าใช้จ่ายรายวัน', amount: 5000, weekly_amount: 1200,
    category_ids: [ids.food.category_id, ids.travel.category_id], ...input }, key);
  return { ctx, ids, spend, save };
}

const satang = (x) => Math.round(x * 100);

test('แบ่งสัปดาห์: พ.ย. 5,000 สัปดาห์ละ 1,200 สัปดาห์สุดท้ายได้ 200, ก.พ. 28 วัน 4 สัปดาห์, ไม่ระบุรายสัปดาห์แบ่งตามจำนวนวัน', () => {
  const { ctx } = fixture();
  const weeks = (ym, amount, weekly) => plain(ctx.Budgets.weeksOf(ym, satang(amount), satang(weekly))).map((w) => [w.start, w.end, w.alloc / 100]);
  assert.deepEqual(weeks(202611, 5000, 1200), [[1, 7, 1200], [8, 14, 1200], [15, 21, 1200], [22, 28, 1200], [29, 30, 200]]);
  assert.deepEqual(weeks(202602, 5000, 1200).map((w) => w[2]), [1200, 1200, 1200, 1400]);
  assert.deepEqual(weeks(202611, 1000, 400).map((w) => w[2]), [400, 400, 200, 0, 0]);
  const even = weeks(202611, 3000, 0).map((w) => w[2]);
  assert.equal(even.reduce((s, v) => s + v, 0), 3000);
  assert.deepEqual(even, [700, 700, 700, 700, 200]);
});

test('ยกยอดข้ามสัปดาห์และยอดต่อวัน: วันที่ 10 พ.ย. สัปดาห์ 1 ใช้ 1,000 สัปดาห์ 2 มี 1,400 ใช้ไป 600 เหลือ 800 วันละ 160', () => {
  const f = fixture();
  assert.equal(f.save({}, 'budget-create').ok, true);
  f.spend('2026-11-03', 1000);
  f.spend('2026-11-09', 500, f.ids.travel);
  f.spend('2026-11-09', 300, f.ids.rent);                       // หมวดที่ไม่อยู่ในงบ
  f.spend('2026-11-10', 100, f.ids.food, f.ids.dad, 'CREDIT_PURCHASE'); // ซื้อด้วยบัตรนับเป็นรายจ่าย
  const [b] = plain(f.ctx.Budgets.list(202611, { today: '2026-11-10' }));
  assert.equal(b.spent, 1600);
  assert.equal(b.remaining, 3400);
  assert.equal(b.current_week, 2);
  assert.deepEqual([b.weeks[0].spent, b.weeks[0].remaining], [1000, 200]);
  assert.deepEqual([b.weeks[1].carry_in, b.weeks[1].available, b.weeks[1].spent, b.weeks[1].remaining], [200, 1400, 600, 800]);
  assert.equal(b.week_remaining, 800);
  assert.equal(b.week_days_left, 5);
  assert.equal(b.per_day_week, 160);
  assert.equal(b.month_days_left, 21);
  assert.equal(b.per_day_month, 161.9);
});

test('ใช้เกินสัปดาห์ลดงบสัปดาห์ถัดไป, กลับรายการคืนยอด, และกรองตามเจ้าของ', () => {
  const f = fixture();
  assert.equal(f.save({ owner_id: f.ids.dad.owner_id }, 'budget-dad').ok, true);
  const big = f.spend('2026-11-02', 1500);
  f.spend('2026-11-05', 999, f.ids.food, f.ids.mom);              // แม่ ไม่นับในงบของพ่อ
  // ใช้เกินในสัปดาห์ปัจจุบัน: ยอดเหลือติดลบ และใช้ได้วันละเป็น 0 (ไม่ error)
  const during = plain(f.ctx.Budgets.list(202611, { today: '2026-11-03' }))[0];
  assert.equal(during.week_remaining, -300);
  assert.equal(during.per_day_week, 0);
  let [b] = plain(f.ctx.Budgets.list(202611, { today: '2026-11-09' }));
  assert.equal(b.spent, 1500);
  assert.deepEqual([b.weeks[1].carry_in, b.weeks[1].available], [-300, 900]);
  const rev = f.ctx.api_reverseTransaction(big.transaction_id || big.row.transaction_id, { reason: 'บันทึกผิด', transaction_date: '2026-11-09' }, 'budget-reverse');
  assert.equal(rev.ok, true, JSON.stringify(rev));
  [b] = plain(f.ctx.Budgets.list(202611, { today: '2026-11-09' }));
  assert.equal(b.spent, 0);
  assert.equal(b.week_remaining, 2400);
});

test('แก้งบ: แก้ยอดแก้ในแถวเดิม, เปลี่ยนหมวดปิดงบเดิมแล้วสร้างงบใหม่, retry ไม่ซ้ำ, ตรวจข้อมูลผิด', () => {
  const f = fixture();
  const created = f.save({}, 'budget-edit-create');
  const id = created.data.result.budget_id;
  const amountOnly = f.save({ budget_id: id, amount: 6000 }, 'budget-edit-amount');
  assert.equal(amountOnly.data.result.budget_id, id);
  assert.equal(amountOnly.data.page.budgets[0].amount, 6000);
  const input = { budget_id: id, amount: 6000, category_ids: [f.ids.food.category_id] };
  const changed = f.save(input, 'budget-edit-cats');
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.notEqual(changed.data.result.budget_id, id);
  assert.equal(f.save(input, 'budget-edit-cats').data.result.budget_id, changed.data.result.budget_id);
  const rows = plain(f.ctx.Database.readAll('Budgets').rows);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.is_active).sort(), [false, true]);
  const page = plain(f.ctx.Budgets.list(202611));
  assert.equal(page.length, 1);
  assert.deepEqual(page[0].categories.map((c) => c.category_name), ['อาหาร']);
  const bad = [
    [{ category_ids: [] }, /อย่างน้อยหนึ่งหมวด/],
    [{ category_ids: [f.ids.salary.category_id] }, /หมวดรายจ่าย/],
    [{ weekly_amount: 9000 }, /ไม่เกินงบทั้งเดือน/],
    [{ amount: 0 }, /.+/],
    [{ budget_month: 202613 }, /.+/]
  ];
  bad.forEach(([patch, message], i) => {
    const res = f.save(patch, 'budget-bad-' + i);
    assert.equal(res.ok, false, JSON.stringify(patch));
    assert.match(res.message, message);
  });
  const off = f.ctx.api_setBudgetActive(changed.data.result.budget_id, false, 'budget-off', 202611);
  assert.equal(off.ok, true);
  assert.equal(off.data.page.budgets.length, 0);
});

test('เปลี่ยนชื่อหมวดและเจ้าของ refresh ชื่อในงบ และคัดลอกงบไปเดือนถัดไปข้ามชื่อที่มีแล้ว', () => {
  const f = fixture();
  assert.equal(f.save({ owner_id: f.ids.dad.owner_id }, 'budget-rename').ok, true);
  assert.equal(f.ctx.api_updateMaster('category', f.ids.food.category_id, { ...plain(f.ids.food), category_name: 'อาหารและเครื่องดื่ม' }, 'budget-rename-cat').ok, true);
  assert.equal(f.ctx.api_updateMaster('owner', f.ids.dad.owner_id, { owner_name: 'คุณพ่อ' }, 'budget-rename-owner').ok, true);
  const [b] = plain(f.ctx.Budgets.list(202611));
  assert.equal(b.owner_name, 'คุณพ่อ');
  assert.ok(b.categories.some((c) => c.category_name === 'อาหารและเครื่องดื่ม'));
  const copy = f.ctx.api_copyBudgets(202611, 202612, 'budget-copy');
  assert.equal(copy.ok, true, JSON.stringify(copy));
  assert.equal(copy.data.result.copied, 1);
  assert.equal(copy.data.page.budgets[0].budget_month, 202612);
  assert.equal(f.ctx.api_copyBudgets(202611, 202612, 'budget-copy-again').data.result.copied, 0);
});

test('ยังไม่มีชีตงบ: หน้าอ่านได้เป็นรายการว่าง และบันทึกงบครั้งแรกสร้างชีตพร้อม header', () => {
  const f = fixture({ withoutBudgetSheets: true });
  assert.equal(f.ctx.__ss.getSheetByName('Budgets'), null);
  const page = f.ctx.api_budgetPage(202611);
  assert.equal(page.ok, true, JSON.stringify(page));
  assert.deepEqual(plain(page.data.budgets), []);
  assert.equal(f.ctx.api_dashboard({ year: 2026 }).ok, true);
  assert.equal(f.ctx.api_updateMaster('owner', f.ids.dad.owner_id, { owner_name: 'คุณพ่อ' }, 'budget-missing-rename').ok, true);
  const res = f.save({}, 'budget-first');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(plain(f.ctx.__ss.getSheetByName('Budgets').data[0]), plain(f.ctx.Config.HEADERS.Budgets));
  assert.deepEqual(plain(f.ctx.__ss.getSheetByName('BudgetCategories').data[0]), plain(f.ctx.Config.HEADERS.BudgetCategories));
  assert.equal(res.data.page.budgets.length, 1);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createContext, createDbContext } = require('./gas-shim');
const plain = (v) => JSON.parse(JSON.stringify(v));

// One-shot outage at each physical write. "after" models a write whose reply was lost.
// sustained=true: the outage continues for every later write, including the error/journal path.
function writes(ctx, failAt = Infinity, timing = 'before', sustained = false) {
  const calls = [];
  let fired = false;
  const restores = ctx.__ss.getSheets().map((sheet) => {
    const original = sheet.getRange;
    sheet.getRange = function (...args) {
      const range = original.apply(this, args);
      const set = range.setValues;
      range.setValues = function (values) {
        calls.push(sheet.name);
        const fail = sustained ? calls.length >= failAt : !fired && calls.length === failAt;
        if (fail) fired = true;
        if (fail && timing === 'before') throw new Error('Injected outage before ' + sheet.name);
        const result = set.call(this, values);
        if (fail) throw new Error('Injected lost reply after ' + sheet.name);
        return result;
      };
      return range;
    };
    return () => { sheet.getRange = original; };
  });
  return { calls, fired: () => fired, stop: () => restores.forEach((restore) => restore()) };
}

function fixture(kind) {
  const ctx = createDbContext();
  const create = (type, input, suffix = type) => ctx.MasterData.create(type, input,
    { actor: { actorId: 'owner@example.com' }, idempotencyKey: 'reliable-seed-' + suffix });
  const owner = create('owner', { owner_name: 'เจ้าของทดสอบ' });
  const cash = create('account', { account_name: 'เงินทดสอบ', account_type: 'CASH', opening_balance: 10000 });
  const second = create('account', { account_name: 'ธนาคารทดสอบ', account_type: 'BANK', opening_balance: 1000 }, 'second');
  const card = create('account', { account_name: 'บัตรทดสอบ', account_type: 'CREDIT_CARD' }, 'card');
  const category = create('category', { category_name: 'ของใช้', category_type: 'EXPENSE' });
  const date = '2026-11-26';
  const planInput = { item_name: 'ผ่อนทดสอบ', purchase_date: date, plan_type: 'INSTALLMENT',
    account_id: card.account_id, owner_id: owner.owner_id, category_id: category.category_id,
    principal_amount: 600, interest_amount: 60, fee_amount: 30, installment_count: 3,
    first_saving_month: 202611, first_payment_month: 202612, purchase_link: 'NEW' };
  const key = 'reliable-target-' + kind;
  let run;
  if (kind === 'transaction') {
    const payload = { transaction_date: date, transaction_type: 'EXPENSE', from_account_id: cash.account_id,
      owner_id: owner.owner_id, category_id: category.category_id, item_name: 'รายจ่ายทดสอบ', amount: 50 };
    run = () => ctx.api_createTransaction(payload, key);
  } else if (kind === 'plan') run = () => ctx.api_createPaymentPlan(planInput, key);
  else {
    const created = ctx.api_createPaymentPlan(planInput, 'reliable-seed-plan');
    assert.equal(created.ok, true, JSON.stringify(created));
    const planId = created.data.plan_id;
    const schedules = plain(ctx.api_paymentPlannerPage()).data.plans[0].schedules;
    const apply = (payload, requestKey) => ctx.api_paymentActivity({ plan_id: planId, date, ...payload }, requestKey);
    const reserve = (account, amount, requestKey) => apply({ action: 'RESERVE', account_id: account.account_id,
      schedule_id: schedules[0].schedule_id, amount }, requestKey);
    assert.equal(reserve(cash, 60, 'reliable-seed-reserve1').ok, true);
    assert.equal(reserve(second, 40, 'reliable-seed-reserve2').ok, true);
    const pay = { action: 'PAY', account_id: cash.account_id,
      lines: [{ schedule_id: schedules[0].schedule_id, amount: 150 }] };
    if (kind === 'rename') run = () => ctx.api_updateMaster('owner', owner.owner_id, { owner_name: 'เจ้าของแก้แล้ว' }, key);
    else if (kind === 'payment') run = () => apply(pay, key);
    else if (kind === 'reverse') {
      assert.equal(apply(pay, 'reliable-seed-payment').ok, true);
      const tx = ctx.Database.readAll('Transactions').rows.find((r) => r.transaction_type === 'CREDIT_PAYMENT');
      run = () => apply({ action: 'REVERSE_PAY', transaction_id: tx.transaction_id, note: 'ทดสอบกู้คืน' }, key);
    } else if (kind === 'settle') {
      const fields = { action: 'SETTLE', account_id: cash.account_id, settlement_interest_amount: 5, settlement_fee_amount: 2, note: 'ทดสอบกู้คืนปิดยอด' };
      const quote = ctx.api_previewPaymentActivity({ plan_id: planId, date, ...fields });
      assert.equal(quote.ok, true, JSON.stringify(quote));
      run = () => apply({ ...fields, preview_version: quote.data.version }, key);
    }
  }
  return { ctx, key, run, ids: { owner, cash, second, card, category } };
}

function financialSnapshot(ctx) {
  const read = (name) => plain(ctx.Database.readAll(name).rows);
  return {
    balances: Object.values(plain(ctx.Transactions.accountBalances())).sort((a, b) => a - b),
    names: ['Owners', 'Transactions', 'PaymentPlans', 'PaymentSchedules'].map((name) => read(name).map((r) => r.owner_name)),
    plans: read('PaymentPlans').map((r) => [r.total_amount, r.plan_status, r.installment_count]),
    schedules: read('PaymentSchedules').sort((a, b) => a.installment_no - b.installment_no)
      .map((r) => [r.installment_no, r.amount_due, r.amount_saved, r.amount_reserved, r.amount_paid,
        r.remaining_to_save, r.remaining_to_pay, r.saving_status, r.payment_status, r.is_cancelled]),
    transactions: read('Transactions').map((r) => [r.transaction_type, r.amount, !!r.reversal_of]).sort(),
    reservations: read('Reservations').map((r) => [r.action_type, r.amount]).sort(),
    allocations: read('PaymentAllocations').map((r) => r.allocated_amount).sort((a, b) => a - b)
  };
}

for (const kind of ['transaction', 'plan', 'payment', 'reverse', 'settle', 'rename']) {
  test('กู้คืนทุกจุดเขียน: ' + kind + ' รวม lost response แล้ว retry key เดิมไม่สร้างยอดหรือ audit ซ้ำ', (t) => {
    const reference = fixture(kind);
    const measure = writes(reference.ctx);
    const ok = reference.run();
    measure.stop();
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const expected = financialSnapshot(reference.ctx);
    for (const timing of ['before', 'after']) {
      for (let point = 1; point <= measure.calls.length; point++) {
        const { ctx, key, run } = fixture(kind);
        const fault = writes(ctx, point, timing);
        const failed = run();
        fault.stop();
        const label = `${kind} ${timing} #${point} (${measure.calls[point - 1]})`;
        assert.equal(fault.fired(), true, label);
        assert.equal(failed.ok, false, label);
        const retry = run();
        assert.equal(retry.ok, true, label + ' ' + JSON.stringify(retry));
        assert.deepEqual(plain(run()), plain(retry), label + ' stable response');
        assert.deepEqual(financialSnapshot(ctx), expected, label + ' financial result');
        const journal = ctx.Database.readAll('OperationJournal').rows.filter((r) => r.idempotency_key === key);
        assert.equal(journal.length, 1, label);
        assert.equal(journal[0].status, 'COMMITTED', label);
        const success = ctx.Database.readAll('AuditLogs').rows.filter((r) => r.operation_id === journal[0].operation_id && r.result === 'SUCCESS' && r.entity_type === 'Operation');
        assert.equal(success.length, 1, label + ' success audit');
        if (kind === 'rename') {
          const rename = ctx.Database.readAll('AuditLogs').rows.filter((r) => r.operation_id === journal[0].operation_id && r.action === 'RENAME_MASTER');
          assert.equal(rename.length, 1, label + ' rename audit');
        }
        assert.equal(ctx.__state.locks, 0, label);
        for (const [name, pk] of Object.entries(plain(ctx.Config.PRIMARY_KEYS))) {
          const rows = ctx.Database.readAll(name).rows;
          assert.equal(new Set(rows.map((r) => r[pk])).size, rows.length, label + ' unique ' + name);
        }
      }
    }
    t.diagnostic(JSON.stringify({ scenario: kind, writePoints: measure.calls.length, injectedFailures: measure.calls.length * 2 }));
  });
}

test('สอง execution แย่ง lock: คำขอที่สองได้ BUSY แล้ว retry ได้หนึ่งรายการต่อ key', () => {
  const sharedLock = { held: false };
  const first = createDbContext({ sharedLock });
  // สอง execution ใช้ Script Properties ชุดเดียวกัน (ตัวนับ running number อยู่ในนั้น)
  const second = createContext({ sharedLock, sharedProperties: first.__props });
  second.Database.setSpreadsheetForTesting(first.__ss);
  const req = (key) => ({ operationType: 'LOCK_TEST', actor: { actorId: 'owner@example.com' }, idempotencyKey: key, payload: {} });
  let nested = 0;
  const other = () => second.Operation.run(req('reliable-lock-second'), (op) => {
    nested++;
    second.Database.appendRowsIfAbsent('Owners', [{ owner_id: op.id('Owners', 'owner'), owner_name: 'สอง', is_active: true }]);
    return 'second';
  });
  first.Operation.run(req('reliable-lock-first'), (op) => {
    assert.throws(other, (e) => e.code === 'BUSY');
    assert.equal(nested, 0);
    first.Database.appendRowsIfAbsent('Owners', [{ owner_id: op.id('Owners', 'owner'), owner_name: 'หนึ่ง', is_active: true }]);
    return 'first';
  });
  assert.equal(other().result, 'second');
  assert.equal(other().replayed, true);
  first.Database.resetExecutionCache();
  assert.equal(first.Database.readAll('Owners').rows.length, 2);
  assert.equal(first.__state.locks + second.__state.locks, 0);
  assert.equal(sharedLock.held, false);
});

test('retry งาน COMMITTED รุ่นเก่าที่ขาด Audit ซ่อมเฉพาะประวัติ และยอมรับ Audit ID แบบเดิม', () => {
  const { ctx, key, run } = fixture('transaction');
  assert.equal(run().ok, true);
  const journal = ctx.Database.readAll('OperationJournal').rows.find((r) => r.idempotency_key === key);
  const auditSheet = ctx.__ss.getSheetByName('AuditLogs');
  const operationColumn = ctx.Config.HEADERS.AuditLogs.indexOf('operation_id');
  // Disposable fixture only: emulate a committed record from the previous implementation.
  auditSheet.data = auditSheet.data.filter((row, i) => i === 0 || row[operationColumn] !== journal.operation_id);
  ctx.Database.resetExecutionCache();
  const before = financialSnapshot(ctx);
  assert.equal(run().ok, true);
  assert.deepEqual(financialSnapshot(ctx), before);
  const audit = ctx.Database.readAll('AuditLogs').rows.find((r) => r.operation_id === journal.operation_id);
  assert.ok(audit);
  const auditRow = ctx.Database.findRowsByValue('AuditLogs', 'audit_id', audit.audit_id)[0].rowNumber;
  audit.audit_id = ctx.Util.uuid();
  ctx.Database.writeRowAt('AuditLogs', auditRow, audit);
  assert.equal(run().ok, true);
  assert.equal(ctx.Database.readAll('AuditLogs').rows.filter((r) => r.operation_id === journal.operation_id).length, 1);
});

function assertCommittedOnce(ctx, key, label) {
  const journal = ctx.Database.readAll('OperationJournal').rows.filter((r) => r.idempotency_key === key);
  assert.equal(journal.length, 1, label + ' journal');
  assert.equal(journal[0].status, 'COMMITTED', label + ' status');
  const success = ctx.Database.readAll('AuditLogs').rows.filter((r) => r.operation_id === journal[0].operation_id &&
    r.result === 'SUCCESS' && r.entity_type === 'Operation');
  assert.equal(success.length, 1, label + ' success audit');
  assert.equal(ctx.__state.locks, 0, label + ' lock');
  for (const [name, pk] of Object.entries(plain(ctx.Config.PRIMARY_KEYS))) {
    const rows = ctx.Database.readAll(name).rows;
    assert.equal(new Set(rows.map((r) => r[pk])).size, rows.length, label + ' unique ' + name);
  }
}

/** Every *_name projection must match the current master name for its *_id. */
function assertProjectionsCurrent(ctx, label) {
  ctx.Database.resetExecutionCache();
  const masters = plain(ctx.Projection.loadMasters());
  for (const [sheet, specs] of Object.entries(plain(ctx.Config.NAME_PROJECTIONS))) {
    for (const row of ctx.Database.readAll(sheet).rows) {
      for (const [idCol, nameCol, key] of specs) {
        if (!row[idCol]) continue;
        assert.equal(row[nameCol], masters[key][row[idCol]].name, `${label} ${sheet}.${nameCol}`);
      }
    }
  }
}

function referenceRun(kind) {
  const reference = fixture(kind);
  const measure = writes(reference.ctx);
  const ok = reference.run();
  measure.stop();
  assert.equal(ok.ok, true, JSON.stringify(ok));
  return { points: measure.calls, expected: financialSnapshot(reference.ctx) };
}

for (const kind of ['transaction', 'plan', 'payment', 'reverse', 'settle', 'rename']) {
  test('outage ต่อเนื่องตั้งแต่จุดเขียนใดก็ได้ รวมเส้นทางบันทึก error/journal: ' + kind, (t) => {
    const { points, expected } = referenceRun(kind);
    for (let point = 1; point <= points.length; point++) {
      const { ctx, key, run } = fixture(kind);
      const fault = writes(ctx, point, 'before', true);
      const failed = run();
      fault.stop();
      const label = `${kind} sustained from #${point} (${points[point - 1]})`;
      assert.equal(failed.ok, false, label);
      assert.equal(ctx.__state.locks, 0, label + ' lock released during outage');
      const retry = run();
      assert.equal(retry.ok, true, label + ' ' + JSON.stringify(retry));
      assert.deepEqual(financialSnapshot(ctx), expected, label + ' financial result');
      assertCommittedOnce(ctx, key, label);
    }
    t.diagnostic(JSON.stringify({ scenario: kind, sustainedFrom: points.length }));
  });

  test('ล้มเหลวซ้ำระหว่าง retry (lost reply แล้ว retry ล้มอีกทุกจุด): ' + kind, (t) => {
    const { points, expected } = referenceRun(kind);
    let combos = 0;
    for (let first = 1; first <= points.length; first++) {
      for (let second = 1; second <= 40; second++) {
        const { ctx, key, run } = fixture(kind);
        const one = writes(ctx, first, 'after');
        assert.equal(run().ok, false);
        one.stop();
        const timing = second % 2 ? 'before' : 'after';
        const two = writes(ctx, second, timing);
        const retried = run();
        two.stop();
        const label = `${kind} after #${first}, retry ${timing} #${second}`;
        if (!two.fired()) {
          // The retry finished before reaching this write, so every later point is covered.
          assert.equal(retried.ok, true, label + ' ' + JSON.stringify(retried));
          assert.deepEqual(financialSnapshot(ctx), expected, label + ' financial result');
          assertCommittedOnce(ctx, key, label);
          break;
        }
        combos++;
        assert.equal(retried.ok, false, label);
        const final = run();
        assert.equal(final.ok, true, label + ' ' + JSON.stringify(final));
        assert.deepEqual(financialSnapshot(ctx), expected, label + ' financial result');
        assertCommittedOnce(ctx, key, label);
      }
    }
    t.diagnostic(JSON.stringify({ scenario: kind, doubleFaults: combos }));
  });
}

test('งานค้างต่างประเภท: เปลี่ยนชื่อ Master ระหว่างงานค้าง แล้ว retry ได้ชื่อปัจจุบันทุกตาราง', () => {
  for (const kind of ['transaction', 'plan', 'payment', 'reverse', 'settle']) {
    const { points } = referenceRun(kind);
    for (let point = 1; point <= points.length; point++) {
      const { ctx, key, run, ids } = fixture(kind);
      const fault = writes(ctx, point, 'after');
      assert.equal(run().ok, false);
      fault.stop();
      const label = `${kind} pending after #${point} + rename`;
      const renames = [
        ['owner', ids.owner.owner_id, { owner_name: 'เจ้าของใหม่ ' + point }],
        ['category', ids.category.category_id, { ...plain(ids.category), category_name: 'หมวดใหม่ ' + point }],
        ['account', ids.cash.account_id, { ...plain(ids.cash), account_name: 'เงินสดใหม่ ' + point }],
        ['account', ids.card.account_id, { ...plain(ids.card), account_name: 'บัตรใหม่ ' + point }]
      ];
      renames.forEach(([type, id, input], i) => {
        const res = ctx.api_updateMaster(type, id, input, `reliable-rename-${point}-${i}`);
        assert.equal(res.ok, true, label + ' ' + JSON.stringify(res));
      });
      const retry = run();
      assert.equal(retry.ok, true, label + ' ' + JSON.stringify(retry));
      assertCommittedOnce(ctx, key, label);
      assertProjectionsCurrent(ctx, label);
    }
  }
});

test('งานค้างต่างประเภท: ชำระค้างแล้วแก้/กลับรายการธุรกรรมชำระตรงถูกปฏิเสธ งานอื่นไม่ถูกบล็อก และ retry ได้ยอดเดิม', () => {
  const { points, expected } = referenceRun('payment');
  let attempted = 0;
  for (let point = 1; point <= points.length; point++) {
    const { ctx, key, run, ids } = fixture('payment');
    const fault = writes(ctx, point, 'after');
    assert.equal(run().ok, false);
    fault.stop();
    const label = `payment pending after #${point}`;
    const partial = ctx.Database.readAll('Transactions').rows.filter((r) => r.source === 'PLAN' && r.transaction_type !== 'CREDIT_PURCHASE');
    for (const tx of partial) {
      attempted++;
      const update = ctx.api_updateTransaction(tx.transaction_id, { transaction_date: tx.transaction_date, transaction_type: tx.transaction_type,
        from_account_id: tx.from_account_id, to_account_id: tx.to_account_id, owner_id: tx.owner_id, category_id: tx.category_id,
        item_name: 'แก้ระหว่างค้าง', amount: 1 }, `reliable-edit-${point}-${attempted}`);
      assert.equal(update.ok, false, label + ' update ' + JSON.stringify(update));
      const reverse = ctx.api_reverseTransaction(tx.transaction_id, { reason: 'กลับระหว่างค้าง', transaction_date: '2026-11-26' }, `reliable-rev-${point}-${attempted}`);
      assert.equal(reverse.ok, false, label + ' reverse ' + JSON.stringify(reverse));
    }
    const unrelated = ctx.api_createTransaction({ transaction_date: '2026-11-27', transaction_type: 'TRANSFER',
      from_account_id: ids.second.account_id, to_account_id: ids.cash.account_id, owner_id: ids.owner.owner_id,
      item_name: 'ไม่เกี่ยวข้อง', amount: 1 }, `reliable-unrelated-${point}`);
    assert.equal(unrelated.ok, true, label + ' unrelated write ' + JSON.stringify(unrelated));
    const retry = run();
    assert.equal(retry.ok, true, label + ' ' + JSON.stringify(retry));
    assertCommittedOnce(ctx, key, label);
    const snap = financialSnapshot(ctx);
    snap.transactions = snap.transactions.filter((t) => t[0] !== 'TRANSFER');
    for (const part of ['transactions', 'schedules', 'reservations', 'allocations', 'plans']) {
      assert.deepEqual(snap[part], expected[part], label + ' ' + part);
    }
  }
  assert.ok(attempted > 0, 'at least one fixture left a partial payment transaction');
});

test('งานค้างต่างประเภท: สร้างแผนค้างแล้วกันเงินงวดของแผนนั้นก่อน retry ยอดไม่เพี้ยน', () => {
  const { points } = referenceRun('plan');
  for (let point = 1; point <= points.length; point++) {
    const { ctx, key, run, ids } = fixture('plan');
    const fault = writes(ctx, point, 'after');
    assert.equal(run().ok, false);
    fault.stop();
    const label = `plan pending after #${point}`;
    const plan = ctx.Database.readAll('PaymentPlans').rows[0];
    const schedule = ctx.Database.readAll('PaymentSchedules').rows.find((r) => r.installment_no === 1);
    let reserved = null;
    if (plan && schedule) {
      reserved = ctx.api_paymentActivity({ plan_id: plan.plan_id, date: '2026-11-26', action: 'RESERVE',
        account_id: ids.cash.account_id, schedule_id: schedule.schedule_id, amount: 10 }, `reliable-early-${point}`);
    }
    const retry = run();
    assert.equal(retry.ok, true, label + ' ' + JSON.stringify(retry));
    assertCommittedOnce(ctx, key, label);
    const rows = ctx.Database.readAll('PaymentSchedules').rows;
    assert.equal(rows.length, 3, label + ' schedules');
    assert.equal(ctx.Database.readAll('Transactions').rows.filter((r) => r.transaction_type === 'CREDIT_PURCHASE').length, 1, label + ' purchase');
    const expectReserve = reserved && reserved.ok ? 10 : 0;
    const reservations = ctx.Database.readAll('Reservations').rows;
    assert.equal(reservations.reduce((s, r) => s + r.amount, 0), expectReserve, label + ' reservation rows');
    assert.equal(rows.find((r) => r.installment_no === 1).amount_reserved, expectReserve,
      label + ' derived amount_reserved, reserve=' + JSON.stringify(reserved));
  }
});

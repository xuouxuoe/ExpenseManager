/**
 * ApiReadService.gs — Integration API ระยะ A5: action อ่านข้อมูล (docs/integration-api.md ข้อ 0.12)
 *
 * - อ่านอย่างเดียว ไม่เขียนชีต ไม่เรียก AI
 * - ใช้ตัวคำนวณเดียวกับหน้าเว็บ (FinanceReports.dashboard, Ledger, PaymentActivity, Budgets) เพื่อให้ตัวเลขตรงกับ Dashboard
 * - คืนเฉพาะข้อมูลที่จำเป็นต่อการแสดงผล (ไม่มี created_at/note/external_ref/ข้อมูลภายใน)
 * - ApiReads.format* แปลงผลเป็นข้อความภาษาไทยสำหรับตอบในแชต LINE
 */
var ApiReads = (function () {
  var RECENT_DEFAULT = 5;
  var RECENT_MAX = 20;
  var TOP_CATEGORIES = 5;

  function currentMonth() {
    return Number(Util.todayIso().slice(0, 7).replace('-', ''));
  }

  function monthOf(params) {
    return Validation.requireYearMonth((params || {}).month, 'month', { required: false }) || currentMonth();
  }

  /** สรุปเดือน: ตัวเลขชุดเดียวกับการ์ดบน Dashboard เมื่อเลือกเดือนนั้น (และเจ้าของ ถ้าระบุ) */
  function summaryMonth(params) {
    var p = params || {};
    var month = monthOf(p);
    var ownerId = Validation.requireId(p.owner_id, 'owner_id', { required: false }) || '';
    var d = FinanceReports.dashboard({ month: month, owner_id: ownerId });
    var s = d.summary;
    var categories = d.categories.slice().sort(function (a, b) { return b.amount - a.amount || a.name.localeCompare(b.name); });
    return {
      month: month,
      owner_id: ownerId,
      income: s.income,
      expense: s.expense,
      net: s.net,
      plan: { scheduled: s.scheduled, paid: s.paid, outstanding: s.outstanding, need_to_save: s.needToSave, saved: s.saved },
      top_categories: categories.slice(0, TOP_CATEGORIES)
    };
  }

  /** ยอดบัญชี: ยอดรวมคำนวณจากทุกบัญชีเหมือน Dashboard; รายการแสดงบัญชีที่ใช้งาน หรือปิดแล้วแต่ยังมียอด */
  function balances() {
    var accounts = Database.readAll('Accounts').rows;
    var transactions = Database.readAll('Transactions').rows;
    var bal = Ledger.balances(accounts, transactions);
    var held = PaymentActivity.balances(Database.readAll('Reservations').rows, transactions).accounts;
    var tripHeld = Budgets.accountHolds(transactions);
    Object.keys(tripHeld).forEach(function (a) { held[a] = (held[a] || 0) + tripHeld[a]; });
    var names = MasterData.displayNames();
    var totals = { assets: 0, reserved: 0, available: 0, liabilities: 0 };
    var list = [];
    accounts.forEach(function (a) {
      var id = a.account_id;
      var asset = Ledger.isAsset(a.account_type);
      var balance = bal[id] || 0;
      var reserved = asset ? (held[id] || 0) : 0;
      if (asset) {
        totals.assets += balance;
        totals.reserved += reserved;
      } else {
        totals.liabilities += balance;
      }
      if (a.is_active !== true && !balance && !reserved) return;
      list.push({ account_id: id, name: names[id] || a.account_name, type: a.account_type, is_asset: asset,
        balance: Validation.fromSatang(balance), reserved: Validation.fromSatang(reserved),
        available: asset ? Validation.fromSatang(balance - reserved) : null });
    });
    totals.available = totals.assets - totals.reserved;
    Object.keys(totals).forEach(function (k) { totals[k] = Validation.fromSatang(totals[k]); });
    return { totals: totals, accounts: list };
  }

  var CARD_TYPES = ['CREDIT_CARD', 'CASH_CARD'];

  /**
   * ยอดหนี้บัตร (CREDIT_CARD, CASH_CARD) จากธุรกรรมจริง พร้อมวงเงินคงเหลือและวันครบกำหนด;
   * สินเชื่อ (LOAN) แยกไว้ต่างหาก — วงเงินไม่ใช่เงินที่ใช้ได้ (AGENTS.md §7.3)
   */
  function debts() {
    var accounts = Database.readAll('Accounts').rows;
    var bal = Ledger.balances(accounts, Database.readAll('Transactions').rows);
    var names = MasterData.displayNames();
    var cards = [];
    var loans = [];
    var totals = { cards: 0, loans: 0 };
    accounts.forEach(function (a) {
      var isCard = CARD_TYPES.indexOf(a.account_type) >= 0;
      if (!isCard && a.account_type !== 'LOAN') return;
      var balance = bal[a.account_id] || 0;
      if (a.is_active !== true && !balance) return;
      var limit = Number(a.credit_limit) > 0 ? Math.round(Number(a.credit_limit) * 100) : 0;
      var row = { account_id: a.account_id, name: names[a.account_id] || a.account_name, type: a.account_type,
        balance: Validation.fromSatang(balance),
        credit_limit: limit ? Validation.fromSatang(limit) : null,
        available_credit: limit ? Validation.fromSatang(Math.max(0, limit - balance)) : null,
        due_day: a.due_day === '' || a.due_day === null || a.due_day === undefined ? null : Number(a.due_day) };
      if (isCard) { cards.push(row); totals.cards += balance; } else { loans.push(row); totals.loans += balance; }
    });
    var byDebt = function (x, y) { return y.balance - x.balance || x.name.localeCompare(y.name); };
    cards.sort(byDebt);
    loans.sort(byDebt);
    return { totals: { cards: Validation.fromSatang(totals.cards), loans: Validation.fromSatang(totals.loans) }, cards: cards, loans: loans };
  }

  /** รายการล่าสุด เรียงเหมือนหน้ารายการ (วันที่ทำรายการ แล้วเวลาบันทึก ล่าสุดก่อน) */
  function recentTransactions(params) {
    var p = params || {};
    var limit = Validation.isBlank(p.limit) ? RECENT_DEFAULT : Validation.requireInt(p.limit, 'limit', { min: 1, max: RECENT_MAX });
    var page = Transactions.list({ page: 1, page_size: limit });
    return {
      total: page.total,
      transactions: page.rows.map(function (r) {
        return { transaction_id: r.transaction_id, transaction_date: r.transaction_date, transaction_type: r.transaction_type,
          item_name: r.item_name, amount: r.amount, category_name: r.category_name || '', owner_name: r.owner_name || '',
          from_account_name: r.from_account_name || '', to_account_name: r.to_account_name || '',
          reversal_of: r.reversal_of || '', is_reversed: r.is_reversed === true };
      })
    };
  }

  /** งบคงเหลือของเดือน (ค่าเดียวกับหน้างบใช้จ่าย) */
  function budgetRemaining(params) {
    var month = monthOf(params);
    var budgets = Budgets.list(month);
    var amount = 0;
    var spent = 0;
    var out = budgets.map(function (b) {
      amount += Validation.toSatang(b.amount, 'amount', { allowZero: true });
      spent += Validation.toSatang(b.spent, 'amount', { allowZero: true });
      var row = { budget_id: b.budget_id, budget_name: b.budget_name, owner_name: b.owner_name, phase: b.phase,
        amount: b.amount, spent: b.spent, remaining: b.remaining };
      if (b.week_remaining !== undefined) {
        row.week_remaining = b.week_remaining;
        row.week_days_left = b.week_days_left;
        row.per_day_week = b.per_day_week;
        row.month_days_left = b.month_days_left;
        row.per_day_month = b.per_day_month;
      }
      return row;
    });
    return { month: month, totals: { amount: Validation.fromSatang(amount), spent: Validation.fromSatang(spent), remaining: Validation.fromSatang(amount - spent) }, budgets: out };
  }

  // ---------- ข้อความสำหรับแชต ----------

  var MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var TYPE_LABELS = { INCOME: 'รายรับ', EXPENSE: 'รายจ่าย', TRANSFER: 'โอน', CREDIT_PURCHASE: 'ซื้อด้วยบัตร', CREDIT_PAYMENT: 'ชำระบัตร/หนี้',
    CASH_ADVANCE: 'เบิกเงินสด', INTEREST: 'ดอกเบี้ย', FEE: 'ค่าธรรมเนียม', REFUND: 'คืนเงิน', ADJUSTMENT: 'ปรับยอด' };

  /** 1234.5 → "1,234.50" (ไม่พึ่ง locale ของ runtime) */
  function money(value) {
    var n = Number(value) || 0;
    var sign = n < 0 ? '-' : '';
    var parts = Math.abs(n).toFixed(2).split('.');
    return sign + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
  }

  function monthLabel(ym) {
    return MONTHS[(ym % 100) - 1] + ' ' + (Math.floor(ym / 100) + 543);
  }

  function shortDate(iso) {
    var p = String(iso).split('-');
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1];
  }

  function formatSummary(r) {
    var lines = ['สรุป ' + monthLabel(r.month),
      'รายรับ ' + money(r.income),
      'รายจ่าย ' + money(r.expense),
      'สุทธิ ' + money(r.net)];
    if (r.top_categories.length) {
      lines.push('', 'รายจ่ายสูงสุด');
      r.top_categories.forEach(function (c) { lines.push('• ' + c.name + ' ' + money(c.amount)); });
    }
    if (r.plan.scheduled || r.plan.need_to_save) {
      lines.push('', 'แผนชำระเดือนนี้ ' + money(r.plan.scheduled), 'ค้างชำระ ' + money(r.plan.outstanding), 'ต้องเก็บเพิ่ม ' + money(r.plan.need_to_save));
    }
    return lines.join('\n');
  }

  function formatBalances(r) {
    var lines = ['ยอดเงิน',
      'สินทรัพย์ ' + money(r.totals.assets),
      'กันไว้ ' + money(r.totals.reserved),
      'ใช้ได้จริง ' + money(r.totals.available),
      'หนี้สิน ' + money(r.totals.liabilities)];
    var assets = r.accounts.filter(function (a) { return a.is_asset; });
    var debts = r.accounts.filter(function (a) { return !a.is_asset && a.balance; });
    if (assets.length) {
      lines.push('');
      assets.forEach(function (a) {
        lines.push('• ' + a.name + ' ' + money(a.balance) + (a.reserved ? ' (ใช้ได้ ' + money(a.available) + ')' : ''));
      });
    }
    if (debts.length) {
      lines.push('', 'หนี้คงค้าง');
      debts.forEach(function (a) { lines.push('• ' + a.name + ' ' + money(a.balance)); });
    }
    return lines.join('\n');
  }

  function formatDebts(r) {
    if (!r.cards.length && !r.loans.length) return 'ยังไม่มีบัตรเครดิต บัตรกดเงินสด หรือสินเชื่อ';
    var lines = ['หนี้บัตร ' + money(r.totals.cards)];
    r.cards.forEach(function (c) {
      var extra = [];
      if (c.available_credit !== null) extra.push('วงเงินเหลือ ' + money(c.available_credit));
      if (c.due_day) extra.push('ครบกำหนดวันที่ ' + c.due_day);
      lines.push('• ' + c.name + ' ' + money(c.balance) + (extra.length ? ' (' + extra.join(', ') + ')' : ''));
    });
    var loans = r.loans.filter(function (l) { return l.balance; });
    if (loans.length) {
      lines.push('', 'สินเชื่อ ' + money(r.totals.loans));
      loans.forEach(function (l) { lines.push('• ' + l.name + ' ' + money(l.balance) + (l.due_day ? ' (ครบกำหนดวันที่ ' + l.due_day + ')' : '')); });
    }
    return lines.join('\n');
  }

  function formatRecent(r) {
    if (!r.transactions.length) return 'ยังไม่มีรายการ';
    var lines = ['รายการล่าสุด'];
    r.transactions.forEach(function (t) {
      var flag = t.reversal_of ? ' [กลับรายการ]' : (t.is_reversed ? ' [ถูกกลับรายการ]' : '');
      lines.push('• ' + shortDate(t.transaction_date) + ' ' + (TYPE_LABELS[t.transaction_type] || t.transaction_type) + ' ' +
        money(t.amount) + ' ' + t.item_name + flag);
    });
    return lines.join('\n');
  }

  function formatBudgets(r) {
    if (!r.budgets.length) return 'ยังไม่มีงบใช้จ่ายของ ' + monthLabel(r.month);
    var lines = ['งบ ' + monthLabel(r.month), 'เหลือ ' + money(r.totals.remaining) + ' จาก ' + money(r.totals.amount)];
    r.budgets.forEach(function (b) {
      var line = '• ' + b.budget_name + ' เหลือ ' + money(b.remaining);
      if (b.week_remaining !== undefined) line += ' (สัปดาห์นี้ ' + money(b.week_remaining) + ', วันละ ' + money(b.per_day_week) + ')';
      lines.push(line);
    });
    return lines.join('\n');
  }

  return {
    summaryMonth: summaryMonth,
    balances: balances,
    recentTransactions: recentTransactions,
    budgetRemaining: budgetRemaining,
    debts: debts,
    formatDebts: formatDebts,
    formatSummary: formatSummary,
    formatBalances: formatBalances,
    formatRecent: formatRecent,
    formatBudgets: formatBudgets,
    money: money
  };
})();

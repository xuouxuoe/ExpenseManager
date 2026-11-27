/** คำนวณรายงานจากแถวต้นฉบับตาม grain ของแต่ละชุดข้อมูล */
var FinanceReports = (function () {
  function sat(value) { return Validation.toSatang(value, 'amount', { allowZero: true }); }
  function baht(value) { return Validation.fromSatang(value); }
  function dateMonth(date) { return Number(date.slice(0, 7).replace('-', '')); }

  function data(input) {
    var f = input || {};
    var month = Validation.requireYearMonth(f.month, 'month', { required: false });
    var year = Validation.requireInt(f.year, 'year', { required: false, min: 1900, max: 2200 });
    var owner = Validation.requireId(f.owner_id, 'owner_id', { required: false });
    var category = Validation.requireId(f.category_id, 'category_id', { required: false });
    var account = Validation.requireId(f.account_id, 'account_id', { required: false });
    var subAccount = Validation.requireId(f.sub_account_id, 'sub_account_id', { required: false });
    var accounts = MasterData.listAll({ includeInactive: true }).accounts;
    var types = Object.create(null);
    accounts.forEach(function (a) { types[a.account_id] = a.account_type; });
    function byMonth(ym) { return month ? ym === month : !year || Validation.yearOf(ym) === year; }
    function byMaster(row, actualAccount) {
      return (!subAccount || row.sub_account_id === subAccount || row.from_sub_account_id === subAccount || row.to_sub_account_id === subAccount) &&
        (!owner || row.owner_id === owner) && (!category || row.category_id === category) &&
        (!account || (actualAccount ? actualAccount === account :
          row.account_id === account || row.from_account_id === account || row.to_account_id === account));
    }
    var transactions = Database.readAll('Transactions').rows;
    var schedules = Database.readAll('PaymentSchedules').rows;
    return {
      accounts: accounts, types: types, allTransactions: transactions, allSchedules: schedules, byMonth: byMonth, byMaster: byMaster,
      transactions: transactions.filter(function (r) { return byMonth(dateMonth(r.transaction_date)) && byMaster(r); }),
      schedules: schedules.filter(function (r) { return !r.is_cancelled && byMaster(r); }),
      reservations: Database.readAll('Reservations').rows,
      allocations: Database.readAll('PaymentAllocations').rows
    };
  }

  function subAccountBalances(d, filters) {
    var accounts = [];
    var groups = Object.create(null);
    var types = Object.create(null);
    // คีย์ต้องไม่เป็นตัวเลขล้วน: object ใน JS เรียงคีย์ตัวเลขก่อนเสมอ ทำให้ลำดับบัญชีย่อยเปลี่ยน
    function key(parent, sub) { return sub ? 'sub-' + sub : 'unassigned-' + parent; }
    function add(parent, sub) {
      var id = key(parent.account_id, sub && sub.sub_account_id);
      types[id] = parent.account_type;
      accounts.push({ account_id: id, account_type: parent.account_type, opening_balance: sub ? 0 : parent.opening_balance });
      groups[id] = { account_id: parent.account_id, sub_account_id: sub ? sub.sub_account_id : '',
        name: sub ? sub.sub_account_name : 'ยังไม่ระบุบัญชีย่อย · ' + parent.account_name,
        type: parent.account_type, isAsset: Ledger.isAsset(parent.account_type),
        is_active: parent.is_active && (!sub || sub.is_active), reserved: 0, income: 0, expense: 0 };
    }
    var children = Database.readAll('SubAccounts').rows;
    d.accounts.forEach(function (a) {
      add(a, null);
      children.filter(function (s) { return s.account_id === a.account_id; }).forEach(function (s) { add(a, s); });
    });
    function groupedTransaction(t) {
      return Object.assign({}, t, {
        from_account_id: t.from_account_id ? key(t.from_account_id, t.from_sub_account_id) : '',
        to_account_id: t.to_account_id ? key(t.to_account_id, t.to_sub_account_id) : ''
      });
    }
    var balances = Ledger.balances(accounts, d.allTransactions.map(groupedTransaction));
    d.transactions.forEach(function (t) {
      var effect = Ledger.effectsOf(groupedTransaction(t), types);
      var source = groups[key(t.from_account_id, t.from_sub_account_id)];
      var target = groups[key(t.to_account_id, t.to_sub_account_id)];
      if (source || target) (source || target).expense += effect.expenseSatang;
      if (target) target.income += effect.incomeSatang;
    });
    var scheduleById = new Map(d.allSchedules.map(function (s) { return [s.schedule_id, s]; }));
    var reserved = PaymentActivity.balances(d.reservations, d.allTransactions).schedules;
    Object.keys(reserved).forEach(function (id) {
      var schedule = scheduleById.get(id);
      Object.keys(reserved[id].accounts).forEach(function (parent) {
        var sub = schedule && schedule.account_id === parent ? schedule.sub_account_id : '';
        var group = groups[key(parent, sub)];
        if (group) group.reserved += reserved[id].accounts[parent];
      });
    });
    // เงินกันของงบทริปไม่มีบัญชีย่อย: อยู่ในกลุ่มยังไม่ระบุบัญชีย่อยของบัญชีนั้น
    var tripHeld = Budgets.accountHolds(d.allTransactions);
    Object.keys(tripHeld).forEach(function (parent) {
      var group = groups[key(parent, '')];
      if (group) group.reserved += tripHeld[parent];
    });
    return Object.keys(groups).map(function (id) {
      var group = groups[id];
      group.balance = baht(balances[id] || 0);
      group.reserved = baht(group.reserved);
      group.available = group.isAsset ? baht((balances[id] || 0) - sat(group.reserved)) : null;
      group.income = baht(group.income);
      group.expense = baht(group.expense);
      return group;
    }).filter(function (row) {
      return (!filters || !filters.account_id || row.account_id === filters.account_id) &&
        (!filters || !filters.sub_account_id || row.sub_account_id === filters.sub_account_id);
    });
  }

  function sharedReport(filters) {
    var d = data(filters);
    return { accounts: subAccountBalances(d, filters).filter(function (row) { return !!row.sub_account_id; }).map(function (row) {
      return { name: row.name, balance: row.balance, income: row.income, expense: row.expense, isAsset: row.isAsset };
    }) };
  }

  /**
   * ภาพรวมรายเดือน/รายปีสำหรับแดชบอร์ด (ใช้ตัวกรองเจ้าของ/หมวด/บัญชีเดียวกัน)
   * current/previous: เดือนก่อนหน้าหรือปีก่อนหน้า; trend: 6 เดือนถึงเดือนที่เลือก หรือ 12 เดือนของปี
   * plan: ต่อเดือนของ trend — ยอดตามแผนตามเดือนชำระ คงค้างชำระ และยังต้องเก็บตามเดือนเก็บ (ไม่รวมงวดยกเลิก)
   */
  function overview(d, f) {
    var month = Validation.requireYearMonth(f.month, 'month', { required: false });
    var year = Validation.requireInt(f.year, 'year', { required: false, min: 1900, max: 2200 });
    var mode = month ? 'MONTH' : year ? 'YEAR' : 'ALL';
    var byMonth = Object.create(null);
    d.allTransactions.forEach(function (row) {
      if (!d.byMaster(row)) return;
      var effect = Ledger.effectsOf(row, d.types);
      var ym = dateMonth(row.transaction_date);
      var b = byMonth[ym] || (byMonth[ym] = { income: 0, expense: 0 });
      b.income += effect.incomeSatang;
      b.expense += effect.expenseSatang;
    });
    function sum(months) {
      var t = months.reduce(function (acc, ym) {
        var b = byMonth[ym];
        if (b) { acc.income += b.income; acc.expense += b.expense; }
        return acc;
      }, { income: 0, expense: 0 });
      return { income: baht(t.income), expense: baht(t.expense), net: baht(t.income - t.expense) };
    }
    function yearMonths(y) { var out = []; for (var m = 1; m <= 12; m++) out.push(y * 100 + m); return out; }
    var trendMonths = [];
    var current = null;
    var previous = null;
    if (mode === 'MONTH') {
      for (var i = 5; i >= 0; i--) trendMonths.push(Validation.addMonths(month, -i));
      current = sum([month]);
      previous = sum([Validation.addMonths(month, -1)]);
    } else if (mode === 'YEAR') {
      trendMonths = yearMonths(year);
      current = sum(trendMonths);
      previous = sum(yearMonths(year - 1));
    }
    var plan = Object.create(null);
    trendMonths.forEach(function (ym) { plan[ym] = { month: ym, scheduled: 0, outstanding: 0, toSave: 0 }; });
    // ยอดตามแผนต่อเจ้าของต่อเดือนชำระ (ใช้ owner_name ล่าสุดจาก projection ของงวด)
    var owners = Object.create(null);
    var monthIndex = Object.create(null);
    trendMonths.forEach(function (ym, i) { monthIndex[ym] = i; });
    d.schedules.forEach(function (r) {
      var pay = plan[r.payment_month];
      if (pay) {
        var o = owners[r.owner_id] || (owners[r.owner_id] = { owner_id: r.owner_id, name: r.owner_name || 'ไม่ระบุเจ้าของ',
          scheduled: trendMonths.map(function () { return 0; }), outstanding: trendMonths.map(function () { return 0; }) });
        o.scheduled[monthIndex[r.payment_month]] += sat(r.amount_due);
        o.outstanding[monthIndex[r.payment_month]] += sat(r.remaining_to_pay);
      }
      if (pay) { pay.scheduled += sat(r.amount_due); pay.outstanding += sat(r.remaining_to_pay); }
      var save = plan[r.saving_month];
      if (save) save.toSave += sat(r.remaining_to_save);
    });
    return {
      mode: mode, month: month || null, year: year || null, current: current, previous: previous,
      trend: trendMonths.map(function (ym) {
        var b = byMonth[ym] || { income: 0, expense: 0 };
        return { month: ym, income: baht(b.income), expense: baht(b.expense), net: baht(b.income - b.expense) };
      }),
      plan: trendMonths.map(function (ym) {
        var p = plan[ym];
        return { month: ym, scheduled: baht(p.scheduled), paid: baht(p.scheduled - p.outstanding), outstanding: baht(p.outstanding), toSave: baht(p.toSave) };
      }),
      planByOwner: Object.keys(owners).map(function (id) {
        var o = owners[id];
        var total = o.scheduled.reduce(function (s, v) { return s + v; }, 0);
        return { owner_id: o.owner_id, name: o.name, total: baht(total),
          outstanding_total: baht(o.outstanding.reduce(function (s, v) { return s + v; }, 0)),
          scheduled: o.scheduled.map(baht), outstanding: o.outstanding.map(baht) };
      }).sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); })
    };
  }

  function dashboard(filters) {
    var d = data(filters);
    var monthly = Object.create(null);
    var categories = Object.create(null);
    var income = 0;
    var expenses = 0;
    var cashFlow = 0;
    d.transactions.forEach(function (row) {
      var effect = Ledger.effectsOf(row, d.types);
      income += effect.incomeSatang;
      expenses += effect.expenseSatang;
      Object.keys(effect.accounts).forEach(function (id) {
        if (Ledger.isAsset(d.types[id])) cashFlow += effect.accounts[id];
      });
      var month = dateMonth(row.transaction_date);
      var bucket = monthly[month] || (monthly[month] = { month: month, income: 0, expense: 0 });
      bucket.income += effect.incomeSatang;
      bucket.expense += effect.expenseSatang;
      if (row.category_name && effect.expenseSatang) {
        categories[row.category_name] = (categories[row.category_name] || 0) + effect.expenseSatang;
      }
    });
    var txById = new Map(d.allTransactions.map(function (r) { return [r.transaction_id, r]; }));
    var scheduleById = new Map(d.allSchedules.map(function (r) { return [r.schedule_id, r]; }));
    var reversed = new Map(d.allTransactions.filter(function (r) { return r.reversal_of; }).map(function (r) { return [r.reversal_of, r]; }));
    var paid = d.allocations.reduce(function (sum, row) {
      var tx = txById.get(row.transaction_id);
      var schedule = scheduleById.get(row.schedule_id);
      if (!tx || !schedule || !d.byMaster(schedule, tx.from_account_id || tx.to_account_id)) return sum;
      var reverse = reversed.get(tx.transaction_id);
      if (d.byMonth(dateMonth(tx.transaction_date))) sum += sat(row.allocated_amount);
      if (reverse && d.byMonth(dateMonth(reverse.transaction_date))) sum -= sat(row.allocated_amount);
      return sum;
    }, 0);
    var saved = d.reservations.reduce(function (sum, row) {
      var schedule = scheduleById.get(row.schedule_id);
      if (!schedule || !d.byMaster(schedule, row.account_id)) return sum;
      if (row.action_type === 'RESERVE' && d.byMonth(dateMonth(row.reservation_date))) sum += sat(row.amount);
      if (row.action_type === 'RELEASE') {
        if (d.byMonth(dateMonth(row.reservation_date))) sum -= sat(row.amount);
        var reverse = row.transaction_id && reversed.get(row.transaction_id);
        if (reverse && d.byMonth(dateMonth(reverse.transaction_date))) sum += sat(row.amount);
      }
      return sum;
    }, 0);
    var needToSave = 0;
    var scheduled = 0;
    var outstanding = 0;
    var planOutstanding = 0;
    // งานของเดือนปัจจุบัน (รวมงวดค้างจากเดือนก่อน) สำหรับการ์ดลิงก์ไปมุมมองรายเดือน
    var thisMonth = dateMonth(Util.todayIso());
    var monthPlan = { month: thisMonth, payCount: 0, pay: 0, saveCount: 0, save: 0, overdue: 0 };
    d.schedules.forEach(function (r) {
      if (r.payment_month <= thisMonth && sat(r.remaining_to_pay) > 0) {
        monthPlan.payCount++;
        monthPlan.pay += sat(r.remaining_to_pay);
        if (r.payment_month < thisMonth || r.is_overdue) monthPlan.overdue++;
      }
      if (r.saving_month <= thisMonth && sat(r.remaining_to_save) > 0) {
        monthPlan.saveCount++;
        monthPlan.save += sat(r.remaining_to_save);
      }
    });
    monthPlan.pay = baht(monthPlan.pay);
    monthPlan.save = baht(monthPlan.save);
    d.schedules.forEach(function (r) {
      if (d.byMonth(r.saving_month)) needToSave += sat(r.remaining_to_save);
      if (d.byMonth(r.payment_month)) {
        scheduled += sat(r.amount_due);
        outstanding += sat(r.remaining_to_pay);
      }
      planOutstanding += sat(r.remaining_to_pay);
    });

    var balances = Ledger.balances(d.accounts, d.allTransactions);
    var reserves = PaymentActivity.balances(d.reservations, d.allTransactions).accounts;
    var tripHeld = Budgets.accountHolds(d.allTransactions); // เงินกันของงบทริป (E3)
    Object.keys(tripHeld).forEach(function (a) { reserves[a] = (reserves[a] || 0) + tripHeld[a]; });
    var accountTotals = { assets: 0, reserved: 0, available: 0, liabilities: 0 };
    d.accounts.forEach(function (row) {
      var id = row.account_id;
      if (Ledger.isAsset(row.account_type)) {
        accountTotals.assets += balances[id];
        accountTotals.reserved += reserves[id] || 0;
      } else accountTotals.liabilities += balances[id];
    });
    accountTotals.available = accountTotals.assets - accountTotals.reserved;
    Object.keys(accountTotals).forEach(function (key) { accountTotals[key] = baht(accountTotals[key]); });
    return {
      summary: { income: baht(income), expense: baht(expenses), net: baht(income - expenses), cashFlow: baht(cashFlow),
        saved: baht(saved), paid: baht(paid), needToSave: baht(needToSave), scheduled: baht(scheduled),
        outstanding: baht(outstanding), planOutstanding: baht(planOutstanding) },
      monthly: Object.keys(monthly).sort().map(function (key) {
        var row = monthly[key];
        return { month: row.month, income: baht(row.income), expense: baht(row.expense) };
      }),
      categories: Object.keys(categories).sort().map(function (name) { return { name: name, amount: baht(categories[name]) }; }),
      accountTotals: accountTotals,
      monthPlan: monthPlan,
      overview: overview(d, filters || {}),
      accounts: filters && filters.account_view === 'SUB' ? subAccountBalances(d, filters) : d.accounts.map(function (row) {
        var id = row.account_id;
        var asset = Ledger.isAsset(row.account_type);
        var held = reserves[id] || 0;
        return { account_id: id, type: row.account_type, is_active: row.is_active === true, name: row.account_name, balance: baht(balances[id]), reserved: baht(held), isAsset: asset,
          available: asset ? baht(balances[id] - held) : null };
      }),
      recent: d.transactions.slice().sort(function (a, b) {
        return b.transaction_date.localeCompare(a.transaction_date) || b.created_at.localeCompare(a.created_at);
      }).slice(0, 8),
      masters: MasterData.listAll({ includeInactive: true })
    };
  }

  function table(kind, filters) {
    var type = Validation.requireEnum(kind, ['TRANSACTIONS', 'SAVING', 'PAYMENT'], 'report');
    var d = data(filters);
    var headers;
    var rows;
    if (type === 'TRANSACTIONS') {
      headers = ['transaction_date', 'month', 'transaction_type', 'owner_name', 'category_name', 'from_account_name',
        'to_account_name', 'item_name', 'amount', 'income', 'expense', 'reversal_of', 'from_sub_account_name', 'to_sub_account_name', 'budget_name'];
      rows = d.transactions.map(function (r) {
        var effect = Ledger.effectsOf(r, d.types);
        return [r.transaction_date, dateMonth(r.transaction_date), r.transaction_type, r.owner_name, r.category_name, r.from_account_name,
          r.to_account_name, r.item_name, r.amount, baht(effect.incomeSatang), baht(effect.expenseSatang), r.reversal_of, r.from_sub_account_name || '', r.to_sub_account_name || '', r.budget_name || ''];
      });
    } else {
      var isSaving = type === 'SAVING';
      var monthField = isSaving ? 'saving_month' : 'payment_month';
      var leftField = isSaving ? 'remaining_to_save' : 'remaining_to_pay';
      headers = ['schedule_id', 'plan_id', 'account_name', 'owner_name', 'category_name', 'item_name', monthField, 'amount_due', leftField, 'sub_account_name'];
      rows = d.schedules.filter(function (r) { return d.byMonth(r[monthField]); }).map(function (r) {
        return headers.map(function (key) { return r[key]; });
      });
    }
    return { headers: headers, rows: rows };
  }

  function exportCsv(kind, filters) {
    var result = table(kind, filters);
    function cell(value) {
      if (typeof value === 'number') return String(value);
      var text = Validation.sanitizeForSheet(String(value == null ? '' : value));
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return [result.headers].concat(result.rows).map(function (row) { return row.map(cell).join(','); }).join('\r\n');
  }

  function refreshPivots() {
    var specs = [
      { type: 'SAVING', name: 'Pivot_Saving', groups: [3, 10], column: 7, totals: [8, 9] },
      { type: 'PAYMENT', name: 'Pivot_Payment', groups: [3, 10], column: 7, totals: [8, 9] },
      { type: 'TRANSACTIONS', name: 'Pivot_Transactions', groups: [4, 5, 13, 14], column: 2, totals: [10, 11] }
    ];
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(Config.LOCK_TIMEOUT_MS)) throw Util.AppError('BUSY', 'ระบบกำลังเขียนข้อมูล กรุณาลองใหม่');
    try {
      var spreadsheet = Database.getSpreadsheet();
      var mark = 'ExpenseManager: generated report';
      function owned(name, create) {
        var sheet = spreadsheet.getSheetByName(name);
        if (sheet) {
          if (sheet.getRange(1, 1).getValue() !== mark) throw Util.AppError('PIVOT_NAME_IN_USE', 'มีชีตชื่อ ' + name + ' อยู่แล้ว');
          return sheet;
        }
        if (!create) return null;
        sheet = spreadsheet.insertSheet(name);
        sheet.getRange(1, 1).setValue(mark);
        return sheet;
      }
      specs.forEach(function (spec) {
        owned(spec.name, false);
        owned('View_' + spec.name, false);
      });
      return specs.map(function (spec) {
        var payload = table(spec.type, {});
        var source = owned('View_' + spec.name, true);
        var target = owned(spec.name, true);
        var values = [payload.headers].concat(payload.rows).map(function (row) {
          return row.map(function (value) { return typeof value === 'string' ? Validation.sanitizeForSheet(value) : value; });
        });
        var required = values.length + 1;
        if (required > source.getMaxRows()) source.insertRowsAfter(source.getMaxRows(), required - source.getMaxRows());
        var previousEnd = source.getLastRow();
        source.getRange(2, 1, values.length, payload.headers.length).setValues(values);
        if (previousEnd > required) source.getRange(required + 1, 1, previousEnd - required, payload.headers.length).clearContent();
        target.getPivotTables().forEach(function (pivot) { pivot.remove(); });
        if (payload.rows.length) {
          var pivot = target.getRange(3, 1).createPivotTable(source.getRange(2, 1, values.length, payload.headers.length));
          spec.groups.forEach(function (column) { pivot.addRowGroup(column); });
          pivot.addColumnGroup(spec.column);
          spec.totals.forEach(function (column) {
            pivot.addPivotValue(column, SpreadsheetApp.PivotTableSummarizeFunction.SUM);
          });
        }
        return { sheet: spec.name, sourceRows: payload.rows.length };
      });
    } finally {
      lock.releaseLock();
    }
  }

  return { dashboard: dashboard, exportCsv: exportCsv, refreshPivots: refreshPivots, sharedReport: sharedReport };
})();

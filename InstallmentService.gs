/** สร้างแผนรายจ่ายในอนาคตและงวดตามปฏิทิน */
var PaymentPlanner = (function () {
  var PLANS = 'PaymentPlans';
  var SCHEDULES = 'PaymentSchedules';
  var MAX_INSTALLMENTS = 360;
  var LINK_MODES = ['NONE', 'NEW', 'EXISTING'];

  function feeTimingKey(planId) { return 'plan.fee_timing.' + planId; }

  function favoritePrefix(actor) { return 'plan.star.' + Util.sha256Hex(actor.actorId).slice(0, 32) + '.'; }

  function favoriteSetting(actor, planId, favorite, now) {
    return { setting_key: favoritePrefix(actor) + planId, setting_value: favorite ? 'ON' : 'OFF',
      description: 'รายการแผนชำระที่ใช้ประจำ', updated_at: now };
  }

  function setFavorite(planId, favorite, request) {
    var id = Validation.requireId(planId, 'plan_id');
    var enabled = Validation.requireBoolean(favorite, 'favorite');
    return Operation.run({ operationType: 'SET_PLAN_FAVORITE', actor: request.actor, idempotencyKey: request.idempotencyKey,
      payload: { plan_id: id, favorite: enabled } }, function (ctx) {
      if (!Database.findRowsByValue(PLANS, 'plan_id', id).length) throw error('plan_id', 'ไม่พบแผนชำระ');
      var row = favoriteSetting(request.actor, id, enabled, ctx.now);
      var hit = Database.findRowsByValue('Settings', 'setting_key', row.setting_key)[0];
      if (hit && hit.row.setting_value !== row.setting_value) Database.writeRowAt('Settings', hit.rowNumber, row);
      if (!hit && enabled) Database.appendRows('Settings', [row]);
      return { favorite: enabled };
    }).result;
  }

  function hasFirstInstallmentFee(planId) {
    return Database.findRowsByValue('Settings', 'setting_key', feeTimingKey(planId)).some(function (hit) {
      return hit.row.setting_value === 'FIRST';
    });
  }

  function error(field, message) {
    return Util.AppError('VALIDATION_PLAN', message, { field: field });
  }

  function text(input, field, limit, required) {
    return Validation.requireText(input[field], field, { max: limit, required: required, multiline: field === 'description' || field === 'note' });
  }

  function normalize(input, masters) {
    var f = input || {};
    var limits = Config.TEXT_LIMITS;
    var type = Validation.requireEnum(f.plan_type, Config.ENUMS.PLAN_TYPE, 'plan_type');
    var count = Validation.requireInt(f.installment_count, 'installment_count', {
      min: 1, max: type === 'ONE_TIME' ? 1 : MAX_INSTALLMENTS
    });
    var principal = Validation.toSatang(f.principal_amount, 'principal_amount', { allowZero: true });
    var interest = Validation.toSatang(f.interest_amount, 'interest_amount', { required: false, allowZero: true }) || 0;
    var fee = Validation.toSatang(f.fee_amount, 'fee_amount', { required: false, allowZero: true }) || 0;
    var total = principal + interest + fee;
    if (!Number.isSafeInteger(total) || total < count) {
      throw error('principal_amount', 'ยอดรวมต้องเพียงพอสำหรับทุกงวด (อย่างน้อยงวดละ 0.01 บาท)');
    }
    var plan = {
      purchase_date: Validation.requireDate(f.purchase_date, 'purchase_date'),
      plan_type: type,
      account_id: Validation.requireId(f.account_id, 'account_id'),
      sub_account_id: Projection.validateSubAccount(f.sub_account_id, f.account_id, masters),
      owner_id: Validation.requireId(f.owner_id, 'owner_id'),
      category_id: Validation.requireId(f.category_id, 'category_id'),
      item_name: text(f, 'item_name', limits.ITEM_NAME, true),
      description: text(f, 'description', limits.DESCRIPTION, false),
      principal_amount: Validation.fromSatang(principal),
      interest_amount: Validation.fromSatang(interest),
      fee_amount: Validation.fromSatang(fee),
      total_amount: Validation.fromSatang(total),
      installment_count: count,
      first_saving_month: Validation.requireYearMonth(f.first_saving_month, 'first_saving_month'),
      first_payment_month: Validation.requireYearMonth(f.first_payment_month, 'first_payment_month'),
      due_day: Validation.requireDay(f.due_day, 'due_day', { required: false }),
      external_ref: text(f, 'external_ref', limits.EXTERNAL_REF, false),
      note: text(f, 'note', limits.NOTE, false),
      plan_status: 'ACTIVE'
    };
    Projection.apply(PLANS, plan, masters, { requireActive: true });
    if (masters.categories[plan.category_id].type !== 'EXPENSE') {
      throw error('category_id', 'แผนชำระต้องใช้หมวดหมู่รายจ่าย');
    }

    var timing = Validation.isBlank(f.fee_timing) ? 'SPREAD' : Validation.requireEnum(f.fee_timing, ['SPREAD', 'FIRST'], 'fee_timing');
    var firstFee = timing === 'FIRST' ? fee : 0;
    var amounts;
    if (f.schedule_amounts !== undefined) {
      if (!Array.isArray(f.schedule_amounts) || f.schedule_amounts.length !== count) {
        throw error('schedule_amounts', 'จำนวนยอดรายงวดต้องตรงกับจำนวนงวด');
      }
      amounts = f.schedule_amounts.map(function (amount) { return Validation.toSatang(amount, 'schedule_amounts'); });
      if (amounts.reduce(function (sum, amount) { return sum + amount; }, 0) !== total) {
        throw error('schedule_amounts', 'ผลรวมรายงวดต้องตรงกับยอดรวมของแผน');
      }
      if (amounts[0] < firstFee) throw error('schedule_amounts', 'งวดแรกต้องครอบคลุมค่าธรรมเนียมทั้งหมด');
    } else if (count === 1) {
      amounts = [total];
    } else {
      if (total - firstFee < count) throw error('installment_count', 'ยอดที่ใช้แบ่งงวดต้องเพียงพออย่างน้อยงวดละ 0.01 บาท');
      amounts = Validation.splitSatang(total - firstFee, count);
      amounts[0] += firstFee;
    }
    // ตรวจขอบเขตก่อนเขียนลงชีต
    Validation.addMonths(plan.first_saving_month, count - 1);
    Validation.addMonths(plan.first_payment_month, count - 1);
    return { plan: plan, amounts: amounts, link: purchaseLink(f, plan, masters) };
  }

  /**
   * เชื่อมแผนกับรายการซื้อด้วยบัตร/สินเชื่อ (CREDIT_PURCHASE) ได้หนึ่งรายการต่อแผน (AGENTS §7.3)
   * purchase_link: NONE (ค่าเริ่มต้น) | NEW (สร้างรายการซื้อใหม่ = เงินต้น ณ วันที่ซื้อ)
   *              | EXISTING (เชื่อมรายการซื้อที่บันทึกไว้แล้ว: purchase_transaction_id)
   * ดอกเบี้ย/ค่าธรรมเนียมของแผนไม่รับรู้ตอนซื้อ แต่รับรู้ตามสัดส่วนเมื่อชำระจริง (PaymentActivity)
   */
  function purchaseLink(f, plan, masters) {
    var mode = Validation.isBlank(f.purchase_link) ? 'NONE' : Validation.requireEnum(f.purchase_link, LINK_MODES, 'purchase_link');
    if (mode === 'NONE') return null;
    var account = masters.accounts[plan.account_id];
    if (!account || Ledger.LIABILITY.indexOf(account.type) < 0) {
      throw error('purchase_link', 'เชื่อมรายการซื้อได้เฉพาะแผนที่ใช้บัตรเครดิต บัตรกดเงินสด หรือสินเชื่อ');
    }
    if (plan.plan_type === 'RECURRING') throw error('purchase_link', 'แผนรายจ่ายประจำเชื่อมรายการซื้อไม่ได้');
    if (!Validation.toSatang(plan.principal_amount, 'principal_amount', { allowZero: true })) {
      throw error('principal_amount', 'แผนที่เชื่อมรายการซื้อต้องมีเงินต้นมากกว่า 0');
    }
    if (plan.purchase_date > Util.todayIso()) throw error('purchase_date', 'วันที่ซื้อต้องไม่เป็นวันในอนาคต');
    if (mode === 'NEW') {
      var tx = Transactions.validate({
        transaction_date: plan.purchase_date, transaction_type: 'CREDIT_PURCHASE', from_account_id: plan.account_id, from_sub_account_id: plan.sub_account_id,
        owner_id: plan.owner_id, category_id: plan.category_id, item_name: plan.item_name, description: plan.description,
        amount: plan.principal_amount, external_ref: plan.external_ref, note: ''
      }, masters);
      tx.source = 'PLAN';
      return { mode: mode, transaction: tx };
    }
    var id = Validation.requireId(f.purchase_transaction_id, 'purchase_transaction_id');
    var candidate = purchaseCandidates().filter(function (r) { return r.transaction_id === id; })[0];
    if (!candidate) throw error('purchase_transaction_id', 'ไม่พบรายการซื้อด้วยบัตรที่ยังไม่เชื่อมแผน');
    if (candidate.from_account_id !== plan.account_id) throw error('purchase_transaction_id', 'รายการซื้อต้องใช้บัตรเดียวกับแผน');
    if (Validation.toSatang(candidate.amount, 'amount') !== Validation.toSatang(plan.principal_amount, 'principal_amount')) {
      throw error('principal_amount', 'เงินต้นของแผนต้องเท่ากับยอดรายการซื้อ ' + candidate.amount + ' บาท');
    }
    if (candidate.transaction_date !== plan.purchase_date) throw error('purchase_date', 'วันที่ซื้อของแผนต้องตรงกับรายการซื้อ');
    if ((candidate.from_sub_account_id || '') !== plan.sub_account_id) throw error('sub_account_id', 'บัญชีย่อยต้องตรงกับรายการซื้อที่เลือก');
    return { mode: mode, transaction_id: id };
  }

  /** รายการ CREDIT_PURCHASE ที่ยังไม่เชื่อมแผนและไม่ถูกกลับรายการ (ใหม่สุดก่อน) */
  function purchaseCandidates() {
    var rows = Database.readAll('Transactions').rows;
    var reversed = new Set(rows.filter(function (r) { return r.reversal_of; }).map(function (r) { return r.reversal_of; }));
    return rows.filter(function (r) {
      return r.transaction_type === 'CREDIT_PURCHASE' && !r.reversal_of && !r.plan_id && !reversed.has(r.transaction_id);
    }).sort(function (a, b) { return a.transaction_date < b.transaction_date ? 1 : a.transaction_date > b.transaction_date ? -1 : 0; });
  }

  /** เขียนการเชื่อมรายการซื้อแบบ replay ได้ */
  function writeLink(link, plan, masters) {
    if (!link) return;
    if (link.mode === 'NEW') {
      // The checkpointed draft may predate a master rename made while this request was pending.
      Database.appendRowsIfAbsent('Transactions', [Projection.apply('Transactions', link.transaction, masters)]);
      return;
    }
    var row = Database.readAll('Transactions').rows.filter(function (r) { return r.transaction_id === link.transaction_id; })[0];
    if (!row) throw Util.AppError('NOT_FOUND', 'ไม่พบรายการซื้อที่เลือก');
    if (row.plan_id === plan.plan_id) return;
    if (row.plan_id) throw error('purchase_transaction_id', 'รายการซื้อนี้ถูกเชื่อมกับแผนอื่นแล้ว');
    Database.updateRows('Transactions', [Object.assign({}, row, { plan_id: plan.plan_id, updated_at: plan.created_at })]);
  }

  function schedulesOf(plan, amounts, masters, today) {
    return amounts.map(function (amount, index) {
      var saving = Validation.addMonths(plan.first_saving_month, index);
      var payment = Validation.addMonths(plan.first_payment_month, index);
      var due = Validation.dueDateOf(payment, plan.due_day);
      var baht = Validation.fromSatang(amount);
      return Projection.applyPlanToSchedule({
        installment_no: index + 1,
        saving_month: saving,
        payment_month: payment,
        due_date: due,
        amount_due: baht,
        amount_saved: 0,
        amount_reserved: 0,
        amount_paid: 0,
        remaining_to_save: baht,
        remaining_to_pay: baht,
        saving_status: 'NOT_SAVED',
        payment_status: 'UNPAID',
        is_overdue: !!due && due < today,
        is_cancelled: false,
        is_month_different: saving !== payment,
        saving_year: Validation.yearOf(saving),
        saving_month_no: Validation.monthOf(saving),
        payment_year: Validation.yearOf(payment),
        payment_month_no: Validation.monthOf(payment),
        remaining_installments: plan.installment_count,
        saving_completed_date: '',
        paid_date: '',
        note: ''
      }, plan, masters);
    });
  }

  function preview(input) {
    var masters = Projection.loadMasters();
    var draft = normalize(input, masters);
    var purchase = draft.link ? {
      mode: draft.link.mode, transaction_date: draft.plan.purchase_date, amount: draft.plan.principal_amount,
      account_name: draft.plan.account_name, transaction_id: draft.link.transaction_id || ''
    } : null;
    return { plan: draft.plan, schedules: schedulesOf(draft.plan, draft.amounts, masters, Util.todayIso()), purchase: purchase };
  }

  function create(input, request) {
    return Operation.run({
      operationType: 'CREATE_PLAN',
      idempotencyKey: request.idempotencyKey,
      actor: request.actor,
      payload: input
    }, function (ctx) {
      var masters = Projection.loadMasters();
      var draft = ctx.recoveryData;
      if (!draft) {
        draft = normalize(input, masters);
        draft.favorite = input.favorite !== undefined && Validation.requireBoolean(input.favorite, 'favorite');
        draft.plan.plan_id = ctx.id('plan');
        draft.plan.created_at = ctx.now;
        draft.plan.updated_at = ctx.now;
        draft.today = Util.todayIso();
        if (draft.link && draft.link.mode === 'NEW') {
          var tx = Object.assign(draft.link.transaction, {
            transaction_id: ctx.id('purchase'), plan_id: draft.plan.plan_id, reversal_of: '',
            created_at: ctx.now, updated_at: ctx.now
          });
          Projection.apply('Transactions', tx, masters);
        }
        ctx.checkpoint(draft);
      }

      var plan = Projection.apply(PLANS, draft.plan, masters);
      var schedules = schedulesOf(plan, draft.amounts, masters, draft.today);
      schedules.forEach(function (schedule) {
        schedule.schedule_id = ctx.id('schedule-' + schedule.installment_no);
        schedule.plan_id = plan.plan_id;
        schedule.created_at = plan.created_at;
        schedule.updated_at = plan.updated_at;
      });
      // Persist the choice before the schedules become payable. The operation lock and key cover retries.
      if (draft.favorite) Database.appendRowsIfAbsent('Settings', [favoriteSetting(request.actor, plan.plan_id, true, plan.created_at)]);
      if (input.fee_timing === 'FIRST' && plan.fee_amount > 0) {
        Database.appendRowsIfAbsent('Settings', [{ setting_key: feeTimingKey(plan.plan_id), setting_value: 'FIRST',
          description: 'รับรู้ค่าธรรมเนียมเมื่อชำระงวดแรก', updated_at: plan.created_at }]);
      }
      Database.appendRowsIfAbsent(PLANS, [plan]);
      Database.appendRowsIfAbsent(SCHEDULES, schedules);
      var saved = Database.readAll(SCHEDULES).rows.filter(function (r) { return r.plan_id === plan.plan_id; });
      if (saved.length !== schedules.length || !saved.every(function (row) {
        var expected = schedules[row.installment_no - 1];
        return expected && expected.schedule_id === row.schedule_id && expected.amount_due === row.amount_due;
      })) {
        throw Util.AppError('INTERNAL_ERROR', 'ตรวจสอบงวดที่บันทึกไม่สำเร็จ กรุณาลองใหม่');
      }
      writeLink(draft.link, plan, masters);
      if (draft.link && Database.readAll('Transactions').rows.filter(function (r) {
        return r.plan_id === plan.plan_id && r.transaction_type === 'CREDIT_PURCHASE';
      }).length !== 1) {
        throw Util.AppError('INTERNAL_ERROR', 'ตรวจสอบรายการซื้อที่เชื่อมแผนไม่สำเร็จ กรุณาลองใหม่');
      }
      return { plan_id: plan.plan_id };
    }).result;
  }

  function list(actor) {
    var schedulesByPlan = {};
    var paymentsByPlan = {};
    var purchaseByPlan = {};
    var today = Util.todayIso();
    var transactions = Database.readAll('Transactions').rows;
    var reversed = new Set(transactions.filter(function (r) { return r.reversal_of; }).map(function (r) { return r.reversal_of; }));
    var allocations = Database.readAll('PaymentAllocations').rows;
    var allocated = new Set(allocations.map(function (r) { return r.transaction_id; }));
    transactions.forEach(function (r) {
      if (r.plan_id && r.transaction_type === 'CREDIT_PURCHASE' && !r.reversal_of) {
        purchaseByPlan[r.plan_id] = { transaction_id: r.transaction_id, transaction_date: r.transaction_date, amount: r.amount };
      }
      if (r.plan_id && r.source === 'PLAN' && (r.transaction_type === 'EXPENSE' || r.transaction_type === 'CREDIT_PAYMENT') &&
          allocated.has(r.transaction_id) && !reversed.has(r.transaction_id)) {
        (paymentsByPlan[r.plan_id] || (paymentsByPlan[r.plan_id] = [])).push({
          transaction_id: r.transaction_id, transaction_date: r.transaction_date, amount: r.amount
        });
      }
    });
    var allSchedules = Database.readAll(SCHEDULES).rows;
    allSchedules.forEach(function (row) {
      row.is_overdue = !row.is_cancelled && row.remaining_to_pay > 0 && !!row.due_date && row.due_date < today;
      (schedulesByPlan[row.plan_id] || (schedulesByPlan[row.plan_id] = [])).push(row);
    });
    var settingRows = Database.readAll('Settings').rows;
    var settings = new Map(settingRows.map(function (row) { return [row.setting_key, row.setting_value]; }));
    var state = { accounts: Database.readAll('Accounts').rows, transactions: transactions, allocations: allocations, schedules: allSchedules, settings: settingRows };
    var starPrefix = favoritePrefix(actor);
    return Database.readAll(PLANS).rows.slice().reverse().reduce(function (result, plan) {
      var schedules = schedulesByPlan[plan.plan_id] || [];
      if (schedules.length === plan.installment_count) {
        schedules.sort(function (a, b) { return a.installment_no - b.installment_no; });
        var position = PaymentActivity.position(plan, state);
        var settlement = PlanRevision.activeSettlement(plan.plan_id, state);
        result.push({ plan: plan, schedules: schedules, payments: paymentsByPlan[plan.plan_id] || [], purchase: purchaseByPlan[plan.plan_id] || null,
          position: { principal_remaining: Validation.fromSatang(position.principalRemaining),
            interest_remaining: Validation.fromSatang(position.interestRemaining), fee_remaining: Validation.fromSatang(position.feeRemaining) },
          settlement_payment_id: settlement ? settlement.paymentId : '',
          first_installment_fee: settings.get(feeTimingKey(plan.plan_id)) === 'FIRST',
          favorite: settings.get(starPrefix + plan.plan_id) === 'ON' });
      }
      return result;
    }, []);
  }

  function extension(plan, input, ctx, masters) {
    if (plan.plan_type !== 'RECURRING') throw error('plan_type', 'ต่ออายุได้เฉพาะรายจ่ายประจำ');
    var count = Validation.requireInt(input.additional_count, 'additional_count', { min: 1, max: MAX_INSTALLMENTS - plan.installment_count });
    var amount = Validation.toSatang(input.renewal_amount, 'renewal_amount');
    if (amount < count) throw error('renewal_amount', 'ยอดต่ออายุต้องเพียงพอสำหรับทุกงวด');
    var oldCount = plan.installment_count;
    var extensionPlan = Object.assign({}, plan, {
      first_saving_month: Validation.addMonths(plan.first_saving_month, oldCount),
      first_payment_month: Validation.addMonths(plan.first_payment_month, oldCount),
      installment_count: count
    });
    plan.installment_count += count;
    var net = Validation.toSatang(plan.total_amount, 'total_amount') + amount;
    var principal = Validation.toSatang(plan.principal_amount, 'principal_amount', { allowZero: true }) + amount;
    Validation.toSatang(Validation.fromSatang(net), 'total_amount');
    plan.total_amount = Validation.fromSatang(net);
    plan.principal_amount = Validation.fromSatang(principal);
    return schedulesOf(extensionPlan, Validation.splitSatang(amount, count), masters, Util.todayIso()).map(function (row) {
      row.installment_no += oldCount;
      row.installment_count = plan.installment_count;
      row.schedule_id = ctx.id('renewal-' + row.installment_no);
      row.plan_id = plan.plan_id;
      row.created_at = ctx.now;
      row.updated_at = ctx.now;
      return row;
    });
  }

  return { preview: preview, create: create, list: list, extension: extension, purchaseCandidates: purchaseCandidates,
    hasFirstInstallmentFee: hasFirstInstallmentFee, setFavorite: setFavorite };
})();

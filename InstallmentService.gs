/** สร้างแผนรายจ่ายในอนาคตและงวดตามปฏิทิน */
var PaymentPlanner = (function () {
  var PLANS = 'PaymentPlans';
  var SCHEDULES = 'PaymentSchedules';
  var MAX_INSTALLMENTS = 360;

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

    var amounts = Validation.splitSatang(total, count);
    if (f.schedule_amounts !== undefined) {
      if (!Array.isArray(f.schedule_amounts) || f.schedule_amounts.length !== count) {
        throw error('schedule_amounts', 'จำนวนยอดรายงวดต้องตรงกับจำนวนงวด');
      }
      amounts = f.schedule_amounts.map(function (amount) { return Validation.toSatang(amount, 'schedule_amounts'); });
      if (amounts.reduce(function (sum, amount) { return sum + amount; }, 0) !== total) {
        throw error('schedule_amounts', 'ผลรวมรายงวดต้องตรงกับยอดรวมของแผน');
      }
    }
    // ตรวจขอบเขตก่อนเขียนลงชีต
    Validation.addMonths(plan.first_saving_month, count - 1);
    Validation.addMonths(plan.first_payment_month, count - 1);
    return { plan: plan, amounts: amounts };
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
    return { plan: draft.plan, schedules: schedulesOf(draft.plan, draft.amounts, masters, Util.todayIso()) };
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
        draft.plan.plan_id = ctx.id('plan');
        draft.plan.created_at = ctx.now;
        draft.plan.updated_at = ctx.now;
        draft.today = Util.todayIso();
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
      Database.appendRowsIfAbsent(PLANS, [plan]);
      Database.appendRowsIfAbsent(SCHEDULES, schedules);
      var saved = Database.readAll(SCHEDULES).rows.filter(function (r) { return r.plan_id === plan.plan_id; });
      if (saved.length !== schedules.length || !saved.every(function (row) {
        var expected = schedules[row.installment_no - 1];
        return expected && expected.schedule_id === row.schedule_id && expected.amount_due === row.amount_due;
      })) {
        throw Util.AppError('INTERNAL_ERROR', 'ตรวจสอบงวดที่บันทึกไม่สำเร็จ กรุณาลองใหม่');
      }
      return { plan_id: plan.plan_id };
    }).result;
  }

  function list() {
    var schedulesByPlan = {};
    var paymentsByPlan = {};
    var today = Util.todayIso();
    var transactions = Database.readAll('Transactions').rows;
    var reversed = new Set(transactions.filter(function (r) { return r.reversal_of; }).map(function (r) { return r.reversal_of; }));
    var allocated = new Set(Database.readAll('PaymentAllocations').rows.map(function (r) { return r.transaction_id; }));
    transactions.forEach(function (r) {
      if (r.plan_id && r.source === 'PLAN' && r.transaction_type === 'EXPENSE' && allocated.has(r.transaction_id) && !reversed.has(r.transaction_id)) {
        (paymentsByPlan[r.plan_id] || (paymentsByPlan[r.plan_id] = [])).push({
          transaction_id: r.transaction_id, transaction_date: r.transaction_date, amount: r.amount
        });
      }
    });
    Database.readAll(SCHEDULES).rows.forEach(function (row) {
      row.is_overdue = !row.is_cancelled && row.remaining_to_pay > 0 && !!row.due_date && row.due_date < today;
      (schedulesByPlan[row.plan_id] || (schedulesByPlan[row.plan_id] = [])).push(row);
    });
    return Database.readAll(PLANS).rows.slice().reverse().reduce(function (result, plan) {
      var schedules = schedulesByPlan[plan.plan_id] || [];
      if (schedules.length === plan.installment_count) {
        schedules.sort(function (a, b) { return a.installment_no - b.installment_no; });
        result.push({ plan: plan, schedules: schedules, payments: paymentsByPlan[plan.plan_id] || [] });
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

  return { preview: preview, create: create, list: list, extension: extension };
})();

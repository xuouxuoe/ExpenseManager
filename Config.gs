/**
 * Config.gs — ค่าคงที่ของระบบ Expense Manager V2
 * Canonical headers ต้องตรงกับ docs/database-schema.md §3 และ AGENTS.md §7.1 เสมอ
 */
var Config = {
  APP_NAME: 'Expense Manager',
  TIMEZONE: 'Asia/Bangkok',

  PROPERTY_KEYS: {
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    TEST_SPREADSHEET_ID: 'TEST_SPREADSHEET_ID',
    ALLOWED_EMAILS: 'ALLOWED_EMAILS',
    DB_TARGET: 'DB_TARGET',
    // สร้างอัตโนมัติครั้งแรกที่สร้างร่างผ่าน API: ใช้คำนวณ confirm_token ของร่าง (ไม่ส่งออกนอก server)
    API_DRAFT_SECRET: 'API_DRAFT_SECRET',
    // ผู้ให้บริการ AI สำหรับแปลงข้อความเป็นรายการ (เจ้าของตั้งใน Apps Script editor เท่านั้น)
    AI_PROVIDER: 'AI_PROVIDER',
    AI_API_KEY: 'AI_API_KEY',
    AI_MODEL: 'AI_MODEL',
    AI_BASE_URL: 'AI_BASE_URL',
    // LINE Messaging API: ใช้ตอบกลับข้อความ (เจ้าของตั้งผ่าน editor หรือหน้าเว็บ)
    LINE_CHANNEL_ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN'
  },

  LOCK_TIMEOUT_MS: 30000,
  MAX_RESULT_REF_LENGTH: 45000,

  SHEETS: {
    ACCOUNTS: 'Accounts',
    SUB_ACCOUNTS: 'SubAccounts',
    OWNERS: 'Owners',
    CATEGORIES: 'Categories',
    TRANSACTIONS: 'Transactions',
    PAYMENT_PLANS: 'PaymentPlans',
    PAYMENT_SCHEDULES: 'PaymentSchedules',
    RESERVATIONS: 'Reservations',
    PAYMENT_ALLOCATIONS: 'PaymentAllocations',
    SETTINGS: 'Settings',
    AUDIT_LOGS: 'AuditLogs',
    OPERATION_JOURNAL: 'OperationJournal',
    BUDGETS: 'Budgets',
    BUDGET_CATEGORIES: 'BudgetCategories',
    API_CLIENTS: 'ApiClients',
    API_DRAFTS: 'ApiDrafts'
  },

  HEADERS: {
    SubAccounts: ['sub_account_id', 'sub_account_name', 'account_id', 'is_active', 'created_at', 'updated_at'],
    Accounts: ['account_id', 'account_name', 'account_type', 'account_subtype', 'owner_id', 'institution', 'opening_balance', 'opening_date', 'credit_limit', 'statement_day', 'due_day', 'is_active', 'note', 'created_at', 'updated_at'],
    Owners: ['owner_id', 'owner_name', 'is_active', 'created_at', 'updated_at'],
    Categories: ['category_id', 'category_name', 'category_type', 'icon', 'color', 'is_active', 'created_at', 'updated_at'],
    Transactions: ['transaction_id', 'transaction_date', 'transaction_type', 'from_account_id', 'from_account_name', 'to_account_id', 'to_account_name', 'owner_id', 'owner_name', 'category_id', 'category_name', 'item_name', 'description', 'amount', 'plan_id', 'external_ref', 'source', 'reversal_of', 'note', 'created_at', 'updated_at'],
    PaymentPlans: ['plan_id', 'purchase_date', 'plan_type', 'account_id', 'account_name', 'owner_id', 'owner_name', 'category_id', 'category_name', 'item_name', 'description', 'principal_amount', 'interest_amount', 'fee_amount', 'total_amount', 'installment_count', 'first_saving_month', 'first_payment_month', 'due_day', 'external_ref', 'plan_status', 'note', 'created_at', 'updated_at'],
    PaymentSchedules: ['schedule_id', 'plan_id', 'purchase_date', 'plan_type', 'account_id', 'account_name', 'owner_id', 'owner_name', 'category_id', 'category_name', 'item_name', 'description', 'installment_no', 'installment_count', 'saving_month', 'payment_month', 'due_date', 'amount_due', 'amount_saved', 'amount_reserved', 'amount_paid', 'remaining_to_save', 'remaining_to_pay', 'saving_status', 'payment_status', 'is_overdue', 'is_cancelled', 'is_month_different', 'saving_year', 'saving_month_no', 'payment_year', 'payment_month_no', 'remaining_installments', 'saving_completed_date', 'paid_date', 'note', 'created_at', 'updated_at'],
    Reservations: ['reservation_id', 'reservation_date', 'schedule_id', 'account_id', 'action_type', 'amount', 'transaction_id', 'note', 'created_at'],
    PaymentAllocations: ['allocation_id', 'transaction_id', 'schedule_id', 'allocated_amount', 'created_at'],
    Settings: ['setting_key', 'setting_value', 'description', 'updated_at'],
    AuditLogs: ['audit_id', 'event_at', 'actor_id', 'action', 'entity_type', 'entity_id', 'operation_id', 'result'],
    OperationJournal: ['operation_id', 'idempotency_key', 'request_hash', 'actor_id', 'operation_type', 'status', 'recovery_data', 'result_ref', 'created_at', 'updated_at'],
    // งบใช้จ่ายรายเดือน/รายสัปดาห์ (อนุมัติ 2026-11-26) หนึ่งงบต่อแถว และหนึ่งหมวดของงบต่อแถว
    Budgets: ['budget_id', 'budget_month', 'budget_name', 'owner_id', 'owner_name', 'amount', 'weekly_amount', 'note', 'is_active', 'created_at', 'updated_at'],
    BudgetCategories: ['budget_category_id', 'budget_id', 'category_id', 'category_name', 'created_at'],
    // ผู้เรียก Integration API ภายนอก เช่น Make (อนุมัติ 2026-11-27) เก็บเฉพาะ hash ของ API key
    ApiClients: ['client_id', 'client_name', 'actor_id', 'key_hash', 'scopes', 'allowed_channel_user_ids', 'default_account_id', 'default_owner_id', 'is_active', 'created_at', 'updated_at'],
    // ร่างรายการจาก Integration API รอผู้ใช้ยืนยัน (อนุมัติ 2026-11-27) draft_json เก็บเฉพาะข้อมูลที่ resolve เป็น ID แล้ว
    ApiDrafts: ['draft_id', 'client_id', 'actor_id', 'channel_user_id', 'draft_status', 'draft_json', 'confirm_token_hash', 'transaction_id', 'error_code', 'expires_at', 'created_at', 'updated_at']
  },

  /** Primary key ของแต่ละตาราง */
  PRIMARY_KEYS: {
    SubAccounts: 'sub_account_id',
    Accounts: 'account_id',
    Owners: 'owner_id',
    Categories: 'category_id',
    Transactions: 'transaction_id',
    PaymentPlans: 'plan_id',
    PaymentSchedules: 'schedule_id',
    Reservations: 'reservation_id',
    PaymentAllocations: 'allocation_id',
    Settings: 'setting_key',
    AuditLogs: 'audit_id',
    OperationJournal: 'operation_id',
    Budgets: 'budget_id',
    BudgetCategories: 'budget_category_id',
    ApiClients: 'client_id',
    ApiDrafts: 'draft_id'
  },

  /** ชีตที่ระบบสร้างเองเมื่อเขียนครั้งแรก (ฟีเจอร์ที่เพิ่มภายหลัง) และอ่านเป็นตารางว่างถ้ายังไม่มี */
  AUTO_CREATE_SHEETS: ['SubAccounts', 'Budgets', 'BudgetCategories', 'ApiClients', 'ApiDrafts'],

  ENUMS: {
    ACCOUNT_TYPE: ['CASH', 'BANK', 'E_WALLET', 'CREDIT_CARD', 'CASH_CARD', 'LOAN'],
    ACCOUNT_SUBTYPE: ['SAVINGS'],
    CATEGORY_TYPE: ['INCOME', 'EXPENSE'],
    TRANSACTION_TYPE: ['INCOME', 'EXPENSE', 'TRANSFER', 'RECLASSIFY', 'CREDIT_PURCHASE', 'CREDIT_PAYMENT', 'CASH_ADVANCE', 'INTEREST', 'FEE', 'REFUND', 'ADJUSTMENT'],
    TRANSACTION_SOURCE: ['MANUAL', 'QUICK_ENTRY', 'PLAN', 'MIGRATION', 'AI'],
    PLAN_TYPE: ['INSTALLMENT', 'ONE_TIME', 'RECURRING'],
    PLAN_STATUS: ['ACTIVE', 'COMPLETED', 'CANCELLED'],
    SAVING_STATUS: ['NOT_SAVED', 'PARTIAL', 'SAVED', 'NOT_REQUIRED', 'CANCELLED'],
    PAYMENT_STATUS: ['UNPAID', 'PARTIAL', 'PAID', 'CANCELLED'],
    RESERVATION_ACTION: ['RESERVE', 'RELEASE', 'CONSUME'],
    OPERATION_STATUS: ['PENDING', 'COMMITTED', 'FAILED', 'NEEDS_RECOVERY'],
    AUDIT_RESULT: ['SUCCESS', 'FAILED'],
    API_SCOPE: ['READ', 'WRITE'],
    DRAFT_STATUS: ['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED'],
    AI_PROVIDER: ['OPENAI', 'OPENAI_COMPATIBLE', 'ANTHROPIC', 'GEMINI']
  },

  /** ความยาวสูงสุดของข้อความ (docs/database-schema.md §1.3) */
  TEXT_LIMITS: {
    NAME: 100,
    ITEM_NAME: 200,
    DESCRIPTION: 1000,
    NOTE: 1000,
    EXTERNAL_REF: 100
  },

  /** คอลัมน์ *_name ที่เป็น projection จาก Master: [id column, name column, master] */
  NAME_PROJECTIONS: {
    Transactions: [
      ['from_sub_account_id', 'from_sub_account_name', 'subAccounts'],
      ['to_sub_account_id', 'to_sub_account_name', 'subAccounts'],
      ['from_account_id', 'from_account_name', 'accounts'],
      ['to_account_id', 'to_account_name', 'accounts'],
      ['owner_id', 'owner_name', 'owners'],
      ['category_id', 'category_name', 'categories']
    ],
    PaymentPlans: [
      ['sub_account_id', 'sub_account_name', 'subAccounts'],
      ['account_id', 'account_name', 'accounts'],
      ['owner_id', 'owner_name', 'owners'],
      ['category_id', 'category_name', 'categories']
    ],
    PaymentSchedules: [
      ['sub_account_id', 'sub_account_name', 'subAccounts'],
      ['account_id', 'account_name', 'accounts'],
      ['owner_id', 'owner_name', 'owners'],
      ['category_id', 'category_name', 'categories']
    ],
    Budgets: [
      ['owner_id', 'owner_name', 'owners']
    ],
    BudgetCategories: [
      ['category_id', 'category_name', 'categories']
    ]
  },

  /** คอลัมน์ที่ PaymentSchedules คัดลอกจาก PaymentPlans (ไม่รวม note) */
  PLAN_TO_SCHEDULE_FIELDS: ['purchase_date', 'plan_type', 'account_id', 'owner_id', 'category_id', 'item_name', 'description', 'installment_count'],

  /**
   * ชนิดข้อมูลของคอลัมน์สำหรับจัดรูปแบบชีตและแปลงค่า: 'money' | 'int' | 'bool' | 'text'
   * text ทั้งหมดถูกตั้งรูปแบบ '@' เพื่อไม่ให้ Sheets แปลงวันที่/ID เป็นค่าอื่น
   */
  columnKind: function (name) {
    if (name.indexOf('is_') === 0) return 'bool';
    if (name === 'amount' || name.indexOf('amount_') === 0 || /_amount$/.test(name) ||
        name.indexOf('remaining_to_') === 0 || name === 'opening_balance' || name === 'credit_limit') {
      return 'money';
    }
    if (/_month$/.test(name) || /_month_no$/.test(name) || /_year$/.test(name) || /_day$/.test(name) ||
        name === 'installment_no' || name === 'installment_count' || name === 'remaining_installments') {
      return 'int';
    }
    return 'text';
  }
};

// Additive extension. Earlier headers remain a supported prefix when reading existing files.
Config.LEGACY_HEADERS = {};
['Transactions', 'PaymentPlans', 'PaymentSchedules'].forEach(function (name) {
  Config.LEGACY_HEADERS[name] = Config.HEADERS[name].slice();
});
Config.HEADERS.Transactions = Config.HEADERS.Transactions.concat(['from_sub_account_id', 'from_sub_account_name', 'to_sub_account_id', 'to_sub_account_name']);
Config.HEADERS.PaymentPlans = Config.HEADERS.PaymentPlans.concat(['sub_account_id', 'sub_account_name']);
Config.HEADERS.PaymentSchedules = Config.HEADERS.PaymentSchedules.concat(['sub_account_id', 'sub_account_name']);
Config.PLAN_TO_SCHEDULE_FIELDS.push('sub_account_id');

/**
 * AiService.gs — แปลงข้อความภาษาไทยเป็นข้อมูลร่างรายการด้วย AI (ระยะ A3, docs/integration-api.md ข้อ 0.3)
 *
 * - ผู้ให้บริการเลือกด้วย Script Property AI_PROVIDER: OPENAI (ค่าเริ่มต้น), OPENAI_COMPATIBLE (custom endpoint
 *   ที่ใช้รูปแบบ Chat Completions; ต้องตั้ง AI_BASE_URL), ANTHROPIC, GEMINI; ชื่อโมเดลใน AI_MODEL; key ใน AI_API_KEY
 * - ผลจาก AI เป็นเพียงข้อเสนอ: คืนเป็น params ของ draft.create ซึ่ง Backend ตรวจ/resolve อีกครั้ง (AGENTS.md §11)
 * - ส่งให้ AI เฉพาะข้อความผู้ใช้ วันที่วันนี้ และชื่อ+ID ของบัญชี/หมวด/เจ้าของ/งบทริปที่ใช้งานอยู่ — ไม่ส่งยอดเงินหรือประวัติ
 * - ไม่ log ข้อความผู้ใช้ คำตอบของ AI หรือ key; log เฉพาะผู้ให้บริการและ HTTP status เมื่อผิดพลาด
 * - ระยะ A6: parseImage อ่านรูปสลิป (base64) ด้วยโมเดลที่อ่านภาพได้ — ไม่เก็บและไม่ log รูป
 */
var AiParser = (function () {
  var MAX_TEXT = 500;
  var MAX_TOKENS = 600;
  var TOOL_NAME = 'record_transaction';
  var DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
  var BASE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
  var FIELDS = ['transaction_type', 'transaction_date', 'amount', 'from_account', 'to_account', 'category', 'owner', 'item_name', 'description', 'note', 'budget'];

  function fail(code, message) {
    return Util.AppError(code, message);
  }

  // ---------- การตั้งค่า ----------

  function config() {
    var props = PropertiesService.getScriptProperties();
    var get = function (k) { return String(props.getProperty(Config.PROPERTY_KEYS[k]) || '').trim(); };
    var provider = (get('AI_PROVIDER') || 'OPENAI').toUpperCase();
    if (Config.ENUMS.AI_PROVIDER.indexOf(provider) < 0) throw fail('AI_NOT_CONFIGURED', 'AI_PROVIDER ต้องเป็น ' + Config.ENUMS.AI_PROVIDER.join(', '));
    var key = get('AI_API_KEY');
    var model = get('AI_MODEL');
    if (!key || !model) throw fail('AI_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า AI_API_KEY และ AI_MODEL ใน Script Properties');
    var base = '';
    if (provider === 'OPENAI_COMPATIBLE') {
      base = get('AI_BASE_URL').replace(/\/+$/, '');
      if (!BASE_URL_RE.test(base)) throw fail('AI_NOT_CONFIGURED', 'AI_BASE_URL ต้องเป็น https://… (เช่น https://example.com/v1)');
    }
    return { provider: provider, key: key, model: model, base: base };
  }

  // ---------- Prompt / schema ----------

  function nullable(type, extra) {
    var out = { type: [type, 'null'] };
    Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /** JSON Schema ของผลลัพธ์ (ทุกฟิลด์ required + additionalProperties false เพื่อใช้กับ structured output แบบ strict) */
  function outputSchema() {
    var props = {
      intent: { type: 'string', enum: ['TRANSACTION', 'OTHER'], description: 'TRANSACTION when the text records income/expense/transfer/card purchase, otherwise OTHER' },
      transaction_type: nullable('string', { enum: ApiDrafts.TYPES.concat([null]) }),
      transaction_date: nullable('string', { description: 'YYYY-MM-DD (Gregorian). null = today' }),
      amount: nullable('number', { description: 'Positive amount in THB' }),
      from_account: nullable('string', { description: 'account_id from the list (source account / credit card)' }),
      to_account: nullable('string', { description: 'account_id from the list (destination account)' }),
      category: nullable('string', { description: 'category_id from the list with matching type' }),
      owner: nullable('string', { description: 'owner_id from the list' }),
      item_name: nullable('string', { description: 'Short item name in the user language' }),
      description: nullable('string', {}),
      note: nullable('string', {}),
      budget: nullable('string', { description: 'budget_id from the trip/project budget list only when the message names that budget or trip; otherwise null' }),
      message: nullable('string', { description: 'Short Thai message to the user when intent is OTHER or information is missing' })
    };
    return { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props };
  }

  function lines(rows, cols) {
    if (!rows.length) return '(none)';
    return rows.map(function (r) { return cols.map(function (c) { return String(r[c] === undefined ? '' : r[c]); }).join(' | '); }).join('\n');
  }

  /** คำแนะนำเพิ่มเมื่อผู้ใช้ส่งรูป (สลิปโอนเงิน/ใบเสร็จ) */
  var SLIP_RULES = [
    'The user sent an IMAGE instead of text. If it is a payment slip, transfer slip or receipt, extract ONE transaction from it.',
    'amount = the paid/transferred total (not fees or balances). transaction_date = the date on the slip (Thai slips often use Buddhist years such as "28 พ.ย. 69" = 2026-11-28).',
    'item_name = the payee/merchant/receiver name or what was bought (short). description may hold the reference number if shown.',
    'from_account = the user account whose bank/name matches the SENDER on the slip, only if clearly identifiable; otherwise null.',
    'Use EXPENSE for payments; use TRANSFER only when the receiver is clearly one of the user own accounts listed below (then set to_account).',
    'If the image is not a slip or receipt, or the amount is unreadable, set intent OTHER and explain briefly in Thai.'
  ].join('\n');

  function systemPrompt(masters, today, extra) {
    return [
      'You convert a Thai personal-finance chat message into one transaction record for the Expense Manager app.',
      'Today is ' + today + ' (Asia/Bangkok). Convert Buddhist years (พ.ศ.) to Gregorian by subtracting 543. Resolve relative dates such as "เมื่อวาน" from today.',
      'transaction_type: EXPENSE = paid from cash/bank/e-wallet; CREDIT_PURCHASE = paid with a credit card or cash card (from_account is that card);',
      'INCOME = money received into to_account; TRANSFER = move money between own asset accounts (from_account and to_account).',
      'Use ONLY ids from the lists below for from_account, to_account, category and owner. If unsure about from_account, to_account or owner, use null — the app applies the user defaults.',
      'category is REQUIRED for INCOME, EXPENSE and CREDIT_PURCHASE (there is no default): always choose the closest category of the matching type — INCOME categories for INCOME, EXPENSE categories for EXPENSE and CREDIT_PURCHASE. If nothing fits, use a general one such as "อื่นๆ"/"ทั่วไป" when listed. Never null for these types; null only for TRANSFER.',
      'amount must be a positive number (e.g. "1.2k" = 1200, "65 บาท" = 65). item_name is a short name of what was bought or received.',
      'If the message is not a transaction (a question, greeting, or missing amount) set intent OTHER and explain briefly in Thai in message.',
      'budget: set a budget_id from Trip budgets ONLY when the message mentions that budget or trip by name (e.g. "งบญี่ปุ่น", "ทริปเชียงใหม่"); never guess from the date alone.',
      'Budgets are for spending only (EXPENSE or CREDIT_PURCHASE). If the chosen budget has an owner_id, use that owner_id as owner.',
      'Return only the JSON object.',
      '',
      'Accounts (account_id | name | type):',
      lines(masters.accounts, ['account_id', 'account_name', 'account_type']),
      '',
      'Categories (category_id | name | type):',
      lines(masters.categories, ['category_id', 'category_name', 'category_type']),
      '',
      'Owners (owner_id | name):',
      lines(masters.owners, ['owner_id', 'owner_name']),
      '',
      'Trip budgets (budget_id | name | start_date | end_date | owner_id):',
      lines(masters.budgets || [], ['budget_id', 'budget_name', 'start_date', 'end_date', 'owner_id']),
      '',
      'Defaults: account_id=' + (masters.defaults.account_id || 'none') + ', owner_id=' + (masters.defaults.owner_id || 'none')
    ].concat(extra ? ['', extra] : []).join('\n');
  }

  // ---------- Provider adapters ----------

  function jsonPost(url, headers, body) {
    return { url: url, options: { method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(body), muteHttpExceptions: true } };
  }

  /** image (ถ้ามี): { mime, data (base64) } แนบไปกับข้อความผู้ใช้ตามรูปแบบของแต่ละผู้ให้บริการ */
  function buildRequest(cfg, system, text, schema, image) {
    var user = image ? text : 'Message:\n' + text;
    if (cfg.provider === 'ANTHROPIC') {
      return jsonPost('https://api.anthropic.com/v1/messages', { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' }, {
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        system: system,
        messages: [{ role: 'user', content: image
          ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }, { type: 'text', text: user }]
          : user }],
        tools: [{ name: TOOL_NAME, description: 'Record the parsed transaction', input_schema: schema }],
        tool_choice: { type: 'tool', name: TOOL_NAME }
      });
    }
    if (cfg.provider === 'GEMINI') {
      return jsonPost('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent', { 'x-goog-api-key': cfg.key }, {
        systemInstruction: { parts: [{ text: system + '\n\nJSON schema:\n' + JSON.stringify(schema) }] },
        contents: [{ role: 'user', parts: image ? [{ inline_data: { mime_type: image.mime, data: image.data } }, { text: user }] : [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: MAX_TOKENS }
      });
    }
    var messages = [{ role: 'system', content: system }, { role: 'user', content: image
      ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: 'data:' + image.mime + ';base64,' + image.data } }]
      : user }];
    if (cfg.provider === 'OPENAI') {
      return jsonPost(DEFAULT_OPENAI_BASE + '/chat/completions', { Authorization: 'Bearer ' + cfg.key }, {
        model: cfg.model,
        messages: messages,
        max_completion_tokens: MAX_TOKENS,
        response_format: { type: 'json_schema', json_schema: { name: TOOL_NAME, strict: true, schema: schema } }
      });
    }
    // OPENAI_COMPATIBLE: ระบบที่รองรับรูปแบบ OpenAI ส่วนใหญ่รองรับ json_object แต่ไม่ทุกตัวรองรับ json_schema
    messages[0].content += '\n\nJSON schema:\n' + JSON.stringify(schema);
    return jsonPost(cfg.base + '/chat/completions', { Authorization: 'Bearer ' + cfg.key }, {
      model: cfg.model,
      messages: messages,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' }
    });
  }

  function parseJsonText(text) {
    var cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var start = cleaned.indexOf('{');
    var end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw fail('AI_INVALID_OUTPUT', 'AI ตอบกลับไม่ใช่ JSON');
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      throw fail('AI_INVALID_OUTPUT', 'AI ตอบกลับไม่ใช่ JSON');
    }
  }

  /** ดึง object ผลลัพธ์จากคำตอบของผู้ให้บริการแต่ละแบบ */
  function extract(cfg, data) {
    if (cfg.provider === 'ANTHROPIC') {
      var tool = (data.content || []).filter(function (c) { return c && c.type === 'tool_use'; })[0];
      if (tool && tool.input && typeof tool.input === 'object') return tool.input;
      var textPart = (data.content || []).filter(function (c) { return c && c.type === 'text'; }).map(function (c) { return c.text; }).join('');
      return parseJsonText(textPart);
    }
    if (cfg.provider === 'GEMINI') {
      var cand = (data.candidates || [])[0];
      var parts = cand && cand.content && cand.content.parts ? cand.content.parts : [];
      return parseJsonText(parts.map(function (p) { return p.text || ''; }).join(''));
    }
    var choice = (data.choices || [])[0];
    var msg = choice && choice.message;
    if (msg && msg.refusal) throw fail('AI_INVALID_OUTPUT', 'AI ปฏิเสธการแปลงข้อความนี้');
    return parseJsonText(msg && msg.content);
  }

  function callProvider(cfg, system, text, image) {
    var req = buildRequest(cfg, system, text, outputSchema(), image);
    var res;
    try {
      res = UrlFetchApp.fetch(req.url, req.options);
    } catch (e) {
      console.log('AI_ERROR: ' + cfg.provider + ' fetch failed');
      throw fail('AI_ERROR', 'เชื่อมต่อบริการ AI ไม่สำเร็จ กรุณาลองใหม่');
    }
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      console.log('AI_ERROR: ' + cfg.provider + ' HTTP ' + code);
      throw fail('AI_ERROR', 'บริการ AI ตอบกลับผิดพลาด (HTTP ' + code + ')');
    }
    var data;
    try {
      data = JSON.parse(res.getContentText());
    } catch (e) {
      throw fail('AI_INVALID_OUTPUT', 'บริการ AI ตอบกลับไม่ใช่ JSON');
    }
    var out = extract(cfg, data);
    if (!out || typeof out !== 'object' || Array.isArray(out)) throw fail('AI_INVALID_OUTPUT', 'AI ตอบกลับไม่ถูกรูปแบบ');
    return out;
  }

  // ---------- ผลลัพธ์ ----------

  function clean(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return isFinite(value) ? value : '';
    return String(value).trim().slice(0, 1000);
  }

  /** ผลจาก AI → { intent, params (สำหรับ draft.create), message } */
  function normalize(out, text) {
    var message = clean(out.message);
    if (out.intent !== 'TRANSACTION') {
      return { intent: 'OTHER', params: null, message: message || 'ข้อความนี้ไม่ใช่รายการรับจ่าย' };
    }
    var params = {};
    FIELDS.forEach(function (k) {
      var v = clean(out[k]);
      if (v !== '') params[k] = v;
    });
    params.source_text = text;
    return { intent: 'TRANSACTION', params: params, message: message };
  }

  var GENERAL_CATEGORY_RE = /อื่น|ทั่วไป|เบ็ดเตล็ด|เบ็ดเสร็จ|misc|other|general/i;

  /**
   * AI ไม่ได้เลือกหมวด: ใช้หมวดทั่วไป (เช่น "อื่นๆ") ของประเภทที่ตรงกันถ้ามีหมวดเดียวที่ตรงชื่อ
   * ผู้ใช้ยังเห็นหมวดในสรุปร่างและต้องกดยืนยันก่อนบันทึก
   */
  function fillGeneralCategory(result, masters) {
    var p = result.params;
    if (!p || p.category || !p.transaction_type || p.transaction_type === 'TRANSFER') return result;
    var want = p.transaction_type === 'INCOME' ? 'INCOME' : 'EXPENSE';
    var hits = masters.categories.filter(function (c) { return c.category_type === want && GENERAL_CATEGORY_RE.test(c.category_name); });
    if (hits.length === 1) p.category = hits[0].category_id;
    return result;
  }

  /** แปลงข้อความเป็น params ของ draft.create (ไม่เขียนข้อมูล) */
  function parse(text, client) {
    var src = Validation.requireText(text, 'text', { required: true, max: MAX_TEXT, multiline: true });
    var cfg = config();
    var masters = ApiDrafts.masters(client);
    var out = callProvider(cfg, systemPrompt(masters, Util.todayIso()), src);
    var result = fillGeneralCategory(normalize(out, src), masters);
    result.provider = cfg.provider;
    return result;
  }

  var IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
  var MAX_IMAGE_BASE64 = 7 * 1024 * 1024; // ~5 MB ก่อนเข้ารหัส

  /**
   * อ่านรูปสลิป/ใบเสร็จเป็น params ของ draft.create (ไม่เขียนข้อมูล ไม่เก็บรูป)
   * image: { mime: image/jpeg|png|webp, data: base64 }
   */
  function parseImage(image, client) {
    var img = image || {};
    var mime = String(img.mime || '').toLowerCase().split(';')[0].trim();
    if (IMAGE_MIME.indexOf(mime) < 0) throw fail('UNSUPPORTED_IMAGE', 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP');
    if (typeof img.data !== 'string' || !img.data || img.data.length > MAX_IMAGE_BASE64) throw fail('UNSUPPORTED_IMAGE', 'รูปมีขนาดใหญ่เกินไป (เกิน 5 MB)');
    var cfg = config();
    var masters = ApiDrafts.masters(client);
    var out = callProvider(cfg, systemPrompt(masters, Util.todayIso(), SLIP_RULES), 'Read this slip image and return the JSON.', { mime: mime, data: img.data });
    var result = fillGeneralCategory(normalize(out, '(รูปสลิป)'), masters);
    result.provider = cfg.provider;
    return result;
  }

  return {
    parseImage: parseImage,
    MAX_TEXT: MAX_TEXT,
    config: config,
    parse: parse,
    buildRequest: buildRequest,
    outputSchema: outputSchema
  };
})();

/**
 * AiSettings — ตั้งค่าผู้ให้บริการ AI จากหน้าเว็บ (เก็บใน Script Properties ไม่ใช่ในชีต)
 * - ดูสถานะได้ทุกคนที่มีสิทธิ์ใช้ระบบ; แก้/ทดสอบได้เฉพาะเจ้าของสคริปต์
 * - API key เขียนได้อย่างเดียว: ไม่ส่งค่ากลับเบราว์เซอร์ (แสดงเฉพาะ 4 ตัวท้าย) ว่าง = ใช้ key เดิม
 * - journal/audit เก็บเฉพาะ hash ของ key
 */
var AiSettings = (function () {
  function key_(name) { return Config.PROPERTY_KEYS[name]; }
  var MODEL_RE = /^[A-Za-z0-9._:\/@+-]{1,100}$/;
  var KEY_RE = /^[\x21-\x7E]{8,500}$/;
  var BASE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;
  var SAMPLE_TEXT = 'กาแฟ 65 บาท';

  function invalid(field, message) {
    return Util.AppError('VALIDATION_AI_SETTINGS', message, { field: field });
  }

  function props() {
    return PropertiesService.getScriptProperties();
  }

  function view(actor) {
    var p = props();
    var get = function (k) { return String(p.getProperty(key_(k)) || '').trim(); };
    var key = get('AI_API_KEY');
    var provider = (get('AI_PROVIDER') || 'OPENAI').toUpperCase();
    var configured = true;
    try { AiParser.config(); } catch (e) { configured = false; }
    return {
      provider: provider,
      model: get('AI_MODEL'),
      base_url: get('AI_BASE_URL'),
      has_key: !!key,
      key_hint: key ? key.slice(-4) : '',
      configured: configured,
      can_edit: Auth.isOwner(actor),
      providers: Config.ENUMS.AI_PROVIDER.slice()
    };
  }

  /** input: { provider, model, base_url, api_key (ว่าง = ใช้ key เดิม) } */
  function save(input, request) {
    Auth.requireOwnerActor(request.actor);
    var src = input || {};
    var provider = Validation.requireEnum(String(src.provider || '').trim().toUpperCase(), Config.ENUMS.AI_PROVIDER, 'provider');
    var model = String(src.model || '').trim();
    if (!MODEL_RE.test(model)) throw invalid('model', 'ชื่อโมเดลต้องเป็นตัวอักษรอังกฤษ ตัวเลข หรือ . _ : / @ + - ไม่เกิน 100 ตัว');
    var base = String(src.base_url || '').trim().replace(/\/+$/, '');
    if (provider === 'OPENAI_COMPATIBLE') {
      if (!BASE_URL_RE.test(base)) throw invalid('base_url', 'Base URL ต้องเป็น https://… (เช่น https://example.com/v1)');
    } else {
      base = '';
    }
    var key = String(src.api_key || '').trim();
    if (key && !KEY_RE.test(key)) throw invalid('api_key', 'API key ไม่ถูกต้อง (8–500 ตัว ไม่มีช่องว่าง)');
    if (!key && !String(props().getProperty(key_('AI_API_KEY')) || '').trim()) throw invalid('api_key', 'กรุณากรอก API key');
    var payload = { provider: provider, model: model, base_url: base, key_hash: key ? Util.sha256Hex(key) : 'KEEP' };
    Operation.run({ operationType: 'UPDATE_AI_SETTINGS', idempotencyKey: request.idempotencyKey, payload: payload, actor: request.actor }, function () {
      var p = props();
      p.setProperty(key_('AI_PROVIDER'), provider);
      p.setProperty(key_('AI_MODEL'), model);
      p.setProperty(key_('AI_BASE_URL'), base);
      if (key) p.setProperty(key_('AI_API_KEY'), key);
      return { provider: provider, model: model };
    });
    return view(request.actor);
  }

  /** ทดสอบการเชื่อมต่อด้วยข้อความตัวอย่าง (ไม่เขียนข้อมูล; ส่งชื่อ+ID ข้อมูลหลักไปยังผู้ให้บริการ AI) */
  function test(actor) {
    Auth.requireOwnerActor(actor);
    var started = Date.now();
    var result = AiParser.parse(SAMPLE_TEXT, { client_id: '', default_account_id: '', default_owner_id: '' });
    return { sample_text: SAMPLE_TEXT, elapsed_ms: Date.now() - started, result: result };
  }

  return { view: view, save: save, test: test };
})();

/**
 * IntegrationService.gs — Integration API สำหรับผู้เรียกภายนอก เช่น LINE OA / สคริปต์ (อนุมัติ 2026-11-27)
 * แผนและสัญญา API: docs/integration-api.md
 *
 * ApiClients: จัดการผู้เรียก (สร้าง/แก้/ปิด/หมุน key) จากหน้าเว็บที่ล็อกอิน Google แล้ว
 *   - API key สร้างฝั่งเบราว์เซอร์ (crypto.getRandomValues) แสดงให้ผู้ใช้ครั้งเดียว
 *     Backend รับมาเพื่อคำนวณ hash เท่านั้น: เก็บเฉพาะ key_hash และไม่ใส่ key ลง journal/audit/log
 * IntegrationApi: รับคำขอจาก doPost (Web App แบบไม่ต้องล็อกอิน)
 *   - doPost อ่าน HTTP header ไม่ได้: api_key อยู่ใน JSON body
 *   - ตอบ HTTP 200 เสมอ ผู้เรียกต้องตรวจ ok ใน body
 *   - actor ของคำขอ = actor_id ของ client ซึ่งต้องยังอยู่ใน ALLOWED_EMAILS
 */
var ApiClients = (function () {
  var SHEET = 'ApiClients';
  var KEY_RE = /^emk_[A-Za-z0-9_-]{43}$/;
  var CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var MAX_CHANNEL_IDS = 20;

  function fail(field, message) {
    return Util.AppError('VALIDATION_API_CLIENT', message, { field: field });
  }

  function hashKey(apiKey) {
    return Util.sha256Hex('expense-manager-api-key\u0000' + apiKey);
  }

  function requireKey(apiKey) {
    if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) throw fail('api_key', 'API key ไม่อยู่ในรูปแบบที่กำหนด');
    return apiKey;
  }

  function listOf(value) {
    if (Validation.isBlank(value)) return [];
    var items = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
    return items.map(function (v) { return String(v === null || v === undefined ? '' : v).trim(); }).filter(function (v) { return v !== ''; });
  }

  function parseScopes(value) {
    var scopes = [];
    listOf(value).forEach(function (s) {
      var v = Validation.requireEnum(s, Config.ENUMS.API_SCOPE, 'scopes');
      if (scopes.indexOf(v) < 0) scopes.push(v);
    });
    if (!scopes.length) throw fail('scopes', 'กรุณาเลือกสิทธิ์อย่างน้อย 1 อย่าง');
    return Config.ENUMS.API_SCOPE.filter(function (s) { return scopes.indexOf(s) >= 0; });
  }

  function parseChannels(value) {
    var out = [];
    listOf(value).forEach(function (id) {
      if (!CHANNEL_ID_RE.test(id)) throw fail('allowed_channel_user_ids', 'รหัสผู้ใช้ช่องทาง (เช่น LINE userId) ไม่ถูกต้อง: ' + id.slice(0, 20));
      if (out.indexOf(id) < 0) out.push(id);
    });
    if (out.length > MAX_CHANNEL_IDS) throw fail('allowed_channel_user_ids', 'ระบุรหัสผู้ใช้ช่องทางได้ไม่เกิน ' + MAX_CHANNEL_IDS + ' รายการ');
    return out;
  }

  function requireActiveMaster(sheetName, pk, value, field, label) {
    var id = Validation.requireId(value, field, { required: false });
    if (!id) return '';
    var row = Database.readAll(sheetName).rows.filter(function (r) { return r[pk] === id; })[0];
    if (!row) throw fail(field, 'ไม่พบ' + label + 'ที่เลือก');
    if (row.is_active !== true) throw fail(field, label + 'ที่เลือกถูกปิดใช้งานแล้ว');
    return id;
  }

  /** ตรวจข้อมูลที่ผู้ใช้แก้ได้ (ไม่รวม key และ is_active) */
  function validateInput(input) {
    var src = input || {};
    return {
      client_name: Validation.requireText(src.client_name, 'client_name', { required: true, max: Config.TEXT_LIMITS.NAME }),
      scopes: parseScopes(src.scopes).join(','),
      allowed_channel_user_ids: parseChannels(src.allowed_channel_user_ids).join(','),
      default_account_id: requireActiveMaster('Accounts', 'account_id', src.default_account_id, 'default_account_id', 'บัญชี'),
      default_owner_id: requireActiveMaster('Owners', 'owner_id', src.default_owner_id, 'default_owner_id', 'เจ้าของ')
    };
  }

  /** ข้อมูลที่ส่งให้หน้าเว็บ: ไม่มี key_hash */
  function toPublic(row) {
    return {
      client_id: row.client_id,
      client_name: row.client_name,
      actor_id: row.actor_id,
      scopes: listOf(row.scopes),
      allowed_channel_user_ids: listOf(row.allowed_channel_user_ids),
      default_account_id: row.default_account_id || '',
      default_owner_id: row.default_owner_id || '',
      is_active: row.is_active === true,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  function rows() {
    return Database.readAll(SHEET);
  }

  function findRow(id) {
    var clientId = Validation.requireId(id, 'client_id');
    var all = rows();
    for (var i = 0; i < all.rows.length; i++) {
      if (all.rows[i].client_id === clientId) return { row: all.rows[i], rowNumber: all.rowNumbers[i], rows: all.rows };
    }
    throw Util.AppError('NOT_FOUND', 'ไม่พบการเชื่อมต่อนี้');
  }

  function assertKeyUnused(all, keyHash, selfId) {
    var used = all.some(function (r) { return r.key_hash === keyHash && r.client_id !== selfId; });
    if (used) throw fail('api_key', 'API key นี้ถูกใช้แล้ว กรุณาสร้างใหม่');
  }

  function list() {
    return rows().rows.map(toPublic).sort(function (a, b) { return Number(a.client_id) - Number(b.client_id); });
  }

  /** input: { client_name, scopes, allowed_channel_user_ids, default_account_id, default_owner_id, api_key } */
  function create(input, request) {
    var src = input || {};
    var keyHash = hashKey(requireKey(src.api_key));
    // payload สำหรับ idempotency ใช้ hash แทน key จริง
    var payload = Object.assign({}, src, { api_key: undefined, key_hash: keyHash });
    return Operation.run({ operationType: 'CREATE_API_CLIENT', idempotencyKey: request.idempotencyKey, payload: payload, actor: request.actor }, function (ctx) {
      var clean = validateInput(src);
      var id = ctx.id(SHEET, 'client');
      var all = rows().rows;
      if (!all.some(function (r) { return r.client_id === id; })) assertKeyUnused(all, keyHash, id);
      var row = Object.assign({ client_id: id, actor_id: ctx.actorId, key_hash: keyHash, is_active: true, created_at: ctx.now, updated_at: ctx.now }, clean);
      Database.appendRowsIfAbsent(SHEET, [row]);
      return toPublic(findRow(id).row);
    }).result;
  }

  function update(id, input, request) {
    return Operation.run({ operationType: 'UPDATE_API_CLIENT', idempotencyKey: request.idempotencyKey, payload: { id: id, input: input }, actor: request.actor }, function (ctx) {
      var found = findRow(id);
      var clean = validateInput(input);
      var row = Object.assign({}, found.row, clean, { updated_at: ctx.now });
      Database.writeRowAt(SHEET, found.rowNumber, row);
      return toPublic(row);
    }).result;
  }

  function setActive(id, active, request) {
    var flag = Validation.requireBoolean(active, 'is_active');
    return Operation.run({ operationType: flag ? 'ENABLE_API_CLIENT' : 'DISABLE_API_CLIENT', idempotencyKey: request.idempotencyKey, payload: { id: id, active: flag }, actor: request.actor }, function (ctx) {
      var found = findRow(id);
      if (found.row.is_active === flag) return toPublic(found.row);
      var row = Object.assign({}, found.row, { is_active: flag, updated_at: ctx.now });
      Database.writeRowAt(SHEET, found.rowNumber, row);
      return toPublic(row);
    }).result;
  }

  /** เปลี่ยน key: key เดิมใช้ไม่ได้ทันที */
  function rotateKey(id, apiKey, request) {
    var keyHash = hashKey(requireKey(apiKey));
    return Operation.run({ operationType: 'ROTATE_API_KEY', idempotencyKey: request.idempotencyKey, payload: { id: id, key_hash: keyHash }, actor: request.actor }, function (ctx) {
      var found = findRow(id);
      if (found.row.key_hash === keyHash) return toPublic(found.row);
      assertKeyUnused(found.rows, keyHash, found.row.client_id);
      var row = Object.assign({}, found.row, { key_hash: keyHash, updated_at: ctx.now });
      Database.writeRowAt(SHEET, found.rowNumber, row);
      return toPublic(row);
    }).result;
  }

  /** หา client ที่ใช้งานได้จาก key; ไม่พบ/รูปแบบผิด/ปิดแล้ว → null (ไม่บอกเหตุผลแยก) */
  function authenticate(apiKey) {
    if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) return null;
    var keyHash = hashKey(apiKey);
    var row = rows().rows.filter(function (r) { return r.key_hash === keyHash; })[0];
    if (!row || row.is_active !== true) return null;
    return { client_id: row.client_id, client_name: row.client_name, actor_id: row.actor_id,
      scopes: listOf(row.scopes), channels: listOf(row.allowed_channel_user_ids),
      default_account_id: row.default_account_id || '', default_owner_id: row.default_owner_id || '' };
  }

  return {
    list: list,
    create: create,
    update: update,
    setActive: setActive,
    rotateKey: rotateKey,
    authenticate: authenticate,
    hashKey: hashKey
  };
})();

var IntegrationApi = (function () {
  var API_VERSION = 1;
  var MAX_BODY_LENGTH = 100000;
  var RATE_LIMIT_PER_MINUTE = 60;

  var REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

  /**
   * action → { scope: 'READ' | 'WRITE' | null, channel: 'optional' | 'required', requestId: true (ต้องส่ง request_id), run(params, call) }
   * call = { client, actor: { actorId }, requestId, channelUserId }
   */
  var ACTIONS = {
    ping: {
      scope: null,
      channel: 'optional',
      run: function (params, call) {
        return {
          api_version: API_VERSION,
          client_id: call.client.client_id,
          client_name: call.client.client_name,
          scopes: call.client.scopes,
          db_target: Database.currentTarget(),
          server_time: Util.nowIso()
        };
      }
    },
    'masters.list': {
      scope: 'READ',
      channel: 'optional',
      run: function (params, call) { return ApiDrafts.masters(call.client); }
    },
    'draft.create': {
      scope: 'WRITE',
      channel: 'required',
      requestId: true,
      run: function (params, call) { return ApiDrafts.create(params, call); }
    },
    'draft.confirm': {
      scope: 'WRITE',
      channel: 'required',
      run: function (params, call) { return ApiDrafts.confirm(params, call); }
    },
    'draft.cancel': {
      scope: 'WRITE',
      channel: 'required',
      run: function (params, call) { return ApiDrafts.cancel(params, call); }
    },
    // แปลงข้อความด้วย AI → params ของ draft.create (ไม่เขียนข้อมูล; ต้องมีสิทธิ์ WRITE เพราะใช้เพื่อบันทึกและมีค่าใช้จ่าย AI)
    'ai.parse': {
      scope: 'WRITE',
      channel: 'optional',
      run: function (params, call) { return AiParser.parse(params.text, call.client); }
    }
  };

  function reject(code, message) {
    return Util.AppError(code, message);
  }

  function parseBody(e) {
    var text = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (!text) throw reject('BAD_REQUEST', 'ต้องส่งคำขอเป็น JSON ใน body');
    if (text.length > MAX_BODY_LENGTH) throw reject('PAYLOAD_TOO_LARGE', 'คำขอมีขนาดใหญ่เกินไป');
    var body;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw reject('BAD_REQUEST', 'body ต้องเป็น JSON ที่ถูกต้อง');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw reject('BAD_REQUEST', 'body ต้องเป็น JSON object');
    return body;
  }

  function checkActor(client) {
    var allowed = String(PropertiesService.getScriptProperties().getProperty(Config.PROPERTY_KEYS.ALLOWED_EMAILS) || '')
      .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s !== ''; });
    if (allowed.indexOf(String(client.actor_id || '').toLowerCase()) < 0) {
      throw reject('FORBIDDEN', 'ผู้ใช้ที่สร้างการเชื่อมต่อนี้ไม่มีสิทธิ์ใช้งานระบบแล้ว');
    }
  }

  function checkChannel(client, channelUserId, mode) {
    var id = channelUserId === undefined || channelUserId === null ? '' : String(channelUserId).trim();
    if (!client.channels.length) return id;
    if (!id) {
      if (mode === 'required') throw reject('FORBIDDEN_CHANNEL', 'ต้องระบุ channel_user_id');
      return '';
    }
    if (client.channels.indexOf(id) < 0) throw reject('FORBIDDEN_CHANNEL', 'channel_user_id นี้ไม่ได้รับอนุญาต');
    return id;
  }

  /** นับคำขอต่อ client ต่อนาทีด้วย CacheService (ประมาณการ ไม่ใช่ตัวนับแบบ atomic) */
  function rateLimit(client) {
    var cache = CacheService.getScriptCache();
    var key = 'api-rl:' + client.client_id + ':' + Math.floor(Date.now() / 60000);
    var count = Number(cache.get(key) || 0);
    if (count >= RATE_LIMIT_PER_MINUTE) throw reject('RATE_LIMITED', 'เรียกใช้บ่อยเกินไป กรุณารอสักครู่');
    cache.put(key, String(count + 1), 120);
  }

  /** ประมวลผลคำขอ คืน { ok, data } หรือ { ok:false, code, message, details } (ใช้ทดสอบได้โดยไม่ผ่าน ContentService) */
  function dispatch(e) {
    try {
      Database.resetExecutionCache();
      var body = parseBody(e);
      var client = ApiClients.authenticate(body.api_key);
      if (!client) throw reject('UNAUTHORIZED', 'API key ไม่ถูกต้องหรือถูกปิดใช้งาน');
      checkActor(client);
      var action = typeof body.action === 'string' ? body.action : '';
      var def = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
      if (!def) throw reject('UNKNOWN_ACTION', 'ไม่รู้จัก action นี้');
      if (def.scope && client.scopes.indexOf(def.scope) < 0) throw reject('FORBIDDEN_SCOPE', 'API key นี้ไม่มีสิทธิ์ ' + def.scope);
      var channelUserId = checkChannel(client, body.channel_user_id, def.channel);
      if (def.requestId && (typeof body.request_id !== 'string' || !REQUEST_ID_RE.test(body.request_id))) {
        throw reject('INVALID_REQUEST_ID', 'ต้องส่ง request_id 8–128 ตัว (A-Z a-z 0-9 _ -) และใช้ค่าเดิมเมื่อส่งซ้ำ');
      }
      rateLimit(client);
      var params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
      var data = def.run(params, {
        client: client,
        actor: { actorId: client.actor_id },
        requestId: body.request_id,
        channelUserId: channelUserId
      });
      return { ok: true, data: data };
    } catch (err) {
      var out = Util.toClientError(err);
      // ไม่ log body/key; บันทึกเฉพาะข้อผิดพลาดภายในเพื่อตรวจสอบ
      if (out.code === 'INTERNAL_ERROR') console.log('INTEGRATION_INTERNAL_ERROR: ' + (err && err.message));
      return out;
    }
  }

  /** ตรวจผู้ใช้/สิทธิ์/อัตราการเรียก สำหรับช่องทางอื่นที่ยืนยันตัวตนด้วย ApiClients (เช่น LINE webhook) */
  function guard(client, scope) {
    checkActor(client);
    if (scope && client.scopes.indexOf(scope) < 0) throw reject('FORBIDDEN_SCOPE', 'API key นี้ไม่มีสิทธิ์ ' + scope);
    rateLimit(client);
  }

  /** คำขอที่มี ?line_key=… ใน URL เป็น LINE webhook; อื่น ๆ เป็น JSON API */
  function handlePost(e) {
    var out = LineWebhook.isLineRequest(e) ? LineWebhook.handle(e) : dispatch(e);
    return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
  }

  return {
    dispatch: dispatch,
    guard: guard,
    handlePost: handlePost,
    actions: function () { return Object.keys(ACTIONS); }
  };
})();

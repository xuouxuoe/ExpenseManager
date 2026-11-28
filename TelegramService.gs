/**
 * TelegramService.gs — รับ Telegram Bot webhook โดยตรง (เทียบเท่า LINE ใน LineService.gs)
 *
 * Telegram ──POST──> gateway /exec?tg_key=<API key ของการเชื่อมต่อ> ──> TelegramWebhook.handle
 *   ข้อความ/รูปสลิป → AiParser → ApiDrafts.create → sendMessage พร้อมปุ่ม inline [ยกเลิก][ยืนยัน]
 *   callback_query ยืนยัน/ยกเลิก → ApiDrafts.confirm / cancel → ตอบสรุป
 *
 * ความปลอดภัย (doPost อ่าน header ไม่ได้ จึงใช้ secret_token ของ Telegram ไม่ได้):
 * - tg_key = API key ของการเชื่อมต่อที่มีสิทธิ์ WRITE; ต้องกำหนด Telegram user id ที่อนุญาต (เก็บเป็น tg_<id>)
 * - รับเฉพาะแชตส่วนตัว (chat.type = private); ทุกการบันทึกต้องกดยืนยันพร้อม token ที่ตรง
 * - กันข้อความซ้ำ (Telegram ส่งซ้ำเมื่อไม่ได้ 200) ด้วย update_id ใน CacheService และ request_id ของร่าง
 * - ไม่ log ข้อความผู้ใช้ token หรือ key
 */
var TelegramWebhook = (function () {
  var API_BASE = 'https://api.telegram.org/bot';
  var FILE_BASE = 'https://api.telegram.org/file/bot';
  var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  var MAX_BODY_LENGTH = 100000;
  var DEDUPE_SECONDS = 6 * 60 * 60;
  var CHANNEL_PREFIX = 'tg_';
  var IMAGE_EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

  function isTelegramRequest(e) {
    return !!(e && e.parameter && typeof e.parameter.tg_key === 'string');
  }

  function channelIdOf(userId) {
    return CHANNEL_PREFIX + String(userId || '').replace(/[^0-9]/g, '').slice(0, 20);
  }

  function botToken() {
    return String(PropertiesService.getScriptProperties().getProperty(Config.PROPERTY_KEYS.TELEGRAM_BOT_TOKEN) || '').trim();
  }

  // ---------- ส่งข้อความ ----------

  var replyIssue = '';

  function maskError(e) {
    return String((e && e.message) || e || '').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  /** เรียก Bot API แบบ JSON; คืน result หรือ null เมื่อผิดพลาด (บันทึกสาเหตุใน replyIssue) */
  function callApi(method, payload) {
    var token = botToken();
    if (!token) {
      console.log('TELEGRAM_NOT_CONFIGURED: ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN');
      replyIssue = 'TELEGRAM_NOT_CONFIGURED';
      return null;
    }
    try {
      var res = UrlFetchApp.fetch(API_BASE + token + '/' + method, {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code < 200 || code >= 300) {
        console.log('TELEGRAM_ERROR: ' + method + ' HTTP ' + code);
        replyIssue = 'TELEGRAM_HTTP_' + code;
        return null;
      }
      var data = JSON.parse(res.getContentText() || '{}');
      return data && data.ok ? (data.result === undefined ? true : data.result) : null;
    } catch (e) {
      var detail = maskError(e);
      console.log('TELEGRAM_ERROR: ' + method + ' failed: ' + detail);
      replyIssue = 'TELEGRAM_FAILED [' + detail + ']';
      return null;
    }
  }

  function send(chatId, text, buttons) {
    var payload = { chat_id: chatId, text: String(text).slice(0, 4000) };
    if (buttons) payload.reply_markup = { inline_keyboard: [buttons] };
    return callApi('sendMessage', payload);
  }

  // คำสั่ง วิธีใช้ และข้อความผิดพลาด: ChatCommands.gs (ใช้ร่วมกับ LINE)

  /** callback_data ของ Telegram ยาวได้ไม่เกิน 64 ไบต์: em|<c|x>|<draft_id>|<token 32 hex> */
  function callbackData(action, draft) {
    return 'em|' + action + '|' + draft.draft_id + '|' + draft.confirm_token;
  }

  function draftButtons(draft) {
    return [
      { text: 'ยกเลิก', callback_data: callbackData('x', draft) },
      { text: '✅ ยืนยัน', callback_data: callbackData('c', draft) }
    ];
  }

  // ---------- เหตุการณ์ ----------

  function seen(client, updateId) {
    if (updateId === undefined || updateId === null || updateId === '') return false;
    var cache = CacheService.getScriptCache();
    var key = 'tg-upd:' + client.client_id + ':' + String(updateId).slice(0, 30);
    if (cache.get(key)) return true;
    cache.put(key, '1', DEDUPE_SECONDS);
    return false;
  }

  function requestIdOf(updateId) {
    var clean = String(updateId === undefined || updateId === null ? '' : updateId).replace(/[^0-9]/g, '').slice(0, 30);
    return clean ? 'tg-update-' + clean : 'tg-' + Utilities.getUuid().replace(/-/g, '');
  }

  function draftFromParsed(parsed, call, chatId) {
    if (parsed.intent !== 'TRANSACTION' && parsed.intent !== 'PLAN') {
      send(chatId, (parsed.message || 'ข้อความนี้ไม่ใช่รายการรับจ่าย') + '\nพิมพ์ "วิธีใช้" เพื่อดูตัวอย่าง');
      return 'other';
    }
    var draft = ApiDrafts.create(parsed.params, call);
    send(chatId, 'ตรวจรายการก่อนบันทึก\n\n' + draft.summary_text, draftButtons(draft));
    return 'draft';
  }

  function onText(body, call, chatId) {
    var text = String(body || '').trim();
    if (ChatCommands.isHelp(text)) {
      send(chatId, ChatCommands.helpText());
      return 'help';
    }
    var command = ChatCommands.find(text);
    if (command) {
      send(chatId, ChatCommands.run(command, call.client));
      return command.result;
    }
    return draftFromParsed(AiParser.parse(text, call.client), call, chatId);
  }

  /** เลือกไฟล์รูป: photo (ขนาดใหญ่สุดที่ไม่เกิน 5 MB) หรือ document ที่เป็นรูป */
  function imageFileOf(message) {
    if (Array.isArray(message.photo) && message.photo.length) {
      var ok = message.photo.filter(function (p) { return p && p.file_id && (!p.file_size || p.file_size <= MAX_IMAGE_BYTES); });
      var best = ok.sort(function (a, b) { return (b.file_size || b.width || 0) - (a.file_size || a.width || 0); })[0];
      return best ? { file_id: best.file_id, mime: 'image/jpeg' } : { tooLarge: true };
    }
    var doc = message.document;
    if (doc && doc.file_id && /^image\/(jpeg|png|webp)$/.test(String(doc.mime_type || ''))) {
      if (doc.file_size && doc.file_size > MAX_IMAGE_BYTES) return { tooLarge: true };
      return { file_id: doc.file_id, mime: doc.mime_type };
    }
    return null;
  }

  /** รูปสลิป: getFile → ดาวน์โหลด → AI อ่านรูป → ร่าง (ไม่เก็บรูป) */
  function onImage(file, call, chatId) {
    if (file.tooLarge) throw Util.AppError('UNSUPPORTED_IMAGE', 'รูปมีขนาดใหญ่เกินไป (เกิน 5 MB)');
    var token = botToken();
    if (!token) throw Util.AppError('TELEGRAM_NOT_CONFIGURED', 'ยังไม่ได้ตั้ง Telegram bot token จึงดึงรูปไม่ได้');
    var info = callApi('getFile', { file_id: String(file.file_id).slice(0, 200) });
    var path = info && typeof info.file_path === 'string' ? info.file_path : '';
    if (!/^[A-Za-z0-9_.\/-]{1,200}$/.test(path)) throw Util.AppError('TELEGRAM_CONTENT_ERROR', 'ดึงรูปจาก Telegram ไม่สำเร็จ กรุณาส่งรูปใหม่อีกครั้ง');
    var res = UrlFetchApp.fetch(FILE_BASE + token + '/' + path, { method: 'get', muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      console.log('TELEGRAM_ERROR: file HTTP ' + code);
      throw Util.AppError('TELEGRAM_CONTENT_ERROR', 'ดึงรูปจาก Telegram ไม่สำเร็จ กรุณาส่งรูปใหม่อีกครั้ง');
    }
    var bytes = res.getBlob().getBytes();
    if (bytes.length > MAX_IMAGE_BYTES) throw Util.AppError('UNSUPPORTED_IMAGE', 'รูปมีขนาดใหญ่เกินไป (เกิน 5 MB)');
    var ext = (path.split('.').pop() || '').toLowerCase();
    var mime = IMAGE_EXT_MIME[ext] || file.mime || 'image/jpeg';
    var parsed = AiParser.parseImage({ mime: mime, data: Utilities.base64Encode(bytes) }, call.client);
    return draftFromParsed(parsed, call, chatId);
  }

  function onCallback(cq, call, chatId) {
    var parts = String(cq.data || '').split('|');
    callApi('answerCallbackQuery', { callback_query_id: String(cq.id || '') });
    if (parts.length !== 4 || parts[0] !== 'em' || (parts[1] !== 'c' && parts[1] !== 'x')) return 'ignored';
    var params = { draft_id: parts[2], confirm_token: parts[3] };
    // เอาปุ่มออกจากข้อความร่าง เพื่อไม่ให้กดซ้ำ (ไม่สำคัญถ้าทำไม่สำเร็จ)
    if (cq.message && cq.message.message_id) {
      callApi('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
    if (parts[1] === 'c') {
      var done = ApiDrafts.confirm(params, call);
      send(chatId, done.summary_text);
      return 'confirmed';
    }
    ApiDrafts.cancel(params, call);
    send(chatId, 'ยกเลิกรายการแล้ว ไม่มีการบันทึก');
    return 'cancelled';
  }

  /** แยก update เป็น { kind, from, chat, ... } เฉพาะแชตส่วนตัว */
  function unpack(update) {
    if (!update || typeof update !== 'object') return null;
    if (update.callback_query && update.callback_query.from) {
      var cq = update.callback_query;
      var chat = cq.message && cq.message.chat;
      if (!chat || chat.type !== 'private') return null;
      return { kind: 'callback', from: cq.from, chatId: chat.id, callback: cq };
    }
    var m = update.message;
    if (m && m.from && m.chat && m.chat.type === 'private') return { kind: 'message', from: m.from, chatId: m.chat.id, message: m };
    return null;
  }

  function setupReply(update, client) {
    var u = unpack(update);
    if (!u || u.from.is_bot) return 'ignored';
    if (seen(client, update.update_id)) return 'duplicate';
    send(u.chatId, 'เชื่อมต่อ Telegram กับ Expense Manager แล้ว แต่ยังไม่ได้อนุญาตบัญชีนี้\n' +
      'ให้ผู้ดูแลเปิดหน้า "เชื่อมต่อภายนอก" → แก้การเชื่อมต่อ → ใส่รหัสนี้ในช่องผู้ใช้ที่อนุญาต แล้วพิมพ์ใหม่อีกครั้ง:\n' + channelIdOf(u.from.id));
    return 'setup';
  }

  function handleUpdate(update, client) {
    var u = unpack(update);
    if (!u || u.from.is_bot) return 'ignored';
    if (seen(client, update.update_id)) return 'duplicate';
    var channelId = channelIdOf(u.from.id);
    if (client.channels.indexOf(channelId) < 0) {
      send(u.chatId, 'บัญชี Telegram นี้ยังไม่ได้รับอนุญาตให้บันทึกรายการ\nให้ผู้ดูแลเพิ่มรหัสนี้ในหน้าเชื่อมต่อภายนอก:\n' + channelId);
      return 'forbidden';
    }
    var call = { client: client, actor: { actorId: client.actor_id }, channelUserId: channelId, requestId: requestIdOf(update.update_id) };
    try {
      if (u.kind === 'callback') return onCallback(u.callback, call, u.chatId);
      var m = u.message;
      if (typeof m.text === 'string') return onText(m.text, call, u.chatId);
      var file = imageFileOf(m);
      if (file) return onImage(file, call, u.chatId);
      send(u.chatId, 'รองรับข้อความและรูปสลิป พิมพ์รายการ เช่น "กาแฟ 65" หรือส่งรูปสลิปโอนเงิน');
      return 'unsupported';
    } catch (err) {
      var e = Util.toClientError(err);
      if (e.code === 'INTERNAL_ERROR') console.log('TELEGRAM_INTERNAL_ERROR: ' + (err && err.message));
      send(u.chatId, ChatCommands.errorText(err));
      return 'error:' + e.code;
    }
  }

  function saveOutcome(outcome) {
    try {
      PropertiesService.getScriptProperties().setProperty(Config.PROPERTY_KEYS.TELEGRAM_LAST_WEBHOOK, JSON.stringify({ at: Util.nowIso(), outcome: outcome.slice(0, 200) }));
    } catch (e) {
      console.log('TELEGRAM_WEBHOOK_STATUS_NOT_SAVED');
    }
  }

  /** ประมวลผล webhook (หนึ่ง update ต่อคำขอ); ตอบ 200 เสมอ */
  function handle(e) {
    replyIssue = '';
    var out = process(e);
    var outcome = (out.ok ? out.results.join(',') : out.code) + (replyIssue ? ' / ' + replyIssue : '');
    console.log('TELEGRAM_WEBHOOK: ' + outcome);
    saveOutcome(outcome);
    return out;
  }

  function process(e) {
    try {
      var raw = e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
      if (!raw || raw.length > MAX_BODY_LENGTH) return { ok: false, code: 'BAD_REQUEST' };
      var update;
      try { update = JSON.parse(raw); } catch (err) { return { ok: false, code: 'BAD_REQUEST' }; }
      if (!update || typeof update !== 'object' || update.update_id === undefined) return { ok: false, code: 'BAD_REQUEST' };

      Database.resetExecutionCache();
      var client = ApiClients.authenticate(e.parameter.tg_key);
      if (!client) return { ok: false, code: 'UNAUTHORIZED' };
      IntegrationApi.guard(client, 'WRITE');
      var hasTelegramUser = client.channels.some(function (c) { return c.indexOf(CHANNEL_PREFIX) === 0; });
      if (!hasTelegramUser) return { ok: false, code: 'FORBIDDEN_CHANNEL', results: [setupReply(update, client)] };
      return { ok: true, results: [handleUpdate(update, client)] };
    } catch (err) {
      var out = Util.toClientError(err);
      if (out.code === 'INTERNAL_ERROR') console.log('TELEGRAM_INTERNAL_ERROR: ' + (err && err.message));
      return { ok: false, code: out.code };
    }
  }

  return { isTelegramRequest: isTelegramRequest, handle: handle, channelIdOf: channelIdOf, callApi: callApi, lastIssue: function () { return replyIssue; } };
})();

/**
 * TelegramSettings — ตั้ง bot token และ webhook จากหน้าเว็บ (เฉพาะเจ้าของ; token ไม่ส่งกลับเบราว์เซอร์)
 */
var TelegramSettings = (function () {
  var TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
  var WEBHOOK_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,200}\/exec\?tg_key=([A-Za-z0-9_-]{20,200})$/;

  function props() { return PropertiesService.getScriptProperties(); }

  function current() {
    return String(props().getProperty(Config.PROPERTY_KEYS.TELEGRAM_BOT_TOKEN) || '').trim();
  }

  function lastWebhook() {
    var raw = props().getProperty(Config.PROPERTY_KEYS.TELEGRAM_LAST_WEBHOOK);
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      return { at: String(v.at || ''), outcome: String(v.outcome || '') };
    } catch (e) {
      return null;
    }
  }

  function view(actor) {
    var token = current();
    return {
      has_token: !!token,
      token_hint: token ? token.slice(-4) : '',
      bot_username: String(props().getProperty(Config.PROPERTY_KEYS.TELEGRAM_BOT_USERNAME) || ''),
      can_edit: Auth.isOwner(actor),
      last_webhook: lastWebhook()
    };
  }

  /** input: { bot_token } — ตรวจกับ getMe ก่อนบันทึก */
  function save(input, request) {
    Auth.requireOwnerActor(request.actor);
    var token = String((input || {}).bot_token || '').trim();
    if (!TOKEN_RE.test(token)) {
      throw Util.AppError('VALIDATION_TELEGRAM_SETTINGS', 'Bot token ไม่ถูกต้อง (รูปแบบ 123456789:AA… จาก @BotFather)', { field: 'bot_token' });
    }
    var me = null;
    try {
      var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getMe', { method: 'get', muteHttpExceptions: true });
      if (res.getResponseCode() === 200) me = JSON.parse(res.getContentText()).result || null;
    } catch (e) {
      me = null;
    }
    if (!me || !me.is_bot) throw Util.AppError('TELEGRAM_TOKEN_REJECTED', 'Telegram ไม่ยอมรับ token นี้ — คัดลอกใหม่จาก @BotFather', { field: 'bot_token' });
    var username = String(me.username || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
    Operation.run({ operationType: 'UPDATE_TELEGRAM_SETTINGS', idempotencyKey: request.idempotencyKey, payload: { token_hash: Util.sha256Hex(token) }, actor: request.actor }, function () {
      props().setProperty(Config.PROPERTY_KEYS.TELEGRAM_BOT_TOKEN, token);
      props().setProperty(Config.PROPERTY_KEYS.TELEGRAM_BOT_USERNAME, username);
      return { saved: true };
    });
    return view(request.actor);
  }

  /**
   * input: { webhook_url } = <URL /exec ของ gateway>?tg_key=<API key>
   * ตรวจว่า key เป็นการเชื่อมต่อที่ใช้งานและมีสิทธิ์ WRITE แล้วเรียก setWebhook (ไม่เก็บ URL/key)
   */
  function setWebhook(input, actor) {
    Auth.requireOwnerActor(actor);
    var url = String((input || {}).webhook_url || '').trim();
    var m = WEBHOOK_RE.exec(url);
    if (!m) {
      throw Util.AppError('VALIDATION_TELEGRAM_SETTINGS', 'Webhook URL ต้องเป็น https://script.google.com/macros/s/…/exec?tg_key=<API key>', { field: 'webhook_url' });
    }
    var client = ApiClients.authenticate(m[1]);
    if (!client) throw Util.AppError('UNAUTHORIZED', 'API key ใน URL ไม่ถูกต้องหรือการเชื่อมต่อถูกปิด', { field: 'webhook_url' });
    if (client.scopes.indexOf('WRITE') < 0) throw Util.AppError('FORBIDDEN_SCOPE', 'การเชื่อมต่อนี้ต้องมีสิทธิ์บันทึก (WRITE)', { field: 'webhook_url' });
    if (!current()) throw Util.AppError('TELEGRAM_NOT_CONFIGURED', 'ตั้ง bot token ก่อน');
    var ok = TelegramWebhook.callApi('setWebhook', { url: url, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true, max_connections: 5 });
    if (!ok) throw Util.AppError('TELEGRAM_ERROR', 'ตั้ง webhook ไม่สำเร็จ (' + (TelegramWebhook.lastIssue() || 'ไม่ทราบสาเหตุ') + ')');
    try { Audit.log({ actorId: actor.actorId, action: 'SET_TELEGRAM_WEBHOOK', entityType: 'ApiClients', entityId: client.client_id, result: 'SUCCESS' }); } catch (e) { console.log('AUDIT_SKIPPED'); }
    return webhookInfo(actor);
  }

  /** สถานะ webhook จาก Telegram (ไม่ส่ง URL เต็มที่มี key กลับเบราว์เซอร์) */
  function webhookInfo(actor) {
    Auth.requireOwnerActor(actor);
    if (!current()) return { configured: false };
    var info = TelegramWebhook.callApi('getWebhookInfo', {}) || {};
    var url = String(info.url || '');
    return {
      configured: true,
      has_url: !!url,
      url_host: url ? url.replace(/\?.*$/, '').replace(/\/macros\/s\/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]*/, '/macros/s/$1…') : '',
      pending_update_count: Number(info.pending_update_count || 0),
      last_error_date: info.last_error_date ? Util.nowIso(new Date(info.last_error_date * 1000)) : '',
      last_error_message: String(info.last_error_message || '').slice(0, 200)
    };
  }

  return { view: view, save: save, setWebhook: setWebhook, webhookInfo: webhookInfo };
})();

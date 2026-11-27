/**
 * LineService.gs — รับ LINE webhook โดยตรง (ระยะ A4, docs/integration-api.md ข้อ 0.2, 0.5)
 *
 * LINE ──POST──> gateway /exec?line_key=<API key ของการเชื่อมต่อ> ──> LineWebhook.handle
 *   ข้อความ → AiParser.parse → ApiDrafts.create → ตอบ Flex พร้อมปุ่ม [ยกเลิก][ยืนยัน] (postback มี draft_id + confirm_token)
 *   postback ยืนยัน/ยกเลิก → ApiDrafts.confirm / cancel → ตอบสรุป
 *
 * ความปลอดภัย (doPost อ่าน header ไม่ได้ จึงตรวจ X-Line-Signature ไม่ได้):
 * - line_key = API key ของการเชื่อมต่อที่มีสิทธิ์ WRITE และต้องกำหนด LINE userId ที่อนุญาต
 * - รับเฉพาะแชต 1:1 (source.type = user) จาก userId ที่อนุญาต; ทุกการบันทึกต้องกดยืนยันพร้อม token ที่ตรง
 * - กันข้อความซ้ำ (LINE redelivery) ด้วย webhookEventId ใน CacheService และ request_id ของร่าง
 * - ไม่ log ข้อความผู้ใช้ token หรือ key
 */
var LineWebhook = (function () {
  var REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
  var MAX_BODY_LENGTH = 100000;
  var DEDUPE_SECONDS = 6 * 60 * 60;
  var HELP_WORDS = ['help', 'ช่วยเหลือ', 'วิธีใช้', '?'];
  var BRAND = '#4F46E5';

  function isLineRequest(e) {
    return !!(e && e.parameter && typeof e.parameter.line_key === 'string');
  }

  // ---------- ข้อความตอบกลับ ----------

  function text(t) {
    return { type: 'text', text: String(t).slice(0, 4900) };
  }

  function helpText() {
    return text('พิมพ์รายการที่ต้องการบันทึก เช่น\n• กาแฟ 65\n• ข้าวกลางวัน 120 จ่ายด้วย kbank\n• เงินเดือนเข้า 30000\n• โอนจาก kbank ไป scb 500\n\nระบบจะสรุปให้ตรวจก่อน แล้วกด "ยืนยัน" เพื่อบันทึก');
  }

  function postbackData(action, draft) {
    return 'em=1&a=' + action + '&d=' + encodeURIComponent(draft.draft_id) + '&t=' + encodeURIComponent(draft.confirm_token);
  }

  function button(label, data, style) {
    return { type: 'button', style: style, height: 'sm', color: style === 'primary' ? BRAND : undefined,
      action: { type: 'postback', label: label, data: data, displayText: label } };
  }

  /** ร่างรายการเป็น Flex bubble พร้อมปุ่มยืนยัน/ยกเลิก */
  function draftMessage(draft) {
    return {
      type: 'flex',
      altText: ('ร่างรายการ: ' + draft.summary_text).slice(0, 400),
      contents: {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: 'ตรวจรายการก่อนบันทึก', weight: 'bold', size: 'sm', color: BRAND },
          { type: 'text', text: draft.summary_text, wrap: true, size: 'sm', margin: 'md' }
        ] },
        footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          button('ยกเลิก', postbackData('x', draft), 'secondary'),
          button('ยืนยัน', postbackData('c', draft), 'primary')
        ] }
      }
    };
  }

  function errorText(err) {
    var e = Util.toClientError(err);
    if (e.code === 'INTERNAL_ERROR') return 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง';
    if (e.code === 'AI_NOT_CONFIGURED') return 'ระบบยังไม่ได้ตั้งค่า AI กรุณาแจ้งผู้ดูแล';
    if (e.code === 'AI_ERROR' || e.code === 'AI_INVALID_OUTPUT') return 'แปลงข้อความไม่สำเร็จ กรุณาลองพิมพ์ใหม่อีกครั้ง';
    var msg = e.message;
    var candidates = e.details && e.details.candidates;
    if (candidates && candidates.length) {
      msg += '\nตัวเลือก: ' + candidates.slice(0, 10).map(function (c) { return c.name; }).join(', ');
    }
    return msg;
  }

  // ---------- ส่งข้อความกลับ ----------

  function reply(replyToken, messages) {
    if (!replyToken) return false;
    var token = String(PropertiesService.getScriptProperties().getProperty(Config.PROPERTY_KEYS.LINE_CHANNEL_ACCESS_TOKEN) || '').trim();
    if (!token) {
      Logger.log('LINE_NOT_CONFIGURED: ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN');
      return false;
    }
    try {
      var res = UrlFetchApp.fetch(REPLY_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ replyToken: replyToken, messages: messages.slice(0, 5) }),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code < 200 || code >= 300) {
        Logger.log('LINE_ERROR: reply HTTP ' + code);
        return false;
      }
      return true;
    } catch (e) {
      Logger.log('LINE_ERROR: reply fetch failed');
      return false;
    }
  }

  // ---------- เหตุการณ์ ----------

  function requestIdOf(eventId) {
    var clean = String(eventId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
    return clean.length >= 8 ? 'line-' + clean : 'line-' + Utilities.getUuid().replace(/-/g, '');
  }

  /** true เมื่อเคยประมวลผลเหตุการณ์นี้แล้ว (LINE ส่งซ้ำ) */
  function seen(client, eventId) {
    if (!eventId) return false;
    var cache = CacheService.getScriptCache();
    var key = 'line-evt:' + client.client_id + ':' + String(eventId).slice(0, 100);
    if (cache.get(key)) return true;
    cache.put(key, '1', DEDUPE_SECONDS);
    return false;
  }

  function parsePostback(data) {
    var out = {};
    String(data || '').split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i > 0) out[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
    });
    return out;
  }

  function onText(message, call, replyToken) {
    var body = String(message || '').trim();
    if (!body || HELP_WORDS.indexOf(body.toLowerCase()) >= 0) {
      reply(replyToken, [helpText()]);
      return 'help';
    }
    var parsed = AiParser.parse(body, call.client);
    if (parsed.intent !== 'TRANSACTION') {
      reply(replyToken, [text((parsed.message || 'ข้อความนี้ไม่ใช่รายการรับจ่าย') + '\nพิมพ์ "วิธีใช้" เพื่อดูตัวอย่าง')]);
      return 'other';
    }
    var draft = ApiDrafts.create(parsed.params, call);
    reply(replyToken, [draftMessage(draft)]);
    return 'draft';
  }

  function onPostback(data, call, replyToken) {
    var p = parsePostback(data);
    if (p.em !== '1' || (p.a !== 'c' && p.a !== 'x')) return 'ignored';
    var params = { draft_id: p.d, confirm_token: p.t };
    if (p.a === 'c') {
      var done = ApiDrafts.confirm(params, call);
      reply(replyToken, [text(done.summary_text)]);
      return 'confirmed';
    }
    ApiDrafts.cancel(params, call);
    reply(replyToken, [text('ยกเลิกรายการแล้ว ไม่มีการบันทึก')]);
    return 'cancelled';
  }

  function handleEvent(ev, client) {
    if (!ev || typeof ev !== 'object' || !ev.source || ev.source.type !== 'user') return 'ignored';
    var userId = String(ev.source.userId || '');
    var eventId = ev.webhookEventId || (ev.message && ev.message.id) || '';
    if (seen(client, eventId)) return 'duplicate';
    if (client.channels.indexOf(userId) < 0) {
      reply(ev.replyToken, [text('บัญชี LINE นี้ยังไม่ได้รับอนุญาตให้บันทึกรายการ\nให้ผู้ดูแลเพิ่ม LINE userId นี้ในหน้าเชื่อมต่อภายนอก:\n' + userId)]);
      return 'forbidden';
    }
    var call = { client: client, actor: { actorId: client.actor_id }, channelUserId: userId, requestId: requestIdOf(eventId) };
    try {
      if (ev.type === 'follow') { reply(ev.replyToken, [helpText()]); return 'help'; }
      if (ev.type === 'postback') return onPostback(ev.postback && ev.postback.data, call, ev.replyToken);
      if (ev.type === 'message') {
        if (ev.message && ev.message.type === 'text') return onText(ev.message.text, call, ev.replyToken);
        reply(ev.replyToken, [text('ตอนนี้รองรับเฉพาะข้อความ พิมพ์รายการ เช่น "กาแฟ 65"')]);
        return 'unsupported';
      }
      return 'ignored';
    } catch (err) {
      var e = Util.toClientError(err);
      if (e.code === 'INTERNAL_ERROR') Logger.log('LINE_INTERNAL_ERROR: ' + (err && err.message));
      reply(ev.replyToken, [text(errorText(err))]);
      return 'error:' + e.code;
    }
  }

  /**
   * log ผลของ webhook แต่ละครั้งเพื่อหาสาเหตุเมื่อบอทไม่ตอบ (ดูได้ที่ Executions ของ gateway)
   * มีเฉพาะรหัสผล/ประเภทเหตุการณ์ ไม่มีข้อความแชต userId key หรือ token
   */
  function logOutcome(out) {
    Logger.log('LINE_WEBHOOK: ' + (out.ok ? (out.results.join(',') || 'none') : out.code));
    return out;
  }

  /** ประมวลผล webhook; ตอบ 200 เสมอ (LINE ไม่ใช้เนื้อหาคำตอบ) */
  function handle(e) {
    var out = process(e);
    // Verify (events ว่าง) ไม่ต้อง log
    if (!(out.ok && !out.results.length)) logOutcome(out);
    return out;
  }

  function process(e) {
    try {
      // อ่าน body ก่อน (ไม่แตะ Spreadsheet): ปุ่ม Verify ของ LINE ส่ง events ว่างและรอคำตอบไม่นาน
      // จึงตอบทันทีโดยไม่ตรวจ key — ไม่มีการประมวลผลหรือเปิดเผยข้อมูลใด
      var raw = e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
      if (!raw || raw.length > MAX_BODY_LENGTH) return { ok: false, code: 'BAD_REQUEST' };
      var body;
      try { body = JSON.parse(raw); } catch (err) { return { ok: false, code: 'BAD_REQUEST' }; }
      var events = body && Array.isArray(body.events) ? body.events : null;
      if (!events) return { ok: false, code: 'BAD_REQUEST' };
      if (!events.length) return { ok: true, results: [] };

      Database.resetExecutionCache();
      var client = ApiClients.authenticate(e.parameter.line_key);
      if (!client) return { ok: false, code: 'UNAUTHORIZED' };
      IntegrationApi.guard(client, 'WRITE');
      if (!client.channels.length) {
        throw Util.AppError('FORBIDDEN_CHANNEL', 'การเชื่อมต่อสำหรับ LINE ต้องกำหนด LINE userId ที่อนุญาต');
      }
      var results = events.slice(0, 20).map(function (ev) { return handleEvent(ev, client); });
      return { ok: true, results: results };
    } catch (err) {
      var out = Util.toClientError(err);
      if (out.code === 'INTERNAL_ERROR') Logger.log('LINE_INTERNAL_ERROR: ' + (err && err.message));
      return { ok: false, code: out.code };
    }
  }

  return { isLineRequest: isLineRequest, handle: handle, draftMessage: draftMessage };
})();

/**
 * LineSettings — ตั้ง LINE Channel access token จากหน้าเว็บ (เฉพาะเจ้าของ; เก็บใน Script Properties; ไม่ส่งค่ากลับเบราว์เซอร์)
 */
var LineSettings = (function () {
  var TOKEN_RE = /^[A-Za-z0-9+\/=._-]{20,500}$/;

  function current() {
    return String(PropertiesService.getScriptProperties().getProperty(Config.PROPERTY_KEYS.LINE_CHANNEL_ACCESS_TOKEN) || '').trim();
  }

  function view(actor) {
    var token = current();
    return { has_token: !!token, token_hint: token ? token.slice(-4) : '', can_edit: Auth.isOwner(actor) };
  }

  /** input: { channel_access_token } */
  function save(input, request) {
    Auth.requireOwnerActor(request.actor);
    var token = String((input || {}).channel_access_token || '').trim();
    if (!TOKEN_RE.test(token)) {
      throw Util.AppError('VALIDATION_LINE_SETTINGS', 'Channel access token ไม่ถูกต้อง (คัดลอกจาก LINE Developers → Messaging API)', { field: 'channel_access_token' });
    }
    Operation.run({ operationType: 'UPDATE_LINE_SETTINGS', idempotencyKey: request.idempotencyKey, payload: { token_hash: Util.sha256Hex(token) }, actor: request.actor }, function () {
      PropertiesService.getScriptProperties().setProperty(Config.PROPERTY_KEYS.LINE_CHANNEL_ACCESS_TOKEN, token);
      return { saved: true };
    });
    return view(request.actor);
  }

  return { view: view, save: save };
})();

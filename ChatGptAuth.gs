/**
 * ChatGptAuth.gs — ใช้บัญชี ChatGPT (Plus/Pro/Team) แทน API key แบบเดียวกับ Codex CLI "Sign in with ChatGPT"
 *
 * ผู้ใช้เลือกแนวทางนี้เอง (2026-11-28) โดยรับทราบว่า:
 * - ใช้ OAuth client ของแอป Codex และ endpoint ภายในของ chatgpt.com ซึ่ง OpenAI ไม่ได้เปิดเป็น API สาธารณะ
 *   อาจขัดเงื่อนไขการใช้งานของ OpenAI และเปลี่ยน/ปิดได้ทุกเมื่อโดยไม่แจ้ง — ถ้าใช้ไม่ได้ให้กลับไปใช้ API key
 * - refresh token ให้สิทธิ์เรียกโมเดลด้วยโควตาของบัญชี ChatGPT นั้น: เก็บใน Script Properties เท่านั้น
 *   ไม่ส่งกลับเบราว์เซอร์ ไม่ log; ตั้ง/ยกเลิกได้เฉพาะเจ้าของสคริปต์
 *
 * ขั้นตอน (device code, ตรวจจากซอร์ส openai/codex: codex-rs/login/src/device_code_auth.rs, server.rs):
 *   1) POST {ISSUER}/api/accounts/deviceauth/usercode {client_id} → device_auth_id, user_code, interval
 *   2) ผู้ใช้เปิด {ISSUER}/codex/device แล้วกรอก user_code (หมดอายุ 15 นาที)
 *   3) POST {ISSUER}/api/accounts/deviceauth/token {device_auth_id, user_code} → 403/404 = รอ; 2xx = authorization_code + code_verifier
 *   4) POST {ISSUER}/oauth/token (form) authorization_code + code_verifier, redirect_uri {ISSUER}/deviceauth/callback → id/access/refresh token
 * ส่วนที่ยังไม่ได้ยืนยันจากซอร์ส (อาจต้องปรับเมื่อทดสอบจริง): ชื่อฟิลด์ใน body ของ /oauth/token และ refresh,
 * path ของ claim chatgpt_account_id, และ header/body ของ chatgpt.com/backend-api/codex/responses
 */
var ChatGptAuth = (function () {
  var ISSUER = 'https://auth.openai.com';
  var CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
  var RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
  var DEVICE_TTL_MS = 15 * 60 * 1000;
  var REFRESH_MARGIN_MS = 5 * 60 * 1000;
  var AUTH_CLAIM = 'https://api.openai.com/auth';

  function fail(code, message) {
    return Util.AppError(code, message);
  }

  function props() { return PropertiesService.getScriptProperties(); }

  function readJson(key) {
    var raw = props().getProperty(Config.PROPERTY_KEYS[key]);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function writeJson(key, value) {
    if (value === null) props().deleteProperty(Config.PROPERTY_KEYS[key]);
    else props().setProperty(Config.PROPERTY_KEYS[key], JSON.stringify(value));
  }

  function formBody(obj) {
    return Object.keys(obj).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); }).join('&');
  }

  /** ข้อความผิดพลาดจากผู้ให้บริการแบบสั้น ไม่มี token */
  function errorDetail(res) {
    var text = '';
    try { text = res.getContentText(); } catch (e) { text = ''; }
    var msg = '';
    try {
      var data = JSON.parse(text);
      var err = data && (data.error || data.detail || data);
      msg = typeof err === 'string' ? err : (err && (err.message || err.code || err.error_description || err.error)) || '';
    } catch (e) {
      msg = text;
    }
    return String(msg || '').replace(/eyJ[A-Za-z0-9_.-]+/g, '***').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function post(url, options) {
    try {
      return UrlFetchApp.fetch(url, Object.assign({ method: 'post', muteHttpExceptions: true }, options));
    } catch (e) {
      console.log('CHATGPT_AUTH_ERROR: fetch failed');
      throw fail('AI_ERROR', 'เชื่อมต่อ OpenAI ไม่สำเร็จ กรุณาลองใหม่');
    }
  }

  /** อ่าน payload ของ JWT (ไม่ตรวจลายเซ็น — ใช้แค่ดึง account id / email / exp จาก token ที่ได้จาก OpenAI โดยตรง) */
  function jwtPayload(token) {
    var parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    try {
      var seg = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (seg.length % 4) seg += '=';
      return JSON.parse(Utilities.newBlob(Utilities.base64Decode(seg)).getDataAsString('UTF-8'));
    } catch (e) {
      return {};
    }
  }

  function tokensFrom(data, previous) {
    var prev = previous || {};
    var idToken = data.id_token || prev.id_token || '';
    var access = data.access_token || '';
    var refresh = data.refresh_token || prev.refresh_token || '';
    if (!access || !refresh) throw fail('CHATGPT_LOGIN_FAILED', 'OpenAI ไม่ส่ง token กลับมา กรุณาเข้าสู่ระบบใหม่');
    var idClaims = jwtPayload(idToken);
    var accessClaims = jwtPayload(access);
    var auth = idClaims[AUTH_CLAIM] || accessClaims[AUTH_CLAIM] || {};
    var accountId = String(auth.chatgpt_account_id || idClaims.chatgpt_account_id || prev.account_id || '');
    var exp = Number(accessClaims.exp) ? Number(accessClaims.exp) * 1000 : Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return {
      access_token: access,
      refresh_token: refresh,
      id_token: idToken,
      account_id: accountId,
      email: String(idClaims.email || prev.email || '').slice(0, 200),
      plan: String(auth.chatgpt_plan_type || prev.plan || '').slice(0, 40),
      expires_at: exp,
      connected_at: prev.connected_at || Util.nowIso()
    };
  }

  // ---------- สถานะ ----------

  function status() {
    var t = readJson('CHATGPT_OAUTH_TOKENS');
    var pending = readJson('CHATGPT_DEVICE_AUTH');
    return {
      connected: !!(t && t.refresh_token),
      email: t ? t.email : '',
      plan: t ? t.plan : '',
      connected_at: t ? t.connected_at : '',
      login_pending: !!(pending && Date.now() - pending.started < DEVICE_TTL_MS)
    };
  }

  function isConnected() {
    var t = readJson('CHATGPT_OAUTH_TOKENS');
    return !!(t && t.refresh_token);
  }

  // ---------- เข้าสู่ระบบด้วย device code ----------

  function startLogin(actor) {
    Auth.requireOwnerActor(actor);
    var res = post(ISSUER + '/api/accounts/deviceauth/usercode', { contentType: 'application/json', payload: JSON.stringify({ client_id: CLIENT_ID }) });
    var code = res.getResponseCode();
    if (code === 404) throw fail('CHATGPT_LOGIN_FAILED', 'OpenAI ปิดการเข้าสู่ระบบแบบ device code อยู่ (เปิดได้ที่ ChatGPT → Settings → Security)');
    if (code < 200 || code >= 300) {
      console.log('CHATGPT_AUTH_ERROR: usercode HTTP ' + code);
      throw fail('CHATGPT_LOGIN_FAILED', 'ขอรหัสเข้าสู่ระบบไม่สำเร็จ (HTTP ' + code + ') ' + errorDetail(res));
    }
    var data = JSON.parse(res.getContentText() || '{}');
    var userCode = String(data.user_code || data.usercode || '');
    if (!data.device_auth_id || !userCode) throw fail('CHATGPT_LOGIN_FAILED', 'OpenAI ตอบกลับไม่ครบ กรุณาลองใหม่');
    var interval = Math.min(Math.max(Number(data.interval) || 5, 3), 30);
    writeJson('CHATGPT_DEVICE_AUTH', { device_auth_id: String(data.device_auth_id), user_code: userCode, interval: interval, started: Date.now() });
    return { user_code: userCode, verification_url: ISSUER + '/codex/device', interval: interval, expires_in: DEVICE_TTL_MS / 1000 };
  }

  /** ตรวจว่าผู้ใช้กรอกรหัสแล้วหรือยัง; คืน { state: PENDING | CONNECTED | EXPIRED } */
  function pollLogin(actor) {
    Auth.requireOwnerActor(actor);
    var pending = readJson('CHATGPT_DEVICE_AUTH');
    if (!pending) return { state: isConnected() ? 'CONNECTED' : 'EXPIRED', status: status() };
    if (Date.now() - pending.started > DEVICE_TTL_MS) {
      writeJson('CHATGPT_DEVICE_AUTH', null);
      return { state: 'EXPIRED', status: status() };
    }
    var res = post(ISSUER + '/api/accounts/deviceauth/token', { contentType: 'application/json',
      payload: JSON.stringify({ device_auth_id: pending.device_auth_id, user_code: pending.user_code }) });
    var code = res.getResponseCode();
    if (code === 403 || code === 404) return { state: 'PENDING', interval: pending.interval };
    if (code < 200 || code >= 300) {
      console.log('CHATGPT_AUTH_ERROR: deviceauth/token HTTP ' + code);
      writeJson('CHATGPT_DEVICE_AUTH', null);
      throw fail('CHATGPT_LOGIN_FAILED', 'เข้าสู่ระบบไม่สำเร็จ (HTTP ' + code + ') ' + errorDetail(res));
    }
    var grant = JSON.parse(res.getContentText() || '{}');
    if (!grant.authorization_code || !grant.code_verifier) throw fail('CHATGPT_LOGIN_FAILED', 'OpenAI ตอบกลับไม่ครบ กรุณาลองใหม่');
    var tokenRes = post(ISSUER + '/oauth/token', {
      contentType: 'application/x-www-form-urlencoded',
      payload: formBody({ grant_type: 'authorization_code', code: grant.authorization_code, redirect_uri: ISSUER + '/deviceauth/callback',
        client_id: CLIENT_ID, code_verifier: grant.code_verifier })
    });
    var tcode = tokenRes.getResponseCode();
    writeJson('CHATGPT_DEVICE_AUTH', null);
    if (tcode < 200 || tcode >= 300) {
      console.log('CHATGPT_AUTH_ERROR: oauth/token HTTP ' + tcode);
      throw fail('CHATGPT_LOGIN_FAILED', 'แลก token ไม่สำเร็จ (HTTP ' + tcode + ') ' + errorDetail(tokenRes));
    }
    var tokens = tokensFrom(JSON.parse(tokenRes.getContentText() || '{}'), null);
    writeJson('CHATGPT_OAUTH_TOKENS', tokens);
    try { Audit.log({ actorId: actor.actorId, action: 'CHATGPT_LOGIN', entityType: 'Settings', entityId: 'CHATGPT_OAUTH_TOKENS', result: 'SUCCESS' }); } catch (e) { console.log('AUDIT_SKIPPED'); }
    return { state: 'CONNECTED', status: status() };
  }

  function logout(actor) {
    Auth.requireOwnerActor(actor);
    writeJson('CHATGPT_OAUTH_TOKENS', null);
    writeJson('CHATGPT_DEVICE_AUTH', null);
    try { Audit.log({ actorId: actor.actorId, action: 'CHATGPT_LOGOUT', entityType: 'Settings', entityId: 'CHATGPT_OAUTH_TOKENS', result: 'SUCCESS' }); } catch (e) { console.log('AUDIT_SKIPPED'); }
    return status();
  }

  // ---------- access token ----------

  function refresh(current) {
    var res = post(ISSUER + '/oauth/token', {
      contentType: 'application/json',
      payload: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: current.refresh_token, scope: 'openid profile email' })
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      console.log('CHATGPT_AUTH_ERROR: refresh HTTP ' + code);
      if (code === 400 || code === 401) {
        throw fail('AI_NOT_CONFIGURED', 'การเข้าสู่ระบบ ChatGPT หมดอายุหรือถูกยกเลิก ให้เจ้าของเข้าสู่ระบบใหม่ในหน้าเชื่อมต่อภายนอก');
      }
      throw fail('AI_ERROR', 'ต่ออายุการเข้าสู่ระบบ ChatGPT ไม่สำเร็จ (HTTP ' + code + ')');
    }
    var next = tokensFrom(JSON.parse(res.getContentText() || '{}'), current);
    writeJson('CHATGPT_OAUTH_TOKENS', next);
    return next;
  }

  /** token ที่ใช้ได้ (ต่ออายุภายใต้ lock เพราะ refresh token ใช้ได้ครั้งเดียว) */
  function validTokens() {
    var t = readJson('CHATGPT_OAUTH_TOKENS');
    if (!t || !t.refresh_token) throw fail('AI_NOT_CONFIGURED', 'ยังไม่ได้เข้าสู่ระบบ ChatGPT');
    if (Number(t.expires_at) - REFRESH_MARGIN_MS > Date.now()) return t;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) throw fail('AI_ERROR', 'ระบบกำลังต่ออายุการเข้าสู่ระบบ ChatGPT กรุณาลองใหม่');
    try {
      var latest = readJson('CHATGPT_OAUTH_TOKENS') || t;
      if (Number(latest.expires_at) - REFRESH_MARGIN_MS > Date.now()) return latest;
      return refresh(latest);
    } finally {
      lock.releaseLock();
    }
  }

  // ---------- เรียกโมเดล ----------

  /** อ่าน Server-Sent Events ของ Responses API → ข้อความผลลัพธ์ */
  function textFromStream(body) {
    var deltas = '';
    var finalText = '';
    var failure = '';
    String(body || '').split(/\r?\n/).forEach(function (line) {
      if (line.indexOf('data:') !== 0) return;
      var raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;
      var ev;
      try { ev = JSON.parse(raw); } catch (e) { return; }
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') deltas += ev.delta;
      else if (ev.type === 'response.completed' && ev.response) finalText = outputText(ev.response) || finalText;
      else if (ev.type === 'response.failed' || ev.type === 'error') {
        var err = (ev.response && ev.response.error) || ev.error || ev;
        failure = String((err && (err.message || err.code)) || 'failed').slice(0, 160);
      }
    });
    if (!finalText && !deltas && failure) throw fail('AI_ERROR', 'ChatGPT ตอบกลับผิดพลาด: ' + failure);
    return finalText || deltas;
  }

  function outputText(response) {
    return (response.output || []).map(function (item) {
      return (item && item.content || []).map(function (c) { return c && (c.type === 'output_text' || c.type === 'text') ? c.text || '' : ''; }).join('');
    }).join('');
  }

  /** ส่งคำขอ 1 ครั้ง (ไม่เก็บบทสนทนา store:false); image: { mime, data } */
  function complete(model, instructions, text, image) {
    var t = validTokens();
    var content = [{ type: 'input_text', text: text }];
    if (image) content.push({ type: 'input_image', image_url: 'data:' + image.mime + ';base64,' + image.data });
    var headers = {
      Authorization: 'Bearer ' + t.access_token,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: Utilities.getUuid(),
      Accept: 'text/event-stream'
    };
    if (t.account_id) headers['chatgpt-account-id'] = t.account_id;
    var res = post(RESPONSES_URL, {
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({
        model: model,
        instructions: instructions,
        input: [{ type: 'message', role: 'user', content: content }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        stream: true
      })
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      console.log('AI_ERROR: CHATGPT_OAUTH HTTP ' + code);
      if (code === 401) throw fail('AI_NOT_CONFIGURED', 'ChatGPT ปฏิเสธการเข้าสู่ระบบ ให้เจ้าของเข้าสู่ระบบใหม่ในหน้าเชื่อมต่อภายนอก');
      throw fail('AI_ERROR', 'ChatGPT ตอบกลับผิดพลาด (HTTP ' + code + ') ' + errorDetail(res));
    }
    return textFromStream(res.getContentText());
  }

  return {
    status: status,
    isConnected: isConnected,
    startLogin: startLogin,
    pollLogin: pollLogin,
    logout: logout,
    complete: complete,
    textFromStream: textFromStream,
    jwtPayload: jwtPayload
  };
})();

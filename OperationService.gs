/**
 * OperationService.gs — Idempotency, LockService, OperationJournal และ AuditLogs
 *
 * Google Sheets ไม่มี ACID transaction ข้ามชีต: ระบบนี้ไม่อ้าง atomicity
 * แต่ใช้ ID ที่กำหนดล่วงหน้า (ctx.id) + การเขียนแบบไม่สร้างซ้ำ เพื่อให้ replay งานค้างได้
 */
var Operation = (function () {
  var SHEET = 'OperationJournal';
  var KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

  function requestHash(operationType, payload) {
    return Util.sha256Hex(Util.stableStringify({ type: operationType, payload: payload }));
  }

  /** หา journal ด้วย TextFinder (ไม่อ่านทั้งตารางที่โตขึ้นทุกการเขียน); คืน { entry, rowNumber } */
  function findEntry(idempotencyKey, actorId) {
    var hits = Database.findRowsByValue(SHEET, 'idempotency_key', idempotencyKey).filter(function (h) {
      return h.row.actor_id === actorId;
    });
    return hits.length ? { entry: hits[hits.length - 1].row, rowNumber: hits[hits.length - 1].rowNumber } : null;
  }

  function saveEntry(found) {
    found.entry.updated_at = Util.nowIso();
    Database.writeRowAt(SHEET, found.rowNumber, found.entry);
  }

  /**
   * รันงานเขียนข้อมูลภายใต้ lock และ journal
   * request: { operationType, idempotencyKey, payload, actor: {actorId}, recoveryData }
   * work(ctx): ctx = { operationId, actorId, now, replay (true เมื่อ retry งานที่ค้าง), id(label) } ต้องเขียนข้อมูลแบบ replay ได้
   *   (ใช้ ctx.id และ Database.appendRowsIfAbsent) และคืนผลลัพธ์ที่ JSON ได้
   * คืน { operationId, result, replayed }
   */
  function run(request, work) {
    var operationType = Validation.requireText(request.operationType, 'operation_type', { required: true, max: 64 });
    var key = String(request.idempotencyKey || '');
    if (!KEY_RE.test(key)) {
      throw Util.AppError('VALIDATION_IDEMPOTENCY_KEY', 'idempotency key ไม่ถูกต้อง');
    }
    if (!request.actor || !request.actor.actorId) {
      throw Util.AppError('AUTH_REQUIRED', 'ไม่พบผู้ทำรายการ');
    }
    var actorId = request.actor.actorId;
    var hash = requestHash(operationType, request.payload);

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(Config.LOCK_TIMEOUT_MS)) {
      throw Util.AppError('BUSY', 'ระบบกำลังบันทึกรายการอื่น กรุณาลองใหม่อีกครั้ง');
    }
    try {
      // ข้อมูลที่อ่านก่อนได้ lock อาจเก่า: อ่านใหม่ทั้งหมดภายใน lock
      Database.resetExecutionCache();
      var found = findEntry(key, actorId);
      var entry = found ? found.entry : null;
      var replay = !!found;
      if (entry) {
        if (entry.request_hash !== hash || entry.operation_type !== operationType) {
          throw Util.AppError('IDEMPOTENCY_CONFLICT', 'คำขอนี้ถูกใช้กับข้อมูลชุดอื่นแล้ว กรุณาเริ่มรายการใหม่');
        }
        if (entry.status === 'COMMITTED') {
          return { operationId: entry.operation_id, result: entry.result_ref ? JSON.parse(entry.result_ref) : null, replayed: true };
        }
        // PENDING / FAILED / NEEDS_RECOVERY: replay ด้วย operation_id เดิม
        entry.status = 'PENDING';
        saveEntry(found);
      } else {
        var now = Util.nowIso();
        entry = {
          operation_id: Util.uuid(),
          idempotency_key: key,
          request_hash: hash,
          actor_id: actorId,
          operation_type: operationType,
          status: 'PENDING',
          recovery_data: request.recoveryData ? Util.stableStringify(request.recoveryData) : '',
          result_ref: '',
          created_at: now,
          updated_at: now
        };
        Database.appendRows(SHEET, [entry]);
        // ภายใน lock ไม่มีใครเขียน journal พร้อมกัน: แถวที่เพิ่งเพิ่มคือแถวสุดท้าย
        found = { entry: entry, rowNumber: Database.lastRowNumber(SHEET) };
      }

      var operationId = entry.operation_id;
      var ctx = {
        operationId: operationId,
        actorId: actorId,
        now: Util.nowIso(),
        replay: replay,
        recoveryData: entry.recovery_data ? JSON.parse(entry.recovery_data) : null,
        checkpoint: function (data) {
          var serialized = Util.stableStringify(data);
          if (serialized.length > Config.MAX_RESULT_REF_LENGTH) {
            throw Util.AppError('VALIDATION_RECOVERY_SIZE', 'ข้อมูลสำหรับกู้คืนมีขนาดใหญ่เกินไป');
          }
          entry.recovery_data = serialized;
          saveEntry(found);
          ctx.recoveryData = data;
        },
        id: function (label) { return Util.deterministicUuid(operationId, label); }
      };

      var result;
      var resultRef;
      try {
        result = work(ctx);
        resultRef = result === undefined ? '' : JSON.stringify(result);
        if (resultRef.length > Config.MAX_RESULT_REF_LENGTH) {
          throw Util.AppError('RESULT_TOO_LARGE', 'ผลลัพธ์ของรายการมีขนาดใหญ่เกินไป');
        }
      } catch (workError) {
        var validationOnly = Util.isAppError(workError) && workError.code.indexOf('VALIDATION_') === 0;
        entry.status = validationOnly ? 'FAILED' : 'NEEDS_RECOVERY';
        saveEntry(found);
        Audit.log({ actorId: actorId, action: operationType, entityType: 'Operation', entityId: operationId, operationId: operationId, result: 'FAILED' });
        throw workError;
      }

      entry.status = 'COMMITTED';
      entry.result_ref = resultRef;
      saveEntry(found);
      Audit.log({ actorId: actorId, action: operationType, entityType: 'Operation', entityId: operationId, operationId: operationId, result: 'SUCCESS' });
      return { operationId: operationId, result: result === undefined ? null : result, replayed: false };
    } finally {
      lock.releaseLock();
    }
  }

  /** รายการที่ต้องกู้คืน (ไม่คืน recovery_data เพื่อไม่ให้หลุดไปฝั่ง client) */
  function listPendingRecovery() {
    return Database.readAll(SHEET).rows
      .filter(function (r) { return r.status === 'PENDING' || r.status === 'NEEDS_RECOVERY'; })
      .map(function (r) {
        return { operation_id: r.operation_id, operation_type: r.operation_type, status: r.status, updated_at: r.updated_at };
      });
  }

  return {
    run: run,
    requestHash: requestHash,
    listPendingRecovery: listPendingRecovery
  };
})();

var Audit = (function () {
  /** entry: { actorId, action, entityType, entityId, operationId, result } */
  function log(entry) {
    Database.appendRows('AuditLogs', [{
      audit_id: Util.uuid(),
      event_at: Util.nowIso(),
      actor_id: entry.actorId || '',
      action: entry.action,
      entity_type: entry.entityType || '',
      entity_id: entry.entityId || '',
      operation_id: entry.operationId || '',
      result: entry.result || 'SUCCESS'
    }]);
  }

  return { log: log };
})();

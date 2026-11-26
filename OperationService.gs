/**
 * OperationService.gs — Idempotency, LockService, OperationJournal และ AuditLogs
 *
 * Google Sheets ไม่มี ACID transaction ข้ามชีต: ระบบนี้ไม่อ้าง atomicity
 * แต่ใช้ ID ที่กำหนดล่วงหน้า (ctx.id) + การเขียนแบบไม่สร้างซ้ำ เพื่อให้ replay งานค้างได้
 * ID เป็น running number ต่อตาราง (IdSequence); เลขที่จองให้แต่ละ label ถูกบันทึกลง journal ก่อนเขียนข้อมูล
 * จึง replay แล้วได้เลขเดิม
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

  /** บันทึก journal; แถวใหม่ถูกเพิ่มครั้งแรกเมื่อจำเป็น (ก่อนเขียนข้อมูลธุรกิจ หรือเมื่อจบงาน) */
  function saveEntry(found) {
    found.entry.updated_at = Util.nowIso();
    if (found.rowNumber) {
      Database.writeRowAt(SHEET, found.rowNumber, found.entry);
      return;
    }
    IdSequence.flush(); // ตัวนับ operation_id ต้องถูกบันทึกก่อนแถวที่ใช้เลขนั้น
    Database.appendRows(SHEET, [found.entry]);
    // ภายใน lock ไม่มีใครเขียน journal พร้อมกัน: แถวที่เพิ่งเพิ่มคือแถวสุดท้าย
    found.rowNumber = Database.lastRowNumber(SHEET);
  }

  /** recovery_data เก็บข้อมูลกู้คืนของงาน และเลข ID ที่จองไว้ต่อ label (ถ้ามี) */
  function packRecovery(data, ids) {
    if (!Object.keys(ids).length) return data === null || data === undefined ? '' : Util.stableStringify(data);
    return Util.stableStringify({ __ids: ids, __data: data === undefined ? null : data });
  }

  function unpackRecovery(text) {
    if (!text) return { data: null, ids: {} };
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.__ids) {
      return { data: parsed.__data === undefined ? null : parsed.__data, ids: parsed.__ids };
    }
    return { data: parsed, ids: {} };
  }

  function successAudit(entry, replay) {
    Audit.log({ actorId: entry.actor_id, action: entry.operation_type, entityType: 'Operation',
      entityId: entry.operation_id, operationId: entry.operation_id, result: 'SUCCESS', deduplicate: replay });
  }

  /**
   * รันงานเขียนข้อมูลภายใต้ lock และ journal
   * request: { operationType, idempotencyKey, payload, actor: {actorId}, recoveryData }
   * work(ctx): ctx = { operationId, actorId, now, replay (true เมื่อ retry งานที่ค้าง), id(sheetName, label) } ต้องเขียนข้อมูลแบบ replay ได้
   *   (ใช้ ctx.id และ Database.appendRowsIfAbsent) และคืนผลลัพธ์ที่ JSON ได้
   *   ctx.id(sheetName, label) คืน running number ถัดไปของตารางนั้น; label เดิมในคำขอเดิมได้เลขเดิมเสมอ
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
      // ข้อมูลที่อ่านก่อนได้ lock อาจเก่า: อ่านใหม่ทั้งหมดภายใน lock (รวมตัวนับ running number)
      Database.resetExecutionCache();
      var found = findEntry(key, actorId);
      var entry = found ? found.entry : null;
      var replay = !!found;
      if (entry) {
        if (entry.request_hash !== hash || entry.operation_type !== operationType) {
          throw Util.AppError('IDEMPOTENCY_CONFLICT', 'คำขอนี้ถูกใช้กับข้อมูลชุดอื่นแล้ว กรุณาเริ่มรายการใหม่');
        }
        if (entry.status === 'COMMITTED') {
          var committedResult = entry.result_ref ? JSON.parse(entry.result_ref) : null;
          // Repairs older committed requests whose audit write failed. Never rerun the business write.
          successAudit(entry, true);
          return { operationId: entry.operation_id, result: committedResult, replayed: true };
        }
        // PENDING / FAILED / NEEDS_RECOVERY: replay ด้วย operation_id และเลข ID ที่จองไว้เดิม
        entry.status = 'PENDING';
        saveEntry(found);
      } else {
        var now = Util.nowIso();
        entry = {
          operation_id: IdSequence.next(SHEET),
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
        // ยังไม่เพิ่มแถว: เพิ่มพร้อมเลข ID ที่จองไว้ก่อนการเขียนข้อมูลธุรกิจครั้งแรก
        found = { entry: entry, rowNumber: null };
      }

      var operationId = entry.operation_id;
      var recovery = unpackRecovery(entry.recovery_data);
      var ids = recovery.ids;
      // สำเนาข้อมูลกู้คืน ณ checkpoint ล่าสุด (งานอาจแก้ object ภายหลัง แต่ journal ต้องเก็บค่าตอน checkpoint)
      var snapshot = recovery.data === null ? null : JSON.parse(JSON.stringify(recovery.data));
      var idsDirty = false;
      var persisting = false;
      var ctx;
      var persist = function () {
        persisting = true;
        try {
          IdSequence.flush(); // ตัวนับต้องถูกบันทึกก่อนเลขที่จองไว้ และก่อนแถวที่ใช้เลขนั้น
          entry.recovery_data = packRecovery(snapshot, ids);
          saveEntry(found);
          idsDirty = false;
        } finally {
          persisting = false;
        }
      };
      ctx = {
        operationId: operationId,
        actorId: actorId,
        now: Util.nowIso(),
        replay: replay,
        recoveryData: recovery.data,
        checkpoint: function (data) {
          var serialized = packRecovery(data, ids);
          if (serialized.length > Config.MAX_RESULT_REF_LENGTH) {
            throw Util.AppError('VALIDATION_RECOVERY_SIZE', 'ข้อมูลสำหรับกู้คืนมีขนาดใหญ่เกินไป');
          }
          snapshot = JSON.parse(Util.stableStringify(data));
          ctx.recoveryData = data;
          persist();
        },
        id: function (sheetName, label) {
          if (!Config.PRIMARY_KEYS[sheetName] || label === undefined || label === null || label === '') {
            throw Util.AppError('INTERNAL_ID_LABEL', 'ต้องระบุตารางและ label ของ ID');
          }
          var slot = sheetName + ':' + label;
          if (!ids[slot]) {
            ids[slot] = IdSequence.next(sheetName);
            idsDirty = true;
          }
          return ids[slot];
        }
      };
      // ก่อนเขียนชีตธุรกิจใด ๆ: บันทึกตัวนับและเลขที่จองไว้ลง journal ก่อน
      Database.setWriteHook(function (sheetName) {
        if (persisting || sheetName === SHEET) return;
        if (idsDirty || !found.rowNumber) persist();
        else IdSequence.flush();
      });

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
        persist();
        Audit.log({ actorId: actorId, action: operationType, entityType: 'Operation', entityId: operationId, operationId: operationId, result: 'FAILED' });
        throw workError;
      }

      // Persist the success event before confirming the request. A lost reply here leaves
      // PENDING and can be replayed with the same operation ID, without duplicate events.
      successAudit(entry, replay);
      entry.status = 'COMMITTED';
      entry.result_ref = resultRef;
      persist();
      return { operationId: operationId, result: result === undefined ? null : result, replayed: false };
    } finally {
      Database.setWriteHook(null);
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
  /** entry: { actorId, action, entityType, entityId, operationId, result, auditId?, deduplicate? } */
  function log(entry) {
    if (entry.deduplicate && entry.operationId) {
      // Match the event identity as well as operation ID, including legacy audits with random IDs.
      var existing = Database.findRowsByValue('AuditLogs', 'operation_id', entry.operationId).some(function (hit) {
        var row = hit.row;
        return row.actor_id === (entry.actorId || '') && row.action === entry.action &&
          row.entity_type === (entry.entityType || '') && row.entity_id === (entry.entityId || '') &&
          row.result === (entry.result || 'SUCCESS');
      });
      if (existing) return;
    }
    var auditId = entry.auditId || IdSequence.next('AuditLogs');
    IdSequence.flush(); // ตัวนับต้องถูกบันทึกก่อนแถวที่ใช้เลขนั้น
    Database.appendRows('AuditLogs', [{
      audit_id: auditId,
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

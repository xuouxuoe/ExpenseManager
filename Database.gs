/**
 * Database.gs — ชั้นเข้าถึง Google Sheets
 * - อ่าน/เขียนแบบ batch (getValues / setValues)
 * - ตรวจ header ให้ตรง canonical ก่อนอ่านหรือเขียน (ครั้งเดียวต่อ execution ต่อชีต)
 * - cache ข้อมูลที่อ่านแล้วภายใน execution และอัปเดต cache เมื่อเขียน
 * - initializeDatabase แบบเรียกซ้ำได้ ไม่ลบหรือเขียนทับข้อมูล
 */
var Database = (function () {
  var spreadsheetOverride = null;
  var cachedSpreadsheet = null;

  /** ใช้ในการทดสอบเท่านั้น: กำหนด spreadsheet object โดยตรง */
  function setSpreadsheetForTesting(ss) {
    spreadsheetOverride = ss;
    cachedSpreadsheet = null;
    resetExecutionCache();
  }

  /**
   * เปิด Spreadsheet จาก Script Property
   * target: 'PRODUCTION' (SPREADSHEET_ID, ค่าเริ่มต้น) หรือ 'TEST' (TEST_SPREADSHEET_ID)
   */
  function openTarget(target) {
    var props = PropertiesService.getScriptProperties();
    var prodId = props.getProperty(Config.PROPERTY_KEYS.SPREADSHEET_ID);
    if (target === 'TEST') {
      var testId = props.getProperty(Config.PROPERTY_KEYS.TEST_SPREADSHEET_ID);
      if (!testId) throw Util.AppError('CONFIG_MISSING', 'ยังไม่ได้ตั้งค่า Script Property TEST_SPREADSHEET_ID');
      if (prodId && testId === prodId) {
        throw Util.AppError('CONFIG_INVALID', 'TEST_SPREADSHEET_ID ต้องไม่ใช่ไฟล์เดียวกับ SPREADSHEET_ID');
      }
      return SpreadsheetApp.openById(testId);
    }
    if (!prodId) throw Util.AppError('CONFIG_MISSING', 'ยังไม่ได้ตั้งค่า Script Property SPREADSHEET_ID');
    return SpreadsheetApp.openById(prodId);
  }

  /** ใช้ Spreadsheet ทดสอบ (TEST_SPREADSHEET_ID) สำหรับ execution นี้ */
  function useTestSpreadsheet() {
    spreadsheetOverride = openTarget('TEST');
    cachedSpreadsheet = null;
    resetExecutionCache();
  }

  /** ใช้ Spreadsheet Production (SPREADSHEET_ID) สำหรับ execution นี้ โดยไม่สนใจ DB_TARGET */
  function useProductionSpreadsheet() {
    spreadsheetOverride = openTarget('PRODUCTION');
    cachedSpreadsheet = null;
    resetExecutionCache();
  }

  /** ไฟล์ที่ Web App/API ใช้: ตาม Script Property DB_TARGET ('TEST' หรือค่าเริ่มต้น 'PRODUCTION') */
  function currentTarget() {
    var raw = PropertiesService.getScriptProperties().getProperty(Config.PROPERTY_KEYS.DB_TARGET);
    var target = String(raw || 'PRODUCTION').trim().toUpperCase();
    if (target !== 'TEST' && target !== 'PRODUCTION') {
      throw Util.AppError('CONFIG_INVALID', 'DB_TARGET ต้องเป็น TEST หรือ PRODUCTION');
    }
    return target;
  }

  function getSpreadsheet() {
    if (spreadsheetOverride) return spreadsheetOverride;
    if (!cachedSpreadsheet) cachedSpreadsheet = openTarget(currentTarget());
    return cachedSpreadsheet;
  }

  function headersOf(sheetName) {
    var headers = Config.HEADERS[sheetName];
    if (!headers) throw Util.AppError('UNKNOWN_SHEET', 'ไม่รู้จักตาราง ' + sheetName);
    return headers;
  }

  // ---------- Schema ----------

  /** เปรียบเทียบ header จริงกับ canonical โดยไม่แก้ไขอะไร */
  function inspectSheet(ss, sheetName) {
    var expected = headersOf(sheetName);
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return { sheet: sheetName, status: 'MISSING' };
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow === 0 || lastCol === 0) return { sheet: sheetName, status: 'EMPTY' };
    var actual = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    while (actual.length && actual[actual.length - 1] === '') actual.pop();
    var same = actual.length === expected.length && actual.every(function (h, i) { return h === expected[i]; });
    if (same) return { sheet: sheetName, status: 'OK', dataRows: lastRow - 1 };
    var dupes = actual.filter(function (h, i) { return h !== '' && actual.indexOf(h) !== i; });
    return {
      sheet: sheetName,
      status: 'MISMATCH',
      dataRows: lastRow - 1,
      missing: expected.filter(function (h) { return actual.indexOf(h) < 0; }),
      unexpected: actual.filter(function (h) { return expected.indexOf(h) < 0; }),
      duplicates: dupes,
      orderDiffers: expected.every(function (h) { return actual.indexOf(h) >= 0; })
    };
  }

  /** รายงาน schema ทุกตาราง (read-only) */
  function checkSchema() {
    var ss = getSpreadsheet();
    return Object.keys(Config.HEADERS).map(function (name) { return inspectSheet(ss, name); });
  }

  function formatSheet(sheet, headers) {
    sheet.setFrozenRows(1);
    var maxRows = Math.max(sheet.getMaxRows(), 2);
    headers.forEach(function (h, i) {
      var kind = Config.columnKind(h);
      var format = kind === 'text' ? '@' : (kind === 'money' ? '0.00' : (kind === 'int' ? '0' : null));
      if (format) sheet.getRange(2, i + 1, maxRows - 1, 1).setNumberFormat(format);
    });
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }

  /**
   * สร้างชีตที่ขาดและเขียน header ให้ชีตที่ว่าง
   * ไม่ลบชีต ไม่เปลี่ยน header ที่มีอยู่ ไม่แตะแถวข้อมูล; ชีตที่ header ไม่ตรงจะถูกรายงานเท่านั้น
   */
  function initialize() {
    resetExecutionCache();
    var ss = getSpreadsheet();
    return Object.keys(Config.HEADERS).map(function (name) {
      var headers = Config.HEADERS[name];
      var before = inspectSheet(ss, name);
      if (before.status === 'MISSING') {
        var created = ss.insertSheet(name);
        created.getRange(1, 1, 1, headers.length).setValues([headers]);
        formatSheet(created, headers);
        return { sheet: name, status: 'CREATED' };
      }
      if (before.status === 'EMPTY') {
        var sheet = ss.getSheetByName(name);
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        formatSheet(sheet, headers);
        return { sheet: name, status: 'HEADERS_WRITTEN' };
      }
      return before;
    });
  }

  // ---------- แปลงค่า ----------

  function toCell(value, column) {
    if (value === null || value === undefined) return '';
    var kind = Config.columnKind(column);
    if (kind === 'bool') return value === true || value === 'TRUE';
    if (kind === 'text') return Validation.sanitizeForSheet(String(value));
    return value;
  }

  function fromCell(value, column) {
    var kind = Config.columnKind(column);
    if (value instanceof Date) {
      // ป้องกันกรณี Sheets แปลงข้อความเป็นวันที่: คืนเป็นข้อความตามรูปแบบคอลัมน์
      return /_at$/.test(column) ? Util.nowIso(value) : Util.todayIso(value);
    }
    if (kind === 'bool') return value === true || value === 'TRUE';
    if (kind === 'text') return Validation.unsanitizeFromSheet(value === '' ? '' : String(value));
    return value === '' ? '' : value;
  }

  function rowToObject(values, headers) {
    var obj = {};
    for (var i = 0; i < headers.length; i++) obj[headers[i]] = fromCell(values[i], headers[i]);
    return obj;
  }

  function objectToRow(obj, headers) {
    return headers.map(function (h) { return toCell(obj[h], h); });
  }

  // ---------- Cache ภายใน execution ----------
  // Apps Script เริ่ม global ใหม่ทุก execution; cache นี้ลดการเรียก Sheets ซ้ำภายในคำขอเดียว
  // ต้องเรียก resetExecutionCache() หลังได้ lock (Operation.run) เพื่อไม่ใช้ข้อมูลที่อ่านก่อน lock
  var execCache = { sheets: {}, tables: {} };

  function resetExecutionCache() {
    execCache = { sheets: {}, tables: {} };
  }

  function trimHeader(row) {
    var out = row.map(function (h) { return String(h).trim(); });
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  function sameHeader(actual, expected) {
    return actual.length === expected.length && actual.every(function (h, i) { return h === expected[i]; });
  }

  function schemaError(sheetName, status) {
    return Util.AppError('SCHEMA_MISMATCH', 'โครงสร้างตาราง ' + sheetName + ' ไม่ตรงกับที่กำหนด (' + status + ') กรุณาเรียก checkDatabase()', { sheet: sheetName, status: status });
  }

  /** sheet ที่ตรวจ header แล้ว (อ่านเฉพาะแถว header; ใช้กับการเขียนแบบ append ที่ไม่ต้องอ่านทั้งตาราง) */
  function verifiedSheet(sheetName) {
    var entry = execCache.sheets[sheetName];
    if (entry) return entry;
    var headers = headersOf(sheetName);
    var sheet = getSpreadsheet().getSheetByName(sheetName);
    if (!sheet) throw schemaError(sheetName, 'MISSING');
    var actual = trimHeader(sheet.getRange(1, 1, 1, headers.length + 1).getValues()[0]);
    if (!sameHeader(actual, headers)) throw schemaError(sheetName, actual.length ? 'MISMATCH' : 'EMPTY');
    entry = execCache.sheets[sheetName] = { sheet: sheet, lastRow: null };
    return entry;
  }

  /** อ่านทั้งตารางด้วย getDataRange().getValues() ครั้งเดียว (รวม header) แล้วเก็บใน cache */
  function loadTable(sheetName) {
    var table = execCache.tables[sheetName];
    if (table) return table;
    var headers = headersOf(sheetName);
    var entry = execCache.sheets[sheetName];
    var sheet = entry ? entry.sheet : getSpreadsheet().getSheetByName(sheetName);
    if (!sheet) throw schemaError(sheetName, 'MISSING');
    var values = sheet.getDataRange().getValues();
    var actual = trimHeader(values[0] || []);
    if (!sameHeader(actual, headers)) throw schemaError(sheetName, actual.length ? 'MISMATCH' : 'EMPTY');
    var width = headers.length;
    var body = values.slice(1).map(function (r) {
      var row = r.slice(0, width);
      while (row.length < width) row.push('');
      return row;
    });
    while (body.length && body[body.length - 1].every(function (v) { return v === '' || v === null; })) body.pop();
    execCache.sheets[sheetName] = { sheet: sheet, lastRow: body.length + 1 };
    table = execCache.tables[sheetName] = { values: body };
    return table;
  }

  function lastRowOf(sheetName) {
    var entry = verifiedSheet(sheetName);
    if (entry.lastRow === null) entry.lastRow = Math.max(entry.sheet.getLastRow(), 1);
    return entry.lastRow;
  }

  // ---------- อ่าน/เขียน ----------

  /** อ่านทั้งตาราง: { rows: [object], rowNumbers: [number] } — object ใหม่ทุกครั้ง แก้ไขได้โดยไม่กระทบ cache */
  function readAll(sheetName) {
    var headers = headersOf(sheetName);
    var values = loadTable(sheetName).values;
    var rows = [];
    var rowNumbers = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i].every(function (v) { return v === '' || v === null; })) continue;
      rows.push(rowToObject(values[i], headers));
      rowNumbers.push(i + 2);
    }
    return { rows: rows, rowNumbers: rowNumbers };
  }

  /**
   * หาแถวที่คอลัมน์ตรงกับค่า โดยไม่อ่านทั้งตาราง (TextFinder ฝั่ง server) — สำหรับตาราง append-only ที่โตเรื่อย ๆ
   * คืน [{ row: object, rowNumber }]
   */
  function findRowsByValue(sheetName, column, value) {
    var headers = headersOf(sheetName);
    var col = headers.indexOf(column);
    if (col < 0) throw Util.AppError('UNKNOWN_COLUMN', 'ไม่พบคอลัมน์ ' + column);
    var table = execCache.tables[sheetName];
    if (table) {
      var hits = [];
      table.values.forEach(function (r, i) {
        if (fromCell(r[col], column) === value) hits.push({ row: rowToObject(r, headers), rowNumber: i + 2 });
      });
      return hits;
    }
    var entry = verifiedSheet(sheetName);
    var last = lastRowOf(sheetName);
    if (last < 2) return [];
    var matches = entry.sheet.getRange(2, col + 1, last - 1, 1).createTextFinder(String(value)).matchEntireCell(true).findAll();
    return matches.map(function (m) {
      var rn = m.getRow();
      return { row: rowToObject(entry.sheet.getRange(rn, 1, 1, headers.length).getValues()[0], headers), rowNumber: rn };
    });
  }

  /** เพิ่มหลายแถวด้วย setValues ครั้งเดียว (ไม่อ่านทั้งตาราง) */
  function appendRows(sheetName, objects) {
    if (!objects || !objects.length) return 0;
    var headers = headersOf(sheetName);
    var entry = verifiedSheet(sheetName);
    var start = lastRowOf(sheetName) + 1;
    var values = objects.map(function (o) { return objectToRow(o, headers); });
    entry.sheet.getRange(start, 1, values.length, headers.length).setValues(values);
    entry.lastRow = start + values.length - 1;
    var table = execCache.tables[sheetName];
    if (table) {
      while (table.values.length < start - 2) table.values.push(headers.map(function () { return ''; }));
      values.forEach(function (v) { table.values.push(v.slice()); });
    }
    return values.length;
  }

  /** เพิ่มเฉพาะแถวที่ยังไม่มี primary key นี้ (ใช้สำหรับ replay แบบไม่สร้างซ้ำ) */
  function appendRowsIfAbsent(sheetName, objects) {
    var pk = Config.PRIMARY_KEYS[sheetName];
    var existing = {};
    readAll(sheetName).rows.forEach(function (r) { existing[r[pk]] = true; });
    var fresh = objects.filter(function (o) { return !existing[o[pk]]; });
    appendRows(sheetName, fresh);
    return { appended: fresh.length, skipped: objects.length - fresh.length };
  }

  /** เขียนทับแถวตามเลขแถวที่ทราบแล้ว (ใช้คู่กับ findRowsByValue) */
  function writeRowAt(sheetName, rowNumber, object) {
    var headers = headersOf(sheetName);
    var entry = verifiedSheet(sheetName);
    var values = objectToRow(object, headers);
    entry.sheet.getRange(rowNumber, 1, 1, headers.length).setValues([values]);
    var table = execCache.tables[sheetName];
    if (table && table.values[rowNumber - 2]) table.values[rowNumber - 2] = values.slice();
  }

  /**
   * แทนที่แถวตาม primary key ด้วย object ใหม่ทั้งแถว
   * เขียนเป็นช่วงแถวที่ติดกันเพื่อลดจำนวนการเรียก setValues
   */
  function updateRows(sheetName, objects) {
    if (!objects || !objects.length) return 0;
    var headers = headersOf(sheetName);
    var pk = Config.PRIMARY_KEYS[sheetName];
    var pkIndex = headers.indexOf(pk);
    var table = loadTable(sheetName);
    var rowById = {};
    table.values.forEach(function (r, i) { rowById[fromCell(r[pkIndex], pk)] = i + 2; });
    var targets = objects.map(function (o) {
      var rowNumber = rowById[o[pk]];
      if (!rowNumber) throw Util.AppError('NOT_FOUND', 'ไม่พบรายการ ' + o[pk] + ' ในตาราง ' + sheetName);
      return { rowNumber: rowNumber, values: objectToRow(o, headers) };
    }).sort(function (a, b) { return a.rowNumber - b.rowNumber; });
    var sheet = verifiedSheet(sheetName).sheet;
    var start = 0;
    for (var i = 1; i <= targets.length; i++) {
      if (i === targets.length || targets[i].rowNumber !== targets[i - 1].rowNumber + 1) {
        var block = targets.slice(start, i).map(function (t) { return t.values; });
        sheet.getRange(targets[start].rowNumber, 1, block.length, headers.length).setValues(block);
        start = i;
      }
    }
    targets.forEach(function (t) { table.values[t.rowNumber - 2] = t.values.slice(); });
    return targets.length;
  }

  /**
   * เขียนทั้งคอลัมน์ (แถว 2..n) ด้วย setValues ครั้งเดียวต่อคอลัมน์ โดยใช้ค่าเดิมจาก cache
   * values ต้องเรียงตาม rowNumbers ที่ได้จาก readAll
   */
  function writeColumn(sheetName, column, rowNumbers, values) {
    var headers = headersOf(sheetName);
    var colIndex = headers.indexOf(column);
    if (colIndex < 0) throw Util.AppError('UNKNOWN_COLUMN', 'ไม่พบคอลัมน์ ' + column);
    if (!rowNumbers.length) return 0;
    var table = loadTable(sheetName);
    var first = rowNumbers[0];
    var last = rowNumbers[rowNumbers.length - 1];
    var current = [];
    for (var rn = first; rn <= last; rn++) {
      var cached = table.values[rn - 2];
      current.push([cached && cached[colIndex] !== undefined ? cached[colIndex] : '']);
    }
    rowNumbers.forEach(function (n, i) { current[n - first][0] = toCell(values[i], column); });
    verifiedSheet(sheetName).sheet.getRange(first, colIndex + 1, last - first + 1, 1).setValues(current);
    current.forEach(function (c, i) { if (table.values[first - 2 + i]) table.values[first - 2 + i][colIndex] = c[0]; });
    return rowNumbers.length;
  }

  return {
    setSpreadsheetForTesting: setSpreadsheetForTesting,
    useTestSpreadsheet: useTestSpreadsheet,
    useProductionSpreadsheet: useProductionSpreadsheet,
    currentTarget: currentTarget,
    getSpreadsheet: getSpreadsheet,
    checkSchema: checkSchema,
    initialize: initialize,
    resetExecutionCache: resetExecutionCache,
    lastRowNumber: lastRowOf,
    readAll: readAll,
    findRowsByValue: findRowsByValue,
    writeRowAt: writeRowAt,
    appendRows: appendRows,
    appendRowsIfAbsent: appendRowsIfAbsent,
    updateRows: updateRows,
    writeColumn: writeColumn,
    toCell: toCell,
    fromCell: fromCell
  };
})();

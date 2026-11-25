/**
 * Database.gs — ชั้นเข้าถึง Google Sheets
 * - อ่าน/เขียนแบบ batch (getValues / setValues)
 * - ตรวจ header ให้ตรง canonical ก่อนอ่านหรือเขียนทุกครั้ง
 * - initializeDatabase แบบเรียกซ้ำได้ ไม่ลบหรือเขียนทับข้อมูล
 */
var Database = (function () {
  var spreadsheetOverride = null;
  var cachedSpreadsheet = null;

  /** ใช้ในการทดสอบเท่านั้น: กำหนด spreadsheet object โดยตรง */
  function setSpreadsheetForTesting(ss) {
    spreadsheetOverride = ss;
    cachedSpreadsheet = null;
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
  }

  /** ใช้ Spreadsheet Production (SPREADSHEET_ID) สำหรับ execution นี้ โดยไม่สนใจ DB_TARGET */
  function useProductionSpreadsheet() {
    spreadsheetOverride = openTarget('PRODUCTION');
    cachedSpreadsheet = null;
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

  // ---------- อ่าน/เขียน ----------

  /** คืน sheet ที่ header ตรง canonical แล้วเท่านั้น */
  function getVerifiedSheet(sheetName) {
    var ss = getSpreadsheet();
    var info = inspectSheet(ss, sheetName);
    if (info.status !== 'OK') {
      throw Util.AppError('SCHEMA_MISMATCH', 'โครงสร้างตาราง ' + sheetName + ' ไม่ตรงกับที่กำหนด (' + info.status + ') กรุณาเรียก checkDatabase()', info);
    }
    return ss.getSheetByName(sheetName);
  }

  /** อ่านทั้งตาราง: { rows: [object], rowNumbers: [number] } */
  function readAll(sheetName) {
    var headers = headersOf(sheetName);
    var sheet = getVerifiedSheet(sheetName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { rows: [], rowNumbers: [] };
    var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    var rows = [];
    var rowNumbers = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i].every(function (v) { return v === '' || v === null; })) continue;
      rows.push(rowToObject(values[i], headers));
      rowNumbers.push(i + 2);
    }
    return { rows: rows, rowNumbers: rowNumbers };
  }

  /** เพิ่มหลายแถวด้วย setValues ครั้งเดียว */
  function appendRows(sheetName, objects) {
    if (!objects || !objects.length) return 0;
    var headers = headersOf(sheetName);
    var sheet = getVerifiedSheet(sheetName);
    var values = objects.map(function (o) { return objectToRow(o, headers); });
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
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

  /**
   * แทนที่แถวตาม primary key ด้วย object ใหม่ทั้งแถว
   * เขียนเป็นช่วงแถวที่ติดกันเพื่อลดจำนวนการเรียก setValues
   */
  function updateRows(sheetName, objects) {
    if (!objects || !objects.length) return 0;
    var headers = headersOf(sheetName);
    var pk = Config.PRIMARY_KEYS[sheetName];
    var data = readAll(sheetName);
    var rowById = {};
    data.rows.forEach(function (r, i) { rowById[r[pk]] = data.rowNumbers[i]; });
    var targets = objects.map(function (o) {
      var rowNumber = rowById[o[pk]];
      if (!rowNumber) throw Util.AppError('NOT_FOUND', 'ไม่พบรายการ ' + o[pk] + ' ในตาราง ' + sheetName);
      return { rowNumber: rowNumber, values: objectToRow(o, headers) };
    }).sort(function (a, b) { return a.rowNumber - b.rowNumber; });
    var sheet = getVerifiedSheet(sheetName);
    var start = 0;
    for (var i = 1; i <= targets.length; i++) {
      if (i === targets.length || targets[i].rowNumber !== targets[i - 1].rowNumber + 1) {
        var block = targets.slice(start, i).map(function (t) { return t.values; });
        sheet.getRange(targets[start].rowNumber, 1, block.length, headers.length).setValues(block);
        start = i;
      }
    }
    return targets.length;
  }

  /**
   * เขียนทั้งคอลัมน์ (แถว 2..n) ด้วย setValues ครั้งเดียวต่อคอลัมน์
   * values ต้องเรียงตาม rowNumbers ที่ได้จาก readAll
   */
  function writeColumn(sheetName, column, rowNumbers, values) {
    var headers = headersOf(sheetName);
    var colIndex = headers.indexOf(column);
    if (colIndex < 0) throw Util.AppError('UNKNOWN_COLUMN', 'ไม่พบคอลัมน์ ' + column);
    if (!rowNumbers.length) return 0;
    var sheet = getVerifiedSheet(sheetName);
    var first = rowNumbers[0];
    var last = rowNumbers[rowNumbers.length - 1];
    var range = sheet.getRange(first, colIndex + 1, last - first + 1, 1);
    var current = range.getValues();
    rowNumbers.forEach(function (rn, i) { current[rn - first][0] = toCell(values[i], column); });
    range.setValues(current);
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
    readAll: readAll,
    appendRows: appendRows,
    appendRowsIfAbsent: appendRowsIfAbsent,
    updateRows: updateRows,
    writeColumn: writeColumn,
    toCell: toCell,
    fromCell: fromCell
  };
})();

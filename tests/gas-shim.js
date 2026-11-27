'use strict';
/**
 * Fake Google Apps Script services สำหรับทดสอบ logic ใน Node.js (ไม่เชื่อมต่อ Google จริง)
 * จำลองเฉพาะ API ที่โค้ดใช้; พฤติกรรมของ Sheets จริง (เช่น การแปลงชนิดข้อมูล) ต้องทดสอบบน Spreadsheet ทดสอบ
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    this.sheet.calls.getValues = (this.sheet.calls.getValues || 0) + 1;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = (this.sheet.data[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows || values.some((l) => l.length !== this.numCols)) {
      throw new Error('FakeRange.setValues: dimension mismatch');
    }
    this.sheet.calls.setValues++;
    for (let r = 0; r < this.numRows; r++) {
      const rowIndex = this.row - 1 + r;
      while (this.sheet.data.length <= rowIndex) this.sheet.data.push([]);
      for (let c = 0; c < this.numCols; c++) this.sheet.data[rowIndex][this.col - 1 + c] = values[r][c];
    }
    return this;
  }
  setNumberFormat(f) { this.sheet.formats.push({ col: this.col, format: f }); return this; }
  createTextFinder(text) {
    const range = this;
    let entire = false;
    return {
      matchEntireCell(v) { entire = v; return this; },
      findAll() {
        range.sheet.calls.textFinder = (range.sheet.calls.textFinder || 0) + 1;
        const hits = [];
        for (let r = 0; r < range.numRows; r++) {
          for (let c = 0; c < range.numCols; c++) {
            const v = String((range.sheet.data[range.row - 1 + r] || [])[range.col - 1 + c] ?? '');
            if (entire ? v === text : v.includes(text)) hits.push({ getRow: () => range.row + r });
          }
        }
        return hits;
      }
    };
  }
  setFontWeight() { return this; }
  getValue() { return this.getValues()[0][0]; }
  setValue(value) { return this.setValues([[value]]); }
  clearContent() {
    return this.setValues(Array.from({ length: this.numRows }, () => Array(this.numCols).fill('')));
  }
  createPivotTable(source) {
    const pivot = { source, anchor: [this.row, this.col], groups: [], columns: [], values: [],
      addRowGroup(column) { this.groups.push(column); return this; },
      addColumnGroup(column) { this.columns.push(column); return this; },
      addPivotValue(column, summary) { this.values.push({ column, summary }); return this; },
      remove: () => { this.sheet.pivots = this.sheet.pivots.filter((p) => p !== pivot); }
    };
    this.sheet.pivots.push(pivot);
    return pivot;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.data = [];
    this.formats = [];
    this.frozen = 0;
    this.calls = { setValues: 0 };
    this.maxRows = 1000;
    this.pivots = [];
  }
  getName() { return this.name; }
  getLastRow() {
    this.calls.getLastRow = (this.calls.getLastRow || 0) + 1;
    for (let i = this.data.length - 1; i >= 0; i--) {
      if ((this.data[i] || []).some((v) => v !== '' && v !== undefined && v !== null)) return i + 1;
    }
    return 0;
  }
  getLastColumn() {
    this.calls.getLastColumn = (this.calls.getLastColumn || 0) + 1;
    let max = 0;
    this.data.forEach((row) => row.forEach((v, i) => { if (v !== '' && v !== undefined && v !== null) max = Math.max(max, i + 1); }));
    return max;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, count) { this.maxRows += count; return this; }
  getPivotTables() { return this.pivots.slice(); }
  getDataRange() {
    return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }
  getRange(row, col, numRows, numCols) {
    this.calls.getRange = (this.calls.getRange || 0) + 1;
    return new FakeRange(this, row, col, numRows || 1, numCols || 1);
  }
  setFrozenRows(n) { this.frozen = n; }
  setName(name) { this.name = name; return this; }
  copyTo(ss) {
    const copy = ss.insertSheet('Copy of ' + this.name);
    copy.data = this.data.map((r) => (r || []).slice());
    return copy;
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = [new FakeSheet('ชีต1')]; }
  getSheetByName(name) {
    this.calls = this.calls || { getSheetByName: 0 };
    this.calls.getSheetByName++;
    return this.sheets.find((s) => s.name === name) || null;
  }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error('sheet exists');
    const s = new FakeSheet(name);
    this.sheets.push(s);
    return s;
  }
  getSheets() { return this.sheets.slice(); }
}

function formatBangkok(date, pattern) {
  const d = new Date(date.getTime() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (pattern === 'yyyy-MM-dd') return ymd;
  if (pattern === "yyyy-MM-dd'T'HH:mm:ssXXX") return `${ymd}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+07:00`;
  throw new Error('formatBangkok: unsupported pattern ' + pattern);
}

/**
 * สร้าง context ที่โหลดไฟล์ .gs ทั้งหมดใน root
 * options: { properties, sharedProperties, activeEmail, effectiveEmail, lockAvailable }
 */
function createContext(options = {}) {
  // sharedProperties: ใช้ Script Properties ชุดเดียวกับอีก context (จำลองหลาย execution ของสคริปต์เดียว)
  const props = options.sharedProperties || Object.assign({}, options.properties || {});
  const sharedLock = options.sharedLock || { held: false };
  const state = {
    activeEmail: options.activeEmail === undefined ? 'owner@example.com' : options.activeEmail,
    effectiveEmail: options.effectiveEmail || 'owner@example.com',
    lockAvailable: options.lockAvailable !== false,
    locks: 0,
    spreadsheets: {},
    cache: options.sharedCache || {},
    logs: []
  };
  // console.log ใน Apps Script ไปที่ Cloud Logging (ดูได้ที่ Executions ของ Web App) — ในเทสต์เก็บรวมกับ Logger
  const captureLog = (...args) => state.logs.push(args.map(String).join(' '));
  const sandbox = {
    console: { log: captureLog, info: captureLog, warn: captureLog, error: captureLog },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    SpreadsheetApp: {
      PivotTableSummarizeFunction: { SUM: 'SUM' },
      openById: (id) => {
        if (!state.spreadsheets[id]) state.spreadsheets[id] = new FakeSpreadsheet();
        return state.spreadsheets[id];
      }
    },
    LockService: {
      getScriptLock: () => {
        let acquired = false;
        return {
          tryLock: () => {
            if (acquired) return true;
            if (!state.lockAvailable || sharedLock.held) return false;
            sharedLock.held = acquired = true; state.locks++; return true;
          },
          releaseLock: () => {
            if (acquired) { sharedLock.held = acquired = false; state.locks--; }
          }
        };
      }
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => state.activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => state.effectiveEmail })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      getUuid: () => crypto.randomUUID(),
      base64Encode: (bytes) => Buffer.from(Array.from(bytes, (b) => b & 255)).toString('base64'),
      computeDigest: (_alg, text) => Array.from(crypto.createHash('sha256').update(text, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (date, tz, pattern) => {
        if (tz !== 'Asia/Bangkok') throw new Error('unexpected timezone ' + tz);
        return formatBangkok(date, pattern);
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in state.cache ? state.cache[k] : null),
        put: (k, v) => { state.cache[k] = String(v); }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, mimeType: null, setMimeType(m) { this.mimeType = m; return this; }, getContent() { return this.text; } })
    },
    HtmlService: {
      createHtmlOutput: (html) => ({ html, setTitle(t) { this.title = t; return this; } })
    },
    Logger: { log: (m) => state.logs.push(String(m)) },
    // ตั้ง context.__state.fetch = (url, options) => ({ code, body }) ในเทสต์; ค่าเริ่มต้นไม่ให้ออกเครือข่าย
    UrlFetchApp: {
      fetch: (url, options) => {
        state.fetches = (state.fetches || 0) + 1;
        if (!state.fetch) throw new Error('UrlFetchApp: no fake handler (network disabled in tests)');
        const res = state.fetch(url, options || {});
        const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        // ข้อมูลไบนารี (เช่น รูปจาก LINE content API): res.bytes + res.contentType; คืนไบต์แบบ signed เหมือน Apps Script
        const bytes = res.bytes ? Array.from(res.bytes, (b) => (b > 127 ? b - 256 : b)) : [];
        const blob = { getBytes: () => bytes.slice(), getContentType: () => res.contentType || 'application/octet-stream' };
        return { getResponseCode: () => res.code, getContentText: () => body, getBlob: () => blob, getContent: () => bytes.slice() };
      }
    }
  };
  const context = vm.createContext(sandbox);
  const root = path.join(__dirname, '..');
  fs.readdirSync(root).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), context, { filename: f });
  });
  context.__state = state;
  context.__props = props;
  return context;
}

/** รวมจำนวนการเรียก Sheets API ของทุกชีต (ใช้วัดประสิทธิภาพ) */
function countCalls(ss) {
  const total = { getSheetByName: (ss.calls && ss.calls.getSheetByName) || 0, getRange: 0, getValues: 0, setValues: 0, getLastRow: 0, getLastColumn: 0, textFinder: 0 };
  ss.sheets.forEach((sh) => Object.keys(total).forEach((k) => { if (k !== 'getSheetByName') total[k] += sh.calls[k] || 0; }));
  total.all = Object.values(total).reduce((a, b) => a + b, 0);
  return total;
}

function resetCalls(ss) {
  ss.calls = { getSheetByName: 0 };
  ss.sheets.forEach((sh) => { sh.calls = { setValues: 0 }; });
}

/** context ที่ Database ชี้ไป FakeSpreadsheet ใหม่ และ initialize แล้ว */
function createDbContext(options = {}) {
  const ctx = createContext(Object.assign({ properties: { ALLOWED_EMAILS: 'owner@example.com' } }, options));
  const ss = new FakeSpreadsheet();
  ctx.Database.setSpreadsheetForTesting(ss);
  if (options.initialize !== false) ctx.Database.initialize();
  ctx.__ss = ss;
  return ctx;
}

module.exports = { createContext, createDbContext, FakeSpreadsheet, countCalls, resetCalls };

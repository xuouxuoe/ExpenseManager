'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('local โหลด backend ใหม่เมื่อ .gs เปลี่ยน โดยเก็บข้อมูลเดิมและกู้จาก syntax error ได้', { timeout: 20000 }, async () => {
  const root = path.join(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-dev-reload-'));
  fs.mkdirSync(path.join(temp, 'tests'));
  for (const name of fs.readdirSync(root).filter((name) => /\.(gs|html)$/.test(name))) {
    fs.copyFileSync(path.join(root, name), path.join(temp, name));
  }
  for (const name of ['dev-server.js', 'gas-shim.js']) fs.copyFileSync(path.join(__dirname, name), path.join(temp, 'tests', name));
  const serviceFile = path.join(temp, 'AccountService.gs');
  const current = fs.readFileSync(serviceFile, 'utf8');
  fs.writeFileSync(serviceFile, current.replace(/^.*subaccount: \{ sheet: 'SubAccounts'.*\r?\n/m, ''));
  const child = spawn(process.execPath, ['tests/dev-server.js', '0'], {
    cwd: temp, windowsHide: true, env: { ...process.env, DEV_DELAY_MS: '0', DEV_FAIL_RATE: '0' }
  });
  const exited = once(child, 'exit');
  try {
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk) => {
        const match = String(chunk).match(/localhost:(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      child.once('exit', () => reject(new Error('Preview exited before startup')));
    });
    const call = async (name, ...args) => {
      const response = await fetch('http://127.0.0.1:' + port + '/api/' + name, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args)
      });
      if (!response.ok) return { status: response.status };
      return response.json();
    };
    const masters = (await call('api_listMasters', { includeInactive: true })).data;
    const before = (await call('api_listTransactions', {})).data;
    const input = { account_id: masters.accounts[0].account_id, sub_account_name: 'ทดสอบ reload' };
    const stale = await call('api_createMaster', 'subaccount', input, 'reload-create-subaccount');
    assert.equal(stale.code, 'VALIDATION_ENUM');
    fs.writeFileSync(serviceFile, current);
    const created = await call('api_createMaster', 'subaccount', input, 'reload-create-subaccount');
    assert.equal(created.ok, true);
    assert.equal(created.data.sub_account_name, input.sub_account_name);
    assert.deepEqual((await call('api_listTransactions', {})).data, before);
    fs.appendFileSync(serviceFile, '\n!!! syntax error !!!\n');
    assert.equal((await call('api_listMasters', {})).status, 500);
    fs.writeFileSync(serviceFile, current);
    const after = (await call('api_listMasters', { includeInactive: true })).data;
    assert.equal(after.subAccounts[0].sub_account_id, created.data.sub_account_id);
    assert.deepEqual(after.accounts, masters.accounts);
  } finally {
    child.kill();
    await exited;
    const resolved = path.resolve(temp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'expense-dev-reload-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

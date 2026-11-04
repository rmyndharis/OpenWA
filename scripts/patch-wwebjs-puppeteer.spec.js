'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('whatsapp-web.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPatch, isApplied, REPLACEMENTS } = require('./patch-wwebjs-puppeteer.js');

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-puppeteer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  const file = path.join(root, 'src', 'Client.js');
  fs.writeFileSync(file, source);
  return { root, file };
}

test('updates both browser checks atomically and is idempotent', t => {
  const before = REPLACEMENTS.map(([old]) => old).join('\n');
  const after = REPLACEMENTS.map(([, fixed]) => fixed).join('\n');
  const { root, file } = fixture(t, before);
  assert.equal(isApplied(root), false);
  assert.deepEqual(applyPatch(root), { skipped: false });
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  assert.equal(isApplied(root), true);
  assert.deepEqual(applyPatch(root), { skipped: true });
  assert.equal(fs.readFileSync(file, 'utf8'), after);
});

for (const source of [
  'unknown source',
  REPLACEMENTS.map(([old]) => old)
    .join('\n')
    .repeat(2),
  REPLACEMENTS[0][0] + '\n' + REPLACEMENTS[1][1],
]) {
  test(`rejects unsupported or partial browser checks: ${source.split('\n')[0]}`, t => {
    const { root, file } = fixture(t, source);
    assert.throws(() => applyPatch(root), /unsupported Client.js shape/);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.equal(isApplied(root), false);
  });
}

test('destroy closes a connected Puppeteer browser before destroying authentication', async () => {
  const calls = [];
  const client = {
    pupBrowser: { connected: true, close: async () => calls.push('close') },
    authStrategy: { destroy: async () => calls.push('destroy') },
  };
  await Client.prototype.destroy.call(client);
  assert.deepEqual(calls, ['close', 'destroy']);
});

test('destroy still releases authentication when the browser is already disconnected', async () => {
  const calls = [];
  const client = {
    pupBrowser: { connected: false, close: async () => calls.push('close') },
    authStrategy: { destroy: async () => calls.push('destroy') },
  };
  await Client.prototype.destroy.call(client);
  assert.deepEqual(calls, ['destroy']);
});

test('logout waits for browser closure before removing authentication', async () => {
  const calls = [];
  const client = {
    pupPage: { evaluate: async () => calls.push('page logout') },
    pupBrowser: {
      connected: true,
      async close() {
        calls.push('close');
        this.connected = false;
      },
    },
    authStrategy: { logout: async () => calls.push('auth logout') },
  };
  await Client.prototype.logout.call(client);
  assert.deepEqual(calls, ['page logout', 'close', 'auth logout']);
});

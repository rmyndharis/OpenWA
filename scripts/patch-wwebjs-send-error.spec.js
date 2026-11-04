'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const { applyBackport, isApplied, ANCHOR, FIX, PREFIX } = require('./patch-wwebjs-send-error.js');

const INSTALLED_CLIENT = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

/**
 * The installed Client.js as upstream ships it. The tree this spec runs in has normally been through
 * postinstall already, so the transform is reversed first; the anchor is replaced whole, which makes
 * that reversal exact.
 */
function pristineClient() {
  const installed = fs.readFileSync(INSTALLED_CLIENT, 'utf8');
  return installed.includes(FIX) ? installed.replace(FIX, ANCHOR) : installed;
}

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-send-error-'));
  const client = path.join(root, 'src', 'Client.js');
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, source);
  return { root, client };
}

test('applies to the Client.js the installed whatsapp-web.js ships, and the result still parses', () => {
  const pristine = pristineClient();
  assert.equal(
    pristine.split(ANCHOR).length - 1,
    1,
    'the installed Client.js carries neither the anchor nor this capture; after editing FIX, reinstall ' +
      'whatsapp-web.js (npm ci) so the tree is patched with the current one',
  );
  const { root, client } = makeDependency(pristine);

  const result = applyBackport(root);

  assert.deepEqual(result, { skipped: false, note: 'page-side send errors now carry what the page threw' });
  const patched = fs.readFileSync(client, 'utf8');
  assert.equal(patched, pristine.replace(ANCHOR, FIX));
  // Compile only: the copy cannot be required from a temp dir, its relative requires would miss.
  assert.doesNotThrow(() => new vm.Script(patched, { filename: client }));
});

test('is idempotent once the capture is present', () => {
  const { root, client } = makeDependency(pristineClient().replace(ANCHOR, FIX));
  const original = fs.readFileSync(client, 'utf8');

  assert.deepEqual(applyBackport(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already reports page-side send errors',
  });
  assert.equal(fs.readFileSync(client, 'utf8'), original);
});

test('reports the patch as applied only once the transform has run', () => {
  const { root } = makeDependency(`head\n${ANCHOR}tail\n`);

  assert.equal(isApplied(root), false);
  applyBackport(root);
  assert.equal(isApplied(root), true);
});

test('reads an unreadable tree as applied rather than raising a false alarm', () => {
  assert.equal(isApplied(path.join(os.tmpdir(), 'openwa-send-error-absent')), true);
});

test('rejects an unknown dependency shape without changing it', () => {
  const { root, client } = makeDependency('const msg = await window.WWebJS.sendMessage(chat, content, options);\n');
  const original = fs.readFileSync(client, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), original);
});

test('rejects an ambiguous dependency shape without changing it', () => {
  const { root, client } = makeDependency(`${ANCHOR}${ANCHOR}`);
  const original = fs.readFileSync(client, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), original);
});

test('rejects a capture present alongside a second anchor', () => {
  const { root, client } = makeDependency(`${FIX}${ANCHOR}`);
  const original = fs.readFileSync(client, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Client\.js shape/);
  assert.equal(fs.readFileSync(client, 'utf8'), original);
});

test('fails the CLI on an unknown shape without --best-effort, and only warns with it', () => {
  // The CLI patches the tree beside the script, so run a copy from a scripts/ dir in a scratch root.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-send-error-cli-'));
  const script = path.join(root, 'scripts', 'patch-wwebjs-send-error.js');
  fs.mkdirSync(path.dirname(script));
  fs.copyFileSync(path.join(__dirname, 'patch-wwebjs-send-error.js'), script);
  fs.copyFileSync(path.join(__dirname, 'atomic-write.js'), path.join(path.dirname(script), 'atomic-write.js'));
  const client = path.join(root, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, 'not the shape\n');

  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' }).status, 0);
  assert.equal(fs.readFileSync(client, 'utf8'), 'not the shape\n');
});

/** What the stubbed `getMessageModel` answers, one fixed object so a test can compare by identity. */
const MODEL = { model: true };

/**
 * The longest message a capture may build: the 2000-character budget, the fixed field names with
 * their punctuation (53), the prefix (11), and either the `props` marker or the few characters the
 * last property may run over before the loop stops.
 */
const MAX_MESSAGE = 2100;

/**
 * Run page code against a stubbed `send`: by default the lines the patcher inserts, exactly as
 * inserted, or the upstream lines they replace for comparison. `chat`, `content` and `options` are
 * the evaluate's own parameters, so the wrapper declares them; `window` carries only what the lines
 * read.
 */
function runPageCode({ send, model, code = FIX, version = '2.3000.1047868043', debug = true } = {}) {
  const calls = [];
  const window = {
    WWebJS: {
      sendMessage: (...args) => {
        calls.push(args);
        return send();
      },
      getMessageModel: model ?? (msg => (msg ? MODEL : assert.fail('getMessageModel called without a message'))),
    },
  };
  if (debug) window.Debug = { VERSION: version };
  const chat = { id: 'chat' };
  const content = 'hello';
  const options = { linkPreview: true };
  const body = new Function('window', 'chat', 'content', 'options', `return (async () => {\n${code}})();`);
  return { promise: body(window, chat, content, options), calls, chat, content, options };
}

/** The rejection of the inserted code for a send that throws `value`. */
async function rejectionFor(value, opts) {
  const { promise } = runPageCode({
    send: () => {
      throw value;
    },
    ...opts,
  });
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('the inserted code resolved although the send threw');
}

/** The JSON a captured rejection carries, after asserting it is one. */
function summaryOf(error) {
  assert.ok(error instanceof Error, 'a captured value must be rethrown as an Error');
  assert.equal(error.constructor, Error);
  assert.ok(error.message.startsWith(PREFIX), `expected the capture prefix, got ${error.message.slice(0, 80)}`);
  return JSON.parse(error.message.slice(PREFIX.length));
}

test('returns a successful send exactly as the unpatched code did', async () => {
  const sent = { id: 'sent-1' };
  const run = runPageCode({ send: async () => sent });

  assert.equal(await run.promise, MODEL);
  // The send still receives the evaluate's own arguments, the same objects, untouched.
  assert.equal(run.calls.length, 1);
  run.calls[0].forEach((arg, i) => assert.equal(arg, [run.chat, run.content, run.options][i]));

  // Each outcome the upstream lines can return, compared against those lines themselves.
  for (const outcome of [sent, undefined, null, 0, '']) {
    const upstream = await runPageCode({ send: async () => outcome, code: ANCHOR }).promise;
    assert.equal(await runPageCode({ send: async () => outcome }).promise, upstream, String(outcome));
  }
});

test('rethrows a plain Error as the same object, so its text reaches OpenWA unchanged', async () => {
  for (const make of [() => new Error('No LID for user'), () => new Error('Could not get the quoted message.')]) {
    const thrown = make();
    assert.equal(await rejectionFor(thrown), thrown);
  }
  // Rejected asynchronously rather than thrown, the way the injected send fails after an await.
  const late = new Error('media-fault: sendToChat filehash undefined');
  const { promise } = runPageCode({ send: () => Promise.reject(late) });
  await assert.rejects(promise, error => error === late);
});

test('leaves a failure after the send outside the capture', async () => {
  // Only the send call is wrapped: a message that was sent but whose model cannot be read fails as
  // it did before, with the same object, not as a capture that would read like a refused send.
  const thrown = new TypeError('model read failed');
  const { promise } = runPageCode({
    send: async () => ({ id: 'sent-1' }),
    model: () => {
      throw thrown;
    },
  });
  await assert.rejects(promise, error => error === thrown);
});

test('captures a native Error subclass with its constructor and the running build', async () => {
  const summary = summaryOf(await rejectionFor(new TypeError("Cannot read properties of undefined (reading 'x')")));

  assert.equal(summary.build, '2.3000.1047868043');
  assert.equal(summary.ctor, 'TypeError');
  assert.equal(summary.name, 'TypeError');
  assert.equal(summary.message, "Cannot read properties of undefined (reading 'x')");
  assert.match(summary.stack, /^TypeError: Cannot read properties/);
});

test("captures WhatsApp Web's minified error classes with the properties that carry their detail", async () => {
  // The shape measured on a live WhatsApp Web page, where it reached Node as `t: t`: class `t`, a
  // name set on the instance, an empty message, no stack, and the detail in an own property.
  class t extends Error {
    constructor() {
      super('');
      delete this.stack;
      this.name = 'InvalidMediaCheckRepairFailedType';
      this.taalOpcodes = [2, 2];
    }
  }
  const summary = summaryOf(await rejectionFor(new t()));

  assert.equal(summary.ctor, 't');
  assert.equal(summary.name, 'InvalidMediaCheckRepairFailedType');
  assert.equal(summary.str, 'InvalidMediaCheckRepairFailedType');
  assert.equal(summary.stack, 'undefined');
  assert.equal(summary.taalOpcodes, '2,2');

  // A minified class that is not an Error at all.
  class u {
    constructor() {
      this.code = 7;
    }
  }
  const plainClass = summaryOf(await rejectionFor(new u()));
  assert.equal(plainClass.ctor, 'u');
  assert.equal(plainClass.code, '7');
});

test('never lets the value it is reading crash the catch', async () => {
  const nullProto = Object.create(null);
  Object.defineProperty(nullProto, 'boom', {
    enumerable: true,
    get() {
      throw new Error('getter');
    },
  });
  nullProto.code = 9;
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('ownKeys');
      },
      get() {
        throw new Error('get');
      },
      getPrototypeOf() {
        throw new Error('proto');
      },
    },
  );
  const cyclic = { code: 'UPLOAD_FAILED', blob: new Uint8Array(1e6), big: 'x'.repeat(1e6) };
  cyclic.self = cyclic;
  const shapes = {
    undefined: undefined,
    null: null,
    string: 't',
    number: 42,
    symbol: Symbol('s'),
    nullProto,
    hostile,
    cyclic,
  };

  for (const [label, value] of Object.entries(shapes)) {
    const error = await rejectionFor(value);
    const summary = summaryOf(error);
    assert.ok(error.message.length <= MAX_MESSAGE, `${label}: summary of ${error.message.length} chars is not capped`);
    assert.equal(summary.build, '2.3000.1047868043', label);
  }

  assert.equal(summaryOf(await rejectionFor(undefined)).str, 'undefined');
  assert.equal(summaryOf(await rejectionFor('t')).str, 't');
  const readable = summaryOf(await rejectionFor(nullProto));
  assert.equal(readable.boom, '(unreadable)');
  assert.equal(readable.code, '9');
  const unreadable = summaryOf(await rejectionFor(hostile));
  assert.equal(unreadable.ctor, '(unreadable)');
  assert.equal(unreadable.props, '(unreadable)');
});

test('keeps the whole message within its budget however the JSON escapes it', async () => {
  // Each shape spends more in JSON than in raw characters: control characters escape to six, and
  // every property adds its quotes, colon and comma even when its value is empty.
  const controls = '\u0001'.repeat(600);
  class t extends Error {}
  const manyKeys = {};
  for (let i = 0; i < 5000; i++) manyKeys[String.fromCharCode(0x100 + i)] = '';
  const controlKeys = {};
  for (let i = 1; i < 32; i++) controlKeys[String.fromCharCode(i).repeat(100)] = controls;
  const shapes = {
    controlMessage: new t(controls),
    manyKeys,
    controlKeys,
    array: new Array(100000).fill(''),
  };

  for (const [label, value] of Object.entries(shapes)) {
    const error = await rejectionFor(value, { version: controls });
    summaryOf(error);
    assert.ok(error.message.length <= MAX_MESSAGE, `${label}: ${error.message.length} chars`);
  }
});

test('still captures on a page with no build to report', async () => {
  const summary = summaryOf(await rejectionFor(new TypeError('x'), { debug: false }));

  assert.equal(summary.build, '(unreadable)');
  assert.equal(summary.ctor, 'TypeError');
});

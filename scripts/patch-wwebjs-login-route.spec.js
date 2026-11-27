'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const { applyPatch, isApplied, REPLACEMENTS } = require('./patch-wwebjs-login-route.js');

const EDITS = REPLACEMENTS.map(([find, replace, name]) => ({ name, find, replace }));

const INSTALLED_CLIENT = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

/**
 * The installed Client.js as upstream ships it, as far as this patch is concerned. The tree this spec
 * runs in has normally been through postinstall already, so the transforms are reversed first; each
 * replacement is replaced whole, which makes that reversal exact.
 */
function unpatchedClient() {
  return EDITS.reduce(
    (source, edit) => source.split(edit.replace).join(edit.find),
    fs.readFileSync(INSTALLED_CLIENT, 'utf8'),
  );
}

function patchedClient() {
  return EDITS.reduce((source, edit) => source.replace(edit.find, edit.replace), unpatchedClient());
}

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-login-route-'));
  const client = path.join(root, 'src', 'Client.js');
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, source);
  return { root, client };
}

const edit = name => {
  const found = EDITS.find(e => e.name === name);
  assert.ok(found, `no edit named ${name}`);
  return found;
};

test('applies to the Client.js the installed whatsapp-web.js ships, and the result still parses', () => {
  const unpatched = unpatchedClient();
  for (const e of EDITS) {
    assert.equal(
      unpatched.split(e.find).length - 1,
      1,
      `the installed Client.js carries neither the "${e.name}" anchor nor its fix; after editing an edit, ` +
        'reinstall whatsapp-web.js (npm ci) so the tree is patched with the current one',
    );
  }
  const { root, client } = makeDependency(unpatched);

  assert.deepEqual(applyPatch(root), {
    skipped: false,
    note: 'added /login/ route handling to Client.js',
  });
  const patched = fs.readFileSync(client, 'utf8');
  assert.equal(patched, patchedClient());
  // Compile only: the copy cannot be required from a temp dir, its relative requires would miss.
  assert.doesNotThrow(() => new vm.Script(patched, { filename: client }));
});

test('is idempotent, and reports itself applied only once it has run', () => {
  const { root, client } = makeDependency(unpatchedClient());
  assert.equal(isApplied(root), false);
  applyPatch(root);
  assert.equal(isApplied(root), true);
  const once = fs.readFileSync(client, 'utf8');

  assert.deepEqual(applyPatch(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already handles /login/ route',
  });
  assert.equal(fs.readFileSync(client, 'utf8'), once);
});

test('fails when the installed Client.js is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-login-route-missing-'));
  assert.throws(() => applyPatch(root), /Client\.js not found/);
});

test('reads an unreadable tree as applied rather than raising a false alarm', () => {
  assert.equal(isApplied(path.join(os.tmpdir(), 'openwa-login-route-absent')), true);
});

test('rejects an unknown or a half-patched shape without changing it', () => {
  const half = unpatchedClient().replace(EDITS[0].find, EDITS[0].replace);
  for (const source of ['const state = window.require("WAWebSocketModel").Socket.state;\n', half]) {
    const { root, client } = makeDependency(source);
    assert.throws(() => applyPatch(root), /unsupported Client\.js shape/);
    assert.equal(fs.readFileSync(client, 'utf8'), source);
  }
});

test('fails the CLI on an unknown shape without --best-effort, and only warns with it', () => {
  // The CLI patches the tree beside the script, so run a copy from a scripts/ dir in a scratch root.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-login-route-cli-'));
  const script = path.join(root, 'scripts', 'patch-wwebjs-login-route.js');
  fs.mkdirSync(path.dirname(script));
  fs.copyFileSync(path.join(__dirname, 'patch-wwebjs-login-route.js'), script);
  fs.copyFileSync(path.join(__dirname, 'atomic-write.js'), path.join(path.dirname(script), 'atomic-write.js'));
  const client = path.join(root, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
  fs.mkdirSync(path.dirname(client), { recursive: true });
  fs.writeFileSync(client, 'not the shape\n');

  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' }).status, 0);
  assert.equal(fs.readFileSync(client, 'utf8'), 'not the shape\n');
});

/**
 * The two pages as the injected code sees them. On the app page require('WAWebSocketModel') answers the
 * module. On the signed-out /login/ page it answers null, and a require made while the page boots has
 * been seen to throw; a wait whose predicate throws never looks again, so no injected line may ask for
 * it there.
 */
function page(pathname, target) {
  const asked = [];
  const window = {
    location: { pathname },
    require: name => {
      asked.push(name);
      if (name === 'WAWebConnModel') return { Conn: { off: event => target.dropped.push(event) } };
      if (pathname.startsWith('/login')) {
        if (name === 'WAWebBackendEventBus') return { BackendEventBus: target };
        if (asked.filter(n => n === 'WAWebSocketModel').length > 1) {
          throw new Error('Requiring module "%s" with unresolved dependencies: %s');
        }
        return null;
      }
      if (name === 'WAWebSocketModel') return { Socket: target };
      throw new Error(`unexpected module ${name} on ${pathname}`);
    },
  };
  return { window, asked };
}

/** The socket model's Socket, or the event bus: an emitter that records what is done to it. */
function socket(extra = {}) {
  const handlers = {};
  const calls = [];
  return {
    handlers,
    calls,
    dropped: [],
    on: (event, handler) => (handlers[event] = handler),
    off: () => undefined,
    logout: () => calls.push('logout'),
    reconnect: () => calls.push('reconnect'),
    triggerLogout: () => calls.push('logout'),
    triggerReconnectSocket: () => calls.push('reconnect'),
    ...extra,
  };
}

/** Each injected fragment made into a function body, from the upstream lines or from their replacement. */
const FRAGMENTS = {
  'boot state': side => `${side('boot state')}\nreturn state;`,
  'qr listener cleanup': side => `const onRefChange = () => undefined;\n${side('qr listener cleanup')}`,
  'sync listeners': side => `${side('sync listeners head')}
    const listeners = [
${side('sync listeners')}    ];
    for (const [obj, event, handler] of listeners) obj.on(event, handler);
    const storeInjected = false;
${side('synced already')}window.onAppStateHasSyncedEvent('level');
    }`,
  'pairing code state': side => `${side('pairing code state')}\nreturn state;`,
  logout: side => side('logout'),
  'get state': side => side('get state'),
  'reset state': side => side('reset state'),
};

const upstream = name => edit(name).find;
const patched = name => edit(name).replace;

/** Runs a fragment on a page, then fires whatever it subscribed, and reports everything observable. */
function observe(body, pathname, target) {
  const { window, asked } = page(pathname, target);
  const events = [];
  window.onAuthAppStateChangedEvent = state => events.push(['auth state', state]);
  window.onAppStateHasSyncedEvent = how => events.push(['synced', how]);
  const result = new Function('window', body)(window);
  const subscribed = Object.keys(target.handlers).sort();
  for (const event of subscribed) {
    // The model hands (model, state) to a state listener; the bus hands the state alone.
    if (event === 'change:state') target.handlers[event](target, 'PAIRING');
    else if (event === 'set_socket_state') target.handlers[event]('PAIRING');
    else target.handlers[event]();
  }
  return { result, asked, subscribed, events, calls: target.calls, dropped: target.dropped };
}

test('every fragment covers every transform', () => {
  const used = new Set();
  for (const build of Object.values(FRAGMENTS)) build(name => (used.add(name), patched(name)));
  assert.deepEqual([...used].sort(), EDITS.map(e => e.name).sort());
});

for (const [name, build] of Object.entries(FRAGMENTS)) {
  test(`off /login/, ${name} asks for the same modules and does the same as the upstream lines`, () => {
    const make = () => socket({ state: 'CONNECTED', hasSynced: true });
    assert.deepEqual(observe(build(patched), '/', make()), observe(build(upstream), '/', make()));
  });

  test(`on /login/, ${name} never asks for the socket model`, () => {
    const seen = observe(build(patched), '/login/', socket({ socketState: 'UNPAIRED', isMainStreamReadyMd: false }));
    assert.equal(seen.asked.includes('WAWebSocketModel'), false, `asked for ${seen.asked.join(', ')}`);
  });
}

test('a require that throws while the page boots does not end the wait for the state', () => {
  // puppeteer never runs a predicate again once it has thrown, so a throwing require must stay inside it.
  const read = new Function('window', FRAGMENTS['boot state'](patched));
  for (const pathname of ['/login/', '/']) {
    const window = {
      location: { pathname },
      require: () => {
        throw new Error('Requiring module "%s" with unresolved dependencies: %s');
      },
    };
    assert.equal(read(window), undefined, pathname);
  }
});

test('on /login/ the event bus answers for the socket model', () => {
  const bus = () => socket({ socketState: 'UNPAIRED', isMainStreamReadyMd: false });
  const on = (name, target = bus()) => observe(FRAGMENTS[name](patched), '/login/', target);

  for (const name of ['boot state', 'pairing code state', 'get state']) assert.equal(on(name).result, 'UNPAIRED', name);
  assert.equal(on('get state', socket()).result, null);

  const listeners = on('sync listeners');
  assert.deepEqual(listeners.subscribed, ['open_socket_stream', 'set_socket_state']);
  assert.deepEqual(listeners.events, [
    ['synced', undefined],
    ['auth state', 'PAIRING'],
  ]);
  // A page that is synced already is acted on at once.
  assert.deepEqual(on('sync listeners', socket({ isMainStreamReadyMd: true })).events[0], ['synced', 'level']);

  assert.deepEqual(on('qr listener cleanup').subscribed, ['open_socket_stream']);
  assert.deepEqual(on('qr listener cleanup').dropped, ['change:ref']);
  assert.deepEqual(on('logout').calls, ['logout']);
  assert.deepEqual(on('reset state').calls, ['reconnect']);
});

/**
 * Let whatsapp-web.js 1.34.8 link a device on WhatsApp Web's signed-out /login/ page.
 *
 * WhatsApp Web sends a signed-out browser to /login/, where the socket model is not loaded:
 * require('WAWebSocketModel') answers null, and a require made while the page boots can throw, which
 * ends a puppeteer wait without failing it. There the socket state and its events live on
 * WAWebBackendEventBus.BackendEventBus (`socketState`, `set_socket_state`, `open_socket_stream`,
 * `triggerLogout`, `triggerReconnectSocket`), which whatsapp-web.js reads since
 * wwebjs/whatsapp-web.js#201990.
 *
 * Every transform covers a call the library can make before the app is loaded, and chooses by path:
 * the event bus on /login/, the unchanged upstream calls on every other page, so a linked session runs
 * as before. The boot wait also survives a require that throws.
 *
 * The transform is exact and idempotent, and the file is written once, after every edit resolves. An
 * unknown shape fails the production image build unless `--best-effort` is passed. Retire it with the
 * whatsapp-web.js release that carries the upstream repair.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

/** [upstream lines, replacement, name] */
const REPLACEMENTS = [
  // boot state
  [
    `                    const state =
                        window.require?.('WAWebSocketModel')?.Socket?.state;
`,
    `                    // A predicate that throws is never run again, so a require that throws while the page boots must not
                    // escape it. On /login/ the socket model must not be required at all: the event bus holds the state.
                    let state;
                    try {
                        state = window.location.pathname.startsWith('/login')
                            ? window.require?.('WAWebBackendEventBus')?.BackendEventBus?.socketState
                            : window.require?.('WAWebSocketModel')?.Socket?.state;
                    } catch {
                        // Not loadable yet: the next poll asks again.
                    }
`,
    'boot state',
  ],
  // qr listener cleanup
  [
    `                        // Remove QR listener once authentication succeeds
                        window
                            .require('WAWebSocketModel')
                            .Socket.on('change:hasSynced', () => {
                                window
                                    .require('WAWebConnModel')
                                    .Conn.off('change:ref', onRefChange);
                            });
`,
    `                        // Remove QR listener once authentication succeeds
                        const loginPage = window.location.pathname.startsWith('/login');
                        const stream = loginPage
                            ? window.require('WAWebBackendEventBus').BackendEventBus
                            : window.require('WAWebSocketModel').Socket;
                        stream.on(loginPage ? 'open_socket_stream' : 'change:hasSynced', () => {
                            window
                                .require('WAWebConnModel')
                                .Conn.off('change:ref', onRefChange);
                        });
`,
    'qr listener cleanup',
  ],
  // sync listeners head
  [
    `                const Socket = window.require('WAWebSocketModel').Socket;
`,
    `                // On /login/ the event bus reports the same two changes, and the socket model is not required.
                const bus = window.location.pathname.startsWith('/login')
                    ? window.require('WAWebBackendEventBus').BackendEventBus
                    : null;
                const Socket = bus ?? window.require('WAWebSocketModel').Socket;
`,
    'sync listeners head',
  ],
  // sync listeners
  [
    `                    [
                        Socket,
                        'change:state',
                        (_AppState, state) => {
                            window.onAuthAppStateChangedEvent(state);
                        },
                    ],
                    [
                        Socket,
                        'change:hasSynced',
                        () => {
                            window.onAppStateHasSyncedEvent();
                        },
                    ],
`,
    `                    [
                        Socket,
                        bus ? 'set_socket_state' : 'change:state',
                        (first, state) => {
                            window.onAuthAppStateChangedEvent(bus ? first : state);
                        },
                    ],
                    [
                        Socket,
                        bus ? 'open_socket_stream' : 'change:hasSynced',
                        () => {
                            window.onAppStateHasSyncedEvent();
                        },
                    ],
`,
    'sync listeners',
  ],
  // synced already
  [
    `                if (Socket.hasSynced === true && !storeInjected) {
`,
    `                if ((bus ? bus.isMainStreamReadyMd : Socket.hasSynced) === true && !storeInjected) {
`,
    'synced already',
  ],
  // pairing code state
  [
    `                    const state =
                        window.require('WAWebSocketModel').Socket.state;
`,
    `                    const state = window.location.pathname.startsWith('/login')
                        ? window.require('WAWebBackendEventBus').BackendEventBus.socketState
                        : window.require('WAWebSocketModel').Socket.state;
`,
    'pairing code state',
  ],
  // logout
  [
    `            return window.require('WAWebSocketModel').Socket.logout();
`,
    `            if (window.location.pathname.startsWith('/login')) {
                return window.require('WAWebBackendEventBus').BackendEventBus.triggerLogout();
            }
            return window.require('WAWebSocketModel').Socket.logout();
`,
    'logout',
  ],
  // get state
  [
    `            return window.require('WAWebSocketModel').Socket.state ?? null;
`,
    `            if (window.location.pathname.startsWith('/login')) {
                return window.require('WAWebBackendEventBus').BackendEventBus.socketState ?? null;
            }
            return window.require('WAWebSocketModel').Socket.state ?? null;
`,
    'get state',
  ],
  // reset state
  [
    `            window.require('WAWebSocketModel').Socket.reconnect();
`,
    `            if (window.location.pathname.startsWith('/login')) {
                window.require('WAWebBackendEventBus').BackendEventBus.triggerReconnectSocket();
            } else {
                window.require('WAWebSocketModel').Socket.reconnect();
            }
`,
    'reset state',
  ],
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** Upstream lines are counted with the replacements removed: some replacements keep their upstream line. */
function counts(source) {
  return {
    unpatched: REPLACEMENTS.map(([before, after]) => occurrences(source.split(after).join(''), before)),
    patched: REPLACEMENTS.map(([, after]) => occurrences(source, after)),
  };
}

function isPatched(source) {
  const { unpatched, patched } = counts(source);
  return unpatched.every(count => count === 0) && patched.every(count => count === 1);
}

/**
 * The stand-down branch as a predicate, for the startup guard (engine-patch-status.ts). An unreadable
 * tree reads as applied, since a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return isPatched(fs.readFileSync(path.join(wwjsDir, CLIENT_PATH), 'utf8'));
  } catch {
    return true;
  }
}

function applyPatch(wwjsDir = DEFAULT_WWJS) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  }

  let source = fs.readFileSync(clientFile, 'utf8');
  if (isPatched(source)) {
    return { skipped: true, reason: 'installed whatsapp-web.js already handles /login/ route' };
  }
  const { unpatched, patched } = counts(source);
  // Applied from nothing: anything else is a shape this patcher was not written for.
  if (!unpatched.every(count => count === 1) || !patched.every(count => count === 0)) {
    throw new Error(
      `unsupported Client.js shape (unpatched: ${unpatched.join(',')}, patched: ${patched.join(',')}); ` +
        'recheck /login/ route compatibility in whatsapp-web.js',
    );
  }
  for (const [before, after] of REPLACEMENTS) {
    source = source.replace(before, after);
  }
  writeFileAtomic(clientFile, source);
  return { skipped: false, note: 'added /login/ route handling to Client.js' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyPatch();
    console.log(`patch-wwebjs-login-route: ${result.skipped ? `skipped: ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-login-route: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-login-route: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyPatch, isApplied, REPLACEMENTS };

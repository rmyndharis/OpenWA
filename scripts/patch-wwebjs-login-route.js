/**
 * Support WhatsApp Web's /login/ route in whatsapp-web.js 1.34.8.
 *
 * WhatsApp Web redirects unauthenticated sessions from `/` to `/login/`, where
 * `WAWebSocketModel` is not yet loaded (its dependencies are unresolved in the
 * login bundle). Polling `window.require('WAWebSocketModel')` on every animation
 * frame inside `Client.inject()` stalls the page until `authTimeoutMs` expires
 * (`auth timeout`), even though the QR code (`WAWebConnModel.Conn.ref`) is already
 * available on `/login/`.
 *
 * This patch:
 *   1. Checks `window.location?.pathname?.startsWith('/login')` with `polling: 500`
 *      before touching `WAWebSocketModel`, resolving once `WAWebConnModel.Conn.ref`
 *      is ready.
 *   2. Guards `WAWebSocketModel?.Socket` and `WAWebCmd?.Cmd` accesses during
 *      listener registration and the `hasSynced` check on `/login/`.
 *
 * The transform is exact and idempotent. An unknown shape fails the production
 * image build unless `--best-effort` is passed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

const REPLACEMENTS = [
  [
    `            const needAuthHandle = await this.pupPage.waitForFunction(
                () => {
                    const state =
                        window.require?.('WAWebSocketModel')?.Socket?.state;
                    if (
                        !state ||
                        state === 'OPENING' ||
                        state === 'UNLAUNCHED' ||
                        state === 'PAIRING'
                    ) {
                        return false;
                    }
                    return {
                        need: state === 'UNPAIRED' || state === 'UNPAIRED_IDLE',
                        state,
                    };
                },
                { timeout: authTimeout },
            );`,
    `            const needAuthHandle = await this.pupPage.waitForFunction(
                () => {
                    if (window.location?.pathname?.startsWith('/login')) {
                        if (window.require?.('WAWebConnModel')?.Conn?.ref) {
                            return { need: true, state: 'UNPAIRED' };
                        }
                        return false;
                    }
                    const state =
                        window.require?.('WAWebSocketModel')?.Socket?.state;
                    if (
                        !state ||
                        state === 'OPENING' ||
                        state === 'UNLAUNCHED' ||
                        state === 'PAIRING'
                    ) {
                        return false;
                    }
                    return {
                        need: state === 'UNPAIRED' || state === 'UNPAIRED_IDLE',
                        state,
                    };
                },
                { timeout: authTimeout, polling: 500 },
            );`,
  ],
  [
    `                        // Remove QR listener once authentication succeeds
                        window
                            .require('WAWebSocketModel')
                            .Socket.on('change:hasSynced', () => {
                                window
                                    .require('WAWebConnModel')
                                    .Conn.off('change:ref', onRefChange);
                            });`,
    `                        // Remove QR listener once authentication succeeds
                        window
                            .require('WAWebSocketModel')
                            ?.Socket?.on('change:hasSynced', () => {
                                window
                                    .require('WAWebConnModel')
                                    .Conn.off('change:ref', onRefChange);
                            });`,
  ],
  [
    `            await this.pupPage.evaluate(() => {
                const Socket = window.require('WAWebSocketModel').Socket;
                const Cmd = window.require('WAWebCmd').Cmd;

                const listeners = [
                    [
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
                    [
                        Cmd,
                        'offline_progress_update_from_bridge',
                        () => {
                            window.onOfflineProgressUpdateEvent(
                                window
                                    .require('WAWebOfflineHandler')
                                    .OfflineMessageHandler.getOfflineDeliveryProgress(),
                            );
                        },
                    ],
                    [
                        Cmd,
                        'logout',
                        async () => {
                            await window.onLogoutEvent();
                        },
                    ],
                    [
                        Cmd,
                        'logout_from_bridge',
                        async () => {
                            await window.onLogoutEvent();
                        },
                    ],
                ];`,
    `            await this.pupPage.evaluate(() => {
                const Socket = window.require('WAWebSocketModel')?.Socket;
                const Cmd = window.require('WAWebCmd')?.Cmd;

                const listeners = [
                    ...(Socket
                        ? [
                              [
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
                          ]
                        : []),
                    ...(Cmd
                        ? [
                              [
                                  Cmd,
                                  'offline_progress_update_from_bridge',
                                  () => {
                                      window.onOfflineProgressUpdateEvent(
                                          window
                                              .require('WAWebOfflineHandler')
                                              .OfflineMessageHandler.getOfflineDeliveryProgress(),
                                      );
                                  },
                              ],
                              [
                                  Cmd,
                                  'logout',
                                  async () => {
                                      await window.onLogoutEvent();
                                  },
                              ],
                              [
                                  Cmd,
                                  'logout_from_bridge',
                                  async () => {
                                      await window.onLogoutEvent();
                                  },
                              ],
                          ]
                        : []),
                ];`,
  ],
  [
    `                const storeInjected = typeof window.WWebJS !== 'undefined';
                if (Socket.hasSynced === true && !storeInjected) {
                    window.onAppStateHasSyncedEvent();
                }`,
    `                const storeInjected = typeof window.WWebJS !== 'undefined';
                if (Socket?.hasSynced === true && !storeInjected) {
                    window.onAppStateHasSyncedEvent();
                }`,
  ],
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function isPatched(source) {
  return REPLACEMENTS.every(([before, after]) => occurrences(source, before) === 0 && occurrences(source, after) === 1);
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
  if (!REPLACEMENTS.every(([before, after]) => occurrences(source, before) === 1 && occurrences(source, after) === 0)) {
    throw new Error('unsupported Client.js shape; recheck /login/ route compatibility in whatsapp-web.js');
  }

  for (const [before, after] of REPLACEMENTS) {
    source = source.replace(before, after);
  }
  writeFileAtomic(clientFile, source);
  return { skipped: false, note: 'added /login/ route handling to Client.inject()' };
}

function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return isPatched(fs.readFileSync(path.join(wwjsDir, CLIENT_PATH), 'utf8'));
  } catch {
    return true;
  }
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyPatch();
    console.log(
      `patch-wwebjs-login-route: ${result.skipped ? `skipped — ${result.reason}` : result.note}`,
    );
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-login-route: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-login-route: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyPatch, isApplied, REPLACEMENTS };

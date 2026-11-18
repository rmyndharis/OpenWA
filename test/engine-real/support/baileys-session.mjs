/**
 * Shared harness of the engine-real proofs that need the compiled adapter: a session wired as the lifecycle wires it,
 * on a fake socket whose event emitter is the library's REAL event buffer, with messages delivered the way the socket
 * delivers them (a node opens the buffer, a buffered upsert emits `messages.upsert` and runs the library's processMessage,
 * and the node's end flushes). Only makeWASocket and the network are replaced. Not a spec: it is imported by the specs.
 *
 * Runs over dist/, so it needs `npm run build` first. No network, no WhatsApp account.
 */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Set before the adapter is loaded: a fixed WhatsApp Web version spares the session its lookup of the latest one.
process.env.BAILEYS_WA_VERSION = '2.3000.1000000000';
process.env.MEDIA_DOWNLOAD_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

const require = createRequire(import.meta.url);
export const lib = await import('@whiskeysockets/baileys');
export const processMessage = (await import('@whiskeysockets/baileys/lib/Utils/process-message.js')).default;
const { BaileysAdapter } = require('../../../dist/engine/adapters/baileys.adapter.js');

export const PEER = '6281111111111@s.whatsapp.net';
export const CHAT = '6281111111111@c.us';
export const quiet = {
  level: 'silent',
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Waits for `condition` (which may be async) and fails at the deadline instead of hanging; it decides nothing by elapsed time. */
export async function until(condition, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/** The in-memory chat-state table the session store writes mute, archive, pin and deletion marks through to. */
export class FakeChatStateStore {
  rows = new Map();
  clock = 1_000_000;
  key(sessionId, chatId) {
    return `${sessionId}\u0000${chatId}`;
  }
  get(sessionId, chatId) {
    return this.rows.get(this.key(sessionId, chatId));
  }
  chatIds(sessionId) {
    return [...this.rows.keys()]
      .filter(k => k.startsWith(`${sessionId}\u0000`))
      .map(k => k.slice(sessionId.length + 1));
  }
  remember(sessionId, chatId, patch, create = true) {
    const defaults = { muteEndTime: null, archived: false, pinned: false };
    const restates = Object.keys(patch).every(field => patch[field] === defaults[field]);
    if (!create && restates && !this.rows.has(this.key(sessionId, chatId))) return Promise.resolve();
    const existing = this.rows.get(this.key(sessionId, chatId)) ?? { ...defaults, observed: [] };
    const observed = existing.observed && [...new Set([...existing.observed, ...Object.keys(patch)])];
    this.rows.set(this.key(sessionId, chatId), { ...existing, ...patch, observed, updatedAt: ++this.clock });
    return Promise.resolve();
  }
  reload() {
    return Promise.resolve();
  }
  clearSession() {
    return Promise.resolve();
  }
  fold(sessionId, chatId, twins, patch, create = true) {
    return this.remember(sessionId, chatId, patch, create);
  }
  forget(sessionId, chatIds) {
    for (const chatId of chatIds) this.rows.delete(this.key(sessionId, chatId));
    return Promise.resolve();
  }
  refreshSession() {
    return Promise.resolve();
  }
}

const me = { id: '6280000000000:3@s.whatsapp.net', lid: '99999999999999:3@lid', name: 'Gateway' };

/**
 * A session over a fake socket. `socket` adds or replaces members of the fake (a chatModify, a readMessages), `callbacks`
 * are the engine callbacks, `chatStateStore` is what the adapter is given for persisted chat state (none: no deletion
 * mark is kept at all, so a proof about deleted chats has to pass one).
 */
export async function startSession(t, { chatStateStore, unarchiveChats = false, socket = {}, callbacks = {} } = {}) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-real-'));
  const ev = lib.makeEventBuffer(quiet);
  const sock = {
    ev,
    ws: Object.assign(new EventEmitter(), { isOpen: true, isConnecting: false }),
    user: me,
    authState: { creds: { me, accountSettings: { unarchiveChats }, accountSyncCounter: 0 }, keys: {} },
    end: () => undefined,
    fetchAccountReachoutTimelock: () => Promise.resolve(),
    groupFetchAllParticipating: () => Promise.resolve({}),
    resyncAppState: () => Promise.resolve(),
    ...socket,
  };
  const adapter = new BaileysAdapter({
    sessionId: 'real-session',
    dbSessionId: 'db-real-session',
    authDir,
    chatStateStore,
  });
  adapter.lifecycle.lib = { ...lib, default: () => sock, makeCacheableSignalKeyStore: store => store };
  await adapter.initialize({ onMessage: () => undefined, onMessageCreate: () => undefined, ...callbacks });
  ev.emit('connection.update', { connection: 'open' });
  t.after(async () => {
    await adapter.destroy();
    ev.destroy();
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  return { adapter, sock };
}

/** A message as the socket reads it off the wire: built, wire-encoded and decoded. */
export function wireMessage({ id, chat = PEER, fromMe = false, at, message }) {
  const wm = lib.proto.WebMessageInfo.fromObject({
    key: { remoteJid: chat, fromMe, id },
    message,
    messageTimestamp: at,
  });
  return lib.proto.WebMessageInfo.decode(lib.proto.WebMessageInfo.encode(wm).finish());
}

/** The processMessage context of a socket. */
const contextOf = sock => ({
  signalRepository: {},
  shouldProcessHistoryMsg: false,
  placeholderResendCache: undefined,
  ev: sock.ev,
  creds: sock.authState.creds,
  keyStore: sock.authState.keys,
  logger: quiet,
  options: {},
  getMessage: () => Promise.resolve(undefined),
});

/**
 * One message node, the way the socket takes it: processNodeWithBuffer opens the buffer, handleMessage runs upsertMessage
 * (a buffered function that emits messages.upsert and runs processMessage), and the node's end flushes, which delivers what
 * the buffer held synchronously. `gate` keeps the node open until it settles, as a decrypt or a download would.
 */
export async function deliver(sock, wm, { gate } = {}) {
  sock.ev.buffer();
  await sock.ev.createBufferedFunction(async message => {
    sock.ev.emit('messages.upsert', { messages: [message], type: 'notify' });
    await processMessage(message, contextOf(sock));
    await gate;
  })(wm);
  sock.ev.flush();
}

/** Several messages that reach the socket in one flush: the buffer folds their updates before anything hears of them. */
export async function deliverTogether(sock, messages) {
  sock.ev.buffer();
  for (const wm of messages) {
    await sock.ev.createBufferedFunction(async message => {
      sock.ev.emit('messages.upsert', { messages: [message], type: 'notify' });
      await processMessage(message, contextOf(sock));
    })(wm);
  }
  sock.ev.flush();
}

/** What the adapter lists for the chat, or undefined for a chat it does not list. */
export async function listed(adapter, chat = CHAT) {
  return (await adapter.getChats()).find(c => c.id === chat);
}

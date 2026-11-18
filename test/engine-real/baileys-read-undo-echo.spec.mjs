/**
 * A read of a Baileys chat marked unread by hand, through the REAL library event buffer and the compiled adapter.
 *
 * Reading such a chat sends the receipt and then an app-state write that undoes the mark (`chatModify({ markRead: true })`).
 * The library replays its own write as a `chats.update` with `unreadCount: 0` (Socket/chats.js appPatch,
 * `config.emitOwnEvents`), and hands it to `ev.emit`, which only APPENDS a bufferable event while the event buffer is
 * open. resyncAppState, the first step of every app-state write, opens it and leaves it open for 100 ms after it ends
 * (createBufferedFunction), so when the patch answers inside that time the replay is delivered by the flush that follows,
 * after chatModify has resolved and the read has finished. Any buffered work of another chat holds it just as long.
 *
 * A message counted while the write waited for its turn (the app-state patch mutex, the key transaction, a lid check)
 * was never read by this read, and the late zero must not list the chat read: nothing would list it unread again.
 *
 * Everything but the socket is real: the event buffer, processMessage (the `chats.update` Baileys raises for a received
 * message), processSyncAction (the replay), the compiled lifecycle listeners, session store and contacts delegate. The
 * fake socket replaces makeWASocket and the network round trips only, and its chatModify keeps the order of appPatch
 * (chats.js 700-757): wait for the mutex, resyncAppState as a buffered function, the patch IQ, then the own-event replay.
 * The patch answers without a timer (a fast link): the 100 ms flush is then still pending when the replay is emitted, and
 * every other ordering waits for the buffer's own state, never for a guessed time.
 *
 * Runs over dist/: `npm run build && node --test test/engine-real/baileys-read-undo-echo.spec.mjs`.
 * No network, no WhatsApp account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, PEER, deliver, lib, listed, startSession, until, wireMessage } from './support/baileys-session.mjs';

const OTHER = '6282222222222@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const MEMBER = '6283333333333@s.whatsapp.net';
const quiet = {
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

const message = (id, at, over = {}) => wireMessage({ id, at, message: { conversation: `text of ${id}` }, ...over });

/**
 * A fake socket whose chatModify keeps the order of appPatch. `patch` is the app-state patch round trip (default: it
 * answers at once); `beforeWrite` runs while the write waits for its turn, `duringResync` while resyncAppState runs and
 * `duringWrite` after it, while the patch is out. `refuse` makes the write fail.
 */
function writing({ patch = () => Promise.resolve(), beforeWrite, duringResync, duringWrite, refuse } = {}) {
  return {
    replayWasBuffered: undefined,
    writes: 0,
    readMessages: () => Promise.resolve(),
    // A method, not an arrow: `this` is the fake socket the adapter calls it on.
    async chatModify(mod, jid) {
      this.writes += 1;
      await beforeWrite?.(this);
      if (refuse) throw new Error('App state key not present!');
      await this.ev.createBufferedFunction(async () => {
        await duringResync?.(this);
        await Promise.resolve();
      })(); // resyncAppState([name], false)
      await duringWrite?.(this);
      await patch(this); // query(patch), keys.set
      lib.processSyncAction(
        {
          index: ['markChatAsRead', jid],
          syncAction: lib.proto.SyncActionData.create({
            value: lib.proto.SyncActionValue.create({ markChatAsReadAction: { read: mod.markRead === true } }),
          }),
        },
        this.ev,
        this.user,
        undefined,
        quiet,
      );
      this.replayWasBuffered = this.ev.isBuffering();
    },
  };
}

/** The library flushes the buffered echo at most 100 ms after the last buffered work ends, or when a node ends. */
const echoDelivered = sock => until(() => !sock.ev.isBuffering(), 'the event buffer to flush');

const unread = async (adapter, chat = CHAT) => (await listed(adapter, chat))?.unreadCount;

/** The chat holds M1, read nowhere, and the account marked it unread by hand on the phone. */
async function markedUnread({ adapter, sock }, chat = PEER, neutral = CHAT, options = {}) {
  await deliver(sock, message('M1', 1_700_000_010, { chat, ...options }));
  await until(() => adapter.sessionStore.lastInboundMessage(neutral) !== null, 'M1 to be recorded');
  sock.ev.emit('chats.update', [{ id: chat, unreadCount: -1 }]);
  assert.equal(await unread(adapter, neutral), -1);
}

test('a message counted while the read waits for its write keeps its count when the write echo is delivered late', async t => {
  const session = await startSession(t, {
    // Another message of the chat is received while the write waits for the patch mutex or a lid check.
    socket: writing({ beforeWrite: sock => deliver(sock, message('M2', 1_700_000_011)) }),
  });
  const { adapter, sock } = session;
  await markedUnread(session);

  assert.equal(await adapter.sendSeen(CHAT), true);

  assert.equal(sock.writes, 1);
  assert.equal(sock.replayWasBuffered, true, 'the echo is held by the open event buffer');
  assert.equal(await unread(adapter), 1, 'M2 is listed unread when the read returns');
  await echoDelivered(sock); // the buffered flush that delivers the echo
  assert.equal(await unread(adapter), 1, 'M2 was never read, and the echo of the write must not list the chat read');
});

test('a message counted while the read waits for its write keeps its count in a group', async t => {
  const session = await startSession(t, {
    socket: writing({
      beforeWrite: sock => deliver(sock, message('M2', 1_700_000_011, { chat: GROUP, participant: MEMBER })),
    }),
  });
  const { adapter, sock } = session;
  await markedUnread(session, GROUP, GROUP, { participant: MEMBER });

  assert.equal(await adapter.sendSeen(GROUP), true);

  assert.equal(sock.replayWasBuffered, true);
  await echoDelivered(sock);
  assert.equal(await unread(adapter, GROUP), 1);
});

test('control: a patch that answers after the buffer was flushed has its echo delivered before the read returns', async t => {
  const session = await startSession(t, {
    // The patch answers after the buffer flushed on its own, so the echo is not held.
    socket: writing({
      patch: sock => echoDelivered(sock),
      beforeWrite: sock => deliver(sock, message('M2', 1_700_000_011)),
    }),
  });
  const { adapter, sock } = session;
  await markedUnread(session);

  assert.equal(await adapter.sendSeen(CHAT), true);

  assert.equal(sock.replayWasBuffered, false, 'the echo is delivered at once');
  assert.equal(await unread(adapter), 1);
  await echoDelivered(sock);
  assert.equal(await unread(adapter), 1);
});

test('control: a message received after the read returned, while the echo is still held, is added to it by the library', async t => {
  const session = await startSession(t, { socket: writing() });
  const { adapter, sock } = session;
  await markedUnread(session);

  assert.equal(await adapter.sendSeen(CHAT), true);
  assert.equal(sock.replayWasBuffered, true);
  assert.equal(await unread(adapter), 0);
  await deliver(sock, message('M2', 1_700_000_011)); // the open buffer adds the 1 to the held 0
  assert.equal(await unread(adapter), 1);
  await echoDelivered(sock);
  assert.equal(await unread(adapter), 1);
});

/** The points between the receipt and the echo at which a message of the chat can be counted. */
const WINDOWS = {
  'while the write waits for its turn': 'beforeWrite',
  'while resyncAppState runs': 'duringResync',
  'while the patch is out': 'duringWrite',
};

for (const [when, hook] of Object.entries(WINDOWS)) {
  test(`a message counted ${when} keeps its count when another chat holds the event buffer open`, async t => {
    let release;
    const held = new Promise(resolve => (release = resolve));
    let otherChat;
    const arrives = sock => deliver(sock, message('M2', 1_700_000_011));
    const session = await startSession(t, {
      socket: writing({
        [hook]: hook === 'duringWrite' ? undefined : arrives,
        duringWrite: async sock => {
          if (hook === 'duringWrite') await arrives(sock);
          // After the buffer's own flush, a message of another chat starts being decrypted: its node keeps a new
          // buffer open until it ends, which is when it flushes.
          await echoDelivered(sock);
          otherChat = deliver(sock, message('X1', 1_700_000_012, { chat: OTHER }), { gate: held });
        },
      }),
    });
    const { adapter, sock } = session;
    await markedUnread(session);

    assert.equal(await adapter.sendSeen(CHAT), true);

    assert.equal(sock.replayWasBuffered, true, 'the echo is held by the buffer the other chat keeps open');
    assert.equal(await unread(adapter), 1);
    release();
    await otherChat; // the other node ends and flushes, which delivers the echo
    assert.equal(await unread(adapter), 1, 'M2 was never read, and the echo of the write must not list the chat read');
  });
}

test('a read made on the phone after the echo was delivered still lists the chat read', async t => {
  const session = await startSession(t, {
    socket: writing({ beforeWrite: sock => deliver(sock, message('M2', 1_700_000_011)) }),
  });
  const { adapter, sock } = session;
  await markedUnread(session);
  assert.equal(await adapter.sendSeen(CHAT), true);
  await echoDelivered(sock);
  assert.equal(await unread(adapter), 1);

  sock.ev.emit('chats.update', [{ id: PEER, unreadCount: 0 }]); // the account reads M2 on its phone

  assert.equal(await unread(adapter), 0);
});

// The one case the note cannot tell apart: a read on the phone that the library merges into the very hold that carries the
// replay is delivered as one zero, which is taken for the replay. The count it leaves is the one of a message that was read.
test('a read made on the phone inside the hold that carries the echo is taken for the echo', async t => {
  const session = await startSession(t, {
    socket: writing({ beforeWrite: sock => deliver(sock, message('M2', 1_700_000_011)) }),
  });
  const { adapter, sock } = session;
  await markedUnread(session);
  assert.equal(await adapter.sendSeen(CHAT), true);
  assert.equal(sock.replayWasBuffered, true);

  sock.ev.emit('chats.update', [{ id: PEER, unreadCount: 0 }]); // the same hold: one zero for both
  await echoDelivered(sock);

  assert.equal(await unread(adapter), 1);
});

test('a write WhatsApp refuses leaves no note: the zero a phone read brings later applies', async t => {
  const session = await startSession(t, { socket: writing({ refuse: true }) });
  const { adapter, sock } = session;
  await markedUnread(session);
  await deliver(sock, message('M2', 1_700_000_011));

  assert.equal(await adapter.sendSeen(CHAT), true);
  assert.equal(sock.replayWasBuffered, undefined, 'the write never reached its replay');

  sock.ev.emit('chats.update', [{ id: PEER, unreadCount: 0 }]);
  assert.equal(await unread(adapter), 0);
});

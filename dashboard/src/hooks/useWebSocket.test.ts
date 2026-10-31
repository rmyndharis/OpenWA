// The live feed's socket: what the page sends to open it and to join a room, and how it learns that the
// connection is gone for good. The client is the socket.io double (see vite-shim-hooks.mjs), which records
// what the hook sends and lets a test deliver the client's own events.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { holdConnect, lastIoCall, lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';
import type { useWebSocket as useWebSocketFn } from './useWebSocket.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useWebSocket: typeof useWebSocketFn;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // The hook opens no socket without a key.
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  rtl = await import('@testing-library/react');
  ({ useWebSocket } = await import('./useWebSocket.ts'));
});

afterEach(() => {
  mock.timers.reset();
  rtl.cleanup();
  resetSocketDouble();
});

type Frame = { type?: string; sessionId?: string; events?: string[]; requestId?: string };

/** A frame as the page meant it: the requestId only matches the gateway's answer to it. */
const withoutRequestId = (frame: unknown) =>
  Object.fromEntries(Object.entries(frame as Frame).filter(([key]) => key !== 'requestId'));

/** The subscribe frames the hook sent, in order. */
const subscribeFrames = (socket: NonNullable<ReturnType<typeof lastSocket>>): Frame[] =>
  socket.emitted.map(frame => frame.args[0] as Frame).filter(frame => frame.type === 'subscribe');

test('the handshake carries the API key in auth and in a header, never in the URL', () => {
  rtl.renderHook(() => useWebSocket());

  const call = lastIoCall();
  assert.ok(call, 'expected the hook to open a socket');
  assert.ok(call.url.endsWith('/events'), `the socket was opened on ${call.url}`);
  assert.equal(call.url.includes('test-key'), false, 'the key is in the handshake URL');
  assert.equal(call.options.query, undefined, 'the key is in the handshake query');
  assert.deepEqual(call.options.auth, { apiKey: 'test-key' });
  assert.deepEqual(call.options.extraHeaders, { 'X-API-Key': 'test-key' });
});

test('no socket is opened without a key', () => {
  window.sessionStorage.removeItem('openwa_api_key');
  try {
    rtl.renderHook(() => useWebSocket());
    assert.equal(lastIoCall(), null);
  } finally {
    window.sessionStorage.setItem('openwa_api_key', 'test-key');
  }
});

test('a room is joined and left with frames of its own, and only once the handshake is done', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');

  result.current.subscribe('s1', ['message.received']);
  assert.equal(socket.emitted.length, 0, 'a frame went out before the connection was open');

  rtl.act(() => socket.receive('connect'));
  result.current.subscribe('s1', ['message.received']);
  result.current.unsubscribe('s1');
  assert.deepEqual(
    socket.emitted.map(frame => frame.event),
    ['message', 'message'],
  );
  assert.deepEqual(
    socket.emitted.map(frame => withoutRequestId(frame.args[0])),
    [
      { type: 'subscribe', sessionId: 's1', events: ['message.received'] },
      { type: 'unsubscribe', sessionId: 's1' },
    ],
  );
});

test('the connection counts as failed once the client gives up reconnecting, and recovers on a redial', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  assert.equal(result.current.isConnected, true);

  // A dropped connection is the client's to retry: nothing is failed yet.
  rtl.act(() => socket.receive('disconnect', 'transport close'));
  assert.equal(result.current.isConnected, false);
  assert.equal(result.current.connectionFailed, false);

  // The attempts run out: only the client's manager says so, never the socket.
  rtl.act(() => socket.io.receive('reconnect_failed'));
  assert.equal(result.current.connectionFailed, true);

  rtl.act(() => result.current.reconnect());
  const redialed = lastSocket();
  assert.ok(redialed && redialed !== socket, 'expected the retry to open a fresh socket');
  rtl.act(() => redialed.receive('connect'));
  assert.equal(result.current.connectionFailed, false);
  assert.equal(result.current.isConnected, true);
});

// The gateway answers a subscribe it could not judge (its key store failed) with INTERNAL_ERROR and keeps the socket
// open, so nothing else sends that subscribe again and its room's events would stop with no sign. It is sent again
// after a pause, matched to its answer by requestId. A refusal is the gateway's judgement and is not sent again.
test('a subscribe the gateway could not check is sent again after a pause, and a refused one is not', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });

  result.current.subscribe('s1', ['message.received']);
  result.current.subscribe('s2', ['message.received']);
  const [first, second] = subscribeFrames(socket);
  assert.equal(typeof first.requestId, 'string', 'a subscribe carries no requestId to match its answer with');
  assert.notEqual(first.requestId, second.requestId);
  rtl.act(() => {
    socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', message: 'retry', requestId: first.requestId });
    socket.receive('message', { type: 'error', code: 'FORBIDDEN_SESSION', message: 'no', requestId: second.requestId });
  });
  rtl.act(() => mock.timers.tick(500));
  assert.equal(subscribeFrames(socket).length, 2, 'the subscribe was sent again at once');

  rtl.act(() => mock.timers.tick(1_000));
  const retried = subscribeFrames(socket).slice(2);
  assert.deepEqual(retried.map(withoutRequestId), [
    { type: 'subscribe', sessionId: 's1', events: ['message.received'] },
  ]);
  rtl.act(() =>
    socket.receive('message', {
      type: 'subscribed',
      sessionId: 's1',
      events: ['message.received'],
      requestId: retried[0].requestId,
    }),
  );
  rtl.act(() => mock.timers.tick(600_000));
  assert.equal(subscribeFrames(socket).length, 3, 'a refused or an answered subscribe was sent again');
  assert.equal(result.current.connectionFailed, false);
});

// Retrying for ever would hide the fault: once the pauses run out the feed counts as failed, which shows the page's
// connection banner and its retry, and nothing more is sent.
test('a subscribe that still cannot be checked after its retries reports the connection failed', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });

  result.current.subscribe('s1', ['message.received']);
  for (let round = 0; round < 20 && !result.current.connectionFailed; round++) {
    const latest = subscribeFrames(socket).at(-1);
    rtl.act(() => socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', requestId: latest?.requestId }));
    rtl.act(() => mock.timers.tick(60_000));
  }
  assert.equal(result.current.connectionFailed, true, 'the feed never reported the failure');
  const sent = subscribeFrames(socket).length;
  assert.ok(sent > 2 && sent <= 10, `the subscribe was sent ${sent} times`);
  rtl.act(() => mock.timers.tick(600_000));
  assert.equal(subscribeFrames(socket).length, sent, 'the subscribe was sent again after the failure was reported');
});

test('a waiting retry is dropped when its session is left or the connection drops', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });

  result.current.subscribe('s1', ['message.received']);
  result.current.subscribe('s2', ['message.received']);
  rtl.act(() => {
    for (const frame of subscribeFrames(socket)) {
      socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', requestId: frame.requestId });
    }
  });
  result.current.unsubscribe('s1');
  rtl.act(() => mock.timers.tick(60_000));
  assert.deepEqual(
    subscribeFrames(socket)
      .slice(2)
      .map(frame => frame.sessionId),
    ['s2'],
    'only the session still wanted is sent again',
  );

  const retried = subscribeFrames(socket).at(-1);
  rtl.act(() => socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', requestId: retried?.requestId }));
  rtl.act(() => socket.receive('disconnect', 'transport close'));
  rtl.act(() => mock.timers.tick(600_000));
  assert.equal(subscribeFrames(socket).length, 3, 'a retry went out after the connection dropped');
});

const SESSION_FEED = ['session.status', 'session.qr', 'session.restriction'];
const MESSAGE_FEED = ['message.received', 'message.sent'];

// Chats holds two subscriptions of the open session for a session-scoped key: its session feed and its message feed.
test('both subscriptions of one session the gateway could not check are sent again', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });

  result.current.subscribe('s1', SESSION_FEED);
  result.current.subscribe('s1', MESSAGE_FEED);
  rtl.act(() => {
    for (const frame of subscribeFrames(socket)) {
      socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', requestId: frame.requestId });
    }
  });
  rtl.act(() => mock.timers.tick(1_000));
  assert.deepEqual(
    subscribeFrames(socket)
      .slice(2)
      .map(frame => frame.events?.join(','))
      .sort(),
    [SESSION_FEED.join(','), MESSAGE_FEED.join(',')].sort(),
  );
});

test('a waiting retry of one subscription outlasts a new subscribe of other events for its session', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });

  result.current.subscribe('s1', MESSAGE_FEED);
  const [messages] = subscribeFrames(socket);
  rtl.act(() => socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', requestId: messages.requestId }));
  // The scope fallback joins the session feed of the same session while the message feed waits for its retry.
  result.current.subscribe('s1', SESSION_FEED);
  const [, feed] = subscribeFrames(socket);
  rtl.act(() =>
    socket.receive('message', { type: 'subscribed', sessionId: 's1', events: SESSION_FEED, requestId: feed.requestId }),
  );
  rtl.act(() => mock.timers.tick(60_000));
  assert.deepEqual(
    subscribeFrames(socket)
      .slice(2)
      .map(frame => frame.events?.join(',')),
    [MESSAGE_FEED.join(',')],
  );

  // Leaving the session drops every waiting retry of it.
  const [, , retried] = subscribeFrames(socket);
  rtl.act(() => socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', requestId: retried.requestId }));
  result.current.subscribe('s1', SESSION_FEED);
  const [, , , feedAgain] = subscribeFrames(socket);
  rtl.act(() => socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', requestId: feedAgain.requestId }));
  result.current.unsubscribe('s1');
  rtl.act(() => mock.timers.tick(600_000));
  assert.equal(subscribeFrames(socket).length, 4, 'a retry of a session left went out');
});

// The gateway meters every frame of a key, across all of its sockets, at 120 at once and then 60 a second. A frame
// over that is answered RATE_LIMITED, dropped and the socket kept: it joined nothing, like INTERNAL_ERROR.
test('a subscribe answered RATE_LIMITED is sent again after a pause, a retried one too', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });

  result.current.subscribe('s1', SESSION_FEED);
  const slowDown = (frame: Frame | undefined) =>
    socket.receive('message', {
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'slow down',
      requestId: frame?.requestId,
    });
  rtl.act(() => slowDown(subscribeFrames(socket).at(-1)));
  rtl.act(() => mock.timers.tick(1_000));
  assert.equal(subscribeFrames(socket).length, 2, 'a subscribe answered RATE_LIMITED was not sent again');

  rtl.act(() => slowDown(subscribeFrames(socket).at(-1)));
  rtl.act(() => mock.timers.tick(2_000));
  assert.equal(subscribeFrames(socket).length, 3, 'a retry answered RATE_LIMITED was not sent again');
  const latest = subscribeFrames(socket).at(-1);
  rtl.act(() =>
    socket.receive('message', {
      type: 'subscribed',
      sessionId: 's1',
      events: SESSION_FEED,
      requestId: latest?.requestId,
    }),
  );
  rtl.act(() => mock.timers.tick(600_000));
  assert.equal(subscribeFrames(socket).length, 3);
  assert.equal(result.current.connectionFailed, false);
});

// Sent again all at once, the subscribes of a scoped key with a hundred sessions would go over that budget themselves.
test('subscribes sent again go out a batch a second, and one failing again waits for the next round', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });

  const ids = Array.from({ length: 100 }, (_, n) => `s${n}`);
  for (const id of ids) result.current.subscribe(id, SESSION_FEED);
  const unreadable = (frames: Frame[]) => {
    for (const frame of frames) {
      socket.receive('message', { type: 'error', code: 'INTERNAL_ERROR', requestId: frame.requestId });
    }
  };
  rtl.act(() => unreadable(subscribeFrames(socket)));
  const resent = () => subscribeFrames(socket).slice(ids.length);

  rtl.act(() => mock.timers.tick(1_000));
  assert.equal(resent().length, 30, `${resent().length} subscribes went out at once`);
  // The first batch fails again while the rest of the round is still going out.
  const firstBatch = resent();
  rtl.act(() => unreadable(firstBatch));
  for (const total of [60, 90, 100]) {
    rtl.act(() => mock.timers.tick(1_000));
    assert.equal(resent().length, total);
  }
  assert.deepEqual(
    resent()
      .map(frame => frame.sessionId)
      .sort(),
    [...ids].sort(),
    'the round did not send each waiting subscribe once',
  );

  // The next round follows the round's last batch by the next pause.
  rtl.act(() => mock.timers.tick(1_999));
  assert.equal(resent().length, 100, 'a subscribe that failed again went out before the next pause');
  rtl.act(() => mock.timers.tick(1));
  assert.deepEqual(
    resent()
      .slice(100)
      .map(frame => frame.sessionId),
    firstBatch.map(frame => frame.sessionId),
  );
});

// A room that was not joined during the pauses missed its pushes for good, so the page reads again what it holds, as
// after a reconnect. It is told once a batch of retries, not once a subscribe, and never for a first subscribe.
test('a retried subscribe that joins is reported once a batch, and a first one that joins is not', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });
  const answer = (frame: Frame | undefined, reply: Record<string, unknown>) =>
    rtl.act(() => socket.receive('message', { ...reply, requestId: frame?.requestId }));
  const joined = (frame: Frame | undefined) =>
    answer(frame, { type: 'subscribed', sessionId: frame?.sessionId, events: frame?.events });

  for (const id of ['s1', 's2', 's3']) result.current.subscribe(id, SESSION_FEED);
  const [first, second, third] = subscribeFrames(socket);
  joined(first);
  assert.equal(result.current.rejoins, 0, 'a first subscribe that joined was reported');

  answer(second, { type: 'error', code: 'INTERNAL_ERROR' });
  answer(third, { type: 'error', code: 'INTERNAL_ERROR' });
  rtl.act(() => mock.timers.tick(1_000));
  const retried = subscribeFrames(socket).slice(3);
  assert.equal(retried.length, 2);
  for (const frame of retried) joined(frame);
  assert.equal(result.current.rejoins, 1);

  result.current.subscribe('s4', SESSION_FEED);
  answer(subscribeFrames(socket).at(-1), { type: 'error', code: 'RATE_LIMITED' });
  rtl.act(() => mock.timers.tick(1_000));
  joined(subscribeFrames(socket).at(-1));
  assert.equal(result.current.rejoins, 2);
});

// A page can send a failed subscribe again itself while it waits for its retry (Chats sends '*' again on every session
// switch). That send ends the same gap, so its join is reported like the retry's would have been, after an earlier
// rejoin too.
test('a failed subscribe the page sends again during the pause is reported as a rejoin when it joins', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });
  const answer = (frame: Frame | undefined, reply: Record<string, unknown>) =>
    rtl.act(() => socket.receive('message', { ...reply, requestId: frame?.requestId }));
  const joined = (frame: Frame | undefined) =>
    answer(frame, { type: 'subscribed', sessionId: frame?.sessionId, events: frame?.events });

  result.current.subscribe('*', SESSION_FEED);
  answer(subscribeFrames(socket).at(-1), { type: 'error', code: 'INTERNAL_ERROR' });
  rtl.act(() => mock.timers.tick(1_000));
  joined(subscribeFrames(socket).at(-1));
  assert.equal(result.current.rejoins, 1);

  for (let round = 2; round <= 3; round++) {
    result.current.subscribe('*', SESSION_FEED);
    answer(subscribeFrames(socket).at(-1), { type: 'error', code: 'INTERNAL_ERROR' });
    result.current.subscribe('*', SESSION_FEED);
    joined(subscribeFrames(socket).at(-1));
    assert.equal(result.current.rejoins, round, 'the join that ended the gap was not reported');
  }
  rtl.act(() => mock.timers.tick(600_000));
  assert.equal(subscribeFrames(socket).length, 6, 'a retry the page sent in place of went out too');
});

// Chats leaves every room of the session it switches away from, a waiting retry included, and then joins that session's
// feed again itself for a session-scoped key.
test('a retry dropped by leaving its session is reported as a rejoin once the page subscribes it again', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });
  const answer = (frame: Frame | undefined, reply: Record<string, unknown>) =>
    rtl.act(() => socket.receive('message', { ...reply, requestId: frame?.requestId }));
  const joined = (frame: Frame | undefined) =>
    answer(frame, { type: 'subscribed', sessionId: frame?.sessionId, events: frame?.events });

  result.current.subscribe('s1', SESSION_FEED);
  answer(subscribeFrames(socket).at(-1), { type: 'error', code: 'INTERNAL_ERROR' });
  result.current.unsubscribe('s1');
  result.current.subscribe('s2', MESSAGE_FEED);
  joined(subscribeFrames(socket).at(-1));
  assert.equal(result.current.rejoins, 0, 'a first subscribe of another session was reported');
  result.current.subscribe('s1', SESSION_FEED);
  joined(subscribeFrames(socket).at(-1));
  assert.equal(result.current.rejoins, 1, 'the join that ended the gap was not reported');

  // The gap is closed: the same subscription joining again is not another one.
  result.current.unsubscribe('s1');
  result.current.subscribe('s1', SESSION_FEED);
  joined(subscribeFrames(socket).at(-1));
  assert.equal(result.current.rejoins, 1);
});

test('a retry still in flight when its session is left is reported as a rejoin once the page subscribes it again', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });
  const answer = (frame: Frame | undefined, reply: Record<string, unknown>) =>
    rtl.act(() => socket.receive('message', { ...reply, requestId: frame?.requestId }));

  result.current.subscribe('s1', SESSION_FEED);
  answer(subscribeFrames(socket).at(-1), { type: 'error', code: 'INTERNAL_ERROR' });
  rtl.act(() => mock.timers.tick(1_000));
  const retry = subscribeFrames(socket).at(-1);
  assert.equal(subscribeFrames(socket).length, 2, 'the retry did not go out');
  result.current.unsubscribe('s1');
  // The gateway cancels a subscribe an unsubscribe overtakes; a late answer of it changes nothing.
  answer(retry, { type: 'error', code: 'SUBSCRIPTION_CANCELLED' });
  result.current.subscribe('s1', SESSION_FEED);
  const again = subscribeFrames(socket).at(-1);
  answer(again, { type: 'subscribed', sessionId: 's1', events: SESSION_FEED });
  assert.equal(result.current.rejoins, 1, 'a retry left in flight was not remembered');
});

// The page can send a subscribe again while an earlier send of it is still being checked: the gateway awaits the key
// read, which a failing store can make slow, and Chats sends '*' again on every session switch. Whichever answer comes
// first, the gap the failed send leaves is reported once, when the room is joined, and nothing is sent again for it.
test('a page subscribe sent while an earlier send of it is in flight ends its gap in either answer order', () => {
  const outcomes: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const earlier of ['a retry', 'a first send']) {
    for (const order of ['the failure first', 'the join first']) {
      holdConnect();
      const { result, unmount } = rtl.renderHook(() => useWebSocket());
      const socket = lastSocket();
      assert.ok(socket, 'expected the hook to open a socket');
      rtl.act(() => socket.receive('connect'));
      mock.timers.enable({ apis: ['setTimeout'] });
      const answer = (frame: Frame | undefined, reply: Record<string, unknown>) =>
        rtl.act(() => socket.receive('message', { ...reply, requestId: frame?.requestId }));
      const failed = (frame: Frame | undefined) => answer(frame, { type: 'error', code: 'INTERNAL_ERROR' });
      const joined = (frame: Frame | undefined) =>
        answer(frame, { type: 'subscribed', sessionId: frame?.sessionId, events: frame?.events });

      result.current.subscribe('*', SESSION_FEED);
      if (earlier === 'a retry') {
        failed(subscribeFrames(socket).at(-1));
        rtl.act(() => mock.timers.tick(1_000));
      }
      const inFlight = subscribeFrames(socket).at(-1);
      result.current.subscribe('*', SESSION_FEED);
      const page = subscribeFrames(socket).at(-1);
      if (order === 'the failure first') {
        failed(inFlight);
        joined(page);
      } else {
        joined(page);
        failed(inFlight);
      }
      const sent = subscribeFrames(socket).length;
      const atJoin = result.current.rejoins;
      rtl.act(() => mock.timers.tick(60_000));
      for (const frame of subscribeFrames(socket).slice(sent)) joined(frame);
      const name = `${earlier} in flight, ${order}`;
      outcomes[name] = { atJoin, sentAfter: subscribeFrames(socket).length - sent, rejoins: result.current.rejoins };
      expected[name] = { atJoin: 1, sentAfter: 0, rejoins: 1 };
      mock.timers.reset();
      unmount();
      resetSocketDouble();
    }
  }
  assert.deepEqual(outcomes, expected);
});

// The gateway answers a retry only once its key read returns, which a failing store can delay well past the page's own
// send of it, so the page's join is reported when it lands, not when the retry's answer finally does.
test('a page join while the retry of it is still unanswered is reported at the join', () => {
  holdConnect();
  const { result } = rtl.renderHook(() => useWebSocket());
  const socket = lastSocket();
  assert.ok(socket, 'expected the hook to open a socket');
  rtl.act(() => socket.receive('connect'));
  mock.timers.enable({ apis: ['setTimeout'] });
  const answer = (frame: Frame | undefined, reply: Record<string, unknown>) =>
    rtl.act(() => socket.receive('message', { ...reply, requestId: frame?.requestId }));

  result.current.subscribe('*', SESSION_FEED);
  answer(subscribeFrames(socket).at(-1), { type: 'error', code: 'INTERNAL_ERROR' });
  rtl.act(() => mock.timers.tick(1_000));
  const retry = subscribeFrames(socket).at(-1);
  result.current.subscribe('*', SESSION_FEED);
  answer(subscribeFrames(socket).at(-1), { type: 'subscribed', sessionId: '*', events: SESSION_FEED });
  const atJoin = result.current.rejoins;
  answer(retry, { type: 'error', code: 'INTERNAL_ERROR' });
  const sent = subscribeFrames(socket).length;
  rtl.act(() => mock.timers.tick(60_000));
  assert.deepEqual(
    { atJoin, afterRetryAnswer: result.current.rejoins, sentAfter: subscribeFrames(socket).length - sent },
    { atJoin: 1, afterRetryAnswer: 1, sentAfter: 0 },
  );
});

// A failure answered while another send of the subscription is out leaves that send to end the gap, which marks it after
// it was sent. Its join is still reported after an earlier report, on this connection or a previous one.
test('a failure handed to another send in flight is reported at its join after an earlier report', () => {
  for (const reconnect of [false, true]) {
    holdConnect();
    const { result, unmount } = rtl.renderHook(() => useWebSocket());
    const socket = lastSocket();
    assert.ok(socket, 'expected the hook to open a socket');
    rtl.act(() => socket.receive('connect'));
    mock.timers.enable({ apis: ['setTimeout'] });
    const answer = (frame: Frame | undefined, reply: Record<string, unknown>) =>
      rtl.act(() => socket.receive('message', { ...reply, requestId: frame?.requestId }));
    const failed = (frame: Frame | undefined) => answer(frame, { type: 'error', code: 'INTERNAL_ERROR' });
    const joined = (frame: Frame | undefined) =>
      answer(frame, { type: 'subscribed', sessionId: frame?.sessionId, events: frame?.events });

    result.current.subscribe('s1', MESSAGE_FEED);
    failed(subscribeFrames(socket).at(-1));
    rtl.act(() => mock.timers.tick(1_000));
    joined(subscribeFrames(socket).at(-1));
    assert.equal(result.current.rejoins, 1, 'the retried join was not reported');
    if (reconnect) {
      rtl.act(() => socket.receive('disconnect', 'transport close'));
      rtl.act(() => socket.receive('connect'));
    }

    result.current.subscribe('*', SESSION_FEED);
    const first = subscribeFrames(socket).at(-1);
    result.current.subscribe('*', SESSION_FEED);
    const page = subscribeFrames(socket).at(-1);
    failed(first);
    joined(page);
    const sent = subscribeFrames(socket).length;
    rtl.act(() => mock.timers.tick(60_000));
    assert.deepEqual(
      { rejoins: result.current.rejoins, sentAfter: subscribeFrames(socket).length - sent },
      { rejoins: 2, sentAfter: 0 },
      reconnect ? 'after a reconnect' : 'on the same connection',
    );
    mock.timers.reset();
    unmount();
    resetSocketDouble();
  }
});

// Quick session switches in Chats can put three sends of '*' out at once. One joins and the other two fail after it:
// the room is joined once, so what it missed is read again once, and nothing is sent again for it.
test('one join and two later failures of three sends in flight are reported once', () => {
  const outcomes: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const [joins, failOrder] of [
    [0, [1, 2]],
    [1, [0, 2]],
    [2, [0, 1]],
  ] as const) {
    holdConnect();
    const { result, unmount } = rtl.renderHook(() => useWebSocket());
    const socket = lastSocket();
    assert.ok(socket, 'expected the hook to open a socket');
    rtl.act(() => socket.receive('connect'));
    mock.timers.enable({ apis: ['setTimeout'] });
    const answer = (frame: Frame | undefined, reply: Record<string, unknown>) =>
      rtl.act(() => socket.receive('message', { ...reply, requestId: frame?.requestId }));

    for (let n = 0; n < 3; n++) result.current.subscribe('*', SESSION_FEED);
    const sends = subscribeFrames(socket);
    answer(sends[joins], { type: 'subscribed', sessionId: '*', events: SESSION_FEED });
    for (const n of failOrder) answer(sends[n], { type: 'error', code: 'INTERNAL_ERROR' });
    const sent = subscribeFrames(socket).length;
    rtl.act(() => mock.timers.tick(60_000));
    const name = `send ${joins + 1} joins`;
    outcomes[name] = { rejoins: result.current.rejoins, sentAfter: subscribeFrames(socket).length - sent };
    expected[name] = { rejoins: 1, sentAfter: 0 };
    mock.timers.reset();
    unmount();
    resetSocketDouble();
  }
  assert.deepEqual(outcomes, expected);
});

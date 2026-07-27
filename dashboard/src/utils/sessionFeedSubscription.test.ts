import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_FEED_EVENTS,
  createSessionFeedState,
  noteSessionFeedError,
  subscribeSessionFeed,
} from './sessionFeedSubscription.ts';

interface SentSubscribe {
  sessionId: string;
  events: string[];
}

// Minimal socket stand-in capturing subscribe emissions.
function mockSink() {
  const sent: SentSubscribe[] = [];
  return {
    sent,
    subscribe(sessionId: string, events: string[]) {
      sent.push({ sessionId, events });
    },
  };
}

test('unrestricted path subscribes the wildcard room once', () => {
  const sink = mockSink();
  const state = createSessionFeedState();
  subscribeSessionFeed(sink, state, ['s1', 's2']);
  assert.deepEqual(sink.sent, [{ sessionId: '*', events: [...SESSION_FEED_EVENTS] }]);
});

test('FORBIDDEN_SESSION error frame triggers the per-session fallback (scoped key)', () => {
  const sink = mockSink();
  const state = createSessionFeedState();

  // Wildcard attempt, answered by the gateway with a scope rejection.
  subscribeSessionFeed(sink, state, ['s1', 's2']);
  assert.equal(noteSessionFeedError(state, 'FORBIDDEN_SESSION'), true);
  subscribeSessionFeed(sink, state, ['s1', 's2']);

  assert.deepEqual(
    sink.sent.map(m => m.sessionId),
    ['*', 's1', 's2'],
  );
  assert.deepEqual(sink.sent[1].events, [...SESSION_FEED_EVENTS]);
});

test('fallback is silent for unrelated errors and fires only once', () => {
  const sink = mockSink();
  const state = createSessionFeedState();
  subscribeSessionFeed(sink, state, ['s1']);

  assert.equal(noteSessionFeedError(state, 'UNAUTHORIZED'), false);
  assert.equal(noteSessionFeedError(state, 'FORBIDDEN_SESSION'), true);
  // A duplicate rejection after the fallback must not re-trigger or re-subscribe.
  assert.equal(noteSessionFeedError(state, 'FORBIDDEN_SESSION'), false);

  subscribeSessionFeed(sink, state, ['s1']);
  subscribeSessionFeed(sink, state, ['s1']);
  assert.deepEqual(
    sink.sent.map(m => m.sessionId),
    ['*', 's1'],
  );
});

test('per-session mode subscribes only newly listed sessions (e.g. created after fallback)', () => {
  const sink = mockSink();
  const state = createSessionFeedState();
  subscribeSessionFeed(sink, state, []);
  noteSessionFeedError(state, 'FORBIDDEN_SESSION');

  subscribeSessionFeed(sink, state, ['s1']);
  subscribeSessionFeed(sink, state, ['s1', 's2']);

  assert.deepEqual(
    sink.sent.map(m => m.sessionId),
    ['*', 's1', 's2'],
  );
});

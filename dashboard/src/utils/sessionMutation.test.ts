import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, keepPreviousData } from '@tanstack/react-query';
import { invalidateSessionQueries, reconcileSessionCache } from './sessionMutation.ts';
import type { Session } from '../services/api.ts';

// A minimal-but-complete Session factory for the cache assertions.
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'session-1',
    status: 'ready',
    phone: '+155512345',
    pushName: 'Alice',
    lastActive: '2025-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, placeholderData: keepPreviousData } },
  });
}

// Reconciling a Session response into a seeded sessions cache must replace the matching row with the
// EXACT authoritative object — losing phone:null was the original defect.
test('reconcileSessionCache: replaces the matching row in the seeded sessions cache with the exact response', async () => {
  const queryClient = freshClient();
  const seeded = [makeSession({ id: 'a' }), makeSession({ id: 'b', phone: '+1' })];
  queryClient.setQueryData<Session[]>(['sessions'], seeded);

  const updated = makeSession({ id: 'b', status: 'disconnected', phone: null });
  await reconcileSessionCache(queryClient, ['sessions'], updated);

  const cached = queryClient.getQueryData<Session[]>(['sessions']);
  assert.equal(cached?.length, 2);
  assert.deepEqual(cached?.[1], updated);
  assert.equal(cached?.[1].phone, null);
});

// The whole point of the helper: a Session response also marks the shared session queries stale so
// the Dashboard (stats/groups/chats/templates) does not keep showing the pre-mutation counts.
test('reconcileSessionCache: invalidates the sessions prefix (list + stats) but not unrelated keys', async () => {
  const queryClient = freshClient();
  const invalidated: string[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: { queryKey?: readonly unknown[] }) => {
    invalidated.push(JSON.stringify(filters.queryKey ?? []));
    return original(filters);
  }) as typeof queryClient.invalidateQueries;

  queryClient.setQueryData<Session[]>(['sessions'], [makeSession({ id: 'a' })]);
  const updated = makeSession({ id: 'a', status: 'disconnected', phone: null });
  await reconcileSessionCache(queryClient, ['sessions'], updated);

  // The invalidate call targets the sessions prefix (matches list AND stats/groups/chats/templates).
  assert.ok(
    invalidated.some(k => k === '["sessions"]'),
    `sessions prefix not invalidated; got ${JSON.stringify(invalidated)}`,
  );
});

// The sessions list cache is shared with the Dashboard, so an update must NOT seed a row list into a
// cache slot the page never populated — that would shadow the real list query with a one-row stub.
test('reconcileSessionCache: an absent cache stays absent (no seeding with a one-row list)', async () => {
  const queryClient = freshClient();
  const updated = makeSession({ id: 'b', status: 'disconnected' });
  await reconcileSessionCache(queryClient, ['sessions'], updated);
  assert.equal(queryClient.getQueryData<Session[]>(['sessions']), undefined);
});

// create/delete use the same invalidate helper; it must mark the prefix stale so siblings refetch.
test('invalidateSessionQueries: invalidates the sessions prefix', async () => {
  const queryClient = freshClient();
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: { queryKey?: readonly unknown[] }) => {
    invalidated.push(filters.queryKey);
    return original(filters);
  }) as typeof queryClient.invalidateQueries;

  await invalidateSessionQueries(queryClient, ['sessions']);

  assert.ok(
    invalidated.some(k => JSON.stringify(k) === '["sessions"]'),
    `sessions prefix not invalidated; got ${JSON.stringify(invalidated)}`,
  );
});

// The helper receives the EXACT query key the caller built; passing the stats key invalidates only
// the stats entry, and the ['sessions'] prefix is what callers use for the broad invalidate.
test('invalidateSessionQueries: with the stats key only the stats cache family is touched', async () => {
  const queryClient = freshClient();
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: { queryKey?: readonly unknown[] }) => {
    invalidated.push(filters.queryKey);
    return original(filters);
  }) as typeof queryClient.invalidateQueries;

  await invalidateSessionQueries(queryClient, ['sessions', 'stats']);

  assert.ok(
    invalidated.some(k => JSON.stringify(k) === '["sessions","stats"]'),
    `stats key not invalidated; got ${JSON.stringify(invalidated)}`,
  );
});

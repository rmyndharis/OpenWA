import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPages } from './fetchAllPages.ts';

/** Fake page source: holds `total` rows, but never returns more than `serverMax` per call. */
function fakeSource(total: number, serverMax: number) {
  const calls: Array<{ limit: number; offset: number }> = [];
  const fetchPage = async (limit: number, offset: number) => {
    calls.push({ limit, offset });
    const take = Math.min(limit, serverMax);
    const data = Array.from({ length: Math.max(0, Math.min(take, total - offset)) }, (_, i) => offset + i);
    return { data, total };
  };
  return { fetchPage, calls };
}

test('walks every page when the server clamps below the requested size', async () => {
  // The shipped bug: requesting 500 against a server that clamps to 200 stopped after one page.
  const { fetchPage, calls } = fakeSource(650, 200);
  const rows = await fetchAllPages(fetchPage, { pageSize: 500 });
  assert.equal(rows.length, 650);
  assert.deepEqual(rows.slice(0, 3), [0, 1, 2]);
  assert.equal(calls.length, 4);
});

test('stops once total is reached without an extra empty request', async () => {
  const { fetchPage, calls } = fakeSource(400, 200);
  const rows = await fetchAllPages(fetchPage, { pageSize: 200 });
  assert.equal(rows.length, 400);
  assert.equal(calls.length, 2);
});

test('stops on an empty page even if total over-reports', async () => {
  // Guards the infinite loop: a stale/wrong `total` must not keep the loop spinning.
  const { fetchPage, calls } = fakeSource(50, 200);
  const rows = await fetchAllPages(async (limit, offset) => {
    const page = await fetchPage(limit, offset);
    return { data: page.data, total: 9999 };
  });
  assert.equal(rows.length, 50);
  assert.equal(calls.length, 2);
});

test('honours the safety cap', async () => {
  const { fetchPage } = fakeSource(10_000, 200);
  const rows = await fetchAllPages(fetchPage, { pageSize: 200, maxItems: 500 });
  assert.equal(rows.length, 600); // stops at the first page that crosses the cap
});

test('returns an empty list when there is nothing to export', async () => {
  const { fetchPage, calls } = fakeSource(0, 200);
  const rows = await fetchAllPages(fetchPage);
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 1);
});

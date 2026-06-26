import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadChunkWithReload } from './chunkReload.ts';

function makeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: k => void m.delete(k),
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('returns the module and clears the reload flag on success', async () => {
  const storage = makeStorage({ owa_chunk_reloaded: '1' });
  const mod = { default: 'Component' };
  let reloads = 0;

  const result = await loadChunkWithReload(() => Promise.resolve(mod), { reload: () => reloads++, storage });

  assert.equal(result, mod);
  assert.equal(reloads, 0);
  assert.equal(storage.getItem('owa_chunk_reloaded'), null);
});

test('reloads exactly once on a chunk failure when no reload has happened yet', async () => {
  const storage = makeStorage();
  let reloads = 0;

  // The result never settles (Suspense holds until the reload), so don't await it.
  void loadChunkWithReload(() => Promise.reject(new Error('Loading chunk 7 failed')), {
    reload: () => reloads++,
    storage,
  });
  await flush();

  assert.equal(reloads, 1);
  assert.equal(storage.getItem('owa_chunk_reloaded'), '1');
});

test('rethrows instead of reloading again once a reload already happened (no loop)', async () => {
  const storage = makeStorage({ owa_chunk_reloaded: '1' });
  let reloads = 0;

  await assert.rejects(
    loadChunkWithReload(() => Promise.reject(new Error('still failing')), { reload: () => reloads++, storage }),
    /still failing/,
  );
  assert.equal(reloads, 0);
});

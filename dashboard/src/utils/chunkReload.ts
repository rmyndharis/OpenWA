// Recovery for a failed dynamic import() of a route/lazy chunk. The dominant cause is a redeploy:
// the running index.html references hashed chunk filenames that no longer exist on the server, so
// import() rejects. A one-time full reload pulls the fresh index + chunks. A sessionStorage flag
// guards against a reload loop when the failure is not deploy-related (adblock, offline, real 404).
// React-free on purpose so it is unit-testable without a DOM. See lazyWithRetry.ts for the wiring.

const RELOAD_KEY = 'owa_chunk_reloaded';

export interface ChunkReloadDeps {
  reload: () => void;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export async function loadChunkWithReload<T>(factory: () => Promise<T>, deps: ChunkReloadDeps): Promise<T> {
  try {
    const mod = await factory();
    deps.storage.removeItem(RELOAD_KEY);
    return mod;
  } catch (err) {
    if (!deps.storage.getItem(RELOAD_KEY)) {
      deps.storage.setItem(RELOAD_KEY, '1');
      deps.reload();
      // Hold Suspense until the reload navigates away; never resolve/reject this load.
      return new Promise<T>(() => {});
    }
    // A reload already happened and it still failed → let the caller's error boundary surface it.
    throw err;
  }
}

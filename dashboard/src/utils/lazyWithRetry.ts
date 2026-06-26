import { lazy, type ComponentType } from 'react';
import { loadChunkWithReload } from './chunkReload';

/**
 * Drop-in replacement for React.lazy that survives a stale-chunk failure after a redeploy: a failed
 * dynamic import() triggers a one-time full reload (fresh index.html + chunks) instead of bubbling to
 * the top-level ErrorBoundary and blanking the whole dashboard. See chunkReload.ts for the guard logic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() =>
    loadChunkWithReload(factory, {
      reload: () => window.location.reload(),
      storage: window.sessionStorage,
    }),
  );
}

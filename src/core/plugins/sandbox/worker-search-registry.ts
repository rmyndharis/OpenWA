import { HostToWorkerMessage, WorkerToHostMessage } from './protocol';
import type { SearchQuery, SearchResults } from '../../../modules/search/search.types';

/** A sandboxed plugin's search handler — runs the plugin's query logic (e.g. Meilisearch) and returns
 *  SearchResults. Registered via ctx.registerSearchProvider; invoked when the host sends `search`. */
export type WorkerSearchHandler = (query: SearchQuery) => Promise<SearchResults> | SearchResults;

/**
 * Worker-side search-provider handling, mirroring {@link WebhookRegistry}. A sandboxed plugin registers
 * ONE search handler (via ctx.registerSearchProvider); the registry tells the host once (so the host
 * creates a PluginSearchProvider), and on a `search` message runs the handler and replies with
 * `search-result` — a thrown handler becomes ok:false, a missing handler ok:false too.
 *
 * Unlike hooks (per-event) / webhooks (per-route), a plugin provides exactly one search handler, so
 * `register` replaces any prior handler and posts `search-provider-register` only on the first call
 * (the host dedups by `plugin:<id>` anyway, but this avoids re-registration churn).
 */
export class WorkerSearchRegistry {
  private handler?: WorkerSearchHandler;
  private registered = false;

  constructor(private readonly post: (message: WorkerToHostMessage) => void) {}

  register(handler: WorkerSearchHandler): void {
    this.handler = handler;
    if (this.registered) return;
    this.registered = true;
    this.post({ kind: 'search-provider-register' });
  }

  async handleSearch(message: Extract<HostToWorkerMessage, { kind: 'search' }>): Promise<void> {
    if (!this.handler) {
      this.post({ kind: 'search-result', id: message.id, ok: false, error: 'no search handler registered' });
      return;
    }
    try {
      const results = await this.handler(message.query);
      this.post({ kind: 'search-result', id: message.id, ok: true, results });
    } catch (err) {
      this.post({
        kind: 'search-result',
        id: message.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

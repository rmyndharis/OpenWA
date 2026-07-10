# 27 - Writing a Search-Provider Plugin

> **Status:** The host→plugin search RPC shipped in v0.8.13 (PR #674). A sandboxed plugin can now register
> as a `SearchProvider` and answer `GET /api/search` queries from its own backend (Meilisearch,
> Elasticsearch, Typesense, OpenSearch, …) while the core stays backend-agnostic. This guide is the
> plugin-author's contract.

## 27.1 What it is

A **search-provider plugin** owns a search backend. It does two things:

1. **Indexes** messages — via the `message:persisted` hook (the plugin stays in sync with live traffic).
2. **Answers queries** — via `ctx.registerSearchProvider(handler)`. The host routes `GET /api/search` to
   the plugin over a correlated `search` / `search-result` wire protocol and returns the plugin's
   `SearchResults` to the caller.

The core never talks to the search backend directly — all vendor-specific logic (the query builder, the
API client, the index schema) lives in the plugin. Swapping backends is a config change
(`SEARCH_PROVIDER`), not a code change. See [26 - Global Search](./26-global-search.md) for the
user-facing feature and the built-in DB-FTS default.

## 27.2 The contract

### Register the handler

In `onEnable`, call `ctx.registerSearchProvider(handler)` with a function that takes a `SearchQuery` and
returns a `SearchResults`:

```ts
ctx.registerSearchProvider(async (query) => {
  // query: SearchQuery — { q, sessionIds?, sessionId?, chatId?, direction?, type?, from?, dateFrom?, dateTo?, limit?, offset? }
  // Run your backend's query here (e.g. a Meilisearch /search call).
  return {
    hits: [...],   // SearchHit[] — see below
    total: 123,    // bounded exact count for pagination
    tookMs: 7,     // your query time in ms
    provider: `plugin:${ctx.pluginId}`,  // your provider id (the host derives `plugin:<id>` automatically)
  };
});
```

A plugin may register **one** search handler (calling `registerSearchProvider` again replaces it; the
host is notified once). If `onEnable` throws after registering, the host cleans up (the provider is
unregistered).

### The `SearchHit` shape

Each hit must carry every field below — the dashboard + the SDKs consume them directly:

```ts
{
  messageId: string;      // your stable id for the message (the core Message PK is the convention)
  waMessageId: string;    // the WhatsApp message id (empty string if unknown)
  sessionId: string;
  chatId: string;
  body: string;           // the full message body (the dashboard may truncate for display)
  snippet: string;        // excerpt with <mark>…</mark> around the matched term(s) — render as TEXT, never HTML
  timestamp: number;      // epoch-seconds (matches the core messages.timestamp column)
  type: string;           // the MessageType ('text', 'image', …)
  direction: string;      // 'incoming' | 'outgoing'
  from: string;           // sender jid / phone
  score?: number;         // optional relevance score (backend-specific)
}
```

The `<mark>` snippet markers are the **only** highlight convention — the dashboard renders the snippet as
text (escape-then-highlight), never as HTML. Do not inject HTML.

## 27.3 Indexing via the `message:persisted` hook

The core fires `message:persisted` for every live message (outbound on send, inbound on receive) — never
for history backfill. Register a handler to keep your index in sync:

```ts
ctx.registerHook('message:persisted', async (hookCtx) => {
  const { sessionId, message } = hookCtx.data;
  // message carries: id, waMessageId, sessionId, chatId, body, from, to, type, direction, timestamp, …
  await myBackend.index(message);   // fire-and-forget is fine; an error here doesn't break the send/receive
});
```

**Backfill is the plugin's responsibility.** The hook fires only for live traffic. A plugin installed on
a deployment with existing message history must perform its own one-time backfill (read the `messages`
table via `ctx.engine.getChatHistory` or a direct query, and index) at `onEnable`. The built-in DB-FTS
provider is unaffected (its index is DB-synced via triggers on every insert, including backfill).

## 27.4 Host-side guarantees (the plugin author doesn't handle these)

The host enforces these before/after the RPC, so the plugin doesn't have to:

- **Pagination cap.** `limit` is clamped to `SEARCH_LIMIT_MAX` (default 100) and `offset` to
  `SEARCH_OFFSET_MAX` before the query reaches the plugin. The plugin still receives the bounded values;
  honor them.
- **Session-scope re-filter.** The host re-filters the plugin's returned hits against the caller's
  `allowedSessions` (defense-in-depth — the plugin is trusted to scope, but the host verifies). A scoped
  key never sees an out-of-scope hit even if the plugin leaks one.
- **Timeout.** The plugin's `search()` handler must answer within **10 seconds** (`SANDBOX_SEARCH_TIMEOUT_MS`).
  A slow/wedged handler resolves `ok:false` → the caller sees `503 Service Unavailable`. Fail fast.
- **Health.** The host reuses the plugin's general `healthCheck()` (the `health` lifecycle method) for
  the `/search` health check. Implement `healthCheck()` to report your backend's reachability.
- **Selection.** When `SEARCH_PROVIDER=auto` (the default), the plugin supersedes the built-in
  `builtin-fts` on enable. Set `SEARCH_PROVIDER=builtin-fts` to keep the built-in active.

## 27.5 A minimal full example

```
plugins/my-search/
├── manifest.json
└── index.js
```

**manifest.json:**
```json
{
  "id": "my-search",
  "name": "My Search Backend",
  "version": "1.0.0",
  "type": "extension",
  "main": "index.js"
}
```

**index.js:**
```js
module.exports = class MySearchPlugin {
  async onEnable(ctx) {
    // 1. Index every persisted message (live traffic only — backfill separately at onEnable).
    ctx.registerHook('message:persisted', async (hookCtx) => {
      const { message } = hookCtx.data;
      await this._index(ctx, message);
    });

    // 2. Answer search queries.
    ctx.registerSearchProvider(async (query) => {
      const start = Date.now();
      const results = await this._search(ctx, query); // your backend's query
      return {
        hits: results.rows.map((r) => ({
          messageId: String(r.id),
          waMessageId: r.waMessageId ?? '',
          sessionId: r.sessionId,
          chatId: r.chatId,
          body: r.body,
          snippet: this._highlight(r.body, query.q), // wrap the match in <mark>…</mark>
          timestamp: r.timestamp,
          type: r.type,
          direction: r.direction,
          from: r.from,
          score: r.score,
        })),
        total: results.total,
        tookMs: Date.now() - start,
        provider: `plugin:${ctx.pluginId}`,
      };
    });
  }

  // Your backend-specific methods:
  async _index(ctx, message) { /* upsert into your index */ }
  async _search(ctx, query) { /* run your backend's query, honoring query.q + filters + limit/offset */ return { rows: [], total: 0 }; }
  _highlight(body, term) { return body.replace(new RegExp(term, 'gi'), '<mark>$&</mark>'); }

  // Optional: report backend health to the /search health check.
  async healthCheck() {
    const ok = await this._pingBackend();
    return { healthy: ok, message: ok ? undefined : 'backend unreachable' };
  }
};
```

## 27.6 TypeScript plugin authors

The contract types are exported from the core:

```ts
import type { SearchQuery, SearchResults, SearchHit } from '../../modules/search/search.types';
```

(Add the OpenWA repo as a devDependency or reference the types via a `paths` mapping. A standalone
`@openwa/plugin-types` package is planned.)

The worker context a sandboxed plugin receives exposes: `pluginId`, `config` (per-session-resolved),
`logger`, the capability bridge (`messages`, `engine`, `storage`, `net`, …), `registerHook`,
`registerWebhook`, and `registerSearchProvider`. (A formal `@openwa/plugin-types` package with the full
ctx interface is planned; for now the search contract types above are the stable surface.)

## 27.7 Gotchas

- **`timestamp` is epoch-seconds**, not epoch-ms (matches the core `messages.timestamp` column). The
  `dateFrom`/`dateTo` in the query are epoch-ms; convert if your backend uses ms.
- **The provider id is `plugin:<manifest.id>`** — the host derives it; your `SearchResults.provider`
  should match (`plugin:${ctx.pluginId}`).
- **The 10s timeout is hard.** A backend that's slow under load returns 503 (the host fails fast, never
  hangs the `/search` request). Use a backend-side query timeout shorter than 10s.
- **Session scope is authoritative.** The caller's `allowedSessions` is injected by the host into
  `query.sessionIds` — the plugin should honor it (filter by `sessionIds` in the backend query) for
  correct results + performance. The host re-filters as defense-in-depth, but a plugin that ignores
  `sessionIds` returns more rows than needed (wasteful) and relies on the host to strip them.
- **`message:persisted` is fire-and-forget.** An error in the indexing handler is swallowed (it must not
  break the send/receive pipeline). Log errors via `ctx.logger` and retry/mirror in your backend's own
  retry queue if you need stronger delivery guarantees.

---

> See also: [26 - Global Search](./26-global-search.md) (the feature + the built-in provider),
> [19 - Plugin Architecture](./19-plugin-architecture.md),
> [23 - Plugin Sandboxing](./23-plugin-sandboxing.md),
> [06 - API Specification](./06-api-specification.md) §6.4.12 Search.

# 19 - Plugin Architecture

## Implementation Status

> **Current Status: ✅ Implemented**
>
> The plugin runtime — loader, hook bus, capability facade, permission enforcement, per-session
> activation, and a `worker_thread` sandbox for user-installed plugins — is shipped and wired.

| Component                | Status         | Location                                                           |
| ------------------------ | -------------- | ------------------------------------------------------------------ |
| **HookManager**          | ✅ Implemented | `src/core/hooks/hook-manager.service.ts`                           |
| **PluginLoaderService**  | ✅ Implemented | `src/core/plugins/plugin-loader.service.ts`                        |
| **PluginStorageService** | ✅ Implemented | `src/core/plugins/plugin-storage.service.ts`                       |
| **Manifest loading**     | ✅ Implemented | Loads from `plugins/` directory                                    |
| **Plugin lifecycle**     | ✅ Implemented | onLoad, onEnable, onDisable, onUnload, onConfigChange, healthCheck |
| **Dashboard UI**         | ✅ Implemented | `dashboard/src/pages/Plugins.tsx`                                  |
| **REST API**             | ✅ Implemented | `src/modules/plugins/plugins.controller.ts`                        |

| Component                    | Status         | Notes                                                                                                                                    |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandboxed execution**      | ✅ Implemented | User-installed (disk-loaded) plugins run in a `worker_thread`; see [30 — Plugin Sandboxing](./30-plugin-sandboxing.md). No `vm2`.        |
| **Permission enforcement**   | ✅ Implemented | Capability permissions enforced at the call boundary via `assertPermission`                                                              |
| **Per-session activation**   | ✅ Implemented | A session-scoped plugin runs only for the sessions an operator activated it for                                                          |
| **Per-session config**       | ✅ Implemented | Per-session config overrides deep-merged over the base config at hook time (nested objects merge key by key; arrays and scalars replace) |
| **Built-in plugins**         | ✅ Implemented | The two engine adapters (`whatsapp-web.js`, `baileys`) register as in-process built-ins                                                  |
| **Plugin install / catalog** | ✅ Implemented | Install a `.zip` by upload or URL, or from the remote catalog                                                                            |
| **@openwa/plugin-sdk**       | 🔜 Planned     | NPM package not yet published; plugins implement `IPlugin` directly today                                                                |

---

## 19.1 Overview

The plugin architecture enables OpenWA extensibility without modifying the core codebase. Plugins can add new features, integrate with external services, or customize behavior.

### Design Goals

```mermaid
flowchart TB
    subgraph Goals
        ISO[Isolation]
        EXT[Extensibility]
        SAFE[Safety]
        PERF[Performance]
    end

    subgraph Implementation
        ISO --> SANDBOX[Sandboxed Execution]
        EXT --> HOOKS[Hook System]
        SAFE --> PERM[Permission Model]
        PERF --> LAZY[Lazy Loading]
    end
```

1. **Isolation** - User-installed plugins (anything loaded from the `plugins/` directory) run in a `worker_thread`, separate from in-process built-ins; capability calls round-trip to the host. First-party built-ins (the engine adapters) run in-process. A `worker_thread` is V8-context isolation in the same OS process, not an OS-level sandbox — see [30 — Plugin Sandboxing](./30-plugin-sandboxing.md) for what it does and does not guarantee, and the OS-containment guidance.
2. **Extensibility** - Easy to add new features
3. **Safety** - Capability permissions are enforced at the call boundary (`assertPermission` throws `PluginCapabilityError`), session scope is enforced per call, and `ctx.net.fetch` is SSRF-guarded and host-allowlisted (a direct Node socket opened by the worker is not; see [30 - Plugin Sandboxing](./30-plugin-sandboxing.md)).
4. **Performance** - Lazy loading, minimal overhead

## 19.2 Plugin Types

### Type Categories

```mermaid
flowchart LR
    subgraph PluginTypes[Plugin Types]
        MSG[Message Handlers]
        WH[Webhook Transformers]
        AUTH[Auth Providers]
        STORE[Storage Providers]
        INT[Integrations]
    end

    MSG --> |Process| INCOMING[Incoming Messages]
    MSG --> |Transform| OUTGOING[Outgoing Messages]
    WH --> |Filter/Transform| WEBHOOK[Webhook Payloads]
    AUTH --> |Custom| AUTHFLOW[Auth Flow]
    STORE --> |Alternative| STORAGE[Storage Backends]
    INT --> |External| SERVICES[External Services]
```

| Type                | Description                        | Examples                    |
| ------------------- | ---------------------------------- | --------------------------- |
| Message Handler     | Process incoming/outgoing messages | Auto-reply, Translation     |
| Webhook Transformer | Transform webhook payloads         | Add metadata, Filter events |
| Auth Provider       | Custom authentication              | OAuth, LDAP                 |
| Storage Provider    | Alternative storage backends       | Google Drive, Dropbox       |
| Integration         | External service integration       | CRM, Analytics, n8n         |

## 19.3 Plugin Structure

### Directory Structure

```
plugins/
├── my-plugin/
│   ├── package.json         # Plugin metadata
│   ├── index.ts              # Entry point
│   ├── manifest.json         # Permissions & config
│   ├── src/
│   │   ├── handlers/         # Message handlers
│   │   ├── hooks/            # Hook implementations
│   │   └── utils/            # Utilities
│   ├── config/
│   │   └── default.json      # Default config
│   └── README.md             # Documentation
```

### Manifest File

`id`, `name`, `version`, `type`, and `main` are required; the rest are optional. There is **no**
`types` field and **no** `maxVersion`. The host version is gated by `minOpenWAVersion` only (see its
row), and the SDK major by the check applied to a manifest that declares `ingress` (see the
`sdkVersion` row). The config schema is the top-level `configSchema` (note: not nested under `config`).

```json
{
  "id": "my-awesome-plugin",
  "name": "My Awesome Plugin",
  "version": "1.0.0",
  "type": "extension",
  "description": "An awesome plugin for OpenWA",
  "author": "Your Name",
  "license": "MIT",

  "main": "dist/index.js",

  "permissions": ["messages:send", "engine:read", "net:fetch"],

  "sessionScoped": true,
  "sessions": ["*"],

  "net": { "allow": ["api.example.com"] },

  "hooks": ["message:received", "message:sending"],

  "provides": ["greeter"],
  "requires": [],

  "configSchema": {
    "type": "object",
    "properties": {
      "greeting": { "type": "string", "title": "Greeting", "default": "Hello" },
      "apiKey": { "type": "string", "title": "API key", "secret": true }
    }
  },

  "configUi": { "entry": "config-ui.html", "height": 480 },

  "i18n": {
    "es": { "name": "Mi complemento", "config": { "greeting": { "title": "Saludo" } } }
  }
}
```

| Field                   | Required | Meaning                                                                                                                                                                                                                                                                                              |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | ✅       | Unique identifier (also the plugin's on-disk directory name)                                                                                                                                                                                                                                         |
| `name`                  | ✅       | Display name                                                                                                                                                                                                                                                                                         |
| `version`               | ✅       | Semver                                                                                                                                                                                                                                                                                               |
| `type`                  | ✅       | The enum has five values (`engine`, `storage`, `queue`, `auth`, `extension`) but only `extension` is installable — an uploaded or hand-placed directory declaring any other type is rejected at install **and** at boot load. The other tiers are reserved for programmatically registered built-ins |
| `main`                  | ✅       | Entry file, resolved **inside** the plugin directory (a path that escapes it is rejected)                                                                                                                                                                                                            |
| `permissions`           | —        | Capability permissions this plugin declares; absent/empty = no capability access                                                                                                                                                                                                                     |
| `sessions`              | —        | Session ids this plugin may act on, or `['*']`. Absent = `['*']`. Static — editing config can't widen it                                                                                                                                                                                             |
| `sessionScoped`         | —        | Default `true`. A scoped plugin only sees events for the sessions it's activated for; `false` = always runs                                                                                                                                                                                          |
| `net.allow`             | —        | Outbound-HTTP host allowlist for `ctx.net.fetch` (`host`, `host:port`, or `'*'`). Absent = deny all, unless `net.allowConfigHosts` admits a host                                                                                                                                                     |
| `net.allowConfigHosts`  | —        | Config keys holding an https URL; each URL's https origin (scheme, host and port) is admitted at fetch time on top of `net.allow`, so an adapter can reach an operator-configured host without `net.allow: ['*']`. Credentialed or non-https values are ignored, and the SSRF guard still applies    |
| `sdkVersion`            | —        | Integration SDK `major` (or `major.minor`) the plugin was authored against. Absent = `'1'`. Only enforced for a manifest declaring `ingress`: a major other than `1` is refused at load                                                                                                              |
| `minOpenWAVersion`      | -        | Oldest OpenWA release the plugin runs on (`MAJOR.MINOR.PATCH`). Install answers 400 and boot load fails when the running host is older; a malformed value is rejected. Absent or `null` = no floor                                                                                                   |
| `ingress`               | —        | Inbound webhook routes this plugin claims (requires the `webhook:ingress` permission). Validated at load — route uniqueness, signature scheme, ack contract; see [25 — Integration Fabric](./25-integration-fabric.md)                                                                               |
| `configSchema`          | —        | Declarative config schema the dashboard renders as a form when there is no `configUi`. Still required with one: it defines the fields, their types and which are `secret`                                                                                                                            |
| `configUi`              | —        | Optional self-contained HTML config editor served into a sandboxed iframe. When present it **replaces** the generated form and owns saving — the dashboard renders neither the form nor its Save button                                                                                              |
| `hooks`                 | —        | Hook events this plugin listens to (informational)                                                                                                                                                                                                                                                   |
| `provides` / `requires` | —        | Features this plugin provides / depends on                                                                                                                                                                                                                                                           |
| `i18n`                  | —        | Localized dashboard text per locale (dashboard-only; a `configUi` editor receives it through the localized `schema`)                                                                                                                                                                                 |

**The `configUi` bridge.** The editor is injected as `srcdoc` into a `sandbox="allow-scripts"` iframe, so
it has an opaque origin and no access to the dashboard. It talks to the host by `postMessage`:

| Direction     | Message                                                          | Notes                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iframe → host | `{ type: 'config:get' }`                                         | Sent on load; the host answers with the current values                                                                                                       |
| host → iframe | `{ type: 'config:value', config, schema, locale, theme }`        | `config` is already secret-redacted. `schema` text is localized for `locale`, the dashboard language. `theme` is `'light'` or `'dark'`, resolved by the host |
| iframe → host | `{ type: 'config:save', config }`                                | The host makes the authenticated write                                                                                                                       |
| host → iframe | `{ type: 'config:saved' }` / `{ type: 'config:error', message }` | Outcome of that write                                                                                                                                        |

`theme` matters because an opaque-origin iframe cannot read the dashboard's theme for itself; without it
an editor can only guess, and a light-only editor becomes a glaring white panel inside a dark modal. It is
sent once, with the handshake — the theme control sits behind the modal overlay, so an explicit Light or
Dark choice cannot change while an editor is open. With the System theme, though, an OS color-scheme change
is not forwarded, so an editor that wants to follow it should also listen to `prefers-color-scheme` inside
the frame. Treat it as optional: an editor that ignores it still works, and one that uses it should fall
back to `prefers-color-scheme` so it stays readable on an older host.

`locale` is the dashboard's language code (`'es'`, `'zh-CN'`, ...), sent for the same reason: the iframe
cannot read the operator's language setting, and `navigator.language` differs from it whenever the
operator picked a language other than the browser's. The `schema` in the same message carries field
titles and descriptions localized from the manifest `i18n` block for that code, the same text the
generated form shows. Everything else in the editor (its own labels, buttons, messages) is the editor's
to translate from `locale`. Treat it as optional too, and fall back to `navigator.language` on an older
host.

A `configSchema` field may set `secret: true` (e.g. an API key): the value is masked on read and
preserved on an unchanged write.

### Plugin Entry Point

A plugin's `main` module **default-exports a class** that implements `IPlugin`. All lifecycle methods
are optional and each receives only the `PluginContext` — there is no second `config` argument; config
is read from `ctx.config`.

```typescript
// plugins/my-plugin/index.ts

import type { IPlugin, PluginContext } from '@openwa/plugin-sdk'; // shape only; implement IPlugin

interface MyPluginConfig {
  greeting: string;
  apiKey?: string;
}

export default class MyAwesomePlugin implements IPlugin {
  async onLoad(ctx: PluginContext): Promise<void> {
    ctx.logger.log('Plugin loaded', { version: ctx.manifest.version });

    // Register a hook handler. Handlers receive a HookContext and return a HookResult.
    ctx.registerHook('message:received', async hookCtx => {
      const cfg = ctx.config as MyPluginConfig; // per-session-merged config for this event
      const { sessionId, data } = hookCtx;
      const message = data as { from: string; body?: string };

      if (message.body?.toLowerCase() === 'help' && sessionId) {
        // Capability call — requires the 'messages:send' permission + an in-scope, live session.
        await ctx.messages.sendText(sessionId, message.from, cfg.greeting ?? 'How can I help you?');
        return { continue: false }; // stop the chain
      }
      return { continue: true };
    });
  }

  async onEnable(_ctx: PluginContext): Promise<void> {}
  async onDisable(_ctx: PluginContext): Promise<void> {}
  async onUnload(ctx: PluginContext): Promise<void> {
    ctx.logger.log('Plugin unloading');
  }

  async onConfigChange(ctx: PluginContext, newConfig: Record<string, unknown>): Promise<void> {
    ctx.logger.log('Config changed', { keys: Object.keys(newConfig) });
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return { healthy: true };
  }
}
```

## 19.4 Plugin SDK

> Plugins implement the `IPlugin` interface directly. An `@openwa/plugin-sdk` npm package is planned
> but not yet published; the interfaces below are the live runtime contract from
> `src/core/plugins/plugin.interfaces.ts`.

### Core Interfaces

```typescript
// src/core/plugins/plugin.interfaces.ts

export interface IPlugin {
  // All optional; each receives only the PluginContext.
  onLoad?: (context: PluginContext) => Promise<void>;
  onEnable?: (context: PluginContext) => Promise<void>;
  onDisable?: (context: PluginContext) => Promise<void>;
  onUnload?: (context: PluginContext) => Promise<void>;
  onConfigChange?: (context: PluginContext, newConfig: Record<string, unknown>) => Promise<void>;
  healthCheck?: () => Promise<{ healthy: boolean; message?: string }>;
}

export interface PluginContext {
  pluginId: string;
  manifest: PluginManifest;

  // Effective config for the firing session (per-session override merged over the base). A getter,
  // so it reflects live config edits; outside a hook it returns the base config.
  config: Record<string, unknown>;

  hookManager: HookManager;
  logger: PluginLogger; // log / debug / warn / error
  storage: PluginStorage; // get / set / delete / list — requires 'storage:use', scoped to this plugin

  // Register a hook handler (optionally with a priority; lower runs first).
  registerHook: (event: HookEvent, handler: HookHandler, priority?: number) => void;

  // Claim one of the manifest's declared ingress routes (requires 'webhook:ingress'). Sandboxed
  // plugins only — an in-process built-in that calls it throws.
  registerWebhook: (route: string, handler: WebhookHandler) => void;

  // Capability facade (permission- + scope-checked on each call):
  messages: PluginMessagingCapability; // requires 'messages:send'
  engine: PluginEngineReadCapability; // requires 'engine:read' (read-only)
  net: PluginNetCapability; // requires 'net:fetch' (SSRF-guarded, host-allowlisted)
  conversations: PluginConversationsCapability; // requires 'conversation:send'
  handover: PluginHandoverCapability; // requires 'conversation:send'
  mappings: PluginMappingsCapability; // requires 'conversation:send'
}

export interface PluginLogger {
  log(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown, meta?: Record<string, unknown>): void;
}
```

There is **no** `ctx.api`, `ctx.router`, or `ctx.events` — a plugin never binds a port, mounts its own
route, or gets an event emitter. Inbound HTTP reaches a plugin only through `ctx.registerWebhook`, which
claims a route the manifest already declared under `ingress`: the host owns the URL (mounted under
`ingress`), verifies the provider signature, dedups and enqueues, then dispatches to the handler — see
[25 — Integration Fabric](./25-integration-fabric.md). A sandboxed plugin additionally gets
`ctx.registerSearchProvider` for answering global-search queries — see
[27 — Writing a Search-Provider Plugin](./27-plugin-search-providers.md). Hook handlers use the host
`HookContext` / `HookResult` shape (see §19.5), not a `{ continue, modified }` shape.

### Capability facade

A plugin reaches WhatsApp, the engine, and the network **only** through these namespaces. Each call is
gated by the matching declared permission (and, for everything except `net` and `storage`, the session scope) — a
missing grant throws a `PluginCapabilityError`.

```typescript
// ctx.messages — requires 'messages:send'. Routes through MessageService (persistence preserved).
export interface PluginMessagingCapability {
  sendText(sessionId: string, chatId: string, text: string): Promise<MessageResponseDto>;
  reply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<MessageResponseDto>;
}

// ctx.engine — requires 'engine:read'. Read-only, scoped engine queries.
export interface PluginEngineReadCapability {
  getGroupInfo(sessionId: string, groupId: string): Promise<...>;
  getContacts(sessionId: string): Promise<...>;
  getContactById(sessionId: string, contactId: string): Promise<...>;
  checkNumberExists(sessionId: string, phone: string): Promise<...>;
  getChats(sessionId: string): Promise<...>;
  // Recent messages for a chat, both directions, oldest first (history backfill). `limit` is clamped host-side to 1-100.
  getChatHistory(sessionId: string, chatId: string, limit?: number, includeMedia?: boolean): Promise<...>;
  // Canonical form of a chat id: resolves a known '@lid' privacy id to its stable '<phone>@c.us',
  // otherwise returns the id unchanged (best-effort).
  canonicalChatId(sessionId: string, chatId: string): Promise<string>;
}

// ctx.net — requires 'net:fetch'. Always through the host SSRF guard, scoped to the effective host
// allowlist (manifest net.allow + the https origins of the net.allowConfigHosts config keys).
export interface PluginNetCapability {
  fetch(url: string, init?: PluginNetRequestInit): Promise<PluginNetResponse>;
}

// ctx.conversations / ctx.handover / ctx.mappings — all require 'conversation:send'. The normalized
// outbound surface an integration adapter uses; sends translate host-side to MessageService.
export interface PluginConversationsCapability {
  send(env: ConversationSendEnvelope): Promise<unknown>;
}
export interface PluginHandoverCapability {
  set(key: { sessionId: string; chatId: string; instanceId: string }, state: HandoverState): Promise<unknown>;
}
export interface PluginMappingsCapability {
  upsert(key: { sessionId: string; chatId: string; instanceId: string }, providerConversationId: string): Promise<void>;
  get(key: { sessionId: string; chatId: string; instanceId: string }): Promise<... | null>;
  getByProvider(instanceId: string, providerConversationId: string): Promise<... | null>;
}
```

`ctx.net.fetch` returns a serializable response (`{ ok, status, statusText, headers, body }`, body as
a string) — no streaming and no live `Response` object, because it must cross the worker boundary via
structured clone. The request has a default 15 s / hard-cap 30 s timeout and a 10 MB response cap.

### Plugin Storage

```typescript
// Key-value storage, scoped to the plugin (values cross structuredClone, so keep them serializable).
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

## 19.5 Hook System

### Hook Lifecycle

```mermaid
sequenceDiagram
    participant Core as OpenWA Core
    participant HM as Hook Manager
    participant P1 as Plugin 1
    participant P2 as Plugin 2
    participant WH as Webhook

    Core->>HM: Message Received
    HM->>P1: message:received
    P1->>HM: {continue: true, data: msg}
    HM->>P2: message:received (with P1's data)
    P2->>HM: {continue: true}
    HM->>Core: Continue processing
    Core->>WH: Deliver webhook
```

A handler returns `{ continue: false }` to stop the chain. To transform the event it returns
`{ continue: true, data: <new value> }`; the next handler (and the host) sees that `data`. (There is
no `modified` field — the result type uses `data`.) A handler that both transforms and stops the chain
still has its `data` applied.

**What `continue: false` does and does not do.** On a **notification** event — `message:received`,
`message:sent` — it stops the remaining handlers and nothing else. The message has already arrived at,
or left, WhatsApp, so the gateway still persists it and still dispatches `message.received` /
`message.sent` to webhooks and the websocket. This is the flag an auto-reply plugin uses to claim a
message ("I answered this, don't let another bot answer it too"); it is not a way to hide a message from
the operator's own history. For the same reason the gateway only keeps a returned `data` on these two
events while it is still a message (an object with a string `id` and `chatId`): `data: null`, a
primitive or `{}` is logged and skipped, and the chain carries on with the last message it held, so an
earlier handler's rewrite (a redaction) still applies. `webhook:before` treats a result without a
plain-object `payload` the same way.

On a **pre-action** event it is a veto, because the action has not been taken yet: `false` on
`message:sending` blocks the send (the caller gets a `400`), and on `webhook:before` it cancels that one
delivery.

A bulk send (`POST /api/sessions/:sessionId/messages/send-bulk`) runs `message:sending` once per item,
and fires `message:failed` for an item that fails for any reason other than a plugin block or a pacing
refusal. Both carry the item's content with its recipient `chatId` added as `input`, so a handler that
reads `input.chatId` on a single send reads it here too. A handler may rewrite the content, but a
rewritten `chatId` is ignored: the item always goes to its own recipient. On a single send the rewritten
`input` is what gets sent, `chatId` included.

A product send (`POST /api/sessions/:sessionId/messages/send-product`) runs `message:sending` with type
`product`, source `CatalogService` and `input` `{ chatId, productId, body }`. A handler may rewrite
`productId` or `body`; a value that is not a string (or an empty `productId`) is refused with `400`. As
with a bulk item, a rewritten `chatId` is ignored: the product goes to the chat the request named.

> **`message:sending` does not see every attempted send.** With send pacing enabled
> (`SEND_PACING_ENABLED`), the pacing governor runs _before_ this hook, so a send it refuses never
> fires `message:sending` — plugins are not asked to moderate, and cannot rewrite, traffic that
> policy already forbids. Treat the hook as a complete record of sends **actually attempted against
> WhatsApp**, not of send _requests_. A paced-out request surfaces to the caller as `429` with
> `code: SEND_PACING_LIMITED`; a plugin veto stays `400`. Pacing is off by default, so a deployment
> that has not opted in sees the hook fire exactly as before.

> Until 0.10.5, `continue: false` on the two notification events also skipped persistence, the webhook
> and the websocket emit. An auto-reply plugin returning it for its ordinary purpose therefore erased
> the triggering message from the dashboard's chat history and from every integration downstream. If you
> wrote a plugin that relied on that to hide messages, it no longer does — filter on the consumer side
> instead.

### Hook events

```typescript
// src/core/hooks/hook.interfaces.ts

export type HookEvent =
  // Session lifecycle
  | 'session:created'
  | 'session:starting'
  | 'session:ready'
  | 'session:qr'
  | 'session:disconnected'
  | 'session:error'
  | 'session:deleted'
  // Message lifecycle
  | 'message:received'
  | 'message:sending'
  | 'message:sent'
  | 'message:failed'
  | 'message:ack'
  | 'message:persisted'
  | 'message:deleted'
  // Webhook lifecycle
  | 'webhook:before'
  | 'webhook:queued'
  | 'webhook:delivered'
  | 'webhook:after'
  | 'webhook:error'
  // Ingress (inbound provider webhook -> plugin) lifecycle
  | 'ingress:error';
```

`session:created` carries the new session in the shape the REST API returns it (`id`, `name`, `status`,
timestamps and so on), never the stored `proxyUrl` or `config`; `session:deleted` carries
`{ id, name, phone, pushName }`.

### Hook context and result

```typescript
export interface HookContext<T = unknown> {
  event: HookEvent;
  data: T; // the event payload (mutate via the returned HookResult.data)
  sessionId?: string; // the session the event belongs to (used for activation + capability scope)
  timestamp: Date;
  source: string; // which service emitted this
}

export interface HookResult<T = unknown> {
  continue: boolean; // false = stop the chain
  data?: T; // replacement payload for the next handler (only applied when error is absent)
  error?: Error; // an error to propagate; the handler's data mutation is discarded
}

export type HookHandler<T = unknown> = (ctx: HookContext<T>) => Promise<HookResult<T>>;
```

### Hook Manager behavior

`HookManager` (`src/core/hooks/hook-manager.service.ts`) is a NestJS provider. Handlers are stored per
event and run in **priority order** (lower `priority` first; default `100`; a priority that is not a
finite number runs at `100`). A sandboxed plugin's handlers for one event share a single host-side
registration at the lowest priority among them, so relative to other plugins they all run at that point,
and among themselves in their own order. On `execute(event, data,
{ sessionId, source })` it walks the chain, threading each handler's returned `data` into the next; a
handler that returns `{ continue: false }` stops the chain. A handler that **throws** is logged and the
chain continues with the previous data (one bad plugin can't break the chain). Same-event re-entrancy
is blocked: a handler that re-fires the event it is handling is short-circuited (guards synchronous
re-entry only). Plugins never call `HookManager` directly — they use `ctx.registerHook(...)`, which
also applies the per-session activation gate.

Chains for different messages run concurrently, so a handler can see one chat's messages out of order.
The gateway still stores and emits each chat's messages in arrival order: the `message:received` and
`message:sent` chains run concurrently, but the row insert, the websocket event, `message:persisted` and
the start of webhook dispatch wait for every earlier message of the same chat. A slow handler therefore
delays that chat's later messages, by at most its 5 s hook timeout (`SANDBOX_HOOK_TIMEOUT_MS`) for a
sandboxed plugin. Webhook dispatch itself is not ordered: its queue jobs and HTTP deliveries run
concurrently, so a receiver that needs order should sort by the message's `data.timestamp`. That value is
whole seconds from WhatsApp, so messages sent within the same second cannot be put back in order.

## 19.6 Plugin Loader

`PluginLoaderService` (`src/core/plugins/plugin-loader.service.ts`) is the NestJS provider that
discovers, loads, and runs plugins.

**Discovery & load.** On `onModuleInit` it scans the plugins directory (`plugins.dir`, default `<dataDir>/plugins` — the same tree the
registry and each plugin's `ctx.storage` live in, so code and persisted state stay together on one
volume; `PLUGINS_DIR` overrides it). The engine built-ins are not registered here: `EngineFactory`
registers them in its own `onModuleInit` through `registerBuiltInPlugin` (see §19.7). For each
sub-directory with a `manifest.json` it reads the manifest, validates the required fields
(`id`/`name`/`version`/`type`/`main`), and records an `INSTALLED` plugin plus a persisted registry
entry — **without running any plugin code**. Persisted config and per-session activation/config are
read back so an operator's choices survive a restart. There are two version gates. The manifest
validator refuses a plugin whose `minOpenWAVersion` is newer than the running OpenWA (at boot the
plugin is skipped and logged as `plugin_load_failed`, it does not appear in `GET /plugins`, and
its config is kept so it loads again after a host upgrade), and `validateIngressManifest`
refuses a manifest declaring `ingress` whose `sdkVersion` major is not the supported Integration SDK
major (`1`).

> Loading a plugin from disk never runs it: a load always yields `INSTALLED`. Enabling is a separate
> step that runs the lifecycle, and happens either on an explicit ADMIN action or — for a plugin the
> operator had already enabled — at bootstrap (see **Restore on boot** below).

**Restore on boot.** `status` describes where the runtime is, so it cannot carry the operator's
decision across a restart; the decision is persisted separately as `enabledByOperator`. On
`onApplicationBootstrap` — after the rest of the app is wired — the loader re-enables every non-built-in
plugin carrying that flag, so an upgrade, host reboot or container restart no longer silently switches
off every extension ([#856](https://github.com/rmyndharis/OpenWA/issues/856)). Restoring is best-effort
and sequential: a plugin that fails is logged (`plugin_restore_failed`), left in `ERROR`, and never
holds up startup. Built-ins are skipped — `EngineFactory` enables the engine named by `engine.type`.

> The flag is written **only** by the operator-facing enable/disable, never by the loader.
> `onModuleDestroy` disables every running plugin during a graceful shutdown, so a loader-side write
> would erase the decision on the way out.

**Enable.** `enablePlugin(id)` runs the lifecycle by trust tier (a synchronous lock prevents a racing
double-enable, and engines must match the configured active engine):

- **Built-in (trusted)** → `enableInProcess`: `require()` the `main` module (path-contained to the
  plugin dir), instantiate the default-exported class, and run `onLoad` then `onEnable` in-process with
  the live capability context.
- **User-installed (disk-loaded)** → `enableSandboxed`: spawn a `worker_thread`, load the module there, and
  drive `onLoad`/`onEnable` over the channel. Capability calls and hook dispatches round-trip to the
  host, which runs the **same** permission + session-scope checks. Lifecycle calls are bounded by a
  30 s timeout and hooks by a 5 s timeout; a failure tears the worker back down. See
  [30 — Plugin Sandboxing](./30-plugin-sandboxing.md).

**Disable / unload / uninstall.** `disablePlugin` runs `onDisable` (force-terminating the worker for a
sandboxed plugin, even if `onDisable` hangs or throws) and unregisters the plugin's hooks. `onModuleDestroy`
disables every enabled plugin on graceful shutdown so stateful plugins can flush. Running plugins are
disabled first; then it waits for enables already in flight (a sandboxed enable is three 30 s-bounded
calls) and disables those plugins too. New enables are refused once teardown starts. `uninstallPlugin`
disables + unloads, drops the registry entry, and deletes the plugin's directory and its `ctx.storage`
data dir (built-ins are protected and cannot be uninstalled). The unload path dispatches `onUnload`:
for a sandboxed plugin it runs in the worker between `onDisable` and terminate (a plain disable does
NOT fire `onUnload` — disable is reversible and its cleanup hook is `onDisable`).

**Context.** `createPluginContext` builds the `PluginContext` (§19.4): a per-plugin logger,
`registerHook` (wrapped with the per-session activation gate), `registerWebhook`, the live
`config` getter, and the permission-checked `messages` / `engine` / `net` / `storage` / `conversations` /
`handover` / `mappings` capabilities. The capability methods call `assertPermission` before doing any
work, and — for everything but `net` and `storage`, which are not keyed to a session —
`assertSessionActive` → `assertSessionAllowed` on the session they act on, so a
missing grant or out-of-scope session fails with a `PluginCapabilityError`.

> ⚠️ **`ctx.storage` is plugin-scoped, not per-session — unlike `ctx.config`.** `ctx.config` is merged
> automatically for the firing session, but `ctx.storage` is a single namespace shared across **all** of a
> plugin's sessions. A multi-session plugin that keys state by a fixed string (mirroring the per-session
> config model) will have one session overwrite another's. Prefix storage keys with the session id (e.g.
> `ctx.storage.set(\`${sessionId}:lastSeen\`, …)`) whenever state must be isolated per session.

## 19.7 Built-in Plugins

The only plugins **shipped** as built-ins are the two WhatsApp **engine adapters**, registered
programmatically (not loaded from disk) by `EngineFactory` via `registerBuiltInPlugin`:

| Plugin id         | Type     | Notes                                  |
| ----------------- | -------- | -------------------------------------- |
| `whatsapp-web.js` | `engine` | Default engine adapter (browser-based) |
| `baileys`         | `engine` | WebSocket engine adapter (no browser)  |

Engines are mutually exclusive: the active one is pinned by `engine.type` config, and `enablePlugin`
rejects any engine that is not the configured active one. Built-ins run **in-process** (trusted) — they
are not sandboxed. There is no `auto-reply` / `translation` plugin bundled in the source tree today.

### Example: a hook-based message plugin

A disk-installed extension implements `IPlugin`, registers hooks in `onLoad`, and uses the capability
facade. This auto-reply sketch needs `messages:send` and `storage:use` in its manifest `permissions` —
the latter because it records a counter through `ctx.storage`:

```typescript
// plugins/auto-reply/index.ts
import type { IPlugin, PluginContext } from '@openwa/plugin-sdk'; // shape only; implement IPlugin

interface AutoReplyConfig {
  enabled?: boolean;
  rules?: { match: string; reply: string }[];
}

export default class AutoReplyPlugin implements IPlugin {
  async onLoad(ctx: PluginContext): Promise<void> {
    ctx.registerHook('message:received', async hookCtx => {
      const cfg = ctx.config as AutoReplyConfig; // per-session-merged config for this event
      const { sessionId, data } = hookCtx;
      const message = data as { from: string; body?: string };
      if (cfg.enabled === false || !sessionId || !message.body) return { continue: true };

      const text = message.body.toLowerCase();
      const rule = (cfg.rules ?? []).find(r => text.includes(r.match.toLowerCase()));
      if (rule) {
        await ctx.messages.sendText(sessionId, message.from, rule.reply);
        await ctx.storage.set(`stats:replies:${Date.now()}`, rule.match);
      }
      return { continue: true }; // keep the chain going (still delivers the webhook)
    });

    ctx.logger.log('Auto-reply plugin loaded');
  }
}
```

A plugin that calls an external API instead would declare `net:fetch` plus the host in `net.allow`, and
use `await ctx.net.fetch('https://api.example.com/...', { method: 'POST', body, headers })` — the
SSRF-guarded outbound HTTP capability. A read-only plugin (e.g. enriching events with group/contact
data) would declare `engine:read` and call `ctx.engine.getGroupInfo(...)` / `ctx.engine.getContacts(...)`.

## 19.8 Plugin Management API

`PluginsController` (`src/modules/plugins/plugins.controller.ts`) is mounted at `plugins` and **every
route requires the `ADMIN` role** (`@RequireRole(ApiKeyRole.ADMIN)` — not a bare API-key guard). There
is **no** `POST :id/reload` and **no** `GET :id/config`. Install is a multipart `.zip` upload (or by
URL / catalog), not an npm/github source descriptor.

> **Installed plugins are trusted code.** The worker sandbox (doc 30) is crash and heap-OOM
> _containment_, not a security boundary: plugin code runs inside the gateway's OS process and can
> reach Node built-ins (`fs`, `net`, `child_process`) directly — the capability permission model
> gates only the `ctx.*` verbs, not raw Node access. The SSRF guard and digest pin on
> `install-url` protect the _delivery_ of the package, not what the package does once loaded.
> Install only plugins you trust, and keep the OS-level containment from doc 30 (container,
> read-only rootfs, dropped capabilities) in place when you do.

| Method & path                        | Purpose                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET /plugins`                       | List all plugins                                                                                           |
| `GET /plugins/catalog`               | List the remote plugin catalog, annotated with install state                                               |
| `GET /plugins/:id`                   | Get a single plugin                                                                                        |
| `POST /plugins/install`              | Install from an uploaded `.zip` (`multipart/form-data`, field `file`, ≤ 5 MB)                              |
| `POST /plugins/install-url`          | Install by downloading a `.zip` from an https URL (SSRF-guarded; `#sha256=` pin required in production)    |
| `POST /plugins/:id/update`           | Update an installed plugin in place from a URL (staged swap, crash-safe; preserves config + enabled state) |
| `POST /plugins/:id/enable`           | Enable a plugin                                                                                            |
| `POST /plugins/:id/disable`          | Disable a plugin                                                                                           |
| `PUT /plugins/:id/config`            | Update the plugin's base config                                                                            |
| `PUT /plugins/:id/config/:sessionId` | Set (or clear, when empty) a per-session config override                                                   |
| `PUT /plugins/:id/sessions`          | Set which sessions a session-scoped plugin is activated for (`['*']` = all)                                |
| `GET /plugins/:id/config-ui`         | Serve the plugin's sandboxed config-UI HTML (for an iframe `srcdoc`)                                       |
| `GET /plugins/:id/health`            | Run the plugin's `healthCheck`                                                                             |
| `DELETE /plugins/:id`                | Uninstall a plugin (removes its files; built-ins are protected)                                            |

> `GET /plugins/:id/config-ui` returns untrusted HTML served with `Content-Security-Policy: sandbox`
> and `X-Content-Type-Options: nosniff`. The dashboard fetches it **with** the API key and injects the
> body as an iframe `srcdoc` (opaque origin), applying the current document's CSP nonce to inline scripts;
> the editor exchanges config over a `postMessage` bridge, so the API key never reaches the iframe. If
> the bridge does not initialize within 5 s, the dashboard shows an error; the generated `configSchema`
> form is not rendered as a fallback.

## 19.9 Plugin Security

### Permission model

There are exactly **seven** capability permissions, declared in the manifest `permissions` array — five
enforced at the capability boundary, plus two on the worker-declaration bridges: `webhook:ingress` at
load and at route subscription, and `search:provide` when the provider declaration reaches the host:

```typescript
// src/core/plugins/plugin.interfaces.ts (doc comments condensed)

export const PluginCapabilityPermission = {
  /** ctx.messages.* — send / reply on a session. */
  MESSAGES_SEND: 'messages:send',
  /** ctx.engine.* — read-only engine queries (group info, contacts, chats, history, number check). */
  ENGINE_READ: 'engine:read',
  /** ctx.net.fetch — SSRF-guarded outbound HTTP, scoped to the manifest net.allow host list. */
  NET_FETCH: 'net:fetch',
  /** ctx.storage.* — per-plugin key/value persistence on the host disk (get / set / delete / list).
   *  A declaration boundary: the per-plugin directory, key check and quota already bound the access. */
  STORAGE_USE: 'storage:use',
  /** ctx.registerWebhook — claim an inbound ingress route declared in the manifest. */
  WEBHOOK_INGRESS: 'webhook:ingress',
  /** ctx.conversations.send plus ctx.handover.* and ctx.mappings.* — the normalized outbound surface. */
  CONVERSATION_SEND: 'conversation:send',
  /** ctx.registerSearchProvider — serve /api/search. Under SEARCH_PROVIDER=auto the provider is also
   *  made ACTIVE, so an undeclared plugin would see every query the gateway serves. */
  SEARCH_PROVIDE: 'search:provide',
} as const;
```

There is no `PermissionChecker` class and no `PermissionDeniedError`. Enforcement of the five
capability-facade permissions lives in the loader: each capability method calls
`assertPermission(manifest, permission)` before doing any work, and a plugin whose manifest does not
declare the matching permission (or declares none) is rejected with a `PluginCapabilityError`:

```typescript
// src/core/plugins/plugin-loader.service.ts (paraphrased)

private assertPermission(manifest: PluginManifest, permission: PluginCapabilityPermission): void {
  if (!(manifest.permissions ?? []).includes(permission)) {
    throw new PluginCapabilityError(
      `Plugin ${manifest.id} is missing the '${permission}' permission required for this capability. ` +
        `Add "${permission}" to the "permissions" array in the plugin's manifest.json, then reload the plugin.`,
    );
  }
}
```

`webhook:ingress` is the exception — nothing passes it to `assertPermission`. It is enforced earlier, in
two places: at **load**, `validateIngressManifest` throws when a manifest declares `ingress` routes without
the permission, so the plugin never loads; and at the **ingress-subscribe guard**, a route claim from a
worker whose manifest lacks the permission is silently dropped (no `PluginCapabilityError`) and the plugin
simply owns no routes.

`search:provide` is enforced the same way, and for the same reason: a worker declares itself a search
provider by sending `search-provider-register` over IPC, which never passes through the capability router
that gates `ctx.messages` / `ctx.net` / `ctx.engine`. `registerPluginSearchProvider` checks the manifest
before the provider reaches the registry. Unlike the ingress guard this one **warns**
(`sandbox_search_provider_denied`) rather than dropping silently: there is no manifest `search` array, so
no load-time validation can catch it, and an operator would otherwise have no signal at all. The warning
is bounded to one line per enable — `WorkerSearchRegistry` posts the declaration only on the plugin's
first `ctx.registerSearchProvider` call.

Two further checks apply on top of the permission:

- **Session scope.** Every capability but `net` and `storage` is session-scoped through `assertSessionActive`, which
  requires **both** that the manifest `sessions` list admits the session (`assertSessionAllowed`; `['*']` =
  all) and that the operator has activated the plugin for it. Most verbs run it up front, on the
  `sessionId` the plugin passed; `ctx.mappings.getByProvider` takes no `sessionId`, so it runs the check
  after the lookup, on the `sessionId` of the row it found (and returns `null` when there is none) — either
  way an out-of-scope session is never reachable. The `sessionId` comes from the plugin, so this is the
  security boundary; the manifest half is static (editing config can't widen it).
- **Network allowlist.** `ctx.net.fetch` additionally requires the target host to be on the plugin's
  **effective** allowlist: `manifest.net.allow` plus the https origin of every `net.allowConfigHosts` config key
  that resolves to an https URL, taken across the base config **and** every per-session override. A host
  admitted only through `allowConfigHosts` is therefore allowed while absent from `net.allow`. The request
  always passes through the SSRF guard (which blocks internal IPs even for an allowlisted host).

### Sandboxed execution

User-installed plugins (anything loaded from the plugins directory) run in a Node `worker_thread`; there is
**no `vm2`**. First-party built-ins (the engine adapters) run in-process. The loader routes by trust
tier automatically. Key properties:

- Each worker has a heap cap (`maxOldGenerationSizeMb`, default **256 MB**) — an OOM terminates the
  worker, not the host.
- A sandboxed hook handler has a **5 s** time budget (`SANDBOX_HOOK_TIMEOUT_MS`); on timeout the host
  resolves `{ continue: true }` (fail-open), so each sandboxed subscriber delays the hook chain by at most
  5 s per event. The same fail-open value drains in-flight hooks if the worker crashes. The timeout is
  logged at most once per event per minute and shows as the last hook error in plugin health.
- After a hook, webhook or search dispatch times out, the host pings the worker. A worker whose event
  loop is blocked (a synchronous loop) cannot answer within 5 s, so it is terminated and the plugin is
  set to `ERROR`, as on a crash; a slow async handler answers and is left running.
- Lifecycle methods (`load`/`onLoad`/`onEnable`/`onDisable`) and `healthCheck` are bounded by a **30 s**
  / **5 s** timeout respectively, so a wedged plugin can't hang an ADMIN enable/disable or the health endpoint.
- The worker gets a **minimal allowlisted env** (`NODE_ENV`, `NODE_EXTRA_CA_CERTS`, `TZ`) — host secrets
  (master key, DB/Redis vars, …) are left out of the worker's `process.env`. That is hygiene, not a
  boundary: the worker can still read the process environment through `fs`.

This is V8-context isolation in the same OS process, not an OS-level sandbox: a worker can still reach
Node built-ins (`fs`, `process`, sockets), so it is fault containment and installing a plugin is full
host trust. The bundled `docker-compose.yml` (not the image) adds read-only rootfs and `cap_drop: ALL`,
which limit what the process can do to the host but not what a plugin inside it can reach. See
[30 — Plugin Sandboxing](./30-plugin-sandboxing.md) for the full security model and author rules.

---

<div align="center">

[← 18 - SDK Design](./18-sdk-design.md) · [Documentation Index](./README.md) · [Next: 20 - Community Guidelines →](./20-community-guidelines.md)

</div>

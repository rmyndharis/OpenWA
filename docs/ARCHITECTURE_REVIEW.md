# OpenWA — Architecture Review

> Senior engineering review of the OpenWA WhatsApp API Gateway.
> Date: 2026-05-31 · Branch: `fix/typeorm1-better-sqlite3` · Scope: `src/` (122 TS files, ~2.5k LOC in hot paths).
> All findings cite `file:line`. Line numbers verified against the working tree at review time.

---

## 1. Architecture — Clean Map

**Stack:** NestJS 11 modular monolith. One Puppeteer-driven `whatsapp-web.js` client per session. TypeORM **dual datasource**: `main` (auth + audit, SQLite) and `data` (sessions / messages / webhooks; SQLite default, PostgreSQL optional). BullMQ + Redis optional for webhook delivery. Socket.io for realtime. Plugin + hook subsystem for extensibility.

### Module layout

```
src/
  main.ts                  bootstrap: helmet, CORS, ValidationPipe, Swagger
  app.module.ts            dual TypeOrmModule.forRootAsync ('main' + 'data')
  config/configuration.ts  ConfigService tree
  database/                data-source.ts (CLI/migrations) + migrations/
  engine/                  engine.factory, adapters/whatsapp-web-js.adapter.ts, interfaces
  core/
    plugins/               plugin-loader, plugin-storage, interfaces
    hooks/                 hook-manager (in-memory registry)
  common/                  cache (Redis), storage (FS/S3), security middleware,
                           filters, interceptors, transformers, logger, shutdown
  modules/
    session/  message/  webhook/  events/  auth/  queue/
    contact/  group/  label/  channel/  catalog/  status/
    stats/  audit/  health/  settings/  infra/  docker/  plugins/
```

### Data flow — outgoing (API → WhatsApp)

```
POST /sessions/:id/messages/send-text
 → MessageController → MessageService.sendText           message.service.ts:25
 → hook 'message:sending' → saveOutgoingMessage(PENDING) message.service.ts:43
 → engine.sendTextMessage → adapter → client.sendMessage adapter:355
 → DB update status=SENT → hook 'message:sent'           message.service.ts:53
 → MessageResponseDto
```

### Data flow — incoming (WhatsApp → out)

```
whatsapp-web.js 'message' event
 → adapter.buildIncomingMessage                          adapter:254
 → callbacks.onMessage → SessionService callback         session.service.ts:293
 → hook 'message:received'
 → webhookService.dispatch  (fire-and-forget)            session.service.ts:310
 → eventsGateway.emitMessage                             session.service.ts:312
```

### Session lifecycle

```
POST /sessions/:id/start
 → SessionService.start → EngineFactory.create
 → pluginLoader.getPlugin → WhatsAppWebJsPlugin.createEngine
 → new WhatsAppWebJsAdapter (Puppeteer + LocalAuth)
 → live client stored in IN-PROCESS Map  engines          session.service.ts:32
 → reconnect timers stored in Map  reconnectStates         session.service.ts:35
```

**Verdict:** Layering is fundamentally sound — thin controllers, validated DTOs, global guards, a clean plugin/hook seam, parameterized queries throughout. The problems below are **concentrated**, not systemic. This is a fixable codebase, not a rewrite.

---

## 2. Critical Areas

| # | Area | Evidence | Severity |
|---|------|----------|----------|
| C1 | **Plugin loads arbitrary code, no sandbox** | `plugin-loader.service.ts:140` — `require(mainPath)` where `mainPath = join(dir, pluginId, plugin.manifest.main)` | **Critical** |
| C2 | **Docker socket hardcoded** | `docker.service.ts:74` — `new Docker({ socketPath: '/var/run/docker.sock' })` | **Critical** |
| C3 | **In-memory session/engine/hook state** | `session.service.ts:32,35`; `hook-manager.service.ts:7` | **High** |
| C4 | **Fire-and-forget dispatch loses errors** | `session.service.ts:310,312,326,336` — `void this.webhookService.dispatch(...)` | **High** |
| C5 | **SQLite default for `data` DB** | `app.module.ts` runtime factory; `data-source.ts:11` better-sqlite3 | **High** |
| C6 | **Secrets plaintext on disk** | `.env.generated` written by bootstrap, perms not enforced | **High** |
| C7 | **Unbounded webhook fan-out per message** | `webhook.service.ts:196` — `find()` no limit; no backoff jitter | High |
| C8 | **Infra import path not validated** | `infra.controller.ts` import-data file path | High |
| C9 | **Missing indexes** | `messages.status/type/direction`; `webhooks.sessionId/active` | Medium |
| C10 | **Stats use SQLite `strftime`** | `stats.service.ts:260` — breaks on PostgreSQL (the prod DB) | Medium |

### Detail

**C1 — Plugin RCE / path traversal.** `manifest.main` comes from a JSON file on disk and is passed straight to `require()`. A manifest with `"main": "../../../etc/something.js"` (or any attacker-writable path) executes arbitrary code with full app privileges — DB, network, Docker socket. No path containment check, no signature, no isolation.

**C2 — Docker socket = host root.** Hardcoded socket path, no config gate, no read-only enforcement. If the container mounts the socket, the app effectively has root on the host. Used by `docker.service.ts` for infra orchestration.

**C3 — In-memory state kills horizontal scale.** Live engines (`engines` Map), reconnect timers (`reconnectStates` Map), and the entire hook registry (`hooks` Map) live in process memory. Two app instances behind a load balancer: a request routed to the node that does *not* own the session fails with "session not started"; hooks registered on node A are invisible on node B.

**C4 — Silent delivery loss.** Incoming-message side effects are `void`-dispatched with no `.catch`. If the webhook queue or socket emit throws, the failure disappears — no retry, no log at the call site. (Contrast: outgoing `MessageService` path *does* await and handle errors.)

**C5 — SQLite single-writer.** Default `data` datasource is `better-sqlite3` — synchronous, whole-DB write lock. Fine for single-process dev; under multi-instance prod it serializes or corrupts. PostgreSQL is supported (`app.module.ts`, `data-source.ts:21`) and should be mandatory for any scaled deployment.

**C6 — Plaintext secrets.** Generated DB / Redis / S3 credentials land in `.env.generated` with no enforced `0600`. Recommend chmod on write + documented external-vault path.

---

## 3. Code-Quality Findings

### Duplication

- **`MessageService` send methods** — ~10 near-identical methods (`sendText`, `sendImage`, `sendVideo`, `sendAudio`, `sendDocument`, `sendLocation`, `sendContact`, `sendSticker`, `reply`, `forward`) all repeat the same shape: `getEngine → saveOutgoingMessage(PENDING) → try { send; update SENT; hook } catch { update FAILED; hook; throw }`. ~250 lines collapse to ~80 with one `dispatchSend()` helper. Verified `message.service.ts:25–406`.
- **Retry / backoff implemented 3×** — webhook queue backoff config, `deliverWebhook` recursive direct-mode retry (`webhook.service.ts`), and `scheduleReconnect` exponential backoff (`session.service.ts:381`). No shared utility.

### God class

- **`WhatsAppWebJsAdapter`** — 1006 lines, one file: client init + event wiring + 10 send ops + group management + labels + channels + reactions + contact block/unblock + status/catalog stubs. Should split by concern (message / group / contact / channel sub-adapters).

### Long method

- **`SessionService.initializeEngine`** — ~150 lines of inline callback definitions (`session.service.ts:220–375`). Engine cannot be tested in isolation; callbacks should be named handler methods.

### Coupling

- `SessionService` wires DB + hooks + webhooks + WebSocket directly inside its engine callbacks. No event-bus indirection — every consumer is hard-referenced.

### Other smells

- **Hook chain** (`hook-manager.service.ts:104`) — no per-handler timeout, exceptions swallowed (chain continues silently), strictly sequential. One hung plugin stalls every handler for that event.
- **WebSocket fan-out** (`events.gateway.ts:196`) — each event emitted to 4 overlapping wildcard rooms; clients subscribed to both exact and wildcard rooms receive duplicates.
- **Bulk send** (`bulk-message.service.ts`) — `results[]` accumulates unbounded; full-array JSON saved to DB every 10 messages. A 100k-message batch is pathological (huge payloads, many writes).
- **Media** (`adapter:267`) — `downloadMedia()` decodes full base64 into the message object, no size cap. Burst of large media = memory spike.
- **Reconnect state leak** (`session.service.ts:384`) — on max attempts the handler `return`s without `delete`-ing the Map entry. Dead state accumulates.
- **Config triplication** — DB config defined in `data-source.ts`, `configuration.ts`, and the `app.module.ts` async factory. Risk of drift. ~88 raw `process.env` reads, no boot-time schema validation.
- **Audit log growth** — stored in `main` SQLite forever; cleanup method exists (`audit.service.ts`) but is never scheduled.

### What's already good — do not touch

- API key: SHA-256 hash, 256-bit entropy, prefix-only display, never logged plaintext.
- Role hierarchy: VIEWER → OPERATOR → ADMIN, enforced in `api-key.guard.ts`.
- Usage tracking: fire-and-forget, throttled to 1/min, atomic `.increment()` — correct.
- Helmet: CSP + HSTS + noSniff. CORS: sensible default-allow with explicit-allowlist + credentials logic.
- Input: global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`), regex-checked DTOs.
- DB access: parameterized queries throughout — **no SQL injection vectors found.**

---

## 4. Refactor Strategy — Ranked, Functionality-Preserving

### Tier 1 — Security (do first; no public API change)

1. **C1** — Resolve `manifest.main`, assert it stays inside the plugin dir (`path.resolve` + prefix check); reject traversal. (Later: `worker_threads` / `vm` isolation.)
2. **C2** — Inject socket path via config; default disabled; document read-only mount.
3. **C8** — Normalize + whitelist import path under `./data/`.
4. **C6** — `chmod 0600` on `.env.generated` write; document vault option.

### Tier 2 — Correctness / scale

5. **C4** — Wrap fire-and-forget dispatches in a `safeDispatch` helper that `.catch`-logs (stops silent loss; stays async).
6. **C9 / C10** — Add `@Index` on `messages.status/type/direction` + `webhooks(sessionId, active)`; replace `strftime` with DB-portable grouping.
7. **C7** — Cap / paginate webhook fetch; add jitter to retry backoff (avoid thundering herd).

### Tier 3 — Maintainability (pure refactor, identical behavior)

8. **Extract `MessageService` send pipeline** — collapse 10 methods into one `dispatchSend()`. Biggest LOC win, zero API change. *(worked example below)*
9. Split `WhatsAppWebJsAdapter` into concern-scoped sub-adapters.
10. Move `initializeEngine` callbacks into named handler methods.
11. Single config source of truth; add zod/joi env validation at bootstrap.

### Tier 4 — True horizontal scale (design changes; schedule separately)

12. Socket.io Redis adapter + shared session-ownership registry + Redis-backed hook registry. **C3 / C5 are architectural** — flag and plan, do not rush.

---

## 5. Worked Example — Tier-3 #8 (highest-leverage safe refactor)

**Current shape, repeated ~10×:**

```ts
async sendImage(sessionId, dto) {
  const engine = this.getEngine(sessionId);
  const media = this.toMediaInput(dto);
  const message = await this.saveOutgoingMessage(sessionId, { chatId: dto.chatId, type: 'image', ... });
  try {
    const result = await engine.sendImageMessage(dto.chatId, media);
    await this.messageRepository.update(message.id, { externalId: result.id, status: MessageStatus.SENT });
    await this.hookManager.execute('message:sent', ...);
    return { messageId: result.id, timestamp: ... };
  } catch (e) {
    await this.messageRepository.update(message.id, { status: MessageStatus.FAILED, error: ... });
    await this.hookManager.execute('message:failed', ...);
    throw e;
  }
}
```

**Proposed single pipeline (behavior identical):**

```ts
private async dispatchSend(
  sessionId: string,
  meta: { chatId: string; type: MessageType; body?: string },
  send: (engine: IWhatsAppEngine) => Promise<{ id: string; timestamp?: number }>,
): Promise<MessageResponseDto> {
  const engine = this.getEngine(sessionId);
  const message = await this.saveOutgoingMessage(sessionId, meta);
  try {
    const result = await send(engine);
    await this.messageRepository.update(message.id, {
      externalId: result.id,
      status: MessageStatus.SENT,
    });
    await this.hookManager.execute('message:sent', { sessionId, messageId: result.id, ...meta });
    return { messageId: result.id, timestamp: result.timestamp ?? Date.now() };
  } catch (error) {
    await this.messageRepository.update(message.id, {
      status: MessageStatus.FAILED,
      error: error instanceof Error ? error.message : String(error),
    });
    await this.hookManager.execute('message:failed', { sessionId, messageId: message.id, ...meta });
    throw error;
  }
}

// Each public method shrinks to a declaration of intent:
async sendImage(sessionId: string, dto: SendMediaMessageDto) {
  const media = this.toMediaInput(dto);
  return this.dispatchSend(
    sessionId,
    { chatId: dto.chatId, type: MessageType.IMAGE },
    (engine) => engine.sendImageMessage(dto.chatId, media),
  );
}
```

`~250 lines → ~80`. Send-specifics stay in the thunk. `sendText` keeps its extra `message:sending` pre-hook by running it before the call to `dispatchSend`.

---

## Appendix — Verification Notes

Findings grounded by direct `grep`/read at review time:

- `message.service.ts` — 493 lines; `getEngine` + `saveOutgoingMessage` repeated across send methods (`:25–406`).
- `session.service.ts` — `engines` Map `:32`, `reconnectStates` Map `:35`; `void this.*dispatch/emit` at `:310,312,326,336`; reconnect `delete` only on cancel path `:440`, not on max-attempts `:384`.
- `plugin-loader.service.ts:140` — `require(mainPath)` from `manifest.main`.
- `docker.service.ts:74` — hardcoded `/var/run/docker.sock`.
- `data-source.ts` — `better-sqlite3` (`:11`) / `postgres` (`:21`), `synchronize:false` in both CLI configs (runtime `data` sync set in `app.module.ts`).
- `whatsapp-web-js.adapter.ts` — 1006 lines.

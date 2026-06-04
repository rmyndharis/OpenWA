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

- ✅ **`SessionService` fan-out coupling** — **resolved** via an internal event bus (`@nestjs/event-emitter`). The engine callbacks no longer reference `WebhookService` or `EventsGateway`; SessionService emits domain events (`session.events.ts`: `session.status`, `session.message.received/sent/ack`) and the consumers subscribe with `@OnEvent` (`EventsGateway`, `WebhookService`). The `message:received` hook pipeline stays in SessionService and gates the emit (it can mutate/halt the payload before fan-out), so ordering is preserved. DB persistence stays in SessionService by design. The former `forwardRef(WebhookModule)` coupling in `SessionModule` is gone. *(Hooks remain a direct dependency — they are an ordered, payload-mutating pipeline, not a fire-and-forget listener.)*

### Other smells

- ✅ **Hook chain** (`hook-manager.service.ts`) — **resolved** by the plugin-isolation work: each handler runs under `withTimeout` (`PLUGIN_HOOK_TIMEOUT_MS`), errors are logged (not swallowed), and a circuit breaker disables a repeatedly-failing plugin. Kept strictly sequential **by design** — the hook pipeline is synchronous and can mutate the payload in order.
- ✅ **WebSocket fan-out** (`events.gateway.ts:188`) — **fixed.** `emitToRooms()` now chains all four target rooms into a **single** `.emit()` so Socket.io delivers once; previously four separate emits duplicated to clients in both exact and wildcard rooms.
- ✅ **Bulk send** (`bulk-message.service.ts`) — **bounded.** `SendBulkMessageDto` enforces `@ArrayMaxSize(100)` per request, so `results[]` and the persisted row are capped at 100 entries; the pathological 100k-message batch cannot occur. (Periodic whole-row save is negligible at ≤100 messages.)
- ✅ **Media** (`whatsapp-web-js.adapter.ts:290`) — **capped.** Inline media over `MEDIA_MAX_BYTES` (default 64 MiB) keeps its metadata but drops the base64 payload, with a warning — prevents memory spikes on large-media bursts.
- ✅ **Reconnect state leak** (`session.service.ts:443`) — **fixed.** On max attempts `scheduleReconnect()` now calls `cancelReconnect(id)` to drop the Map entry; a fresh entry is re-created on the next manual start.
- ✅ **Config triplication** — **resolved.** DB connection params now have a single source of truth in `config/database.config.ts` (`readDataDbConfig()` / `readMainDbConfig()`), consumed by both `configuration.ts` (→ the `app.module.ts` TypeORM factories via `ConfigService`) and the migration CLI `database/data-source.ts`. The three places no longer parse `process.env` independently, so they can't drift; locked in by `database.config.spec.ts`. Context-specific knobs (entity scope, `synchronize` defaults, `migrationsRun`) intentionally stay with each caller, since the runtime and the migration CLI legitimately differ. Boot-time joi schema (`env.validation.ts`) remains the single validation gate. *(Drift fixed in passing: the Postgres database name now defaults to `openwa` everywhere instead of the SQLite path in the runtime config.)*
  - **Note (unchanged):** the runtime Postgres factory in `app.module.ts` still does not pass `ssl` — only the CLI DataSource honors `DATABASE_SSL`. Left as-is to preserve behavior; wiring runtime SSL is a separate, deployment-affecting change.
- ✅ **Audit log growth** (`audit.service.ts`) — **scheduled.** `AuditService` now runs `cleanup()` on a dependency-free unref'd interval (`AUDIT_CLEANUP_ENABLED` / `AUDIT_RETENTION_DAYS` / `AUDIT_CLEANUP_INTERVAL_HOURS`, defaults on / 30d / 24h).

### What's already good — do not touch

- API key: SHA-256 hash, 256-bit entropy, prefix-only display, never logged plaintext.
- Role hierarchy: VIEWER → OPERATOR → ADMIN, enforced in `api-key.guard.ts`.
- Usage tracking: fire-and-forget, throttled to 1/min, atomic `.increment()` — correct.
- Helmet: CSP + HSTS + noSniff. CORS: sensible default-allow with explicit-allowlist + credentials logic.
- Input: global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`), regex-checked DTOs.
- DB access: parameterized queries throughout — **no SQL injection vectors found.**

---

## 4. Refactor Strategy — Ranked, Functionality-Preserving

### Tier 1 — Security (do first; no public API change) ✅ done

All four hardened in commit `48ebf25` (plugin loading, docker socket, import paths, secrets file).

1. ✅ **C1** — Resolve `manifest.main`, assert it stays inside the plugin dir (`path.resolve` + prefix check); reject traversal.
   - **Plugin isolation follow-up (2026-06-03).** Trusted-author model: per-plugin timeouts + circuit breaker (blast radius) and a manifest `permissions` capability model (least privilege). `net`/`fs` permissions are audit-only — true sandboxing (`worker_threads`/`isolated-vm`) remains out of scope as it would break engine plugins (live Puppeteer sessions) and the synchronous in-process hook pipeline. See `docs/superpowers/specs/2026-06-03-plugin-sandbox-isolation-design.md`.
2. ✅ **C2** — Socket path injected via `DOCKER_SOCKET_PATH`; integration gated by `DOCKER_ENABLED` (`docker.service.ts:72`). `docker-compose.yml:75` mounts the socket read-only (`:ro`); both vars documented in `.env.example`. *(Default stays enabled for backward compat — disable explicitly where untrusted.)*
3. ✅ **C8** — `resolveWithinDataDir()` normalizes the import path and asserts it stays under `./data/` (prefix check), rejecting traversal (`infra.controller.ts:751`).
4. ✅ **C6** — `.env.generated` written with `mode: 0o600` + `fs.chmodSync` to enforce regardless of umask (`infra.controller.ts:318`); external-vault option documented in `.env.example`.

### Tier 2 — Correctness / scale ✅ done

Delivered in commit `95f8f06` (correctness + scalability hardening).

5. ✅ **C4** — `safeDispatch()` / `safeEmit()` helpers wrap the fire-and-forget incoming-message side effects with `.catch`-logging (`session.service.ts:56`); the bare `void` webhook dispatches now report failures instead of swallowing them.
6. ✅ **C9 / C10** — `@Index` on `messages.status/type/direction` (`message.entity.ts:20`) and `@Index(['sessionId','active'])` on `webhooks` (`webhook.entity.ts:17`); stats grouping now DB-portable via `timeBucketExpr()` / `hourOfDayExpr()` — `to_char`/`EXTRACT` on Postgres, `strftime` on SQLite (`stats.service.ts:257`).
7. ✅ **C7** — `dispatch()` caps the fetch with `take: webhook.maxPerDispatch` (default 100, `WEBHOOK_MAX_PER_DISPATCH`) and warns when capped (`webhook.service.ts:199`); direct-delivery retries use exponential backoff **with full jitter** (`webhook.service.ts:407`).

### Tier 3 — Maintainability (pure refactor, identical behavior) ✅ done

8. ✅ **Extract `MessageService` send pipeline** — collapsed 10 methods into one `dispatchSend()` (commit `493c1dc`). *(worked example below)*
9. ✅ Split `WhatsAppWebJsAdapter` into concern-scoped sub-adapters under `adapters/whatsapp-web-js/`; added delegation smoke test (commit `6320647`).
10. ✅ Moved `initializeEngine` callbacks into named handler methods (commit `8cb57a2`).
11. ✅ Env validation at bootstrap via joi schema in `ConfigModule` (commit `fcecda6`). Note: full ConfigService consolidation of remaining direct `process.env` readers deferred — joi now coerces validated values back into `process.env`, so the schema is the single validation gate.

### Tier 4 — True horizontal scale (design changes) ✅ done

12. Horizontal scale, gated behind `CLUSTER_ENABLED` (default off → single-instance behavior unchanged). Delivered in four commits:

    - **C5 — SQLite rejected in cluster mode.** When `CLUSTER_ENABLED=true` the joi schema rejects `DATABASE_TYPE=sqlite` at bootstrap; a shared postgres/mysql store is mandatory. Adds the `cluster.{enabled,instanceId,ownershipTtl}` config block (`instanceId` defaults to hostname). *(env validation + config)*
    - **Socket.io Redis adapter.** `RedisIoAdapter` (ioredis pub/sub + `@socket.io/redis-adapter`), wired in bootstrap only when clustered, pings Redis to fail fast. Replaces the in-memory adapter so a broadcast on node A reaches clients on node B.
    - **C3 — session-ownership registry.** `SessionRegistry` records `session:owner:<id> = instanceId` in Redis with a half-TTL heartbeat (timer `unref`'d). `SessionService` claims on engine init, releases on stop/delete. `resolveEngine()` returns the local engine or throws `SessionOwnedElsewhereException` (409 naming the owner) instead of a misleading "not active". `MessageService` adopts it; other controllers can migrate the `getEngine` + generic-throw pattern incrementally.

    **Hard constraint (by design, not a gap):** a WhatsApp engine is a live Puppeteer/browser session bound to the process that started it — it **cannot** migrate. So this is *ownership routing* (stateless API nodes + sticky session ownership), not arbitrary request routing. Put a sticky-by-`sessionId` rule at the load balancer, or have clients honor the 409 owner hint.

    **Hooks stay in-process — intentionally.** Hook handlers are JS functions and cannot be serialized into a shared registry. Cross-node consistency comes from every node loading the **same** plugin set: `PLUGINS_DIR` must point at shared storage (network volume / shared mount) when clustered. The plugin loader logs a warning if `CLUSTER_ENABLED` is on, as a deployment reminder.

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

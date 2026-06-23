# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Plugins: a new `ctx.net.fetch` capability lets a sandboxed plugin make outbound HTTP through the host's SSRF guard (resolve-once-pin, redirects refused), gated by a `net:fetch` permission plus a manifest `net.allow` host allowlist (`host:port`, bare `host`, or `*` for any public host; internal IPs are always blocked). Responses are bounded by a timeout and a size cap. (#437)

## [0.6.2] - 2026-06-23

Plugin platform follow-ups (sandbox hardening, install-from-URL + catalog), a mark-chat-unread
endpoint, and a batch of correctness/housekeeping fixes.

### Added

- **Install plugins from a URL / catalog.** `POST /plugins/install-url` downloads a plugin `.zip` from an HTTP(S) URL through the SSRF guard (host validated, connection pinned, redirects refused, size-capped) and runs the exact same validate-write-load pipeline as an uploaded package. `GET /plugins/catalog` fetches a configured remote catalog (`PLUGIN_CATALOG_URL`, default the OpenWA-plugins `plugins.json`) and annotates each entry with `installed` / `installedVersion` / `updateAvailable`. The dashboard install modal gains a **Catalog** tab to browse and one-click install. Add a non-public catalog/release host to `SSRF_ALLOWED_HOSTS`. (#433)
- **Update a plugin in place.** `POST /plugins/:id/update` downloads the new package (same SSRF-guarded path) and swaps it in while **preserving operator config and the enabled state** — it unloads the running plugin (keeping its registry entry, so config survives), writes the new files, reloads, and re-enables if it was enabled. The package id must match; the old version is backed up and restored if the update fails. The dashboard Catalog tab shows an **Update** button when a newer version is available. (#433)
- Mark a chat as unread: `POST /sessions/:id/chats/unread` (and `sessionApi.markChatUnread` on the dashboard client), the inverse of mark-as-read, supported on both the whatsapp-web.js and Baileys engines. (#432)

### Security

- Untrusted (uploaded) plugins now run with a minimal, allowlisted worker environment instead of inheriting the host process environment, so a plugin can no longer read host secrets (database/Redis credentials, the API master key and pepper, `DOCKER_HOST`) out of `process.env`. (#431)

### Fixed

- Webhook delivery no longer POSTs an empty (`undefined`) body when a `webhook:before` plugin hook returns a result without a `payload` key — it now falls back to the original payload. (#434)
- The `session.qr` WebSocket event is now actually emitted from the QR callback, so the dashboard can render the QR live instead of only polling `GET /qr`. (#434)
- Storage usage now reports real S3 object sizes instead of a 100KB-per-file estimate, and local file writes no longer block the event loop during an import. (#434)
- A sandboxed plugin whose `load`/`onEnable`/`onDisable` hangs no longer blocks the enable/disable request (and the request behind it) indefinitely — plugin lifecycle calls are now time-bounded, and a disable always tears the worker down even if `onDisable` fails, so a misbehaving plugin can't leak its worker thread. (#431)
- Sandboxed plugins now receive `onConfigChange` (config updates reach the worker instead of being silently ignored until disable + re-enable) and have their real `healthCheck` run — `GET /plugins/:id/health` previously always returned the default "healthy" for sandboxed plugins. (#430)
- Plugin `onDisable` now runs on graceful shutdown (`OnModuleDestroy`), so stateful plugins can flush buffers / close connections / persist state instead of losing in-flight work on every restart or deploy. (#430)
- A concurrent enable of the same plugin no longer double-runs `onEnable` or double-registers its hooks (a synchronous in-progress lock rejects the racing call). (#430)
- Plugin storage writes — `ctx.storage.set()` and the plugin registry — are now atomic (write to a temp file then rename), so a crash mid-write can't leave a truncated file that silently degrades to lost state. (#430)

### Changed

- The plugin-management UI strings (install/uninstall, the status rail, and the install modal) are now translated into every locale instead of falling back to English. (#429)

## [0.6.1] - 2026-06-22

A patch closing a plugin-hook gap.

### Fixed

- The `message:ack` hook event was declared in the `HookEvent` union but never emitted, so a plugin registered for it (e.g. a delivery-status logger) silently never fired. It now fires for every delivery/read receipt with `{ messageId, status, ack }` (`source: 'Engine'`, scoped to the session), consistent with `message:received`/`message:sent`. Delivery failures surface as `message:ack` with `status: 'failed'`; the send-time `message:failed` hook is unchanged.

## [0.6.0] - 2026-06-22

The **plugin platform** release: untrusted plugins now run sandboxed, and you can install and uninstall them from the dashboard. One breaking change for plugin authors (the sandbox context), so this is a minor bump.

### Added

- **Install and uninstall plugins from the dashboard.** Upload a plugin packaged as a `.zip` (`POST /api/plugins/install`) and remove it (`DELETE /api/plugins/:id`). The Plugins page is redesigned into a status rail — the active engine + library version, enabled/installed counts, and the live list of active plugins — alongside a catalog with an Install button and a per-plugin Uninstall. Uploaded packages are validated (manifest, safe id, zip-slip + size guards), only `extension` plugins are installable (engines and other tiers stay built-in), and built-ins cannot be uninstalled.

### Changed

- ⚠️ **Breaking (plugin authors):** plugins loaded from the `plugins/` directory now run sandboxed in an isolated worker thread instead of in-process. Their context is curated to `messages`, `engine`, `storage`, `logger`, `config`, `pluginId`, and `registerHook`, with capability calls permission-checked on the host — a sandboxed plugin can no longer reach the host `hookManager` directly or share host objects. Bundled/built-in plugins (engines, auto-reply, translation) are unaffected and still run in-process. See `docs/23-plugin-sandboxing.md` for the trust model and the boundary's limits.
- Engines are now single-active: enabling an engine other than the configured `engine.type` is rejected (switch engines in settings, then restart). The dashboard shows the active engine as **Active** and the others as **Available**, fixing the state where two engines could appear active at once.
- Calmer plugin cards — the loud gradient, type-colored card headers are replaced with clean cards and a subtle type-tinted icon.

### Fixed

- Plugins page: the "Active" state and the Enable/Activate actions were all the same green and hard to tell apart. Actions are now a solid green button and the current state a neutral chip. (#417)
- The dashboard reports each plugin's real built-in status (previously only the WhatsApp Web.js engine was flagged built-in).
- The appearance/theme popover no longer spills outside the sidebar onto the page. (#424)

## [0.5.1] - 2026-06-22

A small correctness & consistency patch — **no breaking changes**. Session engine callbacks no longer
mutate a session after it has been stopped or its engine replaced; bulk-message variables now use the
same `{{name}}` syntax as message templates (single-brace `{name}` deprecated but still honored); and
a plugin's declared capability permissions are now actually enforced at the capability boundary.

### Changed

- **Plugin capability permissions are now enforced.** A plugin may use a capability — `ctx.messages.*`
  (send/reply) or `ctx.engine.*` (read-only group/contact/chat queries) — only if its manifest
  declares the matching permission (`messages:send` / `engine:read`); a plugin that doesn't declare
  it, or declares none, is denied with a clear `PluginCapabilityError`. Previously `manifest.permissions`
  was advisory and unenforced. The built-in extensions declare exactly what they use (auto-reply:
  `messages:send`; translation: `messages:send` + `engine:read`) and are unaffected; custom plugins
  must declare the permissions for the capabilities they call. (#412)
- **Bulk-message variable substitution now uses the same `{{name}}` syntax as message templates.**
  `POST /sessions/:id/messages/send-bulk` previously substituted `messages[].variables` with a
  single-brace `{name}` convention, inconsistent with the double-brace `{{name}}` used everywhere
  else in the gateway. Bulk content is now rendered by the shared template helper, so the canonical
  `{{name}}` placeholders work in bulk content. Existing single-brace `{name}` content keeps working
  unchanged. (#69, #411)

### Deprecated

- **Single-brace `{name}` placeholders in bulk-message content.** Prefer `{{name}}`; the legacy
  `{name}` form is still substituted for backward compatibility but may be removed in a future major
  version. (#69, #411)

### Fixed

- **A session is no longer mutated by callbacks from an engine it has already replaced or torn
  down.** Each engine's lifecycle/message callbacks (QR, ready, disconnect, state, ack, message,
  reaction, …) now no-op once that engine is no longer the live one for the session. This closes a
  race where a late callback from a stopped engine — or from a previous engine after a
  restart/reconnect — could write a stale status (e.g. flip a stopped session back to `ready`),
  schedule a reconnect for a session meant to be down, or persist a stray message/ack against the
  wrong engine generation. The guard is a no-op for the live engine and for ordinary network-drop
  reconnects. (#410)

## [0.5.0] - 2026-06-21

A security & reliability hardening release. **One behavior change** (the reason for the minor bump):
the contact / group / chat list endpoints now paginate with a default cap of 1000 items — opt into
`limit`/`offset`; accounts with fewer than 1000 items are unaffected. Everything else is hardening and
correctness: time-bounded SSRF DNS resolution, validated webhook custom headers (blocks CR/LF
injection), Swagger off by default in production, boot-time validation of numeric env vars and of a
SQLite data/main path collision, plugin reads gated to ADMIN, a session-scoped key no longer denied on
non-session routes, no resurrection of a session stopped mid-startup, a hardened dashboard config-save
path (browser-flag parsing + `0600` secret file), and cleaner fresh-install schema.

### Changed

- **The contact, group, and chat list endpoints are now paginated (default cap 1000).** ⚠️ Behavior
  change. `GET /sessions/:id/contacts`, `/groups`, and `/chats` previously serialized the operator's
  *entire* address book / group / chat set into one response — a heap/GC hazard for very large
  accounts. They now accept optional `limit` (clamped `[1, 1000]`) and `offset` query params, and
  default to returning at most **1000** items when no `limit` is given. Accounts under 1000 items are
  unaffected; larger accounts page with `offset`. Chats are returned **most-recent first**, so a
  capped response is the newest chats rather than an arbitrary slice. In-process callers (plugins
  using the engine directly) still receive the full set. (#401)
- **Fresh databases no longer create the unused `api_keys`/`audit_logs` tables on the data
  connection.** Those auth/audit tables belong solely to the separate "main" SQLite connection, but
  the data-connection baseline migration also created them (with a stale `keyPrefix` width), leaving
  dead, unused tables on the data database. New installs are now clean. Existing installs are
  unaffected — an already-applied migration is never re-run, so their harmless leftover tables remain
  and no destructive drop is performed. (#400)

### Fixed

- **Browser launch flags saved from the dashboard are now applied correctly.** The Infrastructure
  form persists the Puppeteer/Chromium arguments space-separated, but the engine config parser only
  split on commas — collapsing every flag into a single malformed argv token, so `--no-sandbox` (and
  any other flag) was silently never applied. In a hardened/containerized environment that can wedge
  session startup. The parser now accepts either delimiter, and an already-saved space-separated value
  is repaired on the next boot. (#397)
- **A session-restricted API key is no longer wrongly denied on non-session routes.** The guard
  derived the session for a key's `allowedSessions` scope from the `:id` route param, but `:id` is
  also the resource id on unrelated routes (e.g. `auth/api-keys/:id`, `plugins/:id`) — so a
  session-scoped key got a spurious `401` there. Session scoping is now applied only where `:id`
  actually denotes a session; enforcement on the real `sessions/:id/...` routes is unchanged. (#398)
- **Boot is now rejected when the SQLite `DATABASE_NAME` collides with the internal main database
  file.** The auth/audit ("main") and application ("data") connections must be separate SQLite files;
  pointing `DATABASE_NAME` at `./data/main.sqlite` ran two connections — each with its own migration
  ledger and synchronize policy — against one file, risking schema divergence and lock contention.
  Startup validation now fails fast with a clear message (paths are normalized, so relative spellings
  of the same file are caught). Postgres is unaffected (its `DATABASE_NAME` is a bare db name). (#399)
- **Numeric environment variables are validated at boot.** The rate-limit windows/limits, webhook
  timeout/retry settings, and the database pool size were parsed with an unbounded `parseInt`; a
  non-integer value (e.g. `RATE_LIMIT_SHORT_LIMIT=abc`) became `NaN` and silently disabled the
  corresponding limit. Startup now rejects a non-negative-integer violation with a clear message,
  consistent with the existing port validation. (#402)
- **The whatsapp-web.js engine now detects remote media URLs case-insensitively.** A media `data`
  string was treated as a URL only with a lowercase `http://`/`https://` prefix, so a mixed-case
  scheme (e.g. `HTTPS://…`) was mistaken for base64 instead of being fetched through the SSRF-guarded
  path — diverging from the Baileys engine. Both engines now use the same case-insensitive check. (#404)
- **A session stopped or deleted mid-startup is no longer resurrected to `READY`.** If `stop`/`delete`
  landed while `start()` was awaiting the engine's `initialize()`, the freshly-created engine was left
  registered and running. `start()` now re-checks the stopping flag after initialization and tears the
  engine down (mirroring the existing reconnect guard), so a concurrent stop/delete wins. (#405)

### Security

- **DNS resolution in the SSRF guard is now bounded by a deadline.** The guard resolved a hostname
  with an unbounded lookup, so a hanging or very slow resolver could pin a worker indefinitely. The
  lookup now races a deadline (default 10s, overridable via `SSRF_DNS_TIMEOUT_MS`) and fails closed
  with a clear error on expiry. Healthy resolvers are unaffected. (#404)
- **Custom webhook headers are now validated as a flat, control-character-free string map.** The
  `headers` field accepted any object shape with no per-value checks, so a value containing `CR`/`LF`
  could attempt header injection into the outbound webhook request, and non-string values silently
  broke delivery. Creation/update now reject invalid header names, non-string or control-character
  values, and over-large maps (max 50 entries, value max 1024 chars). The delivery-time reserved-name
  filter is unchanged. (#403)
- **Swagger UI (`/api/docs`) now defaults OFF in production.** The interactive API schema was served
  unauthenticated by default everywhere; it is reconnaissance surface. It remains on outside
  production and can be re-enabled in production with `ENABLE_SWAGGER=true` (and is still disabled
  anywhere with `ENABLE_SWAGGER=false`). The startup banner only advertises the docs URL when it is
  actually served. (#402)
- **Plugin inventory, detail, and health reads now require the ADMIN role.** `GET /plugins`,
  `GET /plugins/:id`, and `GET /plugins/:id/health` were readable by any authenticated key (including
  the read-only VIEWER role), exposing installed plugin versions, non-secret configuration, and
  health/error text. They now require ADMIN, matching the plugin write routes and the infrastructure
  endpoints. (Secret config values were — and remain — redacted regardless.) (#398)
- **The dashboard-generated env file is now written owner-only (`0600`).** Saving Infrastructure
  configuration wrote `data/.env.generated` — which can hold the database, S3, and Redis credentials —
  with default permissions (world-readable `0644`) until the next restart re-tightened it. It is now
  written `0600` at save time through the same owner-only helper used for the generated env at first
  boot, closing the exposure window on shared or bind-mounted hosts. (#397)

## [0.4.8] - 2026-06-21

A maintenance release — no breaking changes; everything is a fix or internal hardening.
**Reliability:** the configurable whatsapp-web.js first-boot timeout (`WWEBJS_AUTH_TIMEOUT_MS`) now
actually takes effect in Docker (it was never forwarded into the container) and is validated as a safe
integer; the dashboard now collapses duplicate connection-lost toasts during a reverse-proxy outage.
**Resource limits:** outbound base64 media is now size-capped (`413` when too large) on a par with the
remote-URL and inbound media caps, and bulk-send media payloads are validated as typed objects.
**Release & tooling:** a published GitHub Release now waits for the container image build, and the data
migration CLI is scoped to the data-owned tables. Note: bulk-send media validation is now stricter — a
bulk request carrying unknown or malformed fields inside a media object is now rejected with `400`.

### Changed

- **A published GitHub Release now waits for the container image build.** The release workflow's
  GitHub Release job now depends on the Docker image job, so a `v*` tag can no longer publish release
  notes without a matching multi-arch image on GHCR. A failed image build leaves the tag without a
  Release until the workflow is re-run. (#389)
- **The data migration CLI is scoped to the data-owned tables.** `data-source.ts` (used by
  `migration:generate` / `migration:run`) now lists only the data connection's entities
  (session/webhook/message/template/engine), mirroring the runtime data connection, instead of a
  broad glob that also pulled in the main-owned `api_keys`/`audit_logs` entities. Generating a data
  migration no longer emits spurious auth/audit DDL into the data database. No runtime or schema
  change for existing installs. (#391)

### Fixed

- **Dashboard collapses duplicate connection-lost toasts during a reverse-proxy outage.** When the
  backend is unreachable behind a reverse proxy that returns a non-JSON `502`/`503` page, the
  dashboard now folds the repeated request failures into a single connection-lost toast instead of
  stacking ordinary error toasts. The thrown error now always carries the HTTP status code (which the
  toast de-duplication matches on), rather than a status text that is empty over HTTP/2. (#388)
- **`WWEBJS_AUTH_TIMEOUT_MS` now takes effect in Docker, and is validated as a safe integer.** The
  configurable first-boot init timeout added in 0.4.7 was never forwarded into the container by Docker
  Compose, so setting it in `.env` had no effect on the recommended deployment path — the engine kept
  the 30000ms default. Both compose files now pass it through (unset still means the default). The
  value is also validated as a positive safe integer, so an accidental huge or overflowing value falls
  back to the default instead of making the engine's first-boot wait run effectively unbounded. (#393)
- **Outbound base64 media is now size-limited.** Sending media as a base64 string (single and bulk
  sends) was bounded only by the coarse whole-request `BODY_SIZE_LIMIT`, unlike remote-URL and inbound
  media which already enforce `MEDIA_DOWNLOAD_MAX_BYTES`. The decoded size of an outbound base64 blob
  is now checked against the same `MEDIA_DOWNLOAD_MAX_BYTES` cap (default 50 MiB) before it is sent or
  persisted; an oversized blob is rejected with `413 Payload Too Large` (the documented
  `MESSAGE_MEDIA_TOO_LARGE`). The bulk-send nested media payloads are now validated as typed objects,
  so unknown or malformed media fields are rejected rather than silently persisted — bulk requests
  carrying junk inside a media object will now get a `400`. (#394, #395)

## [0.4.7] - 2026-06-21

A webhooks, reliability, and dashboard release — no breaking changes; everything is additive or a
fix. **Webhooks** gain optional smart pre-dispatch filters: a trigger can carry AND-ed conditions
(sender/recipient/body/type/mentions/fromMe/hasMedia/isGroup) and fires only when they all match,
with engine-neutral `WaId` contact matching and a FilterBuilder UI — a webhook with no filters
behaves exactly as before. The whatsapp-web.js engine's first-boot init timeout is now configurable
(`WWEBJS_AUTH_TIMEOUT_MS`) for slow environments. **Fixed:** the dashboard no longer crashes on
PostgreSQL when a webhook exists (a JSON column type mismatch). **Dashboard:** a downed backend no
longer floods the screen with error toasts.

### Added

- **Smart webhook filters (optional, additive).** A webhook trigger can now carry an optional set of
  pre-dispatch conditions, evaluated per event before delivery: it fires only when **all** conditions
  match (AND). Conditions match on `sender` / `recipient` / `body` / `type` / `mentions` / `fromMe` /
  `hasMedia` / `isGroup` with `is` / `isNot` / `contains` / `equals` operators;
  message-only conditions are skipped for non-message events, so a `*`-subscribed webhook still fires on
  session events. A webhook with no filters behaves exactly as before. Contact-id conditions
  (`sender`/`recipient`/`mentions`) match by the engine-neutral `WaId` key, so a filter written as a
  plain number or in any dialect (`@c.us` / `@s.whatsapp.net` / `@lid`) matches the same person - and a
  lid-addressed sender (e.g. an unresolved `@lid` group participant) matches a phone filter once the
  persistent `lid -> phone` table knows the mapping. Configurable via the API (`filters` on create/update)
  and a new FilterBuilder UI on the dashboard's Webhooks page. (#379)

- **Configurable first-boot init timeout for the whatsapp-web.js engine (`WWEBJS_AUTH_TIMEOUT_MS`).**
  On slow first boots (e.g. WSL2 or low-resource containers) the engine's fixed 30s wait for WhatsApp
  Web to finish loading could expire before the QR code was generated, aborting startup. Set
  `WWEBJS_AUTH_TIMEOUT_MS` to a larger value in milliseconds (e.g. `120000`) to extend it; unset keeps
  the previous 30000ms default, so existing deployments are unchanged. (#353)

### Changed

- **Dashboard collapses connection-error spam into a single toast.** When the backend is unreachable
  (`failed to fetch`, network errors, HTTP 502/503), the dashboard now shows one translated "Server
  Connection Lost" toast that auto-dismisses, instead of stacking an error toast per failed request —
  de-duplicated on a stable key so translation can't break it. Original work by @quinton-8. (#293)

### Fixed

- **Dashboard no longer crashes ("Something went wrong") when a webhook exists on PostgreSQL.** JSON
  columns (`webhooks.events`/`headers`, `sessions.config`, `messages.metadata`, `message_batches.*`)
  were declared `jsonb` in their entities but created as `text` by the baseline migration, so on
  Postgres the driver returned them as raw JSON strings and the dashboard's `events.map()` threw an
  uncaught error. `jsonColumnType()` now resolves to `simple-json` on both dialects (parsed in JS on
  read) — no schema migration or data conversion, since the write format was already identical. This
  also corrects the same latent string-instead-of-object behavior for session reconnect config,
  message-reaction persistence, and bulk-send batches on Postgres. The dashboard additionally
  normalizes webhook `events` to an array at the query boundary as defense-in-depth. (#385)

## [0.4.6] - 2026-06-20

A reliability, correctness, and dashboard release. **Identity & engine:** Baileys gains a persistent,
cross-session `lid -> phone` table (shared resolution that survives restarts) plus a new `from` message
filter, and its contact/chat *listing* ids are now engine-neutral (`@c.us`). **Webhooks:** message
reactions now also fire as a `message.reaction` webhook (previously WebSocket-only). **Dashboard:**
selectable appearance palettes with light/dark/system mode, and a redesigned Templates workspace.
**Hardening:** the LibreTranslate client pins its outbound connection, and Baileys group-participant
operations address participants in the engine wire dialect. **Two consumer-visible notes:** Baileys
contact/chat-list ids flip `@s.whatsapp.net` -> `@c.us` (whatsapp-web.js already used `@c.us`), and
webhooks subscribed with `*` now also receive `message.reaction`.

### Added

- **Persistent, cross-session `lid -> phone` resolution + a `from` filter on message history.** A new
  `lid_mappings` table (on the `data` connection) records the `lid -> phone` mappings WhatsApp pushes us
  (history sync, contacts) so resolution is shared across sessions and survives restarts, instead of
  living only in one Baileys session's in-memory map. `GET /api/sessions/:sessionId/messages` now accepts
  a `from` query param that resolves through this table: filtering by a phone returns not just messages
  stored as `<phone>@c.us` but also those whose sender was an unresolved `<lid>@lid` that has since
  resolved to that phone - closing a gap where a phone-based filter silently missed the same person's
  lid-addressed (e.g. group) messages. The table is populated at runtime from the lid<->phone pairs the
  Baileys engine observes (inbound message `senderPn`/`participantPn`, the `chats.phoneNumberShare`
  event, contacts, and history sync), so it fills continuously without re-auth. Internally these ids are
  now carried by a typed `WaId` value object; it is in-memory only and serializes to the exact same
  neutral string, so **no webhook / WebSocket / REST response shape changes**. (#374)

- **Webhook parity for message reactions (`message.reaction`).** Reactions were broadcast over the
  WebSocket only; they are now also delivered as a `message.reaction` webhook with the same payload (the
  reaction plus the post-apply reactions snapshot) and are selectable in the dashboard event picker.
  Idempotency is salted per dispatch, so a re-reaction is a distinct delivery while retries dedupe.
  **Consumer-visible:** webhooks subscribed with `*` now also receive this event. (#380)

- **Dashboard appearance palettes + redesigned Templates workspace.** A new Appearance menu switches
  light / dark / system mode and selectable accent palettes (persisted and applied across the UI). The
  Templates page is redesigned into a searchable workspace with a saved-template library, editor, live
  preview, and placeholder inputs. (#361)

- **`BAILEYS_LOG_LEVEL`** (trace|debug|info|warn|error, silent by default) surfaces the Baileys library's
  own diagnostics; `trace` dumps the decoded WhatsApp wire frames to stdout (context "baileys-wire") for
  analysis. (#375)

### Fixed

- **Baileys engine: contacts, chats and recent history now sync on connect.** Baileys defaults
  `shouldSyncHistoryMessage` to `() => !!syncFullHistory`, so with `syncFullHistory` unset it silently
  disabled the **entire** initial sync - the address-book/app-state sync never ran, so no contacts, chat
  list, recent messages, or `lid -> phone` mappings ever arrived. The adapter now passes
  `shouldSyncHistoryMessage: () => true`, enabling the sync while keeping the full-archive download
  opt-in via `BAILEYS_SYNC_FULL_HISTORY` (WhatsApp sends the recent window + contact snapshot, not the
  entire message history). (#375)

- **Message history `chatId` filter now matches across dialects.** A chat addressed as `<phone>@c.us` (the
  neutral list id) now also returns messages stored under `<phone>@s.whatsapp.net` (e.g. an outbound send
  addressed by a raw engine id), so the conversation view is no longer empty when the stored and queried
  dialects differ - the same resolution the `from` filter uses. (#375)

- **Baileys engine: contact and chat *listing* ids are now engine-neutral (`@c.us`).** `getContacts` /
  `getChats` / `getContactById` previously returned the raw `<phone>@s.whatsapp.net` id (visible in the
  dashboard, and mismatched against the `@c.us` chatId stored on messages). They now emit the neutral
  `@c.us` dialect like the message payloads; the read-back paths (`sendSeen` / `deleteChat` / contact
  lookup) accept the neutral id and fold it back internally, so sending and marking-read still round-trip.
  **Consumer-visible:** Baileys contact/chat-list ids flip `@s.whatsapp.net` -> `@c.us` (whatsapp-web.js
  already used `@c.us`). (#374)

- **Hardened the LibreTranslate translation client against DNS rebinding.** The client validated the
  target host and then issued a separate request that re-resolved DNS at connect time. It now pins the
  connection to the pre-validated address (the same SSRF-safe path webhook and media delivery use) and
  refuses redirects, so the API key (sent in the request body) cannot be redirected to an internal target
  between the host check and the connection. (#377)

- **Baileys group-participant operations now address participants in the engine wire dialect.** Add /
  remove / promote / demote and group creation passed neutral `<phone>@c.us` participant ids straight to
  the wire, where they encode as an unknown server suffix instead of the `s.whatsapp.net` protocol token.
  They now fold to the engine dialect before the call (matching how 1:1 sends already round-trip); `@lid`
  and the `@g.us` group id are untouched, and the returned group info stays neutral `@c.us`. (#378)

- **Italian translation corrections.** Updated and corrected the Italian (`it`) dashboard locale. (#376)

## [0.4.5] - 2026-06-20

A Baileys engine quality-and-correctness release, plus a chat-history enhancement. **Identity:** inbound
Baileys message ids are now engine-neutral (`@c.us`, matching whatsapp-web.js), the dashboard Chats list
shows saved/contact names instead of raw JIDs, and `@lid` (privacy-id) senders resolve to a phone number.
**Messaging:** an opt-in `deep=true` mode lets the live chat-history endpoint reach up to 2000 messages
back on whatsapp-web.js, and Baileys can now send captions with document messages. **One behavior change
to note:** `message.received` / `revoked` / `reaction` webhook and WebSocket payloads from a Baileys
session now carry `@c.us` ids where they previously carried `@s.whatsapp.net` (or a resolved `@lid`) — a
consumer that stored or compared the old ids will see the new value.

### Added

- **Opt-in deep chat history (`deep=true`).** `GET /sessions/:id/messages/:chatId/history` was capped at
  100 messages per request — OpenWA's own bound, not a WhatsApp limit, since whatsapp-web.js can load
  earlier messages on demand. A new `deep=true` query raises the ceiling to 2000 so callers can reach
  weeks/months back. Deep mode is metadata-only (it ignores `includeMedia`, since base64 for up to 2000
  messages would be an enormous payload). The default path is unchanged (default 50, max 100). The Baileys
  engine has no history sync, so the endpoint still returns `501` there regardless of `deep`. (#347)

### Fixed

- **Baileys engine: the Chats list now shows saved/contact names instead of a raw number or `@lid`.** When
  Baileys supplied a chat without a title, the dashboard Chats list fell back to the raw JID user-part (a
  bare number, or a privacy-id for `@lid` contacts). The session store now resolves a best-known display
  name from the synced contacts — preferring the saved name, then the business `verifiedName`, then the
  pushName (`notify`) — and for a `@lid` chat it also looks up the contact behind the resolved phone. The
  raw user-part remains the last resort, so a name is shown whenever WhatsApp has delivered one. No API
  shape change (`ChatSummary.name` is simply better populated). (#369)

- **Baileys engine: `@lid` senders now resolve to a phone number.** `senderPhone` and
  `GET /sessions/:id/contacts/:id/phone` always returned `null` for privacy-id (`@lid`) contacts on
  Baileys: the resolver only consulted mappings from `contacts.*` / `messaging-history.set`, which don't
  fire for a fresh inbound `@lid` sender, and baileys@6.7.23 has no `getPNForLID` lookup. The adapter now
  learns the `lid -> phone` pair that Baileys attaches to the inbound message key (`senderPn` /
  `participantPn`), so the sender of an incoming message resolves to its number and later contact lookups
  succeed. Still best-effort by design — a number is only revealed once WhatsApp delivers the mapping
  (e.g. an inbound message from that contact). (#362)
- **Baileys engine: inbound message ids are now engine-neutral (`@c.us`).** The Baileys adapter emitted
  its native `<phone>@s.whatsapp.net` / `<lid>@lid` ids in message payloads (`from` / `to` / `chatId` /
  `author`, plus revoked and reaction events), while the whatsapp-web.js engine and the rest of the
  system use the `<phone>@c.us` convention - so the same contact was addressed under a different id
  depending on the engine, and `@lid` (privacy-id) contacts could not be resolved to a phone. Baileys
  now canonicalizes these to the neutral dialect (resolving a `@lid` to its phone when the mapping is
  known, keeping it as `@lid` otherwise), matching whatsapp-web.js. Group participant and owner ids are
  canonicalized through the same path, so admin/controller recognition (e.g. the translation plugin)
  keeps working. **Consumer-visible:** `message.received` / `revoked` / `reaction` webhook and WebSocket
  payloads from a Baileys session now carry `@c.us` ids where they previously carried
  `@s.whatsapp.net` (or a resolved `@lid`); a consumer that stored or compared the old ids will see the
  new value. Outbound sending and contact/chat list ids are unchanged for now.

- **Baileys engine: documents can now be sent with a caption.** `sendDocumentMessage` dropped
  `media.caption` on the Baileys engine, while whatsapp-web.js already forwarded it. Baileys now sends the
  caption too (parity across engines); the document stores the caption as its message body, falling back
  to the filename when absent. (#363)

## [0.4.4] - 2026-06-20

A reliability and correctness patch. Engine: Baileys reconnect no longer leaks its socket, and a session
keeps its operator config even if the engine plugin fails to enable before `onLoad`. Templates: names are now
unique per session (deterministic resolve, `409` on duplicate, with a lossless de-duplicating migration).
Tooling: the migration CLI can manage the main (auth/audit) connection, and the Docker image ships `procps`
so a missing-`ps` cleanup path can't crash the container. **One behavior change to note:** `PUT /settings`
now returns `501` — settings are environment-derived and read-only at runtime — instead of a misleading `200`
(no dashboard flow uses the write).

### Added

- **CLI migration commands for the main (auth/audit) connection.** The app runs the main connection as a separate
  always-SQLite connection, but the migration CLI only managed the data connection. New `migration:run:main`,
  `migration:generate:main`, `migration:show:main`, and `migration:revert:main` scripts (plus `:prod` variants) manage
  it — needed when `MAIN_DATABASE_SYNCHRONIZE=false` disables boot auto-migration. Purely additive. (#364)

### Changed

- **`PUT /settings` now returns `501 Not Implemented` instead of a misleading `200`.** Settings are derived from
  environment variables and consumed at boot (and `ConfigService` is immutable at runtime), so the previous handler
  mutated an in-memory copy and reported success while persisting and applying nothing. The endpoint is now honest
  about being read-only; `GET /settings` and the ADMIN guard are unchanged, and no dashboard flow uses the write. (#364)

### Fixed

- **Baileys reconnect no longer leaks the previous socket.** An internal (transient-drop) reconnect overwrote the live
  socket without tearing the old one down, leaking its WebSocket and event listeners on every reconnect. The previous
  socket is now detached and ended before its replacement is created. (#364)
- **Engine sessions keep operator config when the engine plugin fails to enable.** The engine config blob is now also
  supplied at plugin construction, so `sessionDataPath`/`executablePath`/`authDir` still apply if a plugin fails to
  enable before its `onLoad` runs (they previously dropped silently to defaults). The healthy path is unchanged. (#364)
- **Template names are unique per session.** A composite unique index makes resolve-by-name deterministic and rejects
  duplicate names with `409 Conflict`; a migration losslessly de-duplicates any pre-existing collisions (keeps the
  earliest, renames the rest) before adding the index. The `{{var}}`/`{var}` template-syntax split is unchanged and
  still tracked in #69. (#364)
- **Container no longer crashes on browser-cleanup paths when `ps` is missing.** The production image is based on
  `node:22-slim`, which omits the `ps` binary; cleanup code that shells out to `ps` (e.g. process-tree kills) fails
  with `spawn ps ENOENT`, and that unhandled child-process error can take down the whole Node runtime. The image now
  installs `procps`. This does not change the underlying browser-init timeout — it only prevents the missing-`ps`
  cleanup failure from being fatal. (#359)

### Documentation

- **Documented chat-history limits.** A new guide explains the difference between the local message-history
  endpoint (`GET /sessions/:id/messages`, reads OpenWA's database) and the bounded live-history endpoint
  (`GET /sessions/:id/messages/:chatId/history`, asks the engine): live history defaults to `limit=50` and is
  clamped to `[1, 100]` (so `limit=999` returns 100, not the full account history), and is a recent-history
  helper rather than a complete server-side import. (#356)

## [0.4.3] - 2026-06-19

A security-hardening and reliability release: outbound-request and storage hardening, plugin/message persistence
fixes, delivery-status and concurrency correctness, and lifecycle robustness — including a **force-kill recovery
for stuck sessions** and its dashboard button. **No breaking changes** for a correctly-configured deployment; the
only behavior change to note is that a misconfigured `ENGINE_TYPE`/`STORAGE_TYPE` now fails fast at boot instead
of silently falling back to the default.

### Added

- **Force-kill a stuck session.** `POST /sessions/:id/force-kill` (OPERATOR) recovers a session whose engine is
  wedged and won't respond to a normal stop/delete: the whatsapp-web.js engine **SIGKILLs its own Chromium
  process directly** (never a process-wide kill that could take down other sessions), then best-effort tears the
  client down; the Baileys engine ends its socket. The teardown is time-bounded and isolated, and the session is
  left `DISCONNECTED` and restartable. (#352)
- **Dashboard "Kill Stuck" button.** Session cards in a `failed` state get a Kill Stuck action that confirms,
  then calls the force-kill endpoint above. (#351)

### Security

- **Outbound webhook and media fetches are pinned to the SSRF-validated IP.** The host check and the actual
  connection previously resolved DNS independently, leaving a DNS-rebinding window; the connection now reuses
  the exact vetted address (preserving the hostname for TLS SNI/`Host`, with A-record failover) across webhook
  delivery (direct/queued/test) and server-side media downloads. (#338)
- **IPv6 SSRF blocklist closes embedded-IPv4 gaps** (6to4 `2002::/16`, NAT64 `64:ff9b::/96`, IPv4-compatible
  `::/96`); the LibreTranslate plugin client is SSRF-guarded; per-session `proxyUrl` is validated as an
  `http(s)`/`socks4`/`socks5` URL. (#344)
- **Secret/auth hardening.** Generated secret files (`data/.env.generated`, `data/.api-key`) are written `0600`;
  an opt-in `API_KEY_PEPPER` hashes API keys with HMAC-SHA256; `allowedIps` entries are validated as IPv4/CIDR;
  the queue dashboard (Bull Board) auth uses the same trusted-proxy IP model as the API; the production
  secret-guard inspects the canonical S3 variables. (#345)
- **Storage import/key hardening.** A `tar.gz` import is bounded against decompression bombs (per-entry byte cap
  + entry-count cap); storage-key containment is enforced at the backend-agnostic boundary so the S3 path
  inherits it; a plugin's `ctx.storage` is sandbox-contained against `..` traversal. (#346)

### Fixed

- **Webhook subscriptions for session lifecycle events now deliver.** `session.status`, `session.qr`,
  `session.authenticated`, `session.disconnected` were accepted on subscribe but never dispatched; they now fire
  from the engine lifecycle (the n8n docs are corrected to the real event names). (#335)
- **Plugin enable/disable and configuration now persist** across restarts (they previously updated only
  in-memory state while the API reported success). Plugins are not auto-enabled on boot for safety; their saved
  configuration is preserved. (#339)
- **Bulk-sent messages are recorded, their errors no longer leak internal addresses, and a running batch can be
  cancelled across instances.** (#340)
- **Forwarded messages on the whatsapp-web.js engine report a real WhatsApp message id**, so their delivery
  status advances (the synthetic `fwd_<id>` could never match an ack). (#341)
- **A late delivery/read receipt is no longer lost** (the ack retries once when it arrives before the send's id
  is committed); **concurrent reactions no longer overwrite each other** (serialized per message); a plugin hook
  that reports an error no longer has its partial output applied; a failed ack write is logged with context. (#348)
- **Storage export no longer accumulates copies on the data volume** — it writes under `data/exports/` with a
  TTL sweep and an async read (instead of a synchronous read that blocked the event loop). (#346)
- **`WEBHOOK_TIMEOUT` is honored on the queued and test delivery paths** (not just the deprecated direct one);
  graceful shutdown is bounded (a half-open Redis socket can't block `app.close()`); unsupported status/catalog
  operations return a consistent `501`; a misconfigured `ENGINE_TYPE`/`STORAGE_TYPE` fails fast at boot. (#350)

### Changed

- **The `/api/metrics` scrape is memoized for a few seconds** so back-to-back scrapes don't each run a full
  session scan plus aggregates; removed a dead branch in the WebSocket connect handler. (#350)

### Documentation

- Added a **phone-number pairing** example. (#343)
- Documented the webhook `idempotencyKey`/`deliveryId` fields (body + `X-OpenWA-*` headers) and the dedup rule;
  corrected the `.env.example` rate-limit variable names (`RATE_LIMIT_MEDIUM_TTL`/`_LIMIT`, in milliseconds). (#350)

## [0.4.2] - 2026-06-19

Bug-fix and hardening release: access-control tightening, session-lifecycle resilience, data-migration
correctness, and a PostgreSQL analytics fix. No breaking changes — existing deployments and the default
(ADMIN) dashboard key are unaffected.

### Security

- **The well-known development API key is refused in production.** With `ALLOW_DEV_API_KEY=true` (and no
  `API_MASTER_KEY`), the server seeded the documented `dev-admin-key` as an ADMIN credential in any
  environment. Production now fails fast when `ALLOW_DEV_API_KEY=true`, and `dev-admin-key` is rejected as an
  `API_MASTER_KEY`. Development behaviour is unchanged.
- **Webhook by-id operations and the webhook list are scoped to their session.** `GET`/`PUT`/`DELETE`
  `/sessions/:sessionId/webhooks/:id` and the test endpoint now verify the webhook belongs to the URL's
  session (a mismatch returns 404), and `GET /webhooks` is scoped to the calling key's allowed sessions —
  closing cross-session access to another session's webhook configuration.
- **`GET /sessions` is scoped to the API key's allowed sessions.** A session-restricted key no longer lists
  every session.
- **The audit log and global statistics require ADMIN.** `GET /audit`, `GET /stats/overview` and
  `GET /stats/messages` (cross-session, unscoped reads) now require an ADMIN key. The per-session stats route
  is unchanged (already scoped by its session parameter).
- **Plugin secrets are redacted on read.** `GET /plugins` and `GET /plugins/:id` now mask config fields a
  plugin marks `secret` (e.g. API keys); updating config preserves the stored secret when the masked value is
  submitted back unchanged.

### Fixed

- **Baileys: inbound and sent messages no longer fail to persist for a recreated session** (#319). An
  orphaned adapter writing under a stale session id raised a foreign-key error on every message and left the
  message store empty (breaking reply/forward/react/delete by id). The store now skips the write for an absent
  parent session, logging once instead of erroring per message.
- **`import-data` no longer silently loses message history.** The restore targeted non-existent columns for
  the `messages` and `message_batches` tables, so every row failed while the endpoint still reported success —
  after the destructive delete. Column mapping is corrected for both SQLite and PostgreSQL, and a partial
  restore now rolls back and reports `imported: false` instead of committing a half-wiped database.
- **Statistics work on a PostgreSQL data database.** The time-series and hourly-activity queries used a
  SQLite-only date function and returned 500 on PostgreSQL; the date bucketing is now dialect-correct.
- **Concurrent session start no longer orphans an engine.** Two near-simultaneous `POST /sessions/:id/start`
  for the same session could both create an engine, leaking a Chromium process the lifecycle could never
  clean up. The second start is now rejected with a clear error.
- **A stuck engine teardown no longer wedges a session.** `delete()` and `stop()` now time-bound and isolate
  the engine teardown, so a hanging Chromium can't prevent the session row from being removed or its status
  from being updated. A genuine database failure on delete still surfaces as an error.
- **Reconnect backoff is bounded.** An unvalidated `reconnectBaseDelay` / `maxReconnectAttempts` in a
  session's config could drive an immediate-relaunch storm or an unbounded reconnect loop; the values are now
  coerced and clamped (the defaults are unchanged).
- **Inbound media is size-capped.** Media on an inbound message is bounded by `MEDIA_DOWNLOAD_MAX_BYTES`
  (default 50 MiB; previously this cap applied only to outbound URL sends). Oversized media is dropped — the
  message envelope is preserved — instead of being base64-encoded into memory, persisted, and broadcast.
- **`reply` / `forward` / `react` / `delete` on a missing message return 404** instead of a generic 500.
- **Swagger now reports the current API version** (it was pinned to an old value).

### Documentation

- Added an n8n appointment-booking workflow example and webhook signature-verification examples, and corrected
  the `message.received` webhook payload field reference.

## [0.4.1] - 2026-06-18

Bug-fix release found while verifying v0.4.0 on both engines (whatsapp-web.js and Baileys): the Baileys QR
now renders in the dashboard, a `synchronize`-created SQLite data DB no longer crashes when adopting
migrations, and graceful shutdown is clean. No API or breaking changes.

### Fixed

- **Baileys QR code is now scannable from the dashboard.** The Baileys engine returned the raw WhatsApp QR
  ref string from `GET /sessions/:id/qr`, while the dashboard (and the whatsapp-web.js engine) expect a PNG
  data URL — so the dashboard's `<img>` showed a broken image and Baileys sessions could not be linked via
  the UI. The Baileys adapter now renders the QR to a `data:image/png` URL, matching the whatsapp-web.js
  engine's contract (the REST response shape is now consistent across engines).
- **Adopting migrations over a `synchronize`-created SQLite data DB no longer crashes on boot.** A data DB
  whose schema was created by `DATABASE_SYNCHRONIZE=true` has an empty migrations table, so the baseline
  migration re-ran `CREATE TABLE "sessions"` and aborted startup with `table "sessions" already exists`. The
  baseline migration is now idempotent (it skips when the schema already exists, mirroring the other
  migrations), so switching a SQLite data DB from synchronize to migration-managed boots cleanly and the DB
  becomes migration-managed going forward (existing rows preserved). Fresh deployments are unaffected.
- **Graceful shutdown no longer logs "could not find DataSource" on SIGTERM.** With two named TypeORM
  connections (`main` + `data`), `@nestjs/typeorm`'s shutdown hook resolved the default (unnamed) DataSource
  token and threw `Nest could not find DataSource element`, leaving the DataSources undestroyed and the
  process exiting non-zero. The connection factories now carry their `name`, so the shutdown hook resolves
  the correct named DataSource and the app shuts down cleanly (exit 0).

### Changed

- Internal: the SQLite data-DB configuration comment and a dead `synchronize` default in `app.module.ts` now
  reflect the actual behavior (the data DB is migration-managed by default; `DATABASE_SYNCHRONIZE=true` opts
  into synchronize). No runtime behavior change.

## [0.4.0] - 2026-06-18

Single-port deployment. The API now serves the bundled dashboard SPA itself, and the bundled Traefik
reverse proxy is removed. This is a deployment/packaging change only — there are no API or
application-code changes.

### Changed

- **BREAKING — single-port dashboard: the API now serves the bundled dashboard SPA.** In production the
  NestJS API serves the built dashboard from its own port (default `2785`) via `@nestjs/serve-static`, so
  there is no separate dashboard container and the UI is available by default wherever the API runs. `/api`
  and `/socket.io` are excluded so they keep returning real API/WebSocket responses. Opt out with
  `SERVE_DASHBOARD=false`. Dev is unchanged: `npm run dev` still runs the Vite dev server on `:2886` (HMR)
  proxying to the API. Split-origin hosting (dashboard on a separate origin/CDN) still works: build with
  `VITE_API_URL=<api-origin>` and host `dashboard/dist` anywhere. (#275)
- The API's Content-Security-Policy now allows `https://fonts.googleapis.com` (`style-src`) and
  `https://fonts.gstatic.com` (`font-src`) so the dashboard's webfonts load now that it is served under the
  API's CSP. (#275)
- **BREAKING — removed the bundled Traefik reverse proxy.** With the API serving both the UI and the API
  on one port, the shipped Traefik service was a single-backend passthrough that added no value (it
  terminated no TLS out of the box). Removed the `traefik` service, the `traefik/` configs, and the
  `with-proxy` profile. For TLS / public exposure, put your own reverse proxy (nginx, Caddy, a cloud load
  balancer, or a k8s Ingress) in front of the API — see `docs/12-troubleshooting-faq.md`. (#276)

### Added

- `npm run build:all` (build API + dashboard) and `npm run prod` (build then serve) for running the
  production build directly without Docker. (#275)

### Migration

- The dashboard moved from `:2886` (separate nginx container) to the API port `:2785`. Update bookmarks,
  monitoring, and any external reverse-proxy config accordingly. (#275)
- The `with-dashboard` and `with-proxy` compose profiles are removed, and the `DASHBOARD_PORT`,
  `PROXY_ENABLED`, and `DASHBOARD_ENABLED` env vars are gone (silently ignored if still set). `--profile
  full` now starts the optional datastores (postgres, redis, minio). If you relied on the bundled Traefik
  for TLS, front the API with your own reverse proxy. (#275, #276)

## [0.3.0] - 2026-06-18

Engine pluggability and plugin extensibility. OpenWA can now run on a second, browser-free WhatsApp engine
(Baileys) as a peer to whatsapp-web.js, and bot-shaped features can ship as first-party extension plugins
on a scoped capability layer instead of living in core (#265).

> ⚠️ **Breaking (plugin API):** `PluginContext.getService` is removed. It was a stub returning `undefined`
> with no real consumers; out-of-tree plugins must migrate to the new `ctx.messages` / `ctx.engine`
> capabilities.

### Added

- **Baileys engine (`ENGINE_TYPE=baileys`)** — a second, browser-free WhatsApp engine built on
  `@whiskeysockets/baileys` (WebSocket/Noise protocol, no Chromium), selectable as a peer to the default
  whatsapp-web.js engine. It supports linking (QR + pairing code); sending text, media
  (image/video/audio/document/sticker), location, and contacts; reply / forward / react /
  delete-for-everyone; full group management (create, participants, subject/description, invite codes),
  profile pictures, and block/unblock; contacts, chats, and read receipts; and **receiving** messages with
  their media, captions, location, quoted context, reactions, and remote deletes. URL media is fetched
  through the same SSRF-guarded path as the default engine. Reply/forward/react/delete are backed by a
  per-session persisted message store (`baileys_stored_messages`, bounded by `BAILEYS_MESSAGE_STORE_LIMIT`,
  default 5000; cleared on logout; CASCADE-deleted with its session). `getChatHistory` and
  labels/channels/status/catalog remain unsupported (HTTP 501) — Baileys has no on-demand history API, and
  the rest are parity with the whatsapp-web.js engine. Config: `BAILEYS_AUTH_DIR` (default `./data/baileys`);
  proxy is not yet supported on this engine. The engine loads **lazily** (dynamic `import()` only when
  selected), so default-engine operators are unaffected and there is **no global Node version floor**.
  (#299, #307, #308, #309, #310, #312)
- **Plugin capability layer (Tier-2 extension plugins):** scoped `ctx.messages` (`sendText` / `reply`,
  routed through `MessageService` so persistence and the send pipeline are preserved) and read-only
  `ctx.engine` (`getGroupInfo` / `getContacts` / `getContactById` / `checkNumberExists` / `getChats`) on
  `PluginContext`, replacing the stubbed `getService`. A manifest-declared `sessions` scope is enforced at
  the facade before any engine access (default `['*']`), and a capability call to a dead/unstarted session
  fails with `PluginCapabilityError` instead of a raw error. (#294)
- **`HookManager` re-entrancy guard** (`AsyncLocalStorage`): a plugin that sends from inside a hook handler
  can no longer recurse into the same event (synchronous re-entry; the async `message:sent` echo loop is
  documented as out of scope for now). (#294)
- **`auto-reply` reference extension plugin**, first-party and **registered disabled by default** — enable
  it via `POST /plugins/auto-reply/enable` to exercise the capability layer end-to-end. (#294)
- **Group auto-translation extension plugin** — a first-party, **disabled-by-default** plugin that
  auto-translates incoming group messages via LibreTranslate, built entirely on the new capability layer
  (supersedes the earlier in-core approach). (#300)
- **Schema-driven plugin config form (dashboard):** the Plugins page now renders an editable config form
  for any plugin that exposes a `configSchema` (text / secret / number / boolean / enum), saved via the
  existing plugin-config endpoint — previously only the engine plugin had editable fields. (#303)
- **Spanish (`es`) dashboard locale** at full parity with English. (#292)

### Changed

- Engine config is now **opaque per-engine**: `EngineFactory` passes only engine-neutral fields
  (`sessionId`/`proxyUrl`/`proxyType`) to an engine plugin and supplies engine-specific config (Puppeteer
  for whatsapp-web.js) as a blob via the plugin context, so a non-browser engine can be added without the
  factory knowing browser fields. No env-var or behavior change for existing deployments. (#296)

### Fixed

- **Dashboard stops polling for a QR code once its session is connected**, and the dev Docker Compose setup
  proxies the dashboard to the API service correctly. (#311)
- Italian locale: the message-template strings are now fully translated. (#301)

## [0.2.10] - 2026-06-17

Completes the v0.2.9 non-breaking batch with three dashboard/CI follow-ups that belonged to the same
improvement set. No breaking changes.

### Fixed

- **MessageTester (dashboard) resolves the recipient through the engine**, not a hand-built `…@c.us` JID:
  it calls the check-number endpoint for the engine-canonical chat id and surfaces a clear "not registered
  on WhatsApp" message for unknown numbers, instead of silently sending to a guessed id (#265). New
  `messageTester.notOnWhatsApp` string across all 8 locales. (#279)
- **Dashboard message bubbles use the engine-neutral `MessageType` vocabulary end-to-end** — incoming
  websocket/revoked payloads are coerced via `asMessageType()`, and an attachment's optimistic bubble is
  typed from its MIME (e.g. a PDF is `document`, not `application`), matching the backend normalization
  shipped in #270. (#281)

### Internal

- CI: bump `docker/setup-qemu-action` v3 → v4 (Node 24), clearing the Node-20 deprecation warning on the
  image-build/publish jobs. (#280)

## [0.2.9] - 2026-06-17

A reliability, security, and accessibility hardening release — no breaking changes. It tightens RBAC on
write endpoints, patches the `ws`/`qs` advisories, makes the busy message path and graceful shutdown
crash-resistant, fixes bulk-message terminal status, finally honors `LOG_LEVEL`, adds audit-log and
webhook-job retention, and improves dashboard accessibility and load-error states.

> ⚠️ **RBAC tightening (action may be required):** write endpoints for groups, contacts, labels, channels,
> catalog, and status now require the `OPERATOR` role. If you used a `VIEWER` key for any of these writes,
> switch it to `OPERATOR` (or `ADMIN`). Everything else is backward-compatible.

### Security

- **Write endpoints for groups, contacts, labels, channels, catalog, and status now require the
  `OPERATOR` role**, closing an unintended privilege gap where a `VIEWER`-role API key could create/leave
  groups, manage participants, block contacts, post statuses, send products, and mutate labels. Read
  (`GET`) endpoints remain open to any valid key, matching the message/session controllers. (#284)
  > ⚠️ If you used a `VIEWER` key for any of these write operations, switch it to `OPERATOR` (or `ADMIN`).
- Patched a high-severity `ws` advisory (and a moderate `qs` DoS) on the live socket.io transport by
  bumping in-range deps (`ws`→8.21.0, `engine.io`→6.6.9, `qs`→6.15.2, plus the incidental
  re-resolutions `npm audit fix` pulled in) in both the API and dashboard. Lockfile-only — no
  `package.json`/API change. The remaining advisories are build-only (`sqlite3`→`node-gyp`→`tar`)
  and require a breaking `sqlite3` major, deferred. (#283)

### Added

- **`LOG_LEVEL` is now honored.** It was read into config/compose but never applied (logging was hardcoded
  to `info`); the level (`error`/`warn`/`info`/`debug`/`verbose`) is now set at bootstrap. (#287)
- **Automatic audit-log retention.** Audit logs older than `AUDIT_RETENTION_DAYS` (default 90; `0` disables)
  are pruned daily and once at startup — the existing `cleanup()` was never scheduled, so `audit_logs` grew
  without bound. (#287)

### Fixed

- **Bulk-message batch status is now correct on cancel and stop-on-error.** A cancelled batch could be
  silently reverted to `PROCESSING` (the final save overwrote the `CANCELLED` status with the stale
  in-memory one), and a `stopOnError` abort was reported as `COMPLETED` whenever at least one message had
  already been sent. The terminal status is now re-derived (cancelled → `CANCELLED` with reconciled
  counters; stop-on-error → `FAILED`; otherwise `COMPLETED`/`FAILED`). Bulk-message item `type` is also
  validated against the allowed set (`text`/`image`/`video`/`audio`/`document`) with `@IsIn`, so an invalid
  type is rejected up front instead of failing mid-send. (#286)
- **Graceful shutdown is now robust.** `onModuleDestroy` clears reconnect timers first and destroys engines
  in parallel, each isolated and time-bounded — so one hung/throwing Chromium can no longer abort teardown
  of the other sessions or stall shutdown. A session that exhausts its reconnect attempts is now marked
  `FAILED` with a reason (surfaced via `lastError`) instead of sitting silently `DISCONNECTED` forever, and
  BullMQ webhook jobs are auto-evicted (`removeOnComplete`/`removeOnFail`) so completed/failed job payloads
  no longer accumulate unbounded in Redis (audit M19). (#287)
- **Engine-event handlers no longer risk unhandled promise rejections.** Webhook dispatch is now
  self-contained (a failed webhook lookup is logged and swallowed, not rejected into the fire-and-forget
  callers), the `onMessage`/`onMessageCreate` hook chains carry a `.catch()`, and a process-level
  `unhandledRejection` backstop logs (instead of crashing) anything that still slips through. A transient
  DB hiccup on the busy message path can no longer drop the event silently or take the process down.
  Audit-log writes are also best-effort: a failed audit insert is logged and swallowed instead of turning
  an otherwise-successful operation (create/delete/start/stop session, etc.) into a `500`. (#285)
- **Dashboard accessibility:** toast notifications are now an ARIA live region (`role="region"`/`aria-live`,
  with `role="alert"` on error/warning toasts) so screen readers announce success/error feedback, and the
  toast close button has an accessible name. The API-key visibility toggles on the Login and API Keys pages
  now have state-reflecting `aria-label`s (show/hide). New `common.showApiKey`/`common.hideApiKey` strings
  across all locales. (#288)
- **Dashboard no longer shows a misleading "nothing here" empty state when a list fetch fails.** The
  Webhooks, API Keys, and Logs pages discarded the query error and rendered the empty state on failure;
  they now surface an accessible error banner (`role="alert"`) so the user knows the data failed to load. (#291)

### Internal

- Added critical-path test coverage for `HookManager`, `AuditService`, and the Postgres-UUID migration
  (497 tests total). (#289)
- Dead-code sweep across the backend and dashboard (unused queue name, `MessageResult.ack`, duplicate
  plugin config, `Skeleton` component, orphaned React Query hooks/keys). (#290)

## [0.2.8] - 2026-06-17

The engine-pluggability release: the whatsapp-web.js delivery-ack, message-type, and JID specifics are
now decoupled behind the neutral engine interface (a different engine, e.g. Baileys, can map its own at
the adapter boundary). Plus dashboard message templates, best-effort `@lid` → phone resolution, and a
Docker fix for sessions stuck at "authenticating".

> ⚠️ **Breaking for webhook consumers:** the `message.received`/`message.sent` `type` field is now a
> neutral enum — incoming `chat` → `text`, `ptt` → `voice`, `vcard`/`multi_vcard` → `contact`. Update
> any consumer that matched the raw whatsapp-web.js tokens. See **Changed** below.

### Added

- **Message templates (dashboard).** Manage reusable message templates from a new dashboard page
  (create/edit/delete, `{{variable}}` placeholders), backed by the existing `sessions/:id/templates`
  API, with full i18n across all locales. Thanks @Leslie-23 (#266).
- **Resolve a `@lid` privacy id to a phone number** (#263), engine-neutral via a new
  `IWhatsAppEngine.resolveContactPhone`. On-demand endpoint `GET /sessions/:id/contacts/:contactId/phone`
  → `{ contactId, phone }` (MSISDN digits, or `null` when the engine can't map it — best-effort, since
  `@lid` exists to hide numbers). Optional **inline** resolution: set `RESOLVE_LID_TO_PHONE=true` to attach
  a best-effort `senderPhone` to the `message.received` webhook + websocket payload for `@lid` senders
  (off by default; per-sender lookups are cached). A non-whatsapp-web.js engine implements its own mapping.

### Changed

- **Message delivery status is now engine-agnostic** (engine-pluggability decoupling, #265). The raw whatsapp-web.js
  ack integer no longer leaks past the engine adapter — a neutral `DeliveryStatus`
  (`pending`/`sent`/`delivered`/`read`/`failed`) flows through the interface, services, webhooks, websocket, and
  dashboard, so a non-whatsapp-web.js engine (e.g. Baileys) can map its own delivery codes at the adapter boundary.
  - The `message.ack`/`message.failed` webhooks now include a neutral **`status`** field. The legacy **`ack`** integer
    is **kept (deprecated)** for backward compatibility — new consumers should read `status`.
  - Dashboard chat delivery ticks now update **live** over the websocket (the ack push was previously never emitted).
  - Minor deprecated-surface deltas: the legacy webhook `ack` reports `3` (not `4`) for a "played" voice/video receipt,
    and a play-after-read no longer emits a second `message.ack` (both map to `status: 'read'`).
- **Message `type` is now an engine-neutral enum** (engine-pluggability decoupling, #265). Raw whatsapp-web.js
  message-type tokens no longer leak past the engine adapter — incoming live/history messages, persisted rows, and the
  `message.received`/`message.sent` webhooks now use a neutral `MessageType`
  (`text`/`image`/`video`/`audio`/`voice`/`document`/`sticker`/`location`/`contact`/`revoked`/`unknown`), consistent with
  outgoing sends. A non-whatsapp-web.js engine maps its own tokens at the adapter boundary.
  - **Webhook contract change** (both `message.received` and `message.sent`): incoming `type` was previously raw — e.g.
    `chat` → **`text`**, `ptt` → **`voice`**, `vcard` → **`contact`**. New consumers should expect the neutral enum.
  - An idempotent startup backfill rewrites existing `messages.type` rows to the neutral vocabulary (runs in every DB
    mode, including the zero-config SQLite default where data migrations don't), so historical chats render correctly
    and message-type stats don't split the same kind across old/new tokens.
  - Fixes a latent dashboard bug where incoming text (`chat`) was mis-styled as media and shown as `[chat]` in reply previews.
- **JID construction moved into the engine** (engine-pluggability decoupling, #265). The check-number endpoint
  (`GET /sessions/:id/contacts/check/:number`) now returns the engine's canonical chat id via a new
  `IWhatsAppEngine.getNumberId(number)` instead of the controller hand-building a `…@c.us` JID. As a result the
  returned `whatsappId` is the engine-resolved id and may be normalized — it can differ from the submitted number's
  `…@c.us` form (e.g. a `@lid` identifier) rather than echoing the input. And status/story
  broadcasts are flagged with a neutral `isStatusBroadcast` on the message payload, so engine-neutral code no longer
  matches the engine-specific `status@broadcast` pseudo-JID. A non-whatsapp-web.js engine supplies its own JID scheme.

### Fixed

- The `WWEBJS_WEB_VERSION` (and `WWEBJS_WEB_VERSION_REMOTE_PATH`) workaround for sessions stuck at
  "authenticating" (#251) is now actually passed through by the Docker Compose files. The `environment:`
  blocks enumerate vars explicitly with no `env_file`, so setting `WWEBJS_WEB_VERSION` in `.env` previously
  never reached the container — making the documented fix a no-op for Compose users. Added the passthrough
  (empty default = auto-select, no behavior change when unset) to `docker-compose.yml` and
  `docker-compose.dev.yml`. (#273)
- Refined the Italian (`it`) dashboard translations. Thanks @albanobattistella (#272).

## [0.2.7] - 2026-06-16

A feature + fix release: typing simulation (anti-ban, on by default), a delete-chat endpoint, and a fix
for duplicate outgoing messages in the dashboard — plus engine-agnostic groundwork and the nginx/
singleton-lock container fixes.

### Added

- **Typing simulation before single sends (anti-ban), on by default.** A text send now shows a "typing…"
  indicator and pauses briefly (length-scaled, jittered) before sending, so automated messages don't look
  instantaneous. Disable with `SIMULATE_TYPING=false`; cap the pause with `SIMULATE_TYPING_MAX_MS`
  (default 5000). Exposed engine-agnostically via `IWhatsAppEngine.sendChatState` and a new
  `POST /sessions/:id/chats/typing` endpoint (`state`: `typing` | `recording` | `paused`). Bulk sends are
  unaffected (they keep their own `delayBetweenMessages` throttle).
- The engine API (`GET /infra/engines`) and the dashboard Active Engine card now report the **underlying
  engine library version** (e.g. `whatsapp-web.js 1.34.7`), distinct from the adapter plugin version.
- **Delete a chat** from the chat list via `POST /sessions/:id/chats/delete` (e.g. to clear out groups
  you've left). `OPERATOR` role, engine-agnostic DTO. Thanks @tobiasstrebitzer (#261).

### Fixed

- **Duplicate outgoing messages in the dashboard Chats view.** A race between the optimistic placeholder
  and the realtime `message.sent` echo could render a sent message twice. Reconciliation is now race-safe.
  (Display-only — the recipient always received exactly one message.)
- Dashboard (simple nginx image) proxied API/WebSocket requests to a `openwa` host that doesn't match the
  backend service name; `dashboard/nginx.conf` now targets `openwa-api` for both `/api/` and `/socket.io/`,
  matching the production compose and `Dockerfile.traefik`. Thanks @Abhishekrajpurohit (#259).
- The container entrypoint now clears stale Chromium `SingletonLock`/`SingletonSocket`/`SingletonCookie` files
  from session profiles on start, so a session can re-launch after an unclean shutdown instead of failing with
  "profile appears to be in use by another Chromium process" (exit Code 21). Thanks @Abhishekrajpurohit (#259).

### Changed

- `mark-chat-read` `chatId` validation is now engine-neutral (accepts any engine's JID scheme, e.g. a
  Baileys `…@s.whatsapp.net`) instead of hardcoding the whatsapp-web.js `@c.us`/`@g.us`/`@lid` format.

## [0.2.6] - 2026-06-16

A patch release: stop Chromium from failing to launch on hardened `read_only` containers, and make the
Login language selector legible in dark mode.

### Fixed

- Chromium no longer hard-crashes at launch (`Trace/breakpoint trap` / `chrome_crashpad_handler:
  --database is required`) on hardened `read_only` containers. Chromium resolves its home dir from the
  passwd entry and ignores `$HOME`, so the home-less `openwa` user pointed it at a nonexistent
  `/home/openwa`. It is now given writable, pre-created `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` dirs (created
  by the entrypoint, owned by `openwa`). This supersedes the ineffective `--crash-dumps-dir` approach
  from 0.2.5, which is a confirmed no-op for the crashpad database on Debian/Ubuntu system Chromium. (#254)
- The Login screen's language `<select>` option popup is now legible in dark mode. The login route never
  sets `data-theme`, so it relied solely on the `prefers-color-scheme` media block, which set dark colors
  but left `color-scheme` ambiguous — rendering the native popup light with light text. (#249)

## [0.2.5] - 2026-06-16

A patch release: pairing-code linking, a Chromium crash-dumps fix, and dark-mode native controls.

### Added

- **Pairing-code linking** — `POST /sessions/:id/pairing-code` returns an 8-character code so a
  session can be linked via WhatsApp's "Link with phone number" instead of scanning the QR (useful
  for single-device / mobile onboarding). The session must be started and not yet authenticated. (#252)

### Fixed

- Chromium is now given an explicit writable `--crash-dumps-dir` so its crashpad handler always
  receives a `--database`, avoiding `chrome_crashpad_handler: --database is required` browser-launch
  failures on some hardened/container hosts. (#254)
- Dashboard native controls (select option popups, scrollbars) now follow the explicit app theme via
  `color-scheme`, instead of only the OS preference. (#249)

## [0.2.4] - 2026-06-16

A patch release: stop LAN dashboard logins from 500-ing, add a pin for the WhatsApp Web version
(works around sessions stuck at "authenticating"), and harden the data-export stream.

### Added

- **Pinnable WhatsApp Web version** via `WWEBJS_WEB_VERSION`. whatsapp-web.js 1.34.x can hang at
  `authenticating` (the post-link sync never completes) when the auto-selected WA-Web version is
  incompatible; set a known-good version (browse
  [wppconnect-team/wa-version](https://github.com/wppconnect-team/wa-version)) to pin it.
  Opt-in — unset keeps the default auto-version behavior. (#251)

### Fixed

- **Dashboard login over LAN no longer returns 500.** A disallowed CORS origin threw inside the
  cors callback, surfacing as an Internal Server Error; it now denies without throwing — so the
  bundled (same-origin) dashboard works on a LAN/remote host out of the box, while a genuine
  cross-origin dashboard still needs its origin in `CORS_ORIGINS`. (#250)
- Data-export stream now surfaces archive-level errors (gzip/finalize) on the response stream
  instead of an unhandled rejection or a silently truncated download. (#248)

## [0.2.3] - 2026-06-15

A patch release: the dashboard now works when served over plain HTTP on a non-`localhost`
origin (LAN/remote), plus a configurable dev-compose bind host.

### Fixed

- **Dashboard now works over plain HTTP on a non-`localhost` origin.** Toast notifications and
  the API-key copy button used secure-context-only browser APIs (`crypto.randomUUID`,
  `navigator.clipboard`) that are unavailable over HTTP on a LAN IP — so creating a session
  threw `crypto.randomUUID is not a function`. Both now degrade gracefully (non-crypto id
  fallback; `execCommand('copy')` clipboard fallback). (#244)
- The Infrastructure page's "View Bull Board" link no longer hardcodes `http://localhost:2785`;
  it opens the configured API origin, so it works on remote/LAN deployments.

### Changed

- The dev compose (`docker-compose.dev.yml`) bind host is now configurable via `BIND_HOST`
  (default `127.0.0.1`); set `BIND_HOST=0.0.0.0` in `.env` to reach the dev stack from another
  host (front it with a TLS proxy for anything public). Thanks @Stanley-blik (#245).

## [0.2.2] - 2026-06-15

A security-hardening and reliability release. It tightens defaults (SSRF protection on,
datastore secrets required, least-privilege webhook reads), closes a server-side
request-forgery vector on media fetches and webhook deliveries, adds an optional Prometheus
metrics endpoint, fixes headless Chromium startup in the non-root Docker image, and refreshes
dependencies. **Please read the Upgrade notes below before upgrading from 0.2.1** — several
defaults changed.

### Added

- **Prometheus metrics** at `GET /api/metrics` (session/message gauges, process stats).
  Disabled by default; set `METRICS_TOKEN` and scrape with `Authorization: Bearer <token>`.

### Security

- **Webhook secrets no longer leak:** the HMAC `secret` and custom `headers` are never
  returned from any webhook API response (responses are mapped through a scoped DTO).
- **Media-fetch SSRF closed:** server-side `MessageMedia.fromUrl` now runs an SSRF host
  guard + byte cap + timeout before fetching a caller-supplied URL.
- **Redirects are not followed** on webhook deliveries or media fetches, so a `302` to an
  internal host can't bypass the SSRF guard.
- **Webhook SSRF protection is ON by default** and validated at registration.
- **Docker hardening:** the socket-proxy is isolated on an `internal: true` network reachable
  only by the API (not the dashboard); the API container runs with `cap_drop: [ALL]` (+ a
  minimal re-add), `no-new-privileges`, a `read_only` rootfs + tmpfs, and pid/mem limits.
- **Plugin loader** rejects a manifest `main` that escapes the plugin directory before
  `require()`.
- **WebSocket:** the API key is re-validated on every subscribe (a revoked key is
  disconnected), is no longer sent in the handshake URL, and CORS uses the configured
  allowlist instead of `*`.
- **Production boot guard:** the app refuses to start in production with empty/placeholder
  secrets, and the committed default datastore credentials were removed.
- **Rate limiting** now keys on the resolved client IP instead of the proxy IP.

### Changed

- Webhook read routes now require an `OPERATOR`+ key.
- Webhook `events[]` are validated against the known event types (plus `*`).
- The six inline-body message endpoints (+ label/channel) now validate their input.
- The `main` auth/audit DB `synchronize` is config-driven (`MAIN_DATABASE_SYNCHRONIZE`,
  default on) with a bundled migration for `api_keys`/`audit_logs`.
- The readiness probe (`/api/health/ready`) now performs real database checks and returns
  503 when a dependency is down or the app is draining; the container `HEALTHCHECK` points
  at it.

### Fixed

- Message ack status UPDATE is scoped by `sessionId` (no cross-session corruption) and
  backed by a composite index.
- `getMessages` sanitizes `limit`/`offset` so `?limit=abc` no longer reaches the query.
- The Postgres database name now honors `DATABASE_NAME` consistently between the runtime and
  the migration CLI.
- Backup/restore scripts (`scripts/backup.sh`/`restore.sh`) capture **both** databases
  (incl. the auth DB `main.sqlite`) + sessions, so a restore preserves API keys.
- Boot-time environment validation rejects an unknown `DATABASE_TYPE` and missing Postgres
  credentials instead of silently coercing.
- Message-event idempotency keys are session-scoped.
- Response-envelope documentation corrected to the real raw-payload shape; the unused
  interceptor/filter were removed; horizontal-scaling docs marked single-instance.
- **Headless Chromium now starts in the Docker image as the non-root `openwa` user** — `HOME`
  points at a writable directory, so the engine no longer dies with
  `chrome_crashpad_handler: --database is required` on a fresh container. (closes #242)
- Marking a 1:1 chat as read now accepts the newer `@lid` (privacy Linked ID) JID, not just
  `@c.us`. Thanks @suraj7974 (#241).
- Allowlisted IPv6 literals in `SSRF_ALLOWED_HOSTS` now match whether or not the entry is
  bracketed (e.g. `[::1]` and `::1`).
- The dashboard returns cleanly to the login screen on a `401` instead of flashing a transient
  error toast.
- A webhook `secret` cleared via update is normalized to "no secret" (consistent with create)
  and is length-capped.

### Dependencies

- `@bull-board/{api,nestjs,express}` 7.2.1 → 8.0.0 and `@types/archiver` 7 → 8 (aligned with the
  archiver v8 runtime), plus a batch of minor/patch bumps (NestJS 11.1.27, BullMQ 5.78.1, AWS SDK,
  ESLint 10.5, Prettier 3.8, typescript-eslint 8.61, and a dashboard dev-tool bump).

### Upgrade notes (behavior changes)

- **Webhook reads now require `OPERATOR`+** — a `VIEWER` key reading webhooks gets `403`.
- **SSRF protection defaults ON** — deployments that deliver webhooks or fetch media from
  internal hosts must set `SSRF_ALLOWED_HOSTS` (comma-separated) or `WEBHOOK_SSRF_PROTECT=false`.
- **Datastore secrets are now required** — there is no `openwa`/`minioadmin` default;
  `docker compose --profile postgres/minio up` needs `DATABASE_PASSWORD` / `S3_*` set, and
  production refuses to boot with placeholder secrets.
- **Bull Board `?apiKey=` removed** — authenticate via `X-API-Key`/`Authorization: Bearer`.
- New env knobs: `SSRF_ALLOWED_HOSTS`, `MEDIA_DOWNLOAD_MAX_BYTES`, `MEDIA_DOWNLOAD_TIMEOUT_MS`,
  `MAIN_DATABASE_SYNCHRONIZE`, `SHUTDOWN_DELAY_MS`, `OPENWA_MEM_LIMIT`, `METRICS_TOKEN`.

## [0.2.1] - 2026-06-15

A patch release.

### Fixed

- **Dashboard:** The API client now honors `VITE_API_URL` for split-origin deployments.
  It reads `VITE_API_URL` (the API origin) and appends `/api` instead of always calling the
  same-origin `/api`; the same-origin default is unchanged. This fixes the dashboard
  failing with "Invalid API Key" when it is hosted on a different origin than the API.
  Thanks @jairo315-bit (#91).

### Dependencies

- **Dashboard:** Bump the TypeScript dev dependency from 5.9.3 to 6.0.3 (#140).

## [0.2.0] - 2026-06-15

A major feature- and security-focused release. Adds six dashboard languages and a
real-time Chats view, completes the outgoing-message and delivery-state webhook
story, introduces message templates and live chat history, hardens the API surface,
session lifecycle, and container runtime, and upgrades the WhatsApp engine. See
**Upgrade notes** for the behavior changes.

### Added

- **Dashboard / Chats:** A new real-time Chats view — browse a session's
  conversations, stream incoming and outgoing messages live over WebSocket, send
  text and media, and mark chats as read. Thanks @akbarxleqi (#152).
- **Dashboard / i18n:** Six new languages on a single canonical language picker —
  Simplified Chinese, Traditional Chinese, Arabic (full RTL), Telugu, French, and
  Italian — alongside the existing English and Hebrew. The picker now also appears
  on the Login screen and resolves `zh-Hant/HK/MO/TW` regional variants. Thanks
  @jr-everstar (#150), @7odaifa-ab (#145), @abhinayguduri (#149), and
  @albanobattistella (#224).
- **Messages:** Server-side **message templates** with `{{variable}}` substitution —
  full CRUD under `/sessions/:id/templates` plus a
  `POST /sessions/:id/messages/send-template` endpoint that renders and sends.
  Text templates only; interactive buttons/list/HSM are not supported on the
  whatsapp-web.js engine. Thanks @esakarya (#69).
- **Messages:** `GET /sessions/:id/messages/:chatId/history` reads chat history live
  from WhatsApp (bypassing the local DB), with optional base64 media; `limit` is
  clamped to 1–100. Thanks @jgalea (#96, closes #162).
- **Groups:** Group payloads now expose `linkedParentJID` — the JID of the parent
  community a sub-group belongs to. Thanks @ferhatte10 (#201).
- **Webhooks:** `message.sent` now fires for **every** outgoing message — including
  messages composed on a linked phone (via the whatsapp-web.js `message_create`
  event), not just messages sent through the API. (closes #93, #168, #195)
- **Webhooks / Sessions:** Stored message status now reflects real delivery state
  from acks — `delivered`, `read`, and `failed` — advancing monotonically (a late
  or out-of-order ack can never downgrade a higher status). A send that never
  receives a delivery ack stays `sent`, so it is visibly "not delivered" instead of
  falsely "sent". A new `message.failed` webhook is emitted on an error ack so
  consumers can detect non-delivery without polling. Independently identified and
  prototyped by @aminebalti55 (#225). (closes #155, #199, #220)
- **Webhooks:** Opt-in outbound SSRF protection — set `WEBHOOK_SSRF_PROTECT=true` to
  refuse webhook URLs that resolve to loopback, private, link-local, CGNAT, or
  cloud-metadata addresses (default off). (#221)
- **API:** `BODY_SIZE_LIMIT` caps request body size (default 25 MB, sized for
  base64 media sends). `ENABLE_SWAGGER` gates the `/api/docs` UI (default on; set
  `false` to disable it on exposed deployments). (#221, #67)
- **Webhooks:** `message.received` payloads now include the group sender's identity
  — `author` (the participant WID) and `contact` `{ name, pushName }`. Additive and
  backward compatible. (#223, closes #146)
- **Sessions:** Opt-in auto-start of previously authenticated sessions on boot via
  `AUTO_START_SESSIONS=true` (default off); sessions start sequentially to bound
  Puppeteer memory and one failure does not block the others. Thanks @mayko7d
  (#135, closes #218).
- **Sessions:** `PUPPETEER_EXECUTABLE_PATH` points the engine at a system
  Chromium/Chrome binary (for Alpine, ARM, or custom base images); unset keeps
  Puppeteer's bundled Chromium. (#219)
- **Docs:** Community integrations page documenting the community-maintained
  ioBroker adapter (with a not-endorsed caveat). (#223, closes #134)

### Changed

- **Engine:** Upgraded `whatsapp-web.js` from 1.26.1-alpha.3 to **1.34.7**
  (improved LID handling and stability). (#222)
- **Dashboard:** Responsive layout for small screens and improved dark-mode
  contrast across pages; the Plugins page no longer truncates the feature list.
  Thanks @ashiwanikumar (#66).
- **Auth:** The first-boot admin key is now a cryptographically random `owa_k1_`
  key in **all** environments by default; the fixed `dev-admin-key` is seeded only
  when `ALLOW_DEV_API_KEY=true` is explicitly set. (#221)
- **Auth:** Requests with a valid key but insufficient role now return **403
  Forbidden** instead of 401. (#221)
- **Docker / Podman:** Base images are fully qualified (`docker.io/node:22-slim`)
  and the container healthcheck uses `curl`, so the image builds and runs under
  Podman as well as Docker; added a Podman compatibility note to the docs. Thanks
  @3bsalam-1 (#68).
- **Docs / API:** Interactive messages (`Buttons` / `List`) are documented as
  unsupported on the whatsapp-web.js engine, and the speculative request-body
  examples were removed from the API collection. (#223, closes #158)

### Fixed

- **Sessions:** An engine operation attempted while a session is disconnected,
  reconnecting, or still initializing (for example, refreshing the dashboard after
  disconnecting the session from the phone) now returns **409 Conflict**
  ("session not connected") instead of a 500 Internal Server Error. Thanks
  @VincenzoKoestler for the related report. (#100)
- **Sessions:** A terminal engine failure (Chromium failed to launch, or WhatsApp
  rejected the stored credentials) now surfaces as a `failed` status with a
  human-readable reason on the session and in the dashboard, instead of silently
  closing the QR modal; `auth_failure` is treated as terminal rather than
  triggering a reconnect loop. A status race that could revert `qr_ready` back to
  `initializing` during startup is also fixed. (#219)
- **Engine:** The built-in engine plugin now honors `SESSION_DATA_PATH` and the
  configured Puppeteer settings instead of silently falling back to relative-path
  defaults. (#219)
- **Infrastructure dashboard:** Saved configuration (`data/.env.generated`) now
  applies reliably. The save handler wrote several env names the backend never read
  (`STORAGE_PATH`, `S3_ACCESS_KEY` / `S3_SECRET_KEY`, `ENGINE_HEADLESS` /
  `ENGINE_SESSION_PATH` / `ENGINE_BROWSER_ARGS`), so those settings silently reverted
  to defaults on restart; they now match what `configuration.ts` reads. Saving also
  merges into the existing file instead of rewriting it from scratch, so a partial
  save no longer blanks other keys or stored secrets, and the form hydrates from a
  new `GET /infra/config` endpoint. Thanks @VincenzoKoestler (#226).

### Security

- **CORS:** A wildcard (`*`) origin is now **refused in production** (cross-origin
  requests are blocked), and CORS credentials are only enabled with an explicit
  origin allowlist. (#221)
- **WebSocket:** A session-scoped API key can no longer subscribe to `*` or to
  sessions outside its `allowedSessions` allowlist, preventing cross-tenant event
  leakage. (#221)
- **Authorization:** Plugin enable/disable/config and the infrastructure read
  endpoints (`/infra/status`, `/infra/config`, `/engines`, `/engines/current`,
  `/storage/files/count`) now require an **ADMIN** key. (#221, #226)
- **Docker:** The container reaches the Docker API through a least-privilege
  `docker-socket-proxy` over TCP (`DOCKER_HOST`) instead of mounting the socket
  directly, and the Node process runs as a non-root `openwa` user via a `gosu`
  privilege-dropping entrypoint (`dumb-init` stays PID 1 for clean signal handling).
  Thanks @A831ARD0 (#227, #228; supersedes #129).
- **Health:** `/api/health` is excluded from rate limiting so liveness probes do
  not exhaust the limiter. (#221)

### Dependencies

- **CI:** Upgraded `softprops/action-gh-release` v2→v3 and
  `docker/build-push-action` v6→v7 (both move the GitHub Actions runtime to
  Node 24). (#169, #170)

### Upgrade notes

- **CORS in production:** if you serve the dashboard on a different origin than the
  API and relied on the default `CORS_ORIGINS=*`, set `CORS_ORIGINS` to the explicit
  dashboard origin(s) — a wildcard is now refused in production.
- **Infrastructure reads are ADMIN-only:** `/api/infra/status`, `/infra/config`,
  `/engines`, `/engines/current`, and `/storage/files/count` now require an ADMIN key.
- **Role-denied requests return 403** (was 401) — update clients that branch on the
  status code.
- **Not-ready engine ops return 409** (was 500) — clients calling group/chat/send
  endpoints while a session is not connected now receive `409 SESSION_NOT_READY`.
- **First-boot key:** non-production no longer seeds `dev-admin-key` by default (a
  random key is generated and printed in the startup banner / written to
  `data/.api-key`). Set `ALLOW_DEV_API_KEY=true` to restore the fixed local key.
- **Docker:** the bundled Compose now runs a `docker-proxy` sibling and the API
  talks to it via `DOCKER_HOST`, and the container runs as non-root; review the new
  Compose if you mounted the Docker socket directly or customized orchestration.

## [0.1.8] - 2026-06-13

A bug-fix patch release for self-hosted PostgreSQL (TLS/SSL) deployments and
webhook delivery deduplication. Backward compatible; defaults are unchanged.

### Added

- **Dashboard / Setup:** The Infrastructure screen now exposes a **Verify SSL Certificate** toggle (`DATABASE_SSL_REJECT_UNAUTHORIZED`), shown when SSL is enabled, so managed-Postgres TLS can be configured end-to-end from the UI without hand-editing `.env`. Defaults to verifying certificates; turn it off only for managed Postgres with self-signed certs (Supabase, Heroku, Render, Railway).

### Fixed

- **Database:** The runtime PostgreSQL TypeORM connection now honors `DATABASE_SSL` and `DATABASE_SSL_REJECT_UNAUTHORIZED`. Previously SSL was wired only into the migration CLI, so `DATABASE_SSL=true` was silently ignored on the live connection. Defaults are unchanged (`ssl: false`), so existing deployments are unaffected. Thanks @farrasyakila (#205, closes #204).
- **Webhooks:** Fixed idempotency-key generation for `message.received`, `message.sent`, `message.ack`, and `message.revoked`. The dispatched payload is an `IncomingMessage` carrying `id` (not `messageId`), but the resolver short-circuited on a truthy `'unknown'` fallback and never read `id`, so every incoming-message webhook was keyed `msg_unknown` — collapsing all messages into one deduplication bucket for consumers relying on the `X-OpenWA-Idempotency-Key` header. The resolver now uses `id ?? messageId`, with regression tests for the id-only and both-present payload shapes. Thanks @Singh1106 (#179).
- **Dashboard:** The Login screen now derives the displayed version from `package.json` at build time instead of a hard-coded literal, so it always reflects the installed release rather than a stale placeholder (closes #88).

## [0.1.7] - 2026-06-13

A security- and stability-focused patch release. Hardens the API surface,
clears a critical dependency advisory, and resolves a batch of self-hosting
bugs. Backward compatible except for the two upgrade notes below.

### Security

- **Path traversal in storage import**: `StorageService` extracted tar archive
  entries (and read/wrote files) using unvalidated paths, allowing writes
  outside the storage root. Added a path-containment check on local read/write.
  Fixes #151. (#207)
- **Broken access control on infrastructure endpoints**: every `/api/infra/*`
  mutating and data-exfiltration endpoint (config, restart, export-data,
  import-data, storage/export, storage/import) required only any valid API key.
  They now require the **ADMIN** role. (#207)
- **X-Forwarded-For IP spoofing**: `ApiKeyGuard` trusted the client-controllable
  `X-Forwarded-For` header for the per-key `allowedIps` whitelist. It now ignores
  it by default and only honours it for configured `TRUSTED_PROXIES`. (#211)
- **Fail-closed IP whitelist**: a key with an `allowedIps` whitelist but an
  undetermined client IP previously skipped the check (failed open); it now
  rejects. The QR endpoint (`GET /sessions/:id/qr`) now requires `OPERATOR`. (#213)
- **Bull Board queue UI** (`/api/admin/queues`) was reachable unauthenticated;
  it now requires an ADMIN API key. (#214)
- **Critical dependency advisory**: bumped `concurrently` to v10 to clear the
  critical `shell-quote` advisories. (#208)

### Fixed

- **Swagger UI** now sends the `X-API-Key` header (global security scheme). Fixes #173. (#109)
- **Dashboard Docker build** failed on the Vite 8 / `@vitejs/plugin-react` v5 peer
  conflict; upgraded the plugin to v6. Fixes #103, #123, #197. (#136)
- **Bulk send** (`/messages/send-bulk`) returned 400 for text-only messages
  (missing `@IsOptional()` on media fields). Fixes #192. (#193)
- **Group participant endpoints** returned 400 because their DTOs lacked
  `class-validator` decorators. Fixes #190. (#210)
- **Cross-platform `postinstall`**: replaced POSIX-only shell syntax that broke
  `npm install` on Windows. Fixes #181. (#209)
- Controllers now throw proper NestJS HTTP exceptions instead of generic `Error`
  (correct 400/404 instead of 500). (#102)
- Dashboard QR modal shows a loading state and keeps polling until ready. (#97)
- Traefik dashboard image now proxies `/api` and `/socket.io`. Fixes #116. (#131)
- Wired the documented `API_MASTER_KEY` env var into the initial key seed. Fixes #153. (#133)
- Fixed the `Location` constructor ESM/CJS interop in the whatsapp-web.js adapter. (#186)
- Incoming webhook messages now include location data for location messages. (#202)

### Changed

- **Lint is now enforced**: `lint` runs ESLint in check mode (fails on
  violations) with a new `lint:fix` for local auto-fixing; fixed the latent
  lint issues this surfaced across the codebase. (#208)
- **CI** publishes multi-arch Docker images (`linux/amd64` + `linux/arm64`).
  Closes #164. (#166)

### Added

- Documented the API key management endpoints. Closes #110. (#130)
- Indonesian Docker deployment guide and an API-spec diagram fix. (#188, #189)

### Dependencies

- Dependabot minor/patch group (NestJS, BullMQ, Bull Board, helmet, ioredis,
  etc.) and `@types/uuid` v11. (#194, #143)

### Upgrade notes

- **Infrastructure endpoints are now ADMIN-only.** Integrations calling
  `/api/infra/config|restart|export-data|import-data|storage/*` with a
  non-admin key will now receive an auth error; use an ADMIN key.
- **Reverse-proxy + per-key `allowedIps`**: if you run behind Traefik/nginx and
  restrict keys by IP, set `TRUSTED_PROXIES` (e.g. `TRUSTED_PROXIES=172.18.0.0/16`)
  so the real client IP is resolved; otherwise `X-Forwarded-For` is ignored.

## [0.1.6] - 2026-05-17

### Fixed

- **PostgreSQL migration crash**: `AddMessageStatus1770108659848` migration contained hardcoded
  SQLite-specific raw SQL (`datetime` type, `datetime('now')` function) that PostgreSQL doesn't
  recognize. Migration now detects database type at runtime and uses appropriate SQL syntax.
  SQLite path is byte-for-byte identical to the original (zero regression). PostgreSQL path uses
  `timestamp` / `NOW()` / `DEFAULT true` / inline FK constraints. Fixes #59, #62.

### Changed

- **Version badge sync**: Updated version badges in `README.md` (was 0.1.4), `docs/README.md`
  (was 0.1.0), and Swagger API docs (was 0.1.0) to 0.1.6.
- **Dependency updates**: Merged Dependabot PRs for 12 npm packages (`@aws-sdk/client-s3`,
  `@nestjs/swagger`, `bullmq`, `class-validator`, `tar-stream`, `typeorm`, `@types/node`,
  `eslint`, `globals`, `jest`, `typescript-eslint`) and 1 dashboard package (`globals`).
- **GitHub Actions**: Upgraded `docker/setup-buildx-action` v3→v4, `codecov/codecov-action` v5→v6,
  `docker/login-action` v3→v4, `docker/metadata-action` v5→v6, `actions/upload-artifact` v6→v7.

## [0.1.5] - 2026-04-27

### Fixed

- **First-boot crash on SQLite**: Data DB now defaults to `synchronize=true` for SQLite so the embedded
  database "just works" on first boot. Resolves `SQLITE_ERROR: no such table: sessions` that appeared on
  fresh installs without `DATABASE_SYNCHRONIZE=true`.
- **PostgreSQL boot crash on `main` connection**: `AuditLog.metadata` now uses `simple-json` instead of
  the dynamic `jsonColumnType()`. The `main` connection is always SQLite, so it must not switch to
  `jsonb` when `DATABASE_TYPE=postgres`. Fixes `DataTypeNotSupportedError: Data type "jsonb" in
"AuditLog.metadata" is not supported by "sqlite" database`.
- **Operator env vars ignored**: `data/.env.generated` no longer overrides `process.env` or project
  `.env`. Loading order is now `process env > .env > data/.env.generated`, so values from Docker /
  shell / systemd take precedence over Dashboard-saved config.

### Changed

- **Auto-run migrations on boot**: PostgreSQL data DB now runs pending migrations automatically; SQLite
  also runs migrations when the user opts out of `synchronize`.
- **Production migration scripts**: Added `migration:run:prod`, `migration:revert:prod`, and
  `migration:show:prod` that operate from `dist/` so they can be executed inside the production
  container (which strips `ts-node`).

## [0.1.4] - 2026-02-26

### Changed

- **ESLint 10 upgrade**: Upgraded `eslint` and `@eslint/js` from v9 to v10 in both root and dashboard
- **Dependency updates**: Merged Dependabot PRs for 6 root packages, 2 dashboard packages, and `@types/node` 24→25
- **Dashboard peer deps**: Added `.npmrc` with `legacy-peer-deps=true` for `eslint-plugin-react-hooks` ESLint 10 compatibility

### Fixed

- **Dashboard lint**: Fixed `no-useless-assignment` error in `Infrastructure.tsx` caught by ESLint 10's new rule
- **Auto-formatting**: Applied Prettier fix to `whatsapp-web-js.types.ts`

## [0.1.3] - 2026-02-18

### Fixed

- **Node 22 LTS upgrade**: Upgraded CI, release workflow, and Dockerfile from Node 20 to Node 22 (current LTS)
- **Lockfile compatibility**: Regenerated `package-lock.json` with npm 10 to match CI runtime
- **TypeScript type conflicts**: Fixed `whatsapp-web.js` type mismatches after dependency update using `Omit<>` pattern
- **ESLint peer dependency**: Pinned `@eslint/js` and `eslint` to v9 to resolve Dependabot-introduced peer conflict
- **CI npm audit**: Changed audit level from `high` to `critical` — high-severity findings are all in unfixable transitive dependencies

### Changed

- **Dependency updates**: Merged Dependabot PRs for 12 npm packages, 6 dashboard packages, and 5 GitHub Actions
- **GitHub Actions**: Upgraded `actions/checkout` v4→v6, `actions/setup-node` v4→v6, `actions/upload-artifact` v4→v6, `docker/build-push-action` v5→v6, `codecov/codecov-action` v4→v5

## [0.1.2] - 2026-02-18

### Fixed

- **[P1] Database safety**: Default `DATABASE_SYNCHRONIZE` to false to prevent auto-schema changes in production
- **[P1] Graceful shutdown**: Replace `process.exit()` with ShutdownService callback pattern
- **[P1] PostgreSQL types**: Use native `jsonb` and `timestamp` column types when available
- **[P1] Docker orchestration**: Remove duplicate Docker management from main.ts (use DockerService)
- **[P1] Queue stub**: Remove unimplemented message queue processor that always threw errors
- **[P2] Error visibility**: Add proper logging to all 12 empty catch blocks across backend services
- **[P2] Type safety**: Reduce `any` usage from 38 to ~4 with typed interfaces for whatsapp-web.js
- **[P2] Data consistency**: Add TypeORM transaction support for session CRUD; save-before-send pattern for messages
- **[P2] Dashboard crashes**: Add ErrorBoundary with fallback UI instead of white screen of death
- **[P2] Dashboard security**: Move API key from localStorage to sessionStorage (cleared on browser close)
- **[P2] Dashboard UX**: Replace blocking `alert()` calls with Toast notifications
- **[P2] Dashboard error handling**: Add logging to all empty catch blocks in dashboard pages

### Changed

- **Dashboard React Query**: Migrate all 8 pages from manual `useState`/`useEffect` to `@tanstack/react-query` with automatic caching and deduplication
- **Dashboard code splitting**: Route-level lazy loading with `React.lazy` + `Suspense` — main bundle reduced 36%

### Added

- **CI npm audit**: `npm audit --audit-level=high` in CI pipeline to catch vulnerabilities
- **CI coverage threshold**: Jest coverage floor to prevent regression
- **CI dashboard job**: Lint + build for React dashboard runs parallel with backend CI
- **Dependabot**: Automated dependency updates — npm weekly, GitHub Actions monthly

## [0.1.1] - 2026-02-17

### Added

- **Unit Tests**: 94 new tests across auth, session, message, and webhook modules (110 total, ~17% coverage)
- **Release Workflow**: `release.yml` GitHub Actions — tag-triggered with test gate, GitHub Release, and Docker semver tagging
- **SDK Scaffolds**: JavaScript/TypeScript and Python client libraries in `sdk/` directory
- New hook events: `webhook:queued` (after queue add) and `webhook:delivered` (after actual delivery)

### Fixed

- **[P1] Idempotency Key**: Made `generateIdempotencyKey` deterministic by removing `Date.now()`. Keys are now content-based for proper deduplication
- **[P2] Webhook Processor**: Added `lastTriggeredAt` update and `webhook:delivered`/`webhook:error` hooks after queue delivery
- **[P2] Hook Semantics**: Added `webhook:queued` event for queue mode; `webhook:after` now only fires in direct mode
- **[P2] QueueModule DI**: Added `TypeOrmModule.forFeature([Webhook])` and `HooksModule` imports for proper dependency injection
- **[P3] Message Processor**: Changed placeholder to throw error so BullMQ correctly marks job as failed

## [0.1.0] - 2026-02-05

### 🎉 Initial Release

OpenWA v0.1.0 is the first stable release featuring a complete WhatsApp API Gateway with all core functionality.

### Core Features

- **REST API** for WhatsApp operations
- **Multi-session** support with concurrent session handling
- **Web Dashboard** for visual management
- **WebSocket** real-time events via Socket.IO
- **API Key Authentication** with role-based permissions
- **Webhook System** with HMAC signatures and queue-based retries

### Messaging

- Send/receive text, image, video, audio, document messages
- Message reactions and replies
- Bulk messaging with rate limiting
- Location and contact sharing
- Sticker support

### Advanced Features

- **Groups API** - Full CRUD operations
- **Channels/Newsletter** support
- **Labels Management**
- **Catalog API** for product management
- **Status/Stories** support
- **Proxy per Session** configuration
- **Plugin System** for extensibility

### Infrastructure

- SQLite (development) and PostgreSQL (production) support
- Redis queue for webhook delivery (optional)
- S3/MinIO storage for media (optional)
- Docker + Docker Compose deployment
- Traefik reverse proxy integration
- Health check endpoints
- Zero-config onboarding with auto-generated API key

### Security

- API key authentication with SHA-256 hashing
- Rate limiting (configurable)
- CIDR IP whitelisting
- CORS configuration
- Helmet security headers
- Audit logging for all operations

### Dashboard

- Session management with QR code display
- Webhook configuration and testing
- API key management
- Message tester for debugging
- Infrastructure status monitoring
- Audit logs viewer
- Plugin management

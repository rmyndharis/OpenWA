# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A WhatsApp-initiated unlink now leaves a durable audit record** — the disconnect reason previously reached only the log, the webhook and the socket, so once the process restarted an unlink was indistinguishable over the API from an ordinary network drop; transient drops stay unaudited, so a reconnect storm still writes nothing.
- **The Go SDK has its first semantic version, `sdk/go/v0.2.0`** — until now the module proxy only served pseudo-versions, so callers could not pin a release at all.
- **`rmyndharis-openwa` 0.2.0 on PyPI** — the first release through the trusted-publishing workflow, carrying everything the Python SDK gained since 0.1.0 in June.
- **`rmyndharis/openwa` 0.2.0 on Packagist** — the first versioned PHP release since June; Composer users on a stable constraint were pinned to 0.1.0 while only `dev-main` moved.

### Changed

- **An API request body with a `Content-Encoding` other than `identity` is now refused with `415`** — the aggregate in-flight body cap counts wire bytes, so a compressed body was admitted on its compressed size and then inflated past the memory it was supposed to bound.

### Fixed

- **A WhatsApp-initiated unlink now clears a session's stored credentials once rather than twice** — whatsapp-web.js can raise the logout event more than once for a single unlink and nothing deduplicated it, so the repeats raced each other and a still-open browser into the `ENOTEMPTY` failure the removal now carries the retry budget to survive.
- **A data import now carries each session's ownership lease by its remaining time instead of its original deadline** — a restore re-applied the deadline unchanged, so one that ran longer than a claim had left committed that claim as expired, including claims held by other nodes whose engines never stopped.
- **A refused data import no longer offers a retry that stops live engines** — the one refusal whose retry is destructive now carries `IMPORT_WOULD_ORPHAN_ENGINES` and the dashboard matches it positively, so a refusal that only asks the operator to wait can no longer present a confirm whose OK re-runs the replace-all with `stopOrphans=true`.
- **A data import is refused with `409` when another transaction holds the connection** — on SQLite it would otherwise nest inside that transaction and commit into it rather than to disk, so a restore reported as successful could vanish with that transaction's rollback.
- **A second data import while one is running is now refused with `409`** — on SQLite both shared a single transaction, so the second one's rollback discarded a restore the first had already reported as successful.
- **A replace-all data import no longer disturbs the engines it left running** — the restore dropped each session's ownership lease and, on SQLite, the heartbeat could read the half-applied transaction, so a renewal concluded the claim was lost and tore down engines that had never stopped.

## [0.14.2] - 2026-08-06

### Added

- **The JavaScript SDK now publishes to npm from CI** via Trusted Publishing (OIDC) on a `js-sdk-v*` tag — no npm token exists anywhere, and every release carries build provenance. First release through it: `@rmyndharis/openwa@0.2.0`, carrying everything added since 0.1.0 in June.
- **The Python SDK now publishes to PyPI from CI** via Trusted Publishing (OIDC) on a `py-sdk-v*` tag — no PyPI token exists anywhere, matching the JavaScript SDK's release path.
- **The PHP SDK now cuts versioned releases from CI** on a `php-sdk-v*` tag — it tags the Packagist mirror, which previously only ever tracked `dev-main` because nothing propagated a version.
- **The Go SDK documents how it is released** — tags must carry the `sdk/go/` module prefix, so a bare `v*` app tag never publishes it and callers can finally pin a version instead of a pseudo-version.

### Fixed

- **The Java SDK release guide described the opposite of what the workflow does** — it promised a missing publish secret makes the run a harmless no-op, while the guard has since been a hard failure by design.
- **A whatsapp-web.js session failing with `Execution context was destroyed` showed a bare Puppeteer error with no next step** — the advisory naming the likely stale browser profile went only to the server log, so the session card now carries a short form of it too.
- **Infrastructure reported "Pinned by an environment variable" for any unapplied change, without naming the variable** — the gateway now reports which settings a higher-precedence layer actually supplies, so a real pin names its variable, a saved-but-not-restarted change says so instead, and the Engine card gained the notice it never had.

## [0.14.1] - 2026-08-05

### Added

- **Plugins can ask for a link preview** — `ConversationSendEnvelope` gained `linkPreview`, forwarded on a plain text send (ignored on media, location and quoted sends); since 0.14.0 made Baileys previews opt-in, a plugin relaying a URL had no way to restore the card.

### Fixed

- **Swagger "Try it out" called `http://localhost:2785` instead of the host that served the docs**, failing with `Failed to fetch` anywhere else — a relative server is now listed first, so it resolves to the serving origin.
- **Sending to a number WhatsApp cannot resolve returned `500`** on the whatsapp-web.js engine — it now answers a terminal `400` naming the recipient and both possible causes, so callers that retried the old 500 should stop.
- **Swagger "Try it out" on `send-text` always returned `400`** — the sampled body paired `linkPreview: false` with a `customLinkPreview`, which the endpoint rejects; the operation now ships explicit request-body examples.
- **Swagger "Try it out" on the media routes uploaded the literal string `"string"`** — the sampled body carried both `url` and `base64`, and base64 wins; each route now ships an explicit example with a single media source.
- **A malformed `mentions` entry returned an undiagnosable `500`** — only type and length were checked, so junk reached WhatsApp Web's WID parser; entries are now validated as individual WIDs (`@c.us`, `@s.whatsapp.net`, `@lid`) and rejected with a `400`.
- **Documentation understated the MCP surface** — the tool count is 51 rather than ~39 (README and the architecture diagram), labels and automation-rule reads ship by default instead of being planned, and the Session row lists both presence tools.

## [0.14.0] - 2026-08-05

### Added

- **Autoreply rules** — per-session single-message autoreplies under `/api/sessions/:id/automation-rules`; conditions use the webhook filter format, the reply goes through the normal send path, and `fromMe`/freshness/per-chat-cooldown guards bound reply loops.
- **Message & chat management** — pin/unpin and star/unstar messages, archive/unarchive chats, clear a chat without deleting it, and vote on polls (whatsapp-web.js).
- **Contacts, groups & channels** — save/edit/remove addressbook contacts; read/set/remove a group picture; `memberAddMode` group setting; preview a group from its invite code before joining; create/delete/mute channels.
- **Labels** — create, rename, recolour and delete labels; eight label agent tools for MCP (four read-only, four write).
- **Presence & calls** — subscribe to presence (`presence.update`, online/typing) and receive call-outcome events (`call.accepted`, `call.rejected`, `call.missed`).
- **Send options** — `linkPreview` toggle on `send-text`, plus a caller-supplied `customLinkPreview` on Baileys.
- **Media & status** — server-side media conversion (audio→Ogg/Opus, video→MP4) via `ffmpeg` (`MEDIA_CONVERSION_ENABLED`); post an audio status as a voice note; archive chat media to the file store and fetch it back after delivery (`CHAT_MEDIA_ARCHIVE_ENABLED`).
- **Opt-in send pacing** (`SEND_PACING_ENABLED`) — warm-up ramp, daily caps, a failure breaker, and a cold-reachout budget that also bounds group participant adds; enforcement is recorded in the audit log.
- **Account restrictions surfaced** — WhatsApp-imposed restrictions appear on the session (API + `session.restriction` webhook + dashboard badge) instead of a generic error.
- **SDK coverage for the new surface** — the JavaScript, Python, Go, Java and PHP SDKs all gained this release's new calls: pin/star a message, poll voting, archive and clear a chat, labels, channels, presence subscription, group picture / join-info / member-add mode, addressbook contacts, server-side media conversion and voice status. Autoreply rules are REST-only for now.
- **Horizontal-scaling groundwork (opt-in)** — sessions record their owning process via a renewed lease so two replicas cannot both start one; a node only reaps the in-flight bulk batches of sessions it may claim, and a data import reports the sessions another node is running; a dead node's sessions are adopted automatically once the lease lapses (`SESSION_TAKEOVER_SWEEP_MS`); session-scoped requests are forwarded to the owning node when each node sets `NODE_URL`; and WebSocket events fan out across replicas when `REDIS_ENABLED=true`.

### Changed

- Built under the full TypeScript `strict` family, with per-module test-coverage floors across the codebase.
- The official Docker image now installs `ffmpeg` (~210 MB larger, measured with `--no-install-recommends`). It backs the opt-in media-conversion endpoints and is installed unconditionally, so the binary is present even though `MEDIA_CONVERSION_ENABLED` still defaults to off. It is the Debian package rather than a bundled static build so codec CVEs arrive through the same security stream as the rest of the image.
- `session.restriction` is now socket-subscribable as well as webhook-delivered, and the dashboard session card picks up a restriction (or its lift) live instead of only on a page reload.
- ⚠️ **Breaking (behavior).** Eager status backfill on session ready is now opt-in (`STATUS_SEED_ON_READY`, default off): the immediate `status@broadcast` read could make some freshly paired whatsapp-web.js accounts lose the companion at WhatsApp Web's first scheduled reload. Statuses posted before a session connects are therefore no longer backfilled unless you set `STATUS_SEED_ON_READY=true`; live status events are unaffected either way. Thanks @duckvhuynh.
- ⚠️ **Breaking (behavior).** Link previews are opt-in on the Baileys engine. Sends carrying a URL previously produced a preview card because the engine's own generator ran by default; they now go out without one unless the request passes `linkPreview: true` (or a `customLinkPreview`). This restores the documented engine default and removes a blocking outbound fetch from every URL-bearing send — which cost a bulk campaign minutes — but recipients of an unchanged integration will see plain links where a preview card used to appear.

### Fixed

- **Status posting on the whatsapp-web.js engine** — current WhatsApp Web had broken text and media status outright; the postinstall patcher restores both. Text, image, video and voice status post again.
- **whatsapp-web.js sessions could report "ready" with a dead inbound pipeline** after a warm restart, silently dropping incoming messages. The adapter now refuses to promote a session whose event bridge never attached, reloading the page once and failing loudly (keeping credentials) if it stays dead.
- **Baileys delete-chat, mark-unread and delete-for-me silently did nothing on individual (1:1) chats** — the neutral id was not folded to the engine form used as the app-state key.
- **Voice notes on the Baileys engine now carry a waveform.**
- The webhook producer enqueues idempotently, and the bundled Redis is pinned `--maxmemory-policy noeviction` so queued jobs are not silently dropped.
- A media-storage root the app cannot write to is caught at boot with a clear error, instead of failing on the first write (#1066).
- The `postinstall` hook no longer aborts with `EALLOWSCRIPTS` under npm 11 when the user's `.npmrc` sets `allow-scripts=true`: npm exports that as `npm_config_allow_scripts`, which npm 11 refuses in the nested dashboard install. The hook now strips it from the environment passed to each nested step. Thanks @configurowebmax.
- The bundled `docker-compose.yml` now forwards the `SEND_PACING_*`, `MEDIA_CONVERSION_*`/`FFMPEG_PATH` and session-ownership (`NODE_ID`, `NODE_URL`, lease/sweep) variables — previously these features could not be enabled from `.env` in a compose deployment at all.
- The four label write tools (`LabelUpsert`, `LabelDelete`, `LabelAddToChat`, `LabelRemoveFromChat`) answered `Internal error` over MCP even though the write had succeeded on WhatsApp, prompting agents to retry a completed operation; they now return `{ success: true }`.
- **Boot validation covers the lease and routing knobs.** A heartbeat that is not comfortably under half the lease TTL (renewals landing after the claim lapsed, so peers adopt sessions from a healthy node), a `NODE_URL` that is scheme-less or carries embedded credentials, a non-integer `AUTOMATION_MAX_PER_SESSION`, and a non-positive media-conversion knob are now boot errors instead of silent fallbacks or a 500 on the first forward. Forwarded responses also relay the owner's `Retry-After`/`X-RateLimit-*`, and an unusable owner URL answers 503 rather than 500.
- **Autoreply rules gain a per-session cap** (`AUTOMATION_MAX_PER_SESSION`, default 32, `0` = unlimited), mirroring the webhook fan-out cap's shape (`WEBHOOK_MAX_PER_SESSION`, default 16): every inbound message is evaluated against every rule of its session.
- The cold-reachout probe recognises a bare phone number, so a known contact passed without a JID suffix is no longer charged as a stranger; a voice status accepts `backgroundColor`; and a graceful shutdown no longer logs a handful of Redis unsubscribe errors.
- **Security (multi-node routing only): the session forwarder could be aimed at any origin.** HTTP/1.1's absolute-form request target (`GET http://elsewhere/api/sessions/x`) is matched by the router and left verbatim in the request URL, where resolving it against the owner's address discards that address — an authenticated caller could make a node forward their request, API key attached, to an origin of their choosing and read the response. The forward target is now rebuilt from the owner's origin plus the request's path and query, so the destination cannot be influenced at all. Deployments without `NODE_URL` (the default) were never affected: the forwarder is inert there.
- **`stop` and `delete` are fenced against a session a live peer is running.** Only `start` was claim-checked, and neither of those two needs a local engine, so a request landing on the wrong node — routine when session ownership is configured but request routing is not — wrote `disconnected` over a peer's live session or deleted its row and credentials while the peer's engine kept running. Both now answer 409; a lapsed claim still proceeds, since taking over is what the claim rule allows.
- **Multi-node ownership races closed:** a `stop` landing while a `start` is mid-launch no longer hands back the claim under a live engine (which left the engine unclaimed and startable a second time elsewhere), a failed start no longer pins its session to that node forever, and a deliberate teardown of a session whose crashed owner's lease had lapsed now really leaves it down instead of being re-adopted by the takeover sweep. Successful forwarded requests also stop logging a spurious error.
- **The send breaker only counts failures that reached WhatsApp.** Client-fault and engine-state errors raised inside the send call — a blocked media URL, a capability the engine lacks, a disconnected socket, a malformed status post — no longer accumulate toward it, so a client sending bad requests can no longer 429 every send on a healthy session for the cooldown. Applied to single sends, bulk batches and status posts alike.
- **`send-sticker` with a video mimetype works in the official image.** whatsapp-web.js converts video to animated WebP through `ffmpeg`, which the image did not ship, so a documented-as-supported call always failed there; the image now carries the binary.
- **Backup/restore covers `automation_rules`.** The table was in neither the export nor the import while the restore's session wipe cascade-deletes it, so a documented backup→restore silently destroyed every autoreply rule.
- Media conversion answers 400 (not 500) for a blocked, unreachable or oversized input URL; `POST /api/sessions/:sessionId/channels/:channelId/mute` refuses a non-channel id instead of muting an ordinary chat forever; listing a label's chats and previewing an unknown group invite answer 404 instead of 500 on whatsapp-web.js; a refused disappearing-message change answers 403; voice-status media is served as audio rather than octet-stream; `PUT /labels/:id` treats explicit `null` fields as an empty body; and an addressbook write with a bare phone number is qualified before it reaches Baileys.
- **Small correctness batch:** the cold-reachout history probe matches both user-id spellings (a known contact addressed the other way no longer reads as cold), an expired account-restriction stops badging the session, ending a ringing call clears its live handle, `PUT /labels/:id` refuses an empty body, addressbook writes refuse group/newsletter/broadcast ids (not just `@lid`), and the channel endpoints' OpenAPI docs state the real 403 refusal status instead of 422.
- **SDKs:** the Go SDK encodes a nil poll-vote `options` as `[]` (clearing a vote now works from the zero value), the Java `GroupSettings` and `SendVoiceStatusRequest` records keep back-compat constructors after gaining a field, and all five SDKs expose the voice-status `backgroundColor` the server accepts.
- The dashboard status viewer now plays a voice status with an audio player instead of rendering it as a broken image, the JS SDK's `StatusRecord.type` includes `'voice'`, and the SDK README's method tables and three misplaced doc comments were brought back in line with the actual surface.
- Fetching a status's media that S3 retention already removed answers 404 instead of 500 (the local-storage miss already did), and server-side media conversion is bounded to `MEDIA_CONVERSION_CONCURRENCY` (default 2) concurrent `ffmpeg` processes with a short queue — saturation answers 503 instead of stacking processes.
- **Baileys message-action targeting:** star/pin/unpin/react/delete now verify the stored message belongs to the requested chat (a mismatched pair answered success while writing under the wrong conversation), pin/unpin/react/delete resolve LID-migrated contacts like every other send, and tagging/untagging a chat's label folds the neutral id to the engine form so the write lands on the real chat instead of a phantom index.
- **whatsapp-web.js raw-id extraction hardening:** every raw WhatsApp Web id is now read through one helper that accepts the renamed property, so a minified WA Web build no longer breaks id-bearing reads. Listing a label's chats no longer 500s when a labelled chat was deleted; the channel list, channel creation and group-invite preview stop returning ids as the literal string `"undefined"` or turning a valid invite preview into a false 404; the number-registration check (`GET /api/sessions/:sessionId/contacts/check/:number`) stops reporting every number as unregistered; and group participants, the group owner and the "am I admin" comparison resolve again instead of yielding `"undefined"` ids.
- **Baileys refusals now answer their documented statuses instead of 500:** an invalid/expired group invite previews as 404, admin-refused group writes (subject, description, announce/locked, picture, member-add mode) and refused channel writes (create/delete/mute) answer 403 — matching the whatsapp-web.js engine. Transport failures still propagate unchanged.
- **Multi-node request routing hardening:** forwarded requests now carry the client address in `x-forwarded-for` (so `allowedIps` keys and per-IP throttling see the real client once peer nodes are listed in `TRUSTED_PROXIES`), a malformed session id no longer 500s on Postgres in routed mode, and the client-settable forwarded marker is verified — a marked request landing on a live non-owner answers 409 instead of executing there.
- **Send pacing accounting:** forwards now pass through the cold-reachout gate (they were ungated while still draining the budget), replying to someone who wrote first today no longer spends the cold budget, and a pacing 429 inside a bulk batch is recorded as `SEND_PACING_LIMITED` instead of a generic `SEND_FAILED`.
- **Multi-node: a session claim could outlive its engine and pin the session to one node forever.** A failed start, a logout, a force-kill or an exhausted reconnect kept the ownership claim, and the heartbeat renewed it indefinitely — the session could not be started on any peer and the takeover sweep never saw it. Claims are now released on every teardown path, and the heartbeat only renews claims that still cover a live engine, an in-flight start or a pending reconnect. Starting a nonexistent session also answers 404 again instead of a misleading 409 "running on another node".
- Corrected column names in `docs/05-database-design.md`.
- Documentation refresh: capability-matrix and MCP tool counts, the `sessions` ownership columns and the `automation_rules` table in the database doc (both now covered by the schema-accuracy gate), the socket-subscribable event list, and precise wording for send-pacing scope and failover engine-overlap.

### Security

- Resolved five advisories in the production dependency tree via transitive bumps (`brace-expansion`, `fast-uri`, `hono`, `ip-address`, `socket.io-parser`); no direct dependency changed.

## [0.13.0] - 2026-08-03

### Added

- `BAILEYS_MARK_ONLINE_ON_CONNECT=false` keeps phone push notifications alive while a Baileys gateway is connected (default `true`). (#871)
- Catalog endpoints now work on the Baileys engine: `GET /catalog`, `GET /catalog/products`, `GET /catalog/products/:id` and `POST /messages/send-product`; `send-catalog` stays `501`, whatsapp-web.js unchanged. (#905)
- Helm chart for Kubernetes deployments under `charts/openwa/`. Closes #695.

### Fixed

- A definitive `null` resolution from the engine now overwrites a stale `lid -> phone` mapping so a contact who hides their number is no longer attributed to the old number. (#1058)
- API keys are now trimmed once in `validateApiKey`, so a key pasted with a stray space authenticates on the WebSocket as well as REST.
- Production image build now chowns only `./data` instead of all of `/app`, eliminating the slow full-`node_modules` chown. (#1045)

## [0.12.5] - 2026-08-03

Internal decomposition follow-up to 0.12.4 with no user- or API-visible change; `openapi.json` is identical (129 paths, 68 schemas).

### Changed

- Finished decomposing three oversized units: `infra-data.controller.ts` 997→467, `infra-config.controller.ts` 703→487, and `mapMessage` 186→44 lines.
- Dashboard `Infrastructure.tsx` reduced from 17 to 1 piece of component state and `Sessions.tsx` from 20 to 10, moved into custom hooks with no child components extracted.
- Added dedicated specs for `MessageProjector` and `BaileysEvents`, and a load-time completeness check for the data-import descriptor table; backend suite 4,051→4,070, dashboard 266→272.

## [0.12.4] - 2026-08-02

Large internal decomposition (~30,000 lines, mostly code motion); the HTTP contract is unchanged (129 paths, 68 schemas identical to 0.12.3). The largest single method shrank from 8,366 to 4,819 characters.

### Changed

- Renamed 12 `operationId` values in `openapi.json` after splitting `InfraController` into `InfraStatusController`, `InfraConfigController`, `InfraDataController` and `InfraStorageController`; URLs and schemas are byte-identical, only generated-client method names change.
- A file attached but not yet sent in Dashboard > Chats is now dropped when opening a different conversation or switching session; reopening the same room still keeps it.

## [0.12.3] - 2026-08-01

### Fixed

- `POST /api/plugins/{id}/disable` now clears the boot-enable decision when the plugin is not loaded instead of answering 404, so a plugin with missing code can be switched off.
- `clearBlankEnv` now clears the eight blank-forwarded settings that had drifted from `docker-compose.yml` (`AUTO_START_SESSIONS`, `BODY_SIZE_LIMIT`, `API_MASTER_KEY`, `TRUSTED_PROXIES`, `CSP_UPGRADE_INSECURE_REQUESTS`, `WWEBJS_WEB_VERSION`, `WWEBJS_WEB_VERSION_REMOTE_PATH`, `WWEBJS_AUTH_TIMEOUT_MS`), so they take effect from `data/.env.generated`. (#981)
- The Infrastructure restart modal now polls `GET /api/health/ready` instead of `/api/infra/health` and derives its deadline from the server estimate, so it reloads only once the new process is serving. (#1019)
- `backup.sh` now resolves paths through environment, `./.env`, then `<data dir>/.env.generated` (skipping and reporting values containing a quote or `#`), so a dashboard-configured install is backed up at its real paths.
- `.env.example` now comments out the 23 blank-forwarded settings the dashboard owns, so copying it no longer pins them; a test derives the set from both compose files. (`POSTGRES_BUILTIN`, `REDIS_BUILTIN`, `MINIO_BUILTIN`, `DATABASE_SSL`, `DATABASE_SSL_REJECT_UNAUTHORIZED` are still pinned.)
- A link posted to a Channel gets a sharp preview thumbnail again on the whatsapp-web.js engine, applied as a strict dependency patch. (#1006)

## [0.12.2] - 2026-08-01

### Changed

- The running engine map moved from `SessionService` to `EngineRegistry` (exported from `EngineModule`), so ten feature services reach the live engine through a narrow port and eight modules no longer import `SessionModule`; `openapi.json` unchanged.
- Lifted six self-contained concerns out of `SessionService` (`SessionLidResolver`, `decideReconnect()`, `SessionLivenessWatchdog`, `KeyedMutationQueue`, `MessageProjector`, `SessionErrorStore`), shrinking `initializeEngine` from 801 to 324 lines and adding 69 tests; behaviour unchanged.
- Moved the engine-init timeout parse and derivation into `engine/engine-init-timeout.ts` so the session lifecycle no longer imports the whatsapp-web.js adapter for it; derived deadline identical.
- `data/.env.generated` path and parse now owned by `generated-env.ts` instead of being rebuilt at three `InfraController` readers; pure code motion.

### Fixed

- `PLUGINS_DIR` now defaults to `<dataDir>/plugins`, matching the registry tree, with the old `./plugins` kept as a compatibility fallback when unset; fixes plugin code vanishing on Docker recreate.
- The boot scope reconciler is now additive: it only adds a row's scope and never overwrites the sessions an operator bound via `PUT /api/plugins/{id}/sessions`; a scope matching no session is logged once (`scope_binding_session_missing`).
- Plugin last-hook-error is now cleared where a worker generation starts, so plugin health no longer reports an error inherited from a dead worker.
- A rolled-back `POST /api/infra/import-data` now reports the orphan engines it actually stopped instead of hardcoded empty arrays; response shape and `openapi.json` unchanged.
- A missing dashboard asset now returns 404 instead of the SPA shell (`ServeStaticModule` catch-all disabled), also fixing client-side routes 404ing when the install path contains a dot-segment.
- `scripts/smoke-test-non-root.sh` had its UTF-8 BOM removed and both smoke-test scripts got the executable bit; CI shellcheck now covers every script in `scripts/`.
- Bootstrap key-file operations now have one owner (`bootstrap-key-file.ts`) honouring a `BOOTSTRAP_KEY_FILE` override, so an e2e run no longer rewrites the developer's `data/.api-key`.
- Opening or closing the QR modal no longer rebuilds the session start/stop/logout handlers (functional updater removes the `qrData` dependency).
- A message for a chat the sidebar lacks now refetches the chat list once, not twice under StrictMode; sidebar reducers moved to `utils/chatList.ts`.
- A stray directory under `data/plugins` without a `manifest.json` now logs a clearer skip message; the `manifest_missing` action key is unchanged.
- `.env.example` now records that `AUTO_START_SESSIONS` began taking effect under Docker Compose in v0.12.0.

### Removed

- `scripts/openwa.sh`, an orchestration helper superseded by the in-process Docker orchestration on `/api/infra`.

### Security

- ⚠️ Four unfixed arm64-only Chromium CVEs (`CVE-2026-16804`, `-16805`, `-16806`, `-16807`) are accepted in the `linux/arm64` image; no fixed Debian package exists yet, recorded in `.trivyignore` with the removal condition. The amd64 image is unaffected.
- Registering a plugin search provider now requires the new `search:provide` permission; a plugin without it is refused before reaching the registry and logs `sandbox_search_provider_denied`. Action required: add `"permissions": ["search:provide"]` to search-provider plugin manifests.

## [0.12.1] - 2026-07-30

### Added

- The session payload now reports `engineLoaded` (whether the gateway holds a live engine); the dashboard derives Stop/Unlink/Force-Kill/Start from it. Added to `openapi.json` and the JavaScript, Python, Go and Java SDKs as a new optional field.
- The whatsapp-web.js onboarding modal can be dismissed on a non-English WhatsApp Web: Chromium launches with a pinned `--lang`, and `WWEBJS_ONBOARDING_CONTINUE_LABELS` accepts additional confirm labels.

### Fixed

- A session in `action_required` is now probed by the liveness watchdog, but the result is observed only and never triggers reconnect or a disconnect; the warning is emitted once per unresponsive stretch.
- A delete refused with `409 SESSION_NAME_TEARDOWN_PENDING` now reconciles the surviving row to `disconnected` before the refusal propagates.
- A WhatsApp-initiated logout arriving during an unrelated teardown now surfaces its credential removal before the latch check, so a following `start()` cannot have its fresh credentials deleted.
- The dashboard now applies the authoritative start response as returned instead of fabricating `status: 'connecting'`.
- Removed two session statuses the gateway never emits (`connecting`, `idle`) and their dead branches.
- Internal tidying with no behaviour change: a caller-initiated logout no longer registers its credential removal twice, and a redundant engine-ownership check in the pre-initialize window was removed.

## [0.12.0] - 2026-07-30

The session-lifecycle security hardening release: lifecycle and logout operations enforce an evidence-accurate contract, teardown fences fail closed, and plugin authorization requires an unrestricted ADMIN key.

### Added

- whatsapp-web.js auto-dismisses a new account's "What's new on WhatsApp Web" onboarding modal, clicking Continue best-effort; English-only, fails silent on other locales (#982, #1003).
- Sessions that stay stuck on the modal after repeated clicks move to a new `action_required` status carrying a reason via `lastError`, surfaced through webhooks, WebSocket, dashboard, and all five SDKs (#982, #1003).
- `POST /sessions/:id/logout` unlinks the device from the WhatsApp account; requires a started session, returns 400 if no engine is loaded (#984, #1003).
- Logout returns `200` only when both the engine-native unlink and local credential cleanup complete; reconnecting afterward always requires a fresh QR (#984, #1003).
- An incomplete logout stops the session locally, clears `phone`, returns `502` with `SESSION_LOGOUT_INCOMPLETE`, and writes no `SESSION_LOGGED_OUT` audit row (#993).
- All five SDKs (JS, Python, Go, PHP, Java) and the dashboard's API client gain a session logout operation (#984).
- The dashboard's Sessions page gains an Unlink action wired to the logout endpoint, labelled "Unlink" and localized across all twelve locales (#984, #1003).

### Fixed

- `send-document` on whatsapp-web.js now forces the document form so `image/*`, `video/*` and `audio/*` payloads arrive as documents; withheld for `status@broadcast` and broadcast lists; missing filename defaults to `file` (#989, #996, #1000, #1003).
- A remote-URL send now keeps the caller-declared mimetype and filename instead of deriving them from the response; stickers keep the fetched content-type.
- A wedged logout can no longer land its destructive `fs.rm` on a freshly re-paired profile; start and delete fail closed with a retryable `409` (`SESSION_NAME_TEARDOWN_PENDING`) while cleanup is pending (#994).
- `npm install` from source no longer fails on native Windows and the whatsapp-web.js backport applies there: patch normalized to LF, `.gitattributes` rule added, and a parse refusal treated as "nothing written" so `--best-effort` degrades (#889, #1003).
- Native Windows and npm 12 source installs no longer fail during dependency setup: reject-file paths normalized before comparison, and `libsignal@6.0.0` resolved from its npm registry tarball to avoid `EALLOWGIT`.
- `AUTO_START_SESSIONS` set in `.env` now reaches the container under the bundled production compose.
- The whatsapp-web.js adapter now logs a warning naming the directory and session when it wipes stored credentials, and the readiness-timeout warning carries the session id (#981).
- A whatsapp-web.js session no longer publishes a QR or `authenticated` event belonging to the browser it is about to replace after `LOGOUT` (#982).
- A `LOGOUT` disconnect now logs that WhatsApp ran a logout and the device must be re-scanned, with a pointer to check Linked devices (#982).
- The expected Puppeteer rejection following an engine teardown now logs as a warning naming the cause instead of an unhandled-rejection error (#982).
- Service start during Docker orchestration now applies the same managed-profile allowlist as teardown.
- A session cannot be torn down before its engine has finished initializing.
- An async disconnect is now fenced by engine identity, so a superseded client cannot drive a lifecycle transition for its replacement.
- Stuck-auth recovery's 90-second readiness budget is now hoisted above the reconnect loop so it survives reconnects.
- `POST /sessions/:id/force-kill` on a session with no live engine now returns `400` instead of a false `200`; the stale-row reconciliation moves to `POST /sessions/:id/stop`.
- The dashboard reconciles Sessions-page visibility and status from a shared definition of a live engine; FAILED no longer holds a concurrency slot.
- Both bundled compose files forward `PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS` with its secure default.
- The SSRF guard's DNS resolution now honours the caller's `AbortSignal`, so a timeout reads as a timeout and one deadline covers the whole redirect chain.
- The bundled MCP SDK is bumped past the Hono transitive advisory; the MCP wire contract is unchanged.

### Security

- Infrastructure routes (`/api/infra/*`) now reject API keys restricted to specific sessions.
- Plugin installation and lifecycle routes (`/api/plugins/*`) now reject session-restricted keys; full activation replacement (`PUT /api/plugins/:id/sessions`) requires an unrestricted ADMIN key.
- The queue dashboard (`/api/admin/queues`) now refuses session-restricted API keys.
- Cross-session statistics, application settings, and session creation now require a key not restricted to specific sessions.
- Redriving a dead-lettered integration delivery now fails closed for session-restricted keys when the instance no longer exists, and filters DLQ rows by stored `sessionId`.
- A pending credential teardown for a session name now fences `start` and `delete` with a retryable `409` (`SESSION_NAME_TEARDOWN_PENDING`).
- Outbound redirect-following downloads (plugin packages and catalog) now validate every hop before connecting, including bare-IP targets, and cap the chain at 5 hops.
- ⚠️ A redirect hop downgrading `https` to `http` on those download paths is now refused; `PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS=true` re-allows that specific hop.
- Added a build-time check that fails when a deployment-wide route is added without refusing session-restricted keys.
- ⚠️ **Breaking (behavior).** Three refusals change behaviour: (1) `403` for session-restricted keys on deployment-global surfaces including `PUT /api/plugins/:id/sessions`; (2) a retryable `409` (`SESSION_NAME_TEARDOWN_PENDING`) from `start`/`delete` during a name-keyed teardown; (3) `400` instead of `200` from `force-kill` with no live engine. Under SemVer 0.x these bump the minor version.

## [0.11.1] - 2026-07-28

### Added

- The Baileys engine now honors the per-session egress proxy (`proxyUrl`: http, https, socks4, socks5, credentialed) on the WebSocket and media transfers; an unusable proxy value now fails session start instead of connecting direct (#859).
- The OpenAPI spec now declares a templated default server `http://{host}:{port}` with `localhost`/`2785` defaults.

### Fixed

- The published OpenAPI spec no longer advertises a `200` the catalog endpoints never return; both adapters throw `501` and the stale declarations are removed.
- The documentation set now matches the shipped implementation: corrected session auth path, compose service name, upgrade runbook, health-check prefix, real config setting names, removed nonexistent endpoints/tooling, doc renumbering (`docs/23`→`docs/30`, capability matrix as `docs/29`), and a working security contact address.
- A source install without the GNU `patch` binary now falls back to `git apply` for the whatsapp-web.js message-id-rename backport, and logs an actionable error at session start if neither applier is present.
- The release runbook in `docs/15` §15.7 now documents the actual single `chore(release)` commit plus annotated tag flow driven by `release.yml`.

## [0.11.0] - 2026-07-27

### Added

- All five SDKs (JS, Python, Go, PHP, Java) gained `sendPoll`, batch `profilePictures`, and status `media` download; webhook filter `value` is now `string | string[] | boolean` with `caseSensitive`, `mentions` accepted on send-text, and non-JSON 2xx responses handled uniformly. (#947)

### Fixed

- S3 storage re-probes on a 60s interval (`S3_REPROBE_INTERVAL_MS`) after a boot-time miss instead of staying on local fallback, and covers the fallback directory in enumeration, totals, and deletes while active. (#945)
- Baileys engine now reports `INITIALIZING` immediately when its socket enters reconnect backoff instead of falsely reporting `READY`. (#944)
- Dashboard clears its React Query cache on logout, validates startup re-auth against `res.ok`, routes `subscribed`/`error` WebSocket frames, and debounces `markChatRead`. (#938)
- Dropped the dead `DELETE: 1` docker-socket-proxy directive; README/SECURITY now document the real threat model, and managed-profile teardown uses a stop-only path reporting per-profile errors. (#934)
- Export/import: optional-table read failures now rethrow (with a `skippedTables` field) instead of producing a false "complete" backup; stripped the Postgres `body_ts` tsvector from exports; added `status_updates` to the backup flow; gunzip/input streams now fail the import instead of crashing; and the `lid -> phone` mirror reloads post-commit. (#927)
- Full-replace restore refuses to orphan a running engine with **409 Conflict** listing affected sessions; pass `stopOrphans: true` or `force: true`. (#927)
- `scripts/backup.sh`/`restore.sh` now resolve DB paths exactly like the app, fail hard on a missing source or incomplete archive, take online-consistent snapshots via `sqlite3 .backup`, and a new `Shell scripts` CI job runs the smoke suite + shellcheck. **Breaking (behavior):** `backup.sh` exits non-zero over an empty/partial archive. (#926)
- Webhook `lastTriggeredAt` update failures no longer flip a delivered event to failed; the dispatch limiter supports `close()`/shutdown drain (`WEBHOOK_SHUTDOWN_DRAIN_MS`); a twice-stalled BullMQ job now records a dead-letter row; `webhook:before` identity fields are re-asserted and the body capped at `WEBHOOK_MAX_PAYLOAD_BYTES` (default 1 MiB). (#933)
- Redis throttler client is now built fail-fast (`enableOfflineQueue: false`, `commandTimeout: 2000ms`) with its own lifecycle and a startup WARN when `WEBHOOK_SHUTDOWN_DRAIN_MS` < `WEBHOOK_TIMEOUT`. **Breaking (behavior):** payloads over 1 MiB are recorded undelivered; Redis slower than 2s degrades to fail-open. (#932)
- A session that exhausts a finite `maxReconnectAttempts` now evicts its dead engine instead of leaking a concurrency slot.
- `cancelBatch` no longer overwrites a terminally FAILED batch to CANCELLED (FAILED added to the terminal-status guard).
- IntegrationModule now imports QueueModule so ingress actually queues when `QUEUE_ENABLED=true`; `ingress_events` rows carry dispatch state and a 60s reconciler (`INGRESS_RECONCILE_*`) replays stuck deliveries; instance teardown checks for an enabled sibling before stripping shared session scope. (#921, #924, #922)
- `message:persisted` now re-fires on every persisted transition (SENT/FAILED) with a `message:deleted` event for echo-merged rows; fixed the history and reactions cURLs in `docs/07-api-collection.md`. (#919, #910)
- Orphan-Chromium sweep now matches the `--openwa-session=<id>` marker token-exactly, so restarting `sales` no longer kills sibling `sales2`. (#923)
- A failed HTTP bind or a rejecting SIGTERM teardown now exits 1 instead of coasting; RED metrics record 401/403/429/404 rejections; a `start()` completing after its row was deleted re-purges both engines' auth dirs. (#949, #961, #952)
- Infra config writes merge per key, drop the old mode's secrets on a builtin→external flip, re-run the production secret assertion at save time (400), and use strictly-coerced DTOs; SQLite path-collision guard, `REDIS_ENABLED` validation, decimal-only numeric env checks, positive-only `WEBHOOK_MAX_PAYLOAD_BYTES`, and a `storage-export-*` boot sweep added. **Breaking (behavior):** partial payloads preserve omitted fields; non-canonical `REDIS_ENABLED` and exponent/hex numeric values fail boot. (#946, #960)
- Bulk batches re-validate rendered payloads post-gate, make all status transitions DB-conditional so CANCELLED stays terminal, and a periodic reaper (`MESSAGE_REAPER_INTERVAL_MS`/`_GRACE_MS`/`_BATCH_SIZE`) marks crash-stuck PENDING rows FAILED. (#955, #958)
- API-key usage deltas merge back on a failed save and flush on shutdown; Bull Board 401/403s and non-GET actions now write audit rows (`QUEUE_BOARD_MUTATED`); the `data/.api-key` bootstrap file is removed when its key no longer validates. (#963)
- Group participant batches capped at 256, template renders capped at `TEMPLATE_RENDER_MAX_CHARS` (default 64 KiB), status media ingest is row-first with `write_failed` recorded and a periodic orphan-file sweep, and the Postgres FTS probe resolves via `to_regclass` under the session `search_path`. **Breaking (behavior):** over-256 batches and over-cap renders now 400. (#964, #966)
- `POST /api/sessions` now maps through `SessionResponseDto`; the OpenAPI exporter pins `SEARCH_ENABLED`/`REDIS_ENABLED` for deterministic output, declares the `calls`/`profile`/`search` tags and metrics Bearer scheme, adds `GET /api/metrics`; README/rate-limit/testing/DB-variable docs corrected. (#953)

### Security

- Added an aggregate in-flight body budget (`INFLIGHT_BODY_BUDGET_BYTES`, default 4× per-request cap) rejecting over-budget requests with 503, with chunked-body reconciliation and a 15s stalled-reservation reaper. (#936)
- WebSocket gateway now enforces three independent limits (per-IP handshake window charged before auth, per-key socket cap, per-token frame bucket), LRU-bounded, with a sampled `RATE_LIMIT_EXCEEDED` audit action. (#937)
- Plugin install now requires `https` and an optional sha256 pin via URL fragment (`#sha256=…`), fail-closed on a mismatch. (#942)
- Dashboard plugin config frame gets an injected meta-CSP (`img-src`/`media-src 'self' data:`, `connect-src 'none'`), and audit-log CSV cells are apostrophe-prefixed against formula injection. **Breaking (behavior):** concurrent sends over the body budget get 503, a 15s-silent connection is dropped, `http://` plugin installs are rejected, and hot-linked config-UI media renders broken. (#939)
- Pinned all 61 workflow `uses:` refs to commit SHAs with Dependabot comments; `:latest` now moves only via `release.yml` after boot-smoke, serialized by a `concurrency:` group with digest-verified promotion. (#940)
- Completed `.dockerignore` (`.git/`, `dashboard/node_modules`, `*.sqlite`, agent workspaces, etc.) with a `check-dockerignore.mjs` CI gate, and extracted `postinstall` to `scripts/postinstall.js` with failure propagation. **Breaking (behavior):** `docker pull openwa:latest` no longer moves on a main merge; `npm install` fails on a broken dashboard/patch. (#943)
- Create-instance and regenerate-secret responses now always start from `maskedView`, unmasking only the two documented "revealed once" fields, so secret-flagged config fields are no longer echoed in plaintext. (#929)
- whatsapp-web.js adapter methods now answer honestly (501 for unwired catalog/subscribe, 403 on refusals, 503 `EngineTransportError` on transport death) with an additive per-participant `results` field. **Breaking (behavior):** callers reading a config secret back get `***`, and clients relying on phantom 2xx see new 4xx/5xx. (#925)
- Plugin ingress routes with `signature.scheme: 'none'` are now rejected unless `ALLOW_UNSIGNED_INGRESS=true` is set.
- `/api/metrics` Bearer and ingress `shared-secret` comparisons now delegate to a `constantTimeEqual` helper that hashes both inputs, no longer leaking the expected token's byte-length.
- Pinned `brace-expansion` to `^5.0.8` (CVE-2026-14257) and `js-yaml` to `^5.2.2` (GHSA-pm4m-ph32-ghv5) via root + dashboard `overrides`.
- Added an `image-scan` release job running `trivy image` on amd64/arm64 that blocks promotion on any fixable HIGH/CRITICAL; the production image now installs npm 12 to clear a critical `node-tar` advisory.
- Session-scoped API keys can no longer escape their fence: a `@RequireUnscopedKey()` marker fences the key-lifecycle controller, instance create/patch/redrive intersect scopes, and plugin `conversation.send` verifies the mapping's `sessionId` matches the envelope. **Breaking (behavior):** session-scoped ADMIN keys get 403 on all key-management routes. (#916, #920)
- Last-usable-admin check now shares one in-process mutex making it race-safe, and webhook media fan-out is bounded by `WEBHOOK_MAX_PER_SESSION` (default 16) and `WEBHOOK_MEDIA_INLINE_MAX_BYTES` (default 1 MiB). **Breaking (behavior):** media over the inline threshold arrives as a marker; registration past the cap returns 400. (#950, #948)
- Plugin sandbox runtime is bounded: capability RPCs time out (`PLUGIN_CAP_TIMEOUT_MS`, default 30s), hook errors surface as rate-limited logs, storage is quota-bounded (`PLUGIN_STORAGE_MAX_BYTES`, default 50 MiB), search results are host-validated, and `conversation.send` `type: 'location'` sends real coordinates. **Breaking (behavior):** malformed plugin search results now 502. (#954)

### Changed

- Added a standalone `IDX_messages_createdAt` index and a `STATS_CACHE_TTL_MS` (default 30s) memo for dashboard stats; ingress replay windows now enforce whenever `timestampHeader` is declared (host-wide `INGRESS_TIMESTAMP_TOLERANCE_SEC`, default 300s), dedup rows retire at 7 days (`INGRESS_DEDUP_RETENTION_DAYS`) with the payload NULLed on outcome. **Breaking (behavior):** stats lag up to `STATS_CACHE_TTL_MS`; a `timestampHeader`-only route now accepts deliveries. (#935, #941)
- Message `from`-filter now also matches group authors (`from` OR `author`), `resolveJidCandidates` is scoped by chat kind, and `DELETE /sessions/:id` purges both engines' auth directories. **Breaking (behavior):** filtering `from` by phone now also returns that person's group messages. (#931, #928)
- Documented ten operator-tunable env vars in `.env.example` (`INGRESS_MAX_ATTEMPTS`, `INGRESS_RETRY_DELAY_MS`, `INGRESS_RETENTION_DAYS`, `SSRF_DNS_TIMEOUT_MS`, `INGRESS_WORKER_CONCURRENCY`, `WEBHOOK_WORKER_CONCURRENCY`, `INBOUND_MEDIA_CONCURRENCY`, `STATUS_MEDIA_MAX_BYTES`, `PLUGIN_DOWNLOAD_MAX_BYTES`, `BULK_MAX_CONCURRENT_BATCHES`), with a shared opt-out parse rule.
- Dockerfile `apt-get install` invocations now use `--no-install-recommends`.
- The in-memory `@lid -> phone` mirror is now LRU-bounded by `LID_MAPPING_CACHE_MAX` (default 5000; `0` restores unbounded).
- The Kubernetes StatefulSet example in `docs/13-horizontal-scaling.md` now sets `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, and `capabilities.drop: ['ALL']`, and bumps the stale image tag.
- The plugin sandboxing doc no longer lists the removed `auto-reply` and `translation` built-ins, naming only the two engine adapters.
- Docs now describe the real default WhatsApp Web version pin (resolved from the `wa-version` registry) and its trust implication; only `WWEBJS_WEB_VERSION=off` selects the first-party build, with a once-per-process WARN at pin time. (#917)
- `BaileysSessionStore`'s five peer-fed maps are now LRU-capped at `BAILEYS_SESSION_STORE_MAX_ENTRIES` (default 5000), chat-history inline media honors an aggregate `CHAT_HISTORY_MEDIA_BUDGET_BYTES` (default 25 MiB) and request abort, and an RFC on wa-version content integrity is open. (#951, #962)
- Nine MCP tool fields now share the REST DTO cap constants (including the 256-participant cap); `GroupAddParticipants` returns per-participant `results`; and the dashboard translates 15 `plugins.*` keys in all 12 locales, uses real plural forms, and moves all 13 modals to the shared accessible Modal. (#959, #965)
- Added a `queue-on` e2e suite proving queued dispatch against a real Redis; DockerService managed containers pin the same MinIO release as compose and set `no-new-privileges`. (#967, #968)

## [0.10.10] - 2026-07-25

### Added

- Text statuses now capture background color and font on ingest (Baileys) and render styled in the dashboard viewer.
- Newly ingested statuses broadcast over the websocket as `status.received` and refresh the Status tab in real time.

### Changed

- `POST /sessions/:id/status/send-text` now accepts the real WhatsApp font enum (0,1,2,6,7,8,9,10) instead of a 0–5 range.

### Fixed

- Data import now carries the `author` column so backup restores keep group sender attribution.
- Group messages persist the participant JID (new `author` column) and the dashboard keys attribution and colors on it, so same-named participants no longer blur together.
- Contacts with both a @lid and a phone identity now appear once in the status list (resolved at read time).
- Status seed pre-gates media downloads at the store's own 10 MB cap instead of the global media cap.
- Status store hardening: `@lid` per-contact queries also match phone-stored rows, lid resolution is guarded to `@lid` inputs, seed-skipped media records `over_cap`, and a post-delete session ingest no longer dispatches `status.received`.
- History-backfilled outgoing group messages are stored with `author` NULL.
- Dashboard follow-through: a websocket reconnect refreshes the statuses list, the webhook editor offers `status.received`, and a styled bubble's timestamp inherits its text color.

## [0.10.9] - 2026-07-24

### Added

- Contact statuses are now readable on both engines and retained for 24 hours; `GET /sessions/:id/status` works on Baileys, and a new `GET /sessions/:id/status/:statusId/media` streams stored media.
- New opt-in `status.received` webhook carrying contact, type, caption, and media flags (no blob).
- The dashboard Status tab is now functional: lists contacts with active statuses, opens a read-only viewer, and posts text or image statuses.
- Group chats now label each incoming message with the sender's name, colored per participant and shown once per run.

### Changed

- Status `recipients` is now optional on the post-status endpoints; Baileys still requires it (400s on empty), whatsapp-web.js no longer needs a placeholder.

### Fixed

- Contact statuses now actually ingest on Baileys (the poster is mapped for `status@broadcast` too, not only group chats).
- `status.received` no longer fires twice for the same status (dispatches only on a genuine new-row insert).
- The status seed skips own and already-expired statuses and survives a bad item.
- Expired statuses are filtered out of the list/per-contact/media endpoints immediately instead of at the next purge.
- Status media is served with a sanitized Content-Type — anything outside `image/*`/`video/*` becomes `application/octet-stream` with `X-Content-Type-Options: nosniff`.
- The status viewer now plays items oldest-first at the scroll position, and composing is blocked until the engine type loads.
- A failed status ingest resolves idempotently only on a genuine unique-constraint violation; other failures propagate.
- The production Docker image no longer ships the TypeScript `tsbuildinfo` build cache.
- `npm run dev` no longer crashes on the second launch with `Cannot find module '.../dist/main'` (the incremental cache is pinned back inside `dist/`). (#891) Thanks @Magnarks.
- Outbound `withSafeFetch` cancels unread response bodies before teardown, no longer crashing the process on a peer TLS reset. (#887)
- Expired status media now 404s instead of 500ing when the purge races a stream.
- A lost status-ingest race no longer leaks an orphaned media file (the loser deletes its own file).
- Status tab polish: the retired Phase-1 aggregate row no longer stacks above the per-contact list, the query waits for the Status tab, and a late-arriving picked file no longer overrides a URL.
- Status tab: clearer fetch errors, a viewer that stays in sync on refetch, recipient search matching name/pushName/number/JID capped at 256, pushName-only contacts shown, and plural forms for Arabic/Hebrew/Telugu.

## [0.10.8] - 2026-07-23

### Added

- Release images are now dual-published bit-identical to `docker.io/rmyndharis/openwa` alongside GHCR, with provenance and SBOM attestations verified pullable before release.
- German (`de`) dashboard translation. Thanks @rjsebening.
- Audit-log coverage for the admin infrastructure endpoints (config save, restart, export/import), with the coverage gate extended so a future operation cannot ship without one.
- A single canonical `kind` discriminator (`individual`/`group`/`channel`/`status`/`broadcast`/`unknown`) threaded through REST, webhooks, WebSocket, plugins, and SDKs; `isGroup`/`isStatusBroadcast` unchanged.
- The dashboard Chats page is split into Chats, Channels (whatsapp-web.js), and Status tabs.

### Fixed

- Redis cache now reconnects with bounded backoff and self-heals after an outage instead of staying off until a restart, failing fast to the source of truth while disconnected.
- `GET /api/audit` and `GET /api/webhooks/delivery-failures` now scope results to the calling key's allowed sessions, with a structural test failing the build if any handler takes an unscoped `sessionId` query param.
- Chat list unread badge now uses a fixed height with border-box sizing (true circle for one digit, pill for more), caps at `99+`, and exposes the exact count to assistive technology.

## [0.10.7] - 2026-07-23

### Changed

- TypeORM upgraded from 0.3 to 1.1 (no schema change; all migrations apply unchanged). A criteria that would previously be silently dropped now fails loudly. From-source minimum Node.js rises from 22.12 to **22.13**.

## [0.10.6] - 2026-07-22

### Changed

- The SQLite driver is now the actively maintained `better-sqlite3` (current SQLite 3.53.x with FTS5 fixes); existing database files open as-is and all migrations apply unchanged. ([#848](https://github.com/rmyndharis/OpenWA/issues/848))

### Fixed

- The Sessions overview column header now reads "Actions" (localized) instead of printing `DASHBOARD.COLUMNS.ACTIONS`; the missing `dashboard.columns.actions` key was added to every locale.

## [0.10.5] - 2026-07-22

### Fixed

- Enabled plugins stay enabled across a gateway restart; enable state is tracked separately from running state, and enabled plugins are restarted after boot. A plugin that fails to start is logged and left disabled ([#856](https://github.com/rmyndharis/OpenWA/issues/856)).
- Messages handled by a plugin (chain stopped via `message:sending`/outgoing gate) are now recorded and delivered to webhooks instead of being dropped from history.
- A plugin configuration or disable that fails to save now reports the failure instead of showing "Saved".
- A plugin that ships its own settings editor no longer renders the generated form and second Save button underneath it.
- A plugin's own settings editor now follows the dashboard theme, passed through the settings handshake.
- The Chats sidebar no longer renders a stray `0` where an empty chat's last-message time belongs.
- The login screen shows the gateway's actual version again (resolved relative to the build config, not the working directory).
- A message send retried after a recipient-address change now logs a warning naming the chat and both addresses.

### Changed

- A release image is only tagged `X.Y.Z`/`X.Y`/`latest` after a boot smoke test passes on both architectures; the build publishes a throwaway `smoke-<run-id>` tag, tested, then re-points the release tags at the identical manifest.
- The smoke test no longer uses `--rm`, so an exited container survives for `docker logs` to report why.

## [0.10.4] - 2026-07-21

> ⚠️ **Use this release, not `0.10.3`.** The `0.10.3` image does not start: its `sqlite3` native binary was built against a newer glibc than the `node:22-slim` runtime provides, so the driver failed to load. `0.10.4` has the same features and fixes plus the correction below.

### Fixed

- The container image starts again: `sqlite3` stays on the `5.x` line, whose prebuilt binaries match the Debian bookworm runtime. The dependency advisories are still resolved via `overrides` pinning `node-gyp` and `tar` forward.

## [0.10.3] - 2026-07-21

> ⚠️ **Two behaviour changes on already-released surfaces.**
>
> 1. **Boolean and numeric request fields are read strictly.** `1`/`0`/`yes`/`no` or a blank number now returns `400`; real JSON booleans/numbers, `"true"`/`"false"`, and numeric strings such as `"5"` still work.
> 2. **Status posts now pass the `message:sending` plugin gate.** A broadly-blocking plugin will now block status posts, and the gate `input` for a status post carries no `chatId`.

### Added

- Outbound message edit: `POST /api/sessions/:sessionId/messages/edit` edits the text of a message sent by the account on both engines. Editing another sender's message returns `403`, an unknown message/chat `404`; the edit passes the `message:sending` gate.
- Live group events `group.join`, `group.leave`, and `group.update` are now dispatched to webhooks and Socket.IO on both engines (previously reserved). On Baileys, full-metadata snapshots are filtered out.
- Join groups & group settings: `POST /api/sessions/:sessionId/groups/join` joins via invite code; `GET`/`PUT /api/sessions/:sessionId/groups/:groupId/settings` read and update `announce`/`locked` and `ephemeralSeconds` (Baileys only — `501` on whatsapp-web.js). Boolean and numeric fields are read strictly.
- Own-profile management: `PUT /api/sessions/:sessionId/profile/{name,status,picture}` set the account's display name, about text, and profile picture on both engines.
- Incoming-call handling: a `call.received` webhook + Socket.IO event fires once per ringing call (both engines); `POST /api/sessions/:sessionId/calls/:callId/reject` rejects a call, and per-session `config.autoRejectCalls: true` auto-rejects. Unknown/expired call ids return `404`.
- Docs: the README feature table points to the first-party Integration Fabric plugins in the [OpenWA-plugins](https://github.com/rmyndharis/OpenWA-plugins) repo, and `docs/23-community-integrations.md` clarifies its community-only scope.

### Changed

- The security audit runs as its own blocking CI job so a newly published advisory can no longer abort the Lint job before the other code-quality gates run.
- Status posts (`POST /api/sessions/:sessionId/status/{text,image,video}`) now run the `message:sending` gate, tagged `status-{text,image,video}` with `source` set to `StatusService`; a blocked post returns `400`, and a rewritten media payload is re-checked against the data-URI and `MEDIA_DOWNLOAD_MAX_BYTES` guards.

### Fixed

- `forEveryone: false` on `POST /api/sessions/:sessionId/messages/delete` is honoured again; the field now accepts only a real boolean or `"true"`/`"false"`, and any other spelling returns `400`. `allowMultipleAnswers` on poll send is read the same way.
- Every boolean and numeric request field is now read strictly (14 more fields covered), with a drift test walking class-validator's registry that fails the build on any coercible field. OpenAPI schema unchanged.
- Running more than one session no longer corrupts the Chromium launch flags of later sessions: the whatsapp-web.js adapter now copies the args array before appending instead of mutating the live `ConfigService` reference. Fixed in #840 — thanks @szmazhr.
- The dashboard webhook editor and the Java/Python SDK event types now include `session.reconnect_loop`.
- Typing a session name in the **Create New Session** dialog no longer stalls after the first character; the `onClose` is held in a ref and the open/close effect depends on `[open]` alone. Reported in #837, fixed in #838.

### Security

- Resolved every known advisory in the dependency tree (17 → 0, including one critical `node-tar` path-traversal issue): `sqlite3` moves to `6.0.1`, `typeorm` to `0.3.31`, and `shell-quote` is pinned forward via `overrides`. Bundled SQLite advances to 3.52.0, verified against migrations, FTS5, and a full boot.

## [0.10.2] - 2026-07-20

### Added

- The README gains a **"Before you connect a number"** section: OpenWA is unofficial, a per-engine ban-risk vs. resource-cost table, six safe-sending guardrails, the known cold-contact first-send silent drop (#830), and a pointer to the official Cloud API. Responds to discussions #87, #154, #436, #687, #694.

### Fixed

- `BODY_SIZE_LIMIT` now takes effect under Docker Compose; both compose files forward it into the container. Reported in #540, tracked in #831, fixed in #832.
- The integration-instance create form now offers an optional **ingress secret** field, so providers with a fixed webhook signing secret (e.g. Chatwoot) can be integrated without the REST API (#821).

## [0.10.1] - 2026-07-20

### Added

- Design draft `docs/28-multitenancy.md`: the enterprise multitenancy proposal (nothing implemented yet).
- The Chats room header now shows the contact/group profile picture (cached one hour), a floating scroll-to-bottom button appears once scrolled away from the latest message, and the header shows the prettified phone number with the raw JID retained on a muted monospace line. The composer send icon was enlarged.
- The linked-device name is now brandable via the optional `BAILEYS_BROWSER_NAME` env var (default `OpenWA`). Thanks @clicsoluciones. (#822)

### Fixed

- The chat header no longer formats a LID privacy id as a fake phone number; digit-only LIDs and group ids are rejected by the formatter, and personal @lid chats resolve the real number. Chat-list rows render profile pictures too.
- Chat-list avatars no longer burst into HTTP 429s: profile pictures are batch-resolved in one request (`GET .../contacts/profile-pictures?ids=…`, up to 50 ids).
- Chat-list avatars no longer stall on long sidebars: the batch endpoint caps engine lookups per id and resolves the top 50 ids in list order first.

## [0.10.0] - 2026-07-19

### Added

- Reconnect-loop observability: an `openwa_session_reconnect_attempts_total` counter, plus a `session.reconnect_loop` webhook, warning log, and `openwa_session_reconnect_loop_alerts_total` tick on every fifth consecutive attempt; the streak re-arms after a stable connection.
- The whatsapp-web.js engine sweeps orphaned Chromium processes carrying an `--openwa-session=<id>` marker before each (re)launch.
- Messages composed on a linked phone are now persisted to local history, deduplicated atomically against the REST send path, with delivery/read acks advancing on these rows.
- The whatsapp-web.js own-send echo downloads media through the same capped inbound path, so phone-composed images persist and render.
- A shared accessible modal dialog (Escape/overlay dismissal, focus trap, scroll lock, `role="dialog"`), first used by the Sessions page.
- The Message Tester now covers every outbound type: location, contact-card, sticker, native poll, forward, and bulk text batch with live progress and cancel.

### Changed

- Dashboard theming simplified to a single light/dark toggle (accent-palette picker removed); `h2` is a real heading again (eyebrow look moves to an opt-in `.eyebrow` class); stored theme applied before first paint; analytics chart defaults to 24h.
- The dev compose defaults `AUTO_START_SESSIONS=true` (application-level default stays off).
- Dashboard action buttons consolidated into shared `.btn-primary`/`.btn-secondary`/`.btn-danger` classes (28 page-scoped copies removed).
- The Infrastructure page's inline-styled elements moved to scoped CSS classes on the design-token system.
- Decorative hover/selection effects flattened for a more professional look.

### Removed

- Verified dead dashboard code: unused CSS, dead client methods and utilities, unused image assets, and 39 unused i18n keys.
- Verified-unused dashboard i18n keys (19 per locale across all 11 locales).

### Fixed

- Boot no longer shows ghost entries for the legacy bundled extensions removed in v0.7 (`auto-reply`, `translation`); the stale registry entry is pruned when its code directory has no manifest.
- Long-lived sessions no longer die permanently: a dead whatsapp-web.js Chromium is detected via puppeteer lifecycle handles, a 60s watchdog probes READY engines, and the reconnect budget is unlimited by default (backoff capped at 1h). On Baileys, `connectionReplaced` (440) is terminal and duplicate close events no longer burn retries.
- Further session-stability hardening: Baileys treats `forbidden` (403) as terminal; stale Chromium `Singleton*` files are removed before each (re)launch; page transport errors are treated as an immediate death signal.
- Sent images no longer vanish from the thread: metadata merges per field (a real payload beats a payload-less echo) and post-send reconciliation folds the optimistic copy into the echo row.
- Chat thread scrolling behaves on every path: opens at the latest message, restores the exact per-chat position, and stays pinned while media decodes.
- The messages-by-type chart no longer shows a misleading Unknown slice: content-less system/event rows are excluded.
- Full-text search self-heals its schema at boot when migrations are skipped, and SQLite FTS5 queries are sanitized per token.
- Audit log rows now carry the resolved API key and client IP for every call site.
- Dashboard CSS no longer references undefined custom properties: danger usages resolve to `--error`, wrong fallbacks are dropped, and the plugin "off" badge shows its background again.
- Dashboard readability/behavior fixes: disabled send button stays readable, API Keys badges render on desktop, Templates page gets real button styles, 14 dark-mode selectors corrected, Sessions modals regain the 90vh cap, QR provisioning uses realtime push, and enabling a plugin with unset required config opens its config dialog with a warning.
- Plugins whose config schema declares field defaults no longer fail to enable: defaults are seeded into stored config at load time without overwriting explicit values.

## [0.9.0] - 2026-07-18

### Added

- Live message-edit support emits `message.edited` through webhooks and WebSocket on both engines, updates the stored message and Chats dashboard in occurrence order, and exposes standard fields to smart filters. Existing wildcard (`*`) subscriptions receive it automatically. Thanks @rogeriorioli. (#734)

### Changed

- ⚠️ **Breaking:** `GET /api/settings` no longer returns the incorrect, always-zero `general.sessionTimeout` field; there is no replacement.
- Java SDK: audio/voice sends now pass `SendAudioRequest` to `sendAudio`; other media sends use `SendMediaRequest`, bulk media uses `BulkMediaRequest`.
- The PHP SDK's configured `timeout` now applies to every request, including calls through an injected Guzzle client.
- PHP SDK contributor installs stay compatible with the PHP 8.1 floor; CI exercises 8.1 and 8.2.

### Fixed

- Preserve plugin state across package updates, cover both engine auth stores plus generated secrets in backup/restore, and preserve message `chatName` on data import.
- Bound webhook and integration redrive work, make Redis throttling atomic, guard stale engine teardown, and make media precedence/data-URI normalization/limits consistent across engines.
- Record API-key authorization changes in activity logs, protect the final usable admin, and align action-style POST routes with their documented `200` responses.
- Correct ingress metadata, dashboard session-state visibility and plugin config fallback, SDK timeout/type parity, metrics types, deployment configuration forwarding, and CI contract gates.

## [0.8.19] - 2026-07-17

### Added

- **Official Go SDK (`sdk/go`).** Hand-written, stdlib-only client covering the user-facing API, joining the JS/Python/PHP/Java clients. Context-first methods, functional options, typed sentinel errors (match with `errors.Is`), opt-in retries honouring `Retry-After` (never replays a POST except on `429`/`503`), and no redirect-following so `X-API-Key` is never re-sent. A `TestRouting` table asserts every method/path and runs in CI. Requires Go 1.22+. Thanks @Revelts.

### Changed

- v0.8.18's whatsapp-web.js id-rename fix also restored `GET /sessions/{id}/chats`, undocumented at the time (docs only). First reported by @SkywardLab in #748. Refs #748, #753, #757.
- Typed SDK response models now match the status, label, and channel payloads the server actually returns: `StatusRecord` gains `contact`/`caption`/`expiresAt` and drops `statusId`/`body`; `LabelRecord` uses `hexColor`; `ChannelRecord` gains `inviteCode`/`picture`/`verified`/`createdAt`; channel messages get a dedicated `ChannelMessageRecord`. A type-level wire contract and Java/Go decode guards pin the models. ⚠️ **Breaking (typed SDK consumers):** renamed fields (`label.color`→`hexColor`, `channel.pictureUrl`→`picture`, `status.statusId`→`id`, `status.body`→`caption`; `channel.role` dropped). Refs #754.
- Swagger now agrees with the engine capability matrix on status and catalog (docs only): status routes drop the stale "(Baileys only)" label and note that whatsapp-web.js ignores `recipients`; catalog reads/sends document their real `200`/`501` responses. `openapi.json` regenerated.
- The send-response Swagger `messageId` text no longer asserts a message to a non-WhatsApp number "never delivers"; it now says the outcome reaches you asynchronously, if at all (docs only). `openapi.json` regenerated.
- The Message Tester's status code renders in monospace via a plain `<code>` element.
- Corrected the send-response documentation (docs only): removed the overstated claim that a stalled `sent` means an unregistered recipient, noted `POST send-bulk` returns `202` and `status/send-*` return a `statusId`, and documented the terminal `failed` state and `message.failed` webhook. Refs #738.

### Fixed

- A deleted message is cleared again on a WhatsApp Web build that renamed the id field: `message_revoke_everyone` now falls back to `$1` for `revokedId` (the one place a fully patched build still hands back a raw key), and the status listing and channel-message reads get the same fallback.
- Documentation corrected where it contradicted the code: `docs/06` status `501` claim, the `recipients` allow-list caveat, catalog success bodies, `docs/03` Phone Link availability, and the SDK docs/count staleness in `docs/18` and `sdk/README.md` (recomputed: 123 supported, 19 not-available across 14 methods).
- `PLUGINS_ENABLED` removed from `.env.example` and the compose file — it was read by nothing. All plugin routes remain ADMIN-only.
- Inbound messages keep their id on a renamed-id build: `buildIncomingMessageBase` now falls back to `$1`, with an unreadable id normalized to NULL at the persist chokepoint.
- Logs CSV export no longer truncates at 200 rows: pagination now terminates on the server-reported `total`. Thanks @kabir74705 for the report and the original fix.
- Dashboard no longer overstates connected sessions or shows a fabricated trend: the KPI reports the READY count (relabelled "Connected Sessions") with a `{running} running · {total} total` breakdown, and the fake trend indicator is gone. Thanks @kabir74705.
- The whatsapp-web.js backport can no longer latch in a half-patched dependency: `REQUIRED_SITES` now asserts `Utils.js`, `Client.js`, and `GroupChat.js`, the Docker build fails on such a tree, and the half-patched error exits non-zero under `--best-effort`.
- A status post no longer claims success it cannot prove: no message back now surfaces as a `500`, the renamed-id `$1` fallback is applied to the status id and the ack listener, so `deleteStatus` and failed acks work on renamed-id builds.
- The Message Tester no longer invents HTTP status codes: the banner now shows the real gateway status (or none when no request was made) instead of hardcoded `200`/`400`. Fixes #750.
- A production boot serving the dashboard over plain HTTP now warns about the `upgrade-insecure-requests` CSP that blanks it; `.env.example` documents `CSP_UPGRADE_INSECURE_REQUESTS=false` under Security and `docs/12-troubleshooting-faq.md` gains a blank-screen entry. (#731)
- The startup banner advertises `BASE_URL` instead of a hardcoded `localhost` on the running/Swagger/Dashboard lines. (#731)
- Saving Infrastructure no longer persists a guessed engine when the running engine is unknown: the save payload omits `engine.type` unless the radio seeded from the running engine or the operator picked one.
- The dashboard now clears a message deleted for everyone while the thread is open (whatsapp-web.js): the WebSocket projection forwards `revokedId` and the cache lookup matches on either candidate id. Refs #755.
- A failed group creation now reports why: the adapter handles whatsapp-web.js's `Promise<CreateGroupResult | string>` union instead of reading `.gid` off the error string.
- An ack whose message id can't be read is dropped at the adapter boundary instead of sending `waMessageId = NULL` that matches no row.
- A send whose message can't be read back no longer crashes or claims an unprovable delivery: seven send sites route through one helper — no message reported as a failed send, an unreadable id reported as the empty no-id sentinel (normalized to NULL in `saveOutgoingMessage`). Refs #757.

## [0.8.18] - 2026-07-17

### Changed

- Send-response semantics clarified (docs only): `201` means the gateway accepted the message, not that the recipient received it; a message to a non-WhatsApp number still returns `201` but never delivers. `GET /sessions/{id}/contacts/check/{number}` is cross-referenced for pre-validation, and the async `status` lifecycle as the source of delivery state. Refs #738.

### Fixed

- Inbound media download, message ids, acks, and reply quoting restored (whatsapp-web.js `id._serialized` → `id.$1` rename in WhatsApp Web build 2.3000.x). The production Docker image backports upstream fix [#201832](https://github.com/wwebjs/whatsapp-web.js/pull/201832) at build time via `scripts/patch-wwebjs-201832.js`, which auto-disables once a future release ships the fix. Fixes #747.
- Source installs get the backport too, applied from `postinstall` (best-effort; a machine without `patch` or a Baileys-only setup gets a warning). The image build still treats the failure as fatal.
- Reactions stay attributable on renamed-id builds: the adapter reads the renamed field directly and falls back to the empty no-id sentinel.
- A reaction with no message id no longer updates an arbitrary message: the id is checked before the lookup query.
- Engine start timeouts return a diagnostic `504` instead of a bare `500`: the whatsapp-web.js auth-timeout and the outer init-hang deadline (`EngineInitTimeoutError`) both map to `504`, with the `WWEBJS_AUTH_TIMEOUT_MS` knob for slow first boots.
- S3 storage no longer falls back to local without an `endpoint`: `endpoint` and `forcePathStyle` apply only when configured, so standard AWS S3 uses virtual-hosted addressing (#735).
- `.env.example` no longer ships a default `S3_ENDPOINT` (#735 follow-up).
- WhatsApp Engine selection on the Infrastructure page no longer reverts to the running engine: the radio seeds once and freezes on first user interaction (#735).
- Message Tester supports uploading local media files: a file picker (mutually exclusive with the URL field) reads the file as base64, client-capped at 18 MiB (#735).

### Security

- Plugin archive extraction hardened against CVE-2026-39244 (adm-zip declared-size zip-bomb OOM): the `adm-zip` bump to `0.6.0` (#728) closes the declared-size allocation vector on the marketplace install path. The now-redundant `@types/adm-zip` devDependency is dropped.

## [0.8.17] - 2026-07-13

### Added

- Structural test fails the build when an `AuditAction` value is neither emitted nor registered as intentionally-unemitted; registry checked for stale/empty entries.
- Operator-tunable HTTP server timeouts via `REQUEST_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS` / `KEEPALIVE_TIMEOUT_MS`, validated at boot.
- Committed `openapi.json` snapshot with a CI sync gate (`npm run openapi:check`).
- Pre-release boot smoke on amd64 + arm64 against `/api/health/live` before the GitHub Release.
- SBOM attestation on published images alongside SLSA provenance (`provenance: true`).
- HTTP RED metrics on `/api/metrics`: `http_requests_total{method,route,status}` and `http_request_duration_seconds` histogram.
- Request correlation ids (`X-Request-ID`) propagated via AsyncLocalStorage and stamped on logs, audit metadata, and the response.
- Engine capability matrix (`src/engine/engine-capability-matrix.ts`) with a drift gate on throw-availability changes.
- Delete-for-me on the Baileys engine (`deleteMessage(…, forEveryone=false)`).
- Status posts (`postTextStatus`/`postImageStatus`/`postVideoStatus`) on the whatsapp-web.js engine; `recipients` not honored there.
- Chat labels (`addLabelToChat`/`removeLabelFromChat`) on the Baileys engine (Business accounts only).
- Status delete (`deleteStatus`) on the whatsapp-web.js engine (own status only).
- Read contact stories (`getContactStatuses`/`getContactStatus`) on the whatsapp-web.js engine.
- Channel lookup/subscribe/unsubscribe (`getChannelById`/`subscribeToChannel`/`unsubscribeFromChannel`) on the Baileys engine.
- Bounded webhook fan-out via `WEBHOOK_DISPATCH_CONCURRENCY` (default 16).
- Optional Redis-backed rate-limit storage when `REDIS_ENABLED=true` (default off, fail-open).

### Fixed

- Baileys 1:1 sends to LID-migrated contacts no longer silently fail (ack 463); phone-dialect chat ids resolve to the contact's LID at the send boundary. Thanks @isaacmendes. [#717]
- whatsapp-web.js adapter now logs an advisory on a stale browser profile after a binary-changing upgrade (`Execution context was destroyed`). [#708]
- OpenAPI export script runs hermetically again under the tightened SQLite `DATABASE_NAME` validation.

## [0.8.16] - 2026-07-12

### Added

- Integration SDK v1 `response` contract for inbound routes: host-side `preflight` (`session-alive`) and declarative `ack`; a dead session on a concrete-scoped route now fails fast with 503. Deprecates `mode: 'sync-reply'`.
- `standard-webhooks` ingress signature scheme (`signature.scheme: "standard-webhooks"`) to verify Svix/Standard Webhooks payloads host-side.

## [0.8.15] - 2026-07-11

- WhatsApp Web sessions no longer wedge in `INITIALIZING` forever; `initializeEngine()` races init against a deadline and force-kills a wedged browser, marking the session `DISCONNECTED`. Thanks @INAPA-desarrolloTIC. [#667]
- Dashboard primary buttons were invisible until hover in light mode; removed the leftover Vite template CSS. Refs #684.
- Fixed a PostgreSQL upgrade crash-loop for schemas formerly bootstrapped with `DATABASE_SYNCHRONIZE=true` via a `NormalizeSynchronizeUuidColumns` guard migration. Fixes #690.
- WhatsApp Web auto-version resolver now prefers a settled build (newest non-beta published ≥12h ago). Fixes the "stuck at Starting, no QR" report from #684 (Bug 2).
- Baileys engine: messages no longer stick on "Waiting for this message" on iOS recipients; `getMessage` is now backed by the message store.
- Baileys message-store lookups no longer fail their FK check; the engine config carries `sessionId` (name) and `dbSessionId` (UUID) separately.
- Wrapped the Baileys signal key store in `makeCacheableSignalKeyStore` to close a write-then-read race.
- Upgraded `@whiskeysockets/baileys` `6.7.23` → `7.0.0-rc13` for the upstream concurrency rewrite.
- Fixed a first-message-after-reconnect drop on Baileys; `'append'` upserts are now gated on message timestamp vs connection open time.
- Dashboard Korean (ko) locale polish (follow-up to #679).
- Reliability and correctness hardening batch: bounded inbound-media waiter queue; `start()` cancels a pending reconnect timer before recreating the engine; dashboard chat thread refetches after a WebSocket reconnect; API-key updates disconnect the key's now-out-of-scope WebSocket sockets; SQLite→PostgreSQL export/import covers every data-owned table; `docker-compose.yml` blank-forwards Puppeteer engine config; PHP SDK docblocks match the real envelopes and SDK CI covers backend controllers/services.

## [0.8.14] - 2026-07-10

### Added

- Plugin search providers: a plugin registers via `ctx.registerSearchProvider(handler)` and the host routes `GET /api/search` over a `search`/`search-result` protocol, selected by `SEARCH_PROVIDER` (`auto`/`builtin-fts`/`none`).
- `GET /api/search` clamps `limit`/`offset` host-side and re-scopes plugin results to the caller's session scope. [#680]
- `ingress_events` and `integration_delivery_failures` are pruned past `INGRESS_RETENTION_DAYS` (default 90). [#680]
- MCP auth failures are audited and the Bull Board login endpoint is pre-auth IP-throttled. [#680]
- Ingress guardrails: startup warning for unauthenticated (`scheme:'none'`) routes; the `{id}` HMAC `contentTemplate` placeholder is now implemented. [#680]
- CI type-checks spec files (`tsc --noEmit -p tsconfig.json`) and the release gate now runs the full CI suite. [#680]
- Korean (한국어) dashboard locale. Thanks @moduvoice. [#679]

### Fixed

- Sending media to a channel (`@newsletter`) on the whatsapp-web.js engine fails fast with `501` (typed `ChannelMediaNotSupportedError`) instead of a raw `500`. [#673]
- `base64` media now takes precedence over `url` when both are provided on a media send. [#670]
- Fresh Docker Compose dev installs no longer boot-loop with `SQLITE_CANTOPEN`; the dev compose forwards a blank `DATABASE_NAME` and validation rejects a bare SQLite name. [#677] [#680]
- `DATABASE_TYPE=postgres` with `DATABASE_SYNCHRONIZE=true` is rejected at boot. [#680]
- Resolved internal IPs are no longer leaked in SSRF-block error messages. [#680]
- `STORE_EPHEMERAL_MESSAGES=false` is now honored on Baileys history backfill. [#680]
- Plugin archive extraction is byte-bounded and returns a 400 on a corrupt/oversized archive. [#680]
- WebSocket auth lifecycle: IP-restricted keys can connect from an allowed IP; a revoked/disabled key's sockets are evicted. [#680]
- Misc hardening: migration CLI honors `MAIN_DATABASE_NAME`; `secret-file` chmod failures logged; IPv4-mapped-loopback SSRF gap closed; storage traversal made async + bounded; dashboard and all four SDKs warn on a non-localhost `http://` `baseUrl`. [#680]

## [0.8.13] - 2026-07-09

### Added

- Dashboard search panel: global search bar on the Chats page with highlighted snippets, cross-session navigation, scope toggle, and pagination; XSS-safe snippet rendering, localized across all 10 locales.
- SDK search resources: the JavaScript, Python, PHP, and Java SDKs expose a `search` resource mirroring `GET /api/search`.

## [0.8.12] - 2026-07-08

### Fixed

- Debian Chromium SIGTRAP crash in Kubernetes: amd64 now downloads Chrome for Testing during build; arm64 keeps Debian's `chromium`, both via one `PUPPETEER_EXECUTABLE_PATH` symlink. Thanks @muhfalihr.

### Added

- Global message search across sessions via `GET /api/search` with a built-in DB full-text provider (PostgreSQL `tsvector`/`GIN`, SQLite `FTS5`); `SEARCH_ENABLED=false` disables it.
- `message:persisted` plugin hook fired on durable persist (outbound send and inbound receive).
- Redis authentication via `REDIS_USERNAME`. Thanks @muhfalihr.
- OpenAPI/Swagger snapshot export with auth-accurate docs: `@Public()` routes marked no-key, `webhook` events advertise the `*` wildcard, request/response schemas filled in; hermetic export environment.

## [0.8.11] - 2026-07-08

### Added

- Prometheus counter `openwa_webhook_delivery_failures_total` on `/api/metrics`, incremented once per delivery that exhausts its retries.

### Changed

- Runtime feature flags centralized under `features.*` on `ConfigService`. ⚠️ A non-canonical boolean (e.g. `SIMULATE_TYPING=1`) now fails boot naming the key.
- Added Jest `coverageThreshold` floors for `src/modules/session`, `src/modules/webhook`, and `src/core/hooks`.

### Fixed

- Inbound ingress deliveries now retry with bounded exponential backoff (`INGRESS_MAX_ATTEMPTS`, `INGRESS_RETRY_DELAY_MS`); the dead-letter write fires once after retries. ⚠️ Ordering is best-effort.
- `/infra/status` actively probes the databases (`SELECT 1`) instead of trusting `isInitialized`.
- The settings panel reports real docs/base-URL config (`ENABLE_SWAGGER`, `BASE_URL`, actual `autoReconnect` default).
- A reaction no longer clobbers a message's delivery status; it writes only `metadata` via a scoped `UPDATE`.
- `PUT /infra/config` returns the real 4xx for a rejected configuration instead of 200 `{ saved: false }`.
- Deleting a session no longer orphans its webhooks, templates, or stored Baileys messages on SQLite; `delete()` removes CASCADE-FK child rows explicitly.
- The `message:sending` gate and `message:failed` notification now cover every outbound path (media, extended, bulk). ⚠️ A `message:sending` plugin now sees sends it previously never received; the payload carries a `type` discriminator.
- Sibling webhooks on the same event now get distinct idempotency keys (salted with the destination webhook id).
- A session with auto-reconnect off now records "Auto-reconnect is disabled" instead of "reconnection failed after 0 attempts".
- A failed inline ingress delivery now persists a redrivable dead-letter record.
- Plugin instance session bindings are re-derived on startup, so a binding lost while the plugin was unloaded self-heals.
- Deleting a session now purges its on-disk engine auth directory (best-effort, traversal-guarded). Thanks @m7fz7.

## [0.8.10] - 2026-07-07

### Added

- PostgreSQL schema selection via `POSTGRES_SCHEMA` (default `public`), exposed on the Infrastructure page and validated at boot.

### Changed

- OpenAPI/Swagger tag hygiene: every controller tag declared, the three Integration Fabric controllers gained `@ApiTags`, uniform casing.
- Graceful shutdown now drains on `SIGTERM`/`SIGINT`. ⚠️ A `docker stop`/redeploy now takes up to `SHUTDOWN_DELAY_MS` (default 3s prod, 0 dev) plus teardown and exits `0`; set `stop_grace_period`/`terminationGracePeriodSeconds` accordingly.
- Bundled Compose pins `docker-socket-proxy` and `minio` to explicit tags, adds a Dependabot `docker` ecosystem, declares a Node `>=22` floor + `.nvmrc`, and disables Scarf telemetry.

### Fixed

- Integration Fabric now works on PostgreSQL; a migration adds `DEFAULT gen_random_uuid()` to `conversation_mappings` and `integration_delivery_failures`, plus a CI job asserting every generated-uuid PK has a DB default.
- Indexed `webhooks.sessionId` to avoid a per-event full table scan.
- Boot now rejects a non-canonical boolean `QUEUE_ENABLED`/`MCP_ENABLED`/`SERVE_DASHBOARD`. ⚠️ A deployment booting with such a value must correct it.
- A fatal uncaught exception is now written to the structured log before exit.
- `POST /infra/import-data` no longer swallows a database error while clearing tables; a real fault rolls the import back with a 500.
- A session no longer schedules a reconnect while the process is shutting down.
- Documentation & config accuracy: `.env.example` documents `PORT` vs `API_PORT` and the `QUEUE_ENABLED`/`CACHE_ENABLED` toggles; refreshed `SECURITY.md` and Java SDK snippets; removed unused `uuid`/`@types/uuid`.
- Bundled Compose no longer kills Chromium mid-spawn under multi-session whatsapp-web.js load; `pids_limit` default raised 512 → 2048, exposed as `OPENWA_PIDS_LIMIT` (#636).

## [0.8.9] - 2026-07-06

### Changed

- Dashboard `<select>` elements replaced with a reusable `CustomSelect` (theming, keyboard nav, responsive). Thanks @haseeblodhi1899.
- "Install a plugin" modal is wider on desktop (480px → 680px), full-width bottom sheet on small screens.
- `webhook_delivery_failures` pruned to `WEBHOOK_FAILURE_RETENTION_DAYS` (default 90) at startup and daily.

### Fixed

- A malformed session id returns `400` instead of `500` on PostgreSQL.
- Baileys API sends now emit `message.sent` (parity with whatsapp-web.js) for text and every media/location/contact/poll/reply/forward send.
- Config & reliability hardening: DB timeout env vars validated at boot; an unparseable `BODY_SIZE_LIMIT` falls back to 25 MB; channel-messages endpoint no longer forwards `NaN`; fire-and-forget session-row writes handle transient DB faults; corrected engine-adapter component names.
- A terminally-failed or un-reinitializable session no longer strands its browser or wedges at "already started"; the dead engine is evicted and force-killed.
- The dark theme now covers every dashboard surface; a new `--info` token themes blue badges and the root `<html>` background follows the dark theme.

## [0.8.8] - 2026-07-05

### Added

- Native WhatsApp polls via `POST /api/sessions/:sessionId/messages/send-poll` (2–12 options, optional `allowMultipleAnswers`), first-class `poll` type on both engines. Thanks @alejo117.

### Changed

- Corrected the Italian login-footer wording. Thanks @albanobattistella.

### Fixed

- `GET /…/channels/:channelId/messages` no longer always returns `[]` on whatsapp-web.js; messages read from the subscribed `Channel`, unknown channel returns `404`. Thanks @Header9968. (#625)
- A session whose `engine.initialize()` fails no longer orphans its browser; the crash-recovery path uses `forceDestroy()`.
- Authenticated HTTP/HTTPS proxies now work on whatsapp-web.js via `proxyAuthentication`; a credentialed SOCKS proxy logs a clear warning. Thanks @gudge25. (#628)

## [0.8.7] - 2026-07-03

### Added

- Plugins can canonicalize a chat id via `ctx.engine.canonicalChatId(sessionId, chatId)`, gated by `engine:read`. (#615)

## [0.8.6] - 2026-07-03

### Fixed

- The `engine.getChatHistory` plugin capability (0.8.5) now reaches sandboxed plugins via the worker bridge; whatsapp-web.js history now carries location coordinates and quoted-message references. (#609)

## [0.8.5] - 2026-07-03

### Added

- Plugins can read recent chat history via `ctx.engine.getChatHistory(sessionId, chatId, limit?, includeMedia?)`, gated by `engine:read` and session scope (limit clamped to 100). (#609)

## [0.8.4] - 2026-07-03

### Added

- `CSP_UPGRADE_INSECURE_REQUESTS` env var to control the CSP `upgrade-insecure-requests` directive. (#611)

## [0.8.3] - 2026-07-03

### Added

- Plugins can send WhatsApp voice notes through `ctx.conversations.send` via a new `voice` envelope type. (#607)

## [0.8.2] - 2026-07-03

### Added

- Plugins can send media (`image`/`video`/`audio`/`file` envelopes carrying `mediaUrl`) through `ctx.conversations.send`; a `replyTo` on a media envelope is rejected.
- Official Java SDK (`com.rmyndharis:openwa`): a synchronous Java 17 client covering all 12 REST resources plus API-key validation, published to Maven Central as `com.rmyndharis:openwa:0.1.1`. (#602)

## [0.8.1] - 2026-07-02

### Changed

- ⚠️ The WebSocket handshake no longer accepts the API key via `?apiKey=`; use `auth.apiKey` or the `X-API-Key` header. (#601)
- ⚠️ The MCP server now defaults to read-only; set `MCP_READONLY=false` to expose write tools. (#601)

### Security

- SSRF rejection messages no longer disclose the resolved internal IP address. (#595)
- Imported session names are validated against path traversal at the engine sink; save-config/export responses return relative paths. (#598)
- Plugin capability calls are confined to the sessions a plugin is activated for; `net.fetch` is bounded by a global concurrency limit. (#594)
- Inbound-webhook signature verification and config-secret handling hardened (no `$`-substitution in signed content, constant-time challenge compare, fail-closed nested-secret redaction). (#592, #593)
- Rejected WebSocket authentication attempts are now audited. (#601)

### Fixed

- Inbound-webhook idempotency and delivery durability: dedup key includes plugin id; a header-less delivery derives a deterministic id; a redrive keeps a DLQ row redrivable; the conversation-mapping upsert is race-safe. (#591)
- Baileys ephemeral inbound: location coordinates no longer dropped; ephemeral/view-once-wrapped history maps to its real type and body. (#596)
- A failed engine start no longer wedges a session; a name-race create returns 409; bulk send caps concurrent batches (`BULK_MAX_CONCURRENT_BATCHES`). (#600)
- PostgreSQL boot on managed instances: the UUID-defaults migration touches `pgcrypto` only on PostgreSQL ≤ 12. (#599)
- The migration CLI works again (the data-source module exported two `DataSource` instances). (#590)

## [0.8.0] - 2026-07-02

### Added

- Integration Fabric: ADMIN operators provision per-plugin instances (each with an HMAC-verified inbound webhook, operator secret, and per-session config) through a provisioning API and a new dashboard Instances tab; plugins gain `ctx.registerWebhook`, `ctx.mappings`, a handover gate, and `net.allowConfigHosts`. (#568, #570, #571, #575, #585, #587, #588, #589)

### Fixed

- Reply/forward to a LID-migrated contact no longer fails with HTTP 500 on whatsapp-web.js; they resolve the recipient like a normal send. (#583)
- The typing/presence endpoint no longer returns 500 on Baileys when a presence update fails; it's caught and logged at WARN. (#583)
- Chat history for a LID-migrated contact is no longer split across two entries on whatsapp-web.js; the engine records the `phone ↔ lid` mapping. (#583)
- The dashboard chat list no longer refetches on every message sent to a LID-migrated contact. (#583)

## [0.7.20] - 2026-07-02

### Fixed

- Sends to a LID-migrated contact no longer intermittently fail with 500 on whatsapp-web.js; the engine caches each contact's confirmed resolution and re-resolves once on a stale mapping. (#580) Thanks @lexcorp.
- The typing indicator now logs at WARN (not ERROR) when sending to a LID-migrated contact, and resolves the target like the send. (#582) Thanks @lexcorp.

## [0.7.19] - 2026-07-02

### Added

- Business messages WhatsApp masks on linked devices are now surfaced as a `masked` type instead of an empty bubble, with a dashboard notice. (#574) Thanks @crossgg.

### Fixed

- Sending to a contact WhatsApp has migrated to LID addressing no longer fails with 500 on whatsapp-web.js; the engine resolves an individual recipient to its current WhatsApp id before sending. (#573) Thanks @lexcorp.

## [0.7.18] - 2026-07-02

### Added

- Stats endpoints (`GET /stats/messages`, `GET /sessions/:id/stats`) include a `chatName` field on each top-chat entry. (#558) Thanks @buluma.

### Fixed

- Incoming WhatsApp Business interactive messages no longer arrive with an empty body on Baileys; text from `interactiveMessage`/`buttonsMessage`/`templateMessage`/`interactiveResponseMessage` is extracted and classified as `text`. (#562)
- Delete-for-everyone now reliably flags the message revoked; `message.revoked` carries an optional `revokedId` (the original message id) on both engines. (#567) Thanks @JibayMcs.

## [0.7.17] - 2026-07-01

### Added

- Send true WhatsApp voice notes (PTT): `send-audio`, bulk send, and the `MessageSendAudio` tool accept an optional `ptt`; the server defaults the mimetype to `audio/ogg; codecs=opus` and stores `type: "voice"`. (OpenWA-n8n #13)

### Fixed

- Operating on a WhatsApp Channel (`…@newsletter`) on whatsapp-web.js no longer logs internal errors; typing/presence, mark-unread, and delete-chat cleanly no-op and chat-labels returns an empty list. (#554) Thanks @DanielOberlechner.
- Add/remove chat labels now works on whatsapp-web.js; a non-Business account or a label-less chat returns 422 instead of a 500. (#556)

## [0.7.16] - 2026-06-30

### Added

- Link a WhatsApp session by pairing code from the dashboard: a "Link with Phone Number" tab requests an 8-character code via `POST /sessions/:id/pairing-code`, localized across all 10 locales and accessible. (#551) Thanks @akash247777.

### Fixed

- Pairing code renders in the correct order in RTL locales (isolated to LTR); the pairing modal no longer disappears mid-link on whatsapp-web.js, and a rapid double-Enter can't fire overlapping requests. (#552)

## [0.7.15] - 2026-06-30

### Added

- Inbound @mentions surfaced on Baileys as `mentionedIds` (normalized to `@c.us`), reaching parity with whatsapp-web.js. (#542)

### Changed

- The message-templates page and the kill-stuck-session dialog are now fully localized. (#550)
- The i18n parity check hard-fails on mismatched `{{placeholder}}` tokens and warns on English-identical values. (#547)
- Sandboxed plugins have a ceiling of 32 concurrent host capability calls. (#544)
- Plugin lifecycle operations (enable/disable/update/uninstall/install) on the same plugin are serialized. (#544)

### Fixed

- The Infrastructure queue panel shows real BullMQ webhook-queue depth, drops the phantom Message Queue card and dead Clear-Failed button, and copies the Bull Board URL with a hint. (#549)
- A sent message whose persistence hiccups is no longer reported as failed; a transient DB fault on saving `SENT` is logged and returns success. (#549)
- Incoming call messages show real detail (`video`/`missed`) on the live whatsapp-web.js path. (#548)
- Location messages show a "📍 Location" preview instead of a base64 thumbnail. (#548)
- Logs pagination can reach every page (sliding clamped window). (#548)
- Message Tester clears the group selection when the session changes. (#548)
- The media lightbox caption shows a formatted time. (#548)
- The "Create API key" button is disabled while the request is in flight. (#548)
- QR polling no longer churns its own interval (reads sessions via a ref). (#548)
- Editing a webhook clears its message-filters when no message events remain selected. (#548)
- A session-status toast fires once per real transition. (#548)
- Dashboard chat media labels are localized (`chats.media.*`). (#547)
- Spanish template-test hint interpolates correctly again (`{{name}}` token restored). (#547)
- Arabic and Hebrew filter-count badges use the correct CLDR plural forms. (#547)
- The audit-log listing rejects a negative offset. (#545)
- API-key create/delete/revoke are now recorded in the audit log. (#546)
- A session status change is no longer broadcast twice over WebSocket. (#546)
- A slow webhook receiver no longer delays delivery to the others (concurrent dispatch on the direct path). (#546)
- A plugin's stored secret array is no longer wiped when its length changes. (#544)
- A crash midway through a plugin update no longer leaves a backup that loads as a duplicate (dot-prefixed backup dir, skipped by the loader). (#544)
- Disappearing (ephemeral) inbound messages no longer lose their content on Baileys (inner content is read). (#542)
- Captioned documents surface their caption on Baileys. (#542)
- Inbound media downloads on whatsapp-web.js stay within `INBOUND_MEDIA_CONCURRENCY` (slot held until the download settles). (#542)
- A stale QR code can no longer be emitted while a whatsapp-web.js session is shutting down. (#542)
- Bulk send persists the correct filename for every media type. (#542)
- Boot migrations are no longer aborted by the runtime `statement_timeout` on PostgreSQL (lifted per-transaction via `SET LOCAL`). (#543)
- The templates migration revert is idempotent on a synchronize-bootstrapped database (`IF EXISTS`). (#543)

### Security

- The MCP endpoint has a pre-authentication per-IP rate limit (`MCP_IP_RATE_LIMIT_MAX`/`_WINDOW_MS`). (#549)
- Contact-card names escape vCard structural characters (backslash, semicolon, comma). (#545)
- Request inputs are bounded against oversized payloads (bulk text/caption, mentions, group/status/contact/reply/reaction fields, storage import DTO). (#545)

## [0.7.14] - 2026-06-30

### Added

- Outbound @mentions on text and media sends via an optional `mentions` array of neutral `@c.us` WIDs. (#530) Thanks @adampalli.
- Call and location messages render in the dashboard chat view; a new engine-neutral `call` type carries `{ video, missed }`, localized across all 10 locales. Based on work by @softronicve (#494).

## [0.7.13] - 2026-06-29

### Fixed

- Bulk batch ids are now unique per `(session, batchId)`, not globally; cross-session reuse no longer 500s. (#531)
- A message arriving while a session is being deleted is no longer persisted as an orphan (post-processing liveness re-check). (#531)
- Per-session stats return a consistent `YYYY-MM-DD HH:MM:SS` `lastActive` on SQLite and PostgreSQL. (#533)
- The uuid id default now works on PostgreSQL ≤ 12 (migration enables `pgcrypto` first). (#533)
- `GET /audit` clamps its page size to a maximum of 200. (#536)
- The `baileys_stored_messages` and `webhook_delivery_failures` migration reverts drop indexes with `IF EXISTS`. (#536)
- Bulk send always releases its in-flight marker on every exit path. (#536)

### Security

- Hook re-entrancy is now blocked for sandboxed plugins; worker-initiated capability calls run inside the in-flight hook context. (#532)
- Docker container teardown on `POST /infra/restart` is restricted to the managed allowlist (`postgres`/`redis`/`minio`) with exact `openwa-<service>` matching. (#534)
- Failed API-key authentication attempts are recorded in the audit log (`api_key_auth_failed`). (#535)
- The SSRF guard blocks the deprecated IPv6 site-local range (`fec0::/10`). (#536)
- Session-scoped MCP tools require a session id before authorization. (#536)
- Contact-card vCards are sanitized on both engines via one shared helper (CR/LF stripped, digits-only `waid`). (#537)

## [0.7.12] - 2026-06-29

### Added

- Brazilian Portuguese (pt-BR) dashboard locale. Thanks @A831ARD0.

### Fixed

- The engine fallback now fails with a clear error instead of silently starting whatsapp-web.js when the configured engine is unavailable. (#527)

### Security

- Application logs redact secret-named metadata fields (`password`, `secret`, `token`, `api-key`, `authorization`, `credential`, `pepper`, `private-key`). (#527)

### Performance

- Failed media sends and completed bulk batches no longer retain their base64 payload (mimetype/filename kept). (#524)
- The dashboard chat view no longer caches full media base64; older history shows a `📎 Media` placeholder. (#525)

## [0.7.11] - 2026-06-29

### Added

- Disappearing-messages support on the Baileys engine: outbound messages honor and set a chat's timer (learned from inbound, resolved across phone and `@lid` ids). Thanks @ulises2k. (#473, #513)
- `STORE_EPHEMERAL_MESSAGES` env var (default `true`); set `false` to skip persisting/dispatching incoming disappearing messages. `ephemeralDuration` surfaced on `IncomingMessage`. Thanks @spidgrou. (#506)
- Durable dead-letter record for permanently-failed webhook deliveries in a new `webhook_delivery_failures` table, reviewable via `GET /webhooks/delivery-failures`. (#520)

### Fixed

- Deleting a session now removes its message history and bulk batches (cascade added). (#504)
- Deleting a session while it is reconnecting no longer leaks its engine (post-init existence re-check). (#521)
- Inbound media downloads are bounded by `MEDIA_DOWNLOAD_TIMEOUT_MS` (default 30s), delivering the message with media omitted. (#510)
- Webhook delivery identifiers stay consistent with the signed body; each webhook gets an isolated data copy. (#512)
- `POST /auth/validate` no longer double-counts key usage and validates IP-restricted keys correctly. (#507)
- ⚠️ `GET /settings` now requires an ADMIN key. (#514)
- Bulk-message `batchId` uniqueness is scoped per session. (#515)
- ⚠️ Boot-time validation now rejects `0` for the rate-limit limits and the webhook timeout. (#516)
- SSRF protection blocks the RFC6052 IPv4-translatable IPv6 form (`::ffff:0:a.b.c.d`). (#518)
- Per-key IP allowlist uses the shared hardened IP matcher and rejects a malformed client address. (#519)
- Dashboard: the Infrastructure page is not rendered for non-admin roles; image-attachment preview object URLs are released. (#508)
- A deleted session's stored failure reason is now cleared (small in-memory leak). (#505)
- The webhook worker connects to the configured Redis (config loaded before modules are evaluated). (#523)

### Performance

- Configurable webhook worker concurrency (`WEBHOOK_WORKER_CONCURRENCY`, default 10). (#511)
- Dropped a redundant single-column `messages(sessionId)` index. (#509)

## [0.7.10] - 2026-06-28

### Added

- WhatsApp Status posting on the Baileys engine: the three status `send-*` endpoints accept a required `recipients[]` (1–256 JIDs) with optional image/video mimetype; whatsapp-web.js returns `501` (upstream-blocked). Thanks @CharlesLightjarvis. (#455)
- Visible placeholder for skipped inbound media: an `omitted` marker with a `📎 Media` dashboard placeholder on both engines. Thanks @spidgrou. (#501)

### Fixed

- Status image/video no longer hardcode `image/jpeg`/`video/mp4`; the DTO accepts an optional `mimetype`. (#455)
- Clean install on Node 22+ / npm 11: `@nestjs/websockets` declared as a direct dependency; `postinstall` no longer triggers `DEP0190`. Thanks @abdullah4tech. (#500)

### Changed

- Italian (`it`) `messageTester` page-title wording. Thanks @albanobattistella. (#497)

## [0.7.9] - 2026-06-28

### Added

- Bounded list pagination on `GET /sessions` and `GET /webhooks` (`limit` 1–1000, `offset`). (#496)
- Concurrent-session cap via `MAX_CONCURRENT_SESSIONS` (default 0 = unlimited). (#496)
- Configurable Redis connect timeout via `REDIS_CONNECT_TIMEOUT_MS` (default 5000). (#496)

### Fixed

- Webhook delivery during a Redis outage fails fast to direct signed delivery instead of buffering indefinitely. (#496)
- `GET /sessions/stats` aggregates status counts in the database for accuracy at scale. (#496)
- Plugin storage keys are validated and encoded to filesystem-safe filenames, with backward-compatible reads/deletes. (#496)

### Changed

- Refreshed project documentation, roadmap, and testing strategy. (#496)

## [0.7.8] - 2026-06-28

### Added

- Optional inbound-media skip via `MEDIA_DOWNLOAD_ENABLED` (default `true`) on both engines. Thanks @spidgrou. (#492)

### Fixed

- External-S3 setups no longer silently fall back to local disk: compose forwards the legacy `S3_ACCESS_KEY`/`S3_SECRET_KEY` and blank-clears them so they can't shadow dashboard config. (#488 follow-up)
- The production default-secret guard now requires both the `*_BUILTIN` flag and an internal host, so an external Postgres/MinIO with a default password is still rejected. (#488 follow-up)
- The Infrastructure page shows an error + retry (not a defaults-seeded form) when `/infra/status` can't load. (#488 follow-up)
- `/infra/status` no longer blocks on the WhatsApp Web version registry fetch, which is now rate-limited after a failure. (#488 follow-up)
- A replayed `message.sent` WebSocket echo no longer downgrades a message already shown delivered/read. (#484 follow-up)

### Changed

- Refreshed the Italian (`it`) dashboard locale. Thanks @albanobattistella. (#491)

## [0.7.7] - 2026-06-28

### Added

- Dashboard chat thread UX: clickable URLs, WhatsApp text formatting, an image lightbox, and per-chat scroll position. Thanks @softronicve. (#484)
- The Infrastructure page shows the actual WhatsApp Web build in use and how it was chosen, via `/infra/status`. (#488)
- Infrastructure data backup & restore: export/import all Data-DB tables to JSON, wired into the database-switch flow with warnings. (#488)
- The Infrastructure page flags any database/redis/storage setting pinned by an environment variable. (#488)
- The storage card warns when S3 is selected but unreachable (`s3Available`, re-probed); an oversized backup import reports an actionable message. (#488)
- Data-loss & availability hardening for the infra flows: refuse an empty/garbage import; built-in Postgres/MinIO no longer crash-loops a production boot; a transient WA-version fetch failure is no longer cached. (#488)
- Human-readable console logs: `LoggerService` renders a colorized NestJS-style line, defaulting to JSON in production and pretty elsewhere (`LOG_FORMAT`, `NO_COLOR`/`FORCE_COLOR` honored). (#469)

### Fixed

- whatsapp-web.js sessions that scanned the QR then looped `qr → authenticating → disconnected` with no `WWEBJS_WEB_VERSION` pinned: the engine now auto-resolves and pins the current known-good WA Web build (`WWEBJS_WEB_VERSION=off` keeps native auto-select). (#488)
- `/stats/messages` no longer 500s on PostgreSQL (ordered by the aggregate, not a case-folded alias); the chart section shows a clear notice on a real error. (#488)
- The Infrastructure page shows what is actually running for database/Redis/storage/engine (from live `/infra/status`), and reports `redis.enabled`. (#488)
- The built-in Postgres/Redis/MinIO toggles reflect whether the bundled container is actually running. (#488)
- Switching away from a built-in backend tears down the bundled container reliably even after a page reload, preserving named volumes. (#488)
- The "by type" message chart keys a stable distinct color by type name. (#486)
- Removed the oversized decorative watermark icons bleeding through stat cards. (#488)
- Dashboard database/Redis/storage switches now take effect after a restart; compose forwards these settings blank (`${VAR:-}`). (#488)

### Changed

- ⚠️ Compose forwards S3 credentials under canonical `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (adds `S3_REGION`); legacy names still accepted as a fallback. (#488)
- ⚠️ Database/Redis/storage selection is sourced from `data/.env.generated` when not pinned by an env var; set the value explicitly to pin it. (#488)

## [0.7.6] - 2026-06-26

### Changed

- CI runs the dashboard unit tests and re-runs the client-SDK suites when a server DTO or the engine interface changes. (#478)
- The Postgres runtime pool applies `statement_timeout`/`idleTimeoutMillis`/`connectionTimeoutMillis`; the migration connection keeps idle/connection timeouts but never `statement_timeout`. Env-tunable, `0` disables. (#480)

### Fixed

- A plugin whose enable fails after subscribing hooks no longer leaves stale hook registrations behind. (#477)
- The WebSocket `message.ack` event now carries the same `{ id, messageId, status, ack }` shape as the webhook. (#477)
- Reconnect timers are no longer stacked on back-to-back disconnects, and a terminal failure cancels any pending reconnect. (#477)
- The dashboard recovers from a stale lazy-loaded chunk with a single guarded reload; CSP `img-src` now allows `blob:`. (#477)
- The Baileys number-check returns a neutral `<phone>@c.us` id. (#477)
- Data export/import now includes the `lid_mappings` cache. (#477)
- The JavaScript SDK applies JSON `Content-Type`/`X-API-Key` after caller headers; an unfollowed redirect (status `0`) raises a clear error. (#478)
- The infrastructure status endpoint reports the active S3 bucket in S3 mode. (#478)
- The migration CLI honors `data/.env.generated`, so `migration:run:prod` targets the configured database. (#479)
- The first-run generated config writes `STORAGE_LOCAL_PATH` instead of the dead `STORAGE_PATH`. (#479)
- The Sessions page keeps the shared dashboard cache in sync. (#479)

### Security

- The startup banner prints the full admin API key only when first created; masked on subsequent boots. (#478)
- The production secret guard rejects a placeholder `REDIS_PASSWORD` (empty/unset still allowed). (#478)
- The published PHP SDK package no longer ships its test suite, PHPUnit config, or `composer.lock`. (#478)
- The weak-secret guard also rejects `123456`, `qwerty`, `root`, `test`, `demo` (exact match). (#480)
- A startup warning when `API_KEY_PEPPER` is unset in production (advisory, opt-in). (#480)

## [0.7.5] - 2026-06-26

### Fixed

- The stats/analytics endpoint no longer crashes on PostgreSQL; the time-series alias `timestamp` (a reserved keyword) is renamed `bucket`, response field unchanged. (#474)

### Documentation

- Added a Traefik / Coolify reverse-proxy guide to the troubleshooting FAQ. (#467)

## [0.7.4] - 2026-06-25

### Fixed

- WebSocket events are delivered exactly once to a client subscribed to overlapping rooms. (#468)
- `session.authenticated` and `session.disconnected` are now emitted over the WebSocket, matching the webhook payloads. (#468)
- `GET /api/infra/status` reports the actual media storage path (`storage.localPath`, default `./data/media`). (#472)
- The JavaScript SDK `timestamp` fields are documented as Unix seconds; the PHP SDK `Client::request()` is correctly typed. (#472)

### Changed

- The WebSocket `group.join`/`group.leave`/`group.update` events are no longer accepted as socket subscriptions (they have no engine source); they remain reserved on the webhook side. (#468)

### Documentation

- Reconciled the `docs/` set against the v0.7.3 implementation. (#471)

## [0.7.3] - 2026-06-25

### Added

- MCP server (opt-in, `MCP_ENABLED=true`): a curated ~39-tool agent surface over the Model Context Protocol at `POST /mcp`, reusing REST services, auth, roles, and per-session scoping; `MCP_READONLY=true` mounts read tools only. (relates to #256; thanks @tobiasstrebitzer)
- Client SDKs: official hand-written libraries for JavaScript/TypeScript (`@rmyndharis/openwa`), Python (`rmyndharis-openwa`), and PHP (`rmyndharis/openwa`), each with the same fluent resource surface, a typed error hierarchy, and server-mirroring types; published at `0.1.0`. (#463)

### Changed

- CI runs the JavaScript, Python, and PHP SDK test suites (path-filtered to `sdk/**`), and the Packagist mirror is gated on the PHP tests passing.

### Fixed

- Reconnection no longer stalls when a wedged browser fails to shut down (engine teardown is time-bounded to 10s on whatsapp-web.js).
- Message timestamps are consistently returned as a number on both SQLite and PostgreSQL.
- A blank `DATABASE_PASSWORD` forwarded by compose is treated as unset, so a dashboard-saved external-PostgreSQL password applies.
- The Python and PHP SDKs treat an unfollowed redirect (any `3xx`) as an error response, matching the JavaScript SDK.
- Duplicate inbound webhook deliveries: `message.received` is de-duplicated server-side, enforced by a `UNIQUE(sessionId, waMessageId)` constraint; delivery stays at-least-once. (#464)

## [0.7.2] - 2026-06-24

### Added

- Sessions (Baileys): pre-connection chat history is now persisted (de-duplicated, real-timestamped, persist-only), with sender push-names and last-message previews seeded from the history (`BAILEYS_SYNC_FULL_HISTORY=true` for full).
- Sessions (Baileys): chat display names are backfilled on connect via `groupFetchAllParticipating` and a best-effort app-state resync.
- Webhooks: opt-in `WEBHOOK_CONTACT_DETAILS` enriches the `message.received` sender `contact` with already-cached WhatsApp fields (off by default, no extra API calls).

### Fixed

- Sessions (Baileys): a logged-out session's invalid on-disk auth state is cleared, so re-linking shows a fresh QR. (#453 — thanks @ulises2k)
- Webhooks: registering a webhook to a host whose DNS lookup rejects now returns `400 Could not resolve host` instead of a generic 500.
- Infrastructure: the config form no longer shows Server/Webhook/Rate-Limit sections that were never persisted.
- Infrastructure: data export/import now round-trips templates, stored Baileys messages, and webhook filters intact.
- Engine selection: the bundled compose files forward `ENGINE_TYPE` again and a blank value is treated as unset. Upgrade note: confirm the active engine after upgrading. (#453 — thanks @ulises2k)

### Security

- Infrastructure: dashboard-saved config values containing a line break are rejected (env-var injection into `data/.env.generated`).

## [0.7.1] - 2026-06-24

### Added

- Dashboard: a Message Analytics section (24h/7d/30d selector; messages-over-time, by-type, top-chats charts), code-split.
- Infrastructure: an Engine Configuration tile to pick and configure the active engine, applied on restart.

### Changed

- Dashboard: the Messages Today card is populated from real data, API Calls replaced with a Total Messages metric, and the sidebar version is read live from the backend.
- Plugins: the engine adapters are no longer plugin cards (configured under Infrastructure → Engine); the Plugins page is extensions-only.
- Plugins config dialog: segmented control, capped scrolling height with pinned header/footer, wider for config-heavy plugins.
- ⚠️ Deployment: the bundled compose files no longer pin `ENGINE_TYPE`; a real container/host value still takes precedence.
- Docker Compose: production data-path settings and the dev-compose environment are overridable via `${VAR:-default}`. (#450, #451 — thanks @MS-Jahan)

### Fixed

- Chats: voice notes and videos now play (CSP `media-src` for `data:` URIs added).
- Chats: history stickers/images/videos/documents now render (history fetched with its media payload).
- Chats: the conversation back-button icon is visible on small screens.
- Plugins config dialog: Sessions-tab radio buttons no longer stretch to full width.
- Infrastructure: the engine status and config form reflect the real saved values instead of defaults.
- Docker (production builds): the builder stage forces `devDependencies` so `nest build` doesn't fail with `nest: not found` when a PaaS leaks `NODE_ENV=production`. (#449 — thanks @MS-Jahan)

## [0.7.0] - 2026-06-23

> **v0.7 — plugin-contract expansion.** Richer plugin config (declarative + sandboxed-iframe editors),
> per-session activation and config, SSRF-guarded outbound HTTP, and the removal of the bundled
> reference extensions in favour of the marketplace. ⚠️ See the **Removed** note before upgrading.

### Added

- Plugins: richer config-schema vocabulary (`textarea`, `min`/`max`/`pattern`, `items`/`properties`/`enum`), rendered recursively with recursive secret redaction/restore. (#439)
- Plugins: a sandboxed-iframe config editor via manifest `configUi { entry, height? }`, served over an authenticated `GET /plugins/:id/config-ui` and injected as an opaque-origin `srcdoc` iframe with a `postMessage` bridge. (#440)
- Plugins: per-session config overrides via `PUT /plugins/:id/config/:sessionId`, shallow-merged over base config and resolved race-safely via `AsyncLocalStorage`. (#441)
- Plugins: per-session activation via `PUT /plugins/:id/sessions` (`*` or an explicit set), enforced at delivery; a plugin declares `sessionScoped` (default `true`). (#438)
- Plugins: a `ctx.net.fetch` capability for SSRF-guarded outbound HTTP, gated by `net:fetch` plus a manifest `net.allow` host allowlist, timeout- and size-bounded. (#437)
- Chats: opening a conversation backfills recent history from WhatsApp when nothing is stored yet.
- Engine (whatsapp-web.js): a reconnect that stalls mid-authentication self-heals; the WA Web build can be pinned via `WWEBJS_WEB_VERSION`.
- Dashboard: a searchable plugin catalog, full audit-log CSV export, the running version in the sidebar, and an engine-aware config dialog.

### Changed

- Dashboard, small screens: the chat view is a single-pane list → conversation flow with a back control; page headers place the description under the title; a consistent keyboard-only focus ring.
- Plugins (install): install-from-URL / catalog downloads follow CDN redirects safely (each hop re-validated through the SSRF guard).

### Removed

- ⚠️ Breaking: the bundled reference extensions `auto-reply` and `translation` are removed from core, superseded by the marketplace plugins `chat-flow` and `group-translate`; the ids remain reserved. Built-in engines are unaffected.

### Fixed

- Plugins: per-session activation and config are now preserved across the second restart (registry rebuild carried those fields). (#441)
- Docker: the builder stage is pinned to `$BUILDPLATFORM` so it runs natively, fixing the `linux/arm64` build failure (`lightningcss.linux-arm64-gnu.node`).
- Inbound media is size-capped before buffering and concurrent downloads are bounded, on both engines.
- Plugins: composite `secret` fields are fully masked on read; storage files/dirs are owner-only; assorted sandbox/installer robustness fixes.

### Security

- Session scope is enforced on the session-statistics overview and per-session plugin config. (Full plugin activation replacement was later moved to unrestricted ADMIN in 0.12.0.)

## [0.6.2] - 2026-06-23

Plugin platform follow-ups (sandbox hardening, install-from-URL + catalog), a mark-chat-unread
endpoint, and a batch of correctness/housekeeping fixes.

### Added

- Install plugins from a URL / catalog: `POST /plugins/install-url` (SSRF-guarded download through the same validate-write-load pipeline) and `GET /plugins/catalog` (`PLUGIN_CATALOG_URL`) with a dashboard Catalog tab. (#433)
- Update a plugin in place via `POST /plugins/:id/update`, preserving operator config and enabled state; the old version is backed up and restored on failure. (#433)
- Mark a chat as unread: `POST /sessions/:id/chats/unread` on both engines. (#432)

### Security

- Untrusted (uploaded) plugins run with a minimal allowlisted worker environment instead of inheriting the host `process.env`. (#431)

### Fixed

- Webhook delivery no longer POSTs an empty body when a `webhook:before` hook returns a result without a `payload` key. (#434)
- The `session.qr` WebSocket event is now actually emitted from the QR callback. (#434)
- Storage usage reports real S3 object sizes; local file writes no longer block the event loop during an import. (#434)
- A sandboxed plugin whose `load`/`onEnable`/`onDisable` hangs no longer blocks the request; lifecycle calls are time-bounded and disable always tears the worker down. (#431)
- Sandboxed plugins now receive `onConfigChange` and have their real `healthCheck` run. (#430)
- Plugin `onDisable` now runs on graceful shutdown (`OnModuleDestroy`). (#430)
- A concurrent enable of the same plugin no longer double-runs `onEnable` or double-registers hooks. (#430)
- Plugin storage writes are now atomic (temp file then rename). (#430)

### Changed

- The plugin-management UI strings are now translated into every locale. (#429)

## [0.6.1] - 2026-06-22

### Fixed

- The `message:ack` hook event now fires for every delivery/read receipt with `{ messageId, status, ack }` (previously declared but never emitted); delivery failures surface as `status: 'failed'`.

## [0.6.0] - 2026-06-22

### Added

- Install and uninstall plugins from the dashboard: upload a `.zip` (`POST /api/plugins/install`) and remove it (`DELETE /api/plugins/:id`), with a redesigned Plugins page (status rail + catalog). Only `extension` plugins are installable; built-ins cannot be uninstalled.

### Changed

- ⚠️ **Breaking (plugin authors):** plugins in `plugins/` now run sandboxed in an isolated worker thread with a curated context (`messages`, `engine`, `storage`, `logger`, `config`, `pluginId`, `registerHook`) and host-side permission checks; built-ins still run in-process. See `docs/23-plugin-sandboxing.md`.
- Engines are now single-active: enabling an engine other than the configured `engine.type` is rejected; the dashboard shows one **Active** engine and others **Available**.
- Calmer plugin cards: clean cards with a subtle type-tinted icon replace the gradient headers.

### Fixed

- Plugins page: current state is now a neutral chip and actions a solid green button (previously all the same green). (#417)
- The dashboard reports each plugin's real built-in status. (previously only the whatsapp-web.js engine was flagged)
- The appearance/theme popover no longer spills outside the sidebar. (#424)

## [0.5.1] - 2026-06-22

### Changed

- Plugin capability permissions are now enforced: a plugin may use `ctx.messages.*` or `ctx.engine.*` only if its manifest declares the matching permission (`messages:send` / `engine:read`), else denied with `PluginCapabilityError`. (#412)
- Bulk-message variable substitution now uses the same `{{name}}` syntax as message templates; legacy `{name}` still honored. (#69, #411)

### Deprecated

- Single-brace `{name}` placeholders in bulk-message content; prefer `{{name}}`. (#69, #411)

### Fixed

- A session is no longer mutated by callbacks from an engine it has replaced or torn down; each engine's lifecycle/message callbacks no-op once it is no longer the live engine. (#410)

## [0.5.0] - 2026-06-21

### Changed

- The contact, group, and chat list endpoints are now paginated with a default cap of 1000 (⚠️ behavior change); accept optional `limit` (`[1, 1000]`) and `offset`, chats returned most-recent first. In-process callers still receive the full set. (#401)
- Fresh databases no longer create the unused `api_keys`/`audit_logs` tables on the data connection; existing installs unaffected. (#400)

### Fixed

- Browser launch flags saved from the dashboard now apply (parser accepts space- or comma-separated; existing values repaired on next boot). (#397)
- A session-restricted API key is no longer wrongly denied on non-session routes; session scoping applies only where `:id` denotes a session. (#398)
- Boot is rejected when the SQLite `DATABASE_NAME` collides with the internal main database file. (#399)
- Numeric environment variables (rate-limit, webhook timeout/retry, DB pool size) are validated at boot instead of silently becoming `NaN`. (#402)
- The whatsapp-web.js engine now detects remote media URLs case-insensitively, matching Baileys. (#404)
- A session stopped or deleted mid-startup is no longer resurrected to `READY`. (#405)

### Security

- DNS resolution in the SSRF guard is now bounded by a deadline (default 10s, `SSRF_DNS_TIMEOUT_MS`). (#404)
- Custom webhook headers are now validated as a flat, control-character-free string map (max 50 entries, value max 1024 chars). (#403)
- Swagger UI (`/api/docs`) now defaults OFF in production; re-enable with `ENABLE_SWAGGER=true`. (#402)
- Plugin inventory, detail, and health reads now require the ADMIN role. (#398)
- The dashboard-generated env file is now written owner-only (`0600`). (#397)

## [0.4.8] - 2026-06-21

### Changed

- A published GitHub Release now waits for the container image build. (#389)
- The data migration CLI is scoped to the data-owned tables (session/webhook/message/template/engine). (#391)

### Fixed

- Dashboard collapses duplicate connection-lost toasts during a reverse-proxy outage; the thrown error now always carries the HTTP status code. (#388)
- `WWEBJS_AUTH_TIMEOUT_MS` now takes effect in Docker (both compose files pass it through) and is validated as a safe integer. (#393)
- Outbound base64 media (single and bulk) is now size-capped against `MEDIA_DOWNLOAD_MAX_BYTES` (`413` when too large); bulk-send nested media payloads are validated as typed objects (`400` on junk). (#394, #395)

## [0.4.7] - 2026-06-21

### Added

- Smart webhook filters (optional, additive): a trigger can carry AND-ed pre-dispatch conditions on `sender` / `recipient` / `body` / `type` / `mentions` / `fromMe` / `hasMedia` / `isGroup` (with `is` / `isNot` / `contains` / `equals`), matching contacts by engine-neutral `WaId`, plus a FilterBuilder UI. (#379)
- Configurable first-boot init timeout for the whatsapp-web.js engine (`WWEBJS_AUTH_TIMEOUT_MS`); unset keeps the 30000ms default. (#353)

### Changed

- Dashboard collapses connection-error spam into a single "Server Connection Lost" toast. Original work by @quinton-8. (#293)

### Fixed

- Dashboard no longer crashes when a webhook exists on PostgreSQL: `jsonColumnType()` now resolves to `simple-json` on both dialects, fixing JSON columns returned as raw strings. (#385)

## [0.4.6] - 2026-06-20

### Added

- Persistent, cross-session `lid -> phone` resolution via a new `lid_mappings` table, plus a `from` query param on `GET /api/sessions/:sessionId/messages` that resolves through it; no webhook/WebSocket/REST shape changes. (#374)
- Webhook parity for message reactions: reactions now also delivered as a `message.reaction` webhook (previously WebSocket-only); `*`-subscribed webhooks now receive it. (#380)
- Dashboard appearance palettes (light/dark/system + accent palettes) and a redesigned, searchable Templates workspace. (#361)
- `BAILEYS_LOG_LEVEL` (trace|debug|info|warn|error, silent by default) surfaces Baileys' own diagnostics; `trace` dumps decoded wire frames. (#375)

### Fixed

- Baileys engine: contacts, chats, and recent history now sync on connect (`shouldSyncHistoryMessage: () => true`); full-archive download stays opt-in via `BAILEYS_SYNC_FULL_HISTORY`. (#375)
- Message history `chatId` filter now matches across dialects (`<phone>@c.us` also returns `<phone>@s.whatsapp.net` rows). (#375)
- Baileys engine: contact and chat listing ids are now engine-neutral (`@c.us`); read-back paths accept the neutral id. (#374)
- Hardened the LibreTranslate translation client against DNS rebinding by pinning the connection to the pre-validated address and refusing redirects. (#377)
- Baileys group-participant operations now address participants in the engine wire dialect. (#378)
- Italian translation corrections. (#376)

## [0.4.5] - 2026-06-20

### Added

- Opt-in deep chat history (`deep=true`) on `GET /sessions/:id/messages/:chatId/history` raises the ceiling to 2000 messages (metadata-only) on whatsapp-web.js; Baileys still returns `501`. (#347)

### Fixed

- Baileys engine: the Chats list now shows saved/contact names (saved → business `verifiedName` → pushName) instead of a raw number or `@lid`. (#369)
- Baileys engine: `@lid` senders now resolve to a phone number by learning the `lid -> phone` pair on the inbound message key (`senderPn` / `participantPn`). (#362)
- Baileys engine: inbound message ids are now engine-neutral (`@c.us`), matching whatsapp-web.js. ⚠️ Consumer-visible: `message.received` / `revoked` / `reaction` payloads now carry `@c.us` where they previously carried `@s.whatsapp.net` (or a resolved `@lid`).
- Baileys engine: documents can now be sent with a caption (parity with whatsapp-web.js). (#363)

## [0.4.4] - 2026-06-20

### Added

- CLI migration commands for the main (auth/audit) connection: `migration:run:main`, `migration:generate:main`, `migration:show:main`, `migration:revert:main` (plus `:prod` variants). (#364)

### Changed

- `PUT /settings` now returns `501 Not Implemented` instead of a misleading `200`; settings are environment-derived and read-only at runtime. (#364)

### Fixed

- Baileys reconnect no longer leaks the previous socket (detached and ended before its replacement). (#364)
- Engine sessions keep operator config when the engine plugin fails to enable before `onLoad`. (#364)
- Template names are unique per session (composite unique index, `409` on duplicate, with a lossless de-duplicating migration). (#364)
- Container no longer crashes on browser-cleanup paths when `ps` is missing; the image now installs `procps`. (#359)

### Documentation

- Documented chat-history limits: the local message-history endpoint vs the bounded live-history endpoint (default `limit=50`, clamped `[1, 100]`). (#356)

## [0.4.3] - 2026-06-19

### Added

- Force-kill a stuck session: `POST /sessions/:id/force-kill` (OPERATOR) SIGKILLs the whatsapp-web.js Chromium directly (Baileys ends its socket), leaving the session `DISCONNECTED` and restartable. (#352)
- Dashboard "Kill Stuck" button on session cards in a `failed` state. (#351)

### Security

- Outbound webhook and media fetches are pinned to the SSRF-validated IP (closing a DNS-rebinding window) across delivery and server-side media downloads. (#338)
- IPv6 SSRF blocklist closes embedded-IPv4 gaps (6to4, NAT64, IPv4-compatible); the LibreTranslate client is SSRF-guarded; per-session `proxyUrl` is validated. (#344)
- Secret/auth hardening: generated secret files written `0600`; opt-in `API_KEY_PEPPER` (HMAC-SHA256); `allowedIps` validated as IPv4/CIDR; Bull Board auth uses the trusted-proxy IP model; the production secret-guard inspects canonical S3 variables. (#345)
- Storage import/key hardening: `tar.gz` import bounded against decompression bombs; storage-key containment enforced at the backend-agnostic boundary; a plugin's `ctx.storage` is sandbox-contained against `..` traversal. (#346)

### Fixed

- Webhook subscriptions for session lifecycle events (`session.status`/`qr`/`authenticated`/`disconnected`) now deliver. (#335)
- Plugin enable/disable and configuration now persist across restarts; plugins are not auto-enabled on boot. (#339)
- Bulk-sent messages are recorded, their errors no longer leak internal addresses, and a running batch can be cancelled across instances. (#340)
- Forwarded messages on whatsapp-web.js report a real WhatsApp message id, so their delivery status advances. (#341)
- A late delivery/read receipt is no longer lost (ack retries once); concurrent reactions no longer overwrite each other; an erroring plugin hook's partial output is not applied; a failed ack write is logged. (#348)
- Storage export writes under `data/exports/` with a TTL sweep and an async read, no longer accumulating copies on the data volume. (#346)
- `WEBHOOK_TIMEOUT` is honored on the queued and test delivery paths; graceful shutdown is bounded; unsupported operations return `501`; a misconfigured `ENGINE_TYPE`/`STORAGE_TYPE` fails fast at boot. (#350)

### Changed

- The `/api/metrics` scrape is memoized for a few seconds; removed a dead branch in the WebSocket connect handler. (#350)

### Documentation

- Added a phone-number pairing example. (#343)
- Documented the webhook `idempotencyKey`/`deliveryId` fields and dedup rule; corrected the `.env.example` rate-limit variable names. (#350)

## [0.4.2] - 2026-06-19

### Security

- The well-known development API key is refused in production: `ALLOW_DEV_API_KEY=true` now fails fast, and `dev-admin-key` is rejected as an `API_MASTER_KEY`.
- Webhook by-id operations and the webhook list are scoped to their session (mismatch returns 404; `GET /webhooks` scoped to allowed sessions).
- `GET /sessions` is scoped to the API key's allowed sessions.
- The audit log and global statistics (`GET /audit`, `GET /stats/overview`, `GET /stats/messages`) require ADMIN.
- Plugin secrets are redacted on read; updating config preserves a stored secret when the masked value is submitted unchanged.

### Fixed

- Baileys: inbound and sent messages no longer fail to persist for a recreated session; the store skips the write for an absent parent session. (#319)
- `import-data` no longer silently loses message history: column mapping corrected for SQLite and PostgreSQL, and a partial restore now rolls back and reports `imported: false`.
- Statistics work on a PostgreSQL data database (dialect-correct date bucketing).
- Concurrent session start no longer orphans an engine; the second start is rejected.
- A stuck engine teardown no longer wedges a session: `delete()`/`stop()` time-bound and isolate teardown.
- Reconnect backoff is bounded: `reconnectBaseDelay` / `maxReconnectAttempts` are coerced and clamped.
- Inbound media is size-capped by `MEDIA_DOWNLOAD_MAX_BYTES` (default 50 MiB); oversized media is dropped.
- `reply` / `forward` / `react` / `delete` on a missing message return 404 instead of 500.
- Swagger now reports the current API version.

### Documentation

- Added an n8n appointment-booking workflow example and webhook signature-verification examples; corrected the `message.received` payload field reference.

## [0.4.1] - 2026-06-18

### Fixed

- Baileys QR code is now scannable from the dashboard: the adapter renders it to a `data:image/png` URL, matching whatsapp-web.js.
- Adopting migrations over a `synchronize`-created SQLite data DB no longer crashes on boot; the baseline migration is now idempotent.
- Graceful shutdown no longer logs "could not find DataSource" on SIGTERM; the connection factories carry their `name` so the named DataSource resolves.

### Changed

- Internal: the SQLite data-DB configuration comment and a dead `synchronize` default in `app.module.ts` now reflect actual behavior. No runtime change.

## [0.4.0] - 2026-06-18

### Changed

- **BREAKING — single-port dashboard:** in production the NestJS API serves the built dashboard from its own port (default `2785`) via `@nestjs/serve-static`; `/api` and `/socket.io` are excluded. Opt out with `SERVE_DASHBOARD=false`; dev is unchanged. (#275)
- The API's Content-Security-Policy now allows `https://fonts.googleapis.com` and `https://fonts.gstatic.com` for the dashboard's webfonts. (#275)
- **BREAKING — removed the bundled Traefik reverse proxy** (`traefik` service, `traefik/` configs, and the `with-proxy` profile); front the API with your own reverse proxy for TLS. (#276)

### Added

- `npm run build:all` and `npm run prod` for running the production build directly without Docker. (#275)

### Migration

- The dashboard moved from `:2886` to the API port `:2785`; update bookmarks, monitoring, and reverse-proxy config. (#275)
- The `with-dashboard`/`with-proxy` compose profiles and the `DASHBOARD_PORT`, `PROXY_ENABLED`, `DASHBOARD_ENABLED` env vars are removed (silently ignored if set); `--profile full` now starts the optional datastores. (#275, #276)

## [0.3.0] - 2026-06-18

> ⚠️ **Breaking (plugin API):** `PluginContext.getService` is removed; out-of-tree plugins must migrate to the new `ctx.messages` / `ctx.engine` capabilities.

### Added

- Baileys engine (`ENGINE_TYPE=baileys`): a second, browser-free WhatsApp engine on `@whiskeysockets/baileys`, supporting linking (QR + pairing code), send (text/media/location/contacts), reply/forward/react/delete, full group management, profile pictures, block/unblock, contacts/chats/read receipts, and receiving messages with media/captions/location/quotes/reactions/deletes. `getChatHistory` and labels/channels/status/catalog return `501`. Loads lazily; no global Node version floor. (#299, #307, #308, #309, #310, #312)
- Plugin capability layer (Tier-2 extension plugins): scoped `ctx.messages` (`sendText`/`reply`, routed through `MessageService`) and read-only `ctx.engine` (`getGroupInfo`/`getContacts`/`getContactById`/`checkNumberExists`/`getChats`), with a manifest-declared `sessions` scope enforced at the facade. (#294)
- `HookManager` re-entrancy guard (`AsyncLocalStorage`): a plugin sending from inside a hook handler can no longer synchronously recurse into the same event. (#294)
- `auto-reply` reference extension plugin, first-party and registered disabled by default. (#294)
- Group auto-translation extension plugin (first-party, disabled-by-default) via LibreTranslate on the capability layer. (#300)
- Schema-driven plugin config form (dashboard) for any plugin exposing a `configSchema` (text/secret/number/boolean/enum). (#303)
- Spanish (`es`) dashboard locale at full parity with English. (#292)

### Changed

- Engine config is now opaque per-engine: `EngineFactory` passes only engine-neutral fields and supplies engine-specific config via the plugin context. No env-var or behavior change. (#296)

### Fixed

- Dashboard stops polling for a QR code once its session is connected, and the dev Docker Compose setup proxies the dashboard to the API service correctly. (#311)
- Italian locale: the message-template strings are now fully translated. (#301)

## [0.2.10] - 2026-06-17

### Fixed

- MessageTester (dashboard) resolves the recipient through the engine and surfaces a clear "not registered on WhatsApp" message; new `messageTester.notOnWhatsApp` string across all 8 locales. (#279)
- Dashboard message bubbles use the engine-neutral `MessageType` vocabulary end-to-end (websocket/revoked payloads coerced via `asMessageType()`; optimistic bubbles typed from MIME). (#281)

### Internal

- CI: bump `docker/setup-qemu-action` v3 → v4 (Node 24), clearing the Node-20 deprecation warning. (#280)

## [0.2.9] - 2026-06-17

> ⚠️ **RBAC tightening (action may be required):** write endpoints for groups, contacts, labels, channels, catalog, and status now require the `OPERATOR` role. Switch any `VIEWER` key used for these writes to `OPERATOR` (or `ADMIN`).

### Security

- Write endpoints for groups, contacts, labels, channels, catalog, and status now require the `OPERATOR` role; read endpoints remain open to any valid key. (#284)
- Patched a high-severity `ws` advisory and a moderate `qs` DoS on the socket.io transport by bumping in-range deps (`ws`→8.21.0, `engine.io`→6.6.9, `qs`→6.15.2) in API and dashboard; lockfile-only. (#283)

### Added

- `LOG_LEVEL` is now honored (applied at bootstrap; previously read but hardcoded to `info`). (#287)
- Automatic audit-log retention: logs older than `AUDIT_RETENTION_DAYS` (default 90; `0` disables) are pruned daily and at startup. (#287)

### Fixed

- Bulk-message batch status is now correct on cancel and stop-on-error (terminal status re-derived); bulk item `type` is validated against the allowed set with `@IsIn`. (#286)
- Graceful shutdown is now robust: `onModuleDestroy` clears reconnect timers first and destroys engines in parallel, each isolated and time-bounded; a session that exhausts reconnects is marked `FAILED` with a reason; BullMQ webhook jobs are auto-evicted. (#287)
- Engine-event handlers no longer risk unhandled promise rejections: webhook dispatch is self-contained, hook chains carry `.catch()`, audit-log writes are best-effort, and a process-level `unhandledRejection` backstop logs instead of crashing. (#285)
- Dashboard accessibility: toasts are an ARIA live region, API-key visibility toggles have state-reflecting `aria-label`s; new `common.showApiKey`/`common.hideApiKey` strings across all locales. (#288)
- Dashboard no longer shows a misleading empty state when a list fetch fails on the Webhooks, API Keys, and Logs pages; an accessible error banner is shown instead. (#291)

### Internal

- Added critical-path test coverage for `HookManager`, `AuditService`, and the Postgres-UUID migration (497 tests total). (#289)
- Dead-code sweep across the backend and dashboard. (#290)

## [0.2.8] - 2026-06-17

> ⚠️ **Breaking for webhook consumers:** the `message.received`/`message.sent` `type` field is now a neutral enum — `chat` → `text`, `ptt` → `voice`, `vcard`/`multi_vcard` → `contact`. Update any consumer that matched the raw whatsapp-web.js tokens.

### Added

- Message templates (dashboard): create/edit/delete reusable templates with `{{variable}}` placeholders, backed by the `sessions/:id/templates` API, with full i18n. Thanks @Leslie-23 (#266).
- Resolve a `@lid` privacy id to a phone number via `IWhatsAppEngine.resolveContactPhone`: `GET /sessions/:id/contacts/:contactId/phone`, plus optional inline resolution with `RESOLVE_LID_TO_PHONE=true` attaching `senderPhone` to `message.received`. (#263)

### Changed

- Message delivery status is now engine-agnostic: a neutral `DeliveryStatus` (`pending`/`sent`/`delivered`/`read`/`failed`) flows through the interface, services, webhooks, websocket, and dashboard. The `message.ack`/`message.failed` webhooks add a neutral `status` field; the legacy `ack` integer is kept (deprecated); dashboard ticks update live. (#265)
- Message `type` is now an engine-neutral enum (`text`/`image`/`video`/`audio`/`voice`/`document`/`sticker`/`location`/`contact`/`revoked`/`unknown`) across live/history messages, persisted rows, and the `message.received`/`message.sent` webhooks; an idempotent startup backfill rewrites existing rows. (#265)
- JID construction moved into the engine: the check-number endpoint returns the engine's canonical chat id via `IWhatsAppEngine.getNumberId(number)`; status/story broadcasts are flagged with a neutral `isStatusBroadcast`. (#265)

### Fixed

- The `WWEBJS_WEB_VERSION` (and `WWEBJS_WEB_VERSION_REMOTE_PATH`) workaround for sessions stuck at "authenticating" is now passed through by the Docker Compose files. (#273, #251)
- Refined the Italian (`it`) dashboard translations. Thanks @albanobattistella (#272).

## [0.2.7] - 2026-06-16

### Added

- Typing simulation before single text sends (anti-ban), on by default; disable with `SIMULATE_TYPING=false`, cap with `SIMULATE_TYPING_MAX_MS` (default 5000). Adds `IWhatsAppEngine.sendChatState` and `POST /sessions/:id/chats/typing` (`typing` | `recording` | `paused`).
- `GET /infra/engines` and the dashboard Active Engine card now report the underlying engine library version (e.g. `whatsapp-web.js 1.34.7`).
- Delete a chat via `POST /sessions/:id/chats/delete` (`OPERATOR` role). Thanks @tobiasstrebitzer (#261).

### Fixed

- Fixed duplicate outgoing messages in the dashboard Chats view (optimistic/echo race is now race-safe).
- `dashboard/nginx.conf` now targets `openwa-api` for `/api/` and `/socket.io/`. Thanks @Abhishekrajpurohit (#259).
- The container entrypoint clears stale Chromium `SingletonLock`/`SingletonSocket`/`SingletonCookie` files so a session can re-launch after an unclean shutdown. Thanks @Abhishekrajpurohit (#259).

### Changed

- `mark-chat-read` `chatId` validation is now engine-neutral (accepts any engine's JID scheme).

## [0.2.6] - 2026-06-16

### Fixed

- Chromium no longer crashes at launch on hardened `read_only` containers; it is given writable, pre-created `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` dirs (supersedes the no-op `--crash-dumps-dir` from 0.2.5). (#254)
- The Login screen's language `<select>` popup is now legible in dark mode. (#249)

## [0.2.5] - 2026-06-16

### Added

- Pairing-code linking — `POST /sessions/:id/pairing-code` returns an 8-character code to link a session without scanning the QR. (#252)

### Fixed

- Chromium is given an explicit writable `--crash-dumps-dir` to avoid `--database is required` launch failures on some hardened/container hosts. (#254)
- Dashboard native controls (select popups, scrollbars) now follow the explicit app theme via `color-scheme`. (#249)

## [0.2.4] - 2026-06-16

### Added

- Pinnable WhatsApp Web version via `WWEBJS_WEB_VERSION` to work around sessions stuck at `authenticating`; opt-in. (#251)

### Fixed

- Dashboard login over LAN no longer returns 500; a disallowed CORS origin now denies without throwing. (#250)
- Data-export stream now surfaces archive-level errors (gzip/finalize) instead of an unhandled rejection or truncated download. (#248)

## [0.2.3] - 2026-06-15

### Fixed

- Dashboard now works over plain HTTP on a non-`localhost` origin; toast ids and the API-key copy button degrade gracefully without secure-context APIs. (#244)
- The Infrastructure "View Bull Board" link opens the configured API origin instead of hardcoded `http://localhost:2785`.

### Changed

- The dev compose bind host is configurable via `BIND_HOST` (default `127.0.0.1`). Thanks @Stanley-blik (#245).

## [0.2.2] - 2026-06-15

### Added

- Prometheus metrics at `GET /api/metrics` (disabled by default; set `METRICS_TOKEN`).

### Security

- Webhook HMAC `secret` and custom `headers` are never returned from any webhook API response.
- Media-fetch SSRF closed: `MessageMedia.fromUrl` runs an SSRF host guard + byte cap + timeout.
- Redirects are no longer followed on webhook deliveries or media fetches.
- Webhook SSRF protection is ON by default and validated at registration.
- Docker hardening: socket-proxy isolated on an `internal` network; API runs with `cap_drop: [ALL]`, `no-new-privileges`, `read_only` rootfs + tmpfs, and pid/mem limits.
- Plugin loader rejects a manifest `main` that escapes the plugin directory.
- WebSocket: API key re-validated on every subscribe, no longer sent in the handshake URL, CORS uses the configured allowlist.
- Production boot refuses to start with empty/placeholder secrets; default datastore credentials removed.
- Rate limiting keys on the resolved client IP instead of the proxy IP.

### Changed

- Webhook read routes now require an `OPERATOR`+ key.
- Webhook `events[]` are validated against known event types (plus `*`).
- The six inline-body message endpoints (+ label/channel) now validate their input.
- The `main` auth/audit DB `synchronize` is config-driven (`MAIN_DATABASE_SYNCHRONIZE`, default on) with a bundled migration.
- `/api/health/ready` performs real database checks and returns 503 when a dependency is down or draining; the container `HEALTHCHECK` points at it.

### Fixed

- Message ack status UPDATE is scoped by `sessionId` and backed by a composite index.
- `getMessages` sanitizes `limit`/`offset`.
- Postgres database name honors `DATABASE_NAME` consistently between runtime and migration CLI.
- Backup/restore scripts capture both databases (incl. `main.sqlite`) + sessions.
- Boot-time validation rejects an unknown `DATABASE_TYPE` and missing Postgres credentials.
- Message-event idempotency keys are session-scoped.
- Response-envelope docs corrected to the raw-payload shape; unused interceptor/filter removed; horizontal-scaling docs marked single-instance.
- Headless Chromium now starts as the non-root `openwa` user in the Docker image. (closes #242)
- Marking a 1:1 chat as read now accepts `@lid` JIDs. Thanks @suraj7974 (#241).
- Allowlisted IPv6 literals in `SSRF_ALLOWED_HOSTS` match whether or not bracketed.
- The dashboard returns to the login screen cleanly on a `401`.
- A webhook `secret` cleared via update is normalized to "no secret" and length-capped.

### Dependencies

- `@bull-board/{api,nestjs,express}` 7.2.1 → 8.0.0, `@types/archiver` 7 → 8, plus minor/patch bumps (NestJS 11.1.27, BullMQ 5.78.1, AWS SDK, ESLint 10.5, Prettier 3.8, typescript-eslint 8.61).

### Upgrade notes (behavior changes)

- Webhook reads now require `OPERATOR`+ (a `VIEWER` key gets `403`).
- SSRF protection defaults ON — set `SSRF_ALLOWED_HOSTS` or `WEBHOOK_SSRF_PROTECT=false` for internal hosts.
- Datastore secrets are now required — no `openwa`/`minioadmin` default; production refuses to boot with placeholders.
- Bull Board `?apiKey=` removed — authenticate via `X-API-Key`/`Authorization: Bearer`.
- New env knobs: `SSRF_ALLOWED_HOSTS`, `MEDIA_DOWNLOAD_MAX_BYTES`, `MEDIA_DOWNLOAD_TIMEOUT_MS`, `MAIN_DATABASE_SYNCHRONIZE`, `SHUTDOWN_DELAY_MS`, `OPENWA_MEM_LIMIT`, `METRICS_TOKEN`.

## [0.2.1] - 2026-06-15

### Fixed

- Dashboard API client honors `VITE_API_URL` for split-origin deployments (appends `/api`); fixes "Invalid API Key" when hosted on a different origin. Thanks @jairo315-bit (#91).

### Dependencies

- Dashboard: bump TypeScript 5.9.3 → 6.0.3 (#140).

## [0.2.0] - 2026-06-15

### Added

- Dashboard Chats: real-time view to browse conversations, stream incoming/outgoing messages over WebSocket, send text and media, and mark chats read. Thanks @akbarxleqi (#152).
- Dashboard i18n: six new languages (Simplified/Traditional Chinese, Arabic RTL, Telugu, French, Italian) on a single picker that also appears on Login and resolves `zh-Hant/HK/MO/TW` variants. Thanks @jr-everstar (#150), @7odaifa-ab (#145), @abhinayguduri (#149), @albanobattistella (#224).
- Messages: server-side message templates with `{{variable}}` substitution — CRUD under `/sessions/:id/templates` plus `POST /sessions/:id/messages/send-template`. Text only. Thanks @esakarya (#69).
- Messages: `GET /sessions/:id/messages/:chatId/history` reads chat history live from WhatsApp, optional base64 media, `limit` clamped 1–100. Thanks @jgalea (#96, closes #162).
- Groups: payloads now expose `linkedParentJID`. Thanks @ferhatte10 (#201).
- Webhooks: `message.sent` now fires for every outgoing message, including messages composed on a linked phone. (closes #93, #168, #195)
- Webhooks/Sessions: stored message status reflects real delivery state (`delivered`, `read`, `failed`) advancing monotonically; a send without a delivery ack stays `sent`; new `message.failed` webhook on an error ack. Independently identified and prototyped by @aminebalti55 (#225). (closes #155, #199, #220)
- Webhooks: opt-in outbound SSRF protection via `WEBHOOK_SSRF_PROTECT=true` (default off). (#221)
- API: `BODY_SIZE_LIMIT` caps request body size (default 25 MB); `ENABLE_SWAGGER` gates `/api/docs` (default on). (#221, #67)
- Webhooks: `message.received` payloads now include the group sender's `author` and `contact` `{ name, pushName }`. (#223, closes #146)
- Sessions: opt-in auto-start of authenticated sessions on boot via `AUTO_START_SESSIONS=true` (default off); sequential, one failure does not block others. Thanks @mayko7d (#135, closes #218).
- Sessions: `PUPPETEER_EXECUTABLE_PATH` points the engine at a system Chromium/Chrome binary. (#219)
- Docs: community integrations page documenting the ioBroker adapter. (#223, closes #134)

### Changed

- Engine: upgraded `whatsapp-web.js` 1.26.1-alpha.3 → 1.34.7. (#222)
- Dashboard: responsive small-screen layout and improved dark-mode contrast; Plugins page no longer truncates the feature list. Thanks @ashiwanikumar (#66).
- Auth: first-boot admin key is a random `owa_k1_` key in all environments; fixed `dev-admin-key` seeded only when `ALLOW_DEV_API_KEY=true`. (#221)
- Auth: a valid key with insufficient role now returns 403 instead of 401. (#221)
- Docker/Podman: fully qualified base images (`docker.io/node:22-slim`) and a `curl` healthcheck, so the image runs under Podman. Thanks @3bsalam-1 (#68).
- Docs/API: interactive `Buttons`/`List` messages documented as unsupported on whatsapp-web.js; speculative request-body examples removed. (#223, closes #158)

### Fixed

- Sessions: an engine op while disconnected/reconnecting/initializing now returns 409 Conflict instead of 500. Thanks @VincenzoKoestler (#100)
- Sessions: a terminal engine failure surfaces as `failed` status with a reason instead of silently closing the QR modal; `auth_failure` is terminal; a `qr_ready`→`initializing` race is fixed. (#219)
- Engine: the built-in engine plugin now honors `SESSION_DATA_PATH` and configured Puppeteer settings. (#219)
- Infrastructure dashboard: saved config (`data/.env.generated`) now applies reliably (env names match `configuration.ts`), merges into the existing file, and hydrates from a new `GET /infra/config`. Thanks @VincenzoKoestler (#226).

### Security

- CORS: a wildcard origin is refused in production; credentials only enabled with an explicit allowlist. (#221)
- WebSocket: a session-scoped key can no longer subscribe to `*` or sessions outside its `allowedSessions`. (#221)
- Authorization: plugin enable/disable/config and the infra read endpoints now require an ADMIN key. (#221, #226)
- Docker: the container reaches the Docker API via a least-privilege `docker-socket-proxy` over TCP; Node runs as non-root `openwa` via a `gosu` entrypoint (`dumb-init` PID 1). Thanks @A831ARD0 (#227, #228; supersedes #129).
- Health: `/api/health` excluded from rate limiting. (#221)

### Dependencies

- CI: `softprops/action-gh-release` v2→v3 and `docker/build-push-action` v6→v7. (#169, #170)

### Upgrade notes

- CORS in production: set `CORS_ORIGINS` to explicit dashboard origin(s) — a wildcard is now refused.
- Infrastructure reads are ADMIN-only (`/api/infra/status`, `/infra/config`, `/engines`, `/engines/current`, `/storage/files/count`).
- Role-denied requests return 403 (was 401).
- Not-ready engine ops return 409 `SESSION_NOT_READY` (was 500).
- First-boot key: non-production no longer seeds `dev-admin-key`; a random key is printed/written to `data/.api-key`. Set `ALLOW_DEV_API_KEY=true` to restore.
- Docker: Compose now runs a `docker-proxy` sibling and the container runs as non-root; review the new Compose if you mounted the socket directly.

## [0.1.8] - 2026-06-13

### Added

- Dashboard Setup: Infrastructure screen exposes a Verify SSL Certificate toggle (`DATABASE_SSL_REJECT_UNAUTHORIZED`), shown when SSL is enabled.

### Fixed

- Database: the runtime PostgreSQL connection now honors `DATABASE_SSL` and `DATABASE_SSL_REJECT_UNAUTHORIZED` (previously only wired into the migration CLI). Thanks @farrasyakila (#205, closes #204).
- Webhooks: fixed idempotency-key generation so incoming-message webhooks use `id ?? messageId` instead of collapsing to `msg_unknown`. Thanks @Singh1106 (#179).
- Dashboard: the Login screen derives its version from `package.json` at build time. (closes #88)

## [0.1.7] - 2026-06-13

### Security

- Path traversal in storage import: added a path-containment check on local read/write. Fixes #151. (#207)
- Broken access control: every `/api/infra/*` mutating and data-exfiltration endpoint now requires ADMIN. (#207)
- X-Forwarded-For IP spoofing: `ApiKeyGuard` now ignores `X-Forwarded-For` by default, honoring it only for configured `TRUSTED_PROXIES`. (#211)
- Fail-closed IP whitelist: a key with `allowedIps` but an undetermined client IP now rejects; `GET /sessions/:id/qr` now requires `OPERATOR`. (#213)
- Bull Board queue UI (`/api/admin/queues`) now requires an ADMIN API key. (#214)
- Bumped `concurrently` to v10 to clear the critical `shell-quote` advisories. (#208)

### Fixed

- Swagger UI now sends the `X-API-Key` header. Fixes #173. (#109)
- Dashboard Docker build: upgraded `@vitejs/plugin-react` to v6 for the Vite 8 peer conflict. Fixes #103, #123, #197. (#136)
- Bulk send returned 400 for text-only messages (missing `@IsOptional()` on media fields). Fixes #192. (#193)
- Group participant endpoints returned 400 due to missing `class-validator` decorators. Fixes #190. (#210)
- Cross-platform `postinstall`: replaced POSIX-only shell syntax that broke Windows `npm install`. Fixes #181. (#209)
- Controllers throw proper NestJS HTTP exceptions instead of generic `Error`. (#102)
- Dashboard QR modal shows a loading state and keeps polling until ready. (#97)
- Traefik dashboard image now proxies `/api` and `/socket.io`. Fixes #116. (#131)
- Wired `API_MASTER_KEY` into the initial key seed. Fixes #153. (#133)
- Fixed `Location` constructor ESM/CJS interop in the whatsapp-web.js adapter. (#186)
- Incoming webhook messages now include location data for location messages. (#202)

### Changed

- Lint is now enforced: `lint` runs ESLint in check mode with a new `lint:fix`. (#208)
- CI publishes multi-arch Docker images (`linux/amd64` + `linux/arm64`). Closes #164. (#166)

### Added

- Documented the API key management endpoints. Closes #110. (#130)
- Indonesian Docker deployment guide and an API-spec diagram fix. (#188, #189)

### Dependencies

- Dependabot minor/patch group (NestJS, BullMQ, Bull Board, helmet, ioredis) and `@types/uuid` v11. (#194, #143)

### Upgrade notes

- Infrastructure endpoints are now ADMIN-only (`/api/infra/config|restart|export-data|import-data|storage/*`).
- Reverse-proxy + per-key `allowedIps`: set `TRUSTED_PROXIES` so the real client IP is resolved; otherwise `X-Forwarded-For` is ignored.

## [0.1.6] - 2026-05-17

### Fixed

- PostgreSQL migration crash: `AddMessageStatus1770108659848` now detects database type at runtime; SQLite path is byte-identical, PostgreSQL uses `timestamp`/`NOW()`/`DEFAULT true`/inline FK. Fixes #59, #62.

### Changed

- Version-badge sync in `README.md`, `docs/README.md`, and Swagger docs to 0.1.6.
- Merged Dependabot PRs for 12 npm packages and 1 dashboard package.
- GitHub Actions: `docker/setup-buildx-action` v3→v4, `codecov/codecov-action` v5→v6, `docker/login-action` v3→v4, `docker/metadata-action` v5→v6, `actions/upload-artifact` v6→v7.

## [0.1.5] - 2026-04-27

### Fixed

- First-boot crash on SQLite: data DB defaults to `synchronize=true` for SQLite, resolving `SQLITE_ERROR: no such table: sessions`.
- PostgreSQL boot crash on `main`: `AuditLog.metadata` uses `simple-json` so the always-SQLite `main` connection never switches to `jsonb`.
- Operator env vars ignored: loading order is now `process env > .env > data/.env.generated`.

### Changed

- Auto-run migrations on boot: PostgreSQL runs pending migrations automatically; SQLite runs them when opting out of `synchronize`.
- Added `migration:run:prod`, `migration:revert:prod`, `migration:show:prod` operating from `dist/`.

## [0.1.4] - 2026-02-26

### Changed

- Upgraded `eslint`/`@eslint/js` v9 → v10 in root and dashboard.
- Merged Dependabot PRs for 6 root packages, 2 dashboard packages, and `@types/node` 24→25.
- Added `.npmrc` with `legacy-peer-deps=true` for `eslint-plugin-react-hooks` ESLint 10 compatibility.

### Fixed

- Fixed `no-useless-assignment` in `Infrastructure.tsx` caught by ESLint 10.
- Applied Prettier fix to `whatsapp-web-js.types.ts`.

## [0.1.3] - 2026-02-18

### Fixed

- Upgraded CI, release workflow, and Dockerfile from Node 20 to Node 22 LTS.
- Regenerated `package-lock.json` with npm 10 to match CI.
- Fixed `whatsapp-web.js` type mismatches using an `Omit<>` pattern.
- Pinned `@eslint/js` and `eslint` to v9 to resolve a Dependabot peer conflict.
- CI npm audit level changed from `high` to `critical` (high findings are unfixable transitive deps).

### Changed

- Merged Dependabot PRs for 12 npm packages, 6 dashboard packages, and 5 GitHub Actions.
- GitHub Actions: `actions/checkout` v4→v6, `actions/setup-node` v4→v6, `actions/upload-artifact` v4→v6, `docker/build-push-action` v5→v6, `codecov/codecov-action` v4→v5.

## [0.1.2] - 2026-02-18

### Fixed

- Default `DATABASE_SYNCHRONIZE` to false to prevent auto-schema changes in production.
- Replaced `process.exit()` with a ShutdownService callback pattern.
- Use native `jsonb`/`timestamp` column types on PostgreSQL when available.
- Removed duplicate Docker management from main.ts (use DockerService).
- Removed the unimplemented message queue stub that always threw.
- Added logging to all 12 empty catch blocks across backend services.
- Reduced `any` usage from 38 to ~4 with typed whatsapp-web.js interfaces.
- Added TypeORM transactions for session CRUD; save-before-send for messages.
- Added a dashboard ErrorBoundary with fallback UI.
- Moved the API key from localStorage to sessionStorage.
- Replaced blocking `alert()` calls with Toast notifications.
- Added logging to all empty catch blocks in dashboard pages.

### Changed

- Migrated all 8 dashboard pages to `@tanstack/react-query`.
- Route-level lazy loading with `React.lazy` + `Suspense` — main bundle reduced 36%.

### Added

- `npm audit --audit-level=high` in the CI pipeline.
- Jest coverage floor to prevent regression.
- Parallel dashboard CI job (lint + build).
- Dependabot: npm weekly, GitHub Actions monthly.

## [0.1.1] - 2026-02-17

### Added

- 94 new unit tests across auth, session, message, and webhook modules (110 total, ~17% coverage).
- `release.yml` GitHub Actions — tag-triggered with test gate, GitHub Release, and Docker semver tagging.
- JavaScript/TypeScript and Python SDK client scaffolds in `sdk/`.
- New hook events `webhook:queued` and `webhook:delivered`.

### Fixed

- Made `generateIdempotencyKey` deterministic by removing `Date.now()` (content-based keys).
- Added `lastTriggeredAt` update and `webhook:delivered`/`webhook:error` hooks after queue delivery.
- Added `webhook:queued` for queue mode; `webhook:after` now fires only in direct mode.
- Added `TypeOrmModule.forFeature([Webhook])` and `HooksModule` imports to QueueModule.
- Message processor placeholder now throws so BullMQ marks the job failed.

## [0.1.0] - 2026-02-05

### 🎉 Initial Release

First stable release of the OpenWA WhatsApp API Gateway.

### Core Features

- REST API for WhatsApp operations.
- Multi-session support with concurrent handling.
- Web dashboard for visual management.
- WebSocket real-time events via Socket.IO.
- API key authentication with role-based permissions.
- Webhook system with HMAC signatures and queue-based retries.

### Messaging

- Send/receive text, image, video, audio, document messages.
- Message reactions and replies.
- Bulk messaging with rate limiting.
- Location and contact sharing.
- Sticker support.

### Advanced Features

- Groups API (full CRUD).
- Channels/Newsletter support.
- Labels management.
- Catalog API for product management.
- Status/Stories support.
- Proxy per session.
- Plugin system for extensibility.

### Infrastructure

- SQLite (dev) and PostgreSQL (prod) support.
- Optional Redis queue for webhook delivery.
- Optional S3/MinIO media storage.
- Docker + Docker Compose deployment.
- Traefik reverse proxy integration.
- Health check endpoints.
- Zero-config onboarding with auto-generated API key.

### Security

- API key authentication with SHA-256 hashing.
- Configurable rate limiting.
- CIDR IP whitelisting.
- CORS configuration.
- Helmet security headers.
- Audit logging for all operations.

### Dashboard

- Session management with QR code display.
- Webhook configuration and testing.
- API key management.
- Message tester for debugging.
- Infrastructure status monitoring.
- Audit logs viewer.
- Plugin management.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Messages handled by a plugin are no longer missing from your history.** When an auto-reply plugin
  answered a message, it told the gateway to stop passing that message to the remaining plugins — and
  the gateway took that as a cue to forget the message entirely. It was never saved, never sent to your
  webhooks, and never appeared in the dashboard. A chat handled by a bot therefore read as a series of
  replies answering nothing, and any integration downstream never learned the customer had written. The
  same applied to outgoing messages. Stopping the plugin chain now does exactly that and nothing more:
  the message is recorded and delivered to webhooks as usual. Plugin authors: this is a behaviour change
  if you relied on it to hide messages — see [19 — Plugin Architecture](docs/19-plugin-architecture.md).
- **A plugin configuration that fails to save no longer reports success.** The dashboard showed "Saved"
  and closed the dialog even when the gateway had rejected the change, so the edit appeared to have been
  applied and was silently gone the next time the dialog was opened. The failure and its reason are now
  shown. The same fix applies to a plugin that fails to disable, which previously reported nothing at
  all.

### Fixed

- **A plugin that ships its own settings editor no longer shows two editors at once.** When a plugin
  provided a custom editor, the dashboard rendered the generated form underneath it as well — so every
  field appeared twice, followed by a second Save button that behaved differently from the editor's own.
  The Chat Flow settings dialog was the visible case. A plugin's own editor now replaces the generated
  form and owns saving; plugins without one are unchanged, form and Save button included.
- **A plugin's own settings editor follows the dashboard theme.** The editor runs in a sandboxed frame
  that cannot see the dashboard's theme, so it had no way to match it and stayed light — a bright panel
  in the middle of a dark dialog. The dashboard now tells the editor which theme is in use. Plugin
  authors: the theme arrives with the existing settings handshake and can be ignored safely; see
  [19 — Plugin Architecture](docs/19-plugin-architecture.md) for the contract.

### Fixed

- **Plugins you enabled stay enabled across a restart.** Every restart of the gateway — an upgrade, a
  host reboot, a container restart policy — silently switched off every extension plugin, with nothing
  written to the log and nothing shown in the dashboard. An integration such as the Chatwoot adapter
  simply stopped relaying until someone noticed and turned it back on by hand. Your enable decision is
  now remembered separately from whether the plugin happens to be running, and the plugins you had
  enabled are started again once the gateway has finished coming up. A plugin that fails to start is
  logged and left disabled rather than holding up the gateway. Enabling still runs the plugin's full
  lifecycle, and a plugin you disabled stays disabled. Nothing to do on upgrade: a plugin that is
  enabled when you upgrade is carried over automatically ([#856](https://github.com/rmyndharis/OpenWA/issues/856)).

- **The chat list no longer shows a stray `0` next to every conversation.** Each row in the Chats
  sidebar rendered a literal `0` where the last message's time belongs, on every chat. A conversation
  with no messages reports a timestamp of zero, and the check that was meant to hide the time in that
  case ended up displaying the zero itself. The time is now simply omitted when there is no last
  message, as intended. The unread-count badge was unaffected.

- **A message send that is retried after a recipient-address change is now recorded in the log.** When
  whatsapp-web.js reports that a contact's cached address is stale, the gateway re-resolves the address
  and sends again. That retry was silent, so in the case where the engine reports a failure for a
  message it had in fact already delivered, the resulting second copy appeared nowhere in the logs and
  could only be noticed on the recipient's phone. The retry now logs a warning naming the chat and both
  addresses. Sending behaviour is unchanged.

- **The login screen shows the gateway's actual version again.** The dashboard resolved its version
  from whichever `package.json` sat in the working directory the build ran from, which meant
  `dashboard/package.json` — a file a release never touches — rather than the root `package.json` that
  a release bumps. The two had drifted, so the login screen advertised an older version than the
  gateway was running. Everywhere else in the dashboard hid this, because the sidebar replaces the
  build-time value with the live version from the API once you are signed in; the login screen has no
  session yet and shows the constant as-is. The version is now resolved relative to the build config
  itself, so it no longer depends on where the build was started from.

### Changed

- **A release image is only tagged after it has been proven to start.** The release workflow
  published `X.Y.Z`, `X.Y` and `latest` in the same step that built the image, and only then ran
  the boot smoke test — so an image that could not start was already pullable by the time the
  test that catches it failed, which is exactly what happened with `0.10.3`. The build now
  publishes a throwaway `smoke-<run-id>` tag, the smoke test boots that on both architectures,
  and a new promote step re-points the release tags at the identical manifest (no rebuild, so
  provenance and SBOM attestations carry over) only once it passes. The GitHub Release depends
  on the promote step, and the staging tag is cleaned up afterwards.
- The smoke test no longer starts containers with `--rm`, so a container that exits on its own
  survives long enough for `docker logs` to report why. The `0.10.3` failure reported
  "No such container" instead of the actual error.

## [0.10.4] - 2026-07-21

> ⚠️ **Use this release, not `0.10.3`.** The `0.10.3` container image does not start: its
> `sqlite3` native binary was built against glibc 2.38 while the runtime image (`node:22-slim`,
> Debian bookworm) provides 2.36, so the driver failed to load and the app could not reach its
> database. The release gate caught it on both architectures and the GitHub release was never
> published, but the image had already been pushed. `0.10.4` contains the same features and
> fixes as `0.10.3` plus the correction below.

### Fixed

- **The container image starts again.** `sqlite3` stays on the `5.x` line, whose prebuilt
  binaries match the Debian bookworm runtime, instead of the `6.x` line whose prebuilds require
  a newer glibc than the base image provides. The dependency advisories that motivated the
  original bump are still resolved — `node-gyp` and `tar` are pinned forward through `overrides`
  so the vulnerable `tar` never enters the tree, leaving `npm audit` clean without changing the
  driver. Verified by building the production image and booting it, not only by the test suite.

## [0.10.3] - 2026-07-21

Patch release: new group, call, profile and message-edit capabilities, plus stricter reading
of boolean and numeric request fields.

> ⚠️ **Two behaviour changes on already-released surfaces.** Neither alters a response payload
> or removes a field, but both can affect an existing deployment:
>
> 1. **Boolean and numeric request fields are read strictly.** A value the pipe previously
>    guessed at — `1`, `0`, `yes`, `no` for a boolean, or a blank string for a number — now
>    returns `400` instead of being silently coerced. Real JSON booleans and numbers, the exact
>    strings `"true"`/`"false"`, and numeric strings such as `"5"` all continue to work, so JSON
>    clients and all five SDKs are unaffected. **Migration:** if you post form-encoded bodies or
>    stringly-typed JSON, send canonical values.
> 2. **Status posts now pass the `message:sending` plugin gate.** A plugin that blocks broadly
>    will now also block status posts, where it previously had no visibility into them, and the
>    gate `input` for a status post carries no `chatId`. **Migration:** a handler that reads
>    `input.chatId` unconditionally should branch on the `source` or `type` field first.

### Added
- **Outbound message edit.** `POST /api/sessions/:sessionId/messages/edit` edits the text of a
  message sent by the account, on both engines (whatsapp-web.js `Message.edit`, Baileys
  `sendMessage` with an `edit` key). Attempting to edit another sender's message fails with `403`,
  an unknown message/chat with `404`, and the stored record's body is updated through the same
  serialized mutation queue as inbound edit events. `message.edited` continues to cover inbound edits.
  An edit passes the `message:sending` plugin gate like every other sender, so a plugin can rewrite
  or block the replacement text.
- **Live group events.** `group.join`, `group.leave`, and `group.update` are now actually
  dispatched — to webhooks (HMAC-signed, with stable idempotency keys) and to Socket.IO
  subscribers — on both engines. They were previously accepted in subscriptions but never emitted
  ("reserved"). whatsapp-web.js maps `group_join`/`group_leave`/`group_update` notifications;
  Baileys maps `group-participants.update` (add/remove) and `groups.update` (subject, description,
  announce/locked changes). On Baileys, full-metadata snapshots (emitted by the library on
  reconnect and on `GET /groups`) are filtered out so they never surface as fabricated updates;
  genuine changes replayed from an offline window are dispatched with the receipt time as their
  `timestamp` (the engine does not forward the original occurrence time).
- **Join groups & group settings.** `POST /api/sessions/:sessionId/groups/join` joins a group via
  invite code (an invalid/expired code returns a typed `400`). `GET`/`PUT
  /api/sessions/:sessionId/groups/:groupId/settings` read and update the admin-only flags
  (`announce`, `locked`) and the disappearing-message timer (`ephemeralSeconds`, Baileys only — it
  returns a documented `501` on whatsapp-web.js, which has no such API). A settings patch applies
  the timer first, so a `501` can never silently follow an already-applied flag change, and
  explicit `null` fields are rejected with `400`. `announce` and `locked` accept only a real boolean
  or the exact strings `"true"`/`"false"`; any other spelling is rejected with `400` rather than
  being interpreted, so a form-encoded `announce=false` can never restrict a group. `ephemeralSeconds`
  is read the same way — a blank value is a `400`, not a silent `0` that would switch the
  disappearing-message timer off.
- **Own-profile management.** `PUT /api/sessions/:sessionId/profile/name`, `/status`, and
  `/picture` set the linked account's display name, about text, and profile picture on both engines.
- **Incoming-call handling.** A new `call.received` webhook + Socket.IO event fires when an
  incoming call starts ringing (both engines; stale offers replayed from an offline window and the
  account's own outgoing calls are not emitted). It fires once per call: both engines signal a
  ringing call more than once (whatsapp-web.js on every write to its internal call map, Baileys via
  the `offer` and `offer_notice` tags), and only the first is dispatched.
  `POST /api/sessions/:sessionId/calls/:callId/reject`
  rejects a ringing call, and the per-session `config.autoRejectCalls: true` flag (settable at
  session creation) rejects every incoming call automatically — the event is still dispatched
  first. Unknown or expired call ids return `404`.
- **Docs: official plugin catalog is now discoverable.** The README feature table points to the
  first-party Integration Fabric plugins (Chatwoot, Typebot, …) in the
  [OpenWA-plugins](https://github.com/rmyndharis/OpenWA-plugins) repo, and
  `docs/23-community-integrations.md` clarifies that it lists community projects only.

### Changed
- **The security audit runs as its own CI job.** `npm audit` reports against the advisory database
  rather than against the diff, so a newly published advisory turns red on unrelated pull requests.
  While it was the first step of the Lint job, that failure aborted the job before ESLint, the
  type-check, the format check, the version-consistency check and the OpenAPI drift gate had run —
  so an advisory silently switched off every code-quality gate at once. It is still blocking (the
  build job depends on it) but can no longer mask an unrelated result.

- **Status posts now pass the `message:sending` plugin gate.** `POST /api/sessions/:sessionId/status/{text,image,video}`
  publish content from the linked account, but were the only content-bearing senders that did not
  consult plugins first. They now run the same gate as chat sends, tagged `status-text`,
  `status-image` and `status-video`, with the hook context `source` set to `StatusService` so a
  plugin can distinguish a status post from a chat send. A blocked post returns `400`, now declared
  on all three operations. A plugin may also rewrite the post; a rewritten media payload is
  re-checked against the data-URI and `MEDIA_DOWNLOAD_MAX_BYTES` guards before it reaches the engine.
  **Two notes for plugin authors:** a plugin that blocks broadly will now also block status posts,
  where it previously had no visibility into them; and the gate `input` for a status post is **not**
  a send DTO — it carries no `chatId`, but `{ text, options }` or `{ media: { mimetype, data }, options }`.
  A handler that reads `input.chatId` unconditionally should branch on `source` or `type` first.

### Fixed
- **`forEveryone: false` on message delete is honoured again.** `POST /api/sessions/:sessionId/messages/delete`
  defaults `forEveryone` to `true`, so sending it at all means "delete only for me" — but a request
  that carried the value as a string (any form-encoded body, since that parser produces only string
  scalars) had it read as `true`, retracting the message from the recipient's device instead of
  hiding it locally. That is not reversible, and the recipient sees a "message deleted" placeholder.
  The field now accepts a real boolean or the exact strings `"true"`/`"false"`; **any other spelling
  — `1`, `0`, `yes`, `no` — is now rejected with `400` instead of being read as `true`.** JSON
  clients and all five SDKs send real booleans and are unaffected. `allowMultipleAnswers` on poll
  send is read the same way, which is what its validation always claimed to do.

- **Every boolean and numeric request field is now read strictly, and a test keeps it that way.**
  The same coercion applied to every such field: a boolean took any non-empty string as `true`, and
  a numeric field took a blank value as `0`. Fourteen more fields are covered — `active` and
  `retryCount` on webhooks (a blank `retryCount` silently meant "no retries"), `enabled` on
  integration instances, `ptt` on audio and bulk sends, `randomizeDelay` and `stopOnError` on bulk
  batches, `latitude`/`longitude` on location sends (a blank pair became the valid coordinates
  `0, 0`), `dateFrom`/`dateTo`/`offset` on search, and `font` on text status. Values that were
  already correct still work — a numeric field still accepts `"5"`, and a boolean still accepts
  `"true"`/`"false"` — so only input that was previously being guessed at is now refused with `400`.
  A drift test walks class-validator's registry and fails the build if any boolean or numeric
  request field, including one in a class that is never exported, accepts a value the pipe would
  otherwise coerce. The published OpenAPI schema is unchanged.

- Running more than one session no longer corrupts the Chromium launch flags of every
  session started after the first. The whatsapp-web.js adapter appended its per-session
  arguments (`--proxy-server`, and the `--openwa-session=<id>` process marker) directly
  to the array returned by `engine.puppeteer.args` — but `ConfigService` hands back a
  live reference into the cached configuration tree, so every session shared one array
  and each start mutated it permanently. Three symptoms followed: the argument list grew
  without bound across starts and reconnects until Chromium refused to launch; a session
  configured without a proxy inherited the previous session's `--proxy-server` and routed
  its traffic through it; and because the orphaned-Chromium sweep identifies processes by
  substring-matching the session marker, a restart of one session could `SIGKILL` another
  session's healthy browser. The adapter now copies the array before appending, so the
  shared configuration is never mutated. Fixed in #840 — thanks @szmazhr.

- The dashboard webhook editor now offers `session.reconnect_loop` (accepted by the backend since
  #800 but never listed in the UI), and the Java/Python SDK event types now include it as well.
- Typing a session name in the dashboard's **Create New Session** dialog no longer
  stalls after the first character. The shared `Modal` component ran its initial-focus
  step inside a `useEffect` whose dependency array included `onClose`, and callers pass
  an inline arrow for that prop (`onClose={() => setShowCreateModal(false)}`) — a fresh
  reference on every parent render. Each keystroke updated the field, re-rendered the
  page, produced a new `onClose`, re-ran the effect, and the initial-focus step yanked
  focus back to the dialog's close button, so only one character could be typed before
  the input lost focus. The `onClose` is now held in a ref and the open/close effect
  depends on `[open]` alone, so focus is applied once when the dialog opens and stays
  put across parent re-renders. Reported in #837, fixed in #838.

### Security
- **Resolved every known advisory in the dependency tree (17 → 0, including one critical).** The
  critical one was a set of path-traversal and symlink issues in `node-tar`, reached only through
  `sqlite3@5` → `node-gyp` → `tar`. `sqlite3` moves to `6.0.1`, which drops the `node-gyp`
  dependency entirely in favour of `prebuild-install` and pulls a patched `tar@7`; `typeorm` moves
  to `0.3.31`, the first release declaring `sqlite3@^6` as a supported peer. `shell-quote` (reached
  through the `concurrently` dev dependency, and with no upstream fix available on any release
  line) is pinned forward with an `overrides` entry.

  The bundled SQLite build advances to 3.52.0. Migrations, the FTS5 full-text search tables, both
  database connections and a full boot were verified against the new driver.

## [0.10.2] - 2026-07-20

### Added

- The README gains an end-user-facing **"Before you connect a number"** section that consolidates
  the recurring ban-risk / safe-sending questions: it states plainly that OpenWA is unofficial (it
  uses `whatsapp-web.js` and `@whiskeysockets/baileys`, not Meta's Cloud API), includes a per-engine
  ban-risk vs. resource-cost trade-off table, six practical safe-sending guardrails (warm-up,
  no cold-blast, rate-limit, opt-in recipients, keep a fallback, mind the hosting IP), calls out the
  known cold-contact first-send silent drop (tracked in #830) as server-side WhatsApp policy rather
  than an OpenWA bug, and points regulated deployments to the official Cloud API. Responds to the
  ban-risk questions raised in discussions #87, #154, #436, #687, and #694.

### Fixed

- `BODY_SIZE_LIMIT` now actually takes effect under Docker Compose. The variable was documented in
  `.env.example` and read correctly by the app (`src/main.ts` → `resolveBodyLimit()`), but neither
  `docker-compose.yml` nor `docker-compose.dev.yml` forwarded it into the container, so a value set
  in `.env` stayed on the host and the app fell back to its default — large base64 media sends
  returned `413 Payload Too Large`. Both compose files now pass `BODY_SIZE_LIMIT` through, matching
  the existing `${VAR:-}` convention; blank/unset keeps the 25 MB app default. Reported in #540,
  tracked in #831, fixed in #832.
- The dashboard's integration-instance create form now offers an optional **ingress secret** field,
  so providers that fix their own webhook signing secret (e.g. Chatwoot's per-webhook secret, which
  cannot be replaced with a custom value) can be integrated without resorting to the REST API.
  Previously the form always auto-generated a secret that could never match the provider's, so every
  webhook delivery failed HMAC verification with a 401 and agent replies never arrived (#821). The
  field mirrors the API's validation rule (blank = auto-generate, otherwise at least 16 characters).

## [0.10.1] - 2026-07-20

### Added

- Design draft `docs/28-multitenancy.md`: the enterprise multitenancy proposal — tenant entity,
  named users with per-tenant roles, TOTP two-factor auth, per-tenant branding/isolation/quotas,
  and the migration path from single-operator deployments (nothing implemented yet).

- The Chats room header now shows the contact or group profile picture (fetched through the existing
  `GET /sessions/:id/contacts/:id/profile-picture` endpoint, cached for one hour, with the icon
  fallback preserved when the engine returns no URL), a floating scroll-to-bottom button appears in
  the messages pane once the reader scrolls away from the latest message, and the room header shows
  the prettified phone number (e.g. `628123456789@c.us` → `+62 812 345 6789`) as the primary
  subtitle for personal chats — with the raw JID retained on a muted monospace line for technical
  use (lid resolution, webhook payloads, group ids). The composer send icon was also enlarged to
  better match its 48 px button.
- The linked-device name shown in WhatsApp's Settings → Linked Devices is now brandable via the
  optional `BAILEYS_BROWSER_NAME` env var (applies to new pairings; default unchanged: `OpenWA`).
  Thanks @clicsoluciones. (#822)

### Fixed

- The chat header no longer formats a LID privacy id as a fake phone number (e.g. "+26 281 346
  125 0071"): digit-only LIDs and group ids are rejected by the phone formatter, and personal @lid
  chats now resolve and display the real number through the engine (cached a day). Chat list rows
  also render profile pictures now, sharing the room header's 1-hour cache instead of static icons.
- Chat-list avatars no longer burst into HTTP 429s: profile pictures for the whole sidebar are
  batch-resolved in ONE request (`GET .../contacts/profile-pictures?ids=…`, up to 50 ids) instead
  of one parallel fetch per row, which exhausted the per-IP throttle.
- Chat-list avatars no longer stall on long sidebars: the batch endpoint caps engine lookups at a
  per-id deadline (a hanging id resolves null instead of holding the whole batch), and the request
  now resolves the sidebar's TOP 50 ids in list order so visible rows get their pictures first.

## [0.10.0] - 2026-07-19

### Added

- Reconnect-loop observability: every scheduled reconnect attempt is counted in the new
  `openwa_session_reconnect_attempts_total` Prometheus counter, and every fifth consecutive attempt
  of an episode emits a `session.reconnect_loop` webhook event (`{ sessionId, attempts, nextDelayMs }`),
  a structured warning log, and an `openwa_session_reconnect_loop_alerts_total` counter tick — a
  session stuck in a reconnect loop is now visible to operators instead of retrying silently forever.
  The episode streak re-arms after a stable connection, so recovered sessions do not keep alerting.
- The whatsapp-web.js engine now sweeps orphaned Chromium processes before each (re)launch: browsers
  are started with an `--openwa-session=<id>` marker arg, and any leftover browser process carrying
  this session's marker from a previous process lifetime (e.g. after the gateway itself was killed)
  is terminated before the new launch, alongside the existing stale Singleton-file cleanup.
- Messages composed on a linked phone are now persisted to local history (previously only API
  sends and inbound messages were stored). Deduplication against the REST send path is atomic on the
  existing unique message index, and delivery/read state advances via acks on these rows as well.
- The whatsapp-web.js own-send echo now downloads media through the same capped inbound path as
  inbound messages (declared-size pre-gate, timeout, concurrency limiter), so phone-composed images
  persist and render with their real payload.
- The dashboard gains a shared accessible modal dialog — Escape and overlay dismissal, a focus
  trap with initial focus, background scroll lock, and `role="dialog"` semantics. The Sessions page
  modals are the first to use it, gaining those behaviors plus a pinned header/footer with a
  scrolling body on long content.
- The dashboard Message Tester now covers every outbound message type: in addition to
  text/image/video/audio/document it can send location, contact-card, sticker, and native poll
  messages, forward an existing message to another chat, and submit a bulk text batch (recipients
  one per line, optional inter-message delay) with live batch progress polling and a cancel control
  in the response panel.

### Changed

- Dashboard theming is simplified to a single light/dark toggle button; the accent-palette picker
  was removed for maintainability. The global `h2` is a real heading
  again instead of a forced small uppercase eyebrow (section/card titles were smaller than body
  text); the eyebrow look survives as an opt-in `.eyebrow` class.
  The stored theme is applied before first paint, so standalone
  routes no longer flash the OS default, and the message-analytics chart now defaults to 24h.
- The dev compose defaults `AUTO_START_SESSIONS=true`, so previously authenticated sessions come
  back by themselves after a container restart (the application-level default stays off).
- Dashboard action buttons are consolidated into shared global `.btn-primary`/`.btn-secondary`/
  `.btn-danger` classes (28 page-scoped copies removed), so padding, radius, hover, and disabled
  states are consistent across pages; the Plugins hover now uses the `--primary-hover` token and
  danger buttons use the single `--error` red.
- The Infrastructure page's inline-styled elements (including the restart/migration progress modal) are
  moved to scoped CSS classes, so all surfaces stay on the design-token system.
- Decorative hover/selection effects are flattened for a more professional look: the install/config
  tab active state no longer lifts or glows, the restart progress bar is a flat primary fill instead
  of a gradient, and the emoji-picker button no longer scales on hover.

### Removed

- Verified dead dashboard code: unused CSS across multiple pages, dead client methods and utilities,
  unused image assets, and 39 unused i18n keys across all locales.
- Verified-unused dashboard i18n keys (19 per locale across all 11 locales): dead `common.*`
  vocabulary and page-specific keys with zero references in the app.

### Fixed

- Boot no longer warns about (and the plugin list no longer shows) ghost entries for the legacy
  bundled extensions removed in v0.7 (`auto-reply`, `translation`): when their code directory has no
  manifest, the stale registry entry is pruned at startup. The guard is scoped to those known ids so
  a temporarily unreadable plugin directory never loses its persisted config.
- Long-lived sessions no longer die permanently after hours of uptime. A dead whatsapp-web.js
  Chromium (browser process exit, renderer crash, or closed page) is now detected through the
  puppeteer lifecycle handles and driven through the standard disconnect → reconnect pipeline, and
  a session watchdog probes READY engines every 60 seconds, treating two consecutive liveness-probe
  failures as a disconnect. The reconnect budget is now unlimited by default (exponential backoff
  capped at 1 hour, counter reset after 5 stable minutes) instead of a terminal failure after 5
  attempts; explicit `maxReconnectAttempts` (`0` = disabled, clamped to 1–20) is unchanged. On the
  Baileys engine, `connectionReplaced` (440) is now terminal instead of fighting the other instance,
  duplicate close events no longer burn retry attempts, and a failed reconnect attempt no longer
  fails the session.
- Harden session stability further: the Baileys engine now treats `forbidden` (403, banned/blocked
  account) as terminal instead of retrying forever; stale Chromium `SingletonLock`/`SingletonSocket`/
  `SingletonCookie` files are removed before each whatsapp-web.js (re)launch so a previously
  force-killed browser can never block startup; and page transport errors (`Protocol error`,
  `Target closed`, detached frame, …) observed during send/query operations are now treated as an
  immediate death signal, cutting dead-session detection from minutes to the first failed call.
- Sent images no longer vanish from the chat thread: the realtime own-send echo carries no media
  payload by design, and the live cache merge replaced metadata wholesale, wiping the optimistic
  bubble's base64. Metadata now merges per field (a real payload always beats a payload-less echo
  marker), and the post-send reconciliation folds the optimistic copy into the echo row.
- Chat thread scrolling now behaves on every path: opens at the latest message, restores the exact
  per-chat position when returning (position is saved continuously, not read after the content
  swap), and stays pinned while media decodes instead of clamping the restore to the pre-decode
  height — releasing cleanly on user scroll.
- The messages-by-type chart no longer shows a misleading Unknown slice: rows with no body and no
  metadata (content-less system/event rows) are excluded from the aggregation.
- Full-text search self-heals its schema at boot when migrations are skipped (`DATABASE_SYNCHRONIZE=true`),
  and SQLite FTS5 queries are sanitized per token, so phone numbers, chat identifiers, quotes, and
  parentheses no longer fail as malformed queries.
- Audit log rows now carry the resolved API key and client IP for every call site: the values are
  stamped into the per-request async context by the auth guard and auto-filled on write (explicit
  context still wins).
- Dashboard CSS no longer references undefined custom properties or fallbacks from a foreign
  design system: every danger/danger-color usage now resolves to the single `--error` token, wrong
  `--primary`/`--text-secondary`/`--border`/`--warning` fallbacks are dropped, and the plugin
  instances "off" badge shows its background again (it referenced an undefined `--bg-secondary`).
- Dashboard readability and behavior: the send button stays readable when disabled, API Keys badges
  render on desktop (rules were stranded in a mobile-only media query), the Templates page gets real
  primary/secondary button styles, fourteen dark-mode selectors are corrected so dark mode applies,
  Sessions modals regain the 90vh cap with a scrolling body, QR provisioning uses the realtime push
  with fetching gated to `qr_ready` (no more expected-but-noisy 400 console errors), and enabling a
  plugin with unset required config opens its config dialog with a warning instead of failing with a
  raw sandbox error.
- Plugins whose config schema declares field defaults no longer fail to enable with those values
  missing: defaults are now seeded into the stored config at load time (fresh installs and every
  boot), without ever overwriting explicit values. Required fields without a declared default still
  need real operator input.

## [0.9.0] - 2026-07-18

### Added

- Live message-edit support now emits `message.edited` through webhooks and WebSocket subscriptions on
  both engines, updates the stored message and Chats dashboard in occurrence order, and exposes the
  standard sender/direction/type/media/mention fields to webhook smart filters. Existing wildcard (`*`)
  subscriptions receive the new event automatically. Thanks @rogeriorioli. (#734)

### Changed

- ⚠️ **Breaking:** `GET /api/settings` no longer returns the incorrect, always-zero
  `general.sessionTimeout` field. Migration: remove reads, destructuring, or schema requirements for that
  admin-only field; there is no replacement because OpenWA has no equivalent session-timeout setting.
- Java SDK callers sending audio/voice notes now pass `SendAudioRequest` to `sendAudio`; other media sends
  continue to use `SendMediaRequest`. Bulk media uses the nested `BulkMediaRequest` type.
- The PHP SDK's configured `timeout` now applies to every request, including calls made through an injected
  Guzzle client; pass `timeout` explicitly when a different bound is required.
- PHP SDK contributor installs now remain compatible with the declared PHP 8.1 runtime floor, and CI
  exercises the suite on both PHP 8.1 and 8.2.

### Fixed

- Preserve plugin state across package updates, make data/storage backup and restore cover both engine
  auth stores plus generated secrets, and preserve message `chatName` during data import.
- Bound webhook and integration redrive work, make Redis throttling atomic, guard stale engine teardown,
  and make media precedence, data-URI normalization, limits, and omission markers consistent across engines.
- Record API-key authorization changes in administrative activity logs, protect the final usable admin,
  and align action-style POST routes with their documented HTTP `200` responses.
- Correct ingress method/verification/dedup metadata, dashboard session-state visibility and plugin config
  fallback, SDK timeout/type parity, metrics types, deployment configuration forwarding, and CI contract gates.

## [0.8.19] - 2026-07-17

### Added

- **Official Go SDK (`sdk/go`).** Hand-written, stdlib-only (no third-party dependencies) Go client
  covering the user-facing API surface, joining the JavaScript/Python/PHP/Java clients. Entry point is
  `openwa.New(baseURL, apiKey, opts...)`, which returns a concurrency-safe `*Client` whose exported
  fields group the API by domain (`Sessions`, `Messages`, `Contacts`, `Groups`, `Webhooks`, `Chats`,
  `Status`, `Labels`, `Channels`, `Catalog`, `Templates`, `Health`, `Search`, `Auth`). Every network
  method is context-first; configuration and dependency injection go through functional options
  (`WithHTTPClient`, `WithTransport`, `WithLogger`, `WithRetry`, `WithMiddleware`, `WithTimeout`,
  `WithUserAgent`, `WithHeader`, `WithInsecureHTTP`). Errors are typed: match the sentinels with
  `errors.Is` (`ErrBadRequest`, `ErrUnauthorized`, `ErrForbidden`, `ErrNotFound`, `ErrConflict`,
  `ErrRateLimited`, `ErrNotImplemented`) or unwrap the concrete `*APIError` with `errors.As`. Retries
  are opt-in (`WithRetry`), honour `Retry-After`, and rewind request bodies via `GetBody`. Because the
  API has no idempotency key, a `POST` is never replayed after a network error, and on a retryable
  status only for `429`/`503` — which prove the gateway declined the request before acting on it —
  since a `500`/`502`/`504` can arrive after the message was already sent. Redirects
  are never followed, so the bearer-equivalent `X-API-Key` is never re-sent to a redirect target. A
  `TestRouting` table asserts the exact method and path of every service call, and the suite runs in CI
  (`gofmt`/`go vet`/`go test -race`) on both SDK and server-contract changes, so route drift fails at
  test time. Requires Go 1.22+. Thanks @Revelts.

### Changed

- **v0.8.18's whatsapp-web.js id-rename fix also restored the Chats page (docs only).** The v0.8.18 entry
  credits that fix with repairing inbound media downloads, message ids, acks, reply quoting, and reactions,
  but never mentions `GET /sessions/{id}/chats` — which the same patch repaired as well. The rename broke the
  injected read of each chat's last-received message key, and because every chat resolves through a single
  `Promise.all`, one unreadable key rejected the entire request, so the dashboard's Chats page returned
  `500 Internal server error` on every load while the rest of the dashboard kept working from stored data.
  Operators on v0.8.17 hitting that symptom found nothing in the release notes matching it and so had no
  reason to upgrade. No behavior change, and no change to which release carries the fix — it is still
  v0.8.18. The chat-list site was first reported here by @SkywardLab in #748.
  Refs #748, #753, #757.

- **Typed SDK response models now match the status, label, and channel payloads the server actually
  returns.** The status, label, and channel routes hand back the engine-neutral shape from
  `whatsapp-engine.interface.ts` verbatim — no DTO, no remap — but the record types the typed SDKs
  declare for them were hand-written and never bound to that contract, so they advertised fields the
  server never sends while omitting most of the ones it does. `StatusRecord` gains
  `contact`/`caption`/`expiresAt` (plus the declared-but-not-yet-populated
  `mediaUrl`/`backgroundColor`/`font`) and drops the never-sent `statusId`/`body`; `LabelRecord`
  replaces `color`/`colorHex` with the real `hexColor`; `ChannelRecord` gains
  `inviteCode`/`picture`/`verified`/`createdAt` and drops the never-sent `pictureUrl`/`role`; and
  channel messages get a dedicated `ChannelMessageRecord` (`id`/`body`/`timestamp`/`hasMedia`/`mediaUrl`)
  instead of being typed as the persisted `MessageRecord`, which that endpoint never returns — it reads
  WhatsApp live. This mirrors how `ChatHistoryMessage` already models the live `messages.history()`
  payload. Status timestamps are typed as the ISO 8601 strings they serialize to rather than
  `Date`/`Object`. JavaScript, Python, and Java needed all four corrections; Go needed the two channel
  ones (its status and label models were already right). The PHP SDK is array-based and unaffected.
  ⚠️ **Breaking (typed SDK consumers):** every field named here was one the server has never sent (always
  `undefined`/`null`), so the code reading it was already broken at runtime; it now fails to compile.
  `label.color`/`label.colorHex` → `label.hexColor`; `channel.pictureUrl` → `channel.picture`;
  `status.statusId` → `status.id`; `status.body` → `status.caption`. `channel.role` has no successor —
  the server has no such field, so drop the read. Conversely the
  real fields (`status.contact`, `channel.inviteCode`, `message.hasMedia`, …) were previously compile
  errors and now resolve. Nothing caught this before: these controllers declare no `@ApiResponse` type,
  so `openapi.json` carries no response schema for them and `openapi:check` had nothing to diff, while
  the SDK suites mocked the transport and asserted URLs only. A type-level wire contract
  (`sdk/javascript/test/wire-contract.test-d.ts`, gated by `tsc` in the JavaScript SDK's `npm test`) plus
  per-model decode guards in the Java and Go suites now pin the models to the engine shapes. Refs #754.

- **Swagger now agrees with the engine capability matrix on status and catalog (docs only).** Eight
  operations were describing something other than what they do, and the drift ran in both directions.
  The three status-post routes were labelled "(Baileys only)" — stale since #714 wired them on
  whatsapp-web.js, and contradicted by the matrix, which has listed both engines as `supported` ever
  since; the label told whatsapp-web.js users a working endpoint was unavailable to them. Their `201`
  also promised the status was "posted to the specified recipients", which is true only on Baileys:
  whatsapp-web.js ignores the `recipients` allow-list and broadcasts to the account's status-privacy
  audience, as the adapter already warns at runtime. Dropping the stale label without that caveat would
  have replaced a wrong label with a worse silence, so the responses and the `recipients` field now say
  which engine honors it. In the other direction, the three catalog reads documented a plain `200` as
  though they returned data, and the two catalog **sends** documented a `201` they can never return —
  the matrix marks all five `not-available` on both engines. whatsapp-web.js stubs the reads (`null`/an
  empty page with a warn log) and Baileys raises `501`; the sends are `501` on both. Every real response
  is now documented and the summaries name the gap. The matrix's own header claimed five whatsapp-web.js
  entries were `not-available` while two of the five it named said `supported` two lines below; it is
  three, and the stale adapter line references in the catalog evidence now cite the symbols instead, so they cannot drift again. No
  behavior change; `openapi.json` regenerated.

- **The send-response Swagger text now matches the prose it was corrected alongside (docs only).** The
  `messageId` description still asserted that a message to a number not on WhatsApp "never delivers" —
  the same unevidenced claim about WhatsApp's behavior that was retracted from `docs/06` in the same
  change that edited this string. It now says what the prose says: the outcome reaches you
  asynchronously, if at all. `openapi.json` regenerated.

- **The Message Tester's status code renders in monospace.** It was emitted as `<span class="mono">`,
  but every monospace rule in the dashboard hangs off a compound selector (`.detail-value.mono`), which
  a bare span never matches — so the class contributed only the RTL direction isolation it was chosen
  for, and nothing else. A plain `<code>` earns both from the existing global rules with no new CSS.

- **Corrected the send-response documentation (docs only).** The guidance added in #739 overstated what a
  stalled send tells you: it said a message resting at `sent` for a recipient you have never reached is
  "almost certainly a number that is not on WhatsApp." That inference does not hold in the other
  direction — a _registered_ recipient whose device has not come online since the send stays at `sent`
  indefinitely too, by design, so the state is not diagnostic on its own. The unevidenced claim that an
  unregistered recipient is "the most common cause" of a send that never arrives is gone, as is the
  description of what the message looks like in a WhatsApp client, which is not ours to assert. The
  section also claimed _every_ send route returns `201` with `{ messageId, timestamp }`; `POST send-bulk`
  returns `202` with a batch envelope, and the `status/send-*` routes return a `statusId` and an ISO
  timestamp rather than a `messageId` and epoch seconds. Both exceptions are now stated where the rule
  is. Finally, the documented `status` lifecycle omitted its terminal error state: WhatsApp reporting an
  error for a message advances it to `failed` and dispatches a `message.failed` webhook, on both engines
  — that signal existed all along and is now written down. No behavior change. Refs #738.

### Fixed

- **A deleted message is cleared again on a WhatsApp Web build that renamed the id field.** The rename
  sweep reached the send, ack, status and inbound paths but not `message_revoke_everyone`, which read
  both ids unguarded. `revokedId` needed the fallback even on a patched install: whatsapp-web.js
  overwrites the normalized id with a raw spread of the revocation's `protocolMessageKey`, and that key
  is normalized by neither the structure constructor nor the injected serializer — so it is the one
  place a fully patched build still hands back a raw key. Without it the id arrived undefined, the
  update fell back to the notification's own id, matched no row, and the deleted message's text stayed
  in the database and on the dashboard while WhatsApp showed it as deleted. The status listing
  (`collectStatuses`) and channel-message reads had the same gap: a status whose id was lost could not
  be revoked by `deleteStatus`, and a channel message reported the literal string `"undefined"` as its
  id rather than the empty sentinel. The channel-message type declared the id in a shape that made the
  renamed field unreadable without a cast, the same defect corrected on the inbound path.

- **Documentation corrected where it contradicted the code.** `docs/06` told whatsapp-web.js operators —
  the default engine — that posting a status returns `501`, which has been untrue since #714 wired it;
  the shipped OpenAPI schema and the adapter both say otherwise. In the other direction it promised that
  the `recipients` allow-list restricts who sees a status, which holds on Baileys but not on
  whatsapp-web.js, where the list is ignored and the status reaches the account's whole status-privacy
  audience with no error — the one drift here that could surprise someone about who read their status.
  The catalog routes documented success bodies no engine can return (both sends always `501`; the reads
  are stubs that return `null`/empty unconditionally). `docs/03` marked Phone Link unavailable on
  whatsapp-web.js though the adapter has implemented it since #552. `docs/18` and `sdk/README.md` still
  described three or four SDKs, listed three of five in their tables, omitted Maven Central entirely, and
  pinned a gateway version last true at 0.7.3. The capability-matrix summary counts were stale
  (recomputed from the matrix itself: 123 supported, 19 not-available across 14 methods), and its catalog
  evidence now cites symbols rather than line numbers, which had drifted twice in two releases.

- **`PLUGINS_ENABLED` removed from `.env.example` and the compose file.** It was documented, plumbed into
  the container, and read by nothing — an operator setting it to `false` still got the full plugin
  surface. The flag is gone rather than wired: the plugins module is `@Global()` and eight non-plugin
  files inject its providers, so a genuine opt-out is a change of its own, not a release-eve edit. All
  plugin routes remain ADMIN-only.

- **Inbound messages keep their id on a WhatsApp Web build that renamed the field.** The id-rename
  sweep (#762/#765/#773) taught the send, ack and status paths to read `$1` when `_serialized` is
  absent, but missed the busiest path of all: `buildIncomingMessageBase`, which runs on every message
  that arrives (`onMessage`) and every message the account sends from a linked phone
  (`onMessage_create`). It read `msg.id._serialized` unguarded — and its parameter type declared the
  id as `{ _serialized: string }`, so the renamed field was not merely unread but _unreachable_
  without a cast, and the `id: string` it produced was `undefined` at runtime. On an affected build
  without the build-time backport applied, every inbound message reached the webhook, the WebSocket
  and the database with no id: nothing to dedup on, nothing to quote in a reply, nothing for an ack
  to match. The id now falls back to `$1`, and an id readable by neither name reports the same empty
  sentinel the send path uses — normalized to NULL at the persist chokepoint, mirroring
  `saveOutgoingMessage`, because the non-partial `(sessionId, waMessageId)` unique index exempts NULL
  but would collide the second `''`.
- **Logs CSV export truncated at 200 rows.** The export loop requested 500-row pages and treated any
  short page as the last one, but `GET /audit` clamps `limit` to `MAX_AUDIT_PAGE_SIZE` (200) — so the
  first page always looked short and every export stopped at 200 rows regardless of how much history
  matched. Pagination now terminates on the server-reported `total` (and on empty pages) instead of on
  a guessed page size, so the export can no longer be truncated by a server-side clamp. Thanks
  @kabir74705 for the report and the original fix.

- **Dashboard overstated connected sessions and showed a fabricated trend.** The "Active Sessions" KPI
  read `stats.active`, which counts running engine instances — including `initializing`, `qr_ready`,
  and `connecting` — so it reported sessions that could not yet send or receive as active. The green
  "+N" trend arrow beneath it was not a delta at all: it rendered the current READY count as though it
  were a period-over-period gain, so a steady deployment appeared to be permanently growing. The card
  now reports the READY count (relabelled "Connected Sessions") with a plain `{running} running ·
{total} total` breakdown, and the fake trend indicator is gone. Thanks @kabir74705 for spotting both.

- **The whatsapp-web.js backport can no longer latch in a half-patched dependency.** The patcher proves a
  tree is whole before standing down, and #759 added that check precisely so a run that died mid-apply
  could not be mistaken for an upstream fix. The proof was incomplete in the one place it mattered most.
  `REQUIRED_SITES` asserted the eight structure constructors but not `src/util/Injected/Utils.js` — the
  browser-side normalizer every inbound message crosses on its way to Node, and the **last** of the
  twelve files `patch` writes, one after the `Message.js` the stand-down check keys on. A run that died in
  that window left a tree where every assertion passed, so each later run stood down as healthy while the
  primary normalizer was permanently absent — the exact latch the check exists to prevent. `Client.js` and
  `GroupChat.js` normalize ids too and were likewise unasserted; all three are now covered. The Docker
  image build runs the patcher directly, so it now fails the build on such a tree instead of shipping it.
  Separately, the half-patched error was the only one of the four not marked as leaving a partial tree, so
  `--best-effort` downgraded it to a warning; it now exits non-zero like the other three. Note this makes
  the tree _reported_ on the `npm install` path rather than rejected there — the `postinstall` hook
  discards the patcher's exit code, so the install still succeeds; that is pre-existing and deliberately
  untouched, since failing `npm install` outright is the trade the flag exists to avoid. Both fixes are
  regression-tested, including the `--best-effort` path.

- **A status post no longer claims success it cannot prove, and no longer throws away a readable id.**
  #762 established that `whatsapp-web.js` can _resolve_ `undefined` instead of throwing, and that reporting
  that as success is unrecoverable — so a send with no message back now fails loudly. Status posts were
  left on the old behavior: they returned **201** with an empty `statusId` and a `new Date()` invented on
  the spot, for a status that may never have been published. Their case is in fact simpler than a send's —
  the engine returns the status model before reaching the lookup that makes a send's empty result
  ambiguous, so no message back means nothing was posted, full stop — and it now surfaces as a `500`
  carrying that reason rather than a fabricated success. Separately, the id was read only as `_serialized`,
  so on a build that renamed the field to `$1` (#747) a status that posted perfectly well came back with
  `statusId: ""` — and since `deleteStatus` takes that id as its revoke handle, the status could never be
  taken down. The rename fallback the send path has since #762 is now applied here too. The same fallback
  is added to the ack listener, where an unreadable id previously stranded a message at `sent` forever —
  including the `failed` ack that is the only signal a send was rejected. Baileys is unaffected: its send
  and status paths already agree with each other.

- **The Message Tester no longer invents HTTP status codes.** Its result banner rendered one of two
  hardcoded strings — `200 OK - Success` or `400 - Failed` — for every outcome, in all eleven locales.
  Neither number was ever read from the response. Send routes return **201**, not 200, so the success
  banner was wrong on every successful send; and _any_ failure displayed `400`, including a server 500
  and the recipient pre-check that short-circuits in the browser without issuing a request at all. The
  banner now states the outcome and, when a request actually reached the gateway, the real status the
  gateway returned — which `services/api.ts` already attaches to the error for exactly this purpose.
  Where no request was made, no code is shown rather than a fabricated one. This is what made a plain
  `500` get reported as a mystery `400` in #750. Fixes #750.

- **A production boot that serves the dashboard over plain HTTP now warns about the CSP upgrade that
  blanks it.** In production OpenWA emits `upgrade-insecure-requests`, which is correct behind a
  TLS-terminating reverse proxy — the shipped `docker-compose.yml` topology — but silently breaks a
  direct-HTTP deployment: the browser upgrades the dashboard's own script fetches to `https://`, the
  non-TLS server cannot answer them, no JavaScript runs, and the UI renders a blank white screen. The
  failure happens entirely in the browser, so the server log stayed clean and the operator had nothing
  to go on; the existing `CSP_UPGRADE_INSECURE_REQUESTS=false` opt-out was documented only under
  `.env.example`'s "Developer settings" heading, where a production operator had no reason to look.
  Boot now names the setting when the trap is possible, `.env.example` documents it under Security with
  the symptom spelled out, and `docs/12-troubleshooting-faq.md` gains a "Dashboard renders a blank white
  screen" entry. The warning cannot distinguish direct HTTP from a TLS proxy at boot (Express
  `trust proxy` is off), so it fires for both and tells a proxied operator to ignore it. The CSP default
  is unchanged. (#731)
- **The startup banner now advertises `BASE_URL` instead of a hardcoded `localhost`.** The
  `🚀 running on`, `📚 Swagger docs`, and `🖥️ Dashboard` lines printed `http://localhost:${PORT}` as a
  literal, regardless of where the instance was actually reachable — contradicting the `AuthService`
  banner directly above them, which already honoured `BASE_URL`. Two adjacent log lines could therefore
  report different URLs for the same server, which read as "the UI is pinned to localhost" and sent #731
  chasing `BASE_URL`/`BIND_HOST`/`API_PORT` rather than the actual cause. (#731)

- **Saving Infrastructure no longer persists a guessed engine when the running engine is unknown.** The
  engine radio falls back to its `whatsapp-web.js` default until `/infra/engines/current` resolves; if that
  request failed, saving wrote that default as `ENGINE_TYPE`, silently switching a Baileys deployment on
  the next restart. The save payload now omits `engine.type` unless the radio actually seeded from the
  running engine or the operator picked one — the backend leaves a saved `ENGINE_TYPE` untouched when the
  field is absent, so an unrelated save can no longer flip the engine.

- **The dashboard now clears a message deleted for everyone while the thread is open (whatsapp-web.js).**
  `message.revoked` carries `revokedId` — the id of the original deleted message, which whatsapp-web.js
  resolves separately from the event's own `id` — but the dashboard's WebSocket projection dropped the
  field and matched its message cache on `id` alone. Persistence was always correct (the backend keys
  its `UPDATE` on `revokedId`), and webhook/API consumers already received the field; only the live
  dashboard view was affected, where `staleTime: Infinity` meant an already-open thread kept rendering
  the deleted message's original text until a reload, reconnect, or cache eviction. The projection now
  forwards `revokedId`, and the cache lookup matches on either candidate id (against both the row id
  and `waMessageId`), which keeps the Baileys path — where the two ids are identical — unchanged. When
  whatsapp-web.js cannot resolve the original (it is no longer in its local store) `revokedId` is
  absent and the lookup falls back to `id`, as before. Refs #755.

- **A failed group creation now reports why it failed.** `whatsapp-web.js` signals a failed
  `createGroup` by _resolving_ with a plain string (`'CreateGroupError: …'`) instead of throwing, and
  its typings say so (`Promise<CreateGroupResult | string>`) — but the adapter cast that union away and
  read `.gid` off the string, so the reason upstream gave us was replaced by an opaque
  `TypeError`. The union is handled, and an unreadable group id now fails loudly rather than being
  coerced through `String()` into the literal id `"undefined"`. The status is unchanged (the group
  genuinely wasn't created, so it was always a 500); the error text is now the real one.

- **An ack whose message id can't be read is dropped instead of silently advancing nothing.** On a
  WhatsApp Web build that renames the id field (#747), the id reached the status `UPDATE` as
  `undefined`, which TypeORM sends as `waMessageId = NULL` — matching no row, since `x = NULL` is never
  true. The ack advanced nothing, burned its one-shot retry, and left only a misleading "no status row
  advanced" line behind. It is now dropped at the adapter boundary, where the reason is still visible.

- **A send whose message can't be read back no longer crashes, and never claims a delivery it can't
  prove.** `whatsapp-web.js`'s `Client.sendMessage()` can _resolve_ with `undefined` instead of
  throwing, while its typings declare `Promise<Message>` — so the adapter's `msg.id._serialized` reads
  surfaced as an opaque `TypeError: Cannot read properties of undefined (reading 'id')` and a 500, at
  seven send sites. All of them now route through one helper that distinguishes the two cases the
  dependency collapses into that single `undefined`: no message at all is reported as a failed send
  (it is genuinely ambiguous whether anything was dispatched, and a retryable false negative beats
  claiming a delivery that never happened), whereas a message whose id is merely unreadable reports
  the empty no-id sentinel `forwardMessage` already used — never a synthesised id. An empty id is now
  normalized to NULL inside `saveOutgoingMessage`, so it can't collide on the non-partial
  `(sessionId, waMessageId)` unique index and silently drop a bulk row. Refs #757.

### Security

## [0.8.18] - 2026-07-17

### Added

### Changed

- **Send-response semantics clarified (docs only).** The send endpoints' Swagger response and `docs/06` now state explicitly that `201` means the gateway accepted the message for sending — not that the recipient received it — and that WhatsApp does not reject an unregistered recipient synchronously, so a message to a number that is not on WhatsApp still returns `201` with a `messageId` but never delivers. `GET /sessions/{id}/contacts/check/{number}` is cross-referenced as the way to pre-validate a new recipient, and the async message `status` lifecycle (`sent → delivered → read`, or `failed`) as the source of real delivery state. No behavior change. Refs #738.

### Fixed

- **Inbound media download, message ids, acks, and reply quoting restored**
  (whatsapp-web.js `id._serialized` → `id.$1` rename). WhatsApp Web build 2.3000.x
  (rolled out ~2026-07-14) renamed the internal serialized message-id property
  from `id._serialized` to `id.$1`, which broke whatsapp-web.js 1.34.7's
  `downloadMedia()`, message-id extraction, ack tracking, and quoted-message
  resolution for every bot at once. The production Docker image now backports
  upstream fix [#201832](https://github.com/wwebjs/whatsapp-web.js/pull/201832)
  (`Base._normalizeId`) into the installed dependency at build time via
  `scripts/patch-wwebjs-201832.js`. The patcher applies the real upstream diff
  (with a loud-fail guard against version skew) and auto-disables the moment a
  future whatsapp-web.js release ships the fix, so it is a stopgap, not a fork.
  Fixes #747.

- **Source installs get the whatsapp-web.js backport too, not just the Docker image.**
  `npm install` now applies it from `postinstall`, so the local-development setup in
  the README is no longer stuck with broken media downloads. It is best-effort
  there: a machine without a `patch` binary (Windows outside WSL) or a
  Baileys-only setup gets a warning rather than a failed install. The image build
  still treats the same failure as fatal.

- **Reactions stay attributable on the renamed-id builds too.** `Reaction` assigns
  its keys straight through, so it is the one structure upstream's normalization
  doesn't reach; the adapter now reads the renamed field directly and falls back to
  the empty no-id sentinel instead of passing `undefined` on.

- **A reaction with no message id no longer updates an arbitrary message.**
  `applyReaction` looked the message up by an id that could be `undefined`, and
  TypeORM drops an undefined condition from the where-clause rather than matching
  nothing — so the lookup found an unrelated row and emitted its reactions under
  the incoming event. The id is now checked before the query. Latent since
  reactions were added; only reachable when an engine can't resolve the id.

- **Engine start timeouts now return a diagnostic 504 instead of a bare 500.** Two
  `POST /api/sessions/:id/start` failure modes previously escaped to NestJS's default handler as a
  meaningless `500 Internal Server Error`: (1) the **auth-timeout** — whatsapp-web.js throws the
  primitive string `'auth timeout'` when its login poll exhausts `authTimeoutMs` (default 30s), e.g.
  an unreachable session proxy means the browser launches but no QR is ever delivered; and (2) the
  **outer init-hang deadline** (`EngineInitTimeoutError`) — a wedged `initialize()` that never settles
  within `max(60s, WWEBJS_AUTH_TIMEOUT_MS+30s)`, usually a container memory/resource limit or a stalled
  Chromium. Both now map to `504 Gateway Timeout` with a diagnostic message (proxy/network vs resource
  limits respectively) and the `WWEBJS_AUTH_TIMEOUT_MS` knob for slow first boots. Engine cleanup
  (force-destroy + evict + status) still runs before mapping; generic non-timeout init rejections
  (e.g. "chromium launch failed") still propagate untouched.

- **S3 storage no longer falls back to local without an `endpoint`.** The S3 client init required an
  `endpoint`, which only S3-compatible stores (MinIO, R2) need — standard AWS S3 (whose endpoint is
  derived from region) silently initialized no client and served all media from local disk (#735).
  `endpoint` and `forcePathStyle` are now applied only when an endpoint is configured, so AWS S3 uses
  its default virtual-hosted addressing while MinIO-compatible stores keep path-style.

- **`.env.example` no longer ships a default `S3_ENDPOINT`.** The template's pre-filled
  `http://localhost:9000` silently re-routed a copy-paste AWS S3 config to MinIO/path-style mode and the
  local fallback; it is now commented out so the default is AWS virtual-hosted mode (#735 follow-up).

- **WhatsApp Engine selection on the Infrastructure page no longer reverts to the running engine.**
  The engine radio was re-stamped from the live `/engines/current` value on every emission, so a late
  first resolution (or a window-focus refetch) overwrote an operator's in-progress, unsaved selection
  (#735). The selection now seeds once and freezes on the first user interaction, matching the
  one-time hydration lock the other infrastructure fields already had.

- **Message Tester supports uploading local media files.** Media messages could previously only be
  sent from a URL; a file picker is now available alongside the URL field (mutually exclusive with
  it), reading the file as base64 (#735). The backend already accepted `base64`; this adds the
  dashboard UI for it. Uploads are client-capped at 18 MiB (the effective base64-over-JSON body
  limit) so an oversized pick surfaces a clear error instead of freezing the tab, and switching the
  message category after picking a file now clears it so stale bytes aren't routed to the wrong
  endpoint.

### Security

- **Plugin archive extraction hardened against CVE-2026-39244 (adm-zip declared-size zip-bomb OOM).**
  The `adm-zip` bump to `0.6.0` in #728 brings upstream's fix for CVE-2026-39244: a crafted archive
  declaring a huge entry size could drive an unbounded `Buffer.alloc` and exhaust memory during
  extraction. This closes the declared-size allocation vector on the plugin marketplace install path
  (`src/modules/plugins/plugin-installer.ts`), complementing the project's own `readEntryData()` guard
  that already caps _decompressed_ bytes via zlib `maxOutputLength`. The two adm-zip 0.6.0 behavior
  changes (`extractEntryTo` subdirectory preservation, non-fatal `utimes`) touch APIs this project does
  not use. The now-redundant `@types/adm-zip` devDependency is dropped as well — adm-zip 0.6.0 ships its
  own `types.d.ts`.

## [0.8.17] - 2026-07-13

### Added

- **`AuditAction` emit-coverage gate.** A structural test now fails the build when an `AuditAction`
  enum value is neither emitted at a real call site nor registered (with a reason) in a new
  intentionally-unemitted registry. A declared audit event can no longer silently exist with no
  emission site, and a new action cannot land without either wiring it or documenting why it is held
  back. The registry is also checked for stale entries (an action that is in fact emitted) and empty
  reasons, so it cannot decay into a dumping ground.

- **Operator-tunable HTTP server timeouts.** The gateway now pins `requestTimeout`,
  `headersTimeout`, and `keepAliveTimeout` on its HTTP server explicitly (previously Node's
  implicit defaults), exposed via `REQUEST_TIMEOUT_MS` / `HEADERS_TIMEOUT_MS` /
  `KEEPALIVE_TIMEOUT_MS` and logged at boot. Defaults match Node 22 (300s / 65s / 5s);
  `headersTimeout` is normalized to stay above `keepAliveTimeout` (Node requires it), and the three
  are validated as positive integers at boot.

- **Committed OpenAPI snapshot + CI sync gate.** The gateway's OpenAPI document is now committed as
  `openapi.json` (generated from the NestJS Swagger decorators via `npm run openapi:export`) and a CI
  check (`npm run openapi:check`) fails when a controller/DTO change lands without regenerating it, so
  the machine-readable contract can never silently drift from the code. SDK/API consumers now have a
  versioned artifact at the repo root.

- **Pre-release boot smoke on amd64 + arm64.** Cutting a release tag now runs the just-published
  image on both `linux/amd64` and `linux/arm64` (via QEMU) and polls the dependency-free
  `/api/health/live` endpoint before the GitHub Release is created — so a runtime-only boot regression
  on one architecture (a clean build can still produce a native-dep/Chromium SIGTRAP on arm64) cannot
  ship under a release. The Release job waits on the new boot-smoke job.

- **SBOM attestation on published images.** Each image built by CI and on release now carries an
  in-toto SBOM attestation alongside the SLSA provenance that `docker/build-push-action` already
  generates by default. Both are verifiable with
  `docker buildx imagetools inspect ghcr.io/rmyndharis/openwa:<tag>`. Provenance is now also pinned
  explicitly (`provenance: true`) so the attestation pair is self-documenting rather than reliant on
  the action default.

- **HTTP RED metrics.** The `/api/metrics` endpoint now exposes
  `http_requests_total{method,route,status}` and an `http_request_duration_seconds` histogram (per
  route), recorded by a global interceptor. Route labels use the Express route pattern (bounded —
  `/api/sessions/:id`, not the raw URL) with a `Controller#handler` fallback, and `/api/health` +
  `/api/metrics` are not counted. Conventional unprefixed names so a generic RED dashboard or a 5xx
  error-rate alert matches them directly.

- **Request correlation ids (`X-Request-ID`).** Every inbound request now carries an id that
  propagates through the whole request via AsyncLocalStorage, so each JSON log line and each
  audit-log metadata blob stamps it — a request can be traced end-to-end. A valid client-supplied
  `X-Request-ID` (alphanumeric + dash, ≤128 chars) is echoed; anything else (including a CRLF
  header-injection attempt) is replaced with a generated UUID. The id is also set on the response.

- **Engine capability matrix + drift gate.** A committed, source-verified matrix
  (`src/engine/engine-capability-matrix.ts`) records, for every `IWhatsAppEngine` method on each
  engine (whatsapp-web.js default, Baileys), whether it is `supported` or `not-available` — and for
  the not-available ones, the root cause: `adapter-gap` (the underlying library supports it, OpenWA
  just hasn't wired it — fixable) vs `library-limitation` (no first-class library API), with the
  cited library symbol as evidence. A drift gate fails when a method's throw-availability changes.
  `docs/engine-capability-matrix.md` inventories the unwired adapter-gaps as a prioritized capability
  backlog.

- **Delete-for-me on the Baileys engine.** `deleteMessage(…, forEveryone=false)` now performs a
  delete-for-me via Baileys' `chatModify({ deleteForMe })` instead of returning 501. Revoke-for-
  everyone (`forEveryone=true`) was already wired; this completes `deleteMessage` on the Baileys
  engine for the most common delete mode.

- **Status posts on the whatsapp-web.js engine.** `postTextStatus`, `postImageStatus`, and
  `postVideoStatus` now work on whatsapp-web.js (the default engine) — they route through
  `sendMessage('status@broadcast', …)` (text styling via `extra: { backgroundColor, fontStyle }`;
  media via `MessageMedia` + `caption`). Previously these returned 501 on the default engine despite
  the library supporting them; the stale "blocked upstream, #455" guard is removed (#455 is a closed
  feature request, and whatsapp-web.js 1.34.7 ships a real status-send path). Caveat: the library has
  no status-recipient arg, so `StatusPostOptions.recipients` is not honored on this engine (it
  broadcasts to the account's status-privacy audience; a one-time warning is logged). The Baileys
  engine continues to honor `recipients`.

- **Chat labels on the Baileys engine.** `addLabelToChat` and `removeLabelFromChat` now work on
  the Baileys engine — 1:1 to `sock.addChatLabel(chatId, labelId)` / `sock.removeChatLabel(chatId,
labelId)` instead of returning 501. WhatsApp-Business-only (rejects on personal accounts). Label
  _listing_ (`getLabels` / `getLabelById` / `getChatLabels`) remains unavailable on Baileys (no
  first-class library API — see `docs/engine-capability-matrix.md`).

- **Status delete on the whatsapp-web.js engine.** `deleteStatus(statusId)` now works on
  whatsapp-web.js via `client.revokeStatusMessage(statusId)` instead of returning 501 — completing
  the status lifecycle (post + delete) on the default engine. Own-status only (the library revokes
  the caller's own status posts).

- **Read contact stories on the whatsapp-web.js engine.** `getContactStatuses()` and
  `getContactStatus(contactId)` now return contact "stories" (24h status posts) via
  whatsapp-web.js `getBroadcasts()` / `getBroadcastById()` flattened to `Status[]` (contact via
  `broadcast.getContact()`, type from `MessageTypes`, 24h TTL) instead of stubbing to `[]`. The
  Baileys engine still cannot read stories — `fetchStatus` returns the _about_ text, not stories
  (documented as a library limitation).

- **Channel lookup / subscribe / unsubscribe on the Baileys engine.** `getChannelById(id)`,
  `subscribeToChannel(inviteCode)`, and `unsubscribeFromChannel(id)` now work via Baileys
  `newsletterMetadata` (mapped to `Channel` with optional fields), `newsletterFollow` (subscribe,
  resolving invite→jid first), and `newsletterUnfollow` (unsubscribe, 1:1). `getChannelById` on
  Baileys resolves ANY channel by jid (richer than the whatsapp-web.js subscribed-list lookup).
  `getChannelMessages` remains unsupported — `newsletterFetchMessages` returns a raw BinaryNode with
  no library parser, so it stays a documented gap rather than an unverified walk.

- **Bounded webhook fan-out.** An event matching N webhooks now delivers at most
  `WEBHOOK_DISPATCH_CONCURRENCY` (default 16) concurrently instead of opening N outbound sockets at
  once; the rest queue and run as slots free. Per-webhook isolation (`Promise.allSettled`) is
  unchanged. The shared `ConcurrencyLimiter` was also promoted from `engine/adapters` to
  `common/utils` (it has no engine-specific logic), so the webhook module no longer imports across the
  engine boundary.

- **Optional Redis-backed rate-limit storage.** When `REDIS_ENABLED=true`, API rate-limit counters
  now persist to Redis (a new `RedisThrottlerStorage` implementing @nestjs/throttler v6's
  `ThrottlerStorage`), so limits aggregate across replicas behind a load balancer instead of being
  per-process. Default off (single-node deployments gain nothing and it adds a connection dependency).
  Fail-OPEN on Redis error — rate limiting is a secondary control, and fail-closed would self-DoS the
  API.

### Fixed

- **Silent delivery failure for 1:1 Baileys sends to LID-migrated contacts (ack 463).** On the
  Baileys engine, a 1:1 send addressed by phone (`<phone>@c.us` / `<phone>@s.whatsapp.net`) to a
  contact WhatsApp has migrated to LID addressing was rejected server-side with ack error 463
  (`NackCallerReachoutTimelocked` / "missing tctoken" — the privacy token is stored and honored
  under the LID), while the same send addressed to the contact's `<lid>@lid` delivered. Because
  Baileys generates the message id locally, the API still returned a `messageId`, so the
  non-delivery was silent to the caller. The adapter now resolves phone-dialect 1:1 chat ids to
  the contact's LID at the send boundary via `sock.signalRepository.lidMapping.getLIDForPN` (the
  same mapping the Baileys send path consults), applied in `sendTextMessage`, `sendContent` (all
  media/location/contact/poll sends), and `sendChatState`. Groups, broadcast, already-`@lid`, and
  unmapped ids pass through unchanged (non-migrated contacts behave identically), and resolution
  is best-effort: any lookup error falls back to the phone jid. The disappearing-timer lookup
  still resolves under the LID, since `getEphemeralExpiration` already keys on the raw, engine,
  and neutral forms of the jid. Thanks @isaacmendes. [#717]

- **Diagnosable failure for a stale browser profile after a binary-changing upgrade.** Upgrading
  across the v0.8.12 amd64 browser-binary switch (Debian Chromium → Chrome for Testing, #663) — or any
  later change to the Chromium/Chrome binary — can leave an already-authenticated `whatsapp-web.js`
  session's persistent browser profile incompatible with the new binary: on the next start the page
  context is destroyed during injection and the engine fails with Puppeteer's opaque
  `Execution context was destroyed`, which reads like a Puppeteer bug and gave no hint that the stale
  profile was the cause. The `whatsapp-web.js` adapter now detects that error in its `initialize()`
  catch and logs an advisory pointing the operator at the remedy (delete the session profile dir and
  re-scan); the error still propagates unchanged, so existing failure handling is unaffected. The
  profile is not auto-recovered — a tainted profile is not safely portable across Chromium major
  versions (clearing only the cache subdirs is insufficient), so a one-time re-authentication is
  required. [#708]

- **OpenAPI export script under current env validation.** `scripts/export-openapi.ts` had been broken
  since the SQLite `DATABASE_NAME` file-path validation tightened (it pinned an in-memory data DB,
  which that rule rejects). The data connection now uses a temp-dir SQLite file that is removed on
  exit, so the snapshot generator runs hermetically again.

## [0.8.16] - 2026-07-12

### Added

- **Integration SDK v1 `response` contract for inbound routes.** A route may now declare a host-side
  `preflight` (today: `session-alive`, returning 503 for a definitively-dead WhatsApp session) and a
  declarative `ack` (status/body/headers) returned synchronously to the provider. The plugin ALWAYS runs
  async (enqueued, full DLQ/retry); for routes declaring `response`, the ack is returned without awaiting
  enqueue so a queue-disabled deployment cannot block the provider's deadline. A dead session (no live
  engine or `FAILED`) on a concrete-scoped route now fails fast with 503 instead of being swallowed into
  202; recoverable statuses still 202+enqueue and let the worker fail fast. The inert `mode: 'sync-reply'`
  value is deprecated in favor of `response` (kept for SDK v1 additive-only compatibility). Routes with no
  `response` are byte-identical to today's default fast-ack.

- **`standard-webhooks` ingress signature scheme.** A route may now declare
  `signature.scheme: "standard-webhooks"` to verify [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)
  payloads host-side (Supabase Auth's Send SMS hook, and any Svix-routed provider). The wire format is
  fixed by the spec, so only `toleranceSec` (default 300s) and `dedupHeader` apply. The operator pastes
  the provider's Svix secret (`v1,whsec_<base64>`) as the instance secret. This surfaces a bad signature
  as a synchronous 401 and — because the `session-alive` preflight runs after verify — makes that preflight
  safe to use (an unauthenticated caller can no longer probe liveness). Additive; existing
  `hmac-sha256`/`shared-secret`/`none` behavior is unchanged.

## [0.8.15] - 2026-07-11

- **WhatsApp Web sessions no longer wedge silently in `INITIALIZING` forever.** `engine.initialize()` was awaited with no timeout, and neither whatsapp-web.js nor Puppeteer bounds the initial browser launch/navigation (`page.goto` is called with `timeout: 0` and the web-version-cache fetch carries no timeout). If Chromium stalled under container memory pressure — realistic at the documented 2 GB Standard profile — the await never resolved or rejected: the session sat in `INITIALIZING` indefinitely, `GET /sessions/:id/qr` 400'd forever, and nothing was logged. The #635 abandoned-engine reaper is reactive (terminal `onError` / rejected re-init only), so nothing recovered it. `initializeEngine()` now races `engine.initialize()` against a deadline derived from the configured auth wait (floor 60 s, or `WWEBJS_AUTH_TIMEOUT_MS` + 30 s when an operator has raised that for slow first boots) so a legitimate slow init is never cut short; on timeout it force-kills the wedged browser, marks the session `DISCONNECTED` (retryable, so the existing reconnect backoff picks it up), and rethrows — surfacing the failure to a manual `POST /start` caller instead of hanging. The race's catch is scoped to the timeout only (`EngineInitTimeoutError`): a real init rejection (e.g. Chromium can't launch) propagates untouched so `start()`'s existing `FAILED`+reason diagnostics are preserved — handling both in one catch would downgrade real failures to `DISCONNECTED` and hide their reason. Thanks @INAPA-desarrolloTIC. [#667]

- **Dashboard primary buttons were invisible until hover in light mode.** A leftover Vite template rule — `:root:not([data-theme='dark']) button { background-color:#f9f9f9 }` inside `@media (prefers-color-scheme: light)` — carried specificity `(0,2,1)` (`:root` + the `:not([data-theme])` argument + `button`), higher than every page-scoped `.X-page .btn-primary` rule `(0,2,0)`. In light mode (the default) it overrode the green design-system background with a near-white `#f9f9f9`, leaving the buttons' white text invisible until the leftover Vite `button:hover { border-color:#646cff }` ring revealed them on hover; the same `(0,2,1)` rule also pushed `.btn-secondary` and `.btn-icon` off their intended backgrounds. Removed that rule (Create-session and other primary buttons are green again), and cleared the remaining Vite scaffolding brand-colors from `index.css` (`a { color:#646cff }`, the purple `a:hover`, `button { background-color:#1a1a1a }`, `button:hover { border-color:#646cff }`) that competed with the App.css design system on import-order tiebreaks; the structural button CSS (border-radius, padding, font, cursor) is retained. Plain `<button>` elements now render with the browser default instead of the dark `#1a1a1a`. The defect was invisible to anyone developing the dashboard in dark mode. Refs #684 (addresses the dashboard-button part; the QR-with-whatsapp-web.js report in the same issue is separate and still under investigation).

- **PostgreSQL upgrade crash-loop for deployments formerly run with `DATABASE_SYNCHRONIZE=true`.** On the PostgreSQL data connection, migrations always run at boot (`migrationsRun: true`), so a schema previously bootstrapped with `DATABASE_SYNCHRONIZE=true` — whose `@PrimaryGeneratedColumn('uuid')` columns TypeORM created as native `uuid` — collides with a migration chain that assumes `varchar` ids and crash-loops the container on boot. A new guard migration (`NormalizeSynchronizeUuidColumns`), ordered before the first colliding migration, now converts those `uuid` id and foreign-key columns to `varchar` (dropping and recreating the dependent cascade foreign keys, and re-applying the `gen_random_uuid()::varchar` defaults), so affected deployments self-heal on the next restart. It is a single-probe no-op on SQLite and on already-`varchar` (healthy) PostgreSQL. For very large `messages` tables the conversion holds an exclusive lock, so run `npm run migration:run` against the stopped app during a maintenance window if needed; `DATABASE_SYNCHRONIZE=true` on PostgreSQL remains unsupported for production. Fixes #690.

- **WhatsApp Web auto-version resolver now prefers a settled build.** The whatsapp-web.js engine auto-pins its WhatsApp Web build from the wppconnect wa-version registry; the resolver previously took the registry's `currentVersion` verbatim — the absolute latest build, which can be minutes old and unvalidated and, on some setups, never reaches QR readiness (the #684 whatsapp-web.js "stuck at Starting, no QR" report class). It now picks the newest non-beta, unexpired build published at least 12 hours ago, falling back to `currentVersion` only when no build qualifies, so auto-pinning no longer latches onto a brand-new build. Operators who set `WWEBJS_WEB_VERSION` explicitly are unaffected. Fixes the whatsapp-web.js "stuck at Starting, no QR" report from #684 (Bug 2); #692 fixes the dashboard-button part (Bug 1) of the same issue.

- **Baileys engine: messages no longer get stuck on "Waiting for this message. This may take a while." on iOS recipients.** Reported specifically on iOS WhatsApp: the recipient's chat shows the message as permanently pending, with no error and a stable connection. The Baileys `makeWASocket` config had no `getMessage` implementation, so WhatsApp's own retry-on-decrypt-failure protocol had nothing to resend, leaving the recipient stuck instead of recovering within seconds; it's now backed by the message store.

- **Baileys message-store lookups no longer fail their FK check.** The engine factory keyed `messageStore.put`/`getMessage`/`clearSession` by the session's on-disk auth-directory name, but `BaileysStoredMessage.sessionId` is a foreign key to `sessions.id` — every write violated the FK and was silently dropped by the orphan guard, leaving the store empty and defeating the `getMessage` fix above. The engine config now carries the auth-directory key (`sessionId`, the session name) and the DB-row key (`dbSessionId`, the session's UUID) as two separate fields, so the message store is keyed correctly without disturbing the existing on-disk auth-directory layout (and `purgeSessionData`, still keyed by name, keeps working on delete).

- **Closed a write-then-immediate-read race in the Baileys signal key store.** The raw signal key store is now wrapped in Baileys' own `makeCacheableSignalKeyStore`, which could previously make a freshly-established session appear "missing" and force an unnecessary fresh PreKey handshake.

- **Upgraded `@whiskeysockets/baileys` `6.7.23` → `7.0.0-rc13`.** Picks up an upstream concurrency rewrite (WhiskeySockets/Baileys#2571, #2587) that closes a "dual uncoordinated prekey queues" race in the same session-establishment path; no `6.x` release (up to `6.17.16`) carries this fix.

- **Fixed a first-message-after-reconnect drop on the Baileys engine.** `handleMessagesUpsert` no longer treats every `type: 'append'` upsert as history sync — Baileys can tag a genuinely new customer message `'append'` when it arrives in the same window as a reconnect's state-sync handshake, silently dropping it; it's now gated on the message's own timestamp against the connection's open time instead (with the account's own sent-message echoes still excluded, to avoid double-firing the existing `emitOwnSendEcho` webhook).

- **Dashboard Korean (ko) locale polish.** Refined several ko strings for consistency, fluency, and accuracy (follow-up to #679): "Create New Session" → `새 세션 생성` (aligns with `생성` used elsewhere in the create flow); the plugin "Configuration" tab → `설정` (matches the rest of the config UI); "Start messaging" → `대화 시작하기` (idiomatic — in Korean one starts a conversation, not a "message"); the WhatsApp Web build "current known-good" now reads `현재` instead of `최신` (latest), which had inverted the version-pinning intent; the "New" session status → `신규` (the conventional Korean status label); and the template placeholder example re-phrases the `{{orderId}}` clause so the interpolation reads naturally.

- **Reliability and correctness hardening batch.** A set of fixes across the engine, session, auth, infra, dashboard, and SDK layers:
  - The inbound media concurrency limiter now bounds its waiter queue and rejects when full; both engines route a rejected download to their existing emit-without-media path, so a burst of inbound media can no longer grow heap without bound.
  - `start()` now cancels any pending reconnect timer before recreating the engine, so a stale timer left by a failed reconnect can no longer destroy the engine or orphan the Chromium process.
  - The dashboard chat thread now refetches after a WebSocket reconnect, so messages that arrived during a transient gap (and ack/reaction/revoke updates) are no longer silently missing until the chat is reopened.
  - Updating an API key's role, allowed sessions, allowed IPs, or expiry now disconnects the key's already-connected WebSocket sockets, so a narrowed key stops streaming realtime events for sessions/IPs it just lost. A benign rename leaves connected sockets alone.
  - The SQLite→PostgreSQL export/import path now covers every data-owned table (plugin instances + ingress HMAC secrets, conversation mappings, ingress events, both dead-letter queues) instead of only seven, so a migration no longer silently drops the Integration Fabric and the DLQs. The main connection (API keys, audit logs) stays excluded; existing seven-table exports still import unchanged.
  - The bundled `docker-compose.yml` no longer shadows dashboard-saved Puppeteer headless / session-data-path / browser-args with pinned container defaults — those are blank-forwarded so a dashboard (or `data/.env.generated`) selection applies, with the sane container defaults supplied by the application config layer (headless, `./data/sessions`, the full `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu` flag set). **Upgrade note:** if you previously saved engine config in the dashboard, re-save it (or set `PUPPETEER_ARGS`) so the full Docker sandbox flag set is retained.
  - The PHP SDK `messages.list()` and `catalog.products()` docblocks now match the real `{messages, total}` / `{products, pagination}` envelopes the server returns (consistent with the JS/Python/Java SDKs), and the SDK CI path-filter now covers backend controllers and services so response-shape drift re-runs the SDK suites.

## [0.8.14] - 2026-07-10

### Added

- **Plugin search providers (host→plugin search RPC).** A sandboxed plugin can now register as a `SearchProvider` by calling `ctx.registerSearchProvider(handler)` (e.g. `ctx.registerSearchProvider(async (query) => …)`) from its worker. The host routes `GET /api/search` queries to the plugin over a new correlated `search` / `search-result` wire protocol (mirroring the existing hook/webhook/health-check bridges), so a plugin owns all of its vendor-specific query logic (Meilisearch, Elasticsearch, Typesense, …) while the core stays backend-agnostic — adding a new backend is a plugin, with no core changes. When `SEARCH_PROVIDER=auto` (the default), an enabled plugin provider supersedes the built-in database full-text provider; `SEARCH_PROVIDER=builtin-fts` keeps the built-in active; `SEARCH_PROVIDER=none` disables search. Searches are bounded by a 10s timeout and fail fast rather than hanging, and a provider is dropped from the registry when its plugin is disabled. This is Part 1 of the plugin-search work (the query RPC + selection policy); the indexing side uses the existing `message:persisted` hook.

- **Search queries are bounded host-side and plugin results are re-scoped.** `GET /api/search` now clamps `limit` (to `SEARCH_LIMIT_MAX`) and `offset` (to `SEARCH_OFFSET_MAX`) before dispatching to any provider, so a plugin backend can no longer be asked for an unbounded page; a plugin provider's returned hits are re-filtered host-side against the caller's session scope, mirroring the SQL-enforced built-in provider. The provider's `total` is preserved when no out-of-scope hit was stripped, so pagination is unaffected. [#680]
- **Ingress events and delivery failures are now retained.** `ingress_events` and `integration_delivery_failures` are pruned past `INGRESS_RETENTION_DAYS` (default 90; `<=0` disables), matching the existing webhook/audit retention so the tables no longer grow without bound. [#680]
- **MCP auth failures are audited and Bull Board login is throttled.** MCP authentication failures are now written to the audit log (parity with the REST `ApiKeyGuard`), and the Bull Board login endpoint is pre-auth IP-throttled (sharing MCP's `MCP_IP_RATE_LIMIT_*` settings) to bound credential-guessing floods. [#680]
- **Ingress guardrails.** A startup warning now names any unauthenticated (`scheme:'none'`) ingress route a plugin declares; the documented `{id}` HMAC `contentTemplate` placeholder is now implemented (previously it silently 401'd deliveries that used it). [#680]
- **CI now type-checks spec files, and the release gate matches CI.** A `tsc --noEmit -p tsconfig.json` step full-program type-checks test files (previously invisible to CI, since `tsconfig.build.json` excludes specs); the release workflow's test gate now runs the full CI suite (lint + typecheck + jest + e2e + postgres-migration + dashboard) gating both the image and the GitHub Release. [#680]
- **Korean (한국어) dashboard locale.** The dashboard language picker now includes Korean alongside the existing locales. Thanks @moduvoice. [#679]

### Fixed

- **Sending media to a channel (`@newsletter`) on the whatsapp-web.js engine now fails fast with `501 Not Implemented` instead of a raw `500`.** whatsapp-web.js builds a channel media message and calls `msg.avParams()`, a WhatsApp-Web-page method removed in a recent WA Web build, so the send crashed with `TypeError: msg.avParams is not a function` (upstream wwebjs#201823, unresolved in the current 1.34.7 release). The engine adapter now guards all media sends — image/video/audio/document (which share one send path) **and sticker** (a separate path that funnels into the same crash for channels) — for a channel recipient and raises a typed `ChannelMediaNotSupportedError` (501) before reaching the broken upstream code. Text→channel still works; only media is affected. The Baileys engine is unaffected. Workaround for affected media-to-channel sends until the upstream is fixed: switch the session to the Baileys engine, or pin `WWEBJS_WEB_VERSION` to a cached WA Web build that predates the `avParams` removal. [#673]

- **`base64` media now takes precedence over `url` when both are provided on a media send.** A `send-image`/`send-video`/etc. request carrying both fields previously sent the URL — and because `@ValidateIf` skipped `@IsUrl` validation on `url` whenever `base64` was present, a stale `url` (e.g. an example default left in the body, or a client such as the n8n community node that sends both) was fetched unvalidated and could 404, silently shadowing the supplied base64 image. `buildMediaInput` now prefers `base64`, aligning the send path with the already-base64-first persisted message metadata. Both engine adapters (whatsapp-web.js and Baileys) already guard the remote fetch behind an `isHttpUrl` check, so the change covers both. [#670]

- **Fresh Docker Compose dev installs no longer boot-loop with `SQLITE_CANTOPEN`.** `.env.example` ships `DATABASE_NAME=openwa` (a PostgreSQL db-name) which, in the SQLite dev compose, became the SQLite **file path** — SQLite tried to open a bare file on the read-only container rootfs and retried 9× per boot. The dev compose now forwards a blank `DATABASE_NAME` default (matching production), `.env.example` documents it as PostgreSQL-only, and env-validation rejects a bare SQLite name with a clear boot error. [#677] [#680]
- **`DATABASE_TYPE=postgres` combined with `DATABASE_SYNCHRONIZE=true` is now rejected at boot.** On PostgreSQL the data connection runs migrations every boot, so `synchronize` immediately dropped the search migration's generated `body_ts` column and broke `/search` (501) on every restart; the misconfigured combination now fails fast. [#680]
- **Resolved internal IPs are no longer leaked in SSRF-block error messages.** The webhook test response, delivery-failure/DLQ `lastError`, `webhook:error` hook payloads, and plugin-download errors now show a generic message instead of the resolved internal address (which was a server-side-recon oracle). The full detail is still logged server-side. [#680]
- **`STORE_EPHEMERAL_MESSAGES=false` is now honored on Baileys history backfill.** Previously only the live inbound path enforced the opt-out, so disappearing-message history was silently persisted + indexed on every connect/reconnect despite the operator's opt-out. [#680]
- **Plugin archive extraction is bounded and fails clean.** Per-entry and aggregate actual extracted bytes are now capped (a lying `size=0` header can no longer inflate unboundedly), and a corrupt/oversized archive returns a 400 instead of an uncaught 500. [#680]
- **WebSocket auth lifecycle.** IP-restricted API keys can now connect from an allowed IP (previously the gateway failed-closed and locked out every IP-restricted key), and a revoked/disabled key's active sockets are now evicted. [#680]
- **Misc hardening.** The migration CLI honors `MAIN_DATABASE_NAME`; `secret-file` chmod failures are logged (a world-readable secret file no longer stays silent after a rewrite on a chmod-unsupported FS); the fully-expanded IPv4-mapped-loopback SSRF classifier gap is closed (latent, defense-in-depth); storage file-list/export traversal is now async + bounded (no longer blocks the event loop); the dashboard and all four SDKs warn on a non-localhost `http://` `baseUrl`. [#680]

## [0.8.13] - 2026-07-09

### Added

- **Dashboard search panel.** The Chats page now has a global search bar in its header — type to search messages across all sessions, see results with highlighted snippets in a dropdown, and click a result to jump to that message in its chat (with cross-session navigation and best-effort message scrolling). Includes a scope toggle (all sessions / current session), load-more pagination, and graceful error states (incl. "search unavailable" when search is disabled). The snippet renderer is XSS-safe (escape-then-highlight, never `dangerouslySetInnerHTML`). Search UI strings are localized across all 10 supported locales.
- **SDK search resources.** The JavaScript, Python, PHP, and Java SDKs now expose a `search` resource mirroring `GET /api/search` — `client.search.search({ q, sessionId?, chatId?, … })` → `SearchResults`. Typed params and results match the backend contract exactly.

## [0.8.12] - 2026-07-08

### Fixed

- **Debian Chromium SIGTRAP crash in Kubernetes.** The `Dockerfile` previously installed the OS-level `chromium` package from Debian 12. When run as a non-root user in strict Docker/Kubernetes environments, this package consistently crashed at startup with `Code: null` and `Trace/breakpoint trap (core dumped)`. On amd64 the `Dockerfile` now downloads **Chrome for Testing** via Puppeteer during the build phase (avoiding the Debian package's SIGTRAP); arm64 keeps Debian's `chromium`, since Chrome for Testing publishes no linux-arm64 build. Both resolve to a single `PUPPETEER_EXECUTABLE_PATH` symlink. This resolves the persistent browser launch failures on restricted environments without requiring insecure workarounds like `--no-zygote` or disabling Seccomp/AppArmor. Thanks @muhfalihr.

### Added

- **Global message search across sessions.** `GET /api/search` finds messages across all sessions through an open `SearchProvider` contract, with a built-in database full-text provider (PostgreSQL `tsvector`/`GIN`, SQLite `FTS5`) as the zero-dependency default — no external service required. Search works out of the box on both SQLite and PostgreSQL and survives repeated dialect switching and export/import round-trips; a non-FTS5 SQLite build skips the index gracefully and the route returns `501` instead of crashing boot. Set `SEARCH_ENABLED=false` to disable the route and module entirely (the index is DB-maintained per-write regardless, at negligible in-process cost). Advanced backends (typo-tolerance, CJK word-segmentation, large-scale relevance) will be available as provider plugins.
- **`message:persisted` plugin hook.** A new general extension point fired when a message is durably persisted — on outbound send (from `MessageService`) and on inbound receive (from `SessionService`, where both engine adapters converge on the single persist) — so plugins can react to persisted messages (e.g. an external search indexer) without coupling to the message/session services. The built-in FTS search provider is DB-synced and does not consume this hook; it exists for plugin providers and general use. Fire-and-forget: a handler error is swallowed and never breaks the send/receive path.
- **Redis authentication via username.** Added support for `REDIS_USERNAME` to configure the Redis cache connection and BullMQ queue connections that require a username. Thanks @muhfalihr.
- **OpenAPI/Swagger snapshot export + enriched, auth-accurate API docs.** The published spec (served at `/api/docs` and exportable via `scripts/export-openapi.ts`) now mirrors the runtime auth model: `@Public()` routes (`/api/health*`, `/api/infra/health`, and the integration ingress wildcard) are marked as not requiring an `X-API-Key`, matching what the `ApiKeyGuard` actually enforces. The `webhook` `events` enum now advertises the `*` subscribe-all wildcard the dispatch layer already honors, and request/response schemas are filled in across the catalog, status, stats, integration-instance, and auth endpoints — notably typing the integration `InstanceView` (and its `IngressUrl` entries) as real schemas so generated clients no longer receive opaque objects. The export script pins a hermetic environment (in-memory SQLite, queue/MCP off) so it is safe to run anywhere without touching a real database or opening a Redis connection.

## [0.8.11] - 2026-07-08

### Added

- **Prometheus counter for terminally-failed webhook deliveries.** `/api/metrics` now exposes `openwa_webhook_delivery_failures_total`, incremented once per delivery that exhausts all its retries (mirroring the durable `webhook_delivery_failures` dead-letter record, on both the queued and the queue-disabled direct path). It is an in-process monotonic counter — cheap, real-time, and resetting only on restart, which Prometheus `rate()`/`increase()` treat as a normal counter reset — so a `COUNT(*)` over the retention-pruned failure table isn't queried per scrape. Operators can now alert on webhook failure rate from the scrape instead of tailing the structured log or querying the dead-letter endpoint.

### Changed

- **Runtime feature flags are centralized in the config layer.** `AUTO_START_SESSIONS`, `STORE_EPHEMERAL_MESSAGES`, `RESOLVE_LID_TO_PHONE`, `SIMULATE_TYPING`, and `SIMULATE_TYPING_MAX_MS` now resolve through a single discoverable `features.*` namespace on `ConfigService` (backed by one `computeFeatureFlags()` source of truth) instead of ad-hoc `process.env` reads scattered across the session and message services. Runtime behavior and defaults are unchanged. The four boolean flags are now validated at boot alongside the existing `QUEUE_ENABLED`/`MCP_ENABLED`/`SERVE_DASHBOARD` checks — ⚠️ **behavior change:** a deployment booting one of them with a non-canonical value (e.g. `SIMULATE_TYPING=1`, `AUTO_START_SESSIONS=yes`) will now fail fast naming the offending key until corrected to `true`/`false`/unset, instead of silently falling back to the default.
- **Coverage floors added for the session, webhook, and hook-manager modules.** Per-directory Jest `coverageThreshold` entries now guard `src/modules/session`, `src/modules/webhook`, and `src/core/hooks` (set just below measured, matching the ratcheted floors already in place for the security, auth, engine-adapter, and integration modules), so a large deletion of these modules' tests fails CI instead of passing under the softer global gate.

### Fixed

- **Inbound integration (ingress) deliveries now retry with backoff instead of failing on the first error.** A queued ingress job was enqueued with no retry policy, so BullMQ ran a single attempt and a transient plugin-handler error (e.g. a 5xx from the sandbox) went straight to the dead-letter table — asymmetric with the webhook queue, which already retries. Ingress jobs now use bounded exponential-backoff retries (default 3 attempts, 5s base delay; configurable via `INGRESS_MAX_ATTEMPTS` and `INGRESS_RETRY_DELAY_MS`), and the dead-letter write still fires exactly once, only after the retries are exhausted. ⚠️ **Ordering caveat:** the per-conversation ordering lock guarantees no two same-conversation dispatches run concurrently, but a retried delivery re-enters the lock after its backoff and can therefore overtake a same-conversation successor that dispatched during the backoff window. Ingress order is best-effort regardless (the provider delivers over unordered HTTP); order-strict plugins must not assume a retried event still arrives in sequence. This trades strict order for throughput — BullMQ releases the worker slot during backoff, where retrying inside the lock would hold it.
- **`/infra/status` now actively probes the databases (`SELECT 1`) instead of trusting `isInitialized`.** The Infrastructure panel's database tile read only `DataSource.isInitialized`, which stays `true` after a PostgreSQL backend dies (until an explicit `.destroy()`), so the tile showed the database healthy while it was actually down. The endpoint now runs a short, timeout-bounded `SELECT 1` on both connections — the same probe `/health/ready` uses — so a post-init outage is reflected. SQLite is effectively always up, so this only changes behavior for a genuinely-down external PostgreSQL.
- **The settings panel reports the real docs and base-URL configuration.** `GET /settings` hardcoded `enableDocs: true` (ignoring `ENABLE_SWAGGER`, so it claimed the API docs were enabled in production where they are disabled by default) and an `http://localhost:<port>` `apiBaseUrl` (ignoring the operator's configured `BASE_URL`). Both now reflect the real values, and `autoReconnect` reports the engine's actual default (on) rather than a hardcoded `false` for a config key that never existed.
- **A reaction no longer clobbers a message's delivery status.** `applyReaction` read the full message row, mutated its `reactions` metadata, then wrote the whole row back — so a delivery ack (`SENT`→`DELIVERED`/`READ`) that committed in the window between that read and write was overwritten with the stale status, permanently regressing the message's state until another ack happened to arrive. The reaction now writes only the `metadata` column via a scoped `UPDATE` keyed on `(sessionId, waMessageId)`, so it can never touch `status` (acks and reactions update disjoint columns). The existing per-message serialization for concurrent reactions is unchanged.
- **`PUT /infra/config` returns the real HTTP status for a rejected configuration.** A validation failure (an unknown engine type, or a value carrying a newline that would inject an extra env var) was caught and returned as HTTP 200 with `{ saved: false }`, so a client branching on the status code alone treated a rejected save as success. Such validation errors now surface as their real 4xx (`BadRequestException`); a genuine persistence fault (e.g. a disk/permission error while writing the env file) still returns `{ saved: false }` with 200, preserving the dashboard's `body.saved` handling.
- **Deleting a session no longer orphans its webhooks, templates, or stored Baileys messages on SQLite.** `webhooks`, `templates`, and `baileys_stored_messages` declare an `ON DELETE CASCADE` foreign key to `sessions`, but the default `data` engine (SQLite) runs with `foreign_keys` OFF, so that cascade never fired — a session delete removed only the session, `messages`, and `message_batches` rows and left the rest behind indefinitely (orphaned `webhooks` rows in particular retain their signing secret and any custom headers). `delete()` now removes all CASCADE-FK child rows explicitly inside the same transaction (children before the parent), which is engine-agnostic — redundant-but-harmless on PostgreSQL, where the real cascade already handles it — and mirrors the ordering the data-restore path already uses.
- **The `message:sending` moderation gate and `message:failed` notification now cover every outbound path.** Both hooks were wired only into the text `sendText` method, so a plugin registered on `message:sending` (the canonical pre-send moderation/compliance gate) saw no image/video/audio/document/sticker/location/contact/poll/reply/forward send and no bulk send at all, and a `message:failed` plugin saw only text-send failures. Every single sender now passes through a shared pre-send gate (a plugin can block or rewrite the payload) and a shared failure emitter, and `BulkMessageService` runs the same per-message gate (a block fails just that message, honoring `stopOnError`) and emits `message:failed` on a failed batch item. ⚠️ **Behavior change:** a `message:sending` plugin now receives — and can block/modify — media, extended, and bulk sends it previously never saw; the hook payload carries a `type` discriminator (`image`/`video`/`poll`/`reply`/… ) so a handler can scope its logic per send type, and its `error` field is sanitized so an SSRF-blocked media fetch does not expose the resolved internal address to plugins. A moderation block on a bulk item fails just that item (honoring `stopOnError`) without emitting `message:failed`, matching single-send where a block is a client error, not a delivery failure. `message:sent` is unchanged (still emitted once from the engine `message_create` path).
- **Sibling webhooks subscribed to the same event now get distinct idempotency keys.** The per-event idempotency key was derived only from the event and its payload, so two _different_ webhook endpoints registered for the same event on the same session received an identical `X-OpenWA-Idempotency-Key`. A receiver sitting behind both (or a shared dedup store) could drop the second endpoint's delivery as a replay of the first. The key is now salted with the destination webhook's id, so each endpoint is dedup'd independently while retries of the _same_ delivery (including the queue-add→direct fallback) keep their stable key.
- **A session with auto-reconnect turned off no longer reports "reconnection failed after 0 attempts".** When a disconnect fired with the reconnect budget set to `0` (auto-reconnect disabled), the session was marked `FAILED` with the exhausted-retries message and a count of `0` — implying a retry loop had run and failed rather than a feature that is simply off. That case now records an explicit "Auto-reconnect is disabled" reason; the genuine exhausted-retries message (with its real attempt count) is unchanged.
- **A failed inbound integration (ingress) delivery is no longer silently dropped on the inline path.** With the queue disabled (or Redis unreachable), an ingress delivery is dispatched inline; if the plugin handler threw, the error was swallowed and the event was stranded — the provider had already received its `202`, and the redrive tooling only scans the dead-letter table, which never got a row. The inline path now persists a dead-letter record (the same shape the queued path writes on its final failed attempt), so the event is redrivable. The write is best-effort: a failure to persist it is logged but never turns the `202` into a `5xx` (the delivery is already dedup-persisted, so the provider won't re-send).
- **Plugin instance session bindings are re-derived on startup, so a binding lost while the plugin was momentarily unloaded self-heals.** Provisioning a plugin instance mirrors its config into the plugin runtime (per-session config + activation) so an ingress handler resolves the right `ctx.config`; if the plugin happened to be unloaded at that moment the bridge was skipped (only an INFO audit), leaving the instance marked enabled but resolving base config only — previously recoverable only by re-saving the instance. A boot-time reconciliation now re-applies every enabled instance's binding from the persisted `plugin_instances` rows (honoring each row's real `enabled` flag), so a restart restores it. The binding logic moved into a dedicated service shared by provisioning and the reconciler.
- **Deleting a session now purges its on-disk engine auth directory.** `DELETE /sessions/:id` tore down the running engine and removed the database rows but left the engine's persistent auth store behind (`data/baileys/<name>` for the Baileys engine, `data/sessions/session-<name>` for whatsapp-web.js) — these are keyed by session **name** and live independently of any engine instance, so recreating a session under the same name reloaded stale credentials. The delete now removes that directory too (best-effort, keyed by name, guarded against path traversal, and correctly a no-op when the session was already stopped and had no live engine). Thanks @m7fz7.

## [0.8.10] - 2026-07-07

### Added

- **PostgreSQL schema selection via `POSTGRES_SCHEMA`.** OpenWA's tables and the TypeORM migration ledger can now be placed in a dedicated Postgres schema (default `public` preserves historical behavior). Set `POSTGRES_SCHEMA` to isolate OpenWA from other apps sharing a database, or to use a managed-Postgres project schema. The schema must already exist (the built-in container creates it; for external Postgres run `CREATE SCHEMA <name>;` once). SQLite ignores this setting. The dashboard Infrastructure page exposes the field, and the environment variable is validated as a legal, non-reserved Postgres identifier at boot.

### Changed

- **OpenAPI/Swagger tag hygiene.** Every controller tag is now declared in the API document (ten were used but undeclared), the three Integration Fabric controllers gained `@ApiTags`, and the tag casing is uniform — so `/api/docs` groups every endpoint under a described tag instead of leaving some ungrouped.
- **Graceful shutdown now drains on `SIGTERM`/`SIGINT`** (rolling deploys, `docker stop`, Ctrl+C), not just on the admin restart endpoint. On a termination signal the app flips readiness to `503` immediately so a load balancer/orchestrator stops routing, keeps serving in-flight requests for a bounded grace window, then tears down and exits deterministically. ⚠️ **Behavior change:** a `docker stop` / redeploy now takes up to the grace window (`SHUTDOWN_DELAY_MS`, default **3s** in production, **0** in dev) plus teardown instead of tearing down instantly, and the process now exits `0` on a clean signal. In Docker set `stop_grace_period` ≥ `SHUTDOWN_DELAY_MS` + your worst-case teardown (the bundled compose now sets `45s`); for Kubernetes set `terminationGracePeriodSeconds` accordingly. A second signal during the drain forces an immediate exit. The whatsapp-web.js engine no longer lets Puppeteer install its own signal handlers (which previously killed Chromium at signal time / `exit(130)` before the drain could run).
- **The bundled Docker Compose stack pins its `docker-socket-proxy` and `minio` images to explicit tags** (they were on `:latest`) for reproducible, non-drifting deploys, and a Dependabot `docker` ecosystem was added so base and stack images keep receiving update PRs. A Node `>=22` `engines` floor + `.nvmrc` were declared, and the transitive install-time Scarf telemetry (via `swagger-ui-dist`) is disabled.

### Fixed

- **The Integration Fabric now works on PostgreSQL.** `conversation_mappings` and `integration_delivery_failures` declared `@PrimaryGeneratedColumn('uuid')` ids but their columns were created without a Postgres `DEFAULT gen_random_uuid()`, so on PostgreSQL every first insert failed with a `NOT NULL` violation on `id` — breaking the plugin conversation-mapping upsert (e.g. the Chatwoot handover) and the ingress dead-letter write. SQLite was unaffected because its driver mints the uuid client-side, which is why it went unnoticed. A forward-only migration adds the default (no-op on SQLite). A new CI job now applies the full migration chain against a real PostgreSQL and asserts every generated-uuid primary key has a database default, so this dialect gap can't recur.
- **Indexed `webhooks.sessionId`.** The webhook dispatch path looks up a session's active webhooks by `sessionId` on every emitted event, so on a busy session this was a full table scan of the `webhooks` table per event (the foreign-key column carried no index). A cross-dialect index migration — plus the matching entity index — makes the lookup index-backed.
- **Boot now rejects a non-canonical boolean feature flag instead of silently disabling the feature.** `QUEUE_ENABLED`, `MCP_ENABLED`, and `SERVE_DASHBOARD` are read with an exact `=== 'true'` / `!== 'false'` comparison, so a typo (`True`, `1`, `yes`) or a stray trailing space/CR (a Windows-edited env file forwarded verbatim by `docker run --env-file`) silently (dis)abled the feature with zero diagnostics. These are now validated at startup and boot fails fast naming the offending key. ⚠️ **Behavior change:** a deployment currently booting with such a value (e.g. `QUEUE_ENABLED=1`) will now refuse to start until corrected to `true`/`false`/unset — including `SERVE_DASHBOARD=0`/`no`, which was silently serving the dashboard and will now correctly disable it once set to `false`.
- **A fatal uncaught exception is now written to the structured log** (with its stack and origin) before the process exits, instead of only a raw stack on stderr that the log pipeline missed. This is observe-only: the crash-and-restart posture is unchanged (the container restart policy still fires and the process never continues on corrupted post-exception state).
- **`POST /infra/import-data` no longer swallows a genuine database error while clearing tables.** The table-clearing step tolerated only a genuinely-absent table but previously used a blanket catch, so an I/O/lock error (or an aborted transaction) could let a restore commit a _merged_ rather than _replaced_ dataset on SQLite. Such errors now surface and roll the whole import back (a real fault returns a `500` carrying the actual cause); the intended tolerance for a missing table is preserved.
- **A session no longer schedules a reconnect while the process is shutting down** — a disconnect during the drain window would otherwise launch a fresh Chromium racing the shutdown teardown. The session is left `DISCONNECTED` (a later start / auto-restore re-initializes it cleanly).
- **Documentation & config accuracy.** `.env.example` now documents `PORT` (the port the app binds to on bare metal) distinctly from the Compose-only host-published `API_PORT`, and adds the `QUEUE_ENABLED`/`CACHE_ENABLED` toggles. `SECURITY.md`'s supported-versions table and the Java SDK install snippets are refreshed to the current releases. The unused `uuid`/`@types/uuid` dependency was removed, and stale "not yet wired" comments on the plugin ingress-manifest validation (which the loader has called since it shipped) were corrected.
- **The bundled Docker Compose stack no longer kills Chromium mid-spawn under multi-session `whatsapp-web.js` workloads (#636).** The per-container `pids_limit` shipped at `512` since the `#243` hardening pass — a fork-bomb guard chosen without accounting for Chromium's multi-process model. `whatsapp-web.js` runs a full Chromium instance per session (browser + renderer + GPU + zygote + utilities), and WhatsApp Web is itself process-heavy, so ~4 concurrent sessions already approached 512 and the next session's Chromium was killed mid-spawn when `fork()` returned `EAGAIN` — surfacing in the API as a `Failed to launch the browser process: Code: null` launch failure with no useful log (the dbus/crashpad noise in the log is non-fatal). The default is now `2048` (fits ~8–10 sessions with startup-spike headroom), exposed as `OPENWA_PIDS_LIMIT` for larger fleets. The limit is a cgroup `pids.max` ceiling, not an allocation — raising it is a no-op for light containers, so this is safe for the `baileys` engine (single-process, no Chromium, a handful of PIDs regardless). The fork-bomb guard stays finite (`-1`/unlimited is explicitly discouraged). A new troubleshooting entry distinguishes the three causes of `Code: null` (PID exhaustion vs OOM-kill vs the XDG/crashpad crash already fixed earlier), since the cause isn't visible in the log without `docker stats` / `dmesg`.

## [0.8.9] - 2026-07-06

### Changed

- **Dashboard `<select>` elements replaced with a custom dropdown component.** The "All Status" filter (Sessions), "All Severities" filter (Logs), and language picker (Login) now use a reusable `CustomSelect` component that matches the dashboard design system with proper dark/light theming, keyboard navigation (arrows, Home/End, type-ahead, Escape), and responsive behavior. Focus returns to the trigger on close, matching native `<select>` semantics. Thanks @haseeblodhi1899.
- The **"Install a plugin" modal is wider on desktop** (480px → 680px) to give the plugin catalog list more room, while still collapsing to a full-width bottom sheet on small screens.
- **Webhook delivery-failure records are pruned on a retention window.** `webhook_delivery_failures` is an append-only log written on every terminally-failed delivery, so under a receiver outage it grew without bound. It is now pruned to `WEBHOOK_FAILURE_RETENTION_DAYS` (default 90; set `<= 0` to disable) once at startup and daily, mirroring the existing audit-log retention.

### Fixed

- **A malformed session id now returns `400` instead of a `500` on PostgreSQL.** The session routes validate the `:id` path param as a UUID at the boundary, so a non-UUID id (a typo or path fuzzing) is rejected with a clean `400` rather than reaching the `uuid` primary-key column and raising an uncaught cast error that surfaced as a generic `500` — a divergence that only appeared on PostgreSQL (SQLite treated the id as text and returned `404`).
- **Baileys API sends now emit `message.sent`** (parity with the whatsapp-web.js engine). The wwjs engine fires this for the account's own sends; the Baileys engine's own socket-sends echo back only as a skipped history-sync upsert, so `message.sent` webhooks / WebSocket events / the `message:sent` hook never fired for Baileys API sends. They now fire for text and every media/location/contact/poll/reply/forward send (reactions and deletes excluded).
- **Config & reliability hardening.** `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_IDLE_TIMEOUT_MS`, and `DATABASE_CONNECTION_TIMEOUT_MS` are validated at boot — a typo previously reached the config layer as `NaN` and broke the PostgreSQL pool. An unparseable `BODY_SIZE_LIMIT` no longer silently disables the request body-size cap (it falls back to the 25 MB default). The channel-messages endpoint no longer forwards `NaN` to the engine on a non-numeric `?limit`. The fire-and-forget session-row writes in the engine callbacks now handle a transient DB fault instead of surfacing an unhandled rejection, and a set of engine-adapter warning logs no longer mislabel their component name.
- **A terminally-failed or un-reinitializable session no longer strands its browser process or wedges at "already started".** When an engine reports a terminal error, and when a reconnect attempt's re-initialization throws, the dead or half-built engine is now evicted from the session registry and its Chromium process is force-killed instead of being left in place — previously it kept holding a concurrency slot and caused a later start to be rejected as already running. Deleting a session likewise force-kills its browser (rather than a graceful close that could hang on a wedged Chromium and orphan the process).
- **The dark theme now covers every dashboard surface.** A number of components used hardcoded colors instead of the theme's CSS variables, so several surfaces stayed light in dark mode — most visibly the Infrastructure "Database Migrations" card, plus status/severity badges, toasts, danger-hover states, and toggle tracks across most pages. They now use the theme tokens (and translucent semantic fills) so they follow the active theme in both light and dark. A new `--info` token themes the blue badges (permission, SQLite, info logs, qr-ready pill) that previously had no theme-aware color, and the root `<html>` background no longer stays white when the dark theme is selected on a light-OS device (visible on overscroll).

## [0.8.8] - 2026-07-05

### Added

- **Native WhatsApp polls** via `POST /api/sessions/:sessionId/messages/send-poll`: question, 2–12 options and an optional `allowMultipleAnswers` flag (default single choice), implemented on both engines (whatsapp-web.js `Poll`, Baileys `poll` content with `selectableCount` 1/0). The message history stores the poll question as the body so the log stays readable. Polls are a first-class `poll` message type end to end — both engines map incoming poll messages to it, so the websocket/webhook events, persisted rows, and dashboard all report `poll` consistently. Thanks @alejo117.

### Changed

- Corrected the Italian login-footer wording. Thanks @albanobattistella.

### Fixed

- **`GET /api/sessions/:sessionId/channels/:channelId/messages` always returned an empty array** on the whatsapp-web.js engine (#625). The adapter called `client.getChannelById()`, which does not exist in whatsapp-web.js 1.34.x, so every call threw and the error was swallowed into `[]`. Channel messages are now read from the subscribed `Channel` instance (via `getChannels()`), and an unknown/unsubscribed channel returns a `404` (`ChannelNotFoundError`) instead of a silent empty `200` — matching `GET /channels/:channelId`. Thanks @Header9968.
- **A session whose `engine.initialize()` fails no longer orphans its browser process.** The crash-recovery path in `SessionService.start()` was tearing down the half-built engine with a graceful `destroy()`, but a failed `initialize()` usually means the underlying browser/CDP connection is already broken (e.g. a `TargetCloseError: Target closed` mid-injection) — `destroy()` has nothing live to talk to, so it could only time out after 10s via `teardownEngineSafely`'s race, leaving the Chromium process alive and orphaned. Every such crash left one more orphaned process behind, eventually starving the host of memory. It now uses `forceDestroy()` (the same SIGKILL-the-process recovery `POST /:id/force-kill` uses), since a failed initialize is the same "possibly-unreachable engine" state that exists for.
- **Authenticated HTTP/HTTPS proxies now work** on the whatsapp-web.js engine (#628). Credentials were passed inside `--proxy-server`, which Chromium ignores, so a proxy with a username/password never authenticated (only IP-authorized proxies worked). The username/password are now handed to whatsapp-web.js's `proxyAuthentication` (which drives Chromium's `page.authenticate`) while `--proxy-server` gets a credential-less URL. SOCKS proxies still cannot be authenticated — Chromium does not support SOCKS proxy authentication at all — so a SOCKS proxy carrying credentials now logs a clear warning instead of failing with an opaque navigation timeout. Thanks @gudge25.

## [0.8.7] - 2026-07-03

### Added

- **Plugins can canonicalize a chat id** via a new `ctx.engine.canonicalChatId(sessionId, chatId)` capability, gated by the `engine:read` permission like the other engine reads. It resolves a `@lid` privacy id to its stable `<phone>@c.us` form when the mapping is known (best-effort; an unresolved id passes through), letting a plugin key a chat by one identity across WhatsApp's `@lid` migration. This is the host-side prerequisite for an adapter to keep a contact's conversation from splitting when they migrate to `@lid`. (#615)

## [0.8.6] - 2026-07-03

### Fixed

- **The `engine.getChatHistory` plugin capability (added in 0.8.5) now reaches sandboxed plugins.** It was wired only into the host-side context, not the plugin-worker bridge, so a sandboxed plugin's `ctx.engine.getChatHistory` was `undefined` and the call failed silently. It is now bridged through the worker capability + router like the other engine reads. Historical messages from the whatsapp-web.js engine also carry location coordinates and quoted-message references now, matching the live message path (previously a backfilled location rendered empty and replies lost their thread link). (#609)

## [0.8.5] - 2026-07-03

### Added

- **Plugins can read recent chat history** via a new `ctx.engine.getChatHistory(sessionId, chatId, limit?, includeMedia?)` capability, gated by the `engine:read` permission and the plugin's active-session scope like the other engine reads. The limit is clamped host-side (max 100), and both message directions are returned. This is the host-side prerequisite for an adapter to backfill prior conversation context. (#609)

## [0.8.4] - 2026-07-03

### Added

- **`CSP_UPGRADE_INSECURE_REQUESTS` env var** to control the CSP `upgrade-insecure-requests` directive. It defaults to the existing behaviour (on in production, off elsewhere); set it to `false` for an HTTP-only deployment on a trusted private network, where the browser would otherwise upgrade the dashboard to `https` and make it unreachable. Set it to `true` to force it on. (#611)

## [0.8.3] - 2026-07-03

### Added

- **Plugins can send WhatsApp voice notes through `ctx.conversations.send`.** A new `voice` envelope type sends the media at `mediaUrl` as a PTT voice note (audio bubble with waveform) rather than a plain audio file — the host maps it to an audio send with `ptt` set, which defaults the codec to `audio/ogg; codecs=opus` and classifies the message as `voice`, matching inbound classification. It rides the same `conversation:send` permission and activated-session scope as the other media types. (#607)

## [0.8.2] - 2026-07-03

### Added

- **Plugins can send media through `ctx.conversations.send`.** The conversation-send capability now accepts `image`, `video`, `audio`, and `file` envelopes that carry a `mediaUrl`, sending them by URL through the same media pipeline as the REST media endpoints (the caption comes from `text`). It stays under the existing `conversation:send` permission and the plugin's activated-session scope — the text/reply behavior is unchanged. A `replyTo` on a media envelope is rejected, since the engine media path cannot quote a message.
- **Official Java SDK (`com.rmyndharis:openwa`).** A hand-written, synchronous Java 17 client covering the full REST surface — all 12 resources (sessions, messages, contacts, groups, webhooks, chats, labels, channels, catalog, status, templates, health) plus API-key validation — with typed request builders, immutable response records, a typed error hierarchy, and an injectable HTTP transport for testing. One runtime dependency (Gson); published to Maven Central as `com.rmyndharis:openwa:0.1.1`. Lives in `sdk/java` and is drift-tested against the backend DTOs like the JavaScript, Python, and PHP SDKs. (#602)

## [0.8.1] - 2026-07-02

### Changed

- ⚠️ **The WebSocket handshake no longer accepts the API key via the `?apiKey=` query string.** A key in the URL leaks into proxy and access logs. The handshake now accepts the key only via the Socket.IO `auth.apiKey` field (recommended) or the `X-API-Key` header. **Migration:** if a client connected with `io(url + '?apiKey=...')`, switch to `io(url, { auth: { apiKey } })` or send the `X-API-Key` header. (#601)
- ⚠️ **The MCP server now defaults to read-only.** Write (state-changing) tools are exposed only when `MCP_READONLY=false` is set explicitly; previously an unset `MCP_READONLY` defaulted to read-write, so enabling `MCP_ENABLED` silently exposed message-send and group tools. **Migration:** set `MCP_READONLY=false` to keep write tools available to MCP callers. (#601)

### Security

- **SSRF rejection messages no longer disclose the resolved internal IP address.** A blocked outbound URL (media-by-URL send, webhook registration) returned the guard's raw message, which named the internal address it resolved to — a reconnaissance oracle. The client now receives a generic message and the detail is logged server-side only. (#595)
- **Imported session names are validated against path traversal.** A session name becomes the engine's on-disk auth-directory key, and the data-import path bypassed the normal validation, so a crafted name could escape the intended directory. Session-name safety is now enforced at the engine sink for every code path, and the importer skips (with a warning) any unsafe name. Save-config and storage-export responses also return relative paths instead of absolute host paths. (#598)
- **Plugin capability calls are confined to the sessions a plugin is activated for.** Capability calls (send, engine reads, conversation send, handover, mappings) were gated only by the plugin's static manifest scope, so a plugin activated for one session could act on another. They now also honor the operator-set per-session activation. Plugin `net.fetch` is additionally bounded by a global concurrency limit so many concurrent fetches can't exhaust host memory. (#594)
- **Inbound-webhook signature verification and config-secret handling hardened.** The HMAC signed content is reconstructed without interpreting `$`-substitution sequences (a body containing one no longer fails verification), the challenge token is compared in constant time, plugin config-secret redaction fails closed when a schema is unavailable and masks nested secrets, and a masked secret round-tripped from the UI no longer overwrites the stored value. (#592, #593)
- **Rejected WebSocket authentication attempts are now audited** with the same event the REST guard emits, so credential probing over the WebSocket surface leaves a forensic trail. (#601)

### Fixed

- **Inbound-webhook (Integration Fabric) idempotency and delivery durability.** The dedup key now includes the plugin id (two plugins sharing an instance id no longer drop each other's deliveries); a delivery with no dedup header derives a deterministic id instead of a random one (so a provider retry dedups rather than duplicating a WhatsApp send); a redrive keeps a DLQ row redrivable when an inline dispatch is swallowed rather than marking it handled; and the conversation-mapping upsert is race-safe. (#591)
- **Disappearing-chat (ephemeral) inbound messages on the Baileys engine.** Location coordinates are no longer dropped for an ephemeral location message, and ephemeral/view-once-wrapped messages in a history sync now map to their real type and body instead of an empty "unknown". (#596)
- **A failed engine start no longer wedges a session.** If engine initialization fails, the half-built engine is now torn down and evicted instead of being left behind holding a concurrency slot and blocking restarts. Creating a session whose name loses a race to an identical one returns 409 Conflict instead of a 500, and bulk send now caps the number of concurrently-processing batches held in memory (`BULK_MAX_CONCURRENT_BATCHES`). (#600)
- **PostgreSQL boot on managed instances.** The UUID-defaults migration no longer runs `CREATE EXTENSION pgcrypto` unconditionally — it is a core built-in on PostgreSQL 13+, and requiring the extension crash-looped startup on managed databases where the role can't create it. The extension is now touched only on PostgreSQL ≤ 12, with a clear error if it's genuinely needed and unavailable. (#599)
- **The migration CLI works again.** The data-source module exported two `DataSource` instances, which the TypeORM CLI rejects, breaking every `migration:*` command. (#590)

## [0.8.0] - 2026-07-02

### Added

- **Integration Fabric: provision and connect external services to WhatsApp sessions.** ADMIN operators can mint per-plugin instances — one per external account — through a provisioning API and a new dashboard **Instances** tab, each with its own HMAC-verified inbound webhook endpoint, operator-set secret, and per-session configuration. Integration plugins gain the capabilities needed to build a two-way bridge: `ctx.registerWebhook` to receive that inbound traffic, `ctx.mappings` to correlate a WhatsApp chat with an external conversation, a session-and-chat-scoped handover gate so a chat handed to a human is withheld from the owning plugin while the bot and other plugins still receive it, and `net.allowConfigHosts` to permit an outbound request to a host drawn from the instance's own configuration. This is the foundation for provider adapters. (#568, #570, #571, #575, #585, #587, #588, #589)

### Fixed

- **Replying to and forwarding to a LID-migrated contact no longer fail with HTTP 500 on the whatsapp-web.js engine.** These paths sent to the phone id (`@c.us`) like the original send bug (#573), so a contact WhatsApp had migrated to `@lid` rejected them with `No LID for user`. They now resolve the recipient the same way as a normal send (including the self-heal retry), and a forward reads back its delivered id from the resolved chat so delivery status still reconciles. (#583)
- **The typing/presence endpoint no longer returns HTTP 500 on the Baileys engine when a presence update fails.** Presence is best-effort; a failure (e.g. `No LID for user` for a migrated contact) is now caught and logged at `WARN` and the request succeeds, matching the whatsapp-web.js engine. This also covers the presence agent tool. (#583)
- **Chat history for a LID-migrated contact is no longer split across two entries on the whatsapp-web.js engine.** The engine now records the `phone ↔ lid` mapping it learns (when resolving a send, and when resolving an inbound `@lid` sender's number), so the messages API bridges a contact's `@c.us` and `@lid` rows into one conversation — previously only the Baileys engine populated this mapping. (#583)
- **The dashboard chat list no longer refetches on every message sent to a LID-migrated contact.** The outgoing echo can arrive addressed as `@lid` while the open chat is `@c.us`; the sent message is already shown via the send response, so the sidebar no longer triggers a full reload for an outgoing echo with no matching chat. (#583)

## [0.7.20] - 2026-07-02

### Fixed

- **Sends to a LID-migrated contact no longer intermittently fail with HTTP 500 on the whatsapp-web.js engine.** The v0.7.19 fix resolves such a contact's phone id to its `@lid` before sending, but that resolution is a WhatsApp Web round-trip that occasionally throws an internal error — in which case the send fell back to the phone id and hit `No LID for user` again, so the message tester (and the API) still returned a 500 now and then. The engine now caches each contact's confirmed resolution for the session (both a migrated `@lid` and a confirmed non-migrated `@c.us`), so a later flaky resolution reuses the known-good id and ordinary contacts are not re-probed on every send. If a send still fails with `No LID for user` — e.g. a contact that migrates mid-session — the engine drops the stale mapping, re-resolves once, and retries. (#580) Thanks @lexcorp.
- **The typing indicator no longer logs a misleading `ERROR` when sending to a LID-migrated contact.** The best-effort "typing…" presence step is already caught and never affects the send, but a failed attempt (`No LID for user`) was logged at `ERROR`, which read as a fault even though nothing broke. It now logs at `WARN` and the typing target is resolved the same way as the send. (#582) Thanks @lexcorp.

## [0.7.19] - 2026-07-02

### Added

- **Business messages WhatsApp masks on linked devices are now surfaced as a `masked` type instead of an empty bubble.** For some high-security business messages (e.g. enterprise OTPs), WhatsApp delivers only a bodyless placeholder to linked/companion devices — the actual text is withheld by design and is only readable on the primary phone. On the Baileys engine these previously arrived as `type: "unknown"` with a blank body, which looked like a parsing bug. They are now classified as `type: "masked"` (with an empty body) so the API, webhooks, and filters can distinguish them, and the dashboard shows a short notice explaining the message is only available on the primary phone. (#574) Thanks @crossgg.

### Fixed

- **Sending to a contact WhatsApp has migrated to LID addressing no longer fails with HTTP 500 on the whatsapp-web.js engine.** WhatsApp has begun addressing some individual chats by privacy id (`@lid`) instead of the phone-number WID (`@c.us`); for those contacts whatsapp-web.js rejected the send with `No LID for user`, which surfaced as a 500 (and as a passed-through 500 in integrations such as n8n). Pinning the WhatsApp Web version did not help because this is an addressing change, not version drift. The engine now resolves an individual recipient to its current WhatsApp id before sending — across text, media (image/video/audio/document), location, contact, and sticker messages, plus the typing indicator — and falls back to the original id if resolution is unavailable, so a send is never blocked on it. Group and channel sends are unaffected; the Baileys engine already handled this. (#573) Thanks @lexcorp.

## [0.7.18] - 2026-07-02

### Added

- **Stats endpoint now returns chat names in top chats.** The `GET /stats/messages` and `GET /sessions/:id/stats` endpoints include a `chatName` field on each top-chat entry, populated from the contact's pushName or saved name at message time. The dashboard uses it to show readable names instead of raw JIDs. Existing rows start as `NULL` until a new message sets the name. (#558) Thanks @buluma.

### Fixed

- **Incoming WhatsApp Business interactive messages no longer arrive with an empty body on the Baileys engine.** Messages sent as interactive/button/template shapes — which businesses use for one-time codes and verification prompts — were saved with `type: "unknown"` and a blank body, dropping the text (e.g. an OTP) entirely. The engine now extracts the display text from `interactiveMessage`, `buttonsMessage`, `templateMessage`, and `interactiveResponseMessage` into the message body and classifies them as `text`, so the content is retrievable over the standard messages API and rendered in the dashboard. (#562)
- **Deleting a message "for everyone" now reliably flags it as revoked, and `message.revoked` carries the original message id.** On the whatsapp-web.js engine the revoke event's `id` is the _revocation notification_ — a distinct message whose id never matched the stored row — so the stored message was silently never marked revoked, and webhook/WebSocket consumers had no id to reconcile against. The `message.revoked` payload now includes an optional `revokedId` (the original deleted message's id) that both engines populate; OpenWA flags the stored message on `revokedId` (falling back to `id`), and consumers should match the same way. Purely additive and backward-compatible — on Baileys `id` and `revokedId` coincide. (#567) Thanks @JibayMcs.

## [0.7.17] - 2026-07-01

### Added

- **Send true WhatsApp voice notes (PTT).** The `send-audio` endpoint, bulk send, and the `MessageSendAudio` agent tool now accept an optional `ptt` boolean; when set, the message is delivered as a real voice note — the microphone bubble with a waveform — instead of a plain audio file, on both the Baileys and whatsapp-web.js engines. Voice notes require `audio/ogg; codecs=opus` audio, so the server defaults the mimetype to that when `ptt` is set without one (supply OGG/Opus bytes for reliable playback), and stores the message as `type: "voice"`. Fulfills FR-MSG-004. (OpenWA-n8n #13)

### Fixed

- **Sending to — or operating on — a WhatsApp Channel (newsletter) no longer logs internal errors.** On the whatsapp-web.js engine a channel JID (`…@newsletter`) resolves to a `Channel`, which has none of the per-chat operations; the gateway now skips those for channels instead of throwing. The typing indicator that precedes a send, the typing/recording presence endpoint and its MCP tool, mark-unread, and delete-chat now cleanly no-op for a channel (presence does nothing; mark-unread and delete-chat report no change) rather than emitting an internal `TypeError`. Fetching chat labels for a channel previously failed with HTTP 500 — it now returns an empty list. Direct chats, groups, and broadcast lists are unaffected. (#554) Thanks @DanielOberlechner.
- **Adding and removing chat labels now works on the whatsapp-web.js engine.** The add- and remove-label endpoints called a method that does not exist in the engine, so every request failed with HTTP 500. They now apply the change correctly (reading the chat's current labels and writing back the updated set). Because labels are a WhatsApp Business feature, a request on a non-Business account — or against a chat type that has no labels, such as a channel — now returns a clear HTTP 422 instead of an internal error. (#556)

## [0.7.16] - 2026-06-30

### Added

- **Link a WhatsApp session by pairing code from the dashboard.** The session connect modal now offers a "Link with Phone Number" tab next to the QR code: enter a phone number in international format and the dashboard requests an 8-character pairing code — via the existing `POST /sessions/:id/pairing-code` endpoint — to type into WhatsApp on the phone, a QR-free way to link a device. The phone field is constrained to digits with a numeric keypad, the code/instructions are fully localized across all 10 dashboard locales, and the pairing panel is keyboard- and screen-reader-accessible. (#551) Thanks @akash247777.

### Fixed

- **Pairing code renders in the correct order in right-to-left locales.** In Arabic/Hebrew the 8-character code's two halves could be transposed by the bidi algorithm (a code like `1234ABCD` shown as `ABCD - 1234`), causing the user to type the wrong code; the code display is now isolated to left-to-right. The pairing connect modal also no longer disappears mid-link on the whatsapp-web.js engine (it stayed mounted only through `authenticating`), and a rapid double-Enter can no longer fire overlapping pairing-code requests. (#552)

## [0.7.15] - 2026-06-30

### Added

- **Inbound @mentions are surfaced on the Baileys engine.** An incoming message that tags participants now exposes the tagged WIDs as `mentionedIds` (normalized to the neutral `@c.us` convention), reaching parity with the whatsapp-web.js engine and feeding the existing `mentions` webhook filter and command-targeting. (#542)

### Changed

- **The message-templates page and the kill-stuck-session dialog are now fully localized.** Both sections previously fell back to English in French, Spanish, Arabic, Hebrew, Telugu, and Chinese (Simplified and Traditional); all of those strings are now translated, with interpolation placeholders preserved. (#550)
- **The i18n parity check now catches more than missing keys.** It additionally hard-fails on a translated string whose `{{placeholder}}` tokens differ from the reference (the bug class above), and warns when a long value is byte-identical to English (likely untranslated) — giving a CI signal for locale drift. (#547)
- **Sandboxed plugins have a ceiling on concurrent host capability calls.** A single worker-thread plugin can now have at most 32 capability calls (message sends, network fetches, storage writes) running host-side at once; a burst beyond that is rejected (the plugin sees a thrown error) rather than amplified into unbounded host work. (#544)
- **Plugin lifecycle operations on the same plugin are serialized.** Enable, disable, update, uninstall, and install for a given plugin id now run one at a time, so two operations firing together can no longer race on the plugin's directory or runtime state. (#544)

### Fixed

- **The Infrastructure queue panel shows real webhook-queue depth.** It now reports live BullMQ job counts (pending = waiting + active + delayed, plus completed/failed) instead of hard-coded zeros, drops the phantom "Message Queue" card (no such queue exists), removes the dead "Clear Failed Jobs" button (it had no handler and no backend), and makes "View Bull MQ Dashboard" copy the URL with a hint — a plain browser tab can't send the required ADMIN `X-API-Key` header, so opening one only 401'd. (#549)
- **A message that was sent is no longer reported as failed when only its persistence hiccups.** After the engine accepts a message, a transient database fault while saving the `SENT` state is now logged and the call still returns success — instead of marking the already-delivered message permanently `FAILED` (and, for text sends, firing `message:failed`) and returning an error. Genuine send failures are unchanged. (#549)
- **Incoming call messages show their real detail in the dashboard.** Call detail (`video` / `missed`) is now attached on the live whatsapp-web.js inbound path — as it already was on history — so an incoming call renders a specific labeled bubble instead of a generic "Call". (#548)
- **Location messages no longer dump a base64 thumbnail in the chat list.** Both the live dashboard handler and the engine's chat summary now show a "📍 Location" label as the last-message preview instead of the multi-KB base64 map thumbnail. (#548)
- **Logs pagination can reach every page.** The numbered pager was frozen at pages 1–5 (pages 6+ were only reachable by repeated "Next" clicks and the active highlight was lost); it now slides a centered, clamped window around the current page. (#548)
- **Message Tester clears the group selection when the session changes.** A stale group id from the previous session could otherwise be sent to; it is reset and re-seeded from the new session's groups. (#548)
- **The media lightbox caption shows a formatted time** instead of a raw ISO timestamp. (#548)
- **The "Create API key" button is disabled while the request is in flight** (and shows a spinner), preventing a double-submit. (#548)
- **QR polling no longer churns its own interval.** The poll callback reads the latest sessions via a ref, so it keeps a stable identity instead of being torn down and restarted on every sessions update. (#548)
- **Editing a webhook clears its message-filters when no message events remain selected**, matching the create path and the (hidden) filter UI. (#548)
- **A session-status toast fires once per real transition.** A double-signalled WS `session.status` event no longer produces a duplicate toast (and redundant refresh); the handler compares against the current status before reacting. (#548)
- **Dashboard chat media labels are localized.** The omitted-media placeholder and the chat image `alt` text were hardcoded English; both now use the `chats.media.*` translation keys, added across all 10 locales. (#547)
- **Spanish template-test hint interpolates correctly again.** The `templates.noPlaceholders` string had its `{{name}}` interpolation token localized to `{{nombre}}`, which broke substitution; the token is restored while the surrounding prose stays Spanish. (#547)
- **Arabic and Hebrew filter-count badges use the correct plural form.** The `webhooks.filters.badge` count was missing the required CLDR plural categories for Arabic (zero/two/few/many) and Hebrew (two), so i18next fell back to the singular noun; the missing forms are now provided. (#547)
- **The audit-log listing rejects a negative offset.** `GET /audit?offset=-N` previously passed a negative skip to the query driver; the offset is now clamped to a non-negative value. (#545)
- **API-key lifecycle operations are now recorded in the audit log.** Creating, deleting, and revoking an API key previously left no audit entry (only failed authentication was logged). Each now writes an `api_key_created` / `api_key_deleted` / `api_key_revoked` event with the acting admin key, the client IP, and the target key — giving administrators a forensic trail for credential management. (#546)
- **A session status change is no longer broadcast twice over WebSocket.** Some engines signal one transition through both a generic state callback and a dedicated one; the WebSocket `session.status` emit is now de-duplicated the same way the webhook dispatch already was, so connected dashboards receive one event per transition. (#546)
- **A slow webhook receiver no longer delays delivery to the others.** When the queue is disabled (or a queue add fails and falls back to direct delivery), the webhooks matching one event are now dispatched concurrently instead of sequentially, so one hanging or retrying endpoint can't head-of-line-block delivery to its siblings. (#546)
- **A plugin's stored secret array is no longer wiped when its length changes.** When a plugin config had a list of secret values (e.g. API keys), adding or removing an entry from the dashboard sent every other value back as the masked sentinel; on save, the merge couldn't position-match them and silently dropped all of them. Surviving entries now keep their stored secret across an append or removal, while a genuinely-new or edited row is still never grafted with a stored value. (#544)
- **A crash midway through a plugin update no longer leaves a backup that loads as a duplicate.** The in-place update backup is now a dot-prefixed sibling directory, and the loader skips dot-prefixed directories, so a half-finished update can't be re-loaded on the next boot as a second copy of the same plugin id. (#544)
- **Disappearing-messages (ephemeral) inbound messages no longer lose their content on Baileys.** A message in a chat with disappearing messages enabled arrives wrapped, so its text, media, location, and resolved type were silently dropped (the message surfaced empty and typed `unknown`). The adapter now reads the unwrapped inner content, so the body, voice/media/location detail, and correct type are preserved. (#542)
- **Captioned documents surface their caption on Baileys.** A `documentWithCaptionMessage` now contributes its caption to the message body instead of an empty string. (#542)
- **Inbound media downloads on whatsapp-web.js stay within the configured concurrency limit.** When a download exceeded its wall-clock deadline, its slot was freed while the un-abortable download kept running, letting a slow sender push the number of simultaneous in-flight downloads above `INBOUND_MEDIA_CONCURRENCY`. The slot is now held until the real download settles, bounding peak memory. (#542)
- **A stale QR code can no longer be emitted while a whatsapp-web.js session is shutting down.** A QR event buffered by the browser page could flush during teardown and flip a disconnecting session back to `QR_READY`; the handler now ignores QR events once teardown has begun. (#542)
- **Bulk send persists the correct filename for every media type.** A bulk image/video/audio message now records its own `filename` in the stored message metadata instead of only documents'. (#542)
- **Boot migrations are no longer aborted by the runtime query timeout on PostgreSQL.** The `data` connection sets a `statement_timeout` to bound live queries, and that limit was inherited by the migrations that run at startup — so on a large existing deployment a backfill plus `CREATE UNIQUE INDEX` over the `messages` or `templates` table could exceed it and fail boot. The two affected migrations now lift the timeout for their own transaction (PostgreSQL-only, transaction-scoped via `SET LOCAL`, a no-op on SQLite); the runtime timeout that protects live traffic is unchanged. (#543)
- **The templates migration revert is idempotent on a synchronize-bootstrapped database.** `AddTemplates` now drops its index and table with `IF EXISTS`, so a `down()` no longer errors when the schema was created by `synchronize` and the migration-only `IDX_templates_sessionId` index was never created. (#543)

### Security

- **The MCP endpoint has a pre-authentication per-IP rate limit.** The `/mcp` mount is raw Express and bypasses the global REST throttler, and the per-key limiter only fires after key validation — so a flood of missing/invalid/revoked keys reached a database lookup unthrottled. A sliding-window per-IP throttle now runs before key validation (keyed on the resolved client IP, honoring `TRUSTED_PROXIES`), tunable via `MCP_IP_RATE_LIMIT_MAX` (default 120) / `MCP_IP_RATE_LIMIT_WINDOW_MS` (default 60000). (#549)
- **Contact-card names escape vCard structural characters.** A contact whose name contained a backslash, semicolon, or comma could alter the structure of the generated vCard's `FN` field; those characters are now escaped per the vCard spec, complementing the existing CR/LF stripping. (#545)
- **Request inputs are bounded against oversized payloads.** Several endpoints accepted unbounded strings or arrays: bulk message `text`/`caption` now match the single-send caps (4096 / 1024), bulk `variables` must be an object, the `mentions` array is capped in size and per-entry length, group name/subject/description, status text/caption, contact name/number, reply text, and reaction emoji now have length limits, and `POST /infra/storage/import` validates its body through a DTO so the global whitelist applies. (#545)

## [0.7.14] - 2026-06-30

### Added

- **Outbound @mentions on text and media sends.** `send-text` and the media send routes now accept an optional `mentions` array of WIDs (`<phone>@c.us`) to tag participants — most useful in groups. The contract is engine-neutral: pass neutral `@c.us` WIDs and the active engine (whatsapp-web.js or Baileys) de-normalizes them. For a tag to render and notify, the `text`/`caption` must also contain the matching `@<number>` token. This brings outbound parity with the `mentions` field already surfaced on inbound webhooks. (#530) Thanks @adampalli.
- **Call and location messages render in the dashboard chat view.** Call logs now show a labeled bubble (voice/video, and "missed" for an unanswered incoming call) instead of an empty message, and shared locations render their map-preview thumbnail with a "📍 Location" label instead of dumping the raw base64 thumbnail as text. A new engine-neutral `call` message type carries the `{ video, missed }` detail, localized across all 10 dashboard locales. Based on work by @softronicve (#494).

## [0.7.13] - 2026-06-29

### Fixed

- **Bulk batch ids are unique per session, not globally.** A batch id claimed by one session no longer prevents another session from using the same id — the uniqueness constraint is now scoped to `(session, batchId)`, matching the per-session lookup, so an explicit cross-session reuse no longer fails with a `500`. Reusing an id within the same session is still rejected with a clear `400`. Existing databases are migrated in place. (#531)
- **A message arriving while a session is being deleted is no longer persisted as an orphan.** The inbound-message handler re-checks that the session is still live after its asynchronous processing, so a message that races a session deletion can't leave behind a `messages` row (which has no cascade) for a session that no longer exists. (#531)
- **Per-session stats return a consistent `lastActive` timestamp on SQLite and PostgreSQL.** `GET /stats/sessions/:id` previously emitted a different `topChats[].lastActive` format depending on the database (an ISO date-time on PostgreSQL versus the stored text on SQLite); it is now formatted to a stable `YYYY-MM-DD HH:MM:SS` on both. (#533)
- **The uuid id default now works on PostgreSQL 12 and older.** Id generation relies on a `gen_random_uuid()` column default, which is a core built-in only from PostgreSQL 13; on older servers it lives in the `pgcrypto` extension. The migration now enables `pgcrypto` first, so a fresh deploy against PostgreSQL ≤ 12 no longer fails on startup or first insert. (#533)
- **The audit-log listing no longer loads the whole table for a large `limit`.** `GET /audit` clamps its page size to a maximum of 200, so an oversized `limit` can't pull the entire `audit_logs` table into a single response. (#536)
- **Migration reverts are idempotent on a synchronize-bootstrapped database.** The `baileys_stored_messages` and `webhook_delivery_failures` migrations now drop their indexes with `IF EXISTS`, so a `down()` no longer errors when the named indexes were never created. (#536)
- **Bulk send always releases its in-flight marker.** A batch whose session engine was missing, or that threw mid-processing, previously left a stale entry in an in-memory tracking map; the marker is now released on every exit path. (#536)

### Security

- **Hook re-entrancy is now blocked for sandboxed plugins too.** A plugin running in the worker-thread sandbox could re-fire the hook it was handling by issuing a capability call (for example, sending a message from within a `message:sending` handler), because the re-entrancy guard did not span the worker boundary — looping the event back into the plugin without bound. The host now runs each worker-initiated capability call inside the in-flight hook context, so such a re-fire is short-circuited exactly as it already was for in-process plugins. (#532)
- **Docker container teardown is constrained to OpenWA-managed services.** The `POST /infra/restart` endpoint passed its `profilesToRemove` list straight to container removal, which resolved containers by a name substring — so an unrecognized or empty profile could stop and remove an unrelated container. Teardown is now restricted to the managed allowlist (`postgres`, `redis`, `minio`) and container resolution requires an exact `openwa-<service>` name match. (#534)
- **Failed API-key authentication attempts are now recorded in the audit log.** Rejected or denied keys (invalid, disabled/expired, IP- or session-scope-denied, or insufficient role) previously left no audit entry; the gateway now logs an `api_key_auth_failed` event with the client IP, method, path, and reason, giving administrators a forensic trail for credential probing. Audit logging stays best-effort and never affects the request outcome. (#535)
- **The SSRF guard blocks the deprecated IPv6 site-local range (`fec0::/10`).** Webhook and server-side media URLs are now rejected when they resolve into `fec0::/10`, closing a gap alongside the already-blocked unique-local and link-local ranges. (#536)
- **Session-scoped MCP tools require a session id before authorization.** A session-scoped tool invoked without a session id is now rejected, so a session-restricted API key can't be used to drive such a tool against a session outside its scope. (#536)
- **Contact-card vCards are sanitized on both engines.** Sending a contact whose name or number contained CR/LF could inject extra vCard fields on the whatsapp-web.js engine; both adapters now build the vCard through one shared sanitizing helper (CR/LF stripped, digits-only `waid`). (#537)

## [0.7.12] - 2026-06-29

### Added

- **Brazilian Portuguese (pt-BR) locale.** The dashboard is now available in Português (Brasil) — all 9 navigation sections, toasts, dialogs, and form labels are translated. Select it from the language picker on the login screen or the sidebar. Thanks @A831ARD0.

### Fixed

- **The engine fallback no longer silently starts the wrong engine.** If the configured engine (`ENGINE_TYPE`, e.g. `baileys`) is unavailable and the legacy direct-creation fallback is reached, it now fails with a clear error instead of silently constructing the whatsapp-web.js adapter. (#527)

### Security

- **Application logs redact secret-valued metadata.** The values of secret-named log fields (`password`, `secret`, `token`, `api-key`, `authorization`, `credential`, `pepper`, `private-key`) are replaced with `[REDACTED]` before a line is written — defense-in-depth so a stray log statement can't leak a credential. (#527)

### Performance

- **Failed media sends and completed bulk batches no longer retain their base64 payload.** A failed media send kept its (often multi-MB) base64 in the message row, and a completed bulk batch kept every message's base64 in `message_batches` indefinitely — both are now stripped (mimetype/filename kept), so the `messages` and `message_batches` tables don't grow without bound. (#524)
- **The dashboard chat view no longer caches full media base64.** Chat history is fetched without media and the per-chat cache is evicted sooner, so browsing several media-rich chats no longer risks OOMing the tab; older history media shows a `📎 Media` placeholder and recent media still renders. (#525)

## [0.7.11] - 2026-06-29

### Added

- **Disappearing-messages support (Baileys engine).** Outbound messages now honor a chat's disappearing-messages timer and set it on each send (text, media, and replies), so recipients no longer see _"This message won't disappear — the sender may be using an older version of WhatsApp."_ The timer is learned from inbound messages — the reliable source, since the cached chat setting is often absent for a long-standing timer — and resolved across both phone and `@lid` chat identifiers so it applies on LID-migrated 1:1 chats, with a fallback to the chat's cached setting. It is applied only when a positive value is known; when it's unknown or disabled, the per-message expiration is omitted, exactly as before. Reactions, deletes/revokes, and status posts are unaffected. Thanks @ulises2k. (#473, #513)
- **Selective skip for disappearing messages.** New `STORE_EPHEMERAL_MESSAGES` env var (default `true`). Set to `false` to skip persisting and dispatching incoming disappearing messages (those with `ephemeralDuration > 0`) — no DB insert, no webhook dispatch, no websocket event. Backward compatible; existing deployments are unaffected. The `ephemeralDuration` field is also surfaced on `IncomingMessage` for consumers that want to handle it themselves. Thanks @spidgrou. (#506)
- **Durable dead-letter record for failed webhook deliveries.** A webhook delivery that permanently fails — exhausting its retries or being rejected before it is sent — is now persisted to a new `webhook_delivery_failures` table instead of disappearing when its job is evicted from the queue. Operators can review the recorded failures (endpoint, event, status, error, attempts) through a new admin endpoint, `GET /webhooks/delivery-failures`. (#520)

### Fixed

- **Deleting a session now removes its message history and bulk batches.** The `messages` and `message_batches` tables had no cascade from `sessions`, so a deleted session left its rows behind — growing the largest tables without bound and skewing dashboard statistics. They are now removed in the same transaction as the session. (#504)
- **Deleting a session while it is reconnecting no longer leaks its engine.** A delete that landed during the multi-second engine initialization of an in-flight reconnect (or start) could leave the freshly-launched browser/socket registered under the now-deleted session, still counting toward the concurrent-session limit. The post-init guard now re-checks that the session still exists before keeping the engine. (#521)
- **Inbound media downloads are bounded by a wall-clock timeout.** A slow or stalled inbound media transfer could hold a download slot — and, on the Baileys engine, the entire inbound-message pipeline — open indefinitely. Downloads now time out (`MEDIA_DOWNLOAD_TIMEOUT_MS`, default 30s) and the message is delivered with the media omitted. (#510)
- **Webhook delivery identifiers stay consistent with the signed body.** The `X-OpenWA-Idempotency-Key` / `X-OpenWA-Delivery-Id` headers could diverge from the signed payload when a `webhook:before` plugin returned a modified payload, and all webhooks for an event shared one `data` object. Each webhook now receives an isolated copy of the data and the server-generated identifiers are authoritative. (#512)
- **`POST /auth/validate`** no longer double-counts key usage and now validates IP-restricted keys correctly (it previously reported a valid IP-pinned key as invalid). (#507)
- **⚠️ `GET /settings` now requires an ADMIN key** (behavior change) — matching the rest of the configuration surface; it was previously readable by any authenticated key. A client that read settings with a non-admin key must switch to an ADMIN key. (#514)
- **Bulk-message `batchId` uniqueness** is scoped per session, so two sessions can reuse a batch id and neither can probe the other's id namespace. (#515)
- **⚠️ Boot-time configuration validation** now rejects `0` for the rate-limit limits and the webhook timeout (behavior change) — values that silently disabled throttling or aborted every delivery. A deployment that set `0` to disable these must remove the override or use a positive value. (#516)
- **SSRF protection** now blocks the RFC6052 IPv4-translatable IPv6 form (`::ffff:0:a.b.c.d`), closing a gap where an internal address could be reached behind a NAT64/SIIT translator. (#518)
- **Per-key IP allowlist** now uses the shared, hardened IP matcher and rejects a malformed client address instead of coercing it into an allowed range. (#519)
- **Dashboard:** the Infrastructure page is no longer rendered for non-admin roles, and image-attachment preview object URLs are released after use. (#508)
- Released a small in-memory leak: a deleted session's stored failure reason is now cleared. (#505)
- **The webhook worker now connects to the configured Redis.** Configuration from `.env` and the dashboard-saved file is loaded before the application modules are evaluated, so the webhook delivery worker reads its Redis host/port/password from the configured values instead of falling back to a local default when those are supplied by file rather than the process environment. (#523)

### Performance

- **Configurable webhook worker concurrency** (`WEBHOOK_WORKER_CONCURRENCY`, default 10): a single slow or unresponsive receiver no longer head-of-line-blocks delivery for every other webhook. (#511)
- Dropped a redundant single-column index on `messages(sessionId)` already covered by the existing composite indexes, reducing write-time overhead on a high-volume table. (#509)

## [0.7.10] - 2026-06-28

### Added

- **WhatsApp Status posting (Baileys only).** The three status `send-*` endpoints now post to the status feed on the Baileys engine: `POST /api/sessions/:id/status/send-text`, `/send-image`, and `/send-video` accept a required `recipients[]` body field (1–256 JIDs, each `@c.us` or `@lid`; passed to the engine as `statusJidList` — an empty array is rejected with `400`). Image/video take an optional `image.mimetype` / `video.mimetype`; the service defaults to `image/jpeg` / `video/mp4`. A whatsapp-web.js session returns `501`: WA Web removed `WAWebStatusGatingUtils.canCheckStatusRankingPosterGating` around 2026-04-30, so the wwebjs path is upstream-blocked. `@c.us` recipients are reliable; `@lid` is best-effort (unverified), and the posting account's own phone may briefly show a "waiting for this status update" notice while recipients view it normally. Thanks @CharlesLightjarvis for the report. (#455)

- **Visible placeholder for skipped inbound media.** When `MEDIA_DOWNLOAD_ENABLED=false` (or a media item is over the byte cap), an incoming media message now carries an `omitted` marker and the dashboard chat renders a `📎 Media` placeholder instead of a bare timestamp. The marker reuses the existing `{ mimetype, omitted, sizeBytes }` shape on both the whatsapp-web.js and Baileys engines, so webhook/n8n/dashboard consumers see one consistent contract for "media was present but not downloaded." Thanks @spidgrou. (#501)

### Fixed

- **Status image/video no longer hardcode `image/jpeg` / `video/mp4`.** The `SendImageStatusDto` / `SendVideoStatusDto` media input now accepts an optional `mimetype`; the service applies `mimetype ?? 'image/jpeg'` (or `'video/mp4'`) instead of always passing the hardcoded value to the engine. (#455)

- **Clean install on Node 22+ / npm 11.** `@nestjs/websockets` is now declared as a direct dependency — it was only resolving transitively via `@nestjs/platform-socket.io`, so stricter installs failed with `TS2307: Cannot find module '@nestjs/websockets'`. The `postinstall` script also no longer triggers Node's `DEP0190` deprecation: `shell: true` is retained (so Windows still resolves `npm` via `npm.cmd`) but the command is now passed as a single string instead of an args array. Thanks @abdullah4tech. (#500)

### Changed

- **Italian translation update.** Improved the `messageTester` page title in the Italian (`it`) dashboard locale to use natural Italian instead of an anglicism. Thanks @albanobattistella. (#497)

## [0.7.9] - 2026-06-28

### Added

- **Bounded list pagination.** `GET /sessions` and `GET /webhooks` (and the matching agent tools) now accept `limit` (1–1000, default 1000) and `offset` query parameters, so large deployments can page through results instead of receiving an unbounded list. (#496)
- **Concurrent-session cap.** New `MAX_CONCURRENT_SESSIONS` env (default `0` = unlimited) caps how many WhatsApp engines may run or initialize at once, protecting memory/Chromium-constrained hosts. (#496)
- **Configurable Redis connect timeout.** New `REDIS_CONNECT_TIMEOUT_MS` (default `5000`) bounds how long the queue and cache connections wait when reaching Redis. (#496)

### Fixed

- **Webhook delivery during a Redis outage.** The webhook queue producer now fails fast instead of buffering indefinitely when Redis is unreachable, falling back to direct (signed, idempotent) delivery; the queue Worker keeps its offline queue so it still tolerates brief reconnects. (#496)
- **Accurate session stats at scale.** `GET /sessions/stats` aggregates status counts in the database, so totals stay correct on deployments with more sessions than the list cap. (#496)
- **Plugin storage key safety & portability.** Plugin storage keys are validated and encoded to filesystem-safe filenames (JID-style keys now work on Windows), with backward-compatible reads/deletes of pre-existing files. (#496)

### Changed

- Refreshed project documentation, roadmap, and testing strategy against the current baseline. (#496)

## [0.7.8] - 2026-06-28

### Added

- **Optional inbound-media skip.** New `MEDIA_DOWNLOAD_ENABLED` flag (default `true`) lets operators skip downloading inbound media entirely on both the whatsapp-web.js and Baileys engines — useful for text-only or low-resource deployments. When disabled, inbound messages omit the `media` field and report `hasMedia: false` in webhooks and the dashboard. Thanks @spidgrou. (#492)

### Fixed

- External-S3 setups no longer silently fall back to local disk after upgrading: `docker-compose.yml` again forwards the legacy `S3_ACCESS_KEY` / `S3_SECRET_KEY` (alongside the canonical `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`) so an existing `.env` keeps reaching the container, and the legacy names are blank-cleared so they can't shadow the dashboard config. (#488 follow-up)
- The production default-secret guard no longer skips a weak credential for a host-pinned **external** datastore just because the built-in flag is set: the built-in exemption now requires both the `*_BUILTIN` flag **and** an internal host (`postgres` / `minio`), so an external Postgres/MinIO with a default password is still rejected in production. (#488 follow-up)
- The Infrastructure page now shows an error + retry (instead of an editable form seeded from defaults) when the live `/infra/status` can't be loaded, so a save can no longer flip a running built-in database/Redis/storage to external+empty. (#488 follow-up)
- `/infra/status` no longer blocks on the WhatsApp Web version registry fetch, and that fetch is rate-limited after a failure, so a firewalled/offline host no longer stalls up to 5s on every status poll and every session start/reconnect. (#488 follow-up)
- A replayed `message.sent` WebSocket echo no longer downgrades a chat message already shown as delivered/read; the live-append path now applies the same forward-only delivery-status merge as the ack path. (#484 follow-up)

### Changed

- **Italian translation update.** Refreshed the Italian (`it`) dashboard locale. Thanks @albanobattistella. (#491)

## [0.7.7] - 2026-06-28

### Added

- Dashboard **chat thread UX**: URLs in messages are now clickable links, WhatsApp text formatting (bold/italic/strikethrough/monospace) renders, images open in a photo lightbox, and the scroll position is remembered per chat. Thanks @softronicve. (#484)
- The Infrastructure page now shows the actual **WhatsApp Web build** the whatsapp-web.js engine is using (e.g. `2.3000.1042251103-alpha`) and how it was chosen (pinned via `WWEBJS_WEB_VERSION`, auto-resolved, or native), surfaced via `/infra/status`. The engine card previously showed only the npm library version (`whatsapp-web.js 1.34.7`), which is unrelated to the WA Web build that actually governs connection stability. (#488)
- Infrastructure data **backup & restore**: export all Data-DB tables to a JSON file and import them back, wired into the database-switch flow. When you change the database backend, the restart dialog now warns that the new database starts empty and offers a one-click backup before switching; a storage switch warns that existing media is not moved. (#488)
- The Infrastructure page flags any database/redis/storage setting that is **pinned by an environment variable** (its running value differs from the saved config), so it's clear a dashboard change won't apply until that variable is unset, instead of the control silently having no effect. (#488)
- The storage card now warns when **S3 is selected but unreachable** (a dead/misconfigured bucket no longer shows a misleading green badge), via a new `s3Available` field on `/infra/status`; the check re-probes (throttled) rather than latching the boot-time result, so a bundled MinIO that comes up after the app self-corrects. A backup import that exceeds the request size limit now reports an actionable message (raise `BODY_SIZE_LIMIT`) instead of a bare "Payload Too Large". (#488)
- Data-loss & availability hardening for the new infra flows: importing a backup now **refuses an empty/garbage file** (it no longer wipes the database and reports success) and asks for confirmation first; selecting the **built-in Postgres/MinIO no longer crash-loops a production boot** on the default-secret guard (the bundled containers run on the internal-only network); and a transient failure fetching the WhatsApp Web version is no longer cached, so it retries instead of permanently falling back. (#488)
- Human-readable console logs: the `LoggerService` now renders a colorized, NestJS-style line (`[OpenWA] <pid> - <timestamp> <LEVEL> [Context] <message>` with dimmed `key=value` metadata and stack traces on their own line) instead of always emitting raw JSON, so application logs line up visually with NestJS's own framework logs. The format defaults to structured JSON in production (`NODE_ENV=production`, for containers and log aggregators) and human-readable pretty everywhere else, and can be pinned with `LOG_FORMAT=pretty|json`. `NO_COLOR` / `FORCE_COLOR` are honored. JSON output is byte-for-byte unchanged when selected. (#469)

### Fixed

- whatsapp-web.js sessions that scanned the QR then immediately disconnected (looping `qr → authenticating → disconnected`) when no `WWEBJS_WEB_VERSION` was pinned — the common Docker default. The engine now auto-resolves the current known-good WhatsApp Web build from the wppconnect `wa-version` registry and pins it, instead of relying on whatsapp-web.js's auto-select which could latch onto an incompatible bleeding-edge build that authenticates but never reaches "ready". `WWEBJS_WEB_VERSION=off` keeps the old native auto-select; an explicit version still pins exactly. (#488)
- Dashboard message-analytics charts no longer silently vanish on PostgreSQL: `/stats/messages` (top-chats) ordered by an unquoted mixed-case alias (`ORDER BY messageCount`), which PostgreSQL case-folds and rejects with `column "messagecount" does not exist` (500). It now orders by the aggregate directly, so the query — and the dashboard charts it feeds — work on PostgreSQL as they already did on SQLite. The chart section also shows a clear notice on a real error instead of rendering nothing (it previously treated every error as a non-admin 403 and hid itself). (#488)
- The Infrastructure page now shows what is **actually running** for the database, Redis, storage, and engine — the badge/selected card follow the live `/infra/status` instead of the saved `data/.env.generated`, which could disagree when a setting is supplied via environment variable. Previously a stack running PostgreSQL via `DATABASE_TYPE=postgres` showed "SQLite" (the first-run default still in the saved file). `/infra/status` now also reports `redis.enabled`. (#488)
- The "Use Built-in PostgreSQL/Redis/MinIO Container" toggles now reflect whether OpenWA's **bundled container is actually running** and backing the service (detected from the labeled container + the configured host), not just the saved intent — so a Postgres stack started via the `postgres` compose profile correctly shows built-in, and a stopped/external one shows off. Falls back to the saved flag when Docker isn't reachable. (#488)
- Switching **away** from a built-in backend (built-in → external/disabled) now tears down the bundled container reliably even after a page reload: removal is derived server-side from the saved `*_BUILTIN` flags + the running labeled containers, instead of only trusting the browser's in-memory list (which reset on reload and left the container orphaned). Named volumes are preserved, so re-enabling reuses the data. (#488)
- Dashboard "by type" message chart: each message type now gets a stable, distinct color keyed by type name (with a deterministic hash fallback) instead of a rotating array-index palette, so a slice keeps its color when the set of present types changes between requests and types past the eighth no longer collide. (#486)
- Removed the oversized decorative watermark icons bleeding through the dashboard stat cards. (#488)
- Dashboard switches for the **database, Redis, and storage** backends now actually take effect after a restart, matching how the engine switch already worked. The bundled `docker-compose.yml` forwards these settings blank (`${VAR:-}`) so the dashboard's saved selection (in `data/.env.generated`) is honored, while a real value set in your `.env`/host still pins it (and the UI now says so). Previously compose forwarded concrete defaults that silently shadowed the dashboard's choice, so switching had no effect under Docker. (#488)

### Changed

- ⚠️ `docker-compose.yml` now forwards the S3 credentials under their canonical names `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (and adds `S3_REGION`), matching what the app and dashboard read. The legacy `S3_ACCESS_KEY` / `S3_SECRET_KEY` are still accepted as a fallback, so existing setups keep working, but updating your `.env` to the canonical names is recommended. (#488)
- ⚠️ Database/Redis/storage selection is now sourced from the dashboard-managed `data/.env.generated` when not pinned by an environment variable (see Fixed, above). If you previously relied on the compose file's concrete defaults overriding a stale `data/.env.generated`, set the value explicitly in your `.env`/host to pin it. First-run defaults (SQLite, local storage, Redis off) are unchanged. (#488)

## [0.7.6] - 2026-06-26

### Changed

- CI now runs the dashboard unit tests, and re-runs the client-SDK suites when a server DTO or the engine interface changes (not only on SDK edits), so contract drift is caught at its source. (#478)
- The Postgres connection pool now applies query/connection timeouts (`statement_timeout`, `idleTimeoutMillis`, `connectionTimeoutMillis`) on the runtime connection, so a stuck query or a saturated pool fails fast instead of hanging requests. The migration connection keeps idle/connection timeouts but never `statement_timeout`, so a long `CREATE INDEX` is not aborted. Env-tunable (`DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_IDLE_TIMEOUT_MS`, `DATABASE_CONNECTION_TIMEOUT_MS`), conservative defaults, `0` disables; SQLite is unaffected. (#480)

### Fixed

- A plugin whose enable failed after it had already subscribed hooks no longer leaves stale hook registrations behind; a later successful enable could otherwise dispatch each event to the plugin more than once. (#477)
- The WebSocket `message.ack` event now carries the same `{ id, messageId, status, ack }` shape over the socket as the matching webhook does — the socket previously omitted `id` and the legacy `ack`. (#477)
- Reconnect timers are no longer stacked when two disconnects arrive back-to-back, and a terminal engine failure now cancels any pending reconnect so a `FAILED` session cannot be resurrected by a stale timer. (#477)
- The dashboard recovers from a stale lazy-loaded chunk after a redeploy with a single guarded reload instead of replacing the whole UI with the error screen; the Content-Security-Policy `img-src` now allows `blob:` so the outgoing image-attachment preview renders. (#477)
- The Baileys engine's number-check (`GET /sessions/:id/contacts/check/:number`) now returns a neutral `<phone>@c.us` id, matching the whatsapp-web.js engine, instead of a raw `@s.whatsapp.net` id. (#477)
- The data export/import now includes the `lid_mappings` resolution cache, so a backup/restore or a SQLite↔PostgreSQL migration no longer drops it. (#477)
- The JavaScript client SDK applies the JSON `Content-Type` and `X-API-Key` after caller-supplied headers, so they can no longer be overridden by `defaultHeaders` (matching the Python and PHP SDKs); an unfollowed redirect (HTTP status `0`) now raises a clear error instead of `OpenWA API 0`. (#478)
- The infrastructure status endpoint reports the active S3 bucket when storage is in S3 mode, instead of only the unused local media path. (#478)
- The migration CLI now honors the dashboard-written `data/.env.generated`, so `migration:run:prod` targets the configured database (e.g. PostgreSQL) instead of silently defaulting to SQLite. (#479)
- The first-run generated config writes `STORAGE_LOCAL_PATH` (the key the backend reads) instead of the dead `STORAGE_PATH`. (#479)
- The Sessions page now keeps the shared dashboard cache in sync, so creating/stopping/deleting a session no longer leaves the Dashboard showing stale session counts or status until a refresh. (#479)

### Security

- The startup banner prints the full admin API key only when it is first created; on subsequent boots the key is masked, so the live credential is not re-written to the log pipeline on every restart. (#478)
- The production secret guard now rejects a placeholder `REDIS_PASSWORD` (e.g. `changeme`); an empty/unset password is still allowed so passwordless private-network Redis continues to boot. (#478)
- The published PHP SDK package no longer ships its test suite, PHPUnit config, or `composer.lock`. (#478)
- The production weak-secret guard now also rejects the common defaults `123456`, `qwerty`, `root`, `test`, and `demo`. Matching stays an exact full-value comparison, so a strong secret that merely contains one of these words is not blocked. (#480)
- The gateway now logs a startup warning when `API_KEY_PEPPER` is unset in production (stored API-key hashes then use plain SHA-256). Advisory only — enabling a pepper invalidates existing key hashes, so it stays opt-in and is never enforced. (#480)

## [0.7.5] - 2026-06-26

### Fixed

- The stats/analytics endpoint no longer crashes on PostgreSQL. The message time-series query grouped by an output alias named `timestamp` — a reserved type keyword in PostgreSQL — so `GROUP BY timestamp` was not read as the alias and the query failed with _"column m.createdAt must appear in the GROUP BY clause"_ (SQLite tolerated it, so unit tests on the SQLite test DB never caught it). The alias is now `bucket`; the API response field is unchanged. (#474)

### Documentation

- Added a Traefik / Coolify reverse-proxy guide to the troubleshooting FAQ: WebSocket forwarding, the `docker-proxy` double-hop that causes intermittent `504`s behind Coolify (held-open Socket.IO connections exhausting the pool to the single-port upstream), and idle-timeout tuning. (#467)

## [0.7.4] - 2026-06-25

### Fixed

- WebSocket events are now delivered exactly once to a client subscribed to overlapping rooms (for example both a specific event and the `*` wildcard for the same session). The real-time fan-out previously sent one copy per matching room, so such a client could receive the same event two to four times. The bundled dashboard was unaffected (its pages subscribe to disjoint rooms); this fixes duplicate delivery for custom WebSocket clients. (#468)
- `session.authenticated` and `session.disconnected` are now emitted over the WebSocket (with `{ phone, pushName }` and `{ reason }` respectively), matching the existing webhook payloads. They were advertised as subscribable but were only ever delivered via webhooks, so socket subscribers never received them. (#468)
- The infrastructure status endpoint (`GET /api/infra/status`) now reports the actual media storage path — it reads `storage.localPath` (default `./data/media`), the key the storage service uses — instead of a non-existent `storage.path` key that always reported `./uploads`. (#472)
- The JavaScript client SDK's `timestamp` fields (`MessageResponse`, `MessageRecord`) are documented as Unix **seconds** (the real passed-through value, previously mislabelled milliseconds), and the PHP SDK's `Client::request()` is correctly typed (`mixed $body): mixed`). (#472)

### Changed

- The WebSocket `group.join` / `group.leave` / `group.update` events are no longer accepted as socket subscriptions — they have no engine source and were never delivered on the socket. Subscribing to one now returns a clear validation error instead of silently never delivering. They remain reserved on the webhook side. Webhook subscriptions are unaffected. (#468)

### Documentation

- The `docs/` set was reconciled against the v0.7.3 implementation — API specification and collection, operational runbooks, troubleshooting, system architecture, security, database, dashboard, SDK, and plugin docs — correcting drift accumulated across releases. (#471)

## [0.7.3] - 2026-06-25

### Added

- MCP server (opt-in, `MCP_ENABLED=true`): exposes a curated ~39-tool agent surface (sessions, messaging, contacts, basic group ops, webhook reads) over the Model Context Protocol at `POST /mcp`, on the existing single port. Off by default — the MCP SDK is not loaded unless enabled, and every REST route is unchanged. Tools call the existing services and reuse the same API-key auth, role, and per-session scoping as REST; reads vs writes are tiered and `MCP_READONLY=true` mounts read tools only. Destructive/privileged operations are deliberately excluded from the surface. (relates to #256; salvages result-shaping from #461 — thanks @tobiasstrebitzer)
- Client SDKs: official, hand-written client libraries for the REST API in **JavaScript/TypeScript** (`@rmyndharis/openwa`), **Python** (`rmyndharis-openwa`), and **PHP** (`rmyndharis/openwa`), replacing the previous single-file stub (`sdk/`). Each exposes the same fluent resource surface — `sessions`, `messages`, `contacts`, `groups`, `chats`, `webhooks`, `labels`, `channels`, `catalog`, `status`, `templates`, `health` — over an injectable HTTP transport, with a typed error hierarchy mapping the NestJS error envelope (`401/403/404/409/429/501`) to typed exceptions and a timeout error. Request/response types mirror the server DTOs exactly. The JavaScript package ships dual CJS + ESM with bundled type declarations (consumable via both `require()` and native `import()`, guarded by a packaging smoke test); the Python package ships PEP 561 type information (`py.typed`); the PHP package is PSR-4 / Guzzle 7. Redirects are never auto-followed (so the API key is never re-sent to a redirect target), auth/JSON headers always take precedence over caller-supplied defaults, path segments are percent-encoded, and a base-URL path prefix (e.g. behind a reverse proxy) is preserved. The SDK does not retry — wrap calls with your own backoff. Published at `0.1.0` on npm (`@rmyndharis/openwa`), PyPI (`rmyndharis-openwa`), and Packagist (`rmyndharis/openwa`). (#463)

### Changed

- CI now runs the JavaScript, Python, and PHP client SDK test suites (path-filtered to `sdk/**`, including the dual-format CJS/ESM packaging smoke test), and the Packagist mirror of the PHP SDK is gated on its tests passing so a broken SDK can no longer auto-publish.

### Fixed

- Reconnection no longer stalls when a wedged browser fails to shut down: the engine teardown during an automatic reconnect is now time-bounded (10s, matching every other teardown), so a stuck Chromium can't leave a session permanently disconnected without self-healing. Affects the `whatsapp-web.js` engine; recover an already-stuck session with force-kill.
- Message timestamps are now consistently returned as a number on both SQLite and PostgreSQL. PostgreSQL previously returned the `bigint` column as a string, which broke strictly-typed SDK clients and arithmetic in non-coercing consumers.
- A blank `DATABASE_PASSWORD` forwarded by the bundled Docker Compose file is now treated as unset, so an external-PostgreSQL password saved via the dashboard is applied instead of being shadowed by the empty value (a real host/`.env` value still keeps top precedence).
- The Python and PHP SDKs now treat an unfollowed redirect (any `3xx`) as an error response, matching the JavaScript SDK. Redirects are never followed (so the API key is never re-sent to the target), which makes a `3xx` an unusable result rather than a fake success.
- Duplicate inbound webhook deliveries: a single inbound WhatsApp message could reach a registered webhook (and the `messages` table) more than once because the engine can re-fire the message event. Inbound `message.received` is now de-duplicated server-side, enforced by a `UNIQUE(sessionId, waMessageId)` constraint (added with a lossless de-duplicating migration), so each message is persisted and dispatched once. The guard fails open — a transient DB error still delivers the message. Webhook delivery remains **at-least-once** (engines re-fire, failed deliveries retry), so handlers should still be idempotent on the `X-OpenWA-Idempotency-Key` header, now documented under Webhook Delivery Semantics. (#464)

## [0.7.2] - 2026-06-24

### Added

- Sessions (Baileys): pre-connection chat history is now persisted. On a fresh link Baileys pushes the recent (and, with `BAILEYS_SYNC_FULL_HISTORY=true`, full) message history via `messaging-history.set`; these batches are now mapped and saved into the messages table for the chat view, so a newly linked session shows past conversations instead of an empty panel. The batches are de-duplicated and stamped with each message's real timestamp, and are persisted only (no webhook/hook/websocket dispatch, since they predate the live session). Sender push-names from the history are also harvested so chats show names rather than bare ids, and each chat's last-message preview and sort time are seeded from the history so the chat list no longer reads "No messages yet".
- Sessions (Baileys): chat display names are now backfilled on connect. Baileys 6.7.x frequently skips the initial app-state sync (the state machine goes Online before it runs when the first history notification is non-processable) and the `PUSH_NAME` sync can fail to decrypt, so chats showed bare ids/numbers. On connection open the adapter now fetches group subjects via `groupFetchAllParticipating` and re-triggers an app-state resync (best-effort) to recover saved contact names; both are non-fatal and complement the push-names that arrive on live messages.
- Webhooks: an opt-in `WEBHOOK_CONTACT_DETAILS` flag enriches the `message.received` payload's sender `contact` object with the free, already-cached WhatsApp contact fields — `id`, `number`, `shortName`, `type`, `isMyContact`, `isWAContact`, `isBusiness`, `isEnterprise`, `verifiedName`, `verifiedLevel`, `isBlocked`, and `labels` (IDs) — alongside the existing `name`/`pushName`. **Off by default** (the payload keeps the minimal `name`/`pushName`). All fields are read synchronously from the contact already fetched per message, so no extra WhatsApp API calls are made (profile picture and about/status are intentionally excluded to avoid rate-limit/ban risk).

### Fixed

- Sessions (Baileys): when a session is logged out — unlinked from the phone or via the API — the now-invalid on-disk auth state is cleared, so re-linking shows a fresh QR instead of getting stuck silently reloading the dead credentials. (#453 — thanks @ulises2k)
- Webhooks: registering a webhook (`POST /sessions/:id/webhooks`) to a host whose DNS lookup _rejects_ (NXDOMAIN, or a transient `EAI_AGAIN`/`ESERVFAIL` under resolver pressure) now returns `400 Could not resolve host: <host> (<code>)` instead of a generic `500 Internal server error`. The SSRF guard's DNS deadline already mapped resolution _timeouts_ and empty results to a 4xx; a rejected lookup leaked the raw DNS error, which surfaced as an intermittent 500 during back-to-back session-create → webhook-register flows.
- Infrastructure: the dashboard config form no longer shows Server, Webhook, and Rate-Limit sections that were never persisted — they returned a fake "saved" while silently discarding every value. The form now exposes only the settings it actually writes (Database, Redis/Queue, Storage, Engine); the removed settings remain configurable via environment variables.
- Infrastructure: data export/import (the documented backup and SQLite↔PostgreSQL migration flow) is now complete. It previously exported and restored only sessions, webhooks, messages, and message batches — so a restore silently lost all message templates and stored Baileys messages (cascade-deleted with the old sessions and never re-imported) and dropped every webhook's filters, causing a filtered webhook to come back firing on all events. Templates, stored Baileys messages, and webhook filters now round-trip intact.
- Engine selection: pinning the engine from the environment works again after the v0.7.1 compose change. The bundled compose files forward `ENGINE_TYPE` into the container again (`- ENGINE_TYPE=${ENGINE_TYPE:-}`) and the app treats a blank value as unset, so an `.env`/host `ENGINE_TYPE=baileys` is honoured while the dashboard's Infrastructure > Engine selection still wins when no engine is pinned. `.env.example` no longer ships `ENGINE_TYPE` pre-pinned. **Upgrade note:** if you relied on `ENGINE_TYPE=baileys` in your `.env`, confirm the active engine after upgrading. (#453 — thanks @ulises2k)

### Security

- Infrastructure: configuration values saved from the dashboard are now rejected if they contain a line break, which could otherwise write an extra `KEY=value` line into `data/.env.generated` and inject an arbitrary environment variable on the next boot.

## [0.7.1] - 2026-06-24

### Added

- Dashboard: a **Message Analytics** section — a period selector (24h / 7d / 30d) with messages-over-time, messages-by-type, and top-chats charts, sourced from the existing statistics endpoints. The charting bundle is code-split so it loads only with the Dashboard, not on the login screen.
- Infrastructure: an **Engine Configuration** tile to pick and configure the active WhatsApp engine (whatsapp-web.js / Baileys), mirroring the Database tile. Selecting an engine persists the choice and applies on restart.

### Changed

- Dashboard: the **Messages Today** card is now populated from real data, and the previously-empty **API Calls** card is replaced with a **Total Messages** metric. The sidebar version is now read live from the backend, so a stale-built bundle no longer shows the wrong version.
- Plugins: the WhatsApp engine adapters are no longer listed as plugin cards — they are configured under **Infrastructure → Engine**. The Plugins page is now extensions-only.
- Plugins config dialog: the Configuration/Sessions and install tabs use a cleaner segmented control; the modal caps its height and scrolls its body with a pinned header and footer (Save is always reachable) and is wider for config-heavy plugins.
- ⚠️ **Deployment:** the bundled docker-compose files no longer pin `ENGINE_TYPE`, so the active engine can be chosen from **Infrastructure → Engine** (persisted to `data/.env.generated`). A real container/host `ENGINE_TYPE` env still takes precedence; leave it unset to let the dashboard control the engine.
- Docker Compose: the production data-path settings (`SESSION_DATA_PATH`, `STORAGE_LOCAL_PATH`, `PLUGINS_DIR`) and the dev-compose environment are now overridable via `${VAR:-default}` without editing the compose files. (#450, #451 — thanks @MS-Jahan)

### Fixed

- Chats: voice notes and videos now play — the Content-Security-Policy was missing a `media-src` for `data:` URIs, so the browser blocked inline audio/video.
- Chats: stickers, images, videos and documents loaded from history now render instead of collapsing to an empty timestamp-only bubble (history is fetched with its media payload).
- Chats: on small screens the conversation back-button icon is now visible (inherited button padding had squeezed it to zero width).
- Plugins config dialog: radio buttons on the Sessions tab no longer stretch to full width and strand their labels.
- Infrastructure: the engine status and the engine config form now reflect the real saved headless / session-path / browser-argument values instead of always showing defaults.
- Docker (production builds): the builder stage now forces `devDependencies` (`npm ci --include=dev`) so `nest build` and the dashboard build no longer fail with `nest: not found` when a PaaS (e.g. Coolify) leaks `NODE_ENV=production` into the image build. (#449 — thanks @MS-Jahan)

## [0.7.0] - 2026-06-23

> **v0.7 — plugin-contract expansion.** Richer plugin config (declarative + sandboxed-iframe editors),
> per-session activation and config, SSRF-guarded outbound HTTP, and the removal of the bundled
> reference extensions in favour of the marketplace. ⚠️ See the **Removed** note before upgrading.

### Added

- Plugins: richer **config schema** vocabulary — a `textarea` type, `min`/`max`/`pattern` validation hints, and composite kinds (`items` for arrays, including **array-of-rows** when `items` is an object; `properties` for nested objects; `enum` renders a select). The dashboard config form renders them recursively, and secret redaction/restore now recurses so a `secret` field at any depth is masked on read and preserved on an unchanged write. (#439)
- Plugins: a plugin may ship a **sandboxed-iframe config editor** via manifest `configUi { entry, height? }`. The host serves the entry over an authenticated `GET /plugins/:id/config-ui` (ADMIN, path/realpath escape-guarded, CSP-sandboxed) and the dashboard injects it as an `srcdoc` into a `sandbox="allow-scripts"` iframe (opaque origin). The editor exchanges config over a `postMessage` bridge — the API key never enters the iframe, and it only ever receives schema-declared, secret-redacted config. (#440)
- Plugins: **per-session config overrides**. A session-scoped plugin can carry per-session config on top of its base (`'*'`) config via `PUT /plugins/:id/config/:sessionId`; `ctx.config` (read inside a hook) is the override shallow-merged over the base for the firing session, resolved race-safely via `AsyncLocalStorage` for both in-process and sandboxed plugins. Overrides are secret-redacted per slice on the API and survive a restart. (#441)
- Plugins: per-session activation. A session-scoped plugin can now be activated for all numbers (`*`) or an explicit set of sessions via `PUT /plugins/:id/sessions`, and only receives hook events for the sessions it is active for (enforced at delivery). A plugin declares `sessionScoped` in its manifest (default `true`); a global plugin (`false`, e.g. a metrics logger) always runs. The active set is surfaced on the plugin API and survives a restart. (#438)
- Plugins: a new `ctx.net.fetch` capability lets a sandboxed plugin make outbound HTTP through the host's SSRF guard (resolve-once-pin, redirects refused), gated by a `net:fetch` permission plus a manifest `net.allow` host allowlist (`host:port`, bare `host`, or `*` for any public host; internal IPs are always blocked). Responses are bounded by a timeout and a streamed size cap. (#437)
- Chats: opening a conversation now shows its recent history. The dashboard backfills messages directly from WhatsApp when the gateway has none stored yet and merges them with locally-persisted messages, so a freshly connected session shows the conversation instead of an empty thread.
- Engine (whatsapp-web.js): a reconnect that stalls mid-authentication now self-heals — the stale local auth is cleared and a fresh QR pairing is started — and the WhatsApp Web build can be pinned via `WWEBJS_WEB_VERSION` for environments where the auto-selected build drifts.
- Dashboard: a searchable plugin catalog, audit-log CSV export across all pages (not just the current view), the running version shown in the sidebar, and an engine-aware engine-configuration dialog (Baileys no longer shows Puppeteer-only fields).

### Changed

- Dashboard, small screens: the chat view is now a single-pane list → conversation flow with a back control instead of a cramped two-pane; page headers place the description directly under the title; and keyboard focus is a consistent, cross-browser, keyboard-only ring. Plus assorted copy and empty-state refinements.
- Plugins (install): install-from-URL / catalog downloads now follow CDN redirects safely — each hop is re-validated through the SSRF guard — so plugins published on GitHub Releases install correctly.

### Removed

- ⚠️ **Breaking:** the bundled reference extensions `auto-reply` and `translation` have been removed from core. They are superseded by the marketplace plugins **`chat-flow`** (interactive auto-reply) and **`group-translate`** (LibreTranslate group translation), which target the v0.7 contract. **Upgrade:** if you had either enabled, install the replacement from the dashboard (Plugins → Catalog, or `POST /plugins/install-url`) and re-enter its config. The ids `auto-reply` / `translation` remain reserved (an uploaded package can't claim them). Built-in **engines** (whatsapp-web.js, Baileys) are unaffected.

### Fixed

- Plugins: an operator's per-session activation (and now per-session config) was silently dropped from the on-disk registry on the second restart, because the registry entry was rebuilt on each load without carrying those fields. Both are now preserved across restarts. (#441)
- Docker: the multi-arch image build failed on `linux/arm64` (`Cannot find module lightningcss.linux-arm64-gnu.node`) — the builder stage was QEMU-emulated per target and the emulated arm64 install couldn't fetch lightningcss's (Vite's native CSS minifier) arm64 binary. The builder, which only produces arch-independent artifacts, is now pinned to `$BUILDPLATFORM` so it runs natively; per-arch runtime deps still install in the target-platform stage. Restores `linux/arm64` GHCR publishing.
- Inbound media is now size-capped before the full attachment is buffered into memory, on both engines, and concurrent inbound media downloads are bounded — lowering peak memory under bursty load.
- Plugins: composite (object/array) config fields marked `secret` are now fully masked when read back; plugin storage files and directories are created with owner-only permissions; and several runtime robustness fixes (timeout, validation, and error handling) in the sandbox and installer.

### Security

- Session scope is now enforced on the session-statistics overview and on per-session plugin activation, so an API key restricted to specific sessions can no longer read or change state for sessions outside its scope.

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
  _entire_ address book / group / chat set into one response — a heap/GC hazard for very large
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
filter, and its contact/chat _listing_ ids are now engine-neutral (`@c.us`). **Webhooks:** message
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

- **Baileys engine: contact and chat _listing_ ids are now engine-neutral (`@c.us`).** `getContacts` /
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
  - entry-count cap); storage-key containment is enforced at the backend-agnostic boundary so the S3 path
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

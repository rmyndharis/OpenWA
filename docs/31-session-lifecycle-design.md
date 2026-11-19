# 31 — Session Lifecycle: Invariant Catalog

> **Status:** living design note. This document maps the race windows the session lifecycle
> defends against to the code that defends them and the spec that pins each one. It is the
> companion to `docs/03` §_Engine Lifecycle State Machine_, which describes the WHAT; this
> describes the WHY-NOT-THE-OBVIOUS-THING. Anchors reference **spec files by name** (stable) —
> not line numbers (they rot).

The lifecycle is split across three files with one rule each:

| File                                                                                | Owns                                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `session-engine-lifecycle.service.ts`                                               | Engine creation/initialization, status transitions, the reconnect loop (`executeReconnect`), teardown |
| `session-engine-controls.ts`                                                        | The seven control verbs (start/stop/logout/forceKill/delete/shutdown/stopOrphanEngines)               |
| `session-ownership.service.ts` + `src/modules/takeover/session-takeover.service.ts` | Cross-node leases, adoption, orphan reaping                                                           |

---

## 31.1 The invariant catalog

Each entry: the interleaving that would break a naive implementation → where it is defended →
which spec pins it. **If you change one of these files, re-read the rows that cite it.**

### INV-1 — Double-start cannot orphan the first engine

**Interleaving:** two `POST /start` for the same session race; both pass the "not already
starting" read; two engines come up; one is leaked forever (registry holds the second).
**Defense:** `initializingSessions` is reserved SYNCHRONOUSLY (before any `await`) in
`session-engine-controls.ts` — the second request observes the reservation and fails fast.
**Pinned by:** `session.service.spec.ts` (the maxConcurrent/double-start cases, incl. the concurrent-start
claim-holding verbs at
`'%s() keeps the claim when a concurrent start still holds the session here'`).
**The naive fix that is wrong:** checking session.status instead — status is written to the DB
and read back with an await in between; the reservation map is the only synchronous view.

### INV-2 — INITIALIZING is persisted before `initialize()`, and retirement can await that write

**Interleaving:** a stop/logout lands while `initialize()` is in flight; the control sees status
`READY` (stale) and skips teardown of an engine that is actually mid-boot.
**Defense:** the INITIALIZING row is written and its promise tracked
(`session-engine-lifecycle.service.ts`, `initializeEngine`); a retiring control awaits the
pending write before deciding what it is retiring.
**Pinned by:** `session-initial-status-commit-order.spec.ts`, where the INITIALIZING update commits only
after stop, logout, forceKill and delete have begun, and each verb's own write must still land last
(it fails if the verbs stop awaiting the pending write). `session-initial-status-retirement.spec.ts`
pins the other half: a late INITIALIZING reply announces nothing once its engine has retired.

### INV-3 — Ownership is re-validated by object identity, not by session id

**Interleaving:** control A starts engine #1; engine #1 fails and is destroyed; control B (a
retry) starts engine #2; a stale callback from #1 arrives and mutates registry state owned by #2.
**Defense:** `EngineRegistry` keys by session id but validates liveness by object identity
(`isLive` / `deleteIfLive`) — a superseded engine's late callback cannot act. One report is the
exception: a superseded engine's terminal unlink (LOGOUT, UNPAIRED, UNPAIRED_IDLE, Baileys `logged out`)
needs neither the engine nor the row, so it is still recorded (the audit row, the phone clear, the
`session.disconnected` announcement). It changes no registry state, and it is skipped while a local
replacement engine is READY.
**Pinned by:** `engine-registry.service.spec.ts` (isLive / deleteIfLive cases); the registry
is the single most repeated invariant in the module. The unlink exception is pinned by
`session-unlink-retired-engine.spec.ts`.

### INV-4 — Init timeout evicts and 504s; init rejection propagates as FAILED

**Interleaving:** whatsapp-web.js calls `page.goto(..., {timeout: 0})` — a hung browser never
rejects, and neither does a navigation that never completes because WhatsApp Web is unreachable, so
a plain `await` hangs the start forever. The engine's own `authTimeoutMs` poll does not cover that
case: whatsapp-web.js only starts it in `inject()`, after the page has loaded.
**Defense:** `Promise.race` deadline in `initializeEngine`; on timeout the engine is evicted +
force-destroyed + status DISCONNECTED + 504 to the caller; a reconnect's own attempt instead leaves the row
INITIALIZING with the timeout as `lastError` until its next attempt. The eviction, the recorded error and the
DISCONNECTED write apply only while that engine is still the live one: a stale deadline (a stop +
start replaced it mid-init) force-destroys its own engine and 504s, and leaves the replacement alone.
The DISCONNECTED write also lands only on a row whose `nodeId` is this node's or empty: a deadline that
fires while the teardown of a lease lost during the init is still running leaves the row to the peer
that adopted it (INV-6).
A REAL rejection is NOT treated as a timeout: it propagates so `start()` records FAILED with the
reason.
**Pinned by:** `session.service.spec.ts` (start failure-path cases; the timeout/rejection
split lives in `session.service.spec.ts`'s init-timeout describes);
`session-init-timeout-after-lease-loss.spec.ts` for the lost lease.
**Do not "simplify" the two paths into one** — the distinction is why a bad proxy config returns
FAILED + reason while an init that never completes returns 504 + eviction.

### INV-5 — Delete racing a start re-purges auth directories after init resolves

**Interleaving:** delete runs (purges dirs, removes the session's messages, outbox rows and
delivery failures in batches, then the session row and its other child rows in one
transaction); the in-flight start's `initialize()` resolves and re-creates the auth dir; a phantom
session lingers on disk.
**Defense:** the post-init guards in `start()` (`session-engine-controls.ts`) and `executeReconnect`
(`session-engine-lifecycle.service.ts`) call `isSessionRetired`, which treats a stop mark or a missing
row as retired (delete clears its mark before a slow init resolves), then tear down the
just-registered engine and re-purge with `purgeAuthDirsIfDeleted`.
**Pinned by:** `session.service.spec.ts` ('re-purges the auth dirs when a start completes after its
row was deleted (init re-created them)' for `start()`, and 'tears down an engine created when a
delete lands during init (session row gone, mark cleared)' for `executeReconnect`). The opposite half,
that a stop retirement does not purge, is pinned by 'tears down the just-initialized engine if a
stop/delete lands during start() (no resurrection to READY)'.

### INV-6 — Lease loss tears down local engines only; it never writes session rows

**Interleaving:** node A holds session X's lease; node B adopts it after A's lease lapses; a
stale in-flight write from A would clobber B's status.
**Defense:** on lease loss, `stopOrphanEngines` destroys local engines; the session row is the
owning node's alone (`session.service.ts` boot path). Five writes are exceptions, each under a
predicate. The takeover sweep's `markLapsedDisconnected` marks a row disconnected only under the
predicate it read (same `nodeId`, same status, lease expired more than two TTLs ago, and for a
`qr_ready` row still no phone), so a row B has claimed, or a pairing that completed meanwhile, matches
nothing. A `qr_ready` row with a phone is never marked: the adoption sweep would take the resulting
disconnected row over. And a start or reconnect whose post-init read finds its claim gone retires the
engine it launched through `retireLaunchedEngine` (`session-engine-controls.ts`): the engine's own
DISCONNECTED report is held back, because the in-memory ownership it is fenced on still lists the
session until the next heartbeat, and the verb writes DISCONNECTED only on a row whose `nodeId` is this
node's or empty, so a row B has claimed keeps B's status. The init deadline's DISCONNECTED (INV-4) is
written under that same predicate: it can fire while `stopOrphanEngines` is still tearing the engine
down, after B adopted the row. So is the phone clear of a WhatsApp unlink reported after its engine was
retired (`reportUnlinkWithoutRow`): a launch retired for its lost claim can still report the unlink its
cleanup was finishing, while the in-memory ownership that write is also fenced on has not caught up. Last,
a start that fails or is refused with no engine left here (a
takeover adoption whose launch fails, say) releases its claim and then writes DISCONNECTED only on a
row that no node holds and that still has an active status: a row no node holds is revisited by
neither `markLapsedDisconnected` nor the adoption sweep, so the READY a vanished node left on it would
otherwise stand until a boot, and any claim since sets `nodeId`, so a row B claimed matches nothing.
The writes an engine's own reports make are not among the five: the row write of `handleEngineReady`, the DISCONNECTED
of `handleEngineDisconnected` and the INITIALIZING of `initializeEngine` go by id, so an engine that still runs on a
node whose lease lapsed can write onto the row of the node that adopted the session until the heartbeat's teardown
reaches it, within one interval; a stale READY or INITIALIZING is reset by the boot reset and the correction of a
lapsed claim, but a wrong DISCONNECTED is not, and stays until the adopter's engine next reports a state or its node
restarts.
Four writes change the binding of a session: the unlink's clear, the number and push name a READY links, the
push name an engine syncs after it, and the clear of a logout. The first three are not awaited by their issuer;
the logout awaits its own. They are issued one after another per session, so the database receives them in the
order they were issued, and a row read that acts on the session's phone (the disconnect handler's reload, the
second read of a start) must not return the binding they replace: it starts once the writes this process issued
have been answered and is repeated when another is issued while it runs (`session-phone-writes.ts`). A write
that is not answered holds up the ones behind it for five seconds at most, and a read that finds them
unanswered for that long fails: the disconnect handler reads again shortly, and a start fails with it. A READY writes its status and times at once and only its
number and push name join this order, so a stop or a failure that follows it is not overwritten by a write
that was waiting; the synced push name joins it too, so the empty name of the READY row cannot land after it.
The logout issues its clear in the step that removes its engine from the registry, before a start can find
the registry empty. Both readers also compare the binding epoch they took before reading with the one at the
moment they use the row, since an unlink recorded in between clears a binding the row still shows. The snapshot
a reconnect episode starts its next attempt from follows the binding in both directions: an unlink clears its
phone, and an accepted READY sets it, so an attempt that linked an account and then failed is retried with it.
**Pinned by:** `src/modules/takeover/session-takeover.service.spec.ts` +
`session-ownership.service.spec.ts` + `session-ownership-status-fence.spec.ts` +
`session-failed-write-ownership-fence.spec.ts` for the FAILED writers outside the wiring + the real-database
predicate spec for `markLapsedDisconnected` in `src/modules/session/session.service.spec.ts` +
`session-retired-start-leaves-peer-row.spec.ts` for the retired launch +
`session-init-timeout-after-lease-loss.spec.ts` for the init deadline +
`session-unlink-retired-engine.spec.ts` for the unlink's phone clear +
`session-reconnect-stale-binding.spec.ts` for the reads that wait for it +
`src/modules/takeover/session-takeover-failed-adoption.spec.ts` for the failed start. That
`stopOrphanEngines` itself writes no row is pinned by `session-delete-claim.spec.ts` ('retires an old
local engine after a peer takes over and a fresh claim fails with SQL error %s'), where the peer's
claimed row must still read as the peer's own start left it.

### INV-7 — FAILED sessions are deliberately NOT adopted by takeover

**Interleaving:** a session that failed on node A (real engine error) would be adopted by node B
and quietly retried, hiding the failure from the operator.
**Defense:** the adoption sweep skips FAILED rows — a human decides.
**Pinned by:** `src/modules/takeover/session-takeover.service.spec.ts` ('skips sessions not
worth resuming: unauthenticated, mid-pairing, or operator-flagged failed').

### INV-8 — Logout teardown races nothing: the browser must be gone before dir removal

**Interleaving:** `client.logout()` chains `authStrategy.logout()` → `fs.rm(userDataDir)` while
the Chromium process still holds file handles → rm fails or races a browser re-write.
**Defense:** whatsapp-web.js's own `Client.logout()` closes the browser and polls up to ~1 s for it
to disconnect before LocalAuth removes the profile dir. OpenWA's part is the name-keyed
credential-teardown fence: `teardownEngineSafely` registers the whole `engine.logout()` promise under
the session name, and `start()`, `delete()` and `executeReconnect` wait for it through
`awaitPendingTeardown` (bounded at 10 s and fail-closed: a timeout is a 409 for `start()`/`delete()`
and a failed attempt for a reconnect), so no new engine or purge races the rm.
**Pinned by:** `logout-teardown-race.spec.ts`, which enumerates that fence's interleavings. Read it
before touching anything in the logout/forceKill path. The `executeReconnect` wait is pinned by
`session-delete-claim.spec.ts` ('keeps a reconnect awaiting teardown when the old start returns from
its %s').

### INV-9 — The reconnect loop bounds itself: backoff with jitter, clamp ≤ 5 min and ≤ setTimeout's 32-bit range, alert every 5 consecutive attempts

**Defense:** `reconnect-policy.ts` — a pure decision function (attempt budget, loop alerts)
consumed by the lifecycle, which resets the budget only when the session held READY for
`STABLE_READY_MS` (5 min) before its next drop or its next READY, so a session that flaps keeps
backing off and still alerts. The stretch ends where the engine first reports a non-READY state
(`readyEndedAt`), so a Baileys in-engine reconnect between two READYs is not counted as READY time;
the clamps exist because a naive `delay * 2^attempt` reaches values
`setTimeout` silently truncates, and overflows to `Infinity` on a long enough streak.
**Pinned by:** `reconnect-policy.spec.ts`, `session.service.spec.ts` (scheduleReconnect cases).

### INV-10 — Boot auto-start is sequential, staggered (2s per Chromium), and detached from bootstrap

**Why:** ten Chromium instances launching simultaneously on boot would hold the HTTP port closed
for minutes; detaching from bootstrap means the API answers while engines warm.
**Pinned by:** `session.service.spec.ts` (boot auto-start ordering/staggering cases; the stagger by
'waits the full throttle between two auto-started launches').

### INV-11: Overlapping requests for one session on one node never read as a peer holding it

**Interleaving:** two or more requests for one session (starts, deletes, stops) begin within milliseconds. Their
claims overlap: the ones that renew while another claim is in flight take generations in the order their replies
arrive, not the order they began in, and a claim whose generation was replaced must not let its older SQL reply
replace the newer ownership. Read as "a live peer holds the session", a claim that answered `false` for that reason
answered 409 "running on another node" with no other node in the deployment, left the request undone, and could
leave a later request's claim behind for a peer's takeover sweep to adopt. The record of a stop of a session whose
holder's lease lapsed read its writes the same way: another stop cleared the row, or this node's own start took it,
between the stop's writes, and the stop whose last write then matched nothing answered the same 409.
**Defense:** only a peer's live lease makes that answer.

- `claim()` answers a claim whose generation was replaced as the claim that took the newest generation (registered
  when it takes the generation, not when it begins) and with its error, and once that claim has settled as whether a
  claim of this node stands. A release or a loss that ended the claim answers `false`. Any number of overlapping
  claims therefore answer `true` when no other node holds the row and none is ended by a release. They share the
  newest generation, so the request that ends first leaves the claim to the ones still running and the last one out
  releases it.
- `claimUnlessHeldElsewhere` (`session.service.ts`) leaves the 409 of a start and a delete to a miss that
  `isHeldByOtherNode` confirms (another node on a live lease); otherwise, the claim having been ended by a release,
  it asks once more and writes the row nobody holds.
- `keepDown` (the record of a stop) does the same for its writes: a row none of them could take is a peer's only when
  `isHeldByOtherNode` says so. Otherwise the row changed under them, and they run again, at most five passes; a row
  still unwritable after that is logged and the stop goes on, so a stop never answers that another node holds a
  session none does.

A takeover of a lapsed holder is followed up by the claim whose write made it, before that claim reports itself
superseded: the later claim reads this node as the previous holder and would not.
**Pinned by:** `session-ownership-claim-schedules.spec.ts` (every schedule of two and three claims over a free row,
a row this node holds and a lapsed holder's, sampled schedules of four, and of three and four starts or deletes as
`claimUnlessHeldElsewhere` asks them; a live peer refusing all of them), `session-delete-claim.spec.ts` ('two
claims of one session that overlap': a start and a delete in either order, two and three requests, a live peer
refusing every pair; 'stops of one session whose holder lapsed': two and three stops, a stop beside a start and
beside a delete, a live peer; the 'older claim SQL reply' cases for a claim lost and regained) and
`session.service.spec.ts` ('ownership release': the second ask and its refusals).
**The naive fixes that are wrong:** guessing a self-overlap from request state (another delete not yet returned, a
second start reservation): a pair of the other kind, or a partner that has already returned, still answered the
false 409. Asking again a fixed number of times: it absorbs about as many overlapping claims as it asks, so three
requests still answered it.

### INV-12: A release of a session by this node and a claim of it by this node never overlap

**Interleaving:** a stop, a logout, a force-kill or a start that failed hands its claim back. The release ends the
claim in memory at once and clears the row where it names this node. A request for the same session that begins while
that statement is still writing (a delete, a start) takes a new generation and writes the row, which names this node
too. Were its write to land first, the release cleared the row of a claim this node holds: the delete's owner update
matched nothing and answered 409 "no longer owned by this node", a start was refused as stopped or had its engine torn
down by the next heartbeat, and a peer could take a session this node was about to run, with no other node in the
deployment to blame. On PostgreSQL the two statements go out on different connections, so the order they land in is
not the order the requests began in. The delete fences its removal on the time the row was claimed that it read, so a
second claim of this node that rewrote that time under it (overlapping claims of one session each write the row)
answered the same 409.
**Defense:** the row is cleared before a claim of this node writes it, and a claim of this node does not move the time
a row was claimed while the row names this node.

- `release()` without a captured claim and `releaseAll()` register themselves per session in the step that begins them
  (`releasing`), and `claim()` waits for every release registered for its session before it reads its own state. The
  registration ends with the release, failed or not. A release waits for no claim and nothing is held across an engine
  start, so the wait cannot close a cycle. A claim that began before the release is the release's to end, as before.
- The release a delete makes with its captured claim is fenced instead: under the row lock it checks that the claim it
  captured still stands, and a start that reserved the session since makes it do nothing.
- The claim write keeps `claimedAt` when the row already names this node (`CASE WHEN "nodeId" = :me`), so it changes
  only when the row was free or another node's. A delete that read it keeps the claim it read.

**Pinned by:** `session-ownership-claim-schedules.spec.ts` (every schedule of one release, or two, or a shutdown
release, and one claim or two, over a free row, a row this node holds in memory and in the database, and one only the
database says it holds; a lapsed holder's row, whose takeover is followed up once; a live peer's, which refuses every
claim), `session-ownership.service.spec.ts` (the `claimedAt` rules, the bookkeeping after a release that failed) and
`session-delete-claim.spec.ts` ('a request that begins while the claim is being handed back': a delete and a start
beside a stop, a logout, a force-kill and a start the engine refused; a claim of this node that writes the row after a
delete read it).
**The naive fixes that are wrong:** guarding the release statement on the lease or the time it knew. A heartbeat tick
that began before the release extends the lease after it, so the guarded release matches nothing and leaves a claim no
one renews, for a peer's takeover sweep to adopt a session the operator just stopped; and a time stamp is only as exact
as the clock. Having the release wait for the claims in flight as well: each would then wait for the other.

---

## 31.2 Status-transition ownership

Every transition has a known, enumerated set of writers. When debugging a status surprise, find the
writer before anything else:

| Transition                      | Writers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| → `INITIALIZING`                | `initializeEngine` (persisted before `initialize()`), engine-reported `INITIALIZING` via `onStateChanged` (ownership-fenced; Baileys while connecting and through its own reconnect after a drop)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| → `QR_READY` / `AUTHENTICATING` | engine callbacks (wired in the lifecycle delegate), via the registry's liveness check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| → `READY`                       | `handleEngineReady` (also drops a recorded failure reason, see INV-7's rationale comment), engine-reported `READY` via `onStateChanged` (ownership-fenced; both engines report it next to `onReady`; skipped for a link the account binding refuses, which `rejectRebind` lands in `FAILED`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| → `DISCONNECTED`                | init-timeout eviction of a start (own or unowned row only, INV-4), graceful stop, logout, forceKill, a delete whose teardown fence times out, the engine `onDisconnected` callback and the liveness watchdog (`handleEngineDisconnected`), the boot reset, a backup import (active rows restored as disconnected), engine-reported `DISCONNECTED` via `onStateChanged`, the takeover sweep's `markLapsedDisconnected` (INV-6), a start or reconnect retiring the engine it launched (`retireLaunchedEngine`, own or unowned row only, INV-6), a failed or refused start that left no engine here, on the row it released (still-active status only, INV-6), a start whose transient-failure retry shutdown refused (`session.service.ts` hands a `FAILED` row it may claim back as `DISCONNECTED` for the next boot) |
| → `ACTION_REQUIRED`             | engine-reported `ACTION_REQUIRED` via `onStateChanged` (ownership-fenced status write; the whatsapp-web.js onboarding-modal fallback), and `onActionRequired` records the reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| → `FAILED`                      | five terminal paths only, all ownership-fenced: see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`FAILED` is the one worth spelling out, because it is terminal (neither the boot reset nor the
takeover sweep resumes a FAILED row, INV-7) and because more than one path reaches it:

1. `start()`'s own rejection path, when `initializeEngine` throws (`session-engine-controls.ts`).
2. The engine's `onError` callback, which is terminal by definition: it cancels any pending
   reconnect before persisting, because a re-scan is required (`session-engine-event-wiring.ts`).
3. The engine reporting `EngineStatus.FAILED` through `onStateChanged`, which the status map
   forwards verbatim (`session-engine-event-wiring.ts`).
4. A reconnect chain that EXHAUSTS its attempts, so the session is not left silently stuck
   `DISCONNECTED` with no engine (`session-engine-lifecycle.service.ts`).
5. `rejectRebind`, when a different WhatsApp account scans a bound session's QR: it logs that account
   out and lands `FAILED` with the reason (`session-engine-lifecycle.service.ts`).

What still holds, and is load-bearing, is the narrower claim: no reconnect ATTEMPT writes FAILED.
Only the exhaustion of the whole chain does. A loop that marked each failed attempt would turn every
transient network blip into an operator-visible terminal state and defeat INV-7's signal. All five
paths are fenced on `ownsSession`, so a dying generation cannot park a peer's session in a status
nothing resets automatically. The two wiring paths (2 and 3) share one fence, pinned by
`session-ownership-status-fence.spec.ts`; the other three are pinned by
`session-failed-write-ownership-fence.spec.ts`, which drives the real lifecycle.

## 31.3 Comments that exist because the obvious fix is wrong

Collected here so they survive refactors of the code around them:

- `session-engine-lifecycle.service.ts` (init deadline region): the do-not-reorder note — the
  ownership re-validation window between the status write and `initialize()` is _narrowed, not
  closed_; moving the re-validation after init reopens INV-2.
- `session-engine-controls.ts` (start): the reconnect knobs read from the client-writable
  `session.config` are coerced and clamped by `resolveReconnectConfig`, so a poisoned value cannot
  become a NaN delay (a zero-delay relaunch storm) or a NaN attempt cap that never trips.
- `EngineRegistry`: identity-based `deleteIfLive` rather than `delete(id)` — see INV-3; every
  site that bypassed this in the past created the same phantom-callback bug. The eviction
  helpers go through it too: `evictAndForceDestroy`, the init-timeout branch, and `start()`'s catch.
  `start()` identifies its own engine by capturing the registry entry right after calling
  `initializeEngine` (which registers it before its first await), not by a lookup in the catch: a
  mid-init disconnect can schedule a reconnect that registers a replacement first.

## 31.4 What this document is NOT

- Not a state machine diagram (docs/03 has it).
- Not exhaustive per-file documentation — the source comments carry the local detail; this maps
  the SYSTEM of invariants and where each lives.
- Not a spec: where this document and a spec disagree, the spec is right — fix this document.

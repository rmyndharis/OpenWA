# OpenWA Split-Plane Refactor — Change Document

**Branch:** `refactor/control-plane` · **PR:** [backend-platform/OpenWA#1](https://github.com/backend-platform/OpenWA/pull/1)
**Date:** 2026-08-22 · **Scope:** 72 files, +6,098 / −3,970 lines
**Verified:** 5,857 unit tests · 265 docs/coverage-gate tests · 177 e2e tests · lint · OpenAPI, Helm-chart, migration-drift and dependency-audit gates · live two-node exercise on shared Postgres + Redis

---

## 1. Why this refactor happened

OpenWA is the WhatsApp channel behind LowcoAI CRM. Three operational problems drove this work:

| # | Problem | Root cause |
|---|---------|-----------|
| 1 | **A service restart reconnected every session at once, spiking RAM**, and warm-up time grew linearly with session count | Boot restore was strictly sequential — one launch at a time, a 2 s pause between launches, and a ≥ 60 s init deadline per engine, all inside the same process that serves the API. 50 sessions ≈ 50 minutes of warm-up. |
| 2 | **The service could not run more than one replica** | Sessions lived in an in-process `Map`; WhatsApp credentials lived on local disk; the API-key store was a hard-coded per-node SQLite file; every safety fence was single-event-loop state. The Helm chart literally said `replicaCount` MUST stay 1. |
| 3 | **Autoscaling was impossible** | Even if replicas had been allowed, sessions were not *portable*: adopting a session on another node meant re-pairing (a human scanning a QR), readiness probes said nothing about session capacity, and there was no way to drain a node gracefully. |

The redesign principle: **separate the control plane (what should run where) from the data plane (the engines actually running)**, and reuse the lease/takeover/proxy machinery the codebase already shipped as the scheduling substrate — extend it, don't replace it.

---

## 2. The architecture, before and after

**Before** — one process is everything:

```
┌──────────────────────────────────────────────┐
│  ONE NestJS PROCESS (replicas: 1, enforced)  │
│  REST API + dashboard + MCP + webhooks       │
│  + ALL WhatsApp engines (in-process Map)     │
│  + credentials on local disk                 │
│  + API keys in per-node SQLite               │
└──────────────────────────────────────────────┘
```

**After** — three roles from one codebase (`ROLE=all` keeps the old shape exactly):

```
                     one base URL (SDKs unchanged)
                                │
              ┌─────────────────▼──────────────────┐
              │   ROLE=api  (Deployment, N pods)   │   stateless — NEVER
              │   REST + dashboard + MCP + infra   │   constructs an engine
              │   webhook dispatch + reconcilers   │
              └───────┬────────────────────────────┘
        writes desiredState │           ▲ one-hop proxy to the owner
                            ▼           │ (QR, sends, chats…)
              ┌─────────────────────────┴──────────┐
              │  ROLE=worker (autoscaled pods)     │   claim loop adopts
              │  WhatsApp engines + claim loop     │   runnable sessions,
              │  proxied session-scoped routes     │   bounded by capacity
              └───────┬────────────────────────────┘
                      ▼
   ┌────────────────────────────────────────────────────┐
   │ SHARED: Postgres (sessions + leases + generations  │
   │ + desiredState + Baileys auth state + api_keys)    │
   │ Redis (queues, WS fan-out, ordering locks) · S3    │
   └────────────────────────────────────────────────────┘
```

---

## 3. The changes, one by one

Each entry answers: **what** changed, **why**, and the **purpose it serves**.

### 3.1 Role partition — `ROLE=api | worker | all`

**What.** A `ROLE` env var partitions the NestJS module graph at boot (`app.module.ts`). `worker` loads the engine runtime, session-scoped routes, health and drain — but no dashboard, MCP, infra-config, data import/export or Docker orchestration. `api` loads the full REST/dashboard surface but is structurally engine-free: the auto-start flag is forced off for it, the takeover module isn't loaded, and `start()` takes a different path (§3.2). `all` (the default) is byte-for-byte the historic single-container behavior. The node-drain endpoint moved into its own `InfraNodeModule` so every role keeps it.

**Why.** The API surface and the engine runtime have opposite scaling laws: API load scales with request traffic, engine load with session count. Fused in one process, you cannot scale one without paying for the other — and every deploy of a dashboard tweak restarted every WhatsApp socket.

**Purpose.** API pods become fungible and cheaply replicated behind a load balancer; worker pods can be sized and scaled by session capacity; business-logic deploys stop touching live sessions.

### 3.2 Desired-state scheduling + the reconciling claim loop

**What.** A new `sessions.desiredState` column (`'running' | 'stopped'`, migration with behavior-preserving backfill) records operator *intent*, distinct from the observed `status`. `start()` sets it; `stop()`/`logout()`/`forceKill()` clear it. On an api pod, `start()` writes intent and waits (bounded, one sweep interval + slack) for a worker to claim. The takeover sweep (`SessionTakeoverService`) was generalized from a crash-recovery tool into a **desired-state reconciler** with two feeds: sessions whose holder's lease lapsed (crash adoption — unchanged eligibility rules) and *runnable sessions nobody holds* — including unpaired ones (that QR is how api-plane pairing reaches a worker at all) and ones stranded under this node's own previous identity. Adoption is capacity-bounded by `MAX_CONCURRENT_SESSIONS`.

**Why.** Distributed orchestration by RPC ("api pod tells worker X to start Y") needs a scheduler, worker discovery, and retry logic for every failure mode. Reconciliation needs none of that: workers converge "should be running, isn't running anywhere" on a loop, whatever put the row in that state — crash, drain, failed launch, or an api pod recording intent. The claim's conditional UPDATE already makes races safe.

**Purpose.** This *is* the control plane: placement without a scheduler service, automatic retry of failed launches, and — as a welcome side effect — a deliberate stop finally survives a restart (previously boot auto-start relaunched every authenticated disconnected session, stopped or not).

### 3.3 Portable Baileys sessions — `BAILEYS_AUTH_STORE=database`

**What.** A new `baileys_auth_state` table (keyed `sessionName / keyType / keyId`, values stored exactly as the multi-file backend serialized them) plus `useDatabaseAuthState()`, a drop-in replacement for Baileys' `useMultiFileAuthState` that mirrors its semantics precisely — BufferJSON encoding, app-state-sync-key proto revival, delete-on-null, sanitized key ids. The first database-mode start **imports an existing multi-file directory automatically** (disk files kept as fallback); logout/delete purge both backends; the rows ride the data export/import like every other table. Default stays `file`.

**Why.** Credentials on local disk were the #1 scaling blocker: a session could only ever run where its auth directory lived, so takeover on another node meant re-pairing — a human scanning a QR for every session, every failover. Baileys auth state is small, plain JSON; the database the nodes already share is its natural home.

**Purpose.** Sessions become *portable*: any worker sharing the data DB can start any session. This is the single change that makes workers fungible — and therefore makes autoscaling and zero-re-pair failover real. (Proven live: a replacement worker adopted a session and continued without a re-scan.)

### 3.4 Bounded-parallel boot restore — `SESSION_RESTORE_CONCURRENCY`

**What.** `autoStartSessions()` no longer launches strictly one-at-a-time. Launch *starts* still stay ≥ 2 s apart (spike protection, also paces failure storms), but up to N launches (default 3) ride out their ≥ 60 s init deadlines concurrently, via the codebase's existing `ConcurrencyLimiter`.

**Why.** The serialized restore was the direct cause of the restart pain: the time went into waiting out init deadlines back-to-back, not into actual work. The deadlines parallelize safely; only the instantaneous launch burst ever needed serializing.

**Purpose.** Node warm-up stops scaling linearly with session count. Raise the knob to 10–20 on Baileys fleets (no Chromium); keep it low on whatsapp-web.js hosts.

### 3.5 Session-aware operations — `GET /health/sessions` + `POST /infra/drain`

**What.** `GET /api/health/sessions` (public, counts only): this node's engines, assigned rows and per-state buckets, plus a `draining` flag. `POST /api/infra/drain` (ADMIN, unscoped key required): flips readiness to 503, tears down local engines, stops lease renewal and **forgets the claims without clearing them** — a new `abandonAll()` alongside `releaseAll()`, because a *released* row (`nodeId` NULL) is deliberately invisible to the takeover sweep, which is right for an operator stop and exactly wrong for a drain.

**Why.** The readiness probe deliberately checks only databases, so a pod reported Ready with zero sessions restored — an autoscaler or rollout gate had no signal at all. And there was no graceful way to take a node out of a fleet: killing it looked identical to a crash.

**Purpose.** Rollouts can gate on `ready` approaching `assigned`; drain watchers wait for `engines: 0`; scale-down becomes a `preStop` hook away from graceful — peers adopt within one lease TTL plus one sweep (proven live: drain → adoption by a second worker).

### 3.6 Shared auth store — `MAIN_DATABASE_TYPE=postgres`

**What.** The `main` connection (api_keys, audit_logs) — previously *hard-coded* SQLite — can now run on Postgres, with connection details defaulting to the data connection's, a dedicated `openwa_main` database, dialect-guarded migrations, and the same cross-replica advisory-locked boot the data connection uses. Synchronize is never used on Postgres. SQLite remains the zero-config default.

**Why.** With per-node SQLite files, each replica holds a *different* API-key store — a request forwarded from the api plane to a worker fails auth on arrival. Multi-node was impossible regardless of everything else.

**Purpose.** One key store, any number of nodes; audit trail in one place.

### 3.7 Time discipline — DB-clock leases, `useUTC`, and SQL-side liveness

**What.** On Postgres, every lease timestamp is computed on the *database's* clock (`NOW() + TTL` in SQL) for claim, renew, release and all liveness queries. All Postgres connections set TypeORM `useUTC: true` and pin the session `TimeZone=UTC`. The session proxy interceptor decides "is the owner's lease live?" via the ownership service's SQL predicate instead of comparing dates in JavaScript.

**Why (in two layers).** First: node wall clocks aren't trustworthy — skew larger than the lease TTL made healthy peers steal each other's sessions, silently. The shared database is the one clock every node agrees on. Second: the live test then exposed the deeper trap — `timestamp`-without-timezone columns holding naive UTC get parsed back in the *node's local timezone* by the driver, so an IST reader saw a live lease as 5.5 hours lapsed and refused to route. The rule that fixes the whole class: with DB-clock leases, comparisons happen in SQL or under an explicit UTC contract, never against a reader's local clock.

**Purpose.** Lease correctness no longer depends on NTP hygiene or on which timezone a pod happens to run in.

### 3.8 Fencing tokens — `sessions.leaseGeneration`

**What.** Every successful claim atomically increments a `leaseGeneration` column; the claimer caches its generation. `renew()` treats a row that still names this `nodeId` but carries a newer generation as **lost**, tearing the local engine down.

**Why.** `nodeId` defaults to the hostname, which a restart keeps — so `nodeId` alone cannot tell two incarnations of the same node apart. A GC-paused or half-dead previous process could keep renewing and writing as if it owned the session, putting **two engines on one WhatsApp account**: the split-brain the lease exists to prevent, through the one door it left open.

**Purpose.** Zombie writers are structurally rejected by the database, not merely made unlikely. Each claim is a distinct ownership epoch.

### 3.9 Claimed reconciler sweeps — one replay per pass, not per node

**What.** The webhook-outbox sweep and the ingress reconciler now *claim* each stranded row before replaying it — not with a lock, but with an optimistic compare-and-swap on the attempt count they observed (`UPDATE … WHERE id = ? AND attempts = ?`). The loser of a race sees zero rows updated and skips.

**Why.** Both sweeps were documented as deliberately claim-free — acceptable when replicas were forbidden, but under N api pods every stranded delivery would be replayed N times per pass. A held lock would have been worse (a holder can die mid-flight); the CAS has no such failure mode — a crashed claimer merely spent one attempt, and the still-pending row is claimed again next pass.

**Purpose.** At-least-once delivery is preserved end-to-end while duplicate replays stop multiplying with fleet size.

### 3.10 Distributed conversation ordering — Redis-backed `DistributedKeyedLock`

**What.** The integration fabric's per-conversation ordering lock (previously an in-process promise chain) gains a Redis-backed layer when `REDIS_ENABLED=true`: `SET NX PX` acquisition with jittered retry, a Lua compare-and-delete release (never frees a lock that expired and was re-acquired elsewhere), wrapped *around* the local chain (same-pod FIFO stays off Redis). Redis errors degrade to local ordering with a one-time warning; a hopeless wait fails the job into BullMQ's retry, keeping order protected.

**Why.** This was the one genuinely broken cross-pod invariant: BullMQ ingress workers run on *any* pod, so two pods could interleave dispatches for one conversation, reordering a customer's messages in the CRM.

**Purpose.** Conversation ordering holds across the fleet. (Deliberately *not* moved to Redis: send-pacing counters and automation cooldowns — they're per-session state, and the lease pins a session's hot path to exactly one node, so per-process is already correct. Documented inline so nobody "fixes" it later.)

### 3.11 Honest media storage — `STORAGE_STRICT=true`

**What.** In S3 mode, an S3 outage previously fell back to *silent local-disk writes*. Strict mode makes the write fail loudly instead (after one throttled recovery probe). Reads keep their local read-through. Default off.

**Why.** The silent fallback is a fine single-node convenience, but with several pods it shards media invisibly: a file written to pod A's disk doesn't exist for pod B, and nothing reports the split.

**Purpose.** In a fleet, storage degradation is an alert, not a slow-motion data-consistency incident.

### 3.12 Autoscaling signals — `openwa_node_*` Prometheus gauges

**What.** Three new gauges: `openwa_node_engines`, `openwa_node_sessions_assigned`, `openwa_node_session_capacity` (0 = unlimited). Documented in the metrics table docs/10 enforces.

**Why.** Engine load is session-shaped, not CPU-shaped — an HPA scaling workers on CPU would starve idle-but-connected fleets and overscale busy ones.

**Purpose.** `assigned / capacity` is the correct HPA custom metric for worker pools.

### 3.13 Supporting plumbing

- **Config & validation:** every new env var (`ROLE`, `SESSION_RESTORE_CONCURRENCY`, `BAILEYS_AUTH_STORE`, `MAIN_DATABASE_TYPE/HOST/PORT/USERNAME/PASSWORD`, `STORAGE_STRICT`) is documented in `.env.example`, boot-validated (typos fail fast rather than silently selecting a fallback), forwarded by both compose files, and registered in the blank-shadow list so an empty forward can't pin a value off.
- **Docs:** `docs/13-horizontal-scaling.md` §13.2 falsely claimed the lease/claim design was "not implemented" — corrected to describe the shipped mechanism. New endpoints documented in the API reference (docs/06); OpenAPI snapshot regenerated; CHANGELOG entries added.
- **Migrations:** four new, all idempotent — `AddBaileysAuthState`, `AddSessionLeaseGeneration`, `AddSessionDesiredState` (with a backfill that preserves pre-column behavior exactly), `CreateAuthAuditTablesPostgres` (dialect-guarded twin of the SQLite baseline).
- **Export/import:** the auth-state table has an explicit backup decision (exported + cleared-before-restore), keeping the "every table has a decision" parity gate honest — and a restore treats the archive as secret, since it now carries live WhatsApp credentials.

---

## 4. What the live two-node test proved (and the three bugs it caught)

The full lifecycle was exercised on shared Postgres + Redis: session created and started via the **api pod** → worker claimed it in 8.5 s → QR (7.2 KB PNG) served **through the api pod**, proxied to the worker's engine → worker drained (`stoppedEngines: 1`, readiness 503) → a **replacement worker adopted** the session after lease lapse (`leaseGeneration` 1 → 3) → routing followed ownership automatically.

Three defects no unit suite could see were found and fixed during this test:

1. **`ApiKey` entity hard-coded `type: 'datetime'`** — rejected by the Postgres driver, so main-on-Postgres couldn't boot. Fixed with a `mainDateColumnType()` helper that keeps the SQLite schema byte-identical.
2. **The timezone split-brain** described in §3.7 — the definitive argument for SQL-side lease comparisons.
3. **A reconciliation blind spot** — a runnable session held by *this node's own previous incarnation* on a lapsed lease sat in neither claim feed. The unclaimed feed now includes lapsed leases regardless of holder; `claim()` re-verifies atomically, so the widening cannot steal a live session.

---

## 5. Deployment guidance

**Single node (unchanged):** do nothing. `ROLE=all`, SQLite, local disk, file auth — identical behavior, plus the faster restore and the new health endpoint for free.

**Multi-node (LowcoAI production shape):**

| Setting | api pods | worker pods |
|---|---|---|
| `ROLE` | `api` | `worker` |
| `NODE_ID` / `NODE_URL` | — | stable id / reachable URL (**required** for routing) |
| `AUTO_START_SESSIONS` | — | `true` (enables the claim loop) |
| `DATABASE_TYPE` + `MAIN_DATABASE_TYPE` | `postgres` (both, shared server) | same |
| `ENGINE_TYPE` / `BAILEYS_AUTH_STORE` | — | `baileys` / `database` |
| `REDIS_ENABLED` | `true` | `true` |
| `STORAGE_TYPE` / `STORAGE_STRICT` | `s3` / `true` | same |
| `MAX_CONCURRENT_SESSIONS` | — | per-pod capacity (HPA denominator) |
| Scale-down | — | `preStop` → `POST /infra/drain` |

Existing sessions migrate without re-pairing: flip `BAILEYS_AUTH_STORE=database` and the next start imports the disk directory into Postgres automatically.

---

## 6. Deferred, deliberately

- **Durable event log (Redis Streams / EventLogPort):** additive, not required — Redis Socket.IO fan-out already relays worker events to api pods, and workers dispatch webhooks through the crash-safe outbox. Full design (consumer groups, replay, CRM cursor subscription, generation-fenced envelopes) is in the Part 2 architecture document.
- **Workers registry table** (heartbeat, drain flags, fleet dashboard): `/health/sessions` plus the gauges cover the operational need today.
- **whatsapp-web.js multi-node:** Chromium profiles are inherently non-portable; wwebjs sessions remain pinned-node workloads. Baileys is the scaling engine.

---

## 7. Summary

| Before | After |
|---|---|
| Restart = every session reconnects serially; warm-up O(N minutes) | Bounded-parallel restore; warm-up bounded by capacity, observable via `/health/sessions` |
| `replicas: 1`, enforced and documented | api plane scales horizontally; worker pools autoscale on `assigned/capacity` |
| Failover = re-pair every session by hand | Lease lapse → claim loop adoption, no re-pairing (database auth store) |
| Stop didn't survive restart; zombie processes could double-run an account | Desired-state intent + generation-fenced leases |
| N pods = N× webhook replays, interleaved conversations, sharded media, split key stores | Claimed sweeps, distributed ordering lock, strict S3, shared Postgres key store |

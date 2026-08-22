# Split-Plane Deployment: User Guide

How to run OpenWA with a separate **api plane** (stateless REST/dashboard pods) and **worker plane** (engine-hosting pods that autoscale). This guide is operational — for what changed and why, read [docs/32](./32-split-plane-refactor.md); for the design background, [docs/13](./13-horizontal-scaling.md).

**Who needs this:** anyone running more than a handful of sessions, wanting zero-downtime deploys of the API surface, or needing failover/autoscaling. If a single container serves you fine, you can stop reading — the default `ROLE=all` behaves exactly as before.

---

## 1. The three run modes

| `ROLE` | What the process does | Scaling model |
| --- | --- | --- |
| `all` *(default)* | Everything in one process — the historic single-container behavior | Vertical only |
| `api` | Full REST API, dashboard, MCP, infra/config, webhook dispatch. **Never constructs an engine.** | Horizontal, freely — stateless |
| `worker` | Hosts WhatsApp engines, answers proxied session-scoped calls, runs the claim loop. No dashboard/MCP/infra-config/Docker orchestration. | Horizontal, by session capacity |

How a session runs in split-plane mode: you call `POST /api/sessions/{id}/start` on any **api** pod → it records the intent (`desiredState = running`) → a **worker** with free capacity claims the session (within one sweep interval, default 30 s) and launches the engine → every later session-scoped call you make to an api pod (QR, send, chats…) is transparently forwarded to the owning worker. Your clients and SDKs keep one base URL and never learn the topology.

---

## 2. Prerequisites for split-plane mode

All four are hard requirements — each removes a piece of node-local state:

| Requirement | Setting | Why it is required |
| --- | --- | --- |
| Shared Postgres (data) | `DATABASE_TYPE=postgres` | Sessions, leases, desired state, messages — the coordination substrate |
| Shared Postgres (auth) | `MAIN_DATABASE_TYPE=postgres` | One API-key store; with per-node SQLite, forwarded requests fail auth |
| Database auth store | `BAILEYS_AUTH_STORE=database` + `ENGINE_TYPE=baileys` | Makes sessions portable — takeover without re-pairing |
| Redis | `REDIS_ENABLED=true` | Cross-pod WebSocket fan-out, conversation-ordering lock, queues |

Strongly recommended: `STORAGE_TYPE=s3` with `STORAGE_STRICT=true` (media on shared storage, outages fail loudly instead of silently sharding files onto pod disks).

> **whatsapp-web.js caveat:** Chromium profiles are not portable. `ENGINE_TYPE=whatsapp-web.js` sessions stay pinned to the node holding their profile directory — they get no takeover/autoscaling benefits. Use Baileys for split-plane fleets.

---

## 3. Deploying

### 3.1 Worker pods

```bash
ROLE=worker
NODE_ID=worker-1                     # STABLE across restarts (per pod; StatefulSet ordinal works)
NODE_URL=http://worker-1.workers:2785 # how api pods reach THIS pod — required for routing
AUTO_START_SESSIONS=true             # enables boot restore AND the claim loop
ENGINE_TYPE=baileys
BAILEYS_AUTH_STORE=database
MAX_CONCURRENT_SESSIONS=50           # per-pod capacity; the claim loop respects it
SESSION_RESTORE_CONCURRENCY=10       # parallel restore lanes (Baileys: 10–20 is safe)
DATABASE_TYPE=postgres  DATABASE_HOST=…  DATABASE_USERNAME=…  DATABASE_PASSWORD=…
MAIN_DATABASE_TYPE=postgres          # host/port/user/pass default to the DATABASE_* values
REDIS_ENABLED=true  REDIS_HOST=…
STORAGE_TYPE=s3  STORAGE_STRICT=true  S3_BUCKET=…  S3_ACCESS_KEY_ID=…  S3_SECRET_ACCESS_KEY=…
```

Notes:
- `NODE_ID` must survive restarts. If it changes on every boot, each restart looks like a new node and old leases must lapse before re-adoption (slower recovery, never incorrect — the `leaseGeneration` fence keeps stale incarnations out either way).
- `NODE_URL` must be reachable **from the api pods** (a per-pod DNS name — headless-service records work; a load-balanced service URL does NOT, since it must reach one specific pod).
- Workers still enforce API keys on their routes; forwarded requests carry the caller's key, and both planes share the key store via the main Postgres.

### 3.2 Api pods

```bash
ROLE=api
DATABASE_TYPE=postgres  …            # same shared databases as the workers
MAIN_DATABASE_TYPE=postgres
REDIS_ENABLED=true  REDIS_HOST=…
STORAGE_TYPE=s3  STORAGE_STRICT=true …
# No NODE_ID/NODE_URL needed; no AUTO_START_SESSIONS; no engine settings.
```

Put your load balancer / ingress in front of the api pods only. Workers need no public exposure — only pod-to-pod reachability from the api plane.

### 3.3 Kubernetes sketch

- **api**: `Deployment`, 2+ replicas, no volume, readiness `/api/health/ready`.
- **workers**: `StatefulSet` (stable names feed `NODE_ID`/`NODE_URL` via the downward API + a headless Service), no PVC needed in database-auth mode.
- **worker scale-down**: `preStop` hook →
  `curl -X POST -H "x-api-key: $ADMIN_KEY" localhost:2785/api/infra/drain`
  with `terminationGracePeriodSeconds` ≥ drain time. Peers adopt the drained sessions once the leases lapse (≤ `SESSION_LEASE_TTL_MS` + one sweep).
- **HPA**: scale workers on `openwa_node_sessions_assigned / openwa_node_session_capacity` (custom metric from `/api/metrics`), **not** CPU — engine load is session-shaped.

---

## 4. Running sessions day-to-day

Everything below goes through any api pod — the front door never changes.

```bash
# 1. Create
curl -X POST $API/api/sessions -H "x-api-key: $KEY" -H 'Content-Type: application/json' \
     -d '{"name":"customer-line-1"}'

# 2. Start — returns once a worker claims (usually seconds; bounded by one sweep interval + 5s).
#    Timing out is NOT failure: the intent is durable and the next sweep converges it.
curl -X POST $API/api/sessions/$ID/start -H "x-api-key: $KEY"

# 3. Pair — the QR is rendered on the owning worker, proxied through the api pod
curl $API/api/sessions/$ID/qr -H "x-api-key: $KEY"

# 4. Use it — sends, chats, contacts: all transparently routed to the owner
curl -X POST $API/api/sessions/$ID/messages/text -H "x-api-key: $KEY" \
     -H 'Content-Type: application/json' -d '{"to":"628123456789","message":"hello"}'
```

Semantics worth knowing:

- **`desiredState` is the operator contract.** `start` = "keep this running" (survives crashes, drains, restarts — the fleet converges it). `stop`/`logout` = "keep this down" (survives restarts too; nothing resurrects it). A `FAILED` session is never auto-adopted — it waits for an operator.
- **Webhooks/WebSockets are unchanged.** Webhooks fire from the owning worker through the shared crash-safe outbox; WebSocket events reach clients connected to any api pod via the Redis adapter.
- **First start after enabling `BAILEYS_AUTH_STORE=database`** imports the session's on-disk auth directory into Postgres automatically — no re-pairing. Disk files are left as a fallback; the database wins from then on.

---

## 5. Migrating an existing single-node install

Zero re-pairing, staged so each step is independently reversible:

1. **Move the data DB to Postgres** (if on SQLite): export via *Dashboard → Infrastructure → Export*, switch `DATABASE_TYPE=postgres`, import. (The export now includes the Baileys auth-state table; treat archives as secrets — they carry live WhatsApp credentials.)
2. **Move the auth DB:** set `MAIN_DATABASE_TYPE=postgres`, restart, re-create API keys (or export/import them). Verify logins before proceeding.
3. **Make sessions portable:** set `ENGINE_TYPE=baileys` (if not already), `BAILEYS_AUTH_STORE=database`, restart. Each session's next start imports its disk credentials into the database. Verify: `SELECT "sessionName", count(*) FROM baileys_auth_state GROUP BY 1;`
4. **Enable Redis + S3** (`REDIS_ENABLED=true`, `STORAGE_TYPE=s3`, `STORAGE_STRICT=true`).
5. **Split the planes:** deploy workers (`ROLE=worker`, stable `NODE_ID`, `NODE_URL`, `AUTO_START_SESSIONS=true`), flip the original node to `ROLE=api` (or replace it with api pods). Existing sessions keep running where they are; from now on the claim loop places new/orphaned work.

Roll back any step by reverting its env var — `ROLE=all` plus the previous storage settings restores the single-node shape.

---

## 6. Operations

### 6.1 Observability

| Signal | Where | Use for |
| --- | --- | --- |
| `GET /api/health/ready` | every pod | LB routing / k8s readiness (DBs up, not draining) |
| `GET /api/health/sessions` | every pod (public, counts only) | Warm-up progress (`ready` vs `assigned`), drain completion (`engines: 0`), per-node load |
| `openwa_node_engines`, `openwa_node_sessions_assigned`, `openwa_node_session_capacity` | `/api/metrics` (needs `METRICS_TOKEN`) | HPA input, capacity dashboards |
| `openwa_sessions{status=…}` | `/api/metrics` | Fleet-wide session state |

Alerts worth having: `assigned - ready > 0` for longer than a few sweep intervals (sessions not converging); `sessions{status="failed"} > 0` (operator attention required — never auto-adopted); any pod `draining=true` for longer than your grace period.

### 6.2 Timing knobs (defaults are sane — change deliberately)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_LEASE_TTL_MS` | 60000 | Worst-case delay before a dead node's sessions are adoptable |
| `SESSION_LEASE_HEARTBEAT_MS` | 20000 | Lease renewal cadence (keep < half the TTL — boot-validated) |
| `SESSION_TAKEOVER_SWEEP_MS` | 30000 | Claim-loop cadence: pickup latency for new starts and orphans |
| `SESSION_RESTORE_CONCURRENCY` | 3 | Parallel boot-restore lanes (launches stay 2 s apart regardless) |
| `MAX_CONCURRENT_SESSIONS` | 0 (unlimited) | Per-pod engine cap; the claim loop never adopts past it |

Failover time budget ≈ lease TTL + one sweep: **~90 s with defaults**. Lower TTL/sweep for faster failover at the cost of more DB chatter; don't push the TTL below ~30 s (transient pauses start looking like death).

### 6.3 What happens when things fail

| Failure | Behavior |
| --- | --- |
| **Worker crashes** | Its leases stop renewing → lapse at TTL → peers' claim loops adopt every eligible session (authenticated, `desiredState=running`). Database-auth sessions resume **without re-pairing**. |
| **Worker drained** (`POST /api/infra/drain`) | Engines stop immediately, readiness flips to 503, claims are left to lapse → peers adopt. One-way for that process; restart it to rejoin. |
| **Api pod dies** | Nothing session-related happens — it owned nothing. LB routes around it. |
| **A zombie process wakes up** (paused VM, hung container that revives) | Its lease generation is stale; its first renew concludes loss and it tears its engines down. It cannot write as owner — the database rejects stale-generation claims. |
| **Redis down** | Sessions and REST keep working. Degrades: cross-pod WS fan-out, queued webhook mode (falls back inline), conversation-ordering lock falls back to per-pod ordering (logged once). |
| **S3 down** (`STORAGE_STRICT=true`) | Media writes fail loudly (alert-able) instead of silently landing on one pod's disk. Reads keep the local read-through. |
| **Postgres down** | The coordination substrate is gone: readiness fails everywhere, engines keep their WhatsApp sockets but no leases renew. Recovery is automatic when Postgres returns; nothing is adopted in the window (every node is equally blind). |

### 6.4 Rolling restarts / upgrades

Workers: rely on drain-in-`preStop` and roll one at a time — sessions hand off ahead of the kill instead of riding the crash path. Api pods: roll freely. Database migrations run automatically at boot under a cross-replica advisory lock, so simultaneous boots don't race DDL.

---

## 7. Troubleshooting

| Symptom | Likely cause → fix |
| --- | --- |
| `start` on an api pod returns with the session still `disconnected`, `nodeId` null | No worker has capacity or the claim loop is off. Check every worker has `AUTO_START_SESSIONS=true`, headroom under `MAX_CONCURRENT_SESSIONS`, and is Ready. The intent is durable — it converges the moment a worker can take it. |
| `400 "Session is not started"` from an api pod for a session that IS running | The proxy could not identify a live owner. Check the owning worker's `NODE_URL` is set and reachable *from the api pod*, and that its lease is live: `SELECT "nodeId", "leaseExpiresAt" > NOW() FROM sessions WHERE id='…'`. |
| Sessions ping-pong between two nodes | Two workers share a `NODE_ID`. Every worker needs a unique, stable id. |
| Healthy node keeps "losing" its sessions | Lease renewals failing (check DB connectivity/latency in worker logs: *"Failed to renew session leases"*), or heartbeat ≥ half the TTL (boot validation prevents this unless overridden). Clock skew is **not** a suspect on Postgres — lease math runs on the database clock. |
| Session stuck `FAILED` after a failed launch | By design: `FAILED` is operator-owned and never auto-adopted. Inspect `lastError` on the session, fix the cause, `POST /start` again. |
| Takeover forces a QR re-scan | That session's credentials are still file-based. Confirm `BAILEYS_AUTH_STORE=database` on **all** workers and that the session has rows in `baileys_auth_state` (they appear at first pairing / next start). wwebjs sessions can never fail over. |
| A worker adopted nothing after replacing a dead pod with the same hostname | Expected within the lease window — the old lease must lapse first (≤ TTL). If it persists: the new pod's `NODE_ID` differs from the row's `nodeId` *and* the session is unpaired (`phone` null) with `desiredState=stopped` — record intent with `POST /start`. |
| `403` on `POST /api/infra/drain` | Drain needs an **ADMIN** key that is **unscoped** (not restricted to specific sessions) — it tears down every session on the node. |

---

## 8. Quick reference

**New/changed environment variables:** `ROLE` · `SESSION_RESTORE_CONCURRENCY` · `BAILEYS_AUTH_STORE` · `MAIN_DATABASE_TYPE` / `MAIN_DATABASE_HOST` / `MAIN_DATABASE_PORT` / `MAIN_DATABASE_USERNAME` / `MAIN_DATABASE_PASSWORD` · `STORAGE_STRICT` — all documented in `.env.example`, all boot-validated, all forwarded by both compose files.

**New endpoints:** `GET /api/health/sessions` (public; per-node capacity counts) · `POST /api/infra/drain` (ADMIN, unscoped; graceful hand-off).

**New metrics:** `openwa_node_engines` · `openwa_node_sessions_assigned` · `openwa_node_session_capacity`.

**New tables/columns (migrations run automatically):** `baileys_auth_state` · `sessions.desiredState` · `sessions.leaseGeneration` · Postgres twin of the auth/audit schema.

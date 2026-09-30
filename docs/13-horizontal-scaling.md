# 13 - Horizontal Scaling Guide

> ## ⚠️ PARTIALLY IMPLEMENTED — STILL DEPLOY `replicas: 1`
>
> **Supported topology remains exactly one API instance per session-data volume.** Do not
> run the multi-replica examples below yet.
>
> **What now exists.** Sessions carry an owner (`nodeId`) and a renewed lease
> (`leaseExpiresAt`). A process claims a session before starting its engine and refuses
> when another node holds a live claim, so two replicas can no longer both launch the same
> session — which is what corrupted the shared LocalAuth directory. A booting process also
> resets only the sessions it may claim, instead of reporting a live peer's sessions as
> disconnected. Claims are released on a clean shutdown and expire otherwise, so failover
> does not depend on one. `NODE_ID` names the process; it defaults to the hostname and must
> be stable across restarts and unique per running process: two processes sharing a hostname
> (host networking, pm2 cluster mode) must each set it, and a node that sees another process
> renewing leases under its `NODE_ID` logs `duplicate_node_id`.
>
> A node that loses its claim gives up the engine. A lease can lapse while the process is
> perfectly healthy — a slow query is enough — after which a peer may legitimately take the
> session; while the holder can reach the database, renewal detects the loss and tears the local
> engine down at the next heartbeat, so any two-engine overlap is bounded to roughly one heartbeat
> interval (and a teardown failure is logged as an error rather than silently retried). A failed
> renewal is deliberately not read as a loss: the TTL is sized to absorb a database blip, and
> concluding otherwise would stop every healthy engine on the node. The price is the partition case:
> a holder that cannot reach the database keeps its engines, a peer may adopt the session once the
> lease lapses, and both engines run until the holder's first successful renewal after it
> reconnects, so the overlap lasts as long as the outage plus up to one heartbeat.
>
> Bulk-send batches follow the same rule. A batch is only ever driven by the process
> holding its session's engine, so a booting replica now reaps only the batches whose
> sessions it may claim, instead of declaring a peer's in-flight batches FAILED while they
> are still sending. A data import likewise reports the sessions it could not reconcile
> because another node is running them.
>
> **Failover now completes on its own.** A periodic takeover sweep (default every 30s,
> `SESSION_TAKEOVER_SWEEP_MS`) adopts sessions whose holder's lease lapsed — a crashed peer, or a recreated
> container whose new identity boots before its old lease expires. Only authenticated
> sessions in a running-or-should-be state are adopted; mid-pairing and operator-`failed`
> ones are left alone, and a cleanly stopped session releases its claim so it is never
> "lapsed". Adopting a session fails its stuck in-flight batches (no auto-resume — the dead
> node's already-sent messages are unknowable). Adopting is gated by the same
> `AUTO_START_SESSIONS` flag as boot auto-start; the sweep itself is not, and runs on every node,
> because it also has a job that starts nothing: a row a vanished node left `ready`, `initializing`,
> `authenticating` or `action_required` is marked disconnected once its lease expired more than two
> TTLs ago, which is three TTLs after the holder's last renewal plus up to one sweep interval. A
> `qr_ready` row is marked too while it has no phone, since the sweep never adopts a row without one;
> a `qr_ready` row with a phone keeps its status, so the correction never makes it adoptable.
> Nothing else revisits such a row, since the boot reset skips a foreign claim that is still live.
> A session an operator stopped (`POST /stop` or `/force-kill`) is never adopted, even when its
> claim did lapse, until an explicit `POST /start`.
>
> Known limitation: a holder that is alive but cannot reach the database for more than three lease
> TTLs minus one heartbeat (160s at defaults) is marked disconnected by a peer too, and does not write its status back when it reconnects. Its
> renewal still finds its own claim, so it detects no loss, and a steadily connected engine emits no
> new status. The row reads `disconnected` until that engine's status next changes.
>
> **Request routing now exists, opt-in via `NODE_URL`.** When every node sets its own
> reachable URL (e.g. `NODE_URL=http://10.0.0.5:2785`), a session-scoped request landing on
> a non-owner is forwarded to the live owner and the owner's response is relayed back
> (`x-openwa-served-by` names it). The forward happens after API-key auth, carries the
> caller's credentials, is bounded by
> `SESSION_PROXY_TIMEOUT_MS` (default 60s), and is one hop only — a forwarded request is
> never forwarded again; one that still lands on a live non-owner (stale ownership, or a
> client-forged hop marker) is refused with a retryable 409 rather than executed there. A
> lapsed owner is deliberately NOT forwarded to: the local node handles the request,
> which is exactly how a takeover begins. Without `NODE_URL` the whole path is inert and
> single-node deployments pay nothing.
>
> A path on `NODE_URL` is kept (0.23.7 and later) and put in front of the forwarded request's own
> path, which already starts with `/api`. Give one only when the node is reached through a reverse
> proxy under that prefix (`NODE_URL=https://gw.example.com/node-a`); a node reached directly takes
> none. A `NODE_URL` ending in `/api` forwards to `/api/api/...`, and every routed request answers
> `404`.
>
> **The owner authenticates a forwarded request again, against its own key store.** API keys and the
> audit log live in each node's main SQLite file (`MAIN_DATABASE_NAME`, default `./data/main.sqlite`),
> not in the shared data database, and nothing replicates them. A forwarded key must therefore also
> exist on the owner. The receiving node checks its own copy's role, `allowedIps`, `allowedSessions`
> and `allowedChats` before forwarding, and the owner checks its copy again; a filtered list, such as
> a session's chats, is filtered by the owner's copy alone. A missing or narrower copy on the owner
> answers `401` or `403` (or a shorter list). A broader one is accepted and widens those lists, so
> keep the copies identical. A key created through the API or the dashboard gets a fresh random value
> and exists only on the node that created it. Matching keys come only from the same
> `API_MASTER_KEY` seeded on each node's first boot (it seeds only while no key exists), or from a
> copy of one node's `main.sqlite` taken while it is stopped (never one file shared over network
> storage), which authenticates only on nodes with the same `API_KEY_PEPPER`, since the copied hashes
> carry the source node's pepper. Each node's audit log records only the requests it handled.
>
> **List and stats routes answer from the node that received them.** `GET /api/sessions` and
> `GET /api/sessions/stats/overview` name no session, so they are never forwarded. `lastError`,
> `restriction`, the stats `active` count and `memoryUsage` are that node's own view, not the owner's:
> the first two come from what this node's engines recorded, `active` counts only this node's engines,
> and `memoryUsage` is this process's. `engineLoaded` is the exception, since it also counts a live
> claim by another node. With routing on, `GET /api/sessions/:sessionId` is forwarded to the owner, so
> its answer is the owner's; `start`, `stop`, `logout` and `force-kill` are forwarded the same way, so a
> `true` means `stop`, `logout` and `force-kill` can act (and `start` answers `400`, as it does on the
> owner). Without `NODE_URL` nothing is forwarded, so a node that does not hold the
> session still reports `true` but cannot act on it: `start` and `stop` answer `409` there, and `logout`
> and `force-kill` answer `400`.
>
> **A failed forward says whether the owner could have acted.** When the owner cannot be
> reached at all (connection refused, unresolvable or unusable `NODE_URL`), the answer is
> `503` and the request was not carried out, so it is safe to retry. A timeout answers `504`
> (no reply within `SESSION_PROXY_TIMEOUT_MS`), and any other failure answers `502` (the
> connection broke, possibly after the request was sent; a TLS certificate the forwarding
> node does not trust also lands here, with the cause code in its warning log): the owner
> may already have carried it out, so a non-idempotent call such as a message send must not
> be repeated blindly on either.
>
> **The lease compares timestamps written by different nodes, so their clocks must agree.** Each
> node writes `leaseExpiresAt` from its own clock and reads every other node's the same way. Just
> before each renewal the holder's lease is only one TTL minus one heartbeat ahead, so a node whose
> clock runs more than about `SESSION_LEASE_TTL_MS - SESSION_LEASE_HEARTBEAT_MS` ahead (40s at
> defaults, 20s once one renewal is missed) sees healthy peers as lapsed and
> will take their sessions over. Run NTP (or any time sync) on every node — the default on ordinary
> server images — and treat any skew near that margin as a misconfiguration.
> The status correction reads the same timestamps: a node whose clock runs more than three TTLs minus
> one heartbeat ahead (160s at defaults) marks a healthy peer's sessions disconnected, even with
> `AUTO_START_SESSIONS` off, and nothing writes them back. The zone each node runs in is no longer
> part of this: on PostgreSQL the data connection binds, parses and defaults every timestamp in UTC
> ([05 - Database Design](./05-database-design.md#timestamps-on-postgresql-are-utc)), so two nodes in
> different zones, or one zone that observes daylight saving, still
> read each other's leases as the instants they were written at. Only the clocks have to agree.
> One exception, during an upgrade: a node still on 0.23.5 or earlier writes the lease in its own
> local wall time, so while versions are mixed the old cross-zone error above is back for as long as
> the older node keeps renewing. Running every node in `TZ=UTC` (the image default) removes it.
>
> **A forwarded request is throttled on both nodes.** The receiving node counts it before
> forwarding, and the owner counts it again on arrival; with `REDIS_ENABLED=true` both counts land
> in the same shared bucket. Size the rate limits with that in mind for a routed deployment.
>
> Forwards carry the client address in `x-forwarded-for` (inbound chain preserved, the
> observed peer appended). For an `allowedIps`-restricted key or the per-IP throttler to see
> the REAL client on forwarded calls, each node must list its peer nodes' addresses in its
> `TRUSTED_PROXIES` — otherwise the owner (correctly) ignores the chain and every forwarded
> request appears to come from the peer node itself.
>
> **WebSocket events now fan out across replicas** when Redis is enabled (`REDIS_ENABLED=true`,
> the same flag the throttler and cache already use). The gateway broadcasts to rooms; a Redis
> pub/sub adapter attached to Socket.IO relays those broadcasts to every replica, so a client
> connected to node A receives an event raised on node B. Scope honestly: this distributes event
> **fan-out only**. The per-key WS rate-limit buckets (counted per replica) and the engine registry
> are still process-local. Without `REDIS_ENABLED` the adapter is inert and delivery is single-node,
> exactly as before.
>
> **Mid-connection key eviction converges on a timer, not a broadcast, and only on one node.** The
> node that processes a revoke, delete, or narrowing tears down that key's sockets synchronously, in
> the same request. Nothing is published to peers. Every node re-validates the keys behind its own
> live sockets against its own key store once a minute (`EventsGateway.sweepApiKeyAuthorization`, one
> batched read of the key ids currently holding sockets) and evicts on a row that is gone, inactive,
> expired, or whose role, `allowedIps`, `allowedSessions`, `allowedChats` or expiry no longer matches
> the snapshot the socket authenticated with. That catches an expiry, and a change written to the
> node's main database other than through its own API. Before this sweep, a revoke, delete or expiry
> that reached a node that way waited for the client's next subscribe, and a narrowing was never
> caught at all: it leaves the key valid, so only the new subscribe is rejected while every room
> joined earlier stays joined. REST reads the row per request, so the node that processed a change
> rejects the key's REST calls at once. Every other node keeps accepting the key, on REST and on its
> sockets, until the same change is made there: repeat a revoke, delete, expiry change or narrowing
> on every node.
>
> **What does not exist yet, and is why one replica is still the answer.** The cross-replica gap just
> named (WS rate-limit state) remains process-local. API keys and the audit log are per node: each
> node keeps them in its own main SQLite file, so a key created, revoked or narrowed on one node is
> unchanged on the others (see the routing paragraph above). Leases are timed by each node's own
> clock, not the database's (see the clock paragraph above). Not every lifecycle path is fenced: the
> liveness watchdog and reconnect timers still act on whatever is in the local
> registry. `BulkMessageService` keeps its live batch state in process, so a takeover cannot resume
> a batch — only fail it. MCP/agent tool invocations execute on the node that received them rather
> than being forwarded.
>
> Everything below (node affinity, `replicas: 3`) remains a **design sketch** until those
> land.

This guide explains a _proposed_ design for deploying OpenWA in a horizontally scaled environment for high availability and increased capacity.

## 13.1 Architecture Overview

```mermaid
flowchart TB
    subgraph LB["Load Balancer"]
        NGINX[Nginx/Traefik]
    end

    subgraph Nodes["OpenWA Nodes"]
        N1[OpenWA Node 1]
        N2[OpenWA Node 2]
        N3[OpenWA Node 3]
    end

    subgraph Storage["Shared Storage"]
        PG[(PostgreSQL)]
        REDIS[(Redis)]
        S3[S3/MinIO<br/>Media Storage]
    end

    LB --> N1
    LB --> N2
    LB --> N3

    N1 --> PG
    N2 --> PG
    N3 --> PG

    N1 --> REDIS
    N2 --> REDIS
    N3 --> REDIS

    N1 --> S3
    N2 --> S3
    N3 --> S3
```

### Key Principles

| Principle            | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| **Session Affinity** | WhatsApp sessions are stateful and must stay on the same node |
| **Shared Database**  | PostgreSQL stores all persistent data across nodes            |
| **Redis for State**  | Shared cache and queue coordination                           |
| **Sticky Sessions**  | Load balancer routes session requests to the correct node     |

## 13.2 Session Affinity Strategy

Since WhatsApp sessions maintain active connections (a browser instance for `whatsapp-web.js`, or a WebSocket for `baileys` — set via `ENGINE_TYPE`), they cannot be freely moved between nodes.

### Strategy 1: Session-to-Node Mapping (Recommended)

This mapping ships: each `sessions` row records its owner in `nodeId`, `nodeUrl`, `claimedAt` and
`leaseExpiresAt` (migrations `AddSessionOwnership` and `AddSessionNodeUrl`). No load balancer reads it:
a node that receives a request for a session it does not own forwards it to the owner's `NODE_URL`, as
the routing paragraph at the top of this guide describes.

### Strategy 2: Consistent Hashing

Route sessions based on session ID hash. **(Not implemented — no such routing helper exists in
code; the sketch below is illustrative of the future design.)**

```typescript
function getNodeForSession(sessionId: string, nodes: string[]): string {
  const hash = crypto.createHash('md5').update(sessionId).digest('hex');
  const index = parseInt(hash.substring(0, 8), 16) % nodes.length;
  return nodes[index];
}
```

### Strategy 3: Session Claim

Each node "claims" sessions on startup and releases them on shutdown. This is implemented: see the claim, lease and takeover description at the top of this guide.

## 13.3 Docker Swarm Deployment

### docker-compose.swarm.yml

```yaml
version: '3.8'

services:
  openwa:
    image: ghcr.io/rmyndharis/openwa:latest
    deploy:
      replicas: 1 # MUST stay 1 until multi-replica is supported — multiple replicas on one session volume corrupt WhatsApp auth
      update_config:
        parallelism: 1
        delay: 30s
      restart_policy:
        condition: on-failure
        max_attempts: 3
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 512M
    environment:
      - NODE_ENV=production
      - DATABASE_TYPE=postgres
      - DATABASE_HOST=postgres
      - DATABASE_NAME=openwa
      - DATABASE_USERNAME=openwa
      - DATABASE_PASSWORD=${DB_PASSWORD}
      - REDIS_HOST=redis
      - QUEUE_ENABLED=true
      # The session-ownership identity: it names which process holds each session's engine, and
      # it must be STABLE across restarts (a value that changes makes the restarted process a new
      # node, which has to wait out its own previous lease). Defaults to the container hostname.
      - NODE_ID={{.Node.Hostname}}-{{.Task.Slot}}
    volumes:
      - sessions:/app/data/sessions
    networks:
      - openwa-net
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:16-alpine
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
    environment:
      - POSTGRES_DB=openwa
      - POSTGRES_USER=openwa
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - openwa-net

  redis:
    image: redis:7-alpine
    deploy:
      replicas: 1
    command: redis-server --appendonly yes --maxmemory-policy noeviction
    volumes:
      - redis-data:/data
    networks:
      - openwa-net

  # NOTE (v0.4.0): OpenWA no longer ships a bundled Traefik container.
  # For TLS / public exposure, bring your own reverse proxy (Traefik, nginx,
  # Caddy, a cloud load balancer, etc.) and point it at openwa:2785.
  # See section 13.5 for Traefik / nginx config examples.

volumes:
  postgres-data:
  redis-data:
  sessions:

networks:
  openwa-net:
    driver: overlay
```

### Deploy to Swarm

```bash
# Initialize swarm (if not already)
docker swarm init

# Deploy stack
docker stack deploy -c docker-compose.swarm.yml openwa

# Check status
docker service ls
docker service ps openwa_openwa
```

> **Do not scale the `openwa` service** (`docker service scale openwa_openwa=N`). The `sessions`
> volume above is declared with the default local driver (not `external`), so Swarm creates one per
> node: replicas co-located on a single node share that directory and corrupt the WhatsApp auth
> state, while replicas placed on other nodes each get a fresh empty volume and start an
> unauthenticated engine instead. Either way the deployment breaks — see the warning at the top of
> this guide. Scaling only becomes safe once the gaps listed at the top of this guide are closed.

## 13.4 Kubernetes Deployment

### k8s/namespace.yaml

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: openwa
```

### k8s/configmap.yaml

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: openwa-config
  namespace: openwa
data:
  NODE_ENV: 'production'
  DATABASE_TYPE: 'postgres'
  DATABASE_HOST: 'postgres-service'
  DATABASE_PORT: '5432'
  DATABASE_NAME: 'openwa'
  REDIS_HOST: 'redis-service'
  REDIS_PORT: '6379'
  QUEUE_ENABLED: 'true'
  PORT: '2785'
```

### k8s/secret.yaml

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: openwa-secrets
  namespace: openwa
type: Opaque
stringData:
  DATABASE_USERNAME: openwa
  DATABASE_PASSWORD: your-secure-password
```

### k8s/deployment.yaml

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: openwa
  namespace: openwa
spec:
  serviceName: openwa-headless # must match the headless Service declared in k8s/service.yaml
  replicas: 1 # MUST stay 1 until multi-replica is supported — see the warning at the top of this guide
  selector:
    matchLabels:
      app: openwa
  template:
    metadata:
      labels:
        app: openwa
    spec:
      # OS-level containment is defence in depth for the plugin sandbox (see docs/30-plugin-sandboxing.md):
      # it limits the privileges the API process holds, not what a plugin inside that process can reach.
      # Without it the API process, and every plugin loaded into it, keeps whatever the container runtime
      # grants by default, so a plugin that abuses Node built-ins (fs, net) can read host files / open raw
      # sockets outside the capability model. The shipped compose file runs the image read-only +
      # cap_drop:ALL, and the node process runs as the non-root openwa user; the manifest below mirrors
      # that so a k8s deploy is not silently weaker. By default the entrypoint starts as root to chown
      # /app/data, then drops to openwa (uid/gid 997) via gosu. To run non-root from the start instead,
      # add runAsNonRoot: true, runAsUser: 997 and runAsGroup: 997 here and remove the capabilities `add`
      # list below; the entrypoint then skips the chown and the drop (see podSecurityContext in
      # charts/openwa/values.yaml). fsGroup makes the volume writable by openwa in either mode;
      # OnRootMismatch re-owns it only when its root is wrong, not every file on every mount.
      securityContext:
        fsGroup: 997
        fsGroupChangePolicy: OnRootMismatch
      containers:
        - name: openwa
          image: ghcr.io/rmyndharis/openwa:latest
          ports:
            - containerPort: 2785
              name: http
          envFrom:
            - configMapRef:
                name: openwa-config
            - secretRef:
                name: openwa-secrets
          env:
            # The session-ownership identity — see the compose example above. It must be STABLE
            # across restarts, which a Deployment's pod name is NOT: use a StatefulSet (whose pod
            # names are ordinal and stable) for a routed multi-node deployment, or pin a value per
            # replica. A changing NODE_ID still converges (the old lease lapses and the sweep
            # adopts), but every restart then costs one lease TTL of downtime for its sessions.
            - name: NODE_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          # Container-level hardening. readOnlyRootFilesystem requires every writable path to be an
          # explicitly mounted volume — /app/data (SQLite, sessions, media, plugin storage) and /tmp
          # (Chromium needs a writable HOME/XDG for whatsapp-web.js).
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: ['ALL']
              # Only for the root entrypoint's chown and the gosu privilege drop.
              add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']
          resources:
            requests:
              memory: '512Mi'
              cpu: '250m'
            limits:
              memory: '2Gi'
              cpu: '1000m'
          volumeMounts:
            - name: openwa-data
              mountPath: /app/data
            - name: tmp
              mountPath: /tmp
          # Same probes as charts/openwa/templates/statefulset.yaml. The startupProbe holds liveness
          # off during boot (migrations, connect retry, plugin load, backfills), and every timeoutSeconds is
          # explicit because the 1s kubelet default is shorter than /ready's 3s database bound.
          startupProbe:
            httpGet:
              path: /api/health/live
              port: 2785
            periodSeconds: 5
            timeoutSeconds: 5
            failureThreshold: 60
          livenessProbe:
            httpGet:
              path: /api/health/live
              port: 2785
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 6
          readinessProbe:
            httpGet:
              path: /api/health/ready
              port: 2785
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 5
      volumes:
        - name: tmp
          emptyDir: {}
  volumeClaimTemplates:
    - metadata:
        name: openwa-data
      spec:
        accessModes: ['ReadWriteOnce']
        resources:
          requests:
            storage: 10Gi
```

### k8s/service.yaml

```yaml
apiVersion: v1
kind: Service
metadata:
  name: openwa-service
  namespace: openwa
spec:
  type: ClusterIP
  selector:
    app: openwa
  ports:
    - port: 80
      targetPort: 2785
      name: http
---
apiVersion: v1
kind: Service
metadata:
  name: openwa-headless
  namespace: openwa
spec:
  clusterIP: None
  selector:
    app: openwa
  ports:
    - port: 2785
      name: http
```

### k8s/ingress.yaml

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: openwa-ingress
  namespace: openwa
  annotations:
    nginx.ingress.kubernetes.io/affinity: 'cookie'
    nginx.ingress.kubernetes.io/session-cookie-name: 'openwa-session'
    nginx.ingress.kubernetes.io/session-cookie-max-age: '172800'
spec:
  ingressClassName: nginx
  rules:
    - host: openwa.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: openwa-service
                port:
                  number: 80
  tls:
    - hosts:
        - openwa.example.com
      secretName: openwa-tls
```

### Deploy to Kubernetes

The maintained chart is [`charts/openwa`](../charts/openwa), a single-instance StatefulSet that
already encodes the `replicaCount: 1` constraint below; prefer it over hand-applied manifests. The
raw manifests here stay for operators who do not use Helm.

```bash
# Apply all manifests
kubectl apply -f k8s/

# Check pods
kubectl get pods -n openwa

# Check logs
kubectl logs -f statefulset/openwa -n openwa
```

> **Do not raise `replicas` above 1** (`kubectl scale statefulset openwa --replicas=N`). Each pod
> gets its own PVC, so extra replicas do not share a session directory — they each start their own
> unauthenticated engine, and with `AUTO_START_SESSIONS=true` every pod tries to drive the same
> configured sessions from the shared database. See the warning at the top of this guide.

## 13.5 Load Balancer Configuration

### Traefik Dynamic Config

```yaml
# traefik/dynamic-scaling.yml
http:
  routers:
    openwa:
      rule: 'Host(`openwa.example.com`)'
      service: openwa
      middlewares:
        - sticky-session

  middlewares:
    sticky-session:
      headers:
        customResponseHeaders:
          X-OpenWA-Node: '{{.Node}}'

  services:
    openwa:
      loadBalancer:
        sticky:
          cookie:
            name: openwa_node
            secure: true
            httpOnly: true
        servers:
          - url: 'http://openwa-1:2785'
          - url: 'http://openwa-2:2785'
          - url: 'http://openwa-3:2785'
        healthCheck:
          path: /api/health
          interval: 10s
          timeout: 3s
```

### Nginx Upstream Config

```nginx
upstream openwa {
    ip_hash;  # Sticky sessions based on client IP

    server openwa-1:2785 weight=1 max_fails=3 fail_timeout=30s;
    server openwa-2:2785 weight=1 max_fails=3 fail_timeout=30s;
    server openwa-3:2785 weight=1 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    server_name openwa.example.com;

    location / {
        proxy_pass http://openwa;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Session affinity cookie
        proxy_cookie_path / "/; SameSite=Strict; HttpOnly";
    }

    location /api/health {
        proxy_pass http://openwa;
        proxy_connect_timeout 5s;
        proxy_read_timeout 5s;
    }
}
```

## 13.6 Capacity Planning

### Resource Requirements per Node

| Sessions | Memory | CPU      | Disk  |
| -------- | ------ | -------- | ----- |
| 1-5      | 1 GB   | 0.5 vCPU | 5 GB  |
| 5-10     | 2 GB   | 1 vCPU   | 10 GB |
| 10-25    | 4 GB   | 2 vCPU   | 25 GB |
| 25-50    | 8 GB   | 4 vCPU   | 50 GB |

### Scaling Guidelines

The replica count stays at **1** (see 13.3 and 13.4), so the only levers available today are
**vertical** — adjust the `resources` limits/reservations in the manifests above — or run a second
single-instance deployment with its own session volume and split sessions between them. Horizontal
`scale up` / `scale down` becomes an option only once the gaps listed at the top of this guide are closed.

| Metric                            | Threshold  | Action                                                                                                     |
| --------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| CPU > 80%                         | 5 minutes  | Raise `limits.cpu` (StatefulSet); the Swarm block above declares no CPU constraint, so add one             |
| Memory > 85%                      | 5 minutes  | Raise the memory limit                                                                                     |
| CPU < 30%                         | 15 minutes | Lower `requests.cpu` — that is what the scheduler reserves; lowering `limits.cpu` only tightens throttling |
| Active sessions per instance > 20 | -          | Move sessions to a second instance with its own volume                                                     |

### Throughput Projections

Design targets for 2 vCPU / 4GB RAM nodes, **not measurements** — no benchmark artifact in this
repository backs any row, including the 1-node one, and multi-node operation is not implemented (see
the warning at the top of this guide), so the 3- and 5-node rows could not have been run at all:

| Nodes | Sessions | Messages/sec | p95 Latency |
| ----- | -------- | ------------ | ----------- |
| 1     | 10       | 50           | 150ms       |
| 3     | 30       | 150          | 180ms       |
| 5     | 50       | 250          | 200ms       |

## 13.7 Monitoring

### Prometheus Metrics

OpenWA exports Prometheus text exposition at `GET /api/metrics` (`openwa_*` gauges and counters).
The endpoint returns `404` until `METRICS_TOKEN` is set, and then requires that token as a Bearer:

```yaml
# prometheus/prometheus.yml
scrape_configs:
  - job_name: 'openwa'
    static_configs:
      # Swarm service name (13.3). On Kubernetes there is no Service called `openwa` — scrape the
      # pod through the headless Service instead, e.g.
      # openwa-0.openwa-headless.openwa.svc.cluster.local:2785
      - targets: ['openwa:2785']
    metrics_path: '/api/metrics'
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/metrics_token
```

```yaml
# prometheus/openwa-rules.yaml
groups:
  - name: openwa
    rules:
      - alert: HighMemoryUsage
        expr: container_memory_usage_bytes{container="openwa"} > 1.8e9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'OpenWA node high memory usage'

      - alert: NodeDown
        expr: up{job="openwa"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: 'OpenWA node is down'
```

### Health Check Endpoints

| Endpoint            | Purpose                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/api/health`       | Basic health check — returns `status` and `timestamp`; `version` only for an authenticated caller            |
| `/api/health/live`  | Liveness probe (static `ok`; reflects process liveness only)                                                 |
| `/api/health/ready` | Readiness probe — verifies the main + data databases respond (returns 503 while draining or if a DB is down) |

---

<div align="center">

[← 12 - Troubleshooting & FAQ](./12-troubleshooting-faq.md) · [Documentation Index](./README.md) · [Next: 14 - Migration Guide →](./14-migration-guide.md)

</div>

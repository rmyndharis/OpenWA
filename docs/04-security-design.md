# 04 - Security Design

## 4.1 Security Overview

```mermaid
flowchart TB
    subgraph External["External Threats"]
        A1[Unauthorized Access]
        A2[Data Breach]
        A3[DDoS Attack]
        A4[Injection Attack]
    end

    subgraph Defense["Defense Layers"]
        D1[Authentication]
        D2[Encryption]
        D3[Rate Limiting]
        D4[Input Validation]
        D5[Audit Logging]
    end

    A1 --> D1
    A2 --> D2
    A3 --> D3
    A4 --> D4

    D1 --> APP[Application]
    D2 --> APP
    D3 --> APP
    D4 --> APP
    APP --> D5
```

## 4.2 Authentication

### API Key Authentication Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant G as Auth Guard
    participant S as Service
    participant DB as Database

    C->>G: Request + X-API-Key
    G->>G: Hash API Key
    G->>DB: Find by hash
    alt Key Valid
        DB-->>G: API Key record
        G->>G: Check permissions
        G->>G: Check expiration
        G->>S: Forward request
        S-->>C: Response
    else Key Invalid
        G-->>C: 401 Unauthorized
    end
```

### API Key Format

```
Format: owa_k1_<64 hex chars>   (32 random bytes, hex-encoded — 71 characters in total)
Example: owa_k1_3f9c1d0a7b2e4c5680a1f2d3e4b5c6a7980b1c2d3e4f50617283940a1b2c3d4e

Storage: SHA-256 hash only (never store plain key); `keyPrefix` keeps the first 12 characters
```

Every key minted through the API-keys endpoints uses that format. The bootstrap seed key is the only
exception: an explicit `API_MASTER_KEY` is taken verbatim (surrounding whitespace is stripped), and `ALLOW_DEV_API_KEY=true` opts into the
fixed `dev-admin-key`; with neither set, the seed key is generated in the format above.

### Permission Model

API keys carry **no permission strings**. Authorization is a role hierarchy on the key itself, plus
three scoping dimensions enforced by `ApiKeyGuard`.

| Role       | Rank | Meaning                                                              |
| ---------- | ---- | -------------------------------------------------------------------- |
| `admin`    | 3    | Satisfies every `@RequireRole` level, including API-key management   |
| `operator` | 2    | Satisfies `operator` and `viewer` routes — the default for a new key |
| `viewer`   | 1    | Satisfies `viewer` routes only                                       |

A route declares its minimum level with `@RequireRole(...)`; a key passes when its role ranks at or
above that level (`AuthService.hasPermission`). A key below it is rejected with `403 Forbidden`.

| Scope     | Field             | Effect                                                                                                                                                             |
| --------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source IP | `allowedIps`      | Empty/absent = unrestricted; non-empty = fail-closed IP whitelist (see §4.3)                                                                                       |
| Sessions  | `allowedSessions` | Empty/absent = every session; non-empty = a request carrying any other session id is rejected with `403`                                                           |
| Chats     | `allowedChats`    | Empty/absent = every chat; non-empty = default-deny: only chat-scoped routes, and only for a listed chat, else `403`; `/events`, MCP and Bull Board refuse the key |

The key-lifecycle routes (`/api/auth/api-keys`) are additionally fenced with `@RequireUnscopedKey()`:
a session-scoped key is refused there whatever its role, so it cannot mint or widen credentials
beyond its own confinement.

A session's egress proxy (`proxyUrl` on `POST /api/sessions`, `PATCH /api/sessions/:sessionId/proxy`)
is set only by an unscoped `admin` key; any other key gets `403`. The proxy is trusted egress chosen by
the administrator, so its host is deliberately not checked against internal addresses (a loopback or
private-network proxy sidecar works). The destinations of caller-supplied URLs fetched through it are
still vetted by the SSRF guard. Reading the proxy (`GET /api/sessions/:sessionId/proxy`) returns only
the masked host, type and a `hasCredentials` flag.

### Recovering a lost admin key

Keys are stored as one-way hashes, so a lost key cannot be read back from the database: it is either
found where it was saved, or replaced. Try these in order. If every key stopped working at once after
`API_KEY_PEPPER` was set or changed, follow the pepper recovery in §4.4 instead.

1. **The bootstrap key file or `API_MASTER_KEY`.** The key seeded on first boot is kept in
   `data/.api-key` (or the `BOOTSTRAP_KEY_FILE` path) until that key is no longer active (revoked,
   expired or deleted). While the file holds a live key, the startup banner ends with
   `(full key in <path>)`. Read it with `cat data/.api-key`, or with
   `docker compose exec openwa-api cat /app/data/.api-key` on the compose deployment. If
   `API_MASTER_KEY` was set before first boot, the seeded key is that value, and it still works
   unless it was revoked since.

2. **Another ADMIN key.** Any active, unexpired `admin` key without `allowedSessions` or
   `allowedChats` can manage keys: mint a replacement with `POST /api/auth/api-keys`
   (`{"name": "Admin", "role": "admin"}`; the raw key is returned once, in `apiKey`), then revoke the
   lost one with `POST /api/auth/api-keys/:id/revoke`, or do both from the dashboard's API Keys page.

3. **Replace the key in the main database.** With no usable ADMIN key left, give the lost key's row
   a new key; every other key keeps working. Stop the instance and copy the main database aside. Then
   generate a key and its hash with the gateway's own hash function and configuration (process env,
   `.env` and `data/.env.generated`, so the same `API_KEY_PEPPER`). Run it from the gateway's install
   directory, the one holding `dist/` and `data/`, so it reads that install's configuration:

   ```bash
   GEN="require('./dist/config/load-env'); const key = 'owa_k1_' + require('crypto').randomBytes(32).toString('hex'); console.log('key:', key); console.log('prefix:', key.slice(0, 12)); console.log('hash:', require('./dist/modules/auth/api-key-hash').hashApiKey(key, process.env.API_KEY_PEPPER))"
   node -e "$GEN"                                               # source install, after npm run build
   docker compose run --rm --no-deps openwa-api node -e "$GEN"  # compose deployment
   ```

   Find the row and write the new hash and prefix into it. The main database is
   `MAIN_DATABASE_NAME`, `data/main.sqlite` by default; on the compose deployment run `sqlite3` as
   `docker compose run --rm --no-deps openwa-api sqlite3 /app/data/main.sqlite "..."`:

   ```bash
   sqlite3 data/main.sqlite "SELECT id, name, keyPrefix, isActive, expiresAt FROM api_keys WHERE role = 'admin'"
   sqlite3 data/main.sqlite "UPDATE api_keys SET keyHash = '<hash>', keyPrefix = '<prefix>', isActive = 1, expiresAt = NULL, allowedIps = NULL, allowedSessions = NULL, allowedChats = NULL WHERE id = '<id>'"
   ```

   Start the instance and use the new key. The update also clears the row's revoked state, expiry,
   and IP, session and chat restrictions, so it can manage keys again; narrow it afterwards through
   the API if it carried any. The old key no longer authenticates.

4. **Reset the key table.** When no row is worth keeping, empty `api_keys` as the pepper recovery in
   §4.4 describes: the next boot seeds a new ADMIN key (from `API_MASTER_KEY` when set) and prints
   it once. Every other key must then be re-issued.

Keys live in each node's own main database ([13 - Horizontal Scaling](./13-horizontal-scaling.md)),
so on a multi-node deployment the recovery applies only to the node it ran on.

## 4.3 IP Whitelisting

IP whitelisting adds an extra security layer by restricting API key access to specific IP addresses.

### IP Whitelist Flow

```mermaid
flowchart TB
    REQ[Incoming Request] --> AUTH[API Key Valid?]
    AUTH -->|No| R401[401 Unauthorized]
    AUTH -->|Yes| WL{IP Whitelist Enabled?}
    WL -->|No| ALLOW[Allow Request]
    WL -->|Yes| CHECK{IP in Whitelist?}
    CHECK -->|No| RIP[403 Forbidden]
    CHECK -->|Yes| ALLOW
    ALLOW --> PROCESS[Process Request]
```

### Managing the whitelist

There is **no `/whitelist` sub-resource**. A key's allowed source IPs are the `allowedIps` field on the API key itself, set when you create or update the key via the API-keys endpoints (see §6.4.9 in the [API Specification](./06-api-specification.md)):

```http
POST /api/auth/api-keys
PUT  /api/auth/api-keys/:id
```

```json
{
  "name": "production-server",
  "allowedIps": ["203.0.113.50", "10.0.0.0/24"]
}
```

`allowedIps` accepts exact IPs and CIDR ranges. An empty or absent list means the key is **not** IP-restricted; a non-empty list fails closed (a request whose client IP can't be determined, or isn't in the list, is rejected). To change the whitelist, `PUT` the key with the new `allowedIps` array.

### Implementation

There is no dedicated whitelist guard, service or table — no `IpWhitelistGuard`, no whitelist
sub-resource, no per-entry `active` flag. Enforcement lives in two places:

- **Client IP resolution** — `ApiKeyGuard` calls `resolveClientIp(request, TRUSTED_PROXIES)`
  (`src/common/utils/ip.ts`). `X-Forwarded-For` is client-controllable, so it is honored **only**
  when the request actually arrives from a configured trusted proxy; with no trusted proxies set the
  header is ignored entirely and the direct socket address is used. That is what prevents a caller
  from spoofing its way past the whitelist with a forged header (see §4.6 for `TRUSTED_PROXIES`).
- **Matching** — `AuthService.validateApiKey` compares that IP against the key's `allowedIps` with
  the shared `ipMatches` helper, which accepts an exact address or CIDR notation and returns `false`
  on a malformed entry rather than coercing it into range. With a whitelist configured, an
  undeterminable client IP throws `ForbiddenException` (`403`) straight away, with no log line;
  an IP outside the list writes a `logger.warn` with `action: 'ip_rejected'` first, then throws the
  same `403`. The key itself is valid, so the refusal is a `403` like the role and chat refusals, and
  a client does not read it as a key to discard.

### Best Practices

| Practice              | Description                                               |
| --------------------- | --------------------------------------------------------- |
| **Use CIDR notation** | For IP ranges, use CIDR instead of multiple entries       |
| **Trusted Proxies**   | Configure trusted proxies for accurate client IP          |
| **Regular Review**    | Review whitelist entries regularly                        |
| **Audit Logging**     | Log all blocked attempts for monitoring                   |
| **Fallback Plan**     | Prepare a process to update the whitelist when IPs change |

### IPv6 Support

`allowedIps` accepts IPv4 addresses and IPv4 CIDR ranges only; the API rejects an IPv6 entry. An
IPv6 address or range already stored on a key created before v0.4.3, when the API started rejecting
them, is matched as written. An IPv4-mapped client address (`::ffff:203.0.113.50`) is normalized to its bare IPv4 address before
matching. `TRUSTED_PROXIES` accepts IPv4 and IPv6 addresses and CIDR ranges (for example `fd00::/8`);
an entry that is neither is ignored, with a warning at boot. A trusted proxy that appends a port to
an `X-Forwarded-For` hop (`203.0.113.7:51000`, `[2001:db8::1]:443`) resolves to the bare address.

## 4.4 Data Encryption

### In Transit

OpenWA serves plain HTTP on its port; terminate **TLS at your reverse proxy / load balancer** (nginx, Traefik, Caddy) and expose the gateway only over HTTPS in production. The API key is bearer-equivalent and is sent on every request, so it must never traverse plaintext `http://` outside local development.

### At Rest

> **There is currently no application-level encryption at rest.** API keys are stored **hashed** (one-way) in the database, but the first-boot key file and other sensitive values are stored as plaintext in the database / on disk and are protected by filesystem and database permissions, not by encryption. Encryption at rest for these fields is a roadmap item, not a shipped feature — do not assume it.

| Data                                                                | At rest                                                                                                       | How it is protected                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API keys                                                            | **Hashed** — SHA-256 with an optional `API_KEY_PEPPER` HMAC; never reversible                                 | A database leak alone cannot recover the keys; with a pepper set, hashes can't be precomputed offline. See §4.2.                                                                                                                                                                                                                      |
| Session auth state (WhatsApp credentials)                           | Plaintext on disk (the engine's auth store under the data volume)                                             | Filesystem permissions on the data volume — keep it private.                                                                                                                                                                                                                                                                          |
| Webhook secrets and custom headers                                  | Plaintext: `webhooks.secret` (`varchar`) and custom `webhooks.headers` (JSON, may carry receiver credentials) | Database access control; never returned by the webhook read DTOs (write-only) and omitted from `GET /api/infra/export-data` webhook rows.                                                                                                                                                                                             |
| Proxy credentials                                                   | Plaintext — `sessions.proxyUrl` may embed `user:pass`                                                         | Database access control; never returned by the session read DTOs — only masked `proxyHost`, `proxyType` (derived from the URL scheme), and `hasCredentials` on `GET/PATCH /proxy`. The userinfo is also stripped from `GET /api/infra/export-data` session rows; scheme and host survive so a restore cannot silently connect direct. |
| Bootstrap admin key file (`data/.api-key`, or `BOOTSTRAP_KEY_FILE`) | Plaintext raw ADMIN key, written `0600` on first boot                                                         | Owner-only file permissions; removed when the key it holds is revoked or deleted. Delete it once the key is stored elsewhere.                                                                                                                                                                                                         |
| Plugin instance secrets                                             | Plaintext: `plugin_instances.secret`, `verifyToken`, `config`                                                 | Database access control; `secret`, `verifyToken` and the config fields a plugin marks secret are masked on API reads, but `GET /api/infra/export-data` includes all three verbatim, so treat an export file as a secret.                                                                                                              |
| Generated config (`data/.env.generated`)                            | Plaintext file, written `0600`                                                                                | Owner-only file permissions.                                                                                                                                                                                                                                                                                                          |
| Message content                                                     | Plaintext in the `messages` table                                                                             | Database access control.                                                                                                                                                                                                                                                                                                              |

**Hardening you can apply today:** set `API_KEY_PEPPER`; restrict the data volume and database to the app's user; and encrypt at the infrastructure layer (LUKS / cloud-provider encrypted volumes / an encrypted managed Postgres) rather than relying on application-level field encryption, which is not implemented.

**Setting or changing `API_KEY_PEPPER` on an existing install invalidates every key, the admin key included.** No stored hash matches any more, minting a key needs a valid ADMIN key, and a key is seeded only into an empty `api_keys` table, so nothing can be re-issued through the API. Set the pepper before first boot. On a running install: stop the instance, set the pepper, empty the table in the main database (the `MAIN_DATABASE_NAME` path, `data/main.sqlite` by default; on a source install `sqlite3 data/main.sqlite "DELETE FROM api_keys"`, on the compose deployment `docker compose run --rm --no-deps openwa-api sqlite3 /app/data/main.sqlite "DELETE FROM api_keys"`), start the instance, take the new ADMIN key from the startup banner or `data/.api-key` (or set `API_MASTER_KEY` beforehand to choose it), then re-issue the other keys.

## 4.5 Input Validation

### Validation Rules

```mermaid
flowchart TB
    INPUT[User Input] --> V1{Type Check}
    V1 -->|Pass| V2{Length Check}
    V1 -->|Fail| ERR[400 Error]
    V2 -->|Pass| V3{Format Check}
    V2 -->|Fail| ERR
    V3 -->|Pass| V4{Sanitize}
    V3 -->|Fail| ERR
    V4 --> SAFE[Safe Input]
```

### Validation Examples

| Field                        | Rules                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatId`                     | Non-empty string — **no format pattern**; the engine resolves the id, so `@c.us`, `@g.us`, `@lid`, `@newsletter` and `status@broadcast` all pass |
| `phoneNumber` (pairing code) | Pattern: `^[0-9]{6,15}$` — digits only, international format                                                                                     |
| `url`                        | Valid URL (`require_tld: false`, so single-label hosts like `http://localhost:3000` pass); HTTPS is a recommendation, not enforced               |
| `text`                       | Max 4096 chars (`send-text`)                                                                                                                     |
| `sessionName`                | Alphanumeric + hyphen, 3-50 chars                                                                                                                |

### DTO Validation

```typescript
// src/modules/message/dto/send-message.dto.ts
export class SendTextMessageDto {
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH) // 4096, shared with the agent-tool input schemas
  text: string;
}

// src/modules/webhook/dto/webhook.dto.ts
export class CreateWebhookDto {
  // require_tld:false allows hostnames without a dot (e.g. http://localhost:3000); the SSRF
  // guard still decides whether the host may actually be delivered to. The scheme is required
  // and must be http(s); 2048 is the column width.
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @MaxCodePoints(2048)
  url: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  // The full WEBHOOK_EVENTS catalog (message.*, status.received, session.*, presence.update,
  // group.*, call.*) plus '*' for subscribe-all.
  @IsIn([...WEBHOOK_EVENTS, '*'], { each: true })
  events?: string[];
}
```

## 4.6 Rate Limiting

### Rate Limit Configuration

```mermaid
flowchart LR
    REQ[Request] --> RL{Rate Limiter}
    RL -->|Under Limit| APP[Application]
    RL -->|Over Limit| ERR[429 Too Many Requests]

    subgraph Limits["Windows (per route, per client IP)"]
        T1[short: 10 / 1s]
        T2[medium: 100 / 60s]
        T3[long: 1000 / 1h]
    end
```

### Windows

Each window is counted **per route handler per client IP** (the IP resolved through `TRUSTED_PROXIES`) by a global `ThrottlerGuard`, so a client gets the full budget on every endpoint; for an aggregate per-client cap, add a limiter at your reverse proxy. There is **no per-endpoint limit table**: these three windows apply to every non-exempt REST controller route, and exceeding any one returns `429 Too Many Requests`:

| Window   | Default limit | Window length | Env overrides                                       |
| -------- | ------------- | ------------- | --------------------------------------------------- |
| `short`  | 10 requests   | 1 s           | `RATE_LIMIT_SHORT_TTL` / `RATE_LIMIT_SHORT_LIMIT`   |
| `medium` | 100 requests  | 60 s          | `RATE_LIMIT_MEDIUM_TTL` / `RATE_LIMIT_MEDIUM_LIMIT` |
| `long`   | 1000 requests | 3600 s        | `RATE_LIMIT_LONG_TTL` / `RATE_LIMIT_LONG_LIMIT`     |

TTL values are in milliseconds. The `/api/metrics` and `/api/health*` routes are exempt (`@SkipThrottle`), and the ingress route has its own windows (below); `/api/health` still looks up at most 30 failed key presentations per client per minute, and past that answers without `version` and without a key lookup. The MCP endpoint (`/mcp`) and the Bull Board UI (`/api/admin/queues`) are raw Express mounts the guard never sees: RATE_LIMIT_* does not apply to them, and each is bounded by its own pre-auth per-IP throttle (`MCP_IP_RATE_LIMIT_MAX` / `MCP_IP_RATE_LIMIT_WINDOW_MS`). To enforce tighter per-route limits, lower the global windows or add a limiter at your reverse proxy.

An IPv6 client is keyed on its /64, so rotating addresses inside one allocation does not mint fresh buckets. The same key is used by every other per-client limit: the MCP and Bull Board pre-auth throttles, the WebSocket limits below, the per-client share of the in-flight body budget for requests without an API key, the health route's key-lookup budget and auth-failure audit bound, and the REST, queue-dashboard and MCP auth-failure audit bound. `allowedIps` matching and audit rows still see the full address.

### Response on limit

Exceeding a window returns `429 Too Many Requests`. Because the windows are **named** throttlers (`short` / `medium` / `long`), `@nestjs/throttler` suffixes every rate-limit header with the throttler name, so there are no unsuffixed `X-RateLimit-*` headers. `Retry-After` is the exception: on a `429` the guard emits the plain spelling too, because no HTTP client reads a suffixed one.

- On success, each response carries one header triple per window: `X-RateLimit-Limit-short` / `-Remaining-short` / `-Reset-short`, plus the `-medium` and `-long` equivalents.
- On `429`, the exceeded window sets `Retry-After-short`, `Retry-After-medium`, or `Retry-After-long` (seconds until the block expires), and the guard mirrors that value into a plain `Retry-After`. Read the plain one; the suffixed name is what tells an operator which window shed the request.

The ingress route (`ALL /api/ingress/:pluginId/:instanceId/*path`) is exempt from the global per-IP tiers (their 100/min medium window sits below the per-instance limit, so a provider fanning every tenant's webhooks through one egress IP was shed before the per-instance bound could fire). It carries its own two windows instead, both on `INGRESS_INSTANCE_TTL` (default 60000 ms):

- `instance`, keyed on `(pluginId, instanceId)`, env `INGRESS_INSTANCE_LIMIT`, default 120. Sheds one noisy tenant on this bucket without spending its neighbours'. Charged only once a delivery passes signature verification, so unknown-instance, failed-challenge and oversized requests never touch it. A route declaring signature scheme `none` (allowed only with `ALLOW_UNSIGNED_INGRESS=true`) passes every request, so there any caller can spend this bucket.
- `ingress-ip`, keyed on the client (proxy-aware, see `TRUSTED_PROXIES`), env `INGRESS_IP_LIMIT`, default 1200. It is checked before anything else and is the only bound on traffic that fails verification. Every ingress request counts against it, including one the `instance` window then sheds, so a tenant that pushes a shared provider IP past it sheds its neighbours on that IP too. It is sized 10x the per-instance default; raise it for a high-volume provider that delivers many tenants from one egress IP.

Every response the per-IP window admits carries `X-RateLimit-*-ingress-ip`, an acknowledged delivery also carries `X-RateLimit-*-instance`, and a `429` carries the `Retry-After-*` of whichever window shed the request, mirrored into a plain `Retry-After`.

The API exposes the rate-limit headers via CORS (`exposedHeaders`) so browser clients can read them, the plain `Retry-After` included. The simplest backpressure signal remains the `429` status itself, with `Retry-After` as the retry delay.

### In-flight request bodies

The windows above run at the routing layer, after a request body has been buffered, so they cannot bound memory held by slow uploads. A pre-routing middleware does: it caps the request-body bytes in flight across all connections at `INFLIGHT_BODY_BUDGET_BYTES` (default 4 x `BODY_SIZE_LIMIT`) and answers a request that would cross it with `503` and `Retry-After`, before reading its body. A request whose declared `Content-Length` could not fit even on an idle server (above the whole budget, its caller's share or the unkeyed pool) gets `413` instead, without `Retry-After`, since retrying it cannot succeed.

- Requests without an active API key (public ingress webhooks, unauthenticated callers) share a pool of a quarter of the budget, never less than twice `BODY_SIZE_LIMIT` (so half of the default budget), and are charged at most `BODY_SIZE_LIMIT` each. The rest is kept for requests that carry an active key. With `INFLIGHT_BODY_BUDGET_BYTES` below three times `BODY_SIZE_LIMIT` that reserve is smaller than one full-size body, and at twice `BODY_SIZE_LIMIT` or less there is none.
- A request with an active key may hold at most half of the budget per key, wherever it connects from. An unkeyed client (IPv6 on its /64) may hold at most half of the unkeyed pool, or one `BODY_SIZE_LIMIT` if that is larger, so one full-size body from one address leaves room for other unkeyed senders once `INFLIGHT_BODY_BUDGET_BYTES` is at least twice `BODY_SIZE_LIMIT`; below that the room left is the budget minus one `BODY_SIZE_LIMIT`, and at a budget equal to `BODY_SIZE_LIMIT` a single full-size unkeyed body refuses every other body-carrying request, ingress deliveries included, with `503` until it finishes. Behind a reverse proxy without `TRUSTED_PROXIES`, every unkeyed request, ingress included, keys on the proxy address and draws on that one share, so at the defaults a single full-size unkeyed upload refuses ingress deliveries with `503` until it finishes.
- Keys are recognised from an in-memory index of active keys, refreshed at once when this node changes a key and every 30 seconds for a direct write to this node's main database. Keys are per node, so a change made on another node never reaches it. The index only picks the tier; the API-key guard still authorises every request.
- A request holds its declared `Content-Length` until it finishes. After a 15-second grace it must keep up the pace that lands the whole body within `REQUEST_TIMEOUT_MS` (by default 25 MiB in 300 seconds, about 85 KiB/s); a request that falls behind is dropped and its reservation released. A chunked body holds a 1 MiB placeholder, or the bytes that have arrived once they pass it, and must deliver the placeholder at the same pace (about 3.4 KiB/s by default). If that growth crosses the budget, its client's share, or (without a key) the unkeyed pool, that request is aborted.
- A body that sends nothing for 15 seconds is dropped and its reservation released.
- Requests without a body are never refused for lack of budget.

### WebSocket (`/events`) limits

Socket.IO frames never pass through the Nest enhancer pipeline, so the HTTP windows above do **not** apply to the WebSocket surface. `EventsGateway` enforces its own in-process limits instead (all keyed in-memory per process; a blank env value falls back to the default, and one that is not a positive integer fails the boot):

| Limit                                                               | Keyed on                                                        | Default                                | Env overrides                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| Client frames (subscribe/unsubscribe/ping) — token bucket           | API key (IP, IPv6 on its /64, before auth completes)            | 60 frames/s sustained, 120-frame burst | `WS_RATE_LIMIT_FRAME_PER_SECOND` / `WS_RATE_LIMIT_FRAME_BURST`      |
| New handshakes — sliding window, enforced **before** key validation | client IP (resolved through `TRUSTED_PROXIES`, IPv6 on its /64) | 10 per 60 s                            | `WS_RATE_LIMIT_HANDSHAKE_MAX` / `WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS` |
| Simultaneous sockets                                                | API key                                                         | 16                                     | `WS_MAX_SOCKETS_PER_KEY`                                            |

The frame budget is sized ~6x above legitimate traffic: the dashboard emits ~8 subscribe frames at page mount and only occasional ping/unsubscribe frames afterwards (server→client event fan-out is not limited). The handshake window stops an unauthenticated connection flood from forcing a DB `validateApiKey` per attempt; Socket.IO's exponential-backoff reconnect (~6 attempts/min per tab) stays under it. The socket cap covers multi-tab dashboards and SDK clients sharing one key. A rejected handshake or excess socket is answered with a `RATE_LIMITED` error frame and a clean disconnect; an over-budget frame gets a `RATE_LIMITED` error frame and is not dispatched. Violations are audited as `rate_limit_exceeded`, sampled to at most one row per subject+kind per minute (suppressed occurrences are counted into the next row) so the audit trail itself cannot become the flood.

## 4.7 CORS Configuration

### CORS Settings

```typescript
// resolveCorsPolicy (src/config/bootstrap-security.ts): CORS_ORIGINS is a comma-separated
// allowlist; unset defaults to the wildcard. In production a wildcard is REFUSED — the policy
// collapses to same-origin only, with credentials off, so a misconfigured deployment cannot
// reflect arbitrary origins with credentials.
const corsPolicy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);

app.enableCors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, server-to-server)
    if (!origin) return callback(null, true);

    if (corsPolicy.allowAnyOrigin || corsPolicy.origins.includes(origin)) {
      callback(null, true);
    } else {
      // Deny WITHOUT throwing — throwing surfaced as a 500 Internal Server Error (#250).
      // Returning false simply omits the CORS headers, so the browser blocks the genuine
      // cross-origin request itself while same-origin traffic keeps working.
      callback(null, false);
    }
  },
  credentials: corsPolicy.credentials, // false whenever the allowlist is a wildcard
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Request-ID'],
  // Throttlers are named, so rate-limit headers carry a per-window suffix
  // (see "Response on limit" above); there are no unsuffixed variants.
  exposedHeaders: ['X-RateLimit-Limit-short', 'X-RateLimit-Remaining-short', '...'],
  maxAge: 86400, // 24 hours
});
```

## 4.8 Webhook Security

### Webhook Signature

```mermaid
sequenceDiagram
    participant OW as OpenWA
    participant WH as Webhook Endpoint

    OW->>OW: Create payload
    OW->>OW: Sign with HMAC-SHA256
    OW->>WH: POST + X-OpenWA-Signature
    WH->>WH: Verify signature
    WH->>WH: Process if valid
    WH-->>OW: 200 OK
```

### Signature Verification

```typescript
// OpenWA: Generate signature
function signPayload(payload: object, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  return 'sha256=' + hmac.digest('hex');
}

// Client: Verify signature
function verifySignature(payload: string, signature: string | undefined, secret: string): boolean {
  if (typeof signature !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, so a short or forged header must return false first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

### Fan-out and Payload Bounds

A single inbound event is delivered to **every** matching webhook of the session, and media arrives
from unauthenticated WhatsApp senders — so the copy amplification is bounded at four points:

| Bound                         | Knob                                      | Default                            | Behavior                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Webhooks per session          | `WEBHOOK_MAX_PER_SESSION`                 | 16 (`0` = unlimited)               | Creating a NEW webhook at/over the cap is rejected with `400`; existing webhooks are grandfathered                                                                                   |
| Autoreply rules per session   | `AUTOMATION_MAX_PER_SESSION`              | 32 (`0` = unlimited)               | Creating a NEW rule at/over the cap is rejected with `400`; existing rules are grandfathered. Every inbound message is evaluated against every rule of its session                   |
| Inline media in payloads      | `WEBHOOK_MEDIA_INLINE_MAX_BYTES`          | 1 MiB (`0` = never inline)         | Larger media is replaced once, before per-webhook cloning and WebSocket broadcast, with `media: { mimetype, filename?, omitted: true, sizeBytes }`                                   |
| Serialized body size          | `WEBHOOK_MAX_PAYLOAD_BYTES`               | 1 MiB                              | Over-budget bodies shed any remaining inline media (marker form) and are re-checked; still over budget → recorded as undelivered, never sent/queued                                  |
| Failed-job retention in Redis | queue `removeOnComplete` / `removeOnFail` | 1h/1000 completed, 24h/5000 failed | Finished jobs auto-evict; payloads were already media-shed before enqueue, so retained jobs stay small. The durable record of a lost delivery is the `webhook_delivery_failures` row |

Each webhook still receives its own copy of the event data — a `webhook:before` hook may mutate
`payload.data` in place and must not bleed into sibling deliveries — but the copy is taken after
media shedding, so it is small. The HMAC signature is computed over the exact shed bytes sent.

The two media bounds compound. `WEBHOOK_MAX_PAYLOAD_BYTES` is measured on the serialized JSON body
and applies after `WEBHOOK_MEDIA_INLINE_MAX_BYTES`; base64 inflates media by a third, so at the
defaults media above roughly 768 KiB reaches webhooks as the omitted marker. Raise both together,
with the payload limit at least 4/3 of the inline limit plus room for the envelope. The WebSocket
gateway applies only the inline limit. Media the engine downloaded stays retrievable from
`GET /api/sessions/:sessionId/messages/:chatId/:messageId/media` (`404` when nothing was stored).

A `webhook_delivery_failures` row holds no event data by default. With
`WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS` > 0 a terminal row also keeps the pre-hook event data
(already media-shed, so at most about `WEBHOOK_MEDIA_INLINE_MAX_BYTES` of media) so an ADMIN can
replay it with `POST /api/webhooks/delivery-failures/redrive`. That is message content at rest in
the data database: it is cleared once the window passes (checked at startup and then hourly; setting
the knob back to `0` clears every stored copy on the next start), it is never returned by the list
route, and `GET /api/infra/export-data` drops it from backups. With the queue enabled each job also
carries the copy in Redis for the queue's retention window.

## 4.9 Security Headers

### Helmet Configuration

The shipped configuration lives in `src/configure-app.ts` (the HTTP stack `main.ts` and the e2e suites both install), and that file is the source of truth:

```typescript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // The dashboard bundles its fonts; Bull Board's Google Fonts link is blocked (system-font fallback).
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Per-response nonce; the served dashboard document carries the same value.
      scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
      // blob: for the outgoing attachment preview, data: for chat media rendered inline.
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      // On in production, unless CSP_UPGRADE_INSECURE_REQUESTS opts an HTTP-only
      // private-network deployment out (#611).
      upgradeInsecureRequests: isUpgradeInsecureRequestsEnabled(...) ? [] : null,
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // API usage
}));
```

### Security Headers Checklist

| Header                      | Value                                          | Purpose                                                                       |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Force HTTPS                                                                   |
| `X-Content-Type-Options`    | `nosniff`                                      | Prevent MIME sniffing                                                         |
| `X-Frame-Options`           | `SAMEORIGIN`                                   | Prevent clickjacking (helmet's default; not overridden)                       |
| `X-XSS-Protection`          | `0`                                            | Helmet 8 deliberately disables the legacy auditor — the CSP is the protection |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`              | Control referrer                                                              |

## 4.10 Audit Logging

### What Gets Logged

> **Reality check:** persisted audit coverage currently includes API-key create/update/revoke/delete
> (updates carry before/after authorization state), rejected authentication, session lifecycle
> (including disconnects caused by WhatsApp unlinking the device, account restrictions and their
> lifting, and refused rebinds), integration-instance creation, update, secret rotation, deletion,
> redrive, and scope-binding bridge failures, send-pacing refusals (sampled) and breaker trips, the
> infra operations (config save, restart request, data export/import, storage export/import),
> WebSocket rate-limit violations (sampled — see §4.6), and Bull Board queue mutations. Enum
> members for API-key use, session connected, message sends, and webhook lifecycle are explicitly
> registered as intentionally unemitted; application logs cover those operational events until dedicated
> audit callsites are added. There is no global audit interceptor.

```mermaid
flowchart TB
    subgraph Events["Logged Events"]
        AUTH[Authentication attempts]
        SESS[Session operations]
        MSG[Message sends]
        WH[Webhook changes]
        ERR[Security errors]
    end

    Events --> LOG[Audit Log]
    LOG --> STORE[(Storage)]
    LOG --> ALERT[Alerts]
```

### Log Format

```json
{
  "id": "uuid",
  "action": "session_started",
  "severity": "info",
  "apiKeyId": "uuid",
  "sessionId": "sess_123",
  "ipAddress": "192.168.1.1",
  "method": "POST",
  "path": "/api/sessions/sess_123/start",
  "statusCode": 201,
  "userAgent": "MyApp/1.0",
  "metadata": {},
  "createdAt": "2026-02-02T10:00:00.000Z"
}
```

`action` is an `AuditAction` enum value (snake_case); `severity` is `info` / `warn` / `error`. There is no `requestId` or `responseTime` **column**, but the active request id is merged into the `metadata` object of every row written inside a request scope, so an entry still correlates with the application log lines for that request. There is no global request-logging interceptor — entries are written explicitly by the code paths that emit them.

### Security Alerts

> **Not implemented.** There is no alerting or automatic temp-block subsystem; the table below is a design target, not shipped behavior. The signals do get recorded: rejected authentication and WebSocket rate-limit violations write persisted audit rows, and an IP-restricted key used from a disallowed IP also emits a `logger.warn`; but nothing acts on them. A REST, queue-dashboard or MCP rejection that names no stored key (missing or unknown) is capped at 10 rows per client IP per minute; a rejection of a stored key (revoked, expired, IP or session refused, insufficient role) is recorded every time there. The public `/api/health` route bounds every auth-failure row it writes, stored key or not, at 10 per client IP per minute. Rate-limit violations are sampled. Forward the audit log / application log to your SIEM to build these alerts.

| Event                | Severity | Intended action (roadmap) |
| -------------------- | -------- | ------------------------- |
| Multiple failed auth | High     | Alert + temp block        |
| Rate limit exceeded  | Medium   | Log + block               |
| Invalid signature    | Medium   | Log                       |
| Unusual activity     | Low      | Log                       |

## 4.11 Security Checklist

### Development

- [ ] Input validation on all endpoints
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (output encoding)
- [ ] CSRF protection (if using cookies)
- [ ] Secure dependencies (npm audit)
- [ ] No secrets in code

### Deployment

- [ ] HTTPS only (TLS 1.2+)
- [ ] Security headers configured
- [ ] Rate limiting enabled
- [ ] CORS properly configured
- [ ] Firewall rules set
- [ ] Regular security updates
- [ ] Release image (releases after 0.23.7; earlier images carry no attestation) verified as built by the release workflow at its tag: `gh attestation verify oci://ghcr.io/rmyndharis/openwa:<version> --repo rmyndharis/OpenWA --signer-workflow rmyndharis/OpenWA/.github/workflows/release.yml --source-ref refs/tags/v<version>` (the same digest, and so the same check, applies to `docker.io/rmyndharis/openwa`)

### Operations

- [ ] Audit logging enabled
- [ ] Log monitoring setup
- [ ] Backup encryption
- [ ] Incident response plan
- [ ] Regular security audits

---

## 4.12 Secrets Management

### Secrets Inventory

| Secret                                                                       | Storage                                                                                                                                                           | Rotation guidance                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Database credentials                                                         | Environment variable                                                                                                                                              | 90 days                                                            |
| Redis password                                                               | Environment variable                                                                                                                                              | 90 days                                                            |
| API master key (`API_MASTER_KEY`)                                            | Environment variable (first-boot seed only)                                                                                                                       | Not via the env var; see the note below                            |
| API key pepper (`API_KEY_PEPPER`)                                            | Environment variable                                                                                                                                              | Rotating it invalidates all existing key hashes (recovery in §4.4) |
| Webhook secrets and custom headers (`webhooks.secret`, `headers`)            | Database: **plaintext** (custom headers may carry receiver credentials); not in the webhook read DTOs, and omitted from `GET /api/infra/export-data` webhook rows | Per webhook                                                        |
| Bootstrap admin key file (`data/.api-key`, or `BOOTSTRAP_KEY_FILE`)          | File system: raw ADMIN key in **plaintext**, `0600`; removed when that key is revoked or deleted                                                                  | Delete it once the key is stored elsewhere                         |
| Plugin instance secrets (`plugin_instances.secret`, `verifyToken`, `config`) | Database: **plaintext**; `secret`, `verifyToken` and secret-marked config are masked on API reads, but `GET /api/infra/export-data` includes them verbatim        | Per instance (regenerate-secret)                                   |
| Session auth state                                                           | File system (data volume) — **not encrypted**                                                                                                                     | Never (tied to the WA session)                                     |

> `API_MASTER_KEY` only seeds the first ADMIN key, and is read only while the key table is empty. Changing it later has no effect: the new value never authenticates and the seeded key stays valid. Rotate by minting a new ADMIN key with `POST /api/auth/api-keys` and revoking the seeded `Default Admin Key`.

> There is no application `ENCRYPTION_KEY` — OpenWA does not encrypt data at rest (see §4.4). The rotation cadences above are operational recommendations, not enforced by the app.

### Environment Variables Security

```bash
# ❌ BAD: Secrets hard-coded in a committed file (docker-compose.yml, Dockerfile, source)
DATABASE_PASSWORD=password123

# ✅ GOOD: Use .env file (not committed)
DATABASE_PASSWORD=${DATABASE_PASSWORD}

# ✅ BETTER: Use Docker secrets or vault
docker secret create db_password ./secret.txt
```

### Docker Secrets

> **Caveat:** the `*_FILE` convention shown below requires a secret-file reader in the app (see "Reading Secrets" below), which is **not currently implemented** — OpenWA reads secrets straight from environment variables. Until that helper exists, pass secrets as plain env vars (e.g. an `.env` file with restricted permissions) rather than `_FILE` paths.

```yaml
# Illustrative overlay — not the docker-compose.yml shipped in this repo
services:
  app:
    image: openwa:latest
    secrets:
      - db_password
      - api_master_key
    environment:
      - DATABASE_PASSWORD_FILE=/run/secrets/db_password

secrets:
  db_password:
    external: true
  api_master_key:
    external: true
```

### Reading Secrets in Application

> **Not implemented as shown.** OpenWA does **not** read `<NAME>_FILE` Docker-secret files — there is no `getSecret()` helper today. Secrets come straight from `process.env`, layered at boot as `process.env` → `.env` → `data/.env.generated` (`override:false`, so a real environment value wins). The function below is a suggested pattern to add if you want Docker-secret `_FILE` support; as-is, `DATABASE_PASSWORD_FILE` is not consulted.

```typescript
// config/secrets.ts
import { readFileSync, existsSync } from 'fs';

export function getSecret(name: string): string {
  // Try file-based secret first (Docker secrets)
  const filePath = process.env[`${name}_FILE`];
  if (filePath && existsSync(filePath)) {
    return readFileSync(filePath, 'utf8').trim();
  }

  // Fall back to environment variable
  const envValue = process.env[name];
  if (!envValue) {
    throw new Error(`Secret ${name} not configured`);
  }

  return envValue;
}

// Usage
const dbPassword = getSecret('DATABASE_PASSWORD');
const masterKey = getSecret('API_MASTER_KEY');
```

### Key Rotation Procedure

> **Not applicable today.** OpenWA stores no encrypted-at-rest data (see §4.4), so there is no data-encryption key to rotate and no `rotateEncryptionKey()` in the codebase. The flow below is illustrative for if/when field-level encryption is added. To rotate the key seeded from `API_MASTER_KEY`, mint a new ADMIN key through the API-key endpoints (§4.2) and revoke the seeded one; editing the env var has no effect after first boot. Rotating `API_KEY_PEPPER` invalidates every existing key hash; see §4.4 for the recovery.

```mermaid
flowchart TB
    A[Generate New Key] --> B[Update Secret Store]
    B --> C[Deploy with Both Keys]
    C --> D[Re-encrypt Data with New Key]
    D --> E[Verify All Data Accessible]
    E --> F[Remove Old Key]
    F --> G[Deploy with New Key Only]
```

```typescript
// Key rotation for encrypted data
async function rotateEncryptionKey(oldKey: string, newKey: string): Promise<void> {
  // 1. Get all encrypted records
  const sessions = await sessionRepo.find();

  for (const session of sessions) {
    // 2. Decrypt with old key
    const authState = decrypt(session.authState, oldKey);

    // 3. Re-encrypt with new key
    session.authState = encrypt(authState, newKey);

    await sessionRepo.save(session);
  }

  logger.log('Key rotation completed', {
    recordsUpdated: sessions.length,
  });
}
```

## 4.13 Dependency Security

### npm Audit Workflow

```bash
# Check for vulnerabilities
npm audit

# Auto-fix non-breaking vulnerabilities
npm audit fix

# View detailed report
npm audit --json > audit-report.json
```

### GitHub Dependabot Configuration

```yaml
# .github/dependabot.yml, root npm ecosystem only (the file also covers /dashboard,
# /sdk/javascript, github-actions, docker and docker-compose). The comment above each
# ignore is omitted here.
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    groups:
      minor-and-patch:
        update-types:
          - minor
          - patch
      major:
        update-types:
          - major
    labels:
      - dependencies
    ignore:
      - dependency-name: 'typescript'
        versions: ['>=7.0.0']
      - dependency-name: 'better-sqlite3'
        versions: ['>=14.0.0']
      - dependency-name: 'puppeteer'
        versions: ['>24.38.0']
      - dependency-name: 'audio-decode'
        versions: ['>=3.0.0']
      - dependency-name: '@types/node'
        versions: ['>=23.0.0']
      - dependency-name: '@nestjs/*'
        versions: ['>=12.0.0']
      - dependency-name: 'tar-stream'
        versions: ['>=3.2.1']
```

Majors arrive as their own grouped PR, separate from the minor/patch group. Five ignores freeze a
major line (TypeScript 7, better-sqlite3 14, audio-decode 3, @types/node 23 and later, NestJS 12)
and two freeze the line in use (puppeteer above the 24.38.0 pin it shares with whatsapp-web.js,
tar-stream from 3.2.1). Each ignore's reason and lift condition is the comment above it in
`.github/dependabot.yml`.

### Security Scanning in CI

> **Aspirational template, not in the repo.** There is no Snyk and no CodeQL workflow today. The actual dependency check is a dedicated `audit` job ("Security audit") in `ci.yml`, on push/PR. It is deliberately its own job rather than a step inside Lint: an advisory published against an unrelated dependency would otherwise abort the job before ESLint, the type-check and the drift gates ever ran. It runs `npm run check:audit` over the root tree and `npm audit --audit-level=high` over `dashboard/` and `sdk/javascript/`. All three fence `high` rather than `critical`: none of the trees carries a HIGH advisory today (the root reaches that through the `overrides` in `package.json`), so the threshold fences regressions. `check:audit` applies that threshold per advisory instead of all-or-nothing: an advisory with no patched version can be excused by id in `scripts/check-audit.mjs`, with its reason and its removal condition recorded beside it, rather than dropping the whole job to `critical`; an allowlist entry whose advisory has since gone fails the job too, so an exception cannot outlive its cause. The dashboard and the SDK keep the plain form: they have nothing to excuse and stay stricter than the root. Between releases, `.github/workflows/security-scan.yml` (Scheduled Security Scan) repeats that job every Wednesday at 03:00 UTC and on demand, together with the release Trivy scan against the published `latest` image on amd64 and arm64, and a `base-image-drift` job that fails when the Dockerfile's two `node:22-slim` FROM digests disagree, or when the pin differs from what the tag serves today and either the tag has served that image for 7 or more days, or for 3 or more days with the pin last changed 28 or more days ago. The workflow below is a recommended setup to add if you want Snyk and SAST; its scheduled `npm audit` is already covered by `security-scan.yml`.

```yaml
# .github/workflows/security.yml
name: Security Scan

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 0 * * 1' # Weekly on Monday

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm ci

      - name: Run npm audit
        run: npm audit --audit-level=high

      - name: Run Snyk security scan
        uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high

      - name: SAST with CodeQL
        uses: github/codeql-action/analyze@v2
```

### Allowed/Blocked Packages

Security pins for transitive dependencies live in the `overrides` field of `package.json` (for example `"multer": "2.4.0"` and `"ip-address": "^10.7.1"`), and the `audit` CI job gates regressions through `npm run check:audit` (see above). No install hook fetches an unpinned package: `postinstall` runs `npm ci` against the dashboard lockfile and the repository's own patch scripts.

### Vulnerability Response Matrix

| Severity | Response Time | Action                     |
| -------- | ------------- | -------------------------- |
| Critical | 24 hours      | Immediate patch or disable |
| High     | 72 hours      | Patch in next release      |
| Medium   | 2 weeks       | Plan for next sprint       |
| Low      | 1 month       | Backlog item               |

## 4.14 Incident Response

### Incident Severity Levels

| Level         | Description               | Example                | Response Time |
| ------------- | ------------------------- | ---------------------- | ------------- |
| P1 - Critical | Service down, data breach | Auth bypass, data leak | 15 minutes    |
| P2 - High     | Major feature broken      | Session creation fails | 1 hour        |
| P3 - Medium   | Partial degradation       | Slow webhook delivery  | 4 hours       |
| P4 - Low      | Minor issue               | UI glitch              | 24 hours      |

### Incident Response Flow

```mermaid
flowchart TB
    DETECT[Detect Incident] --> ASSESS[Assess Severity]
    ASSESS --> CONTAIN[Contain Threat]
    CONTAIN --> NOTIFY[Notify Stakeholders]
    NOTIFY --> INVESTIGATE[Investigate Root Cause]
    INVESTIGATE --> REMEDIATE[Remediate]
    REMEDIATE --> RECOVER[Recover Service]
    RECOVER --> POSTMORTEM[Post-mortem]
    POSTMORTEM --> IMPROVE[Implement Improvements]
```

### Security Incident Checklist

```markdown
## Immediate Actions (First 15 Minutes)

- [ ] Confirm incident is real (not false positive)
- [ ] Assess severity level
- [ ] Create incident channel/thread
- [ ] Assign incident commander

## Containment (First Hour)

- [ ] Identify affected systems
- [ ] Isolate compromised components
- [ ] Preserve evidence (logs, snapshots)
- [ ] Block attacker if identified

## Investigation

- [ ] Timeline of events
- [ ] Entry point identification
- [ ] Scope of compromise
- [ ] Data accessed/exfiltrated

## Recovery

- [ ] Patch vulnerability
- [ ] Reset compromised credentials
- [ ] Restore from clean backup if needed
- [ ] Verify system integrity

## Post-Incident

- [ ] Document lessons learned
- [ ] Update security controls
- [ ] Notify affected users if required
- [ ] Schedule blameless post-mortem
```

### Emergency Contacts

A template for an operator to fill in and keep outside the repository — OpenWA ships no
`config/incident-response.yml` and reads no such file. The only contact the project itself
publishes is the vulnerability-reporting channel in [SECURITY.md](../SECURITY.md); the on-call,
channel and status-page entries below are placeholders with no upstream default.

```yaml
# config/incident-response.yml — operator-supplied, not shipped
contacts:
  primary_oncall:
    name: 'On-Call Engineer'
    phone: '+62xxx'
    slack: '@oncall'

  security_lead:
    name: 'Security Lead'
    email: 'yudhi@rmyndharis.com' # see SECURITY.md — GitHub Security Advisories preferred

  escalation:
    - level: 1
      wait: 15m
      contact: primary_oncall
    - level: 2
      wait: 30m
      contact: security_lead

communication:
  internal_channel: '' # e.g. a chat channel you own
  status_page: '' # e.g. a status page you own; the project publishes none
```

### Runbooks

```markdown
## Runbook: Suspected Data Breach

### Detection Signals

- Unusual API access patterns
- Large data exports
- Authentication from new locations
- Failed auth attempts spike

### Immediate Steps

1. Rotate all API keys for affected accounts
2. Enable IP whitelisting if not already
3. Check audit logs for scope
4. Snapshot affected database

### Evidence Collection

- Capture the audit log (the `audit_logs` table / audit query API) and the application logs (`docker compose logs openwa-api`) — there is no `logs:export` script
- Database query logs
- Network traffic captures
- System metrics at incident time
```

### Post-Mortem Template

```markdown
# Incident Post-Mortem: [Title]

**Date:** YYYY-MM-DD
**Severity:** P1/P2/P3
**Duration:** X hours
**Author:** [Name]

## Summary

Brief description of what happened.

## Impact

- Users affected: X
- Data compromised: None/Partial/Full
- Revenue impact: $X

## Timeline

| Time (UTC) | Event                 |
| ---------- | --------------------- |
| 10:00      | Alert triggered       |
| 10:05      | Incident confirmed    |
| 10:15      | Containment started   |
| 11:00      | Root cause identified |
| 12:00      | Service restored      |

## Root Cause

Technical explanation of what went wrong.

## What Went Well

- Detection was quick
- Communication was clear

## What Went Wrong

- Missing monitoring for X
- Delayed response due to Y

## Action Items

| Item                 | Owner     | Due Date   | Status |
| -------------------- | --------- | ---------- | ------ |
| Add monitoring for X | @eng      | 2026-02-15 | Open   |
| Update runbook       | @security | 2026-02-10 | Open   |

## Lessons Learned

Key takeaways for preventing future incidents.
```

---

<div align="center">

[← 03 - System Architecture](./03-system-architecture.md) · [Documentation Index](./README.md) · [Next: 05 - Database Design →](./05-database-design.md)

</div>

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
Format: owa_<32-character-random-string>
Example: owa_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6

Storage: SHA-256 hash only (never store plain key)
```

### Permission Model

| Permission | Description |
|------------|-------------|
| `*` | Full access (admin) |
| `sessions:read` | View sessions |
| `sessions:write` | Create/delete sessions |
| `messages:send` | Send messages |
| `messages:read` | Read message history |
| `webhooks:manage` | CRUD webhooks |
| `contacts:read` | View contacts |
| `groups:read` | View groups |
| `groups:write` | Manage groups |

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
    CHECK -->|No| R403[403 Forbidden]
    CHECK -->|Yes| ALLOW
    ALLOW --> PROCESS[Process Request]
```

### Configuration

```typescript
// API to manage IP whitelist
interface IpWhitelistEntry {
  id: string;
  apiKeyId: string;
  ipAddress: string;      // Single IP: "203.0.113.50"
  cidrRange?: string;     // CIDR: "10.0.0.0/24"
  description?: string;
  active: boolean;
  createdAt: Date;
}
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

```typescript
// IP Whitelist Guard
@Injectable()
export class IpWhitelistGuard implements CanActivate {
  constructor(
    private readonly ipWhitelistService: IpWhitelistService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKeyId = request.apiKey?.id;

    if (!apiKeyId) {
      return true; // Let other guards handle missing API key
    }

    const clientIp = this.getClientIp(request);
    const whitelist = await this.ipWhitelistService.getByApiKey(apiKeyId);

    // If no whitelist entries, allow all IPs
    if (whitelist.length === 0) {
      return true;
    }

    // Check if IP matches any whitelist entry
    const isAllowed = whitelist.some(entry =>
      this.ipMatches(clientIp, entry)
    );

    if (!isAllowed) {
      throw new ForbiddenException({
        code: 'IP_NOT_WHITELISTED',
        message: `IP address ${clientIp} is not in the whitelist`,
      });
    }

    return true;
  }

  private getClientIp(request: Request): string {
    // Handle proxies (X-Forwarded-For, X-Real-IP)
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      return (forwarded as string).split(',')[0].trim();
    }
    return request.headers['x-real-ip'] as string ||
           request.socket.remoteAddress ||
           '';
  }

  private ipMatches(clientIp: string, entry: IpWhitelistEntry): boolean {
    if (!entry.active) return false;

    if (entry.cidrRange) {
      return this.ipInCidr(clientIp, entry.cidrRange);
    }

    return clientIp === entry.ipAddress;
  }

  private ipInCidr(ip: string, cidr: string): boolean {
    // IPv4-only example. For IPv6 support, use a library like ipaddr.js.
    const [range, bits] = cidr.split('/');
    const mask = ~(2 ** (32 - parseInt(bits)) - 1);

    const ipNum = this.ipToNumber(ip);
    const rangeNum = this.ipToNumber(range);

    return (ipNum & mask) === (rangeNum & mask);
  }

  private ipToNumber(ip: string): number {
    return ip.split('.').reduce(
      (acc, octet) => (acc << 8) + parseInt(octet), 0
    ) >>> 0;
  }
}
```

### Best Practices

| Practice | Description |
|----------|-------------|
| **Use CIDR notation** | For IP ranges, use CIDR instead of multiple entries |
| **Trusted Proxies** | Configure trusted proxies for accurate client IP |
| **Regular Review** | Review whitelist entries regularly |
| **Audit Logging** | Log all blocked attempts for monitoring |
| **Fallback Plan** | Prepare a process to update the whitelist when IPs change |

### IPv6 Support

For IPv6, use a library that supports IPv6 parsing (e.g., `ipaddr.js`) when performing `ipInCidr`.

## 4.4 Data Encryption

### In Transit

OpenWA serves plain HTTP on its port; terminate **TLS at your reverse proxy / load balancer** (nginx, Traefik, Caddy) and expose the gateway only over HTTPS in production. The API key is bearer-equivalent and is sent on every request, so it must never traverse plaintext `http://` outside local development.

### At Rest

> **There is currently no application-level encryption at rest.** API keys are stored **hashed** (one-way), but other sensitive values are stored as plaintext in the database / on disk and are protected by filesystem and database permissions, not by encryption. Encryption at rest for these fields is a roadmap item, not a shipped feature — do not assume it.

| Data | At rest | How it is protected |
|------|---------|---------------------|
| API keys | **Hashed** — SHA-256 with an optional `API_KEY_PEPPER` HMAC; never reversible | A database leak alone cannot recover the keys; with a pepper set, hashes can't be precomputed offline. See §4.2. |
| Session auth state (WhatsApp credentials) | Plaintext on disk (the engine's auth store under the data volume) | Filesystem permissions on the data volume — keep it private. |
| Webhook secrets | Plaintext — `webhooks.secret` (`varchar`) | Database access control; never returned by any API response (write-only response DTO). |
| Proxy credentials | Plaintext — `sessions.proxyUrl` may embed `user:pass` | Database access control; never returned by the session read DTOs. |
| Generated config (`data/.env.generated`) | Plaintext file, written `0600` | Owner-only file permissions. |
| Message content | Plaintext in the `messages` table | Database access control. |

**Hardening you can apply today:** set `API_KEY_PEPPER`; restrict the data volume and database to the app's user; and encrypt at the infrastructure layer (LUKS / cloud-provider encrypted volumes / an encrypted managed Postgres) rather than relying on application-level field encryption, which is not implemented.

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

| Field | Rules |
|-------|-------|
| `chatId` | Pattern: `^\d+@(c\.us\|g\.us)$` |
| `phone` | Pattern: `^\d{10,15}$` |
| `url` | Valid URL, HTTPS only for webhooks |
| `text` | Max 4096 chars (`send-text`) |
| `sessionName` | Alphanumeric + hyphen, 3-50 chars |

### DTO Validation

```typescript
// Example DTO with validation
import { IsString, IsUrl, Matches, MaxLength } from 'class-validator';

export class SendTextDto {
  @IsString()
  @Matches(/^\d+@(c\.us|g\.us)$/, {
    message: 'Invalid chatId format',
  })
  chatId: string;

  @IsString()
  @MaxLength(4096)
  text: string;
}

export class CreateWebhookDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url: string;

  @IsArray()
  @IsIn(['message.received', 'message.sent', 'session.status'], { each: true })
  events: string[];
}
```

## 4.6 Rate Limiting

### Rate Limit Configuration

```mermaid
flowchart LR
    REQ[Request] --> RL{Rate Limiter}
    RL -->|Under Limit| APP[Application]
    RL -->|Over Limit| ERR[429 Too Many Requests]
    
    subgraph Limits["Global windows (per client IP)"]
        T1[short: 10 / 1s]
        T2[medium: 100 / 60s]
        T3[long: 1000 / 1h]
    end
```

### Windows

All limits are **global and per client IP** (resolved through `TRUSTED_PROXIES`), applied by a global `ThrottlerGuard`. There is **no per-endpoint limit table** — these three windows apply to every non-exempt route, and exceeding any one returns `429 Too Many Requests`:

| Window | Default limit | Window length | Env overrides |
|--------|---------------|---------------|---------------|
| `short` | 10 requests | 1 s | `RATE_LIMIT_SHORT_TTL` / `RATE_LIMIT_SHORT_LIMIT` |
| `medium` | 100 requests | 60 s | `RATE_LIMIT_MEDIUM_TTL` / `RATE_LIMIT_MEDIUM_LIMIT` |
| `long` | 1000 requests | 3600 s | `RATE_LIMIT_LONG_TTL` / `RATE_LIMIT_LONG_LIMIT` |

TTL values are in milliseconds. The `/api/metrics` and `/api/health*` routes are exempt (`@SkipThrottle`). To enforce tighter per-route limits, lower the global windows or add a limiter at your reverse proxy.

### Response on limit

Exceeding any window returns `429 Too Many Requests` with a `Retry-After` header. The `ThrottlerGuard` also sets `X-RateLimit-*` response headers (limit / remaining / reset) by default, and the API exposes them via CORS — but with three named windows in play, the `429` + `Retry-After` is the simplest backpressure signal to act on.

## 4.7 CORS Configuration

### CORS Settings

```typescript
// Secure CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = process.env.CORS_ORIGINS?.split(',') || [];
    
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Request-ID'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  maxAge: 86400, // 24 hours
};
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
function verifySignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

## 4.9 Security Headers

### Recommended Headers

```typescript
// Helmet configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
```

### Security Headers Checklist

| Header | Value | Purpose |
|--------|-------|---------|
| `Strict-Transport-Security` | `max-age=31536000` | Force HTTPS |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `X-XSS-Protection` | `1; mode=block` | XSS filter |
| `Referrer-Policy` | `strict-origin` | Control referrer |

## 4.10 Audit Logging

### What Gets Logged

> **Reality check:** audit entries are persisted to the `audit_logs` table, but **only session-lifecycle actions are emitted today** (`session_created` / `session_started` / `session_stopped` / `session_force_killed` / `session_deleted` / `session_qr_generated`). The `AuditAction` enum also defines `api_key_auth_failed`, `message_sent`, and `webhook_*`, but **no code path emits them** (there is no global audit interceptor) — so failed auth, message sends, and webhook changes are **not** in the audit log yet (a tracked enhancement). Failed authentication currently surfaces only as a `logger.warn` in the application log. The diagram below is the intended coverage.

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
  "ip": "192.168.1.1",
  "method": "POST",
  "path": "/api/sessions/sess_123/start",
  "statusCode": 201,
  "userAgent": "MyApp/1.0",
  "metadata": {},
  "createdAt": "2026-02-02T10:00:00.000Z"
}
```

`action` is an `AuditAction` enum value (snake_case); `severity` is `info` / `warn` / `error`. There is no `requestId` or `responseTime` field, and no global request-logging interceptor — entries are written explicitly by the code paths that emit them.

### Security Alerts

> **Not implemented.** There is no alerting or automatic temp-block subsystem; the table below is a design target, not shipped behavior. The only related runtime behavior today is a `logger.warn` when an IP-restricted key is used from a disallowed IP. Forward the audit log / application log to your SIEM to build these alerts.

| Event | Severity | Intended action (roadmap) |
|-------|----------|---------------------------|
| Multiple failed auth | High | Alert + temp block |
| Rate limit exceeded | Medium | Log + block |
| Invalid signature | Medium | Log |
| Unusual activity | Low | Log |

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

### Operations

- [ ] Audit logging enabled
- [ ] Log monitoring setup
- [ ] Backup encryption
- [ ] Incident response plan
- [ ] Regular security audits

---

## 4.12 Secrets Management

### Secrets Inventory

| Secret | Storage | Rotation guidance |
|--------|---------|-------------------|
| Database credentials | Environment variable | 90 days |
| Redis password | Environment variable | 90 days |
| API master key (`API_MASTER_KEY`) | Environment variable | 180 days |
| API key pepper (`API_KEY_PEPPER`) | Environment variable | Rotating it invalidates all existing key hashes |
| Webhook secrets | Database — **plaintext**; never returned by the API | Per webhook |
| Session auth state | File system (data volume) — **not encrypted** | Never (tied to the WA session) |

> There is no application `ENCRYPTION_KEY` — OpenWA does not encrypt data at rest (see §4.4). The rotation cadences above are operational recommendations, not enforced by the app.

### Environment Variables Security

```bash
# ❌ BAD: Secrets in code or docker-compose.yml
DATABASE_URL=postgresql://user:password123@localhost:5432/db

# ✅ GOOD: Use .env file (not committed)
DATABASE_URL=${DATABASE_URL}

# ✅ BETTER: Use Docker secrets or vault
docker secret create db_password ./secret.txt
```

### Docker Secrets

> **Caveat:** the `*_FILE` convention shown below requires a secret-file reader in the app (see "Reading Secrets" below), which is **not currently implemented** — OpenWA reads secrets straight from environment variables. Until that helper exists, pass secrets as plain env vars (e.g. an `.env` file with restricted permissions) rather than `_FILE` paths.

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  app:
    image: openwa:latest
    secrets:
      - db_password
      - encryption_key
      - api_master_key
    environment:
      - DATABASE_PASSWORD_FILE=/run/secrets/db_password
      - ENCRYPTION_KEY_FILE=/run/secrets/encryption_key

secrets:
  db_password:
    external: true
  encryption_key:
    external: true
  api_master_key:
    external: true
```

### Reading Secrets in Application

> **Not implemented as shown.** OpenWA does **not** read `<NAME>_FILE` Docker-secret files — there is no `getSecret()` helper today. Secrets come straight from `process.env`, layered at boot as `process.env` → `.env` → `data/.env.generated` (`override:false`, so a real environment value wins). The function below is a suggested pattern to add if you want Docker-secret `_FILE` support; as-is, `DATABASE_PASSWORD_FILE` / `ENCRYPTION_KEY_FILE` are not consulted.

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
const encryptionKey = getSecret('ENCRYPTION_KEY');
const dbPassword = getSecret('DATABASE_PASSWORD');
```

### Key Rotation Procedure

> **Not applicable today.** OpenWA stores no encrypted-at-rest data (see §4.4), so there is no data-encryption key to rotate and no `rotateEncryptionKey()` in the codebase. The flow below is illustrative for if/when field-level encryption is added. To rotate the `API_MASTER_KEY` or `API_KEY_PEPPER`, use the API-key endpoints (§4.2) — rotating the pepper invalidates existing key hashes.

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
async function rotateEncryptionKey(
  oldKey: string,
  newKey: string
): Promise<void> {
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
    recordsUpdated: sessions.length 
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
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 10
    groups:
      development-dependencies:
        dependency-type: "development"
      production-dependencies:
        dependency-type: "production"
    ignore:
      # Major version updates require manual review
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
```

### Security Scanning in CI

> **Aspirational template — not in the repo.** There is no `security.yml`, no Snyk, and no CodeQL workflow today. The actual dependency check is an inline step in `ci.yml` (`npm audit --audit-level=critical`, run on push/PR — not on a schedule). The workflow below is a recommended setup to add if you want scheduled scanning and SAST.

```yaml
# .github/workflows/security.yml
name: Security Scan

on:
  push:
    branches: [main, develop]
  schedule:
    - cron: '0 0 * * 1'  # Weekly on Monday

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

```json
// package.json
{
  "overrides": {
    // Force specific version for security fix
    "lodash": "^4.17.21"
  },
  "scripts": {
    "preinstall": "npx npm-force-resolutions"
  }
}
```

### Vulnerability Response Matrix

| Severity | Response Time | Action |
|----------|---------------|--------|
| Critical | 24 hours | Immediate patch or disable |
| High | 72 hours | Patch in next release |
| Medium | 2 weeks | Plan for next sprint |
| Low | 1 month | Backlog item |

## 4.14 Incident Response

### Incident Severity Levels

| Level | Description | Example | Response Time |
|-------|-------------|---------|---------------|
| P1 - Critical | Service down, data breach | Auth bypass, data leak | 15 minutes |
| P2 - High | Major feature broken | Session creation fails | 1 hour |
| P3 - Medium | Partial degradation | Slow webhook delivery | 4 hours |
| P4 - Low | Minor issue | UI glitch | 24 hours |

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

```yaml
# config/incident-response.yml
contacts:
  primary_oncall:
    name: "On-Call Engineer"
    phone: "+62xxx"
    slack: "@oncall"
    
  security_lead:
    name: "Security Lead"
    email: "security@openwa.dev"
    
  escalation:
    - level: 1
      wait: 15m
      contact: primary_oncall
    - level: 2  
      wait: 30m
      contact: security_lead

communication:
  internal_channel: "#incident-response"
  status_page: "https://status.openwa.dev"
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
- Capture the audit log (the `audit_logs` table / audit query API) and the application logs (`docker compose logs openwa`) — there is no `logs:export` script
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
| Time (UTC) | Event |
|------------|-------|
| 10:00 | Alert triggered |
| 10:05 | Incident confirmed |
| 10:15 | Containment started |
| 11:00 | Root cause identified |
| 12:00 | Service restored |

## Root Cause
Technical explanation of what went wrong.

## What Went Well
- Detection was quick
- Communication was clear

## What Went Wrong
- Missing monitoring for X
- Delayed response due to Y

## Action Items
| Item | Owner | Due Date | Status |
|------|-------|----------|--------|
| Add monitoring for X | @eng | 2026-02-15 | Open |
| Update runbook | @security | 2026-02-10 | Open |

## Lessons Learned
Key takeaways for preventing future incidents.
```
---

<div align="center">

[← 03 - System Architecture](./03-system-architecture.md) · [Documentation Index](./README.md) · [Next: 05 - Database Design →](./05-database-design.md)

</div>

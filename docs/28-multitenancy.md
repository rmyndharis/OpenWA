# 28 - Multitenancy

> **Status:** Draft (design proposal — nothing here is implemented). This document defines the target
> architecture for operating OpenWA as a multi-tenant platform: tenant identity, access control, 2FA,
> per-tenant branding, isolation, quotas, and the migration path from today's single-operator model.

## 28.1 Goals & non-goals

**Goals**

- One OpenWA deployment safely hosts many independent organizations (tenants), each with its own
  WhatsApp sessions, users, API keys, branding, plugins, and data — with no cross-tenant visibility.
- Enterprise-grade identity: named users with per-tenant roles and optional/enforced two-factor
  authentication (TOTP), alongside the existing API-key model for programmatic access.
- A migration path where today's single-tenant installations keep working unchanged (everything
  lands in a default tenant).

**Non-goals (explicitly out of scope for the first phases)**

- Billing, seat management, and subscription metering.
- Per-tenant database servers or per-tenant process isolation (see the isolation decision in 28.4).
- Public self-service tenant signup (tenants are provisioned by a platform admin).

## 28.2 Current state assessment

OpenWA today is **multi-session, not multi-tenant**. What already exists and is reused by this design:

| Primitive | Where | Reuse |
|---|---|---|
| Many WhatsApp sessions per deployment, engine-isolated | `session.service.ts` | Sessions become tenant-owned resources |
| API keys with roles (`ADMIN/OPERATOR/VIEWER`) and an `allowedSessions` scope; list + stats already scope-filtered | `api-key.entity.ts:37`, `api-key.guard.ts:64-77`, `session.controller.ts:68-70` | Evolves into tenant-scoped keys; the enforcement pattern (guard-level session resolution) is exactly where tenant checks plug in |
| Per-session plugin activation and per-session config overrides | `sessionConfig` in the plugin loader | Per-tenant plugin policy on top |
| All business data keyed by `sessionId` | messages, audit_log, webhooks, templates | Adding `tenantId` alongside is mechanical |
| Per-request ALS actor stamping (audit attribution) | `request-context.ts` | Audit gains `tenantId` at the same point |

**The gaps** (what makes it not multi-tenant today): no tenant entity, no named users or
memberships, dashboard identity is the API key itself, all branding is global (engine device name,
dashboard theme/logo/title), storage/backups/quota are global, and there is no tenant-scoped audit
boundary.

## 28.3 Definitions & mental model

- **Platform admin** — operates the deployment (today's `ADMIN` key owner). Provisions tenants,
  never reads tenant message content by default (see 28.14).
- **Tenant** — an organization. Owns sessions, users, API keys, plugins-activation, branding,
  quotas, and a data partition. Identified by `tenantId` (uuid) + a stable `slug`.
- **Membership** — a named **user**'s relationship to a tenant, with a **tenant role**
  (`owner`, `admin`, `operator`, `viewer`). One user may belong to many tenants.
- **Tenant role vs platform role** — today's global `ApiKeyRole` becomes the *platform* role; the
  tenant role governs what a user/key may do *inside* one tenant. The full matrix is in 28.5.3.

Everything tenant-owned carries `tenantId`: sessions, API keys, users (via memberships), plugin
activations, webhook endpoints, templates, and every row derived from sessions (messages, audit,
search indexes are recomputed from the `sessionId → tenantId` mapping, so no per-row backfill of
message tables is required).

## 28.4 Isolation architecture (decision)

Chosen: **shared database, `tenantId` on every tenant-owned row, enforced at the service/guard
boundary** — the same boundary that already enforces `allowedSessions` today.

| Option | Verdict | Why |
|---|---|---|
| Row-level (`tenantId` columns, shared schema) | **Chosen** | Matches the existing `sessionId` pattern, zero-infra migration, per-tenant backup/filtering still possible, and PostgreSQL RLS remains a later hardening option |
| Schema-per-tenant (Postgres) | Later option | Real isolation at the DB layer, but migrations × N tenants and cross-tenant platform tables get awkward; revisit if a customer contract demands it |
| Database-per-tenant | Rejected for now | Operational complexity (migrations, pooling, backup orchestration) buys little at this scale |

Hard rule: **no query returns rows without a tenant predicate**. The guard resolves the tenant
context once per request (from key/user + route session) and the service layer composes with it —
mirroring how `allowedSessions` is enforced in `ApiKeyGuard` and `SessionService.findAll` today,
so there is one chokepoint to audit instead of a filter remembered per query.

## 28.5 Identity & access management

### 28.5.1 Users & memberships

New `users` (email, display name, password hash (argon2id), TOTP fields, status) and
`memberships` (`userId`, `tenantId`, `tenantRole`, `createdAt`). Login moves from "paste one API
key" to email+password (+2FA), while **API keys remain first-class for programmatic access** —
now owned by a tenant (`tenantId` + optional `allowedSessions` narrowing inside it) rather than
by the deployment.

### 28.5.2 Two-factor authentication (TOTP)

2FA is included because the admin surface controls real WhatsApp sessions and message flows —
shared API keys already outgrew "one strong secret is enough".

- **Enrollment**: standard TOTP secret (shown once as text + otpauth:// QR), activated only after
  one valid code; 10 single-use **backup codes** (hashed at rest) for device loss.
- **Enforcement modes**: per-user opt-in (default), tenant-enforced (tenant owner requires it for
  all memberships), platform-enforced (deployment-wide).
- **Login flow**: email+password → short-lived `preAuthToken` → TOTP/backup-code challenge →
  full session token. `preAuthToken` can do nothing else and expires in 5 minutes.
- **Reset**: tenant owner/platform admin can reset a member's 2FA (audit-logged); backup codes are
  single-use and regenerating them invalidates the previous set.
- API keys are **not** behind 2FA (they are secrets, not logins) — same model as GitHub/AWS.

### 28.5.3 Role matrix (target)

| Capability | Platform admin | Tenant owner | Tenant admin | Tenant operator | Tenant viewer |
|---|---|---|---|---|---|
| Provision/suspend tenants | ✓ | – | – | – | – |
| Manage tenant members & roles | – | ✓ | ✓ | – | – |
| Manage tenant API keys | – | ✓ | ✓ | – | – |
| Create/delete sessions | – | ✓ | ✓ | – | – |
| Send messages, manage webhooks/templates | – | ✓ | ✓ | ✓ | – |
| View sessions, messages, logs | – | ✓ | ✓ | ✓ | ✓ |
| Configure tenant branding | – | ✓ | ✓ | – | – |
| Manage own 2FA | every named user | | | | |
| Reset members' 2FA | ✓ | ✓ | – | – | – |

### 28.5.4 SSO / SCIM (phase 3 markers)

OIDC login (Google/Microsoft/any IdP) and SCIM provisioning are deliberately deferred: they only
make sense once users/memberships exist, and the membership model here is designed to accept them
without schema change.

## 28.6 Per-tenant branding

- **Linked-device identity**: the engine's browser display name (the `BAILEYS_BROWSER` tuple)
  resolves per session: `session.config.browserName` → `tenant.branding.deviceName` → global
  `BAILEYS_BROWSER_NAME` env → `'OpenWA'`. This supersedes the global-only env approach for
  white-label tenants while keeping a global fallback.
- **Dashboard**: `tenant.branding` (display name, logo URL, optional accent color within the
  existing token system) applied at login and in the shell; global defaults when absent.
- **Outbound identity**: webhook `User-Agent` and dashboard page titles take the tenant brand
  when present.

## 28.7 Data & storage isolation

- **Session/engine data**: `SESSION_DATA_PATH/<tenantId>/<sessionId>` (migration moves existing
  dirs under the default tenant).
- **Media/object storage**: S3 prefix per tenant (or per-tenant bucket policy later); local
  storage mirrors the same layout.
- **Backup/restore**: per-tenant export (sessions + config + keys + branding, message tables
  optionally excluded) so a tenant can be moved or archived independently.

## 28.8 Quotas & rate limiting

New `tenant_quotas` (maxSessions, maxUsers, maxApiKeys, maxMessagesPerDay, maxWebhookEndpoints,
maxPluginInstalls) with sensible unlimited defaults. The existing per-IP/per-key throttlers stay
as coarse guards; per-tenant counters are checked at the same chokepoints (session create, key
create, send path).

## 28.9 Plugins per tenant

Installation stays platform-global (one code copy), **activation and config stay per session**,
governed by an optional tenant policy: `tenant.pluginPolicy = { allow: [...], deny: [...] }`
evaluated at install/enable time. Tenant secrets live only in that tenant's sessionConfig slice,
as today.

## 28.10 Observability

- **Audit log** gains `tenantId` (stamped from the same ALS actor point as `apiKeyId` today) and
  becomes tenant-filterable; platform admins see the deployment-wide stream.
- **Metrics** (Prometheus) label session-scoped series with `tenantId` where cheap; dashboards can
  slice per tenant.
- **Logs** keep the existing structured shape; the tenant id joins the per-request log context
  alongside `requestId`/actor.

## 28.11 API surface (additive, no breaking changes)

- `POST/GET/PATCH/DELETE /api/platform/tenants` (platform admin), with suspend/resume.
- `GET/POST/PATCH/DELETE /api/tenants/:tenantId/members` (tenant owner/admin).
- `POST /api/auth/login` (email+password), `POST /api/auth/2fa/verify`,
  `POST /api/auth/2fa/enroll`, `POST /api/auth/2fa/activate`, `POST /api/auth/2fa/backup-codes`,
  `POST /api/auth/2fa/reset` (privileged).
- `PATCH /api/sessions/:id` gains an optional `tenantId` (assign on create/move by platform admin).
- Existing tenant-scoped routes resolve the tenant from the key/user; `X-Tenant-Id` header is
  accepted only from platform admins (tenant switching without a second key).
- Public config endpoint exposes the active tenant's branding for the login page.

## 28.12 Dashboard UX

- Login: email+password → optional TOTP challenge; tenant switcher in the sidebar for
  multi-tenant users; tenant admin pages (members, keys, branding, quotas); a 2FA section in the
  user menu (enroll, backup codes, reset for admins).
- Every list/view is implicitly tenant-scoped; platform admins get an explicit tenant picker.

## 28.13 Migration & rollout

1. Create the **default tenant** and backfill: all existing sessions, API keys, plugin
   activations, and templates point at it; existing full-access API keys keep working untouched
   (they become keys of the default tenant).
2. Ship behind `MULTITENANCY_ENABLED=true` (default **off**): when off, the tenant layer is a
   no-op pass-through to the default tenant and behavior is byte-identical to today.
3. Dashboard gains user login as an *additional* method; API-key login stays supported
   indefinitely.

## 28.14 Security model & test matrix

- **Single chokepoint**: tenant context resolved in the guard; services never accept a tenant id
  from the client except the platform-admin override (28.11).
- **No platform-admin read-path to tenant content by default** (support operations go through an
  explicit, audit-logged impersonation action).
- **Required test matrix**: cross-tenant read on every tenant-owned route (sessions, messages,
  stats, webhooks, templates, plugins, audit), membership/role enforcement, 2FA enrollment and
  challenge, backup-code single-use, per-tenant quota denial, branding fallback order, migration
  idempotency (second boot is a no-op).

## 28.15 Phasing

| Phase | Contents | Sizing note |
|---|---|---|
| **P0 — Foundations** | Tenant entity + `tenantId` everywhere, default-tenant migration, guard chokepoint, tenant-scoped keys, cross-tenant test matrix, `MULTITENANCY_ENABLED` flag | The platform everything hangs off; largest single block |
| **P1 — Users & 2FA** | users/memberships, email+password login, TOTP enroll/challenge/backup codes, tenant roles matrix, dashboard login + tenant switcher | Independent of P0's data model but layered on it |
| **P2 — Branding, quotas, observability** | per-tenant branding (device name, dashboard, UA), tenant quotas + counters, audit `tenantId`, per-tenant backup/export | Mostly small, parallelizable pieces |
| **P3 — Enterprise extras** | OIDC/SSO, SCIM provisioning, schema-per-tenant evaluation, audit export, impersonation support flow | Only after P0–P2 prove out |

## 28.16 Open questions

1. Do platform admins ever get a legitimate read path into tenant message content, and if so under
   what audit/impersonation ceremony?
2. Should tenant slug be immutable once sessions exist (webhook URLs may embed it later)?
3. Is per-message-type or per-recipient rate limiting part of tenant quotas, or left to the
   existing anti-abuse layer?
4. Does 2FA enforcement also cover API-key *management* actions (create/revoke), not just login?

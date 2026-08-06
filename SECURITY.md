# Security Policy

OpenWA is a self-hosted WhatsApp API gateway. It handles API-key authentication,
WhatsApp session credentials, message data, and — optionally — access to the Docker
socket. Security matters here, and we appreciate responsible disclosure.

## Supported versions

Security fixes land on the latest minor release (currently 0.14.x). Older minor
lines receive no backports — please upgrade older deployments.

| Version | Supported          |
| ------- | ------------------ |
| 0.14.x  | :white_check_mark: |
| < 0.14  | :x:                |

## Reporting a vulnerability

**Please do not open a public issue, discussion, or PR for a security vulnerability.**

Report it privately through either channel:

- **GitHub Security Advisories** (preferred) — open a private report at
  <https://github.com/rmyndharis/OpenWA/security/advisories/new>
- **Email** — yudhi@rmyndharis.com

Please include, where possible:

- A description of the issue and its impact
- Steps to reproduce or a proof of concept
- Affected version(s) and deployment details (Docker / bare metal, database, engine)

### What to expect

- An acknowledgement, typically within a few days
- An assessment, and — where applicable — a coordinated fix and release
- Credit in the advisory / release notes, unless you'd prefer to remain anonymous

## Hardening notes for operators

OpenWA already ships several hardening measures: API-key auth with roles
(ADMIN / OPERATOR / VIEWER), optional outbound webhook SSRF protection, a production
CORS policy (wildcard origins refused in production), request body-size limits, a
non-root application container, path-containment checks on storage import/export,
and a Docker socket-proxy as the sole gateway to the Docker daemon.

When exposing OpenWA, please review the security-relevant configuration documented in
the README and `docs/` — in particular `CORS_ORIGINS`, `ALLOW_DEV_API_KEY`,
`ENABLE_SWAGGER`, `WEBHOOK_SSRF_PROTECT`, `BODY_SIZE_LIMIT`, and the Docker proxy setup.
Never expose the dashboard/API to the public internet with the development API key
enabled.

### Docker socket proxy — scope and residual risk

The application container never mounts `/var/run/docker.sock`; it reaches the daemon
only through the bundled `docker-proxy` sidecar (pinned `tecnativa/docker-socket-proxy`),
which listens solely on an internal Compose network that no other container joins.
The proxy enables only the endpoint families the built-in datastore orchestration
needs (`CONTAINERS`, `IMAGES`, `VOLUMES`, `INFO`, `PING`) plus its single `POST`
method switch.

This is **not** a fine-grained privilege boundary, and we deliberately do not claim
it as one:

- The proxy's method gate is all-or-nothing (`deny unless METH_GET || env(POST)`):
  with `POST` enabled, every HTTP method — including `DELETE` — is admitted to the
  enabled paths. Its `DELETE` env flag is dead config and is no longer set.
- The proxy cannot scope container-create payloads (image, bind mounts, privileges).
  A compromised API container could therefore create a container with a host
  bind-mount, which is host-root-equivalent.

Mitigations in place: the proxy is unreachable except from `openwa-api` (dedicated
`internal: true` network), the orchestration endpoints require an ADMIN-role API key,
both teardown and start are constrained to the three managed profiles (`postgres`,
`redis`, `minio`) — non-managed names are dropped before reaching `DockerService` —
and OpenWA itself never issues deletes (profile teardown is stop-only). If you do not
use the built-in datastore orchestration (Dashboard → Infrastructure built-in
toggles), disable the proxy entirely — see the `docker-proxy` comments in
`docker-compose.yml`; `DockerService` then reports Docker unavailable and
orchestration degrades gracefully.

### Session-restricted API keys

An API key can be restricted to a subset of sessions (`allowedSessions`). A key
with a non-empty restriction is denied on every route that acts on the whole
deployment rather than on a single session:

- Infrastructure routes (`/api/infra/*`)
- API-key lifecycle routes (`/api/auth/api-keys/*`)
- Plugin installation and lifecycle (`/api/plugins/*` — per-session activation
  and per-session config remain available, scoped to the sessions the key
  allows)
- Cross-session statistics (`GET /api/stats/overview`, `GET /api/stats/messages`)
- Application settings (`GET` / `PUT /api/settings`)
- Session creation (`POST /api/sessions`)
- The queue dashboard (`/api/admin/queues`)

Redriving a dead-lettered integration delivery also fails closed (`404`) when
the instance sits outside the key's scope, so retained dead-letter rows cannot
be re-dispatched across the boundary. Per-session routes for the sessions the
key allows remain available, and keys without an `allowedSessions` restriction
are unaffected.

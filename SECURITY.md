# Security Policy

OpenWA is a self-hosted WhatsApp API gateway. It handles API-key authentication,
WhatsApp session credentials, message data, and — optionally — access to the Docker
socket. Security matters here, and we appreciate responsible disclosure.

## Supported versions

Security fixes land on the latest minor release. Please upgrade older deployments.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

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
least-privilege Docker socket-proxy with a non-root container, and path-containment
checks on storage import/export.

When exposing OpenWA, please review the security-relevant configuration documented in
the README and `docs/` — in particular `CORS_ORIGINS`, `ALLOW_DEV_API_KEY`,
`ENABLE_SWAGGER`, `WEBHOOK_SSRF_PROTECT`, `BODY_SIZE_LIMIT`, and the Docker proxy setup.
Never expose the dashboard/API to the public internet with the development API key
enabled.

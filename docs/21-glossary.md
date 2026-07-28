# 21 - Glossary

## A

### ACK (Acknowledgement)
Delivery acknowledgment status. WhatsApp ACK levels:
- `error` (-1): Failed to send
- `pending` (0): Pending
- `server` (1): Sent to WhatsApp server
- `device` (2): Delivered to recipient device
- `read` (3): Read by recipient
- `played` (4): Media played (audio/video)

### Adapter
An interface implementation that provides a specific capability. In OpenWA, adapters are used for:
- **Database Adapter**: SQLite, PostgreSQL
- **Storage Adapter**: Local, S3
- **Cache Adapter**: Memory, Redis
- **Engine Adapter**: whatsapp-web.js (default), Baileys

### API Key
Authentication token to access the OpenWA API. Sent via the `X-API-Key` header.

### Auth State
WhatsApp Web session authentication data. On the whatsapp-web.js engine it is a Chrome profile (cookies, local/session storage) under `SESSION_DATA_PATH` — default `./data/sessions`, one `session-<name>` directory per session. On Baileys it is a set of credential JSON files under `BAILEYS_AUTH_DIR`, default `./data/baileys`. Losing it unlinks the WhatsApp account and requires a fresh QR scan.

## B

### Baileys
Node.js library for WhatsApp Web that uses WebSocket directly without a browser (no Chromium required). Available as a selectable engine in OpenWA via `ENGINE_TYPE=baileys`.

### Broadcast
Sending the same message to multiple recipients. On WhatsApp, this differs from the native "Broadcast List" feature.

### Bull
A Redis-based Node.js job queue library. Used for:
- Message queue (delayed sends)
- Webhook delivery queue (retry mechanism)
- Background tasks

## C

### Chat ID
Unique identifier for a WhatsApp chat:
- Individual: `628123456789@c.us`
- Group: `120363123456789@g.us`
- Status: `status@broadcast`

### Chrome/Chromium
Browser used by Puppeteer to run WhatsApp Web. OpenWA uses headless Chromium.

### Compose
Docker Compose - a tool to define and run multi-container Docker applications.

## D

### Dashboard
Web interface to manage OpenWA without using the API directly. Built with React + shadcn/ui.

### Dead Letter Queue (DLQ)
Queue that stores messages that failed after all retry attempts. Used for debugging and manual retry.

### Docker
Containerization platform for packaging and deploying applications. OpenWA is distributed as a Docker image.

## E

### Engine
Component that handles communication with WhatsApp Web. OpenWA supports pluggable engines selected via the `ENGINE_TYPE` environment variable: `whatsapp-web.js` (default, Chromium/Puppeteer-based) or `baileys` (browser-free, WebSocket-based).

### Event
A system-emitted occurrence, for example:
- `message.received`: New incoming message
- `message.ack`: Message status changed
- `session.status`: Session status changed
- `session.qr`: New QR code generated

## F

### Factory Pattern
Design pattern used to create adapter instances based on configuration. Example: `DatabaseAdapterFactory.create()`.

## G

### Group ID
Unique identifier for a WhatsApp group. Format: `120363123456789@g.us`.

### GHCR
GitHub Container Registry - registry for storing Docker images. The OpenWA image is available at `ghcr.io/rmyndharis/openwa` (and, mirrored per release, at `docker.io/rmyndharis/openwa`).

## H

### Headless
Browser mode that runs without a GUI. Puppeteer runs Chrome in headless mode.

### Health Check
Endpoint to check system health. `/health` is public for basic status, `/health/detailed` requires an API key for full status.

### Hook
An extension point that allows plugins to intercept and modify processing flows.

## I

### In-Memory
Data stored in RAM. Fast but non-persistent. Used for cache in minimal deployments.

## J

### JID (Jabber ID)
WhatsApp's id format, inherited from XMPP; the user-facing "Chat ID" is a JID. The same entity can be addressed in more than one dialect: `<phone>@c.us` (whatsapp-web.js, and OpenWA's neutral form), `<phone>@s.whatsapp.net` (Baileys' raw form for the same user), `<id>@g.us` (a group), or `<lid>@lid` (a LID, a privacy id). OpenWA normalizes engine ids to a single neutral dialect at the engine boundary - see *System Architecture > WhatsApp Identity Contract*.

### Job Queue
Queueing system for asynchronous task processing. Used for webhook delivery and message scheduling.

## L

### LID (Linked ID)
A WhatsApp **privacy identifier** (`<number>@lid`) that addresses a user without exposing their phone number - increasingly used in groups and communities. Its number is **not** a phone number; a separate `lid -> phone` mapping (supplied by WhatsApp via history sync / contacts) resolves it when known. OpenWA keeps an unresolved LID as-is rather than guessing a phone. See *System Architecture > WhatsApp Identity Contract*.

### Linked Device
WhatsApp feature that allows up to 4 additional devices to be linked to one account without requiring an active phone connection.

### Lucide
Icon library used in the dashboard. A fork of Feather Icons with more icons.

## M

### Message Queue
Queue for asynchronous message delivery. Prevents rate limiting and ensures message ordering.

### Middleware
Function executed before a request handler in NestJS. Used for logging, authentication, etc.

### MinIO
Object storage server compatible with the S3 API. Can be used as a self-hosted alternative to S3.

### Multi-session
Ability to run multiple WhatsApp sessions within a single OpenWA instance.

## N

### NestJS
Node.js framework for building server-side applications. The OpenWA backend is built with NestJS.

### Node.js
JavaScript runtime used to run OpenWA. Recommended version: Node.js 22 LTS.

## O

### ORM (Object-Relational Mapping)
Library that maps objects in code to database tables. OpenWA uses TypeORM.

### OpenWA
Open-source WhatsApp API gateway. This project.

## P

### Payload
Data sent in an HTTP request body or webhook delivery.

### Plugin
Extension that can be added to OpenWA to add functionality without modifying the core codebase.

### PostgreSQL
Relational database recommended for production deployments with multiple sessions.

### Puppeteer
Node.js library for controlling Chrome/Chromium. Used by whatsapp-web.js.

### Push Name
Display name shown in a user's WhatsApp profile.

## Q

### QR Code
Code that must be scanned in WhatsApp on a phone to connect a new session.

### Queue
Queue for processing tasks sequentially and asynchronously.

## R

### Rate Limiting
Limiting request volume over time to prevent abuse and WhatsApp bans.

### Redis
In-memory data store used for:
- Caching
- Message queue (with Bull)
- Session storage
- Real-time pub/sub

### REST API
Architectural style for APIs used by OpenWA. Uses HTTP methods (GET, POST, PUT, DELETE).

### Retry
Mechanism to retry failed operations, e.g., webhook delivery.

## S

### S3 (Simple Storage Service)
AWS object storage service. OpenWA supports S3-compatible storage for media files.

### Session
An instance of a WhatsApp Web connection. One phone number = one session.

### SQLite
Embedded database used as the default for minimal deployments.

### shadcn/ui
Component library for React used in the dashboard. Built on top of Radix UI.

### Strategy Pattern
Design pattern that allows selecting an algorithm/implementation at runtime. Used for pluggable adapters.

### Swagger
API documentation tool. OpenWA provides Swagger UI at `/api/docs`.

## T

### Tailwind CSS
Utility-first CSS framework used in the dashboard.

### TanStack Query
Library for data fetching and caching in React. Previously known as React Query.

### TypeORM
ORM for TypeScript/JavaScript that supports multiple databases.

### TypeScript
Typed superset of JavaScript used for OpenWA development.

## V

### Vite
Build tool and dev server for frontend. Used for the dashboard.

### Volume (Docker)
Persistent storage for Docker containers. OpenWA data is stored in volumes.

## W

### WAHA
WhatsApp HTTP API - a similar project that inspired OpenWA. OpenWA is built as an open-source alternative.

### WAL (Write-Ahead Logging)
SQLite journaling mode that improves concurrency. Recommended for production.

### Webhook
HTTP callback to send events to external systems when messages or other events occur.

### WebSocket
Protocol for real-time bidirectional communication. Used for:
- Dashboard real-time updates
- WhatsApp Web protocol (internal)

### whatsapp-web.js
Default engine library used by OpenWA to interact with WhatsApp Web. Uses Puppeteer to control a headless Chromium browser. Selected via `ENGINE_TYPE=whatsapp-web.js` (or by omitting the env var).

## Z

### Zustand
State management library for React used in the dashboard.

---

## Abbreviations

| Abbr | Full Form |
|------|-----------|
| API | Application Programming Interface |
| CRUD | Create, Read, Update, Delete |
| DI | Dependency Injection |
| DLQ | Dead Letter Queue |
| DTO | Data Transfer Object |
| GHCR | GitHub Container Registry |
| HA | High Availability |
| HTTP | HyperText Transfer Protocol |
| JID | Jabber ID |
| JWT | JSON Web Token |
| LTS | Long Term Support |
| MVP | Minimum Viable Product |
| ORM | Object-Relational Mapping |
| QR | Quick Response |
| RAM | Random Access Memory |
| REST | Representational State Transfer |
| S3 | Simple Storage Service |
| SDK | Software Development Kit |
| SOP | Standard Operating Procedure |
| SQL | Structured Query Language |
| SSL | Secure Sockets Layer |
| TLS | Transport Layer Security |
| TTL | Time To Live |
| UI | User Interface |
| URL | Uniform Resource Locator |
| WAL | Write-Ahead Logging |
| WS | WebSocket |
---

<div align="center">

[← 20 - Community Guidelines](./20-community-guidelines.md) · [Documentation Index](./README.md)

</div>

# 06 - API Specification

## 6.1 API Overview

### Base URL

Every REST route is mounted under the global `api` prefix:

```
http://<host>:2785/api
```

For local development that is `http://localhost:2785/api`; behind a reverse proxy substitute your public origin (the `/api` prefix is unchanged).

### Authentication

A global API-key guard protects every route unless it is explicitly marked **public** (`@Public()`). Send the key in the `X-API-Key` header:

```http
X-API-Key: owa_k1_your-api-key-here
```

> **REST auth is header-only.** A query-parameter API key is **not** accepted on REST routes. The only place an `?apiKey=` query value is honoured is the WebSocket (Socket.IO) handshake — see §6.5 Real-time API — which accepts the key via the handshake `auth.apiKey` field, the `X-API-Key` header, or an `?apiKey=` query string. Do not put the key in a REST URL.

The metrics endpoint is the lone exception to the API-key scheme: it authenticates with `Authorization: Bearer <METRICS_TOKEN>` instead of `X-API-Key`.

### Common Headers

```http
X-API-Key: owa_k1_your-api-key      # required on every non-public REST route
Content-Type: application/json       # required on requests with a JSON body
```

`Content-Type: application/json` is only needed when sending a body. There is no required `Accept` or `X-Request-ID` header.

### Roles & Authorization

API keys carry one of three roles, ordered by privilege:

| Role | Rank | Can do |
| --- | --- | --- |
| `viewer` | 1 | Read-only routes (no `@RequireRole`, or routes that only need a valid key) |
| `operator` | 2 | Everything a viewer can, plus write/action routes guarded by `@RequireRole(OPERATOR)` (send messages, group/contact mutations, etc.) |
| `admin` | 3 | Everything, plus admin-only routes guarded by `@RequireRole(ADMIN)` (API-key management, settings) |

`@RequireRole(role)` enforces a **minimum** role using the hierarchy `VIEWER < OPERATOR < ADMIN`: a key satisfies the guard if its own rank is ≥ the required rank (so an `admin` key passes an `OPERATOR`-guarded route). A route with no `@RequireRole` accepts any valid key, including `viewer`. A key whose role is below the requirement gets `403 Forbidden`; a missing or invalid key gets `401 Unauthorized`.

A key may additionally be scoped to specific sessions (`allowedSessions`) and/or source IPs (`allowedIps`). The scope/IP check runs in the guard **before** any role check, so a request outside that scope is rejected with `401` (not `403`) even if the role would otherwise allow it.

### API-Key Lifecycle

OpenWA seeds an initial admin key on first run (printed to the startup log and written to `data/.api-key`, or `/app/data/.api-key` in Docker). Use it to mint scoped, lower-privilege keys for integrations. Full key creation, listing, rotation, and revocation are documented under the auth resource in **§6.4.9 (API Keys)**.

## 6.2 Response Format

> **OpenWA returns the raw handler payload directly — there is NO `{ success, data, meta }` envelope.** A resource route returns the resource object as-is; a list route returns a **bare JSON array**. Read fields directly (`response.id`, not `response.data.id`).

### Success Response

A successful request returns the resource (or array) exactly as the handler produced it:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "my-session",
  "status": "ready"
}
```

List endpoints return a bare array (some paginated list routes instead return a small wrapper such as `{ "messages": [...], "total": 42 }` — the per-endpoint docs state the exact shape):

```json
[
  { "id": "…", "name": "session-a" },
  { "id": "…", "name": "session-b" }
]
```

Session `status` wire values are **lowercase**: `created | initializing | qr_ready | authenticating | ready | disconnected | failed`.

### Error Response

Errors use the NestJS default shape. The HTTP status is on the status line and mirrored in `statusCode`; there is no application-specific `code` field:

```json
{
  "statusCode": 404,
  "message": "Session 'my-session' not found",
  "error": "Not Found"
}
```

Validation failures (`statusCode: 400`) return `message` as an **array** of field-level strings. A global `ValidationPipe` runs with `whitelist` + `forbidNonWhitelisted`, so any request-body field not declared on the DTO is rejected with `400`.

### General Error Codes

| HTTP Status | Meaning | When |
| --- | --- | --- |
| `400` | Bad Request | DTO validation failed, unknown body field, or a business precondition not met (e.g. session not active, media over cap) |
| `401` | Unauthorized | Missing/invalid/expired/revoked `X-API-Key` (or `METRICS_TOKEN` for metrics), a blocked source IP, or a key used outside its `allowedSessions` scope |
| `403` | Forbidden | A valid, in-scope key whose **role** is below the route's `@RequireRole` requirement |
| `404` | Not Found | The addressed resource (session, message, webhook, batch, …) does not exist |
| `409` | Conflict | A uniqueness constraint was violated (e.g. duplicate name) |
| `413` | Payload Too Large | Base64 media exceeds the media byte cap (see §6.3) |
| `500` | Internal Server Error | Send failed at the WhatsApp engine or an unexpected server error |

### Timestamp Conventions

OpenWA uses **two** timestamp representations — be careful which a field is:

- **Message timestamps are epoch numbers (Unix seconds), not ISO strings.** This applies to the `timestamp` field on messages returned by send responses, history, and persisted message records (the persisted column is stored as a bigint and surfaced as a `number`).
- **Entity audit fields use ISO-8601 UTC strings** (example: `2026-02-02T10:00:00.000Z`). This applies to `createdAt` / `updatedAt` on persisted entities, `expiresAt`, batch `startedAt` / `completedAt`, and similar metadata fields.

## 6.3 Media Specifications

### Media DTO (flat shape)

All media send routes (`send-image`, `send-video`, `send-audio`, `send-document`, `send-sticker`) share one **flat** request DTO — `SendMediaMessageDto`. There is **no** nested `{ image: { url } }` wrapper; the media source fields sit at the top level of the body:

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `chatId` | string | yes | non-empty | Recipient — `<phone>@c.us` or `<groupId>@g.us` |
| `url` | string | conditional | valid http/https URL; required when `base64` absent | Remote media URL. Fetched server-side through an SSRF guard; a blocked/internal URL yields `400` |
| `base64` | string | conditional | required when `url` absent | Raw base64 media data. Decoded size is checked against the media cap |
| `mimetype` | string | conditional | required when `base64` is used | MIME type, e.g. `image/jpeg`, `video/mp4`, `application/pdf` |
| `filename` | string | no | max 255 chars | Optional file name (also used as the persisted body fallback for documents) |
| `caption` | string | no | max 1024 chars | Optional caption (not persisted for audio) |
| `mentions` | string[] | no | array of WIDs | WIDs to @mention in the caption (e.g. `["62811@c.us"]`). See **Mentions** below |

Provide **exactly one** of `url` or `base64`. Omitting both, or supplying `base64` without `mimetype`, returns `400`.

```json
{
  "chatId": "6281234567890@c.us",
  "url": "https://example.com/image.jpg",
  "caption": "Check out this image!"
}
```

```json
{
  "chatId": "6281234567890@c.us",
  "base64": "/9j/4AAQSkZJRg...",
  "mimetype": "image/jpeg",
  "filename": "photo.jpg"
}
```

### Size Limit

There is a **single shared media byte cap**, not a per-type table. A base64 (or downloaded) media blob whose **decoded** size exceeds the cap is rejected with `413 Payload Too Large`. The cap is `MEDIA_DOWNLOAD_MAX_BYTES`, default **50 MiB (52,428,800 bytes)**; the same value bounds outbound base64 sends, remote-URL downloads, and inbound media. A non-positive or garbage override falls back to the default.

### Text Limit

`send-text` enforces a maximum body length of **4096 characters** (`text` is `@MaxLength(4096)`). Media captions are limited to **1024 characters**.

### Mentions

`send-text` and the media send routes accept an optional `mentions` array of WIDs (`<phone>@c.us`) to tag participants — most useful in groups. Two things are required for WhatsApp to render a tag and notify the participant:

1. The `mentions` array lists the WID(s), e.g. `["62811@c.us"]`.
2. The `text`/`caption` contains the matching `@<number>` token, e.g. `Hello @62811`.

The contract is engine-neutral: pass neutral `@c.us` WIDs and the active engine (whatsapp-web.js or Baileys) de-normalizes them internally. Whether a mention surfaces a notification is ultimately client-side — outside a shared group some clients may not render it.

## 6.4 REST API Reference

Every path below is prefixed with `/api`. Unless marked **public**, send `X-API-Key: <key>`; `OPERATOR`/`ADMIN` annotations require a key of at least that role. Responses are the raw payload (no envelope); list endpoints return a bare array.

### 6.4.1 Sessions

Base path `/api/sessions`. Read routes return data shaped by `SessionResponseDto.fromEntity` (via `transformSession`), which **strips** `config`, `proxyUrl`, and `proxyType` and renames the entity field `lastActiveAt` to `lastActive`. The one exception is `POST /api/sessions`, which returns the **raw `Session` entity** and therefore *does* expose `config`/`proxyUrl`/`proxyType`/`lastActiveAt`. Session `status` wire values are lowercase: `created | initializing | qr_ready | authenticating | ready | disconnected | failed`.

#### GET /api/sessions

List all sessions, scoped to the API key's `allowedSessions`, ordered `createdAt` DESC.

**Auth:** API key  ·  **Scope:** session-scoped (a scoped key sees only its `allowedSessions`; an ADMIN / null-allowlist key lists all)

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer (1-1000) | No | `1000` | Max sessions to return; oversized/non-finite values are clamped/fallback to the default window. |
| `offset` | integer | No | `0` | Sessions to skip for paging; negative/non-finite values resolve to `0`. |

**Response** `200`

```json
[
  {
    "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
    "name": "my-bot",
    "status": "ready",
    "phone": "6281234567890",
    "pushName": "My Bot",
    "connectedAt": "2026-06-25T08:14:02.000Z",
    "lastActive": "2026-06-25T09:01:55.000Z",
    "createdAt": "2026-06-20T11:30:00.000Z",
    "updatedAt": "2026-06-25T09:01:55.000Z",
    "lastError": null
  }
]
```

`lastError` is non-null only when `status` is `failed`. `config`/`proxyUrl`/`proxyType` are not present (stripped by `fromEntity`).

**Errors:** `401` missing/invalid `X-API-Key`

#### GET /api/sessions/:id

Get a single session by ID.

**Auth:** API key  ·  **Scope:** session-scoped (key's `allowedSessions` enforced against `:id`)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | WhatsApp session UUID |

**Response** `200`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "ready",
  "phone": "6281234567890",
  "pushName": "My Bot",
  "connectedAt": "2026-06-25T08:14:02.000Z",
  "lastActive": "2026-06-25T09:01:55.000Z",
  "createdAt": "2026-06-20T11:30:00.000Z",
  "updatedAt": "2026-06-25T09:01:55.000Z",
  "lastError": null
}
```

**Errors:** `401` missing/invalid key, or key not scoped to this session · `404` session not found

#### GET /api/sessions/:id/qr

Get the QR code (PNG data URL) for session authentication.

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Response** `200` — `QRCodeResponseDto`

```json
{
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "status": "qr_ready"
}
```

`status` is the session's current lowercase status.

**Errors:** `400` session not started / QR not ready yet / already authenticated · `401` · `403` · `404` not found

#### GET /api/sessions/:id/groups

Get all groups the session is a member of (paginated).

**Auth:** API key  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer (1–1000) | No | `1000` | Max groups to return |
| `offset` | integer | No | `0` | Number of groups to skip for paging |

**Response** `200`

```json
[
  { "id": "1234567890-123@g.us", "name": "Project Team", "linkedParentJID": null }
]
```

Bare array mapped from the engine's group list then paginated. `linkedParentJID` is present for community-linked groups.

**Errors:** `400` session not started (engine not in memory) · `401` · `403` · `404` session not found

#### GET /api/sessions/:id/chats

Get active chats for a session, most-recent first (paginated).

**Auth:** API key  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer (1–1000) | No | `1000` | Max chats to return |
| `offset` | integer | No | `0` | Chats to skip for paging |

**Response** `200` — `ChatSummary[]`

```json
[
  {
    "id": "6281234567890@c.us",
    "name": "Alice",
    "isGroup": false,
    "unreadCount": 2,
    "timestamp": 1719306115,
    "lastMessage": "See you tomorrow"
  }
]
```

Sorted by `timestamp` DESC (most recent first) then paginated. `timestamp` is an epoch number (seconds).

**Errors:** `400` session not started · `401` · `403` · `404` session not found

#### GET /api/sessions/stats/overview

Get session statistics for multi-session monitoring.

**Auth:** API key  ·  **Scope:** session-scoped (aggregate counts limited to the key's `allowedSessions`)

**Response** `200`

```json
{
  "total": 4,
  "active": 2,
  "ready": 2,
  "disconnected": 1,
  "byStatus": { "ready": 2, "disconnected": 1, "created": 1 },
  "memoryUsage": { "heapUsed": 142, "heapTotal": 210, "rss": 318 }
}
```

`byStatus` is keyed by lowercase status values. `memoryUsage` values are megabytes (`Math.round(bytes / 1024 / 1024)`). `active` = count of running engines. A scoped key sees only its `allowedSessions` stats.

**Errors:** `401` missing/invalid `X-API-Key`

#### POST /api/sessions

Create a new WhatsApp session.

**Auth:** API key (OPERATOR)

**Request body** — `CreateSessionDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `name` | string | Yes | `@IsString`; length 3–50; `@Matches(/^[a-zA-Z0-9-]+$/)` (letters, numbers, hyphens only) | Unique session name; duplicate → `409` |
| `config` | object | No | `@IsOptional` (arbitrary object, no shape validation) | Opaque engine config; defaults to `{}`; never returned by read routes |
| `proxyUrl` | string | No | `@IsOptional`; `@IsString`; max 255; `@IsUrl` (protocols `http`/`https`/`socks4`/`socks5`, `require_protocol`, `require_tld:false`, `allow_underscores`) | Per-session proxy egress; credentialed `http://user:pass@host` and single-label hosts allowed; not SSRF-blocked |
| `proxyType` | `http` \| `https` \| `socks4` \| `socks5` | No | `@IsOptional`; `@IsIn([...])` | Proxy protocol |

```json
{
  "name": "my-bot",
  "config": { "autoReconnect": true },
  "proxyUrl": "http://proxy.example.com:8080",
  "proxyType": "http"
}
```

Minimal: `{ "name": "my-bot" }`.

**Response** `201`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "created",
  "phone": null,
  "pushName": null,
  "config": { "autoReconnect": true },
  "proxyUrl": "http://proxy.example.com:8080",
  "proxyType": "http",
  "connectedAt": null,
  "lastActiveAt": null,
  "createdAt": "2026-06-25T09:00:00.000Z",
  "updatedAt": "2026-06-25T09:00:00.000Z"
}
```

This route returns the **raw `Session` entity** (not via `fromEntity`), so `config`/`proxyUrl`/`proxyType`/`lastActiveAt` are present here only. Newly created `status` is `created`.

**Errors:** `400` validation (bad `name`/`proxyUrl`/`proxyType`, or an extra non-whitelisted field) · `401` · `403` key lacks OPERATOR role · `409` session name already exists

#### POST /api/sessions/:id/start

Start a session and initialize the WhatsApp connection.

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

No request body.

**Response** `201`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "initializing",
  "phone": null,
  "pushName": null,
  "connectedAt": null,
  "lastActive": null,
  "createdAt": "2026-06-20T11:30:00.000Z",
  "updatedAt": "2026-06-25T09:05:00.000Z",
  "lastError": null
}
```

Returned via `transformSession`. Status typically transitions to `initializing` / `qr_ready`. Note: Swagger declares `200`, but with no `@HttpCode` override the runtime status is **`201`** (NestJS POST default).

**Errors:** `400` session already started / already starting · `401` · `403` · `404` not found

#### POST /api/sessions/:id/stop

Stop a session and disconnect WhatsApp.

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

No request body.

**Response** `201`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "disconnected",
  "phone": "6281234567890",
  "pushName": "My Bot",
  "connectedAt": null,
  "lastActive": "2026-06-25T09:01:55.000Z",
  "createdAt": "2026-06-20T11:30:00.000Z",
  "updatedAt": "2026-06-25T09:10:00.000Z",
  "lastError": null
}
```

Returned via `transformSession`; status typically becomes `disconnected`. Swagger declares `200`; runtime status is **`201`**.

**Errors:** `401` · `403` · `404` not found

#### POST /api/sessions/:id/force-kill

Force-kill a stuck session (SIGKILL the wedged engine, then tear it down).

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

No request body.

**Response** `201`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "disconnected",
  "phone": "6281234567890",
  "pushName": "My Bot",
  "connectedAt": null,
  "lastActive": "2026-06-25T09:01:55.000Z",
  "createdAt": "2026-06-20T11:30:00.000Z",
  "updatedAt": "2026-06-25T09:12:00.000Z",
  "lastError": null
}
```

Returned via `transformSession`. Swagger declares `200`; runtime status is **`201`**.

**Errors:** `401` · `403` · `404` not found

#### POST /api/sessions/:id/pairing-code

Request an 8-char pairing code to link via phone number (alternative to QR).

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Request body** — `RequestPairingCodeDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `phoneNumber` | string | Yes | `@IsString`; `@IsNotEmpty`; `@Matches(/^[0-9]{6,15}$/)` (digits only, 6–15, no `+`/spaces/dashes) | International format: country code + number, e.g. `628123456789` |

```json
{ "phoneNumber": "628123456789" }
```

**Response** `201` — `PairingCodeResponseDto`

```json
{ "pairingCode": "ABCD1234", "status": "qr_ready" }
```

`status` is the lowercase session status.

**Errors:** `400` validation, or session not started, or already authenticated · `401` · `403` · `404` not found

#### POST /api/sessions/:id/chats/read

Mark a chat as read/seen.

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Request body** — `MarkChatReadDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `chatId` | string | Yes | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace) | Engine-native JID, e.g. `1234567890@c.us` (wwebjs) or `1234@s.whatsapp.net` (Baileys) |

```json
{ "chatId": "1234567890@c.us" }
```

**Response** `201`

```json
{ "success": true }
```

Swagger declares `200`; runtime status is **`201`**.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found

#### POST /api/sessions/:id/chats/unread

Mark a chat as unread.

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Request body** — `MarkChatReadDto` (reused)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `chatId` | string | Yes | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` | Engine-native JID, e.g. `1234567890@c.us` |

```json
{ "chatId": "1234567890@c.us" }
```

**Response** `201`

```json
{ "success": true }
```

Swagger declares `200`; runtime status is **`201`**.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found

#### POST /api/sessions/:id/chats/delete

Delete a chat from the chat list (e.g. a group you have left).

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Request body** — `DeleteChatDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `chatId` | string | Yes | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace) | Engine-native JID, e.g. `1234567890-123@g.us` |

```json
{ "chatId": "1234567890-123@g.us" }
```

**Response** `201`

```json
{ "success": true }
```

Swagger declares `200`; runtime status is **`201`**.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found

#### POST /api/sessions/:id/chats/typing

Send a typing/recording presence indicator to a chat (or clear it with `paused`).

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Request body** — `SendChatStateDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `chatId` | string | Yes | `@IsString`; `@IsNotEmpty` (no JID regex; engine-neutral, the adapter validates) | Engine-native chat id, e.g. `1234567890@c.us` |
| `state` | `typing` \| `recording` \| `paused` | Yes | `@IsIn(['typing','recording','paused'])` | `typing`/`recording` show the indicator; `paused` clears it |

```json
{ "chatId": "1234567890@c.us", "state": "typing" }
```

**Response** `201`

```json
{ "success": true }
```

Always returns `{ "success": true }` (the service returns void; the controller hardcodes `true`). Swagger declares `200`; runtime status is **`201`**.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found

#### DELETE /api/sessions/:id

Delete a session.

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Session UUID |

**Response** `204` — empty body (`@HttpCode(204)`, returns void). A `findOne` lookup runs first, so a missing id yields `404`.

**Errors:** `401` missing/invalid key, or key not scoped to this session · `403` key role below OPERATOR · `404` session not found

### 6.4.2 Messages

All routes are mounted under `/api/sessions/:sessionId/messages`. Reads (`GET` history, batch status, reactions) accept any valid API key (including VIEWER). All write/send routes require **API key (OPERATOR)** or higher. Send routes return `MessageResponseDto { messageId, timestamp }` (`timestamp` is an epoch **number** in seconds; there is no `status` field). The global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so any body field not listed below is rejected with `400`.

#### GET /api/sessions/:sessionId/messages

Get persisted message history for a session from the local DB (paginated, filterable). Reads the DB only — does not hit WhatsApp.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| chatId | string | No | — | Filter by chat ID. Matched across `@c.us` / `@s.whatsapp.net` dialects via the lid-mapping table. |
| from | string | No | — | Filter by sender. A phone also matches any lid that resolves to it. |
| limit | integer | No | 50 | Clamped to `[1,100]`; a non-finite value falls back to 50. |
| offset | integer | No | 0 | Clamped to `>=0`; a non-finite value falls back to 0. |

**Response** `200`

```json
{
  "messages": [
    {
      "id": "9f1c2e7a-2b3d-4c5e-8a91-0d1e2f3a4b5c",
      "sessionId": "my-session",
      "waMessageId": "true_628123456789@c.us_3EB0ABCD",
      "chatId": "628123456789@c.us",
      "from": "628123456789@c.us",
      "to": "628987654321@c.us",
      "body": "Hello from OpenWA!",
      "type": "text",
      "direction": "outgoing",
      "timestamp": 1719312000,
      "metadata": null,
      "status": "sent",
      "createdAt": "2026-06-25T09:20:00.000Z"
    }
  ],
  "total": 1
}
```

Each `Message`: `{ id (uuid), sessionId, waMessageId (string|null), chatId, from, to, body (string|null), type, direction ('incoming'|'outgoing'), timestamp (number|null), metadata (object|null), status ('pending'|'sent'|'delivered'|'read'|'failed'), createdAt (ISO date) }`. Ordered by `createdAt` DESC. The response is the raw service object (no envelope).

**Errors:** `401` missing/invalid API key

#### GET /api/sessions/:sessionId/messages/:chatId/history

Fetch chat history live from WhatsApp for a chat, bypassing the local DB.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| chatId | string | Chat ID, e.g. `628123456789@c.us` or `groupId@g.us` |

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| limit | integer | No | 50 | Clamped to `[1,100]`; when `deep=true` the ceiling rises to 2000. Non-finite falls back to 50. |
| includeMedia | boolean | No | false | Truthy only for `true` or `1`. Downloads base64 media (slower). Forced OFF when `deep=true`. |
| deep | boolean | No | false | Truthy only for `true` or `1`. Raises the limit ceiling 100→2000 (whatsapp-web.js only) and forces metadata-only. |

**Response** `200`

Returns a bare array of engine-neutral `IncomingMessage` objects:

```json
[
  {
    "id": "true_628123456789@c.us_3EB0ABCD",
    "from": "628123456789@c.us",
    "to": "628987654321@c.us",
    "chatId": "628123456789@c.us",
    "body": "Hi there",
    "type": "text",
    "timestamp": 1719312000,
    "fromMe": false,
    "isGroup": false,
    "author": "628123456789@c.us",
    "senderPhone": "628123456789"
  }
]
```

Each item may also include `isStatusBroadcast`, `mentionedIds`, `isLidSender`, `contact`, `media { mimetype, filename?, data?, omitted?, sizeBytes? }`, `quotedMessage { id, body }`, `call { video, missed }` (for `call` messages), and `location { latitude, longitude, description?, address?, url? }`. `type` is one of `text|image|video|audio|voice|document|sticker|location|contact|call|revoked|masked|unknown`. A `masked` message is one WhatsApp deliberately withholds from linked/companion devices — e.g. a high-security business OTP — so its `body` is empty by design (the content is only available on the primary phone) rather than a parsing failure; this occurs on the Baileys engine.

**Errors:** `400` session not active · `401` missing/invalid API key · `500` engine error

#### GET /api/sessions/:sessionId/messages/:chatId/:messageId/reactions

Get reactions for a specific message, grouped by emoji with the senders.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| chatId | string | Chat ID containing the message |
| messageId | string | Message ID to get reactions for |

**Response** `200`

Returns a bare array of `MessageReaction`:

```json
[
  {
    "emoji": "👍",
    "senders": [
      { "senderId": "628123456789@c.us", "emoji": "👍", "timestamp": 1719312050 }
    ]
  }
]
```

**Errors:** `400` session not active · `401` missing/invalid API key · `500` engine error

#### GET /api/sessions/:sessionId/messages/batch/:batchId

Get the processing status and progress of a bulk batch.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| batchId | string | Batch ID |

**Response** `200`

```json
{
  "batchId": "batch_a1b2c3d4",
  "status": "processing",
  "progress": { "total": 2, "sent": 1, "failed": 0, "pending": 1, "cancelled": 0 },
  "results": [
    {
      "chatId": "628111111111@c.us",
      "status": "sent",
      "messageId": "true_628111111111@c.us_3EB0ABCD",
      "sentAt": "2026-06-25T09:21:00.000Z"
    },
    { "chatId": "628222222222@c.us", "status": "pending" }
  ],
  "startedAt": "2026-06-25T09:20:55.000Z",
  "completedAt": null
}
```

`status` is one of `pending|processing|completed|cancelled|failed`; per-result `status` is `pending|sent|failed|cancelled`. A failed result carries a sanitized `error { code, message }` (internals are not leaked).

**Errors:** `401` missing/invalid API key · `404` batch not found for this session

#### POST /api/sessions/:sessionId/messages/send-text

Send a plain text message.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendTextMessageDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| chatId | string | Yes | non-empty | `phone@c.us` or `groupId@g.us` |
| text | string | Yes | non-empty, max 4096 | Message text |
| mentions | string[] | No | array of WIDs | WIDs to @mention (e.g. `["62811@c.us"]`). See **Mentions** below |

```json
{ "chatId": "628123456789@c.us", "text": "Hello from OpenWA!" }
```

```json
{ "chatId": "120363000000000000@g.us", "text": "Hello @62811", "mentions": ["62811@c.us"] }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

`messageId` is the WhatsApp message id from the engine. An optional `SIMULATE_TYPING` humanising pause may run before send.

**Errors:** `400` unknown body field, validation failure, or session not active / blocked by a plugin hook · `401` missing/invalid API key · `403` key role below OPERATOR · `404` session not found · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-template

Render a stored text template (header/body/footer joined by blank lines, `{{vars}}` substituted) and send it as text.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendTemplateMessageDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| chatId | string | Yes | non-empty | Target chat |
| templateId | string | Conditional | non-empty; required when `templateName` is absent | Stored template id |
| templateName | string | Conditional | non-empty; required when `templateId` is absent | Stored template name |
| vars | Record\<string,string\> | No | object | Substituted into `{{placeholder}}` tokens; defaults to `{}` |

```json
{
  "chatId": "628123456789@c.us",
  "templateName": "order-confirmation",
  "vars": { "customer": "Alice", "orderId": "1234" }
}
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

Delegates to the send-text path after rendering.

**Errors:** `400` unknown body field, validation failure, or session not active · `401` missing/invalid API key · `403` key role below OPERATOR · `404` session or template not found · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-image

Send an image (by URL or base64) with an optional caption.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendMediaMessageDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| chatId | string | Yes | non-empty | Target chat |
| url | string | Conditional | URL; required when `base64` is absent | http/https media URL (SSRF-guarded; a blocked internal URL maps to `400`) |
| base64 | string | Conditional | string; required when `url` is absent | Base64 media data (capped to the media byte limit) |
| mimetype | string | Conditional | string; required when using `base64` | MIME type of the media |
| filename | string | No | max 255 | File name |
| caption | string | No | max 1024 | Caption text |

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/image.jpg", "caption": "Check out this image!" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` neither `url` nor `base64`, base64 without `mimetype`, base64 over media cap, SSRF-blocked URL, session not active, or unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-video

Send a video (by URL or base64) with an optional caption. Uses the same `SendMediaMessageDto` (and the same validation rules and errors) as `send-image`.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendMediaMessageDto` (fields `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption` — see `send-image`)

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/clip.mp4", "caption": "video" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` media validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-audio

Send an audio message (by URL or base64). Uses `SendAudioMessageDto`. A `caption` is accepted by the DTO but not persisted for audio. Set `ptt: true` to send a real WhatsApp **voice note** (microphone bubble + waveform) instead of a plain audio file. `ptt` is a JSON boolean, exclusive to this endpoint, and — because voice notes require `audio/ogg; codecs=opus` — the server defaults the mimetype to that when you set `ptt` without one; for reliable playback (especially on the Baileys engine, which does not transcode) supply OGG/Opus bytes. A `ptt` voice note is stored as message `type: "voice"`.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendAudioMessageDto` (all `SendMediaMessageDto` fields — `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption` — plus optional `ptt` boolean)

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/voice.ogg", "mimetype": "audio/ogg", "ptt": true }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` media validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-document

Send a document/file (by URL or base64). Uses `SendMediaMessageDto`; `filename` is used as the persisted body fallback.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendMediaMessageDto` (fields `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption` — see `send-image`)

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/report.pdf", "filename": "report.pdf", "mimetype": "application/pdf" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` media validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-location

Send a location pin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendLocationDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| chatId | string | Yes | non-empty | Target chat |
| latitude | number | Yes | valid latitude | Latitude (out-of-range → `400`) |
| longitude | number | Yes | valid longitude | Longitude (out-of-range → `400`) |
| description | string | No | string | Pin description |
| address | string | No | string | Pin address |

```json
{ "chatId": "628123456789@c.us", "latitude": -6.2088, "longitude": 106.8456, "description": "Jakarta", "address": "Central Jakarta" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` invalid coords / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-contact

Send a contact card (vCard).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendContactDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| chatId | string | Yes | non-empty | Target chat |
| contactName | string | Yes | non-empty | Display name for the contact card |
| contactNumber | string | Yes | non-empty | Contact phone number |

```json
{ "chatId": "628123456789@c.us", "contactName": "John Doe", "contactNumber": "628987654321" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-sticker

Send a sticker (by URL or base64; typically webp). Reuses `SendMediaMessageDto`.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendMediaMessageDto` (fields `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption` — see `send-image`)

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/sticker.webp", "mimetype": "image/webp" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` media validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/reply

Reply to a message, quoting a prior message.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `ReplyMessageDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| chatId | string | Yes | non-empty | Target chat |
| quotedMessageId | string | Yes | non-empty | WhatsApp id of the message being quoted |
| text | string | Yes | non-empty | Reply text |

```json
{ "chatId": "628123456789@c.us", "quotedMessageId": "true_628123456789@c.us_3EB0ABCD", "text": "Replying to you" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0EFGH", "timestamp": 1719312100 }
```

The quoted body is best-effort resolved from the DB for the reply preview.

**Errors:** `400` validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/forward

Forward a message from one chat to another.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `ForwardMessageDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| fromChatId | string | Yes | non-empty | Source chat |
| toChatId | string | Yes | non-empty | Destination chat |
| messageId | string | Yes | non-empty | WhatsApp id of the message to forward |

```json
{ "fromChatId": "628111111111@c.us", "toChatId": "628222222222@c.us", "messageId": "true_628111111111@c.us_3EB0XYZ" }
```

**Response** `201`

```json
{ "messageId": "true_628222222222@c.us_3EB0NEW", "timestamp": 1719312200 }
```

`messageId` may be an empty string when the engine could not recover the forwarded copy's id.

**Errors:** `400` validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/react

Add or remove a reaction to a message (an empty emoji removes the reaction).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `ReactMessageDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| chatId | string | Yes | non-empty | Target chat |
| messageId | string | Yes | non-empty | Message to react to |
| emoji | string | Yes | string (may be empty) | Reaction emoji; an empty string removes the reaction. The field must be present. |

```json
{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "emoji": "👍" }
```

**Response** `200`

The controller hardcodes the result after the engine call. Note the `200` status (via `@HttpCode`), not `201`.

```json
{ "success": true }
```

**Errors:** `400` session not active / message not found / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/delete

Delete a message (for everyone by default); also flags the stored record as `revoked`.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `DeleteMessageDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| chatId | string | Yes | non-empty | Target chat |
| messageId | string | Yes | non-empty | Message to delete |
| forEveryone | boolean | No | boolean (default `true`) | Delete for everyone; defaults to `true` in the service |

```json
{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "forEveryone": true }
```

**Response** `200`

After the engine delete, the stored message body is cleared and its `type` set to `revoked`. Note the `200` status (via `@HttpCode`).

```json
{ "success": true }
```

**Errors:** `400` session not active / message not found / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-bulk

Send messages to multiple recipients as an async batch — returns immediately and processes in the background.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `SendBulkMessageDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| batchId | string | No | string | Auto-generated `batch_<hex>` if omitted; a duplicate id returns `400` |
| messages | BulkMessageItemDto[] | Yes | array, max 100, nested-validated | The batch items (see below) |
| options | BulkMessageOptionsDto | No | nested-validated | Pacing/error options (see below) |

Each `BulkMessageItemDto`: `{ chatId: string, type: 'text'|'image'|'video'|'audio'|'document', content: BulkMessageContentDto, variables?: Record<string,string> }`. `content` (all fields optional, nested-validated): `text?: string`, `image?`/`video?`/`audio?`/`document?`: `{ url?, base64?, mimetype?, filename? }`, `caption?: string`.

`BulkMessageOptionsDto`: `{ delayBetweenMessages?: number (1000–60000, default 3000), randomizeDelay?: boolean (default true), stopOnError?: boolean (default false) }`.

```json
{
  "messages": [
    { "chatId": "628111111111@c.us", "type": "text", "content": { "text": "Hi {{name}}" }, "variables": { "name": "Alice" } },
    { "chatId": "628222222222@c.us", "type": "image", "content": { "image": { "url": "https://example.com/promo.jpg" }, "caption": "Promo" } }
  ],
  "options": { "delayBetweenMessages": 3000, "randomizeDelay": true, "stopOnError": false }
}
```

**Response** `202`

`202 Accepted` (via `@HttpCode`). `statusUrl` points at the batch-status route below.

```json
{
  "batchId": "batch_a1b2c3d4",
  "status": "pending",
  "totalMessages": 2,
  "estimatedCompletionTime": "2026-06-25T09:21:00.000Z",
  "statusUrl": "/api/sessions/my-session/messages/batch/batch_a1b2c3d4"
}
```

**Errors:** `400` session not active, duplicate `batchId`, base64 over media cap, or DTO/nested validation failure (unknown nested field rejected) · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/batch/:batchId/cancel

Cancel a running (pending/processing) bulk batch. No request body.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| batchId | string | Batch ID |

**Response** `200`

`200` via `@HttpCode`. On cancel, the remaining pending count is moved to `cancelled`.

```json
{
  "batchId": "batch_a1b2c3d4",
  "status": "cancelled",
  "progress": { "total": 2, "sent": 1, "failed": 0, "pending": 0, "cancelled": 1 }
}
```

**Errors:** `400` batch already completed or cancelled · `401` missing/invalid API key · `403` key role below OPERATOR · `404` batch not found

### 6.4.3 Contacts

Contact endpoints are scoped under a session: `/api/sessions/:sessionId/contacts`. All read routes require a valid API key; the block/unblock writes require an `OPERATOR` key. Every route returns `400 "Session is not started"` when the target session exists but is not in a started/ready state, and `404` when the session itself does not exist. Responses are the raw handler payload (no envelope).

The `Contact` object returned by the list and get-by-id routes has this shape:

```json
{
  "id": "6281234567890@c.us",
  "name": "Jane Doe",
  "pushName": "Jane",
  "number": "6281234567890",
  "isMyContact": true,
  "isBlocked": false,
  "profilePicUrl": "https://pps.whatsapp.net/v/..."
}
```

`name`, `pushName`, and `profilePicUrl` are optional and may be absent.

#### GET /api/sessions/:sessionId/contacts

List all contacts for a session, returned as an in-memory paginated window.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| limit | integer | No | 1000 | Parsed with `parseInt(…,10)`; clamped to `[1, 1000]`. Omitted or non-finite values fall back to 1000. |
| offset | integer | No | 0 | Parsed with `parseInt(…,10)`; non-finite values fall back to 0, then truncated to `>= 0`. |

**Response** `200` — bare `Contact[]` array

```json
[
  {
    "id": "6281234567890@c.us",
    "name": "Jane Doe",
    "pushName": "Jane",
    "number": "6281234567890",
    "isMyContact": true,
    "isBlocked": false,
    "profilePicUrl": "https://pps.whatsapp.net/v/..."
  }
]
```

**Errors:** `400` session is not started · `401` missing/invalid API key, or key not scoped to this session · `404` session not found

#### GET /api/sessions/:sessionId/contacts/check/:number

Check whether a phone number exists on WhatsApp and return its canonical WhatsApp id when it does.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |
| number | string | Phone number to check, e.g. `628123456789` (digits, no `@c.us` suffix). |

**Response** `200`

```json
{
  "number": "628123456789",
  "exists": true,
  "whatsappId": "628123456789@c.us"
}
```

`whatsappId` is the canonical native chat id, or `null` when the number is not on WhatsApp; `exists` is `whatsappId !== null`.

> Route-order caveat: the literal `check/` segment disambiguates this route from `GET /:contactId`. A contact whose id is literally `check` would be shadowed by this handler.

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` session not found

#### GET /api/sessions/:sessionId/contacts/:contactId

Get a single contact by its WhatsApp id.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |
| contactId | string | Contact id / JID, e.g. `6281234567890@c.us` or an `@lid`. |

**Response** `200` — `Contact`

```json
{
  "id": "6281234567890@c.us",
  "name": "Jane Doe",
  "pushName": "Jane",
  "number": "6281234567890",
  "isMyContact": true,
  "isBlocked": false,
  "profilePicUrl": "https://pps.whatsapp.net/v/..."
}
```

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` `Contact <id> not found` (engine returned null), or session not found

#### GET /api/sessions/:sessionId/contacts/:contactId/profile-picture

Get the profile picture URL for a contact (best-effort).

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |
| contactId | string | Contact id / JID, e.g. `6281234567890@c.us`. |

**Response** `200`

```json
{ "url": "https://pps.whatsapp.net/v/..." }
```

`url` is `null` when there is no picture, the contact's privacy hides it, or it cannot be resolved.

> The path segment is `profile-picture` (hyphenated), not `profile-pic`.

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` session not found

#### GET /api/sessions/:sessionId/contacts/:contactId/phone

Resolve a contact id (e.g. an `@lid`) to a phone number (MSISDN digits), best-effort.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |
| contactId | string | Contact id / JID to resolve, e.g. an `@lid`. |

**Response** `200`

```json
{ "contactId": "12345678901234@lid", "phone": "6281234567890" }
```

`phone` is `null` when the engine cannot map the id (e.g. an `@lid` the account has never seen).

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` session not found

#### POST /api/sessions/:sessionId/contacts/:contactId/block

Block a contact.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |
| contactId | string | Contact id / JID, e.g. `6281234567890@c.us`. |

This route takes no request body and binds no DTO. Send an empty body `{}` (the global `whitelist` + `forbidNonWhitelisted` ValidationPipe rejects any unexpected field with `400`).

**Response** `200`

This route is annotated `@HttpCode(200)`, so it returns `200` rather than the POST default `201`.

```json
{ "success": true, "message": "Contact blocked" }
```

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key role below OPERATOR · `404` session not found

#### DELETE /api/sessions/:sessionId/contacts/:contactId/block

Unblock a contact.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |
| contactId | string | Contact id / JID, e.g. `6281234567890@c.us`. |

No request body.

**Response** `200`

No `@HttpCode` override is present, so this DELETE returns the NestJS default `200` (not `204`).

```json
{ "success": true, "message": "Contact unblocked" }
```

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key role below OPERATOR · `404` session not found

### 6.4.4 Groups

All group routes are nested under a session: base path `/api/sessions/:sessionId/groups`. Reads (`GET`) require a plain API key; writes (create/modify/leave/revoke) require an `OPERATOR` role key. All routes resolve the engine for the session first, so a session that is not started yields `400 Session is not started`.

#### GET /api/sessions/:sessionId/groups

List all groups for a session, with pagination.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| limit | string (parsed base-10 to number) | No | 1000 | Max groups to return; clamped to [1, 1000]. Omitted/non-finite → 1000. |
| offset | string (parsed base-10 to number) | No | 0 | Groups to skip. Non-finite → 0; negative truncated to 0. |

**Response** `200`

Raw array (no envelope). The service calls `engine.getGroups()` then paginates to bound the window.

```json
[
  {
    "id": "120363021234567890@g.us",
    "name": "Project Team",
    "participantsCount": 12,
    "isAdmin": true,
    "linkedParentJID": null
  }
]
```

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key`

#### GET /api/sessions/:sessionId/groups/:groupId

Get detailed group info including participants.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID, e.g. `120363021234567890@g.us` |

**Response** `200`

Raw object (no envelope). `engine.getGroupInfo()` returns `GroupInfo | null`; the service throws `404` when it is `null`.

```json
{
  "id": "120363021234567890@g.us",
  "name": "Project Team",
  "description": "Internal coordination group.",
  "owner": "628123456789@c.us",
  "createdAt": 1718900000,
  "isReadOnly": false,
  "isAnnounce": false,
  "linkedParentJID": null,
  "participants": [
    {
      "id": "628123456789@c.us",
      "number": "628123456789",
      "name": "Alice",
      "isAdmin": true,
      "isSuperAdmin": true
    }
  ]
}
```

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `404` `Group <groupId> not found`

#### GET /api/sessions/:sessionId/groups/:groupId/invite-code

Get the group invite code and full invite link.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Response** `200`

`inviteCode` comes from `engine.getGroupInviteCode()`; `inviteLink` is `https://chat.whatsapp.com/<inviteCode>`.

```json
{
  "inviteCode": "AbCdEf123456",
  "inviteLink": "https://chat.whatsapp.com/AbCdEf123456"
}
```

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key`

#### POST /api/sessions/:sessionId/groups

Create a new group with an initial set of participants.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Request body** — `CreateGroupDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| name | string | Yes | `@IsString`, `@IsNotEmpty` | Group subject/name |
| participants | string[] | Yes | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs, e.g. `628123456789@c.us` |

```json
{
  "name": "Project Team",
  "participants": ["628123456789@c.us", "628987654321@c.us"]
}
```

**Response** `201`

Returns the created `Group` directly (raw).

```json
{
  "id": "120363021234567890@g.us",
  "name": "Project Team",
  "participantsCount": 3,
  "isAdmin": true,
  "linkedParentJID": null
}
```

**Errors:** `400` validation (missing/empty `name` or `participants`, or any non-DTO field) / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### POST /api/sessions/:sessionId/groups/:groupId/participants

Add participants to a group.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Request body** — `ParticipantsDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| participants | string[] | Yes | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200`

Status is forced to `200` via `@HttpCode(HttpStatus.OK)` (overriding the POST default). The body is a fixed acknowledgement after the void engine call.

```json
{ "success": true, "message": "Participants added" }
```

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### DELETE /api/sessions/:sessionId/groups/:groupId/participants

Remove participants from a group. Note: this DELETE carries a JSON request body.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Request body** — `ParticipantsDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| participants | string[] | Yes | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200`

No `@HttpCode`, so NestJS uses the DELETE default of `200`.

```json
{ "success": true, "message": "Participants removed" }
```

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### POST /api/sessions/:sessionId/groups/:groupId/participants/promote

Promote participants to group admin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Request body** — `ParticipantsDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| participants | string[] | Yes | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200` (forced via `@HttpCode(HttpStatus.OK)`)

```json
{ "success": true, "message": "Participants promoted to admin" }
```

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### POST /api/sessions/:sessionId/groups/:groupId/participants/demote

Demote participants from group admin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Request body** — `ParticipantsDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| participants | string[] | Yes | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200` (forced via `@HttpCode(HttpStatus.OK)`)

```json
{ "success": true, "message": "Participants demoted from admin" }
```

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### PUT /api/sessions/:sessionId/groups/:groupId/subject

Change the group name/subject.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Request body** — `GroupSubjectDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| subject | string | Yes | `@IsString`, `@IsNotEmpty` | New group subject/name |

```json
{ "subject": "New Team Name" }
```

**Response** `200`

No `@HttpCode`; PUT default is `200`.

```json
{ "success": true, "message": "Group subject updated" }
```

**Errors:** `400` validation (empty `subject`) / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### PUT /api/sessions/:sessionId/groups/:groupId/description

Change the group description. An empty string clears the description.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Request body** — `GroupDescriptionDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| description | string | Yes | `@IsString` (no `@IsNotEmpty`) | Must be present and a string, but `""` is valid and clears the description |

```json
{ "description": "Internal coordination group." }
```

**Response** `200`

No `@HttpCode`; PUT default is `200`.

```json
{ "success": true, "message": "Group description updated" }
```

**Errors:** `400` validation (`description` missing / not a string) / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### POST /api/sessions/:sessionId/groups/:groupId/leave

Leave a group.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Request body** — none (send an empty body).

**Response** `200` (forced via `@HttpCode(HttpStatus.OK)`)

```json
{ "success": true, "message": "Left the group" }
```

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### POST /api/sessions/:sessionId/groups/:groupId/invite-code/revoke

Revoke the current invite code and generate a new one.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| groupId | string | Group ID |

**Request body** — none (send an empty body).

**Response** `200` (forced via `@HttpCode(HttpStatus.OK)`)

`inviteCode` is the **new** code from `engine.revokeGroupInviteCode()`; `inviteLink` is `https://chat.whatsapp.com/<newCode>`.

```json
{
  "inviteCode": "XyZ987654321",
  "inviteLink": "https://chat.whatsapp.com/XyZ987654321",
  "message": "Invite code revoked and new one generated"
}
```

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

### 6.4.5 Message Templates

Reusable message templates scoped to a session, with `{{variable}}` placeholders rendered at send time. All routes are nested under `/api/sessions/:sessionId/templates` and require an **OPERATOR** key. The `sessionId` is stored on the template but is **not** validated against an existing session in these handlers.

#### GET /api/sessions/:sessionId/templates

List all templates for a session, newest first.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID; filters templates by `sessionId`. |

**Response** `200`

Bare `Template[]` array (no pagination, no envelope). Ordered by `createdAt` DESC. Returns an empty array — not `404` — when the session has no templates.

```json
[
  {
    "id": "f1c2a3b4-5d6e-7f80-9a1b-2c3d4e5f6071",
    "sessionId": "9b1c0e2a-3d4f-5a6b-7c8d-9e0f1a2b3c4d",
    "name": "order-confirmation",
    "body": "Hi {{customer}}, your order {{orderId}} has shipped.",
    "header": "OpenWA Store",
    "footer": "Reply STOP to unsubscribe.",
    "createdAt": "2026-06-25T10:15:00.000Z",
    "updatedAt": "2026-06-25T10:15:00.000Z"
  }
]
```

**Errors:** `401` missing/invalid `X-API-Key` · `403` key below OPERATOR role

#### GET /api/sessions/:sessionId/templates/:id

Get a single template by ID within the session.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID; combined with `id` in the lookup. |
| id | string | Template UUID. |

**Response** `200`

Raw `Template` entity (no envelope).

```json
{
  "id": "f1c2a3b4-5d6e-7f80-9a1b-2c3d4e5f6071",
  "sessionId": "9b1c0e2a-3d4f-5a6b-7c8d-9e0f1a2b3c4d",
  "name": "order-confirmation",
  "body": "Hi {{customer}}, your order {{orderId}} has shipped.",
  "header": "OpenWA Store",
  "footer": "Reply STOP to unsubscribe.",
  "createdAt": "2026-06-25T10:15:00.000Z",
  "updatedAt": "2026-06-25T10:15:00.000Z"
}
```

**Errors:** `401` missing/invalid `X-API-Key` · `403` key below OPERATOR role · `404` no row matches the `id`+`sessionId` pair (`{ "statusCode": 404, "message": "Template with id '<id>' not found", "error": "Not Found" }`)

#### POST /api/sessions/:sessionId/templates

Create a message template for the session (with `{{variable}}` placeholders in the body).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID; stored as `template.sessionId`. Not validated against an existing session in this handler. |

**Request body** — `CreateTemplateDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| name | string | yes | non-empty, max 100 chars | Unique template name within the session (DB unique index on `[sessionId, name]`). Duplicate → `409`. |
| body | string | yes | non-empty, max 4096 chars | Template body containing `{{variable}}` placeholders rendered at send time. |
| header | string | no | max 1024 chars | Optional header text; coerced to `null` when omitted. Prepended to rendered body. |
| footer | string | no | max 1024 chars | Optional footer text; coerced to `null` when omitted. Appended to rendered body. |

```json
{
  "name": "order-confirmation",
  "body": "Hi {{customer}}, your order {{orderId}} has shipped.",
  "header": "OpenWA Store",
  "footer": "Reply STOP to unsubscribe."
}
```

**Response** `201`

Returns the saved `Template` entity raw (no envelope). The lazy `session` relation is not loaded on a freshly saved entity, so it is absent from the JSON.

```json
{
  "id": "f1c2a3b4-5d6e-7f80-9a1b-2c3d4e5f6071",
  "sessionId": "9b1c0e2a-3d4f-5a6b-7c8d-9e0f1a2b3c4d",
  "name": "order-confirmation",
  "body": "Hi {{customer}}, your order {{orderId}} has shipped.",
  "header": "OpenWA Store",
  "footer": "Reply STOP to unsubscribe.",
  "createdAt": "2026-06-25T10:15:00.000Z",
  "updatedAt": "2026-06-25T10:15:00.000Z"
}
```

**Errors:** `400` validation failure (missing/empty `name`/`body`, over-length, or any extra field rejected by `forbidNonWhitelisted`) · `401` missing/invalid `X-API-Key` · `403` key below OPERATOR role · `409` duplicate `name` for the session

#### PUT /api/sessions/:sessionId/templates/:id

Update a template's name/body/header/footer (partial; only provided fields change).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |
| id | string | Template UUID to update. |

**Request body** — `UpdateTemplateDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| name | string | no | if present: non-empty, max 100 chars | Applied only when not `undefined`. Duplicate name → `409`. |
| body | string | no | if present: non-empty, max 4096 chars | Applied only when not `undefined`. |
| header | string | no | max 1024 chars | Applied only when not `undefined`. The update path does **not** coerce to `null`, so passing explicit `null` fails `@IsString`; omit the key to leave it unchanged. |
| footer | string | no | max 1024 chars | Applied only when not `undefined`. |

```json
{
  "body": "Hi {{customer}}, your order {{orderId}} is out for delivery.",
  "footer": "Thanks for shopping with us."
}
```

**Response** `200`

Loads via lookup (`404` if missing), patches the provided fields, saves, and returns the updated entity raw. `updatedAt` is refreshed.

```json
{
  "id": "f1c2a3b4-5d6e-7f80-9a1b-2c3d4e5f6071",
  "sessionId": "9b1c0e2a-3d4f-5a6b-7c8d-9e0f1a2b3c4d",
  "name": "order-confirmation",
  "body": "Hi {{customer}}, your order {{orderId}} is out for delivery.",
  "header": "OpenWA Store",
  "footer": "Thanks for shopping with us.",
  "createdAt": "2026-06-25T10:15:00.000Z",
  "updatedAt": "2026-06-25T11:02:00.000Z"
}
```

**Errors:** `400` validation / `forbidNonWhitelisted` · `401` missing/invalid `X-API-Key` · `403` key below OPERATOR role · `404` `id`+`sessionId` not found (raised before any write) · `409` rename collides with another template name in the session

#### DELETE /api/sessions/:sessionId/templates/:id

Delete a template by ID.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. |
| id | string | Template UUID to delete. |

**Response** `204`

No content (empty body). The handler looks the template up first, so a missing template yields `404` rather than a silent `204`.

**Errors:** `401` missing/invalid `X-API-Key` · `403` key below OPERATOR role · `404` `id`+`sessionId` not found

### 6.4.6 Catalog & Channels

WhatsApp Business catalog browsing/sending and channel (newsletter) operations. Catalog read routes (`/catalog…`) require any valid API key; the two product/catalog **send** routes live under the `/messages` path and require an **OPERATOR** key. Channel read routes require any valid API key; subscribe/unsubscribe require **OPERATOR**.

#### GET /api/sessions/:sessionId/catalog

Get business catalog info for the session's WhatsApp Business account.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. |

**Response** `200`

```json
{
  "id": "1234567890123456",
  "name": "My Storefront",
  "description": "Best products in town",
  "productCount": 12,
  "url": "https://wa.me/c/6281234567890"
}
```

Returns `null` when the account has no catalog (catalog is a WhatsApp Business-only feature; non-business accounts may yield `null`). The response is the raw `engine.getCatalog()` return — no envelope.

**Errors:** `401` missing/invalid API key · `404` `Session <sessionId> not found or not connected` · `500` engine error

#### GET /api/sessions/:sessionId/catalog/products

List catalog products with pagination.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. |

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `page` | integer | No | `1` | Page number. Coerced from string; must be an integer `>= 1` or `400`. |
| `limit` | integer | No | `20` | Page size. Must be an integer `>= 1`. No upper cap declared on the DTO. |

Validated against `ProductQueryDto` via the global ValidationPipe; any unknown query key is rejected with `400` (forbidNonWhitelisted).

**Response** `200`

```json
{
  "products": [
    {
      "id": "PROD_12345",
      "name": "Wireless Earbuds",
      "description": "Noise-cancelling, 24h battery",
      "price": 49990,
      "currency": "IDR",
      "priceFormatted": "Rp 49.990",
      "imageUrl": "https://example.com/img/earbuds.jpg",
      "url": "https://wa.me/p/PROD_12345/6281234567890",
      "isAvailable": true,
      "retailerId": "SKU-EB-01"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

**Errors:** `400` invalid `page`/`limit` or unknown query key · `401` missing/invalid API key · `404` `Session <sessionId> not found or not connected` · `500` engine error

#### GET /api/sessions/:sessionId/catalog/products/:productId

Get a specific catalog product by id.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. |
| `productId` | string | Catalog product id. |

**Response** `200`

```json
{
  "id": "PROD_12345",
  "name": "Wireless Earbuds",
  "description": "Noise-cancelling, 24h battery",
  "price": 49990,
  "currency": "IDR",
  "priceFormatted": "Rp 49.990",
  "imageUrl": "https://example.com/img/earbuds.jpg",
  "url": "https://wa.me/p/PROD_12345/6281234567890",
  "isAvailable": true,
  "retailerId": "SKU-EB-01"
}
```

An unknown `productId` returns `200` with body `null` — it is **not** a `404`. Only a missing/disconnected session yields `404`.

**Errors:** `401` missing/invalid API key · `404` `Session <sessionId> not found or not connected` · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-product

Send a product message (catalog product card) to a chat. Note: this route lives under the `/messages` path but belongs to the catalog module.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. |

**Request body** — `SendProductDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `chatId` | string | Yes | `@IsString` | Target chat/recipient id (e.g. `6281234567890@c.us`). |
| `productId` | string | Yes | `@IsString` | Catalog product id to send. |
| `body` | string | No | `@IsString` | Optional message body/caption. |

```json
{
  "chatId": "6281234567890@c.us",
  "productId": "PROD_12345",
  "body": "Check out this item!"
}
```

**Response** `201`

```json
{ "id": "true_6281234567890@c.us_3EB0...", "timestamp": 1719331200 }
```

`timestamp` is an epoch number (seconds).

**Errors:** `400` missing `chatId`/`productId`, wrong types, or any field not on the DTO · `401` missing/invalid API key · `403` API-key role below OPERATOR · `404` `Session <sessionId> not found or not connected` · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-catalog

Send the business catalog link to a chat. Note: this route lives under the `/messages` path but belongs to the catalog module.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. |

**Request body** — `SendCatalogDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `chatId` | string | Yes | `@IsString` | Target chat/recipient id. |
| `body` | string | No | `@IsString` | Optional message body/caption. |

```json
{
  "chatId": "6281234567890@c.us",
  "body": "Browse our full catalog here"
}
```

**Response** `201`

```json
{ "id": "true_6281234567890@c.us_3EB0...", "timestamp": 1719331200 }
```

`timestamp` is an epoch number (seconds).

**Errors:** `400` missing/invalid `chatId` or any non-DTO field · `401` missing/invalid API key · `403` API-key role below OPERATOR · `404` `Session <sessionId> not found or not connected` · `500` engine error

#### GET /api/sessions/:sessionId/channels

List all channels/newsletters the session is subscribed to.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. The engine must be started or the request fails with `400`. |

**Response** `200`

```json
[
  {
    "id": "120363000000000000@newsletter",
    "name": "OpenWA Updates",
    "description": "Release notes and tips",
    "inviteCode": "ABC123xyz",
    "subscriberCount": 1042,
    "picture": "https://example.com/ch.jpg",
    "verified": true,
    "createdAt": 1717200000
  }
]
```

Bare array, no envelope.

**Errors:** `400` `Session is not started` · `401` missing/invalid API key

#### GET /api/sessions/:sessionId/channels/:channelId

Get a single channel/newsletter by its id.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |
| `channelId` | string | Channel/newsletter id. |

**Response** `200`

```json
{
  "id": "120363000000000000@newsletter",
  "name": "OpenWA Updates",
  "description": "Release notes and tips",
  "inviteCode": "ABC123xyz",
  "subscriberCount": 1042,
  "picture": "https://example.com/ch.jpg",
  "verified": true,
  "createdAt": 1717200000
}
```

**Errors:** `400` `Session is not started` · `401` missing/invalid API key · `404` `Channel <channelId> not found` (engine returned null)

#### GET /api/sessions/:sessionId/channels/:channelId/messages

Get recent messages from a channel/newsletter.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |
| `channelId` | string | Channel/newsletter id. |

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `limit` | number | No | engine default (Swagger notes 50) | Max messages to return. Taken as a raw query string and run through `parseInt(limit, 10)` when present, else `undefined` is passed to the engine. There is **no** DTO/ValidationPipe on this value — a non-numeric `limit` becomes `NaN` and is forwarded to the engine. |

**Response** `200`

```json
[
  {
    "id": "false_120363000000000000@newsletter_3EB0...",
    "body": "v0.7.3 is out!",
    "timestamp": 1719331200,
    "hasMedia": false,
    "mediaUrl": null
  }
]
```

Bare array. `timestamp` is an epoch number (seconds).

**Errors:** `400` `Session is not started` · `401` missing/invalid API key

#### POST /api/sessions/:sessionId/channels/subscribe

Subscribe to a channel using its invite code.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |

**Request body** — `SubscribeChannelDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `inviteCode` | string | Yes | `@IsString` `@IsNotEmpty` | Channel invite code from the channel share link. |

```json
{ "inviteCode": "ABC123xyz" }
```

**Response** `201`

```json
{
  "id": "120363000000000000@newsletter",
  "name": "OpenWA Updates",
  "description": "Release notes and tips",
  "inviteCode": "ABC123xyz",
  "subscriberCount": 1042,
  "picture": "https://example.com/ch.jpg",
  "verified": true,
  "createdAt": 1717200000
}
```

**Errors:** `400` `Session is not started`, missing/empty `inviteCode`, or any unknown body field · `401` missing/invalid API key · `403` API-key role below OPERATOR

#### DELETE /api/sessions/:sessionId/channels/:channelId

Unsubscribe from a channel.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |
| `channelId` | string | Channel id to unsubscribe from. |

**Response** `200`

```json
{ "success": true }
```

Note: this is the one route in the module that returns a literal `{ success: true }` (hard-coded by the controller after the void engine call resolves) rather than the raw engine return. There is no `@HttpCode` override, so it returns `200`, not `204`.

**Errors:** `400` `Session is not started` · `401` missing/invalid API key · `403` API-key role below OPERATOR

### 6.4.7 Labels & Status

Labels are a WhatsApp Business feature: every label route lives under a session and reads/writes the chat-label assignments exposed by the engine. Status routes manage the session's status feed (stories) — reading visible statuses and posting/deleting your own. Read routes require a base API key; all writes require `OPERATOR`.

#### GET /api/sessions/:sessionId/labels

List all labels defined for the session (WhatsApp Business accounts only).

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |

**Response** `200`

```json
[
  { "id": "1", "name": "New customer", "hexColor": "#FF9485" },
  { "id": "5", "name": "Paid", "hexColor": "#25D366" }
]
```

Bare array — raw return of `engine.getLabels()`; no envelope.

**Errors:** `400` session is not started (no live engine), or the account is not a WhatsApp Business account · `401` missing/invalid API key

#### GET /api/sessions/:sessionId/labels/:labelId

Get a single label by its ID.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| labelId | string | Label ID |

**Response** `200`

```json
{ "id": "5", "name": "Paid", "hexColor": "#25D366" }
```

The engine resolves `Label | null`; a `null` is mapped to `404` in the service, so a `200` always carries a label.

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` `Label <labelId> not found`

#### GET /api/sessions/:sessionId/labels/chat/:chatId

List the labels currently assigned to a specific chat.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| chatId | string | Chat ID (e.g. `6281234567890@c.us` or a group `…@g.us`) |

**Response** `200`

```json
[
  { "id": "5", "name": "Paid", "hexColor": "#25D366" }
]
```

Bare array — raw return of `engine.getChatLabels(chatId)`.

**Errors:** `400` session is not started · `401` missing/invalid API key

#### POST /api/sessions/:sessionId/labels/chat/:chatId

Add a label to a chat.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| chatId | string | Chat ID to label |

**Request body** — `AddLabelDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| labelId | string | yes | non-empty string | Label ID to add to the chat |

```json
{ "labelId": "5" }
```

**Response** `201`

```json
{ "success": true }
```

The handler always returns the literal `{ "success": true }`. NestJS POST default status is `201` (the Swagger doc says `200`; the runtime code is `201`).

**Errors:** `400` validation failure (missing/empty/non-string `labelId`, or any unknown body field — strict whitelist), or session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role

#### DELETE /api/sessions/:sessionId/labels/chat/:chatId/:labelId

Remove a label from a chat.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID |
| chatId | string | Chat ID |
| labelId | string | Label ID to remove |

**Response** `200`

```json
{ "success": true }
```

The handler always returns `{ "success": true }`. DELETE default status is `200` (no `@HttpCode` override).

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role

#### GET /api/sessions/:sessionId/status

Get all contact status updates (stories) visible to the session.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | WhatsApp session identifier |

**Response** `200`

```json
{
  "statuses": [
    {
      "id": "false_6281234567890@c.us_3A1F...",
      "contact": { "id": "6281234567890@c.us", "name": "Alice", "pushName": "Alice" },
      "type": "image",
      "caption": "On the road",
      "mediaUrl": "https://…",
      "backgroundColor": "#25D366",
      "font": 2,
      "timestamp": "2026-06-25T08:30:00.000Z",
      "expiresAt": "2026-06-26T08:30:00.000Z"
    }
  ]
}
```

The controller wraps the engine array in `{ statuses }`. `type` is one of `text | image | video`; `caption`, `mediaUrl`, `backgroundColor`, `font` are optional. `timestamp` and `expiresAt` serialize to ISO strings (these are `Date` values, not the epoch-number convention used by message timestamps).

**Errors:** `401` missing/invalid API key, or key not scoped to this session · `404` `Session {id} not found or not connected`

#### GET /api/sessions/:sessionId/status/:contactId

Get status updates posted by a specific contact.

**Auth:** API key

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | WhatsApp session identifier |
| contactId | string | Contact JID/id (e.g. `6281234567890@c.us`) |

**Response** `200`

```json
{
  "statuses": [
    {
      "id": "false_6281234567890@c.us_3A1F...",
      "contact": { "id": "6281234567890@c.us", "pushName": "Alice" },
      "type": "text",
      "caption": "Hello!",
      "backgroundColor": "#25D366",
      "font": 0,
      "timestamp": "2026-06-25T08:30:00.000Z",
      "expiresAt": "2026-06-26T08:30:00.000Z"
    }
  ]
}
```

Same `{ statuses }` wrapper and `Status` shape as the list-all route.

**Errors:** `401` missing/invalid API key, or key not scoped to this session · `404` session not found / not connected

#### POST /api/sessions/:sessionId/status/send-text

Post a text status (story) to the session's status feed. **Baileys engine only** — a whatsapp-web.js session returns `501` (see Errors).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | WhatsApp session identifier |

**Request body** — `SendTextStatusDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| text | string | yes | — | Status text body |
| recipients | string[] | yes | 1–256 items, each matching `^\d+@(c\.us\|lid)$` | JIDs of the contacts permitted to view the status (passed as `statusJidList` to the engine). Empty array → `400` |
| backgroundColor | string | no | 6-digit hex color matching `^#[0-9A-Fa-f]{6}$` | e.g. `#25D366`; bad value → `backgroundColor must be a hex color (e.g., #25D366)` |
| font | integer | no | integer `0`–`5` | Font index |

```json
{ "text": "Hello from OpenWA!", "recipients": ["6281234567890@c.us"], "backgroundColor": "#25D366", "font": 2 }
```

**Response** `201`

```json
{
  "statusId": "false_status@broadcast_3A1F...",
  "timestamp": "2026-06-25T08:30:00.000Z",
  "expiresAt": "2026-06-26T08:30:00.000Z"
}
```

Returns the engine `StatusResult` directly (no wrapper). POST default status is `201`.

**Recipient JIDs:** `@c.us` (regular phone) recipients are reliable. `@lid` (privacy-id) recipients are best-effort and unverified — WhatsApp may not deliver to an unresolved LID, so prefer `@c.us` where the phone number is known.

**Sender-side caveat:** the posting account's own phone may display a "waiting for this status update" notice in its status feed; this is cosmetic — recipients view the status normally.

**Errors:** `400` validation failure (unknown body field, missing/empty `recipients`, a JID not matching `@c.us`/`@lid`, or more than 256 recipients, bad `backgroundColor`/`font`), or session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected · `501` the session is on the whatsapp-web.js engine (status posting is Baileys-only; WA Web removed `WAWebStatusGatingUtils.canCheckStatusRankingPosterGating` around 2026-04-30, so the wwebjs path is upstream-blocked — see #455)

#### POST /api/sessions/:sessionId/status/send-image

Post an image status (story) from a URL or base64 payload. **Baileys engine only** — a whatsapp-web.js session returns `501` (see Errors).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | WhatsApp session identifier |

**Request body** — `SendImageStatusDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| image | object (`MediaInput`) | yes | validated nested object (an empty `{}` passes — there is no `@IsNotEmpty`) | Media source wrapper |
| image.url | string | no | — | Media source URL |
| image.base64 | string | no | — | Base64-encoded media data |
| image.mimetype | string | no | — | Media MIME type; if omitted the service defaults to `image/jpeg` |
| recipients | string[] | yes | 1–256 items, each matching `^\d+@(c\.us\|lid)$` | JIDs of the contacts permitted to view the status (`statusJidList`). Empty array → `400` |
| caption | string | no | — | Optional caption |

The service resolves the media as `image.url || image.base64 || ''` and applies mimetype `image.mimetype ?? 'image/jpeg'`.

```json
{ "image": { "url": "https://example.com/photo.jpg", "mimetype": "image/png" }, "recipients": ["6281234567890@c.us"], "caption": "My status" }
```

**Response** `201`

```json
{
  "statusId": "false_status@broadcast_3A1F...",
  "timestamp": "2026-06-25T08:30:00.000Z",
  "expiresAt": "2026-06-26T08:30:00.000Z"
}
```

Returns the engine `StatusResult` directly. POST default status is `201`.

**Recipient JIDs:** `@c.us` (regular phone) recipients are reliable. `@lid` (privacy-id) recipients are best-effort and unverified — prefer `@c.us` where the phone number is known. **Sender-side caveat:** the posting account's own phone may show a "waiting for this status update" notice; recipients view it normally.

**Errors:** `400` validation failure (unknown body field, missing/empty `recipients`, a JID not matching `@c.us`/`@lid`, or more than 256 recipients), or session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected · `501` the session is on the whatsapp-web.js engine (status posting is Baileys-only; see `send-text` and #455)

#### POST /api/sessions/:sessionId/status/send-video

Post a video status (story) from a URL or base64 payload. **Baileys engine only** — a whatsapp-web.js session returns `501` (see Errors).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | WhatsApp session identifier |

**Request body** — `SendVideoStatusDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| video | object (`MediaInput`) | yes | validated nested object (an empty `{}` passes) | Media source wrapper |
| video.url | string | no | — | Media source URL |
| video.base64 | string | no | — | Base64-encoded media data |
| video.mimetype | string | no | — | Media MIME type; if omitted the service defaults to `video/mp4` |
| recipients | string[] | yes | 1–256 items, each matching `^\d+@(c\.us\|lid)$` | JIDs of the contacts permitted to view the status (`statusJidList`). Empty array → `400` |
| caption | string | no | — | Optional caption |

The service resolves the media as `video.url || video.base64 || ''` and applies mimetype `video.mimetype ?? 'video/mp4'`.

```json
{ "video": { "url": "https://example.com/clip.mp4", "mimetype": "video/quicktime" }, "recipients": ["6281234567890@c.us"], "caption": "Watch this" }
```

**Response** `201`

```json
{
  "statusId": "false_status@broadcast_3A1F...",
  "timestamp": "2026-06-25T08:30:00.000Z",
  "expiresAt": "2026-06-26T08:30:00.000Z"
}
```

Returns the engine `StatusResult` directly. POST default status is `201`.

**Recipient JIDs:** `@c.us` (regular phone) recipients are reliable. `@lid` (privacy-id) recipients are best-effort and unverified — prefer `@c.us` where the phone number is known. **Sender-side caveat:** the posting account's own phone may show a "waiting for this status update" notice; recipients view it normally.

**Errors:** `400` validation failure (unknown body field, missing/empty `recipients`, a JID not matching `@c.us`/`@lid`, or more than 256 recipients), or session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected · `501` the session is on the whatsapp-web.js engine (status posting is Baileys-only; see `send-text` and #455)

#### DELETE /api/sessions/:sessionId/status/:statusId

Delete one of the session's own posted statuses.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | WhatsApp session identifier |
| statusId | string | Id of the status to delete (the `statusId` returned by a `send-*` call) |

**Response** `200`

```json
{ "message": "Status deleted successfully" }
```

The service returns `void`; the controller returns a fixed success object. DELETE default status is `200`.

**Errors:** `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` `Session {id} not found or not connected`

### 6.4.8 Webhooks (management)

Webhooks are configured per session and managed under `/api/sessions/:sessionId/webhooks` (handled by `WebhookController`). A separate cross-session list endpoint lives at `/api/webhooks` (handled by `WebhooksListController`). Every route requires an API key with **OPERATOR** role or higher.

Two fields — `secret` and `headers` — are **write-only**: they are accepted on create/update but are **never** returned in any response (the response DTO has no `@Expose` for them, so `fromEntity` drops them). The `secret` is used to compute the `X-OpenWA-Signature: sha256=<hex>` HMAC-SHA256 header on deliveries.

The `events` array accepts these members plus the `*` wildcard: `message.received`, `message.sent`, `message.ack`, `message.failed`, `message.revoked`, `message.reaction`, `session.status`, `session.qr`, `session.authenticated`, `session.disconnected`, `group.join`, `group.leave`, `group.update`. The `group.*` events are **reserved** — accepted and validated but never dispatched (no engine emit source).

#### GET /api/sessions/:sessionId/webhooks

List all webhooks for a session, ordered by `createdAt` descending.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID to filter webhooks by. |

**Response** `200`

```json
[
  {
    "id": "f1e2d3c4-b5a6-7890-1234-567890abcdef",
    "sessionId": "my-session",
    "url": "https://your-server.com/webhook",
    "events": ["message.received", "session.status"],
    "filters": null,
    "active": true,
    "retryCount": 3,
    "lastTriggeredAt": null,
    "createdAt": "2026-06-25T10:00:00.000Z",
    "updatedAt": "2026-06-25T10:00:00.000Z"
  }
]
```

Returns a bare array; empty array if the session has no webhooks. `secret` and `headers` are never included. Not paginated.

**Errors:** `401` missing/invalid API key · `403` insufficient role

#### GET /api/sessions/:sessionId/webhooks/:id

Get a single webhook by ID, scoped to the session.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session ID. The lookup is `WHERE { id, sessionId }`, so a webhook belonging to a different session resolves to `404` (no cross-session existence oracle). |
| id | string (uuid) | Webhook ID. |

**Response** `200`

```json
{
  "id": "f1e2d3c4-b5a6-7890-1234-567890abcdef",
  "sessionId": "my-session",
  "url": "https://your-server.com/webhook",
  "events": ["message.received"],
  "filters": null,
  "active": true,
  "retryCount": 3,
  "lastTriggeredAt": "2026-06-25T11:30:00.000Z",
  "createdAt": "2026-06-25T10:00:00.000Z",
  "updatedAt": "2026-06-25T10:00:00.000Z"
}
```

**Errors:** `401` missing/invalid API key · `403` insufficient role · `404` webhook not found in this session (message `"Webhook with id '<id>' not found"`)

#### GET /api/webhooks

List webhooks visible to the calling API key, scoped to its allowed sessions.

**Auth:** API key (OPERATOR)  ·  **Scope:** session-scoped — derived from the authenticated key, not from any param/query

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer (1-1000) | No | `1000` | Max webhooks to return; oversized/non-finite values are clamped/fallback to the default window. |
| `offset` | integer | No | `0` | Webhooks to skip for paging; negative/non-finite values resolve to `0`. |

**Response** `200`

```json
[
  {
    "id": "f1e2d3c4-b5a6-7890-1234-567890abcdef",
    "sessionId": "my-session",
    "url": "https://your-server.com/webhook",
    "events": ["message.received"],
    "filters": null,
    "active": true,
    "retryCount": 3,
    "lastTriggeredAt": null,
    "createdAt": "2026-06-25T10:00:00.000Z",
    "updatedAt": "2026-06-25T10:00:00.000Z"
  }
]
```

Bare array, ordered by `createdAt` descending, bounded by `limit`/`offset`. If the calling key has a non-empty `allowedSessions` list, results are filtered to `WHERE sessionId IN (allowedSessions)`; a key with null/empty `allowedSessions` (e.g. an unrestricted ADMIN key) sees **all** webhooks. This is the cross-session list; the per-session list lives at `GET /api/sessions/:sessionId/webhooks`.

**Errors:** `401` missing/invalid API key · `403` insufficient role

#### POST /api/sessions/:sessionId/webhooks

Create a webhook for the session.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session the webhook is scoped to; stored as `webhook.sessionId`. No session-existence check is performed at create time. |

**Request body** — `CreateWebhookDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| url | string | yes | `@IsUrl({ require_tld: false })` (allows hostnames without a dot, e.g. `http://localhost:3000`); also run through the SSRF guard, which can reject with `400`. Entity column max 2048 chars. | Webhook URL to receive events. |
| events | string[] | no | `@IsArray`, `@ArrayMinSize(1)`, `@IsIn([...WEBHOOK_EVENTS, '*'], { each: true })` | Event names to subscribe to (see allowed set above). Defaults to `["message.received"]` when omitted. |
| secret | string | no | `@IsString`, `@MaxLength(255)` | HMAC-SHA256 signing key. **Write-only** — never returned. Used for `X-OpenWA-Signature`. Defaults to `null`. |
| headers | Record<string,string> | no | `@IsHeaderMap()` — flat object (not array), ≤50 entries, names match `/^[A-Za-z0-9-]+$/`, values are strings ≤1024 chars with no C0 control/DEL (CR/LF injection guard). | Custom headers added to deliveries. **Write-only** — never returned. At delivery, `content-type` and `x-openwa-*` names are stripped. Defaults to `{}`. |
| filters | WebhookFilters \| null | no | `@IsValidWebhookFilters()` — `{ conditions: [...] }`; each condition `{ field, operator('is'\|'isNot'\|'contains'\|'equals'), value(string\|string[]\|boolean), caseSensitive?:boolean }`; bounds: max 20 conditions, 100 values/condition, 1000-char text values. Message fields: `sender`, `recipient`, `body`, `type`, `isGroup`, `fromMe`, `hasMedia`, `mentions`. | Optional AND pre-filter; **all** conditions must match for the webhook to fire. Omit/null = fire on every subscribed event. Defaults to `null`. |
| retryCount | number (int) | no | `@IsInt`, `@Min(0)`, `@Max(5)` | Delivery retry attempts on failure. Defaults to `3`. |

```json
{
  "url": "https://your-server.com/webhook",
  "events": ["message.received", "session.status"],
  "secret": "your-secret-key",
  "headers": { "X-Custom-Header": "value" },
  "filters": {
    "conditions": [
      { "field": "sender", "operator": "is", "value": ["1234567890@c.us"] },
      { "field": "body", "operator": "contains", "value": "invoice" }
    ]
  },
  "retryCount": 3
}
```

**Response** `201`

```json
{
  "id": "f1e2d3c4-b5a6-7890-1234-567890abcdef",
  "sessionId": "my-session",
  "url": "https://your-server.com/webhook",
  "events": ["message.received", "session.status"],
  "filters": {
    "conditions": [
      { "field": "sender", "operator": "is", "value": ["1234567890@c.us"] },
      { "field": "body", "operator": "contains", "value": "invoice" }
    ]
  },
  "active": true,
  "retryCount": 3,
  "lastTriggeredAt": null,
  "createdAt": "2026-06-25T10:00:00.000Z",
  "updatedAt": "2026-06-25T10:00:00.000Z"
}
```

`secret` and `headers` are deliberately excluded from the response. `active` defaults to `true`, `lastTriggeredAt` is `null` on create.

**Errors:** `400` validation failure, unknown body field (whitelist), or SSRF URL rejection · `401` missing/invalid API key · `403` insufficient role

#### PUT /api/sessions/:sessionId/webhooks/:id

Update a webhook. Partial — only fields present in the body are changed.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session scope; the webhook is looked up by `(sessionId, id)` first → `404` if not in this session. |
| id | string (uuid) | Webhook ID. |

**Request body** — `UpdateWebhookDto` (all fields optional; only fields where the value is not `undefined` are applied)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| url | string | no | `@IsOptional`, `@IsUrl({ require_tld: false })`; re-runs the SSRF guard when provided → `400` if blocked. | New URL. |
| events | string[] | no | `@IsOptional`, `@IsArray`, `@ArrayMinSize(1)`, `@IsIn([...WEBHOOK_EVENTS, '*'], { each: true })` | Same allowed set as create (incl. `*` and reserved `group.*`). |
| secret | string | no | `@IsOptional`, `@IsString`, `@MaxLength(255)` | **Write-only.** An empty string is normalized to `null`, which disables HMAC. |
| headers | Record<string,string> | no | `@IsOptional`, `@IsHeaderMap()` (same constraints as create) | **Write-only.** Replaces existing headers wholesale when provided. |
| filters | WebhookFilters \| null | no | `@IsOptional`, `@IsValidWebhookFilters()` | Set to `null` to clear filters. |
| active | boolean | no | `@IsOptional`, `@IsBoolean` | Enable/disable the webhook. (Present only on update, not create.) |
| retryCount | number (int) | no | `@IsOptional`, `@IsInt`, `@Min(0)`, `@Max(5)` | Retry attempts. |

```json
{
  "events": ["*"],
  "active": false,
  "retryCount": 5,
  "filters": null
}
```

**Response** `200`

```json
{
  "id": "f1e2d3c4-b5a6-7890-1234-567890abcdef",
  "sessionId": "my-session",
  "url": "https://your-server.com/webhook",
  "events": ["*"],
  "filters": null,
  "active": false,
  "retryCount": 5,
  "lastTriggeredAt": null,
  "createdAt": "2026-06-25T10:00:00.000Z",
  "updatedAt": "2026-06-25T12:00:00.000Z"
}
```

Returns the saved entity; `secret` and `headers` excluded.

**Errors:** `400` validation failure, unknown body field (whitelist), or SSRF URL rejection · `401` missing/invalid API key · `403` insufficient role · `404` webhook not found in this session

#### POST /api/sessions/:sessionId/webhooks/:id/test

Send a synthetic test payload to the webhook URL and report the result. No request body.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session scope; looked up first → `404` if not in this session. |
| id | string (uuid) | Webhook ID. |

**Response** `200`

```json
{ "success": true, "statusCode": 200 }
```

On a reachable endpoint the response is `{ success: <response.ok>, statusCode: <response.status> }` — so a non-2xx target returns `200` HTTP with `success: false` and the target's `statusCode`. On an SSRF/timeout/network error the response is `{ "success": false, "error": "<message>" }`. The endpoint never throws on delivery failure; the failure is reflected in the body, not the HTTP status. The test POST sends `{ "event": "test", ... }` with headers `Content-Type`, `User-Agent: OpenWA-Webhook/1.0.0`, `X-OpenWA-Event: test`, `X-OpenWA-Idempotency-Key`, `X-OpenWA-Delivery-Id`, `X-OpenWA-Retry-Count: 0`, and `X-OpenWA-Signature` when a secret is set. Timeout defaults to 10000 ms (`webhook.timeout` config).

**Errors:** `401` missing/invalid API key · `403` insufficient role · `404` webhook not found in this session

#### DELETE /api/sessions/:sessionId/webhooks/:id

Delete a webhook, scoped to the session.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| sessionId | string | Session scope; looked up first → `404` if not in this session. |
| id | string (uuid) | Webhook ID. |

**Response** `204`

No content (empty body; explicit `@HttpCode(204)`).

**Errors:** `401` missing/invalid API key · `403` insufficient role · `404` webhook not found in this session

### 6.4.9 API Keys

API keys are managed under `/api/auth/api-keys`. All management routes (create/list/get/update/delete/revoke) require an **ADMIN** key. The plaintext key string is returned **only once**, at creation. Validation of the caller's own key lives at `POST /api/auth/validate` and accepts any valid key.

#### GET /api/auth/api-keys

List all API keys, newest first. The plaintext key is never returned.

**Auth:** API key (ADMIN)

**Response** `200`

Bare JSON array (no envelope), ordered by `createdAt` DESC. Null array/date fields are omitted.

```json
[
  {
    "id": "3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33",
    "name": "Production Bot",
    "keyPrefix": "owa_k1_a1b2",
    "role": "operator",
    "allowedIps": ["192.168.1.1", "10.0.0.0/8"],
    "allowedSessions": ["session-uuid-1"],
    "isActive": true,
    "expiresAt": "2027-12-31T23:59:59.000Z",
    "lastUsedAt": "2026-06-25T08:14:00.000Z",
    "usageCount": 42,
    "createdAt": "2026-06-01T10:00:00.000Z"
  }
]
```

**Errors:** `401` missing/invalid `X-API-Key` · `403` key role below ADMIN

#### GET /api/auth/api-keys/:id

Get a single API key's details by id. No plaintext key.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string (uuid) | API key id. Opaque resource id, not session-scoped. |

**Response** `200`

```json
{
  "id": "3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33",
  "name": "Production Bot",
  "keyPrefix": "owa_k1_a1b2",
  "role": "operator",
  "allowedIps": ["192.168.1.1", "10.0.0.0/8"],
  "allowedSessions": ["session-uuid-1"],
  "isActive": true,
  "expiresAt": "2027-12-31T23:59:59.000Z",
  "lastUsedAt": "2026-06-25T08:14:00.000Z",
  "usageCount": 42,
  "createdAt": "2026-06-01T10:00:00.000Z"
}
```

**Errors:** `401` missing/invalid key · `403` key role below ADMIN · `404` `"API key with id '<id>' not found"`

#### POST /api/auth/api-keys

Create a new API key; returns the full plaintext key exactly once.

**Auth:** API key (ADMIN)

**Request body** — `CreateApiKeyDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | length 3–100 | Friendly name for the key. |
| `role` | enum `admin` \| `operator` \| `viewer` | no | `@IsEnum` | Defaults to `operator` when omitted. |
| `allowedIps` | string[] | no | each entry a valid **IPv4** address or IPv4 CIDR `/0-32`; IPv6 rejected | IP whitelist (IPv4-only by design). |
| `allowedSessions` | string[] | no | each `@IsString` | Session IDs this key may access. |
| `expiresAt` | string (ISO 8601 date) | no | `@IsDateString` | Stored as a `Date`. |

```json
{
  "name": "Production Bot",
  "role": "operator",
  "allowedIps": ["192.168.1.1", "10.0.0.0/8"],
  "allowedSessions": ["session-uuid-1"],
  "expiresAt": "2027-12-31T23:59:59Z"
}
```

**Response** `201` — `ApiKeyCreatedResponseDto`

Same shape as the read DTO **plus** an `apiKey` field carrying the full plaintext key `owa_k1_<64 hex>`. This is the **only** time the plaintext key is returned. `keyPrefix` is the first 12 chars; `usageCount` starts at `0`, `isActive` is `true`. Null `allowedIps`/`allowedSessions`/`expiresAt`/`lastUsedAt` are omitted.

```json
{
  "id": "3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33",
  "name": "Production Bot",
  "keyPrefix": "owa_k1_a1b2",
  "role": "operator",
  "allowedIps": ["192.168.1.1", "10.0.0.0/8"],
  "allowedSessions": ["session-uuid-1"],
  "isActive": true,
  "expiresAt": "2027-12-31T23:59:59.000Z",
  "usageCount": 0,
  "createdAt": "2026-06-25T09:30:00.000Z",
  "apiKey": "owa_k1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

**Errors:** `400` validation (bad `name` length, invalid `role` enum, non-IPv4 `allowedIps` entry, bad `expiresAt`, or any non-whitelisted body field) · `401` missing/invalid key · `403` key role below ADMIN

#### PUT /api/auth/api-keys/:id

Update mutable fields of an API key. `isActive` is **not** updatable here — use the revoke route to deactivate.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string (uuid) | API key id. |

**Request body** — `UpdateApiKeyDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `name` | string | no | length 3–100 | Applied only if truthy. |
| `role` | enum `admin` \| `operator` \| `viewer` | no | `@IsEnum` | Applied only if truthy. |
| `allowedIps` | string[] | no | IPv4 address / CIDR only | Applied if not `undefined` (can be set to `[]` to clear). |
| `allowedSessions` | string[] | no | each `@IsString` | Applied if not `undefined`. |
| `expiresAt` | string (ISO 8601 date) | no | `@IsDateString` | Applied if not `undefined`; empty/falsy clears to `null`. |

```json
{
  "name": "Renamed Bot",
  "role": "viewer",
  "allowedIps": ["203.0.113.5"],
  "expiresAt": "2028-01-01T00:00:00Z"
}
```

**Response** `200` — `ApiKeyResponseDto`

Returns the updated key (no plaintext).

```json
{
  "id": "3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33",
  "name": "Renamed Bot",
  "keyPrefix": "owa_k1_a1b2",
  "role": "viewer",
  "allowedIps": ["203.0.113.5"],
  "isActive": true,
  "expiresAt": "2028-01-01T00:00:00.000Z",
  "usageCount": 42,
  "createdAt": "2026-06-01T10:00:00.000Z"
}
```

**Errors:** `400` validation (incl. `forbidNonWhitelisted` for unknown fields such as `isActive`) · `401` missing/invalid key · `403` key role below ADMIN · `404` not found

#### POST /api/auth/api-keys/:id/revoke

Revoke (deactivate) an API key without deleting it. No request body required.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string (uuid) | API key id. |

**Response** `200` — `ApiKeyResponseDto`

Sets `isActive` to `false` and returns the key. Default POST status `200` (no `@HttpCode` override). After revoke, the key fails validation with `401 "API key is revoked"`.

```json
{
  "id": "3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33",
  "name": "Production Bot",
  "keyPrefix": "owa_k1_a1b2",
  "role": "operator",
  "isActive": false,
  "usageCount": 42,
  "createdAt": "2026-06-01T10:00:00.000Z"
}
```

**Errors:** `401` missing/invalid key · `403` key role below ADMIN · `404` not found

#### DELETE /api/auth/api-keys/:id

Permanently delete an API key (hard delete). Also drops any un-flushed usage accumulator.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string (uuid) | API key id. |

**Response** `204`

`@HttpCode(204)` — no response body.

**Errors:** `401` missing/invalid key · `403` key role below ADMIN · `404` `"API key with id '<id>' not found"`

#### POST /api/auth/validate

Validate the supplied `X-API-Key` and report its validity and role.

**Auth:** API key (any valid role — VIEWER+)

The key is read from the `X-API-Key` header, not the body; send an empty body. This route sits behind the global guard (it is not `@Public`), so a missing/invalid/revoked/expired key is rejected with `401` at the guard before the handler runs. On success it returns the caller's role.

**Response** `200`

```json
{ "valid": true, "role": "operator" }
```

**Errors:** `401` missing/invalid/revoked/expired key (raised by the global guard before the handler)

> Implemented by `AuthValidateController` (`@Controller('auth')`), sharing the same `/api/auth` base.

### 6.4.10 System (Health, Metrics, Stats, Settings)

System endpoints expose operational status, Prometheus metrics, aggregate statistics, and runtime settings. Health and metrics use non-standard auth (public / Bearer token); stats and settings use the API key, with several routes gated to `ADMIN`.

#### GET /api/health

Basic health check returning status, the current timestamp, and the running app version.

**Auth:** public

**Response** `200`

```json
{ "status": "ok", "timestamp": "2026-06-25T12:34:56.789Z", "version": "0.7.3" }
```

Notes: `timestamp` is an ISO-8601 string (`new Date().toISOString()`). `version` is read from `package.json` at module load. Exempt from rate limiting (`@SkipThrottle`).

#### GET /api/health/live

Kubernetes liveness probe — returns a deliberately static body reflecting only process liveness; it does NOT probe dependencies.

**Auth:** public

**Response** `200`

```json
{ "status": "ok" }
```

Notes: always `{ "status": "ok" }`. Intentionally static so a transient dependency outage does not trigger a pod kill. The handler never returns a non-200.

#### GET /api/health/ready

Readiness probe — verifies the `main` (auth/audit) and `data` TypeORM datasources respond to `SELECT 1` (each bounded to a 3000 ms timeout) and reports `503` while the app is draining/shutting down.

**Auth:** public

**Response** `200`

```json
{
  "status": "ok",
  "details": {
    "mainDatabase": { "status": "up" },
    "dataDatabase": { "status": "up" }
  }
}
```

**Errors:** `503` — either datasource fails or exceeds its 3 s `SELECT 1` timeout, or the app is shutting down. The handler throws `ServiceUnavailableException`, so NestJS wraps the custom `{ status, details }` object as the `message` field:

```json
{
  "statusCode": 503,
  "message": {
    "status": "error",
    "details": { "mainDatabase": { "status": "up" }, "dataDatabase": { "status": "down" } }
  },
  "error": "Service Unavailable"
}
```

During shutdown the `details` instead read `{ "shutdown": { "status": "draining" } }`. Probes run in parallel via `Promise.all`. There is no `health/detailed` route.

#### GET /api/metrics

Prometheus exposition scrape of OpenWA process + session + message metrics; gated by a `METRICS_TOKEN` bearer (disabled when the token is unset).

**Auth:** Bearer METRICS_TOKEN — `Authorization: Bearer <METRICS_TOKEN>`. This route is `@Public()` (it bypasses the `X-API-Key` guard); access is instead validated inside the service with a constant-time compare. The `Bearer ` prefix is stripped case-insensitively. Hidden from Swagger.

**Response** `200`

Content-Type `text/plain; version=0.0.4; charset=utf-8`, `Cache-Control: no-store`. Raw text (no JSON envelope):

```
# HELP openwa_up 1 if the OpenWA process is running
# TYPE openwa_up gauge
openwa_up 1
# TYPE openwa_process_uptime_seconds gauge
openwa_process_uptime_seconds 3600
# TYPE openwa_process_resident_memory_bytes gauge
openwa_process_resident_memory_bytes 187432960
# TYPE openwa_process_heap_used_bytes gauge
openwa_process_heap_used_bytes 64512000
# TYPE openwa_sessions_total gauge
openwa_sessions_total 3
# TYPE openwa_sessions_active gauge
openwa_sessions_active 2
# TYPE openwa_sessions gauge
openwa_sessions{status="ready"} 2
openwa_sessions{status="disconnected"} 1
# TYPE openwa_messages_total counter
openwa_messages_total{direction="outgoing"} 1280
openwa_messages_total{direction="incoming"} 940
# TYPE openwa_messages_failed_total counter
openwa_messages_failed_total 4
```

Values come from `StatsService.getOverview()` plus `process.memoryUsage()`/`process.uptime()`. The render is memoized for 5000 ms to avoid re-running the overview query on every scrape.

**Errors:** `401` — `METRICS_TOKEN` is configured but the bearer is missing or does not match (`{ "statusCode": 401, "message": "Invalid metrics token", "error": "Unauthorized" }`) · `404` — `METRICS_TOKEN` is unset/blank, so the endpoint is disabled (`{ "statusCode": 404, "message": "Metrics endpoint is disabled (set METRICS_TOKEN to enable)", "error": "Not Found" }`).

#### GET /api/stats/overview

Get overall cross-session aggregate statistics (sessions by status + message totals + today's counts).

**Auth:** API key (ADMIN) — deliberately ADMIN-only (global cross-tenant aggregate).

**Response** `200`

```json
{
  "sessions": {
    "active": 2,
    "total": 3,
    "byStatus": { "READY": 2, "DISCONNECTED": 1 }
  },
  "messages": {
    "sent": 1280,
    "received": 940,
    "failed": 4,
    "today": { "sent": 42, "received": 30 }
  }
}
```

Notes: raw handler return (no envelope). `sessions.byStatus` is keyed by `SessionStatus` enum values with per-status counts; `sessions.active` counts only `READY`. `messages.sent`/`received` are all-time outgoing/incoming COUNTs; `failed` is the `FAILED`-status COUNT; `today.*` are the same counts since local midnight. Side effect: caches the `sessions` block via `CacheService`.

**Errors:** `401` — missing/invalid `X-API-Key` · `403` — key role below `ADMIN`.

#### GET /api/stats/messages

Get message statistics over a period: time series, counts by type, by session, and top chats.

**Auth:** API key (ADMIN) — cross-session aggregate.

**Query parameters**

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `period` | `'24h' \| '7d' \| '30d'` | No | `24h` | Window for the report. `@IsIn(['24h','7d','30d'])` — any other value → `400`. Bucket interval is `hour` for `24h`, else `day`. |

**Response** `200`

```json
{
  "timeSeries": [
    { "timestamp": "2026-06-25 10:00:00", "sent": 12, "received": 8 },
    { "timestamp": "2026-06-25 11:00:00", "sent": 20, "received": 14 }
  ],
  "byType": { "chat": 180, "image": 24, "unknown": 3 },
  "bySession": [
    { "sessionId": "9f1c…", "name": "support-line", "sent": 200, "received": 140 }
  ],
  "topChats": [
    { "chatId": "6281234567890@c.us", "messageCount": 320 }
  ]
}
```

Notes: raw handler return. `timeSeries.timestamp` is a DB-formatted bucket string — hourly `YYYY-MM-DD HH:00:00` for `24h`, daily `YYYY-MM-DD` for `7d`/`30d` — sorted ascending. `byType` keys are message-type strings (a null type becomes `unknown`). `bySession.name` is `Unknown` when the session is not found. `topChats` is the top 10 by `messageCount` DESC. All counts are numbers.

**Errors:** `400` — `period` not in the enum, or any non-whitelisted query field (strict `whitelist` + `forbidNonWhitelisted`) · `401` — missing/invalid API key · `403` — role below `ADMIN`.

#### GET /api/stats/sessions/:sessionId

Get statistics for a single session: identity, message counts, top chats, and 24 h hourly activity.

**Auth:** API key — any valid key (VIEWER and up); there is no `@RequireRole`. Note: the handler does NOT verify the key is scoped to this session, so any authenticated key can read any session's stats.

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `sessionId` | string | Session entity id. No format validation; `404` if no session matches. |

**Response** `200`

```json
{
  "session": { "id": "9f1c…", "name": "support-line", "status": "ready" },
  "messages": { "sent": 200, "received": 140, "today": 18, "failed": 1 },
  "topChats": [
    { "chatId": "6281234567890@c.us", "count": 64, "lastActive": "2026-06-25 11:42:07" }
  ],
  "hourlyActivity": [
    { "hour": 0, "sent": 0, "received": 0 },
    { "hour": 1, "sent": 3, "received": 2 }
  ]
}
```

Notes: raw handler return. `session.status` is the `SessionStatus` enum value. `messages.sent`/`received` are all-time outgoing/incoming COUNTs; `today` is the total message count since local midnight; `failed` is the `FAILED`-status count. `topChats` is the top 10 by count DESC, with `lastActive` = `MAX(createdAt)` as a DB-native datetime string. `hourlyActivity` always has 24 entries (hour `0..23`), missing hours zero-filled, computed over the last 24 h.

**Errors:** `401` — missing/invalid API key · `404` — session not found (`Session not found`).

#### GET /api/settings

Get application settings (environment-derived; `general`/`api`/`notifications` groups).

**Auth:** API key (ADMIN). Settings expose server configuration, so a VIEWER or session-scoped key is rejected with `403`.

**Response** `200`

```json
{
  "general": {
    "apiBaseUrl": "http://localhost:2785",
    "sessionTimeout": 0,
    "autoReconnect": false,
    "debugMode": false
  },
  "api": {
    "rateLimit": 100,
    "rateLimitWindow": 60000,
    "enableDocs": true
  },
  "notifications": {
    "emailEnabled": false,
    "notificationEmail": "",
    "webhookAlerts": true
  }
}
```

Notes: raw return of an in-memory `Settings` object built once in the controller constructor from `ConfigService` (snapshotted at construction, not re-read per request). `general.sessionTimeout` is `floor(webhook.timeout / 60000)` minutes; `api.rateLimitWindow` is in ms; `enableDocs`/`notifications.*` are partly hardcoded (`enableDocs: true`, `emailEnabled: false`, `notificationEmail: ''`, `webhookAlerts: true`).

**Errors:** `401` — missing/invalid `X-API-Key` · `403` — API key lacks the ADMIN role.

#### PUT /api/settings

Update settings — intentionally not implemented; always returns `501` (settings are env-derived and read-only at runtime).

**Auth:** API key (ADMIN)

**Request body** — none. There is no request DTO; any body is ignored (the exception is thrown before validation matters).

**Response** `501`

```json
{
  "statusCode": 501,
  "message": "Settings are derived from environment configuration and are read-only at runtime. Change the corresponding environment variable and restart the service.",
  "error": "Not Implemented"
}
```

Notes: the handler unconditionally throws `NotImplementedException`. Even an ADMIN key always gets `501`; there is no success response.

**Errors:** `401` — missing/invalid key · `403` — key lacks `ADMIN` · `501` — always (not implemented).

### 6.4.11 Administration (Infrastructure, Plugins, MCP)

Admin-facing operations: infrastructure status & config, the data/storage migration tooling, plugin lifecycle, and the optional MCP transport. Almost every route is **API key (ADMIN)**; the two exceptions are the public `GET /api/infra/health` and the `POST /mcp` JSON-RPC endpoint (see end of section).

> Note on the infra/MCP request bodies: the `PUT /api/infra/config`, `POST /api/infra/restart`, `POST /api/infra/import-data`, `POST /api/infra/storage/import` bodies and the entire `POST /mcp` envelope are **plain TS interfaces, not class-validator DTOs** — the global `whitelist`/`forbidNonWhitelisted` ValidationPipe does **not** run on them. Unknown fields pass through silently and no type/constraint checks happen, except the few field-level guards noted per endpoint. Plugin DTOs (`InstallFromUrlDto`, `PluginConfigDto`, `PluginSessionsDto`) *are* class-validated and reject unknown fields with `400`.

---

#### GET /api/infra/health

Public liveness probe.

**Auth:** public

**Response** `200`

```json
{ "status": "ok", "timestamp": "2026-06-25T12:00:00.000Z" }
```

---

#### GET /api/infra/status

Aggregate infrastructure status (database, Redis, queue, storage, engine).

**Auth:** API key (ADMIN)

**Response** `200`

```json
{
  "database": { "connected": true, "type": "sqlite", "host": "" },
  "redis": { "enabled": false, "connected": false, "host": "localhost", "port": 6379 },
  "queue": {
    "enabled": false,
    "webhooks": { "pending": 0, "completed": 0, "failed": 0 }
  },
  "storage": { "type": "local", "path": "./data/media" },
  "engine": {
    "type": "whatsapp-web.js",
    "headless": true,
    "sessionDataPath": "./data/sessions",
    "browserArgs": "--no-sandbox --disable-gpu"
  }
}
```

The `queue.webhooks` counters are live BullMQ job counts (`pending` = waiting + active + delayed; plus `completed`/`failed`), degrading to zeros when the queue is disabled or Redis is unreachable. `redis.connected` is a live probe. `storage` only ever returns `type`+`path` here (no `bucket`).

**Errors:** `401` missing/invalid key · `403` key role < ADMIN

---

#### GET /api/infra/engines

List available WhatsApp engine plugins.

**Auth:** API key (ADMIN)

**Response** `200` — bare array

```json
[
  {
    "id": "whatsapp-web.js",
    "name": "WhatsApp Web.js",
    "enabled": true,
    "features": ["send", "receive", "media", "groups"],
    "library": { "name": "whatsapp-web.js", "version": "1.34.7" }
  }
]
```

`library` is optional and may be omitted per engine.

**Errors:** `401` · `403`

---

#### GET /api/infra/engines/current

Get the currently active engine type.

**Auth:** API key (ADMIN)

**Response** `200`

```json
{ "engineType": "whatsapp-web.js" }
```

**Errors:** `401` · `403`

---

#### GET /api/infra/config

Read the saved infrastructure config from `data/.env.generated` (used to hydrate the dashboard form). **Secrets are never returned** — only `*Set`/`*CredentialsSet` booleans indicate that a secret is stored.

**Auth:** API key (ADMIN)

**Response** `200` — `SavedConfigResponse`

```json
{
  "database": {
    "type": "sqlite", "builtIn": false, "host": "", "port": "",
    "username": "", "database": "", "poolSize": 10,
    "sslEnabled": false, "sslRejectUnauthorized": true, "passwordSet": false
  },
  "redis": { "enabled": false, "builtIn": false, "host": "", "port": "", "passwordSet": false },
  "queue": { "enabled": false },
  "storage": {
    "type": "local", "builtIn": false, "localPath": "./data/media",
    "s3Bucket": "", "s3Region": "", "s3Endpoint": "", "s3CredentialsSet": false
  },
  "engine": {
    "type": "whatsapp-web.js", "headless": true,
    "sessionDataPath": "./data/sessions", "browserArgs": "--no-sandbox --disable-gpu"
  }
}
```

When `data/.env.generated` does not exist, empty-string/default values are returned (`poolSize=10`, `sslRejectUnauthorized=true`, `engine.type='whatsapp-web.js'`, `headless=true`).

**Errors:** `401` · `403`

---

#### PUT /api/infra/config

Merge-save infrastructure config to `data/.env.generated` (a `0600` secret file). A partial payload preserves untouched keys; empty/omitted secret fields keep the existing stored secret.

**Auth:** API key (ADMIN)

**Request body** — `SaveConfigDto` (plain interface, **not** class-validated; only `engine.type` and CR/LF safety are enforced)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `database` | object | No | — | DB section (see nested) |
| `database.type` | `'sqlite' \| 'postgres'` | No | — | `sqlite` drops stale postgres keys; `postgres` writes connection keys |
| `database.builtIn` | boolean | No | — | When `true`+postgres, forces the bundled `postgres` container creds + pushes `postgres` Docker profile |
| `database.host` / `.port` / `.username` / `.database` | string | No | `port` is a string | External postgres connection (defaults `localhost`/`5432`/`postgres`/`openwa`) |
| `database.password` | string | No | secret | Empty/omitted keeps the existing stored secret |
| `database.poolSize` | number | No | — | Default 10 |
| `database.sslEnabled` | boolean | No | — | Default false |
| `database.sslRejectUnauthorized` | boolean | No | — | Only written when `sslEnabled` is true; default true |
| `redis.enabled` / `.builtIn` | boolean | No | — | `builtIn`+enabled forces `redis` container + profile |
| `redis.host` / `.port` | string | No | `port` is a string | Defaults `localhost`/`6379` |
| `redis.password` | string | No | secret | Empty keeps existing |
| `queue.enabled` | boolean | No | — | Writes `QUEUE_ENABLED` |
| `storage.type` | `'local' \| 's3'` | No | — | `local` drops stale S3 keys; `s3` drops `STORAGE_LOCAL_PATH` |
| `storage.builtIn` | boolean | No | — | `true`+s3 uses bundled MinIO defaults + pushes `minio` profile |
| `storage.localPath` | string | No | — | Default `./data/media` |
| `storage.s3Bucket` / `.s3Region` / `.s3Endpoint` | string | No | — | External S3 |
| `storage.s3AccessKey` / `.s3SecretKey` | string | No | secret | Empty keeps existing |
| `engine.type` | string | No | **must be a known engine id, else `400`** | The only validated field in the body |
| `engine.headless` | boolean | No | — | Default true; saved as `PUPPETEER_HEADLESS` |
| `engine.sessionDataPath` | string | No | — | Default `./data/sessions` |
| `engine.browserArgs` | string | No | — | Saved as `PUPPETEER_ARGS` |

```json
{
  "database": { "type": "postgres", "builtIn": false, "host": "db.example.com", "port": "5432", "username": "openwa", "password": "s3cret", "database": "openwa", "poolSize": 10, "sslEnabled": true, "sslRejectUnauthorized": false },
  "redis": { "enabled": true, "builtIn": true },
  "queue": { "enabled": true },
  "storage": { "type": "s3", "builtIn": false, "s3Bucket": "my-bucket", "s3Region": "ap-southeast-1", "s3AccessKey": "AKIA...", "s3SecretKey": "...", "s3Endpoint": "https://s3.example.com" },
  "engine": { "type": "whatsapp-web.js", "headless": true, "sessionDataPath": "./data/sessions", "browserArgs": "--no-sandbox --disable-gpu" }
}
```

**Response** `200`

```json
{ "message": "Configuration saved. Server restart required.", "saved": true, "envPath": "data/.env.generated", "profiles": ["postgres", "redis"] }
```

This route **always returns HTTP 200**, even on failure: write/IO errors are caught and returned as `{ "saved": false, "envPath": "", "profiles": [], "message": "Failed to save configuration: …" }`. The only true `400` cases are an unknown `engine.type` or any value containing `\r`/`\n`. `profiles` lists newly-required Docker profiles.

**Errors:** `400` unknown `engine.type` / CR-LF in a value · `401` · `403`

---

#### POST /api/infra/restart

Request a graceful server restart, optionally orchestrating Docker profiles (add/remove services). Schedules process shutdown as a side-effect.

**Auth:** API key (ADMIN)

**Request body** — optional inline type (plain interface, not class-validated)

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `profiles` | string[] | No | `[]` | Docker profiles to enable/start (e.g. `postgres`, `redis`, `minio`) |
| `profilesToRemove` | string[] | No | `[]` | Docker profiles whose containers should be stopped/removed |

```json
{ "profiles": ["postgres", "redis"], "profilesToRemove": ["minio"] }
```

**Response** `200`

```json
{
  "message": "Restarting…",
  "restarting": true,
  "profiles": ["postgres", "redis"],
  "profilesToRemove": ["minio"],
  "estimatedTime": 48
}
```

`estimatedTime` (seconds) = base 15 + 20/postgres + 13/redis + 15/minio + 5/removal. `orchestration` is present only when Docker is available and `profiles` is non-empty; `removal` only when Docker is available and `profilesToRemove` is non-empty. Without Docker, a `data/.orchestration-request.json` signal file is written instead. After responding, `shutdownService.shutdown()` runs (default ~3s grace); readiness returns `503` during drain.

**Errors:** `401` · `403`

---

#### GET /api/infra/export-data

Export every row from the Data DB (sessions, webhooks, messages, batches, templates, Baileys stored messages) as JSON for migration. Read-only, but runs raw `SELECT *` on the `data` DataSource.

**Auth:** API key (ADMIN)

**Response** `200`

```json
{
  "exportedAt": "2026-06-25T12:00:00.000Z",
  "dataDbType": "sqlite",
  "tables": {
    "sessions": [ { "id": "s1", "name": "main", "status": "READY", "phone": "15551234567", "pushName": "Me", "config": {}, "proxyUrl": null, "proxyType": null, "connectedAt": "2026-06-25T00:00:00.000Z", "lastActiveAt": "2026-06-25T00:00:00.000Z", "createdAt": "2026-06-25T00:00:00.000Z", "updatedAt": "2026-06-25T00:00:00.000Z" } ],
    "webhooks": [],
    "messages": [],
    "messageBatches": [],
    "templates": [],
    "baileysStoredMessages": []
  },
  "counts": { "sessions": 1, "webhooks": 0, "messages": 0, "messageBatches": 0, "templates": 0, "baileysStoredMessages": 0 }
}
```

Rows are raw DB column shapes (e.g. `messageBatches` rows use snake_case columns: `batch_id`, `session_id`, `current_index`, `created_at`, …). **`webhooks` rows include `secret` in cleartext.** `messages`/`messageBatches`/`templates`/`baileysStoredMessages` default to `[]` if their table is missing; `sessions`/`webhooks` are not try-wrapped, so a hard DB error there yields `500`.

**Errors:** `401` · `403` · `500` DB error

---

#### POST /api/infra/import-data

Replace all Data DB rows with the supplied export. **Destructive and transactional (all-or-nothing).**

**Auth:** API key (ADMIN)

**Request body** — inline `{ tables: Partial<MigrationTables> }` (plain interface, not class-validated)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tables` | object | Yes | Container of per-table row arrays. Accessing `data.tables` directly means a missing/null value throws `500` |
| `tables.sessions` | `SessionRow[]` | No | Inserted first; skipped if absent/empty |
| `tables.webhooks` | `WebhookRow[]` | No | Includes `secret` |
| `tables.messages` | `MessageRow[]` | No | — |
| `tables.messageBatches` | `MessageBatchRow[]` | No | snake_case columns |
| `tables.templates` | `TemplateRow[]` | No | — |
| `tables.baileysStoredMessages` | `BaileysStoredMessageRow[]` | No | — |

```json
{
  "tables": {
    "sessions": [ { "id": "s1", "name": "main", "status": "READY", "phone": "15551234567", "pushName": "Me", "config": {}, "proxyUrl": null, "proxyType": null, "connectedAt": "2026-06-25T00:00:00.000Z", "lastActiveAt": "2026-06-25T00:00:00.000Z", "createdAt": "2026-06-25T00:00:00.000Z", "updatedAt": "2026-06-25T00:00:00.000Z" } ],
    "webhooks": [], "messages": [], "messageBatches": [], "templates": [], "baileysStoredMessages": []
  }
}
```

**Response** `200`

```json
{
  "imported": true,
  "counts": { "sessions": 1, "webhooks": 0, "messages": 0, "messageBatches": 0, "templates": 0, "baileysStoredMessages": 0 },
  "warnings": []
}
```

Inside a transaction it DELETEs all rows from webhooks/messages/message_batches/templates/baileys_stored_messages/sessions, then re-inserts. If **any** row insert fails, `warnings` is non-empty, the transaction is **rolled back**, and `imported:false` is returned (counts reflect rows inserted before the failure). JSON object/array fields are auto-stringified before insert.

**Errors:** `401` · `403` · `500` `tables` missing/null or unrecoverable DB error

---

#### GET /api/infra/storage/files/count

File count and total size in the active storage backend.

**Auth:** API key (ADMIN)

**Response** `200`

```json
{ "storageType": "local", "count": 128, "sizeBytes": 5242880, "sizeMB": "5.00" }
```

**Errors:** `401` · `403` · `500`

---

#### GET /api/infra/storage/export

Export all storage files into a `tar.gz` under `data/exports` and return its **server-side path** (not a download stream).

**Auth:** API key (ADMIN)

**Response** `200`

```json
{ "message": "Storage export completed", "download": "data/exports/storage-export-1750000000000-abc.tar.gz" }
```

`download` is a server filesystem path — feed it back to `POST /api/infra/storage/import`. The archive is auto-deleted after `STORAGE_EXPORT_TTL_MS` (default 1h).

**Errors:** `401` · `403` · `500`

---

#### POST /api/infra/storage/import

Import storage files from a `tar.gz` located inside the `data/` directory.

**Auth:** API key (ADMIN)

**Request body** — inline `{ filePath: string }` (plain interface, not class-validated; path-safety enforced manually)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `filePath` | string | Yes | Must resolve inside `<cwd>/data` **and** exist on disk, else `400` | Path to the archive (constrained to `data/` to block traversal) |

```json
{ "filePath": "./data/exports/storage-export-1750000000000-abc.tar.gz" }
```

**Response** `200`

```json
{ "imported": true, "count": 128, "storageType": "local" }
```

**Errors:** `400` missing/out-of-`data/`/not-found path · `401` · `403` · `500`

---

#### GET /api/plugins

List all loaded plugins (built-in + installed), with secret config values redacted.

**Auth:** API key (ADMIN)

**Response** `200` — `PluginDto[]` (bare array, `[]` if none)

```json
[
  {
    "id": "chat-flow",
    "name": "Chat Flow",
    "version": "1.0.0",
    "type": "extension",
    "description": "Visual reply flows",
    "author": "openwa-plugins",
    "status": "enabled",
    "config": { "apiKey": "********" },
    "builtIn": false,
    "provides": ["message-hook"],
    "sessionScoped": true,
    "activeSessions": ["*"],
    "loadedAt": "2026-06-25T00:00:00.000Z",
    "enabledAt": "2026-06-25T00:01:00.000Z"
  }
]
```

`type` is one of `engine | storage | queue | auth | extension`; `status` is `installed | enabled | disabled | error`. `activeSessions: ["*"]` means all sessions. Optional fields: `configSchema`, `configUi`, `i18n`, `sessionConfig` (secrets redacted), `error`.

**Errors:** `401` · `403`

---

#### GET /api/plugins/catalog

List the remote plugin catalog annotated with this instance's install state. (Declared before `:id` so `catalog` is not captured as an id.)

**Auth:** API key (ADMIN)

**Response** `200` — bare array

```json
[
  {
    "id": "group-translate",
    "name": "Group Translate",
    "version": "1.2.0",
    "type": "extension",
    "description": "Auto-translate group messages",
    "author": "openwa-plugins",
    "download": "https://github.com/openwa-plugins/group-translate/releases/download/v1.2.0/group-translate.zip",
    "installed": true,
    "installedVersion": "1.1.0",
    "updateAvailable": true
  }
]
```

Returns `[]` when no `plugins.catalogUrl` is configured.

**Errors:** `400` catalog fetch failed / not a JSON array · `401` · `403`

---

#### GET /api/plugins/:id

Get a single plugin by id.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |

**Response** `200` — single `PluginDto` (same shape as the list element, secrets redacted).

**Errors:** `401` · `403` · `404` `Plugin {id} not found`

---

#### GET /api/plugins/:id/config-ui

Serve a plugin's sandboxed config-UI entry HTML (for an iframe `srcdoc`).

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |

**Response** `200` — raw HTML (not JSON). Headers: `Content-Type: text/html; charset=utf-8`, `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`.

**Errors:** `401` · `403` · `404` plugin missing, no `configUi.entry`, file missing, or containment-check failure

---

#### GET /api/plugins/:id/health

Check a plugin's health (delegates to the loader / sandboxed workers).

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |

**Response** `200`

```json
{ "healthy": true }
```

Internal failures are reported in-band as `{ "healthy": false, "message": "…" }` with HTTP 200.

**Errors:** `401` · `403` · `404` unknown id

---

#### POST /api/plugins/install

Install a plugin from an uploaded `.zip` package.

**Auth:** API key (ADMIN)

**Request body** — `multipart/form-data` (no DTO)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `file` | binary (`.zip`) | Yes | ≤ 5 MB; must contain a valid plugin manifest | Form field name is literally `file` |

**Response** `201` — the newly installed `PluginDto`.

**Errors:** `400` no file / invalid package / install failed · `401` · `403` · `409` plugin id or directory already exists

---

#### POST /api/plugins/install-url

Install a plugin by downloading its `.zip` from an HTTP(S) URL (SSRF-guarded fetch: host validated, redirects refused, size-capped at `plugins.downloadMaxBytes`, default 5 MB).

**Auth:** API key (ADMIN)

**Request body** — `InstallFromUrlDto` (class-validated; extra fields → `400`)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes | `@IsUrl({ protocols:['http','https'], require_protocol:true })` | Absolute http(s) URL of the package |

```json
{ "url": "https://github.com/openwa-plugins/chat-flow/releases/download/v1.0.0/chat-flow.zip" }
```

**Response** `201` — the newly installed `PluginDto`.

**Errors:** `400` invalid URL / download or package invalid · `401` · `403` · `409` already installed

---

#### POST /api/plugins/:id/enable

Enable a plugin.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |

**Response** `200`

```json
{ "success": true, "message": "Plugin enabled successfully" }
```

Enable failures are returned in-band as `{ "success": false, "message": "…" }` (still HTTP 200).

**Errors:** `401` · `403` · `404` unknown id

---

#### POST /api/plugins/:id/disable

Disable a plugin.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |

**Response** `200`

```json
{ "success": true, "message": "Plugin disabled successfully" }
```

**Errors:** `401` · `403` · `404` unknown id

---

#### PUT /api/plugins/:id/config

Update a plugin's base configuration object.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |

**Request body** — `PluginConfigDto` (class-validated; body must be exactly `{config:{…}}`)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `config` | object | Yes | `@IsObject()` | Whole config object. Masked/sentinel secret values mean "unchanged" and are restored from the stored config |

```json
{ "config": { "apiKey": "sk-...", "replyDelayMs": 1500 } }
```

**Response** `200`

```json
{ "success": true, "message": "Plugin configuration updated" }
```

Update failures are returned in-band as `{ "success": false, "message": "…" }` (HTTP 200).

**Errors:** `400` extra top-level field · `401` · `403` · `404` unknown id

---

#### PUT /api/plugins/:id/config/:sessionId

Set (or clear) a plugin config override for a specific session.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |
| `sessionId` | string | Session the override applies to |

**Request body** — `PluginConfigDto`

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `config` | object | Yes | `@IsObject()` | Per-session override slice. Empty `{}` clears the override (falls back to base config). Masked secrets restored from the existing per-session value |

```json
{ "config": { "replyDelayMs": 3000 } }
```

**Response** `200`

```json
{ "success": true, "message": "Plugin configuration for session session-1 updated" }
```

**Errors:** `400` plugin is global (not session-scoped) / extra field · `401` · `403` · `404` unknown id

---

#### PUT /api/plugins/:id/sessions

Set which sessions a session-scoped plugin is activated for.

**Auth:** API key (ADMIN)  ·  **Scope:** session-scoped (the key's `allowedSessions` is enforced)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |

**Request body** — `PluginSessionsDto` (class-validated)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `sessions` | string[] | Yes | `@IsArray()`, `@IsString({ each:true })` | Session ids to activate for. `["*"]` = all, `[]` = none |

```json
{ "sessions": ["*"] }
```

**Response** `200` — the updated `PluginDto` (reflecting the new `activeSessions`).

A session-restricted key requesting `"*"` or out-of-scope sessions gets `403 API key not authorized for session(s): …`.

**Errors:** `400` plugin is global · `401` · `403` key not authorized for requested sessions · `404` unknown id

---

#### POST /api/plugins/:id/update

Update an installed plugin in place from a URL, preserving config + enabled state (old directory backed up and restored on failure).

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id (must match the package's manifest id) |

**Request body** — `InstallFromUrlDto` (class-validated)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `url` | string | Yes | `@IsUrl({ protocols:['http','https'], require_protocol:true })` | Absolute http(s) URL of the new `.zip` (SSRF-guarded download) |

```json
{ "url": "https://example.com/plugins/chat-flow-1.1.0.zip" }
```

**Response** `201` — the updated `PluginDto`.

**Errors:** `400` download/package invalid, manifest id mismatch, or built-in plugin · `401` · `403` · `404` unknown id

---

#### DELETE /api/plugins/:id

Uninstall a plugin and delete its files. Built-in plugins are protected.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `id` | string | Plugin id |

**Response** `200`

```json
{ "success": true, "message": "Plugin uninstalled successfully" }
```

Note: this DELETE returns `200` with a body (not the usual `204`).

**Errors:** `400` cannot uninstall (e.g. built-in) · `401` · `403` · `404` unknown id

---

#### POST /mcp

MCP Streamable-HTTP / JSON-RPC 2.0 transport that exposes the agent-tool registry over the Model Context Protocol. **This is a transport, not a REST resource** — there is no NestJS controller, no DTO, and no `{success,data}` shape.

**Auth:** API key — sent as `X-Api-Key: <key>` **or** `Authorization: Bearer <key>`. Auth is enforced **per tool call** inside the MCP layer (not by the global Nest guard), so an auth failure surfaces in-band, not as an HTTP `401`.

Key facts:
- **Path is exactly `POST /mcp` — no `/api` prefix.** The global `api` prefix applies only to Nest controllers; this route is mounted straight on Express.
- Gated by **`MCP_ENABLED=true`**. When off, the module/route is never mounted and `POST /mcp` returns `404`.
- `MCP_READONLY=true` registers only read-tier tools. Per-key sliding-window rate limit: `MCP_RATE_LIMIT_MAX` (default 60) per `MCP_RATE_LIMIT_WINDOW_MS` (default 60000).
- Stateless transport (no SSE/session id for normal calls).

**Request body** — JSON-RPC 2.0 envelope (validated by the MCP SDK, **not** the Nest ValidationPipe)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `jsonrpc` | string | Yes | Must be `"2.0"` |
| `id` | string \| number \| null | No | Request id echoed back; null/absent for notifications |
| `method` | string | Yes | `initialize`, `tools/list`, `tools/call`, plus MCP lifecycle methods. Unknown → JSON-RPC error `-32601` |
| `params` | object | No | Method-specific. For `tools/call`: `{ name, arguments }` where `arguments` must match the tool's zod `inputSchema` |

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "session_send_text", "arguments": { "sessionId": "default", "to": "6281234567890", "text": "Hello from MCP" } } }
```

**Response** `200` — JSON-RPC 2.0 envelope

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": { "content": [ { "type": "text", "text": "{\"success\":true,\"messageId\":\"…\"}" } ] }
}
```

For `tools/call` the result is an MCP `CallToolResult` (`content` array of `text` or embedded base64 `resource` items — payloads over 4096 bytes become a `resource`). **Tool-level failures are returned in-band as `CallToolResult` with `isError:true`** (HTTP stays 200), including missing/invalid API key (`name:'UnauthorizedException'`) and rate-limit hits (`message:'MCP rate limit exceeded'`).

**Errors:** in-band JSON-RPC errors `-32601` (unknown method), `-32602` (invalid params / unknown tool), `-32700` (parse error), all at HTTP 200 · `500` only if the transport throws before headers are sent · `404` when `MCP_ENABLED` is not `true`

> The full catalog of MCP tools (names, tiers, schemas) is documented separately — see **doc 24, MCP Integration**. This section documents only the transport endpoint.

## 6.5 Real-time API (WebSocket)

Live events are delivered over a **Socket.IO** connection (not a raw WebSocket). The server mounts a single Socket.IO namespace, **`/events`**, on the same port as the REST API. There are no REST routes in this module.

### Connecting

Point a Socket.IO client at `<host>:2785` with path-less namespace `/events`:

```
ws://<host>:2785/events      (or wss:// behind TLS)
```

The client must authenticate during the Socket.IO handshake. Three sources are accepted, in this precedence order:

1. **Handshake `auth` (recommended)** — `io(url, { auth: { apiKey } })`. Not written to URLs or access logs.
2. **Header** — `x-api-key: <key>`.
3. **Query param (deprecated fallback)** — `?apiKey=<key>`. The key leaks into access logs; avoid in production.

If no key is supplied, or validation fails, the server emits an `error` message (`code: "UNAUTHORIZED"`) on the `message` event and immediately disconnects the socket. CORS for the namespace reuses the HTTP `CORS_ORIGINS` policy (dev allows any origin; production uses the allowlist).

### Protocol — client → server

All client commands are sent on the Socket.IO event named **`message`** using a single **flat** envelope:

```
{ type, sessionId, events, requestId }
```

| Field | Type | Applies to | Description |
| --- | --- | --- | --- |
| `type` | `"subscribe" \| "unsubscribe" \| "ping"` | all | Command discriminator. |
| `sessionId` | string | subscribe, unsubscribe | A session id, or `"*"` for all sessions. |
| `events` | string[] | subscribe | Event names to subscribe to, or `["*"]` for all. |
| `requestId` | string (optional) | all | Echoed back on the matching server reply for correlation. |

A `ping` carries only `{ type: "ping", requestId? }`.

### Protocol — server → client

All server replies and pushed events also arrive on the Socket.IO event named **`message`**.

Command acknowledgements are **flat** and include an ISO-8601 `timestamp`:

```json
{ "type": "subscribed", "sessionId": "main", "events": ["message.received", "session.status"], "requestId": "r1", "timestamp": "2026-06-25T10:00:00.000Z" }
```

```json
{ "type": "unsubscribed", "sessionId": "main", "requestId": "r2", "timestamp": "2026-06-25T10:00:01.000Z" }
```

```json
{ "type": "pong", "requestId": "r3", "timestamp": "2026-06-25T10:00:02.000Z" }
```

```json
{ "type": "error", "code": "FORBIDDEN_SESSION", "message": "API key is not authorized for this session", "requestId": "r1", "timestamp": "2026-06-25T10:00:00.000Z" }
```

Live events are pushed as a **nested** envelope (note: `data` is under `payload`, and there is no `requestId`):

```json
{
  "type": "event",
  "timestamp": "2026-06-25T10:00:05.000Z",
  "payload": {
    "event": "message.received",
    "sessionId": "main",
    "data": { "id": "ABCD1234", "from": "6281234567890@c.us", "body": "hi", "timestamp": 1750000000 }
  }
}
```

Error `code` values include `UNAUTHORIZED`, `INVALID_MESSAGE`, `INVALID_SESSION`, `INVALID_EVENTS`, and `FORBIDDEN_SESSION`.

### Subscribable events

`events` accepts the wildcard `"*"` (all of the below) or any of these exact names:

```
message.received
message.sent
message.ack
message.revoked
message.reaction
session.status
session.qr
session.authenticated
session.disconnected
```

A subscribe request whose `events` array contains no recognized name (after filtering) is rejected with `INVALID_EVENTS`. Unknown names mixed with valid ones are silently dropped; the `subscribed` reply echoes only the accepted events.

> **`group.*` events are NOT subscribable on the socket.** They have no engine emit source and are never delivered over Socket.IO (they remain reserved only on the webhook side).

### Wildcards and scoping

- **`sessionId: "*"`** subscribes to every session; **`events: ["*"]`** subscribes to every subscribable event. They combine (e.g. `"*"` + `["*"]` = every event of every session).
- The API key is **re-validated on every `subscribe`** (not just at connect), so a key revoked or expired mid-connection is caught — the server replies `UNAUTHORIZED` and disconnects.
- **Per-key session scope is enforced** against the fresh key: a key restricted via `allowedSessions` may NOT subscribe to `"*"` and may NOT subscribe to a session outside its allowlist — either is rejected with `FORBIDDEN_SESSION`. An unrestricted key (no `allowedSessions`) may subscribe to anything, including `"*"`.

### Example (socket.io-client)

```js
import { io } from 'socket.io-client';

const socket = io('ws://localhost:2785/events', {
  auth: { apiKey: process.env.OPENWA_API_KEY },
});

socket.on('connect', () => {
  socket.emit('message', {
    type: 'subscribe',
    sessionId: 'main',
    events: ['message.received', 'message.ack', 'session.status'],
    requestId: 'sub-1',
  });
});

socket.on('message', (msg) => {
  if (msg.type === 'event') {
    console.log(`[${msg.payload.event}]`, msg.payload.sessionId, msg.payload.data);
  } else {
    console.log('reply:', msg); // subscribed | unsubscribed | pong | error
  }
});
```

## 6.6 Webhook Events & Delivery Semantics

Every registered webhook receives an HTTP `POST` with a JSON body of this shape:

```json
{
  "event": "message.received",
  "timestamp": "2026-02-02T10:00:00.000Z",
  "sessionId": "my-session",
  "idempotencyKey": "msg_my-session_3EB0ABC123",
  "deliveryId": "dlv_550e8400-e29b-41d4-a716-446655440000",
  "data": { }
}
```

`event`, `timestamp` (ISO-8601 dispatch time), `sessionId`, `idempotencyKey`, and `deliveryId` are always present; `data` holds the event-specific payload. The same values are mirrored into request headers (below). The HMAC `signature` is **not** in the body — it travels in the `X-OpenWA-Signature` header.

### Event catalog

These are the events OpenWA actually emits. A webhook is registered with an `events` list; an event is delivered to a webhook when its `events` array includes the event name or `"*"`.

| Event | When it fires | `data` payload sketch |
| --- | --- | --- |
| `message.received` | An inbound message arrives | The full message object: `id`, `from`, `to`, `body`, `type`, `timestamp` (epoch **seconds**), `isGroup`, `hasMedia`, `contact{…}` (plus optional `senderPhone` for `@lid` senders) |
| `message.sent` | An outbound message is created/sent from this session | Same message object shape as `message.received` |
| `message.ack` | A delivery/read receipt updates an outbound message | `{ id, messageId, status, ack }` — `status` is the canonical state (`pending`/`sent`/`delivered`/`read`/`failed`); `ack` is the deprecated legacy integer derived from it |
| `message.failed` | A receipt resolves to `failed` (dispatched in addition to `message.ack`) | `{ id, messageId, status: "failed", ack: -1 }` |
| `message.revoked` | A message is deleted/recalled | `{ id, revokedId?, chatId, from, to, type: "revoked", body: "", timestamp }` — **reconcile on `revokedId`** (the original deleted message's id), falling back to `id`. On whatsapp-web.js `id` is the *revocation notification* (a distinct message that won't match a stored id) and `revokedId` may be absent when the original isn't cached locally; on Baileys the two coincide |
| `message.reaction` | A reaction is added, changed, or removed | `{ messageId, chatId, reaction, senderId, reactions }` — `reactions` is the post-apply `{ senderId: emoji }` snapshot; `reaction` is empty when removed |
| `session.qr` | A new pairing QR is generated | `{ sessionId, qr }` (raw QR string) |
| `session.authenticated` | The session pairs and becomes ready | `{ sessionId, phone, pushName }` |
| `session.disconnected` | The session disconnects | `{ sessionId, reason }` |
| `session.status` | The session status transitions | `{ sessionId, status }` where `status` is one of `created` / `initializing` / `qr_ready` / `authenticating` / `ready` / `disconnected` / `failed` |

> **`STORE_EPHEMERAL_MESSAGES=false` affects `message.received`.** When `STORE_EPHEMERAL_MESSAGES` is set to `false`, incoming disappearing messages (those with `ephemeralDuration > 0`) are **not** persisted nor dispatched — no DB insert, no webhook delivery, and no websocket event. Downstream consumers and the dashboard both stop seeing them. Default is `true` (backward compatible — store and dispatch everything).

> **Reserved but not emitted.** `group.join`, `group.leave`, and `group.update` are accepted in a webhook's `events` list (and have reserved idempotency-key formats), but **no code path currently emits them** — registering for them is harmless but they will never be delivered. Likewise there is **no** `contact.update` or `presence.update` event.

### Delivery semantics — at-least-once

Webhook delivery is **at-least-once**. A consumer can legitimately receive the same logical event more than once because:

- The underlying WhatsApp engine can re-fire an event for a single message.
- A failed delivery (non-2xx response, timeout, or network error) is retried.

**Design your handler to be idempotent**, keyed on the `X-OpenWA-Idempotency-Key` header (see below). As a server-side safety net, OpenWA de-duplicates inbound `message.received` before dispatch (a re-fired event for an already-persisted message is dropped), so one webhook normally sees each inbound message once — but this is best-effort defense-in-depth and does not remove the need for consumer-side idempotency.

### HMAC signature

When a webhook is registered with a `secret`, each delivery carries:

```
X-OpenWA-Signature: sha256=<hex>
```

The hex is an HMAC-SHA256 computed over the **raw JSON request body** (exactly the bytes sent) using the webhook's `secret`. Verify by recomputing over the raw body — not over a re-serialized parse — and compare in constant time:

```javascript
const crypto = require('crypto');

function verify(rawBody, header, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

If no `secret` is configured the `X-OpenWA-Signature` header is omitted entirely.

### Idempotency & delivery headers

Every delivery includes:

| Header | Meaning |
| --- | --- |
| `X-OpenWA-Event` | The event name (mirrors `event`) |
| `X-OpenWA-Idempotency-Key` | Content-derived key; **stable across retries** of the same occurrence — dedupe on this |
| `X-OpenWA-Delivery-Id` | A fresh `dlv_<uuid>` generated **per delivery** (differs per retry and per webhook) — for tracing, not dedup |
| `X-OpenWA-Retry-Count` | Retry attempt number (`0` = first attempt) |
| `X-OpenWA-Signature` | HMAC (only when a secret is set) |

**Idempotency key derivation.** The key is content-derived so duplicates of the same logical event collapse to one value:

- `message.received` / `message.sent`: `msg_{sessionId}_{messageId}`
- `message.ack`: `ack_{sessionId}_{messageId}_{status}`
- `message.failed`: `failed_{sessionId}_{messageId}_{status}`
- `message.revoked`: `rev_{sessionId}_{messageId}`
- `message.reaction`: `react_{sessionId}_{messageId}_{senderId}_{occurredAt}`
- `session.qr`: `qr_{sessionId}_{hash(qr)}`
- `session.status`: `sess_{sessionId}_{status}_{occurredAt}`
- `session.authenticated`: `auth_{sessionId}_{hash(data)}_{occurredAt}`
- `session.disconnected`: `disc_{sessionId}_{hash(reason)}_{occurredAt}`

Recurring lifecycle events (and `message.reaction`) carry the same content across occurrences — the same phone on every reconnect, a constant disconnect reason, a re-applied emoji — so they are salted with an `occurredAt` timestamp captured **once per dispatch and reused across that dispatch's retries**. This gives distinct occurrences distinct keys while keeping retries of one occurrence stable. Message keys are scoped by `sessionId` because WhatsApp message ids are unique per account, not globally.

### Retries with exponential backoff

When the queue is enabled, a non-2xx response, timeout (`WEBHOOK_TIMEOUT`, default `10000` ms), or network error schedules a retry. The number of attempts comes from the webhook's `retryCount` (default `3`) and the delay grows **exponentially** from a base of `WEBHOOK_RETRY_DELAY` (default `5000` ms). Each retry reuses the same `idempotencyKey` and increments `X-OpenWA-Retry-Count`. If Redis/BullMQ rejects the initial enqueue, OpenWA logs a `webhook:error` hook event and falls back to direct delivery with the same inline retry budget. When the queue is disabled, delivery is direct with the same retry budget applied inline.

### SSRF guard on registration

Webhook URLs are validated at **registration time**, not just at delivery. When SSRF protection is enabled (the default), creating or updating a webhook with a URL that resolves to a private/internal/loopback address is rejected synchronously with `400 Bad Request` instead of failing silently later at delivery. The `SSRF_ALLOWED_HOSTS` escape-hatch applies equally to registration and delivery. Operator-supplied custom headers that target reserved names (`Content-Type` or any `X-OpenWA-*`) are stripped, so a webhook config cannot forge the signature, event, or idempotency headers.

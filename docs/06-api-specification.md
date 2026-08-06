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

> **Auth is header-only (never in a URL).** A query-parameter API key is **not** accepted anywhere. REST routes take the key via the `X-API-Key` header; the WebSocket (Socket.IO) handshake — see §6.5 Real-time API — accepts it via the handshake `auth.apiKey` field or the `X-API-Key` header. The former `?apiKey=` query fallback was **removed** (it leaked the credential into proxy/access logs). Never put the key in a URL.

The metrics endpoint is the lone exception to the API-key scheme: it authenticates with `Authorization: Bearer <METRICS_TOKEN>` instead of `X-API-Key`.

### Common Headers

```http
X-API-Key: owa_k1_your-api-key      # required on every non-public REST route
Content-Type: application/json       # required on requests with a JSON body
```

`Content-Type: application/json` is only needed when sending a body. There is no required `Accept` or `X-Request-ID` header.

### Roles & Authorization

API keys carry one of three roles, ordered by privilege:

| Role       | Rank | Can do                                                                                                                               |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `viewer`   | 1    | Read-only routes (no `@RequireRole`, or routes that only need a valid key)                                                           |
| `operator` | 2    | Everything a viewer can, plus write/action routes guarded by `@RequireRole(OPERATOR)` (send messages, group/contact mutations, etc.) |
| `admin`    | 3    | Everything, plus admin-only routes guarded by `@RequireRole(ADMIN)` (API-key management, settings)                                   |

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

Session `status` wire values are **lowercase**: `created | initializing | qr_ready | authenticating | ready | disconnected | action_required | failed`.

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

| HTTP Status | Meaning               | When                                                                                                                                                                                                                    |
| ----------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`       | Bad Request           | DTO validation failed, unknown body field, or a business precondition not met (e.g. session not active, media over cap)                                                                                                 |
| `401`       | Unauthorized          | Missing/invalid/expired/revoked `X-API-Key` (or `METRICS_TOKEN` for metrics), a blocked source IP, or a key used outside its `allowedSessions` scope                                                                    |
| `403`       | Forbidden             | A valid, in-scope key whose **role** is below the route's `@RequireRole` requirement                                                                                                                                    |
| `404`       | Not Found             | The addressed resource (session, message, webhook, batch, …) does not exist                                                                                                                                             |
| `409`       | Conflict              | A uniqueness constraint was violated (e.g. duplicate name), or a credential teardown for the same session name is still in flight on `start`/`delete` (retryable; body carries `code: 'SESSION_NAME_TEARDOWN_PENDING'`) |
| `413`       | Payload Too Large     | Base64 media exceeds the media byte cap (see §6.3)                                                                                                                                                                      |
| `415`       | Unsupported Media     | The request has a body carrying a `Content-Encoding` other than `identity`; compressed request bodies are not accepted, as the aggregate body cap counts wire bytes                                                     |
| `500`       | Internal Server Error | Send failed at the WhatsApp engine or an unexpected server error                                                                                                                                                        |

### Timestamp Conventions

OpenWA uses **two** timestamp representations — be careful which a field is:

- **Message timestamps are epoch numbers (Unix seconds), not ISO strings.** This applies to the `timestamp` field on messages returned by send responses, history, and persisted message records (the persisted column is stored as a bigint and surfaced as a `number`).
- **Entity audit fields use ISO-8601 UTC strings** (example: `2026-02-02T10:00:00.000Z`). This applies to `createdAt` / `updatedAt` on persisted entities, `expiresAt`, batch `startedAt` / `completedAt`, and similar metadata fields.

## 6.3 Media Specifications

### Media DTO (flat shape)

All media send routes (`send-image`, `send-video`, `send-audio`, `send-document`, `send-sticker`) share one **flat** request DTO — `SendMediaMessageDto`. There is **no** nested `{ image: { url } }` wrapper; the media source fields sit at the top level of the body:

| Field      | Type     | Required    | Constraints                                         | Description                                                                                      |
| ---------- | -------- | ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `chatId`   | string   | yes         | non-empty                                           | Recipient — `<phone>@c.us` or `<groupId>@g.us`                                                   |
| `url`      | string   | conditional | valid http/https URL; required when `base64` absent | Remote media URL. Fetched server-side through an SSRF guard; a blocked/internal URL yields `400` |
| `base64`   | string   | conditional | required when `url` absent                          | Raw base64 media data. Decoded size is checked against the media cap                             |
| `mimetype` | string   | conditional | required when `base64` is used                      | MIME type, e.g. `image/jpeg`, `video/mp4`, `application/pdf`                                     |
| `filename` | string   | no          | max 255 chars                                       | Optional file name (also used as the persisted body fallback for documents)                      |
| `caption`  | string   | no          | max 1024 chars                                      | Optional caption (not persisted for audio)                                                       |
| `mentions` | string[] | no          | array of WIDs                                       | WIDs to @mention in the caption (e.g. `["62811@c.us"]`). See **Mentions** below                  |

Provide **exactly one** of `url` or `base64`. Omitting both, or supplying `base64` without `mimetype`, returns `400`.

A document sent without a `filename` is delivered under the default name `file` — on the whatsapp-web.js engine, a URL-based send first derives the URL basename before that fallback applies.

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

### Send response: `201` means accepted, not delivered

Single-recipient send routes under `/messages` return **HTTP 201** with `{ "messageId", "timestamp" }` as soon as the gateway hands the message to the WhatsApp client. This confirms the send was _accepted_ — it does **not** confirm the recipient received it. Two routes differ: `POST send-bulk` returns **202** with a batch envelope (`{ batchId, status, totalMessages, … }`), and the `status/send-*` routes return **201** with `{ statusId, timestamp, expiresAt }` — a `statusId`, not a `messageId`, and an ISO timestamp rather than epoch seconds.

Two consequences worth knowing:

1. **WhatsApp does not reject an unregistered recipient synchronously.** A message to a number that is not on WhatsApp still returns `201` with a valid `messageId`. Whether it later delivers, stalls, or is reported as an error reaches you asynchronously, if at all.
2. **There is no synchronous delivery confirmation on either engine** (whatsapp-web.js or Baileys), so the `201` cannot be made to mean "delivered."

**Before sending to a new number**, you can confirm it is a registered WhatsApp account with `GET /api/sessions/:sessionId/contacts/check/:number` (returns `{ exists, whatsappId }`; see the Contacts reference).

**For real delivery state**, track the stored message's `status`, which advances asynchronously as WhatsApp sends acks: `sent → delivered → read`, or `failed` when WhatsApp reports an error for the message — which also dispatches a `message.failed` webhook. See the message shape under the Messages reference.

A message resting at `sent` is **not** diagnostic on its own. It means no ack has advanced it yet, and a registered recipient whose device has not come online since the send stays at `sent` indefinitely too — that is the designed behavior, not a fault. Use `contacts/check` to tell an unregistered number apart from a registered one that simply has not received yet.

## 6.4 REST API Reference

Every path below is prefixed with `/api`. Unless marked **public**, send `X-API-Key: <key>`; `OPERATOR`/`ADMIN` annotations require a key of at least that role. Responses are the raw payload (no envelope); list endpoints return a bare array.

### 6.4.1 Sessions

Base path `/api/sessions`. All routes that return a session return data shaped by `SessionResponseDto.fromEntity` (via `transformSession`), which **strips** `config`, `proxyUrl`, and `proxyType` and renames the entity field `lastActiveAt` to `lastActive`. Session `status` wire values are lowercase: `created | initializing | qr_ready | authenticating | ready | disconnected | action_required | failed`.

#### GET /api/sessions

List all sessions, scoped to the API key's `allowedSessions`, ordered `createdAt` DESC.

**Auth:** API key · **Scope:** session-scoped (a scoped key sees only its `allowedSessions`; an ADMIN / null-allowlist key lists all)

**Query parameters**

| Name     | Type             | Required | Default | Description                                                                                     |
| -------- | ---------------- | -------- | ------- | ----------------------------------------------------------------------------------------------- |
| `limit`  | integer (1-1000) | No       | `1000`  | Max sessions to return; oversized/non-finite values are clamped/fallback to the default window. |
| `offset` | integer          | No       | `0`     | Sessions to skip for paging; negative/non-finite values resolve to `0`.                         |

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
    "lastError": null,
    "restriction": null,
    "engineLoaded": true
  }
]
```

`lastError` is non-null only when `status` is `failed` or `action_required`; any other status clears it. `config`/`proxyUrl`/`proxyType` are not present (stripped by `fromEntity`).

`restriction` reports a limit **WhatsApp itself** has placed on the account, as opposed to `lastError`, which describes a fault on the gateway's side of the link. It is `null` when there is none, and otherwise `{ kind, code, expiresAt }`:

| `kind`              | Meaning                                                                                                                                                                                   | Engine          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `reachout_timelock` | The account stays connected and existing chats keep working; WhatsApp blocks only the **start of new conversations**. `expiresAt` carries the end of enforcement when WhatsApp states it. | Baileys         |
| `tos_block`         | WhatsApp Web refuses the link on Terms-of-Service grounds (`TOS_BLOCK`, or `SMB_TOS_BLOCK` for a business account).                                                                       | whatsapp-web.js |
| `proxy_block`       | WhatsApp Web refuses the egress address the session connects from (`PROXYBLOCK`) — about the route, not the account.                                                                      | whatsapp-web.js |

`code` is the engine's own token for the cause, passed through verbatim (`TOS_BLOCK`, `BIZ_QUALITY`, `WEB_COMPANION_ONLY`, …), so a value newer than your gateway build still reaches you rather than being flattened. Because `tos_block`/`proxy_block` prevent the session from linking at all, neither can appear alongside a `ready` status; a `reachout_timelock` can, and usually does. Like `engineLoaded`, the field is derived from live engine state, never persisted, and re-established on the next connect. Changes are also delivered as the `session.restriction` webhook.

`engineLoaded` reports whether the gateway holds a live engine for the session at the moment of the response. It is the precondition the lifecycle routes enforce, and **`status` is not a substitute for it**: `disconnected` covers both a session whose engine is still registered while an automatic reconnect backs off — where `POST /start` answers `400` — and one stopped through `POST /stop`, which has no engine and does need a start. When `engineLoaded` is `true`, `stop`, `logout` and `force-kill` can act; when it is `false`, `start` is the applicable route. The field is derived per request from live process state, so it is never persisted and never appears in historical/exported data.

**Errors:** `401` missing/invalid `X-API-Key`

#### GET /api/sessions/:id

Get a single session by ID.

**Auth:** API key · **Scope:** session-scoped (key's `allowedSessions` enforced against `:id`)

**Path parameters**

| Name | Type   | Description           |
| ---- | ------ | --------------------- |
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
  "lastError": null,
  "engineLoaded": true
}
```

**Errors:** `401` missing/invalid key, or key not scoped to this session · `404` session not found

#### GET /api/sessions/:id/qr

Get the QR code (PNG data URL) for session authentication.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
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

**Auth:** API key · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Query parameters**

| Name     | Type             | Required | Default | Description                         |
| -------- | ---------------- | -------- | ------- | ----------------------------------- |
| `limit`  | integer (1–1000) | No       | `1000`  | Max groups to return                |
| `offset` | integer          | No       | `0`     | Number of groups to skip for paging |

**Response** `200`

```json
[{ "id": "1234567890-123@g.us", "name": "Project Team", "linkedParentJID": null }]
```

Bare array mapped from the engine's group list then paginated. `linkedParentJID` is present for community-linked groups.

**Errors:** `400` session not started (engine not in memory) · `401` · `403` · `404` session not found

#### GET /api/sessions/:id/chats

Get active chats for a session, most-recent first (paginated).

**Auth:** API key · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Query parameters**

| Name     | Type             | Required | Default | Description              |
| -------- | ---------------- | -------- | ------- | ------------------------ |
| `limit`  | integer (1–1000) | No       | `1000`  | Max chats to return      |
| `offset` | integer          | No       | `0`     | Chats to skip for paging |

**Response** `200` — `ChatSummary[]`

```json
[
  {
    "id": "6281234567890@c.us",
    "name": "Alice",
    "isGroup": false,
    "kind": "individual",
    "unreadCount": 2,
    "timestamp": 1719306115,
    "lastMessage": "See you tomorrow"
  }
]
```

Sorted by `timestamp` DESC (most recent first) then paginated. `timestamp` is an epoch number (seconds). `kind` is the user-facing chat discriminator — one of `individual|group|channel|status|broadcast|unknown`; `isGroup` is retained for back-compat (true only for `kind: "group"`).

**Errors:** `400` session not started · `401` · `403` · `404` session not found

#### GET /api/sessions/stats/overview

Get session statistics for multi-session monitoring.

**Auth:** API key · **Scope:** session-scoped (aggregate counts limited to the key's `allowedSessions`)

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

**Auth:** API key (OPERATOR) that is not restricted to specific sessions. Creating a session is a deployment-level act: the new session is outside the caller's `allowedSessions` by construction, so a session-scoped key is rejected with `403` (`@RequireUnscopedKey`). An unscoped OPERATOR/ADMIN key may create a session.

**Request body** — `CreateSessionDto`

| Field       | Type                                      | Required | Constraints                                                                                                                                              | Description                                                                                                                                                                                                                                                                                                        |
| ----------- | ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`      | string                                    | Yes      | `@IsString`; length 3–50; `@Matches(/^[a-zA-Z0-9-]+$/)` (letters, numbers, hyphens only)                                                                 | Unique session name; duplicate → `409`                                                                                                                                                                                                                                                                             |
| `config`    | object                                    | No       | `@IsOptional` (arbitrary object, no shape validation)                                                                                                    | Opaque engine config; defaults to `{}`; never returned in responses                                                                                                                                                                                                                                                |
| `proxyUrl`  | string                                    | No       | `@IsOptional`; `@IsString`; max 255; `@IsUrl` (protocols `http`/`https`/`socks4`/`socks5`, `require_protocol`, `require_tld:false`, `allow_underscores`) | Per-session proxy egress; credentialed `http://user:pass@host` and single-label hosts allowed; not SSRF-blocked. ⚠ **Must be a real, reachable proxy** — an unreachable value silently blocks the WhatsApp WebSocket (no QR, start → `504`); leave unset unless you need it. See "Per-session egress proxy" below. |
| `proxyType` | `http` \| `https` \| `socks4` \| `socks5` | No       | `@IsOptional`; `@IsIn([...])`                                                                                                                            | Proxy protocol                                                                                                                                                                                                                                                                                                     |

```json
{
  "name": "my-bot",
  "config": { "autoReconnect": true }
}
```

Minimal: `{ "name": "my-bot" }`.

**Optional — per-session egress proxy.** Route a session's traffic through a proxy only if your
network cannot reach WhatsApp directly. Set `proxyUrl`/`proxyType` on the same request:

```json
{
  "name": "my-bot",
  "proxyUrl": "http://user:pass@your-real-proxy.host:8080",
  "proxyType": "http"
}
```

> ⚠ `proxyUrl` **must point at a real, reachable proxy server.** A placeholder or unreachable value
> (e.g. `http://proxy.example.com:8080`) launches the engine pinned to a dead proxy, so the WhatsApp
> WebSocket never connects, **no QR code is ever delivered**, and `POST /api/sessions/:id/start`
> returns `504 Gateway Timeout` after ~30s. Leave `proxyUrl` unset unless you genuinely need a proxy.

**Response** `201`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "created",
  "phone": null,
  "pushName": null,
  "connectedAt": null,
  "lastActive": null,
  "createdAt": "2026-06-25T09:00:00.000Z",
  "updatedAt": "2026-06-25T09:00:00.000Z",
  "lastError": null,
  "engineLoaded": false
}
```

Like every other session route, this returns the `SessionResponseDto` shape (via `fromEntity`), so `config`/`proxyUrl`/`proxyType` are stripped and `lastActiveAt` appears as `lastActive`. Newly created `status` is `created`.

**Errors:** `400` validation (bad `name`/`proxyUrl`/`proxyType`, or an extra non-whitelisted field) · `401` · `403` key lacks OPERATOR role · `409` session name already exists

#### POST /api/sessions/:id/start

Start a session and initialize the WhatsApp connection.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

No request body.

**Response** `200`

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
  "lastError": null,
  "engineLoaded": true
}
```

Returned via `transformSession`. Status typically transitions to `initializing` / `qr_ready`.

**Errors:** `400` session already started / already starting · `401` · `403` · `404` not found · `409` credential teardown for the same session name still in flight (retryable; body carries `code: 'SESSION_NAME_TEARDOWN_PENDING'`; no destructive side effect runs before the refusal — a retry after cleanup settles proceeds)

#### POST /api/sessions/:id/stop

Stop a session and disconnect WhatsApp.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

No request body.

**Response** `200`

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
  "lastError": null,
  "engineLoaded": false
}
```

Returned via `transformSession`; status typically becomes `disconnected`.

**Errors:** `401` · `403` · `404` not found

#### POST /api/sessions/:id/logout

Attempt an engine-native unlink of this companion device, then tear the session down locally.

`stop` disconnects while keeping the stored credentials, and `delete` additionally purges the
on-disk auth directories and the session row, but neither tells WhatsApp anything: the device stays
listed under the account holder's **Linked Devices** on the phone until they remove it by hand.
`logout` attempts the engine-native unlink operation itself.

A `200` means the engine-native unlink operation **and** the required local credential cleanup both
completed — for Baileys, a valid companion identity, an acknowledged `remove-companion-device` IQ
response, and removal of the on-disk auth dir; for whatsapp-web.js, the native `Client.logout()`
promise (including `LocalAuth.logout()`) settled. `200` is **not** an independent observation that
the handset UI no longer shows the linked device — only the linked device itself can observe that,
and callers must not claim otherwise. Because a completed unlink wipes the stored credentials, a
later `start` always requires a fresh QR scan or pairing code.

The session must be running — the unlink is a network round-trip that needs a live engine, so a
stopped session is rejected with `400` (the row is left untouched) rather than reported as a success
that never reached WhatsApp.

If the engine-backed logout attempt does not complete, the session is still torn down locally
(map reconciled, status `disconnected`) but the route returns `502` with a stable
`code: 'SESSION_LOGOUT_INCOMPLETE'`: no send / no acknowledgement / timeout or transport error / or
a local-cleanup failure. `phone` is cleared on this path and **no** `session_logged_out` audit row
is written (that audit is only written on the `200` path). Start the session again and retry the
logout. Do not assume the retry reconnects automatically or lands in a guaranteed QR state — whether
the old credentials remain usable depends on where the failure happened, and the route does not
report which.

With `AUTO_START_SESSIONS=true`, auto-start selects sessions whose `phone` is non-null. Both a `200`
and a `502` logout clear `phone`, so neither is auto-started on boot — an incomplete-logout (`502`)
session must be started explicitly and the logout retried by hand. A session that must stay down can
simply be left as-is.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

No request body.

**Response** `200`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "disconnected",
  "phone": null,
  "pushName": null,
  "connectedAt": null,
  "lastActive": "2026-06-25T09:01:55.000Z",
  "createdAt": "2026-06-20T11:30:00.000Z",
  "updatedAt": "2026-06-25T09:11:00.000Z",
  "lastError": null,
  "engineLoaded": false
}
```

Returned via `transformSession`; status becomes `disconnected` and `phone` is cleared (so the boot
auto-start does not resurrect the session). Recorded in the audit log as `session_logged_out`,
distinguishing an intentional unlink from a plain stop.

**Errors:** `400` session is not started (no engine to send through; the row is left untouched) · `401` · `403` · `404` not found · `502` `SESSION_LOGOUT_INCOMPLETE` — session stopped locally but the logout operation did not complete (retryable; `phone` cleared, no success audit)

#### POST /api/sessions/:id/force-kill

Force-kill a stuck session (SIGKILL the wedged engine, then tear it down).

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

No request body.

**Response** `200`

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
  "lastError": null,
  "engineLoaded": false
}
```

Returned via `transformSession`.

**Errors:** `400` session is not started (no live engine to kill) · `401` · `403` · `404` not found

#### POST /api/sessions/:id/pairing-code

Request an 8-char pairing code to link via phone number (alternative to QR).

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Request body** — `RequestPairingCodeDto`

| Field         | Type   | Required | Constraints                                                                                       | Description                                                      |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `phoneNumber` | string | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[0-9]{6,15}$/)` (digits only, 6–15, no `+`/spaces/dashes) | International format: country code + number, e.g. `628123456789` |

```json
{ "phoneNumber": "628123456789" }
```

**Response** `201` — `PairingCodeResponseDto`

```json
{ "pairingCode": "ABCD1234", "status": "qr_ready" }
```

`status` is the lowercase session status.

**Errors:** `400` validation, or session not started, or already authenticated · `401` · `403` · `404` not found

#### POST /api/sessions/:id/presence/subscribe

Ask WhatsApp to start reporting who is online or typing in a chat.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped · **Engines:** Baileys only

There is no synchronous answer: presence cannot be _fetched_ from either engine, only received.
Updates arrive as the `presence.update` webhook and socket event; the latest is readable at
`GET /api/sessions/:id/presence/:chatId`.

Two properties to design around:

- **The subscription belongs to the connection.** It does not survive a restart or an automatic
  reconnect, and must be re-issued. The gateway does not silently replay subscriptions, because a
  replay would report a presence the account never actually asked for.
- **Subscribe per chat, not to everything.** WhatsApp emits an update on every transition — each time
  someone starts and stops typing — so a broad subscription is a firehose. Only genuine state
  _changes_ are dispatched onward, which bounds the event volume but not the socket traffic.

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Request body** — `SubscribePresenceDto`

| Field    | Type   | Required | Constraints                                                                                 | Description                                                                           |
| -------- | ------ | -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `chatId` | string | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace) | Engine-native JID, e.g. `1234567890@c.us` (wwebjs) or `1234@s.whatsapp.net` (Baileys) |

**Response** `200`

```json
{ "success": true }
```

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found · `501` the active engine cannot observe presence (whatsapp-web.js exposes only `sendPresenceAvailable`/`sendPresenceUnavailable`, which publish the account's _own_ presence, and emits no presence event)

#### GET /api/sessions/:id/presence/:chatId

The last presence reported for a chat.

**Auth:** API key (VIEWER) · **Scope:** session-scoped

**Response** `200`

```json
{
  "chatId": "1234567890@c.us",
  "participants": [{ "id": "1234567890@c.us", "state": "composing", "lastSeen": 1786000000 }],
  "observedAt": "2026-08-03T12:00:00.000Z"
}
```

`state` is one of `available` / `unavailable` / `composing` / `recording` / `paused` — the middle two
mean actively typing or recording _in this chat_, `paused` means they stopped without sending.
`lastSeen` is epoch **seconds** and is absent whenever the contact's privacy settings hide last-seen,
which is the default for most accounts and is not an error. `groupOnlineCount` appears for groups
when WhatsApp reports it. A 1:1 chat still returns a `participants` array, holding the one contact.

`observedAt` is when **this gateway** received the report, not a WhatsApp timestamp. Presence is
short-lived, so an old `observedAt` means the state is stale rather than steady.

The body is `null` when nothing has been reported — the chat was never subscribed, or nothing has
changed since. That is a normal state rather than a missing resource, so it is `200` with a null
body, not a `404`. Presence is held in memory and never persisted: answering "typing" from before a
restart would be worse than answering nothing.

**Errors:** `401` · `403` · `404` session not found

#### POST /api/sessions/:id/chats/read

Mark a chat as read/seen.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Request body** — `MarkChatReadDto`

| Field    | Type   | Required | Constraints                                                                                 | Description                                                                           |
| -------- | ------ | -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `chatId` | string | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace) | Engine-native JID, e.g. `1234567890@c.us` (wwebjs) or `1234@s.whatsapp.net` (Baileys) |

```json
{ "chatId": "1234567890@c.us" }
```

**Response** `200`

```json
{ "success": true }
```

Returns HTTP `200`, matching the OpenAPI contract.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found

#### POST /api/sessions/:id/chats/unread

Mark a chat as unread.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Request body** — `MarkChatReadDto` (reused)

| Field    | Type   | Required | Constraints                                                 | Description                               |
| -------- | ------ | -------- | ----------------------------------------------------------- | ----------------------------------------- |
| `chatId` | string | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` | Engine-native JID, e.g. `1234567890@c.us` |

```json
{ "chatId": "1234567890@c.us" }
```

**Response** `200`

```json
{ "success": true }
```

Returns HTTP `200`, matching the OpenAPI contract.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found

#### DELETE /api/sessions/:id/chats/:chatId/messages

Delete every message in a chat, keeping the chat itself in the list.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name     | Type   | Description                                                                           |
| -------- | ------ | ------------------------------------------------------------------------------------- |
| `id`     | string | Session UUID                                                                          |
| `chatId` | string | Engine-native JID, e.g. `1234567890-123@g.us`. URL-encode it if your client does not. |

**Response** `200`

```json
{ "success": true }
```

> **`success: false` is a real outcome**, as with `chats/archive`: an unknown chat on
> whatsapp-web.js, or on Baileys a chat with no known history — the clear is an app-state
> modification keyed to the chat's last message.

**Errors:** `400` session not ready · `401` missing/invalid API key · `404` session not found

#### POST /api/sessions/:id/chats/archive

Archive or unarchive a chat.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Request body** — `ArchiveChatDto`

| Field     | Type    | Required | Constraints                                                                                 | Description                                   |
| --------- | ------- | -------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `chatId`  | string  | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace) | Engine-native JID, e.g. `1234567890-123@g.us` |
| `archive` | boolean | Yes      | `@IsBoolean` (strict — the string `"false"` is rejected, not coerced to `true`)             | `true` to archive, `false` to unarchive       |

```json
{ "chatId": "1234567890-123@g.us", "archive": true }
```

**Response** `200`

```json
{ "success": true }
```

> **`success: false` is a real outcome here, not an error.** On the Baileys engine the archive is an
> app-state modification keyed to the chat's **last message**, so a chat with no known history
> cannot be archived at all — the same limitation `chats/delete` and `chats/unread` already carry on
> that engine. Rather than fail with a 500, the endpoint reports `success: false`.

> **No `chat.archived` webhook fires for your own archive.** Baileys emits no event for a change the
> account itself made (remote-device archives arrive later via chat-update diffing), and
> whatsapp-web.js's `chat_archived` event is not wired. Treat the HTTP response as the outcome.

**Errors:** `400` session not ready · `401` missing/invalid API key · `404` session not found

#### POST /api/sessions/:id/chats/delete

Delete a chat from the chat list (e.g. a group you have left).

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Request body** — `DeleteChatDto`

| Field    | Type   | Required | Constraints                                                                                 | Description                                   |
| -------- | ------ | -------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `chatId` | string | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace) | Engine-native JID, e.g. `1234567890-123@g.us` |

```json
{ "chatId": "1234567890-123@g.us" }
```

**Response** `200`

```json
{ "success": true }
```

Returns HTTP `200`, matching the OpenAPI contract.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found

#### POST /api/sessions/:id/chats/typing

Send a typing/recording presence indicator to a chat (or clear it with `paused`).

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Request body** — `SendChatStateDto`

| Field    | Type                                | Required | Constraints                                                                      | Description                                                 |
| -------- | ----------------------------------- | -------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `chatId` | string                              | Yes      | `@IsString`; `@IsNotEmpty` (no JID regex; engine-neutral, the adapter validates) | Engine-native chat id, e.g. `1234567890@c.us`               |
| `state`  | `typing` \| `recording` \| `paused` | Yes      | `@IsIn(['typing','recording','paused'])`                                         | `typing`/`recording` show the indicator; `paused` clears it |

```json
{ "chatId": "1234567890@c.us", "state": "typing" }
```

**Response** `200`

```json
{ "success": true }
```

Always returns `{ "success": true }` (the service returns void; the controller hardcodes `true`).

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found

#### DELETE /api/sessions/:id

Delete a session.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name | Type   | Description  |
| ---- | ------ | ------------ |
| `id` | string | Session UUID |

**Response** `204` — empty body (`@HttpCode(204)`, returns void). A `findOne` lookup runs first, so a missing id yields `404`.

**Errors:** `401` missing/invalid key, or key not scoped to this session · `403` key role below OPERATOR · `404` session not found · `409` credential teardown for the same session name still in flight (retryable; body carries `code: 'SESSION_NAME_TEARDOWN_PENDING'`; on a `409` the row is **not** deleted and no hook/auth-purge runs — retry after cleanup settles)

### 6.4.2 Messages

All routes are mounted under `/api/sessions/:sessionId/messages`. Reads (`GET` history, batch status, reactions) accept any valid API key (including VIEWER). All write/send routes require **API key (OPERATOR)** or higher. Single-recipient send routes return `MessageResponseDto { messageId, timestamp }` (`timestamp` is an epoch **number** in seconds; there is no `status` field); `POST send-bulk` instead returns `202` with `BulkMessageResponseDto`. The global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so any body field not listed below is rejected with `400`.

#### GET /api/sessions/:sessionId/messages

Get persisted message history for a session from the local DB (paginated, filterable). Reads the DB only — does not hit WhatsApp.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Query parameters**

| Name   | Type    | Required | Default | Description                                                                                       |
| ------ | ------- | -------- | ------- | ------------------------------------------------------------------------------------------------- |
| chatId | string  | No       | —       | Filter by chat ID. Matched across `@c.us` / `@s.whatsapp.net` dialects via the lid-mapping table. |
| from   | string  | No       | —       | Filter by sender. A phone also matches any lid that resolves to it.                               |
| limit  | integer | No       | 50      | Clamped to `[1,100]`; a non-finite value falls back to 50.                                        |
| offset | integer | No       | 0       | Clamped to `>=0`; a non-finite value falls back to 0.                                             |

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

Each `Message`: `{ id (uuid), sessionId, waMessageId (string|null), chatId, from, to, body (string|null), type, direction ('incoming'|'outgoing'), timestamp (number|null), metadata (object|null), status ('pending'|'sent'|'delivered'|'read'|'failed'), createdAt (ISO date) }`. Ordered by `createdAt` DESC. The response is the raw service object (no envelope). Unlike the live `IncomingMessage` shape below, this persisted `Message` does **not** carry `kind` — re-derive the chat kind from `chatId` (see `ChatKind` / `chatKind()`) if needed.

**Errors:** `401` missing/invalid API key

#### GET /api/sessions/:sessionId/messages/:chatId/history

Fetch chat history live from WhatsApp for a chat, bypassing the local DB.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                         |
| --------- | ------ | --------------------------------------------------- |
| sessionId | string | Session ID                                          |
| chatId    | string | Chat ID, e.g. `628123456789@c.us` or `groupId@g.us` |

**Query parameters**

| Name         | Type    | Required | Default | Description                                                                                                       |
| ------------ | ------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| limit        | integer | No       | 50      | Clamped to `[1,100]`; when `deep=true` the ceiling rises to 2000. Non-finite falls back to 50.                    |
| includeMedia | boolean | No       | false   | Truthy only for `true` or `1`. Downloads base64 media (slower). Forced OFF when `deep=true`.                      |
| deep         | boolean | No       | false   | Truthy only for `true` or `1`. Raises the limit ceiling 100→2000 (whatsapp-web.js only) and forces metadata-only. |

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
    "kind": "individual",
    "author": "628123456789@c.us",
    "senderPhone": "628123456789"
  }
]
```

Each item may also include `isStatusBroadcast`, `mentionedIds`, `isLidSender`, `contact`, `media { mimetype, filename?, data?, omitted?, sizeBytes? }`, `quotedMessage { id, body }`, `call { video, missed }` (for `call` messages), and `location { latitude, longitude, description?, address?, url? }`. `type` is one of `text|image|video|audio|voice|document|sticker|location|contact|call|revoked|masked|unknown`. A `masked` message is one WhatsApp deliberately withholds from linked/companion devices — e.g. a high-security business OTP — so its `body` is empty by design (the content is only available on the primary phone) rather than a parsing failure; this occurs on the Baileys engine. `kind` is the user-facing chat discriminator of `chatId` — one of `individual|group|channel|status|broadcast|unknown`; it supersedes `isStatusBroadcast` (equivalent to `kind === 'status'`), which is retained for back-compat.

**Errors:** `400` session not active · `401` missing/invalid API key · `500` engine error

#### GET /api/sessions/:sessionId/messages/:chatId/:messageId/reactions

Get reactions for a specific message, grouped by emoji with the senders.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                     |
| --------- | ------ | ------------------------------- |
| sessionId | string | Session ID                      |
| chatId    | string | Chat ID containing the message  |
| messageId | string | Message ID to get reactions for |

**Response** `200`

Returns a bare array of `MessageReaction`:

```json
[
  {
    "emoji": "👍",
    "senders": [{ "senderId": "628123456789@c.us", "emoji": "👍", "timestamp": 1719312050 }]
  }
]
```

**Errors:** `400` session not active · `401` missing/invalid API key · `500` engine error

#### POST /api/sessions/:sessionId/messages/vote-poll

Cast a vote on a poll.

**Auth:** API key (OPERATOR) · **Engines:** whatsapp-web.js only — Baileys returns `501`

**Body**

| Field         | Type     | Required | Description                                                                                                                       |
| ------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| chatId        | string   | yes      | Chat containing the poll                                                                                                          |
| pollMessageId | string   | yes      | The poll creation message                                                                                                         |
| options       | string[] | yes      | The option **texts** to select, exactly as they appear on the poll (max 12). Replaces the current selection; `[]` clears the vote |

**Response** `200` — `{ "success": true }`

> **Options are texts, not ids.** whatsapp-web.js matches poll options by name, and no engine
> surfaces a stable per-option id through this API, so the text is the only handle available. A poll
> with two identically-worded options will therefore select **both**.

> **Only recent polls can be voted on.** The poll must be within the 100-message window the engine
> fetches for the chat — the same limit that applies to react/delete/edit/pin. An older poll comes
> back `404`.

> **Baileys returns `501`.** The library exposes no vote-send helper at all — only `decryptPollVote`
> for _receiving_ votes. Sending one requires hand-building a `PollUpdateMessage` with HMAC-SHA256
> vote encryption keyed by the poll creation's `messageSecret`, which is not wired here.

**Errors:** `400` session not active, or the target message is not a poll · `401` missing/invalid API key · `403` key lacks OPERATOR role · `404` poll not found in recent history · `501` Baileys engine

#### POST /api/sessions/:sessionId/messages/pin

Pin a message in its chat for a bounded window.

**Auth:** API key (OPERATOR)

**Body**

| Field           | Type   | Required | Description                                                                                                                                   |
| --------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| chatId          | string | yes      | Chat containing the message                                                                                                                   |
| messageId       | string | yes      | Message to pin                                                                                                                                |
| durationSeconds | number | no       | `86400` (24h), `604800` (7d) or `2592000` (30d). Defaults to `86400`. Any other value is rejected with `400` — WhatsApp recognises no others. |

**Response** `200` — `{ "success": true }`

**Errors:** `400` session not active, or `durationSeconds` outside the three accepted values · `401` missing/invalid API key · `403` the engine refused the pin (in a group only admins may pin) · `404` message not found in the chat

> On whatsapp-web.js the message must be within the 100-message fetch window for the chat, the same
> limit that applies to react/delete/edit. On Baileys it must be in the adapter's message store.

#### POST /api/sessions/:sessionId/messages/star

Star (bookmark) a message, or remove its star. Starring is private to the account — the other party
never sees it — and unlike pinning it has no group-admin restriction and never expires.

**Auth:** API key (OPERATOR)

**Body**

| Field     | Type    | Required | Description                                |
| --------- | ------- | -------- | ------------------------------------------ |
| chatId    | string  | yes      | Chat containing the message                |
| messageId | string  | yes      | Message to star or unstar                  |
| star      | boolean | yes      | `true` to star, `false` to remove the star |

**Response** `200` — `{ "success": true }`

> **Best-effort on whatsapp-web.js.** Its `star()`/`unstar()` resolve with no value and silently do
> nothing when WhatsApp declines the message, so a `200` means the instruction was delivered, not
> that the star is definitely set. There is no signal at the engine boundary to distinguish the two.
> Baileys applies the change through an app-state modification and is exact.

**Errors:** `400` session not active · `401` missing/invalid API key · `404` message not found in the chat

#### POST /api/sessions/:sessionId/messages/unpin

Remove a message's pin. Takes no duration.

**Auth:** API key (OPERATOR)

**Body**

| Field     | Type   | Required | Description                 |
| --------- | ------ | -------- | --------------------------- |
| chatId    | string | yes      | Chat containing the message |
| messageId | string | yes      | Message to unpin            |

**Response** `200` — `{ "success": true }`

**Errors:** `400` session not active · `401` missing/invalid API key · `403` the engine refused the unpin (in a group only admins may unpin) · `404` message not found in the chat

#### GET /api/sessions/:sessionId/messages/:chatId/:messageId/media

Download a message's **archived** media bytes.

This is the read side of chat-media archiving, which is **opt-in and off by default**
(`CHAT_MEDIA_ARCHIVE_ENABLED`). When enabled, each inbound message's media is written to whatever
backs `StorageService` (local disk or S3) in addition to the inline base64 copy the message row
already carries, so it stays retrievable after delivery. With archiving off, this route answers
`404` for every message.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                 |
| --------- | ------ | ------------------------------------------- |
| sessionId | string | Session ID                                  |
| chatId    | string | Chat ID containing the message              |
| messageId | string | WhatsApp message ID whose media to download |

**Response** `200` — the raw media bytes as the response body, served as an **attachment**
(`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`). `Content-Type` is the stored
mimetype when it is in a conservative inert set (common image/video/audio types) and
`application/octet-stream` otherwise — a document, or an `image/svg+xml`, is never served as active
content on the API origin.

**Errors:** `401` missing/invalid API key, or key not scoped to this session · `404`
`No archived media for this message` — archiving was off when the message arrived, the message
carries no media, the media was above `CHAT_MEDIA_ARCHIVE_MAX_BYTES`, or
`CHAT_MEDIA_ARCHIVE_TTL_DAYS` retention has since cleared the file

Note: this is a three-path-segment route, so it never collides with the two-segment
`GET /messages/:chatId/history` regardless of declaration order.

#### GET /api/sessions/:sessionId/messages/batch/:batchId

Get the processing status and progress of a bulk batch.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| batchId   | string | Batch ID    |

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

### Send pacing (opt-in, `429 SEND_PACING_LIMITED`)

Every outbound message send — the `messages/send-*` routes, `messages/edit`, `messages/forward`,
bulk batches, status posts and `messages/send-product` — passes an optional pacing governor before
it reaches WhatsApp. Actions on existing messages (react, vote, pin, star) are not sends and are
not paced. It is **off by default**: unless `SEND_PACING_ENABLED=true`, nothing is refused and no
extra work is done.

When enabled, two rules can refuse a send:

| Rule              | What it means                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warm-up daily cap | The session has used its allowance for the current **UTC** day. The allowance grows with the session's age (`SEND_PACING_WARMUP_SCHEDULE`), because a brand-new WhatsApp account that immediately sends at volume is the pattern that gets numbers banned. The count comes from the messages table, so it survives restarts.                                                                   |
| Cold-reachout cap | The session has used its allowance of **new conversations** for the UTC day (`SEND_PACING_COLD_DAILY_CAP`). A send is a cold reachout when the account has no history with that chat in **either** direction — replying to someone who wrote to you first is never counted, and never refused by this rule. Status posts address no chat and are exempt.                                       |
| Failure breaker   | Consecutive send failures reached `SEND_PACING_BREAKER_THRESHOLD`, which usually means WhatsApp has already started refusing this account. The streak has no time decay — only a successful send resets it, so failures spread across a long quiet period still accumulate toward the threshold. Sends resume after `SEND_PACING_BREAKER_COOLDOWN_MS`, or immediately after any send succeeds. |

A refusal is `429` with a body carrying **`code: "SEND_PACING_LIMITED"`** and `retryAfterSeconds`:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Daily allowance of 5 new conversation(s) reached for a session 0 day(s) old",
  "code": "SEND_PACING_LIMITED",
  "retryAfterSeconds": 34521
}
```

The `code` is what distinguishes it from the **global rate limiter's** own `429`, which carries no
`code`. The difference matters to a client: the throttler's 429 clears in seconds, a daily cap does
not. Do not retry a `SEND_PACING_LIMITED` response before `retryAfterSeconds`.

Inside a bulk batch a refusal fails just that item (honouring `stopOnError`), not the batch — the
allowance may free up, and a batch killed outright could not be resumed.

**Group participant adds draw on the same cold budget.** `POST .../groups/:groupId/participants` and
`POST .../groups` put the account in front of people who did not ask for it, in bulk, in a single
call — the most ban-associated action available — so each participant the account has no history
with costs one cold reachout. A repeated id costs one; participants already known cost nothing. The
whole request is refused rather than partially applied, so a `429` can never be confused with the
per-participant failures those endpoints report normally. No message is sent, so neither call
consumes the overall daily send allowance.

Two consequences worth knowing: a paced-out send fires **no** `message:sending` plugin hook (see
`docs/19-plugin-architecture.md`), and refusals are counted in the `openwa_send_pacing_refusals_total`
Prometheus counter, labelled by rule.

#### POST /api/sessions/:sessionId/messages/send-text

Send a plain text message.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendTextMessageDto`

| Field             | Type     | Required | Constraints                    | Description                                                                                  |
| ----------------- | -------- | -------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| chatId            | string   | Yes      | non-empty                      | `phone@c.us` or `groupId@g.us`                                                               |
| text              | string   | Yes      | non-empty, max 4096            | Message text                                                                                 |
| mentions          | string[] | No       | array of WIDs                  | WIDs to @mention (e.g. `["62811@c.us"]`). See **Mentions** below                             |
| linkPreview       | boolean  | No       | —                              | `false` suppresses it; on Baileys `true` is required to get one. See **Link previews** below |
| customLinkPreview | object   | No       | `{ url, title, description? }` | Attach a preview you supply. **Baileys only.** See **Link previews** below                   |

```json
{ "chatId": "628123456789@c.us", "text": "Hello from OpenWA!" }
```

```json
{ "chatId": "628123456789@c.us", "text": "see https://example.com", "linkPreview": false }
```

**Link previews.** Sending `false` stops the preview on both engines. The two differ on what
happens otherwise: whatsapp-web.js lets WhatsApp Web build one in-page (free, so it is the default),
while on Baileys the gateway must fetch the page itself — a blocking outbound request per URL before
the message can go out — so there a preview is **opt-in**:

|                      | whatsapp-web.js                                                       | Baileys                                            |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `linkPreview: false` | no preview                                                            | no preview                                         |
| unset                | asks WhatsApp Web to build a preview in-page                          | no preview                                         |
| `linkPreview: true`  | asks WhatsApp Web to build a preview in-page                          | the gateway fetches the page itself and builds one |
| `customLinkPreview`  | `501` — the library takes a boolean only, with no way to pass a title | preview attached verbatim, nothing fetched         |

**How Baileys previews are generated.** Not with the library's own generator. That one delegates to
`link-preview-js`, which carries an unfixed SSRF advisory
([GHSA-4gp8-rjrq-ch6q](https://github.com/advisories/GHSA-4gp8-rjrq-ch6q), CWE-918 — "IPv6 and
internal loopback attacks", no patched release). Since the URL comes from message text, an attacker
influences what this server fetches, so the gateway supplies its own generator instead: it fetches
through the same SSRF guard used elsewhere, which validates the destination **and pins the
connection to the vetted address**, closing the DNS-rebinding window a validate-then-delegate
approach would leave open. `WEBHOOK_SSRF_PROTECT` and `SSRF_ALLOWED_HOSTS` apply, so a deployment
that intentionally allows an internal host keeps that behaviour. A refused, slow or broken site
yields no preview — never a failed send.

`customLinkPreview` fetches **nothing at all**, so it works for URLs this server cannot reach, and it
cannot be combined with `linkPreview: false` — that asks for the opposite, and the request is
rejected with `400` rather than guessing which half was meant.

> whatsapp-web.js's own documentation notes the flag "has no effect on multi-device accounts". Its
> code does act on the flag, but that caveat is upstream's and is repeated here rather than
> contradicted — if a preview still appears on a multi-device account despite `false`, that is why.

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendTemplateMessageDto`

| Field        | Type                    | Required    | Constraints                                       | Description                                                 |
| ------------ | ----------------------- | ----------- | ------------------------------------------------- | ----------------------------------------------------------- |
| chatId       | string                  | Yes         | non-empty                                         | Target chat                                                 |
| templateId   | string                  | Conditional | non-empty; required when `templateName` is absent | Stored template id                                          |
| templateName | string                  | Conditional | non-empty; required when `templateId` is absent   | Stored template name                                        |
| vars         | Record\<string,string\> | No          | object                                            | Substituted into `{{placeholder}}` tokens; defaults to `{}` |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendMediaMessageDto`

| Field    | Type   | Required    | Constraints                           | Description                                                               |
| -------- | ------ | ----------- | ------------------------------------- | ------------------------------------------------------------------------- |
| chatId   | string | Yes         | non-empty                             | Target chat                                                               |
| url      | string | Conditional | URL; required when `base64` is absent | http/https media URL (SSRF-guarded; a blocked internal URL maps to `400`) |
| base64   | string | Conditional | string; required when `url` is absent | Base64 media data (capped to the media byte limit)                        |
| mimetype | string | Conditional | string; required when using `base64`  | MIME type of the media                                                    |
| filename | string | No          | max 255                               | File name                                                                 |
| caption  | string | No          | max 1024                              | Caption text                                                              |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendMediaMessageDto` (fields `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption` — see `send-image`)

```json
{
  "chatId": "628123456789@c.us",
  "url": "https://example.com/report.pdf",
  "filename": "report.pdf",
  "mimetype": "application/pdf"
}
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Engine differences:** Baileys always sends a document as a document, while whatsapp-web.js deliberately keeps normal mimetype classification for `status@broadcast` and broadcast lists — the library returns `null` for document-mode sends to those recipients, so forcing the flag there would turn a working send into a failure. For URL-based sends without an explicit `filename`, whatsapp-web.js derives the URL basename; Baileys falls back to the literal `file`.

**Errors:** `400` media validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-location

Send a location pin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendLocationDto`

| Field       | Type   | Required | Constraints     | Description                      |
| ----------- | ------ | -------- | --------------- | -------------------------------- |
| chatId      | string | Yes      | non-empty       | Target chat                      |
| latitude    | number | Yes      | valid latitude  | Latitude (out-of-range → `400`)  |
| longitude   | number | Yes      | valid longitude | Longitude (out-of-range → `400`) |
| description | string | No       | string          | Pin description                  |
| address     | string | No       | string          | Pin address                      |

```json
{
  "chatId": "628123456789@c.us",
  "latitude": -6.2088,
  "longitude": 106.8456,
  "description": "Jakarta",
  "address": "Central Jakarta"
}
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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendContactDto`

| Field         | Type   | Required | Constraints | Description                       |
| ------------- | ------ | -------- | ----------- | --------------------------------- |
| chatId        | string | Yes      | non-empty   | Target chat                       |
| contactName   | string | Yes      | non-empty   | Display name for the contact card |
| contactNumber | string | Yes      | non-empty   | Contact phone number              |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendMediaMessageDto` (fields `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption` — see `send-image`)

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/sticker.webp", "mimetype": "image/webp" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` media validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-poll

Send a native WhatsApp poll.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendPollDto`

| Field                | Type     | Required | Constraints                               | Description                                           |
| -------------------- | -------- | -------- | ----------------------------------------- | ----------------------------------------------------- |
| chatId               | string   | Yes      | non-empty                                 | Target chat                                           |
| name                 | string   | Yes      | max 255                                   | Poll question / title                                 |
| options              | string[] | Yes      | 2–12 items, each non-empty, max 100 chars | Options to vote on                                    |
| allowMultipleAnswers | boolean  | No       | —                                         | Allow picking several options (default single choice) |

```json
{
  "chatId": "1203630000@g.us",
  "name": "Where should we meet?",
  "options": ["Park", "Beach", "Downtown"],
  "allowMultipleAnswers": false
}
```

**Response** `201`

```json
{ "messageId": "true_1203630000@g.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` validation failure (option count/length) / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/reply

Reply to a message, quoting a prior message.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `ReplyMessageDto`

| Field           | Type   | Required | Constraints | Description                             |
| --------------- | ------ | -------- | ----------- | --------------------------------------- |
| chatId          | string | Yes      | non-empty   | Target chat                             |
| quotedMessageId | string | Yes      | non-empty   | WhatsApp id of the message being quoted |
| text            | string | Yes      | non-empty   | Reply text                              |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `ForwardMessageDto`

| Field      | Type   | Required | Constraints | Description                           |
| ---------- | ------ | -------- | ----------- | ------------------------------------- |
| fromChatId | string | Yes      | non-empty   | Source chat                           |
| toChatId   | string | Yes      | non-empty   | Destination chat                      |
| messageId  | string | Yes      | non-empty   | WhatsApp id of the message to forward |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `ReactMessageDto`

| Field     | Type   | Required | Constraints           | Description                                                                      |
| --------- | ------ | -------- | --------------------- | -------------------------------------------------------------------------------- |
| chatId    | string | Yes      | non-empty             | Target chat                                                                      |
| messageId | string | Yes      | non-empty             | Message to react to                                                              |
| emoji     | string | Yes      | string (may be empty) | Reaction emoji; an empty string removes the reaction. The field must be present. |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `DeleteMessageDto`

| Field       | Type    | Required | Constraints              | Description                                            |
| ----------- | ------- | -------- | ------------------------ | ------------------------------------------------------ |
| chatId      | string  | Yes      | non-empty                | Target chat                                            |
| messageId   | string  | Yes      | non-empty                | Message to delete                                      |
| forEveryone | boolean | No       | boolean (default `true`) | Delete for everyone; defaults to `true` in the service |

```json
{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "forEveryone": true }
```

**Response** `200`

After the engine delete, the stored message body is cleared and its `type` set to `revoked`. Note the `200` status (via `@HttpCode`).

```json
{ "success": true }
```

**Errors:** `400` session not active / message not found / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `500` engine error

#### POST /api/sessions/:sessionId/messages/edit

Edit the text of a message sent by this account; also updates the stored record's body.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `EditMessageDto`

| Field     | Type   | Required | Constraints             | Description                                       |
| --------- | ------ | -------- | ----------------------- | ------------------------------------------------- |
| chatId    | string | Yes      | non-empty               | Chat containing the message                       |
| messageId | string | Yes      | non-empty               | Message to edit (the send response's `messageId`) |
| body      | string | Yes      | non-empty, ≤ 4096 chars | New text content                                  |

```json
{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "body": "Corrected text" }
```

**Response** `200`

The edited message keeps its original id.

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1760000000 }
```

**Errors:** `400` session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` message not found · `500` engine error (e.g. editing another account's message, which WhatsApp forbids)

#### POST /api/sessions/:sessionId/messages/send-bulk

Send messages to multiple recipients as an async batch — returns immediately and processes in the background.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendBulkMessageDto`

| Field    | Type                  | Required | Constraints                      | Description                                                                                                               |
| -------- | --------------------- | -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| batchId  | string                | No       | string                           | Auto-generated `batch_<hex>` if omitted; a duplicate id returns `400`                                                     |
| messages | BulkMessageItemDto[]  | Yes      | array, max 100, nested-validated | The batch items (see below); duplicate `chatId`s are collapsed before processing — first occurrence wins, order preserved |
| options  | BulkMessageOptionsDto | No       | nested-validated                 | Pacing/error options (see below)                                                                                          |

Each `BulkMessageItemDto`: `{ chatId: string, type: 'text'|'image'|'video'|'audio'|'document', content: BulkMessageContentDto, variables?: Record<string,string> }`. `content` (all fields optional, nested-validated): `text?: string`, `image?`/`video?`/`audio?`/`document?`: `{ url?, base64?, mimetype?, filename? }`, `caption?: string`.

`BulkMessageOptionsDto`: `{ delayBetweenMessages?: number (1000–60000, default 3000), randomizeDelay?: boolean (default true), stopOnError?: boolean (default false) }`.

Each item's base64 media is checked against the media byte cap (`MEDIA_DOWNLOAD_MAX_BYTES`) twice: at batch creation, and again per item after `variables` and the `message:sending` plugin gate are applied. An item that outgrows the cap only after rendering fails individually (`failed` in `results`, with `message:failed` fired) instead of being sent. `totalMessages` in the response reflects the de-duplicated item count.

```json
{
  "messages": [
    {
      "chatId": "628111111111@c.us",
      "type": "text",
      "content": { "text": "Hi {{name}}" },
      "variables": { "name": "Alice" }
    },
    {
      "chatId": "628222222222@c.us",
      "type": "image",
      "content": { "image": { "url": "https://example.com/promo.jpg" }, "caption": "Promo" }
    }
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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| batchId   | string | Batch ID    |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID. |

**Query parameters**

| Name   | Type    | Required | Default | Description                                                                                           |
| ------ | ------- | -------- | ------- | ----------------------------------------------------------------------------------------------------- |
| limit  | integer | No       | 1000    | Parsed with `parseInt(…,10)`; clamped to `[1, 1000]`. Omitted or non-finite values fall back to 1000. |
| offset | integer | No       | 0       | Parsed with `parseInt(…,10)`; non-finite values fall back to 0, then truncated to `>= 0`.             |

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

**Errors:** `400` session is not started · `401` missing/invalid API key, or key not scoped to this session

#### GET /api/sessions/:sessionId/contacts/check/:number

Check whether a phone number exists on WhatsApp and return its canonical WhatsApp id when it does.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                                             |
| --------- | ------ | ----------------------------------------------------------------------- |
| sessionId | string | Session ID.                                                             |
| number    | string | Phone number to check, e.g. `628123456789` (digits, no `@c.us` suffix). |

**Response** `200`

```json
{
  "number": "628123456789",
  "exists": true,
  "whatsappId": "628123456789@c.us"
}
```

`whatsappId` is the canonical native chat id, or `null` when the number is not on WhatsApp; `exists` is `whatsappId !== null`.

> Route-order caveat: this route is two path segments (`check/:number`), so it never collides with the single-segment `GET /:contactId` — a contact id of literally `check` resolves to `GET /:contactId`.

**Errors:** `400` session is not started · `401` missing/invalid API key

#### GET /api/sessions/:sessionId/contacts/:contactId

Get a single contact by its WhatsApp id.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                               |
| --------- | ------ | --------------------------------------------------------- |
| sessionId | string | Session ID.                                               |
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

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` `Contact <id> not found` (engine returned null)

#### GET /api/sessions/:sessionId/contacts/:contactId/profile-picture

Get the profile picture URL for a contact (best-effort).

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                  |
| --------- | ------ | -------------------------------------------- |
| sessionId | string | Session ID.                                  |
| contactId | string | Contact id / JID, e.g. `6281234567890@c.us`. |

**Response** `200`

```json
{ "url": "https://pps.whatsapp.net/v/..." }
```

`url` is `null` when there is no picture, the contact's privacy hides it, or it cannot be resolved.

> The path segment is `profile-picture` (hyphenated), not `profile-pic`.

**Errors:** `400` session is not started · `401` missing/invalid API key

#### GET /api/sessions/:sessionId/contacts/profile-pictures

Batch-resolve profile picture URLs for many contacts in one request (a chat sidebar would otherwise fire a burst of single fetches and exhaust the per-IP throttle).

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID. |

**Query parameters**

| Name | Type   | Required | Description                                                                                                                                                        |
| ---- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ids  | string | Yes      | Comma-separated contact ids. Blank entries are dropped; only the **first 50** ids are looked up, the rest are ignored (they simply do not appear in the response). |

**Response** `200`

```json
{
  "pictures": {
    "6281234567890@c.us": "https://pps.whatsapp.net/v/...",
    "6289876543210@c.us": null
  }
}
```

`pictures` is keyed by the requested id. A per-id failure — or a lookup that exceeds the 8 s per-id deadline — yields `null` for that id rather than failing the batch. An omitted or empty `ids` returns `{ "pictures": {} }`.

> Route-order caveat: `profile-pictures` is declared **before** `GET /:contactId`, so the literal segment wins — a contact whose id is literally `profile-pictures` cannot be fetched through the single-contact route.

**Errors:** `400` session is not started · `401` missing/invalid API key, or key not scoped to this session

#### GET /api/sessions/:sessionId/contacts/:contactId/phone

Resolve a contact id (e.g. an `@lid`) to a phone number (MSISDN digits), best-effort.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                  |
| --------- | ------ | -------------------------------------------- |
| sessionId | string | Session ID.                                  |
| contactId | string | Contact id / JID to resolve, e.g. an `@lid`. |

**Response** `200`

```json
{ "contactId": "12345678901234@lid", "phone": "6281234567890" }
```

`phone` is `null` when the engine cannot map the id (e.g. an `@lid` the account has never seen).

**Errors:** `400` session is not started · `401` missing/invalid API key

#### PUT /api/sessions/:sessionId/contacts/:contactId

Save a contact to the account's addressbook, or edit an existing entry. This is the WhatsApp
contact record — it does not block, delete, or otherwise touch the chat.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                     |
| --------- | ------ | ------------------------------- |
| sessionId | string | Session ID                      |
| contactId | string | Contact ID (e.g. `628xxx@c.us`) |

**Request body** — `UpsertContactDto`

| Field     | Type   | Required | Constraints | Description                                            |
| --------- | ------ | -------- | ----------- | ------------------------------------------------------ |
| firstName | string | Yes      | 1–100 chars | The contact's first name                               |
| lastName  | string | No       | ≤ 100 chars | Omit for a single-name contact — WhatsApp allows those |

**Response** `200` — `{ "success": true, "message": "Contact saved" }`

> The entry is saved to the WhatsApp addressbook only; it is **not** synced through to the device
> addressbook. Both engines are called with their sync-to-device flag off, so behaviour matches
> across engines rather than depending on which one is running.

> **A privacy id (`…@lid`) is refused with `400`.** The addressbook is keyed by phone number, and a
> lid's digits are not one — whatsapp-web.js takes a bare number here, so an unguarded lid would be
> stored as if it were a real phone. Pass a phone-based contact id instead.

**Errors:** `400` session not active, invalid request, or a `@lid` contact id · `401` missing/invalid API key · `403` key lacks OPERATOR role

#### DELETE /api/sessions/:sessionId/contacts/:contactId

Remove a contact from the account's addressbook. Does not block the contact or delete the chat.

**Auth:** API key (OPERATOR)

**Response** `200` — `{ "success": true, "message": "Contact deleted" }`

**Errors:** `400` session not active, or a `@lid` contact id (same reason as the `PUT` above) · `401` missing/invalid API key · `403` key lacks OPERATOR role

#### POST /api/sessions/:sessionId/contacts/:contactId/block

Block a contact.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                                  |
| --------- | ------ | -------------------------------------------- |
| sessionId | string | Session ID.                                  |
| contactId | string | Contact id / JID, e.g. `6281234567890@c.us`. |

This route takes no request body and binds no DTO. Send an empty body `{}` (the global `whitelist` + `forbidNonWhitelisted` ValidationPipe rejects any unexpected field with `400`).

**Response** `200`

This route is annotated `@HttpCode(200)`, so it returns `200` rather than the POST default `201`.

```json
{ "success": true, "message": "Contact blocked" }
```

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key role below OPERATOR

#### DELETE /api/sessions/:sessionId/contacts/:contactId/block

Unblock a contact.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                                  |
| --------- | ------ | -------------------------------------------- |
| sessionId | string | Session ID.                                  |
| contactId | string | Contact id / JID, e.g. `6281234567890@c.us`. |

No request body.

**Response** `200`

No `@HttpCode` override is present, so this DELETE returns the NestJS default `200` (not `204`).

```json
{ "success": true, "message": "Contact unblocked" }
```

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key role below OPERATOR

### 6.4.4 Groups

All group routes are nested under a session: base path `/api/sessions/:sessionId/groups`. Reads (`GET`) require a plain API key; writes (create/modify/leave/revoke) require an `OPERATOR` role key. All routes resolve the engine for the session first, so a session that is not started yields `400 Session is not started`.

#### GET /api/sessions/:sessionId/groups

List all groups for a session, with pagination.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Query parameters**

| Name   | Type                              | Required | Default | Description                                                            |
| ------ | --------------------------------- | -------- | ------- | ---------------------------------------------------------------------- |
| limit  | string (parsed base-10 to number) | No       | 1000    | Max groups to return; clamped to [1, 1000]. Omitted/non-finite → 1000. |
| offset | string (parsed base-10 to number) | No       | 0       | Groups to skip. Non-finite → 0; negative truncated to 0.               |

**Response** `200`

Raw array (no envelope). The service calls `engine.getGroups()`, projects each entry down to `id`/`name`/`linkedParentJID`, then paginates to bound the window. Anything else the engine's group object may carry is dropped by that projection — use `GET /groups/:groupId` (participants, settings, owner) when you need more than the identity.

```json
[
  {
    "id": "120363021234567890@g.us",
    "name": "Project Team",
    "linkedParentJID": null
  }
]
```

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key`

#### GET /api/sessions/:sessionId/groups/:groupId

Get detailed group info including participants.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                              |
| --------- | ------ | ---------------------------------------- |
| sessionId | string | Session ID                               |
| groupId   | string | Group ID, e.g. `120363021234567890@g.us` |

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

#### GET /api/sessions/:sessionId/groups/:groupId/picture

Get the group's picture URL.

**Auth:** API key

**Response** `200` — `{ "url": "https://…" }`, or `{ "url": null }` when the group has no picture or
it is hidden by privacy settings.

#### PUT /api/sessions/:sessionId/groups/:groupId/picture

Set the group's picture. The account must be a group admin.

**Auth:** API key (OPERATOR)

**Request body** — `SetGroupPictureDto` (same shape as the profile-picture body)

| Field    | Type   | Required          | Constraints          | Description                                |
| -------- | ------ | ----------------- | -------------------- | ------------------------------------------ |
| url      | string | One of url/base64 | http(s) URL          | Fetched server-side through the SSRF guard |
| base64   | string | One of url/base64 | —                    | Wins over `url` when both are present      |
| mimetype | string | With `base64`     | must match `image/*` | Defaults to `image/jpeg`                   |

**Response** `200` — `{ "success": true, "message": "Group picture updated" }`

**Errors:** `400` session not active, or neither `url` nor `base64` supplied · `401` missing/invalid API key · `403` key lacks OPERATOR role, or the engine refused (admin rights required) · `404` group not found

#### DELETE /api/sessions/:sessionId/groups/:groupId/picture

Remove the group's picture. The account must be a group admin.

**Auth:** API key (OPERATOR)

**Response** `200` — `{ "success": true, "message": "Group picture removed" }`

**Errors:** `401` missing/invalid API key · `403` key lacks OPERATOR role, or the engine refused (admin rights required) · `404` group not found

#### GET /api/sessions/:sessionId/groups/:groupId/invite-code

Get the group invite code and full invite link.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `CreateGroupDto`

| Field        | Type     | Required | Constraints                                            | Description                                               |
| ------------ | -------- | -------- | ------------------------------------------------------ | --------------------------------------------------------- |
| name         | string   | Yes      | `@IsString`, `@IsNotEmpty`                             | Group subject/name                                        |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs, e.g. `628123456789@c.us` |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `ParticipantsDto`

| Field        | Type     | Required | Constraints                                            | Description                     |
| ------------ | -------- | -------- | ------------------------------------------------------ | ------------------------------- |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200`

Status is forced to `200` via `@HttpCode(HttpStatus.OK)` (overriding the POST default). `results` carries the engine's per-participant outcome — a partial refusal does **not** fail the batch, so check `results[].success` rather than the envelope's `success`.

```json
{
  "success": true,
  "message": "Participants added",
  "results": [
    { "id": "628123456789@c.us", "success": true, "status": 200 },
    { "id": "628987654321@c.us", "success": false, "status": 403, "message": "invite-only" }
  ]
}
```

Each entry is a `ParticipantOperationResult`: `id` (the participant the outcome belongs to), `success` (true only when the engine confirmed the change for that participant), and the optional engine-reported `status`/`message` (e.g. `200` ok, `403` invite-only/not-admin, `404` not registered, `409` already a member). Engines that only confirm the batch as a whole report one success entry per requested participant.

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### DELETE /api/sessions/:sessionId/groups/:groupId/participants

Remove participants from a group. Note: this DELETE carries a JSON request body.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `ParticipantsDto`

| Field        | Type     | Required | Constraints                                            | Description                     |
| ------------ | -------- | -------- | ------------------------------------------------------ | ------------------------------- |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200`

No `@HttpCode`, so NestJS uses the DELETE default of `200`. `results` carries the per-participant outcome (see the add route above).

```json
{
  "success": true,
  "message": "Participants removed",
  "results": [{ "id": "628123456789@c.us", "success": true, "status": 200 }]
}
```

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### POST /api/sessions/:sessionId/groups/:groupId/participants/promote

Promote participants to group admin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `ParticipantsDto`

| Field        | Type     | Required | Constraints                                            | Description                     |
| ------------ | -------- | -------- | ------------------------------------------------------ | ------------------------------- |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200` (forced via `@HttpCode(HttpStatus.OK)`). `results` carries the per-participant outcome (see the add route above).

```json
{
  "success": true,
  "message": "Participants promoted to admin",
  "results": [{ "id": "628123456789@c.us", "success": true, "status": 200 }]
}
```

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### POST /api/sessions/:sessionId/groups/:groupId/participants/demote

Demote participants from group admin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `ParticipantsDto`

| Field        | Type     | Required | Constraints                                            | Description                     |
| ------------ | -------- | -------- | ------------------------------------------------------ | ------------------------------- |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})` | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200` (forced via `@HttpCode(HttpStatus.OK)`). `results` carries the per-participant outcome (see the add route above).

```json
{
  "success": true,
  "message": "Participants demoted from admin",
  "results": [{ "id": "628123456789@c.us", "success": true, "status": 200 }]
}
```

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### PUT /api/sessions/:sessionId/groups/:groupId/subject

Change the group name/subject.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `GroupSubjectDto`

| Field   | Type   | Required | Constraints                | Description            |
| ------- | ------ | -------- | -------------------------- | ---------------------- |
| subject | string | Yes      | `@IsString`, `@IsNotEmpty` | New group subject/name |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `GroupDescriptionDto`

| Field       | Type   | Required | Constraints                    | Description                                                                |
| ----------- | ------ | -------- | ------------------------------ | -------------------------------------------------------------------------- |
| description | string | Yes      | `@IsString` (no `@IsNotEmpty`) | Must be present and a string, but `""` is valid and clears the description |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

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

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

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

#### GET /api/sessions/:sessionId/groups/join-info

Preview a group from its invite code, **without joining**. Supported on both engines.

**Auth:** API key · **Scope:** session-scoped

Read-only — nothing about the account's membership changes, which is what makes it safe to call on a
code from an untrusted source, and what makes it the natural step before `POST /groups/join`.

**Query parameters**

| Name   | Type   | Required | Description                                        |
| ------ | ------ | -------- | -------------------------------------------------- |
| `code` | string | Yes      | Group invite code — the part after the invite link |

**Response** `200`

```json
{
  "id": "120363012345678901@g.us",
  "name": "Product team",
  "description": "Internal coordination",
  "owner": "628123456789@c.us",
  "createdAt": 1700000000,
  "participantCount": 42
}
```

There is **no participant list** — the account is not a member — only `participantCount`, and only
when WhatsApp discloses one. `id` and `name` are always present; every other field is **omitted**
rather than zeroed when the engine did not report it, because `whatsapp-web.js` returns an untyped
object with no guaranteed shape and a defaulted `createdAt: 0` would read as "created at the epoch".

**Errors:** `400` no code supplied, or session not started · `401` · `404` no such invite — invalid, expired, or revoked

#### POST /api/sessions/:sessionId/groups/join

Join a group via an invite code (the part after `https://chat.whatsapp.com/`).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `JoinGroupDto`

| Field      | Type   | Required | Constraints | Description       |
| ---------- | ------ | -------- | ----------- | ----------------- |
| inviteCode | string | Yes      | non-empty   | Group invite code |

```json
{ "inviteCode": "XyZ987654321" }
```

**Response** `200`

```json
{ "success": true, "groupId": "120363000000000000@g.us" }
```

**Errors:** `400` session is not started / invalid invite code · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role

#### GET /api/sessions/:sessionId/groups/:groupId/settings

Read the group's admin-only settings and disappearing-message timer.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Response** `200`

`announce` = only admins can send messages; `locked` = only admins can edit group info. `ephemeralSeconds` and `memberAddMode` are each present only when the engine reports them.

```json
{ "announce": false, "locked": false, "ephemeralSeconds": 604800, "memberAddMode": "all" }
```

`memberAddMode` is `"all"` (any member may add participants) or `"admins"`. Both engines report and
accept it, but they encode it differently underneath — Baileys as a boolean where `true` means
_everyone_, whatsapp-web.js as WhatsApp's own `all_member_add`/`admin_add` strings (its typings claim
a boolean with the opposite sense). The adapters normalise both to these two values.

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `404` group not found

#### PUT /api/sessions/:sessionId/groups/:groupId/settings

Update group settings. Each present field maps to one engine call; absent fields stay untouched. The caller must be a group admin for the change to take effect.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `GroupSettingsDto` (at least one field required)

| Field            | Type    | Required | Constraints       | Description                                                                                            |
| ---------------- | ------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| announce         | boolean | No       | boolean           | Only admins can send messages                                                                          |
| locked           | boolean | No       | boolean           | Only admins can edit group info                                                                        |
| ephemeralSeconds | integer | No       | ≥ 0               | Disappearing-message timer in seconds (`0` disables). **Baileys only** — whatsapp-web.js returns `501` |
| memberAddMode    | string  | No       | `all` \| `admins` | Who may add participants. Supported on both engines                                                    |

```json
{ "announce": true, "ephemeralSeconds": 86400 }
```

> **Ordering within a patch is deliberate.** `ephemeralSeconds` is applied first because it is the
> only field with a deterministic per-engine refusal (whatsapp-web.js always `501`s it); applying
> anything else first would leave a half-applied patch behind when that call throws. `memberAddMode`
> is supported on both engines and is therefore applied after it.

**Response** `200`

```json
{ "success": true, "message": "Group settings updated" }
```

**Errors:** `400` session is not started / empty patch / unknown body field · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or the account is not a group admin (`memberAddMode` on whatsapp-web.js) · `501` `ephemeralSeconds` on the whatsapp-web.js engine (library limitation)

### 6.4.5 Message Templates

Reusable message templates scoped to a session, with `{{variable}}` placeholders rendered at send time. All routes are nested under `/api/sessions/:sessionId/templates` and require an **OPERATOR** key. The `sessionId` is stored on the template but is **not** validated against an existing session in these handlers.

#### GET /api/sessions/:sessionId/templates

List all templates for a session, newest first.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                                   |
| --------- | ------ | --------------------------------------------- |
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

| Name      | Type   | Description                                   |
| --------- | ------ | --------------------------------------------- |
| sessionId | string | Session ID; combined with `id` in the lookup. |
| id        | string | Template UUID.                                |

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

| Name      | Type   | Description                                                                                            |
| --------- | ------ | ------------------------------------------------------------------------------------------------------ |
| sessionId | string | Session ID; stored as `template.sessionId`. Not validated against an existing session in this handler. |

**Request body** — `CreateTemplateDto`

| Field  | Type   | Required | Constraints               | Description                                                                                          |
| ------ | ------ | -------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| name   | string | yes      | non-empty, max 100 chars  | Unique template name within the session (DB unique index on `[sessionId, name]`). Duplicate → `409`. |
| body   | string | yes      | non-empty, max 4096 chars | Template body containing `{{variable}}` placeholders rendered at send time.                          |
| header | string | no       | max 1024 chars            | Optional header text; coerced to `null` when omitted. Prepended to rendered body.                    |
| footer | string | no       | max 1024 chars            | Optional footer text; coerced to `null` when omitted. Appended to rendered body.                     |

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

| Name      | Type   | Description              |
| --------- | ------ | ------------------------ |
| sessionId | string | Session ID.              |
| id        | string | Template UUID to update. |

**Request body** — `UpdateTemplateDto`

| Field  | Type   | Required | Constraints                           | Description                                                                                                                                                         |
| ------ | ------ | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name   | string | no       | if present: non-empty, max 100 chars  | Applied only when not `undefined`. Duplicate name → `409`.                                                                                                          |
| body   | string | no       | if present: non-empty, max 4096 chars | Applied only when not `undefined`.                                                                                                                                  |
| header | string | no       | max 1024 chars                        | Applied only when not `undefined`. The update path does **not** coerce to `null`, so passing explicit `null` fails `@IsString`; omit the key to leave it unchanged. |
| footer | string | no       | max 1024 chars                        | Applied only when not `undefined`.                                                                                                                                  |

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

| Name      | Type   | Description              |
| --------- | ------ | ------------------------ |
| sessionId | string | Session ID.              |
| id        | string | Template UUID to delete. |

**Response** `204`

No content (empty body). The handler looks the template up first, so a missing template yields `404` rather than a silent `204`.

**Errors:** `401` missing/invalid `X-API-Key` · `403` key below OPERATOR role · `404` `id`+`sessionId` not found

### 6.4.6 Catalog & Channels

WhatsApp Business catalog browsing/sending and channel (newsletter) operations. Catalog read routes (`/catalog…`) require any valid API key; the two product/catalog **send** routes live under the `/messages` path and require an **OPERATOR** key. Channel read routes require any valid API key; subscribe/unsubscribe require **OPERATOR**.

#### GET /api/sessions/:sessionId/catalog

Get business catalog info for the session's WhatsApp Business account.

**Auth:** API key

**Path parameters**

| Name        | Type   | Description          |
| ----------- | ------ | -------------------- |
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

**Not implemented on any engine.** Both adapters throw `EngineNotSupportedError` (`501`) — whatsapp-web.js has no native Catalog API (the former null-returning stub was removed), and Baileys leaves it unwired. The shape above documents the contract, not a response you can obtain today. The whatsapp-web.js adapter calls its readiness guard _before_ refusing, so a session that exists but is not `READY` (initializing, waiting on a QR, reconnecting) gets `409` instead of `501`; Baileys refuses unconditionally.

**Errors:** `401` missing/invalid API key · `404` `Session <sessionId> not found or not connected` · `409` session present but not READY (whatsapp-web.js only) · `501` not implemented on either engine

#### GET /api/sessions/:sessionId/catalog/products

List catalog products with pagination.

**Auth:** API key

**Path parameters**

| Name        | Type   | Description          |
| ----------- | ------ | -------------------- |
| `sessionId` | string | WhatsApp session id. |

**Query parameters**

| Name    | Type    | Required | Default | Description                                                             |
| ------- | ------- | -------- | ------- | ----------------------------------------------------------------------- |
| `page`  | integer | No       | `1`     | Page number. Coerced from string; must be an integer `>= 1` or `400`.   |
| `limit` | integer | No       | `20`    | Page size. Must be an integer `>= 1`. No upper cap declared on the DTO. |

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

**Not implemented on any engine.** Both adapters throw `EngineNotSupportedError` (`501`), so the shape above documents the contract, not a response you can obtain today. Query validation still runs first, so a bad `page`/`limit` is a `400`. On whatsapp-web.js the readiness guard runs before the refusal, so a session that exists but is not `READY` gets `409` instead of `501`; Baileys refuses unconditionally.

**Errors:** `400` invalid `page`/`limit` or unknown query key · `401` missing/invalid API key · `404` `Session <sessionId> not found or not connected` · `409` session present but not READY (whatsapp-web.js only) · `501` not implemented on either engine

#### GET /api/sessions/:sessionId/catalog/products/:productId

Get a specific catalog product by id.

**Auth:** API key

**Path parameters**

| Name        | Type   | Description          |
| ----------- | ------ | -------------------- |
| `sessionId` | string | WhatsApp session id. |
| `productId` | string | Catalog product id.  |

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

**Not implemented on any engine.** Both adapters throw `EngineNotSupportedError` (`501`), so the shape above documents the contract, not a response you can obtain today. On whatsapp-web.js the readiness guard runs before the refusal, so a session that exists but is not `READY` gets `409` instead of `501`; Baileys refuses unconditionally.

**Errors:** `401` missing/invalid API key · `404` `Session <sessionId> not found or not connected` · `409` session present but not READY (whatsapp-web.js only) · `501` not implemented on either engine

#### POST /api/sessions/:sessionId/messages/send-product

Send a product message (catalog product card) to a chat. Note: this route lives under the `/messages` path but belongs to the catalog module.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name        | Type   | Description          |
| ----------- | ------ | -------------------- |
| `sessionId` | string | WhatsApp session id. |

**Request body** — `SendProductDto`

| Field       | Type   | Required | Constraints | Description                                           |
| ----------- | ------ | -------- | ----------- | ----------------------------------------------------- |
| `chatId`    | string | Yes      | `@IsString` | Target chat/recipient id (e.g. `6281234567890@c.us`). |
| `productId` | string | Yes      | `@IsString` | Catalog product id to send.                           |
| `body`      | string | No       | `@IsString` | Optional message body/caption.                        |

```json
{
  "chatId": "6281234567890@c.us",
  "productId": "PROD_12345",
  "body": "Check out this item!"
}
```

**Response** `501` (not implemented on either engine)

```json
{
  "statusCode": 501,
  "message": "Operation not supported by the active engine: sendProduct",
  "error": "Not Implemented"
}
```

No engine implements this. whatsapp-web.js and Baileys both raise `EngineNotSupportedError`, so the
route cannot return a success body on any deployment; it is documented here because it is mounted.
On whatsapp-web.js the readiness guard runs before the refusal, so a session that exists but is not
`READY` gets `409` instead of `501`; Baileys refuses unconditionally.

**Errors:** `400` missing `chatId`/`productId`, wrong types, or any field not on the DTO · `401` missing/invalid API key · `403` API-key role below OPERATOR · `404` `Session <sessionId> not found or not connected` · `409` session present but not READY (whatsapp-web.js only) · `500` engine error

#### POST /api/sessions/:sessionId/messages/send-catalog

Send the business catalog link to a chat. Note: this route lives under the `/messages` path but belongs to the catalog module.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name        | Type   | Description          |
| ----------- | ------ | -------------------- |
| `sessionId` | string | WhatsApp session id. |

**Request body** — `SendCatalogDto`

| Field    | Type   | Required | Constraints | Description                    |
| -------- | ------ | -------- | ----------- | ------------------------------ |
| `chatId` | string | Yes      | `@IsString` | Target chat/recipient id.      |
| `body`   | string | No       | `@IsString` | Optional message body/caption. |

```json
{
  "chatId": "6281234567890@c.us",
  "body": "Browse our full catalog here"
}
```

**Response** `501` (not implemented on either engine)

```json
{
  "statusCode": 501,
  "message": "Operation not supported by the active engine: sendCatalog",
  "error": "Not Implemented"
}
```

No engine implements this. whatsapp-web.js and Baileys both raise `EngineNotSupportedError`, so the
route cannot return a success body on any deployment; it is documented here because it is mounted.
On whatsapp-web.js the readiness guard runs before the refusal, so a session that exists but is not
`READY` gets `409` instead of `501`; Baileys refuses unconditionally.

**Errors:** `400` missing/invalid `chatId` or any non-DTO field · `401` missing/invalid API key · `403` API-key role below OPERATOR · `404` `Session <sessionId> not found or not connected` · `409` session present but not READY (whatsapp-web.js only) · `500` engine error

#### GET /api/sessions/:sessionId/channels

List all channels/newsletters the session is subscribed to.

**Auth:** API key

**Path parameters**

| Name        | Type   | Description                                                                      |
| ----------- | ------ | -------------------------------------------------------------------------------- |
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

| Name        | Type   | Description                                  |
| ----------- | ------ | -------------------------------------------- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |
| `channelId` | string | Channel/newsletter id.                       |

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

| Name        | Type   | Description                                  |
| ----------- | ------ | -------------------------------------------- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |
| `channelId` | string | Channel/newsletter id.                       |

**Query parameters**

| Name    | Type   | Required | Default                           | Description                                                                                                                                                                                                                                                                                                      |
| ------- | ------ | -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit` | number | No       | engine default (Swagger notes 50) | Max messages to return. Taken as a raw query string and run through `parseInt(limit, 10)` when present. There is **no** DTO/ValidationPipe on this value, but a non-numeric `limit` (e.g. `?limit=abc`) parses to `NaN` and falls back to `undefined`, i.e. the engine default — it is never forwarded as `NaN`. |

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

#### POST /api/sessions/:sessionId/channels

Create a channel. Supported on **both** engines.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

The account becomes the channel's owner, which is what makes deleting it possible later — neither
engine can delete a channel it does not own.

**Request body** — `CreateChannelDto`

| Field         | Type   | Required | Constraints  | Description         |
| ------------- | ------ | -------- | ------------ | ------------------- |
| `name`        | string | Yes      | 1–100 chars  | Channel name        |
| `description` | string | No       | ≤ 2048 chars | Channel description |

**Response** `201` — the created `Channel`, including its `inviteCode` (the code, not the full
`https://whatsapp.com/channel/…` link — the code is what `POST /channels/subscribe` takes).

**Errors:** `400` validation, or session not started · `401` · `403` · `422` the engine refused — on whatsapp-web.js this includes channel creation being disabled for the account

#### POST /api/sessions/:sessionId/channels/:channelId/delete

Delete a channel this account owns. Supported on **both** engines.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

Irreversible, and every subscriber loses the channel.

> **Why not `DELETE /channels/:channelId`?** That route already exists and means _unsubscribe_.
> Leaving a channel and destroying it are very different acts, and they must not be reachable by the
> same request with one wrong verb — so deletion takes an explicit path, matching the
> `POST .../messages/delete` and `POST .../chats/delete` convention used elsewhere.

**Response** `200` — `{ "success": true }`

**Errors:** `400` session not started · `401` · `403` · `422` the engine refused — not found, or this account does not own it

#### POST /api/sessions/:sessionId/channels/:channelId/mute

Mute or unmute a channel. Supported on **both** engines.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

Silences the channel's notifications for this account. The subscription is untouched — this is not a
soft unsubscribe.

**Request body** — `MuteChannelDto`

| Field  | Type    | Required | Description                   |
| ------ | ------- | -------- | ----------------------------- |
| `mute` | boolean | Yes      | `true` mutes, `false` unmutes |

**Response** `200` — `{ "success": true }`

**Errors:** `400` validation, or session not started · `401` · `403` · `422` the engine refused

#### POST /api/sessions/:sessionId/channels/subscribe

Subscribe to a channel using its invite code.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name        | Type   | Description                                  |
| ----------- | ------ | -------------------------------------------- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |

**Request body** — `SubscribeChannelDto`

| Field        | Type   | Required | Constraints               | Description                                      |
| ------------ | ------ | -------- | ------------------------- | ------------------------------------------------ |
| `inviteCode` | string | Yes      | `@IsString` `@IsNotEmpty` | Channel invite code from the channel share link. |

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

| Name        | Type   | Description                                  |
| ----------- | ------ | -------------------------------------------- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |
| `channelId` | string | Channel id to unsubscribe from.              |

**Response** `200`

```json
{ "success": true }
```

Note: this is the one route in the module that returns a literal `{ success: true }` (hard-coded by the controller after the void engine call resolves) rather than the raw engine return. There is no `@HttpCode` override, so it returns `200`, not `204`.

**Errors:** `400` `Session is not started` · `401` missing/invalid API key · `403` API-key role below OPERATOR

### 6.4.7 Labels & Status

Labels are a WhatsApp Business feature: every label route lives under a session and reads/writes the chat-label assignments exposed by the engine. Status routes manage the session's status feed (stories) — reading visible statuses and posting/deleting your own. Read routes require a base API key; all writes require `OPERATOR`.

**The two engines split cleanly down the middle here, and neither covers both halves.**

|                                                                                                   | whatsapp-web.js                                  | Baileys                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- |
| Read labels (`GET /labels`, `/labels/:labelId`, `/labels/chat/:chatId`, `/labels/:labelId/chats`) | ✅                                               | `501` — exposes no label query at all |
| Edit labels (`PUT`/`DELETE /labels/:labelId`)                                                     | `501` — can read and assign, but cannot edit one | ✅                                    |
| Assign to a chat (`POST`/`DELETE /labels/chat/…`)                                                 | ✅                                               | ✅                                    |

So a deployment can read labels or edit them, depending on the engine, but not both. Assignment is
the only part that works everywhere. This is a library split, not a gateway one — see
`docs/29-engine-capability-matrix.md` for the symbols behind each cell.

**Creating a label means choosing its id.** WhatsApp carries a single write keyed on the label id, so
create and update are the same operation and there is no server-assigned id to hand back — which is
why the route is `PUT /labels/:labelId` rather than `POST /labels`. Reusing an existing id **rewrites
that label** instead of failing, because the protocol has no create-only form.

**Reads are store-backed, not engine-direct.** `GET /status` and `GET /status/:contactId` no longer call the engine — they read from an OpenWA-side store that ingests inbound status/story broadcasts as they arrive (plus a best-effort backfill of currently-active stories on session connect), with a 24h TTL matching WhatsApp's own story expiry. This makes reads **identical on both engines**: `whatsapp-web.js` (which had a native `getBroadcasts()`/`getBroadcastById()` path) and Baileys (which never had one — `fetchStatus` only returns the _about_ text, not stories, so the raw engine methods still throw `501` if called directly, they're just no longer on the read path) now return the same shape from the same source. A status older than 24h, or received before the store existed, will not appear.

#### GET /api/sessions/:sessionId/labels

List all labels defined for the session (WhatsApp Business accounts only).

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Response** `200`

```json
[
  { "id": "1", "name": "New customer", "hexColor": "#FF9485" },
  { "id": "5", "name": "Paid", "hexColor": "#25D366" }
]
```

Bare array — raw return of `engine.getLabels()`; no envelope.

**Errors:** `400` session is not started (no live engine), or the account is not a WhatsApp Business account · `401` missing/invalid API key · `501` the Baileys engine does not implement label reads (whatsapp-web.js only)

#### GET /api/sessions/:sessionId/labels/:labelId

Get a single label by its ID.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| labelId   | string | Label ID    |

**Response** `200`

```json
{ "id": "5", "name": "Paid", "hexColor": "#25D366" }
```

The engine resolves `Label | null`; a `null` is mapped to `404` in the service, so a `200` always carries a label.

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` `Label <labelId> not found` · `501` the Baileys engine does not implement label reads (whatsapp-web.js only)

#### GET /api/sessions/:sessionId/labels/:labelId/chats

Every chat carrying a label.

**Auth:** API key · **Scope:** session-scoped · **Engines:** whatsapp-web.js only

**Response** `200` — a bare array of `ChatSummary`, the same shape `GET /sessions/:id/chats` returns.

**Errors:** `400` session not started · `401` · `404` session not found · `501` Baileys, which has no label query

#### PUT /api/sessions/:sessionId/labels/:labelId

Create or update a label.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped · **Engines:** Baileys only

The label id is **yours to choose** and travels in the path. Whether this creates or updates depends
only on whether that id already exists — reusing one rewrites that label rather than failing.
Omitted fields are left as they are.

**Request body** — `UpsertLabelDto`

| Field   | Type   | Required | Constraints  | Description                                  |
| ------- | ------ | -------- | ------------ | -------------------------------------------- |
| `name`  | string | No       | 1–100 chars  | Omit to keep the current name                |
| `color` | number | No       | integer 0–19 | WhatsApp's colour **index**, not a hex value |

`color` deliberately does not round-trip with the `hexColor` the read routes return: neither engine
exposes the index-to-hex mapping — whatsapp-web.js passes hex through from the WA Web store and
Baileys only ever speaks in indices — so translating between them here would be guesswork that
silently sets the wrong colour.

```json
{ "name": "VIP customer", "color": 3 }
```

**Response** `200`

```json
{ "success": true }
```

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found · `501` whatsapp-web.js, which cannot edit labels

#### DELETE /api/sessions/:sessionId/labels/:labelId

Delete a label. It disappears from every chat it was on.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped · **Engines:** Baileys only

**Response** `200`

```json
{ "success": true }
```

**Errors:** `400` session not started · `401` · `403` · `404` session not found · `501` whatsapp-web.js, which cannot edit labels

#### GET /api/sessions/:sessionId/labels/chat/:chatId

List the labels currently assigned to a specific chat.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                             |
| --------- | ------ | ------------------------------------------------------- |
| sessionId | string | Session ID                                              |
| chatId    | string | Chat ID (e.g. `6281234567890@c.us` or a group `…@g.us`) |

**Response** `200`

```json
[{ "id": "5", "name": "Paid", "hexColor": "#25D366" }]
```

Bare array — raw return of `engine.getChatLabels(chatId)`.

**Errors:** `400` session is not started · `401` missing/invalid API key · `501` the Baileys engine does not implement label reads (whatsapp-web.js only)

#### POST /api/sessions/:sessionId/labels/chat/:chatId

Add a label to a chat.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description      |
| --------- | ------ | ---------------- |
| sessionId | string | Session ID       |
| chatId    | string | Chat ID to label |

**Request body** — `AddLabelDto`

| Field   | Type   | Required | Constraints      | Description                 |
| ------- | ------ | -------- | ---------------- | --------------------------- |
| labelId | string | yes      | non-empty string | Label ID to add to the chat |

```json
{ "labelId": "5" }
```

**Response** `200`

```json
{ "success": true }
```

The handler always returns the literal `{ "success": true }`.

**Errors:** `400` validation failure (missing/empty/non-string `labelId`, or any unknown body field — strict whitelist), or session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role

#### DELETE /api/sessions/:sessionId/labels/chat/:chatId/:labelId

Remove a label from a chat.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description        |
| --------- | ------ | ------------------ |
| sessionId | string | Session ID         |
| chatId    | string | Chat ID            |
| labelId   | string | Label ID to remove |

**Response** `200`

```json
{ "success": true }
```

The handler always returns `{ "success": true }`. DELETE default status is `200` (no `@HttpCode` override).

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role

#### GET /api/sessions/:sessionId/status

Get all contact status updates (stories) visible to the session, read from the store (24h TTL, both engines — see the note above).

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                 |
| --------- | ------ | --------------------------- |
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
      "mediaUrl": "/api/sessions/my-session/status/false_6281234567890@c.us_3A1F.../media",
      "backgroundColor": "#25D366",
      "font": 2,
      "timestamp": "2026-06-25T08:30:00.000Z",
      "expiresAt": "2026-06-26T08:30:00.000Z"
    }
  ]
}
```

The controller wraps the store array in `{ statuses }`, ordered newest-first. `type` is one of `text | image | video | voice` (`voice` was added with the send-voice endpoint below; before that anything that was not an image or a video read back as `text`); `caption`, `backgroundColor`, `font` are optional. `mediaUrl` is present only when the status carried media that the store kept (see the media endpoint below) — it is a same-origin path into this API, not an external WhatsApp CDN link. `timestamp` and `expiresAt` serialize to ISO strings (these are `Date` values, not the epoch-number convention used by message timestamps).

**Errors:** `401` missing/invalid API key, or key not scoped to this session

#### GET /api/sessions/:sessionId/status/:contactId

Get status updates posted by a specific contact, read from the store (24h TTL, both engines).

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                |
| --------- | ------ | ------------------------------------------ |
| sessionId | string | WhatsApp session identifier                |
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

Same `{ statuses }` wrapper and `Status` shape as the list-all route. An unknown `contactId` returns `{ "statuses": [] }`, not a `404`.

**Errors:** `401` missing/invalid API key, or key not scoped to this session

#### GET /api/sessions/:sessionId/status/:statusId/media

Stream a stored status's media bytes (the file behind a `mediaUrl` returned above).

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                          |
| --------- | ------ | ---------------------------------------------------- |
| sessionId | string | WhatsApp session identifier                          |
| statusId  | string | The status `id` (e.g. from a `GET /status` response) |

**Response** `200` — the raw media bytes as the response body, with `Content-Type` set to the stored mimetype (e.g. `image/jpeg`, `video/mp4`). Streamed via `StreamableFile` from whatever backs `StorageService` (local disk or S3 — the route does not care which).

**Errors:** `401` missing/invalid API key, or key not scoped to this session · `404` `Status media not found or expired` — the status is text-only, its media was omitted (e.g. over the configured size cap), or the 24h TTL has since purged the row

Note: `:statusId/media` is a two-path-segment route, so it never collides with the single-segment `GET /status/:contactId` above regardless of declaration order.

#### POST /api/sessions/:sessionId/status/send-text

Post a text status (story) to the session's status feed. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts to the account's status-privacy audience.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                 |
| --------- | ------ | --------------------------- |
| sessionId | string | WhatsApp session identifier |

**Request body** — `SendTextStatusDto`

| Field           | Type     | Required | Constraints                                                          | Description                                                                                                                                                                                                                                                                                                               |
| --------------- | -------- | -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text            | string   | yes      | `@MaxLength(4096)`                                                   | Status text body                                                                                                                                                                                                                                                                                                          |
| recipients      | string[] | no       | 0–256 items, each matching `^\d+@(c\.us\|lid)$`                      | JIDs of the contacts permitted to view the status. **Honored on Baileys only** (passed as `statusJidList`), where it is required in practice — Baileys posts to exactly this allow-list, so omitting it reaches nobody. whatsapp-web.js ignores it and broadcasts to the account's status-privacy audience; omit it there |
| backgroundColor | string   | no       | 6-digit hex color matching `^#[0-9A-Fa-f]{6}$`                       | e.g. `#25D366`; bad value → `backgroundColor must be a hex color (e.g., #25D366)`                                                                                                                                                                                                                                         |
| font            | integer  | no       | `@IsIn([0, 1, 2, 6, 7, 8, 9, 10])` — `3`–`5` are rejected with `400` | WhatsApp status font index: `0` (default), `1`, `2`, `6` (bold), `7`, `8`, `9`, `10`. whatsapp-web.js honors only `0`–`7` and clamps anything above back to the default                                                                                                                                                   |

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

**Errors:** `400` validation failure (unknown body field, a JID not matching `@c.us`/`@lid`, more than 256 recipients, `text` over 4096 chars, bad `backgroundColor`/`font`) · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected

#### POST /api/sessions/:sessionId/status/send-image

Post an image status (story) from a URL or base64 payload. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts to the account's status-privacy audience.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                 |
| --------- | ------ | --------------------------- |
| sessionId | string | WhatsApp session identifier |

**Request body** — `SendImageStatusDto`

| Field          | Type                        | Required | Constraints                                                                                                                                                       | Description                                                                                                                                                                            |
| -------------- | --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| image          | object (`StatusMediaInput`) | yes      | validated nested object; one of `url`/`base64` must be present — an empty `{}` is rejected with `400`                                                             | Media source wrapper                                                                                                                                                                   |
| image.url      | string                      | no       | must be a non-empty string whenever `base64` is absent **or** `url` is present at all — `"url": ""` is rejected with `400` even when a valid `base64` is supplied | Media source URL                                                                                                                                                                       |
| image.base64   | string                      | no       | must be a non-empty string whenever `url` is absent **or** `base64` is present at all — `"base64": ""` is rejected with `400` even when a valid `url` is supplied | Base64-encoded media data                                                                                                                                                              |
| image.mimetype | string                      | no       | —                                                                                                                                                                 | Media MIME type; if omitted the service defaults to `image/jpeg`                                                                                                                       |
| recipients     | string[]                    | no       | 0–256 items, each matching `^\d+@(c\.us\|lid)$`                                                                                                                   | JIDs of the contacts permitted to view the status (`statusJidList`). Required in practice on Baileys (it posts to exactly this allow-list); ignored by whatsapp-web.js — omit it there |
| caption        | string                      | no       | `@MaxLength(1024)`                                                                                                                                                | Optional caption                                                                                                                                                                       |

The service resolves the media as `image.base64 || image.url || ''` — `base64` wins when both are supplied — and applies mimetype `image.mimetype ?? 'image/jpeg'`.

```json
{
  "image": { "url": "https://example.com/photo.jpg", "mimetype": "image/png" },
  "recipients": ["6281234567890@c.us"],
  "caption": "My status"
}
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

**Errors:** `400` validation failure (unknown body field, an empty media wrapper, a JID not matching `@c.us`/`@lid`, more than 256 recipients, or a caption over 1024 chars) · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected

#### POST /api/sessions/:sessionId/status/send-video

Post a video status (story) from a URL or base64 payload. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts to the account's status-privacy audience.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                 |
| --------- | ------ | --------------------------- |
| sessionId | string | WhatsApp session identifier |

**Request body** — `SendVideoStatusDto`

| Field          | Type                        | Required | Constraints                                                                                                                                                       | Description                                                                                                                                                                            |
| -------------- | --------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| video          | object (`StatusMediaInput`) | yes      | validated nested object; one of `url`/`base64` must be present — an empty `{}` is rejected with `400`                                                             | Media source wrapper                                                                                                                                                                   |
| video.url      | string                      | no       | must be a non-empty string whenever `base64` is absent **or** `url` is present at all — `"url": ""` is rejected with `400` even when a valid `base64` is supplied | Media source URL                                                                                                                                                                       |
| video.base64   | string                      | no       | must be a non-empty string whenever `url` is absent **or** `base64` is present at all — `"base64": ""` is rejected with `400` even when a valid `url` is supplied | Base64-encoded media data                                                                                                                                                              |
| video.mimetype | string                      | no       | —                                                                                                                                                                 | Media MIME type; if omitted the service defaults to `video/mp4`                                                                                                                        |
| recipients     | string[]                    | no       | 0–256 items, each matching `^\d+@(c\.us\|lid)$`                                                                                                                   | JIDs of the contacts permitted to view the status (`statusJidList`). Required in practice on Baileys (it posts to exactly this allow-list); ignored by whatsapp-web.js — omit it there |
| caption        | string                      | no       | `@MaxLength(1024)`                                                                                                                                                | Optional caption                                                                                                                                                                       |

The service resolves the media as `video.base64 || video.url || ''` — `base64` wins when both are supplied — and applies mimetype `video.mimetype ?? 'video/mp4'`.

```json
{
  "video": { "url": "https://example.com/clip.mp4", "mimetype": "video/quicktime" },
  "recipients": ["6281234567890@c.us"],
  "caption": "Watch this"
}
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

**Errors:** `400` validation failure (unknown body field, an empty media wrapper, a JID not matching `@c.us`/`@lid`, more than 256 recipients, or a caption over 1024 chars) · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected

#### POST /api/sessions/:sessionId/status/send-voice

Post an audio status (story) as a **voice note**, from a URL or base64 payload. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts to the account's status-privacy audience.

> **Format matters.** WhatsApp plays a status voice note only when it is Ogg/Opus, and neither engine transcodes — bytes are sent as supplied. Convert first via `POST /api/sessions/:sessionId/media/convert/voice` (§6.4.15) and post the `base64` it returns. Sending another format produces a bubble that will not play.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                 |
| --------- | ------ | --------------------------- |
| sessionId | string | WhatsApp session identifier |

**Request body** — `SendVoiceStatusDto`

| Field           | Type                        | Required | Constraints                                                                                           | Description                                                                                                      |
| --------------- | --------------------------- | -------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| audio           | object (`StatusMediaInput`) | yes      | validated nested object; one of `url`/`base64` must be present — an empty `{}` is rejected with `400` | Media source wrapper                                                                                             |
| audio.url       | string                      | no       | must be a non-empty string whenever `base64` is absent **or** `url` is present at all                 | Media source URL                                                                                                 |
| audio.base64    | string                      | no       | must be a non-empty string whenever `url` is absent **or** `base64` is present at all                 | Base64-encoded media data                                                                                        |
| audio.mimetype  | string                      | no       | —                                                                                                     | Media MIME type; if omitted the service defaults to `audio/ogg; codecs=opus`                                     |
| recipients      | string[]                    | no       | 0–256 items, each matching `^\d+@(c\.us\|lid)$`                                                       | JIDs permitted to view the status (`statusJidList`). Required in practice on Baileys; ignored by whatsapp-web.js |
| backgroundColor | string                      | no       | `^#[0-9A-Fa-f]{6}$`                                                                                   | Background colour rendered behind the voice-note bubble. Baileys only; whatsapp-web.js ignores it                |

There is **no `caption`**: WhatsApp has nowhere to render one on a status voice note.

```json
{ "audio": { "base64": "T2dnUwACAAAA..." }, "recipients": ["6281234567890@c.us"] }
```

**Response** `201` — the engine `StatusResult`, identical in shape to the image/video variants.

**Read-back:** a voice status is listed with `"type": "voice"`. That member was added with this endpoint; before it, anything that was not an image or a video was reported as `text`.

**Errors:** `400` validation failure, or neither `url` nor `base64` supplied · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected · `413` base64 media exceeds `MEDIA_DOWNLOAD_MAX_BYTES`

#### DELETE /api/sessions/:sessionId/status/:statusId

Delete one of the session's own posted statuses.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                                                             |
| --------- | ------ | ----------------------------------------------------------------------- |
| sessionId | string | WhatsApp session identifier                                             |
| statusId  | string | Id of the status to delete (the `statusId` returned by a `send-*` call) |

**Response** `200`

```json
{ "message": "Status deleted successfully" }
```

The service returns `void`; the controller returns a fixed success object. DELETE default status is `200`.

**Errors:** `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` `Session {id} not found or not connected`

### 6.4.8 Webhooks (management)

Webhooks are configured per session and managed under `/api/sessions/:sessionId/webhooks` (handled by `WebhookController`). Two cross-session endpoints live on `WebhooksListController`: `GET /api/webhooks` (list, **OPERATOR**) and `GET /api/webhooks/delivery-failures` (dead-letter log, **ADMIN**). Every other route requires an API key with **OPERATOR** role or higher.

Two fields — `secret` and `headers` — are **write-only**: they are accepted on create/update but are **never** returned in any response (the response DTO has no `@Expose` for them, so `fromEntity` drops them). The `secret` is used to compute the `X-OpenWA-Signature: sha256=<hex>` HMAC-SHA256 header on deliveries.

The `events` array accepts these members plus the `*` wildcard: `message.received`, `message.sent`, `message.ack`, `message.failed`, `message.revoked`, `message.reaction`, `message.edited`, `session.status`, `session.qr`, `session.authenticated`, `session.disconnected`, `session.reconnect_loop`, `session.restriction`, `presence.update`, `call.accepted`, `call.rejected`, `call.missed`, `group.join`, `group.leave`, `group.update`, `call.received`, `status.received`. All of them are actively dispatched by the engines.

#### GET /api/sessions/:sessionId/webhooks

List all webhooks for a session, ordered by `createdAt` descending.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                       |
| --------- | ------ | --------------------------------- |
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

| Name      | Type          | Description                                                                                                                                               |
| --------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sessionId | string        | Session ID. The lookup is `WHERE { id, sessionId }`, so a webhook belonging to a different session resolves to `404` (no cross-session existence oracle). |
| id        | string (uuid) | Webhook ID.                                                                                                                                               |

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

**Auth:** API key (OPERATOR) · **Scope:** session-scoped — derived from the authenticated key, not from any param/query

**Query parameters**

| Name     | Type             | Required | Default | Description                                                                                     |
| -------- | ---------------- | -------- | ------- | ----------------------------------------------------------------------------------------------- |
| `limit`  | integer (1-1000) | No       | `1000`  | Max webhooks to return; oversized/non-finite values are clamped/fallback to the default window. |
| `offset` | integer          | No       | `0`     | Webhooks to skip for paging; negative/non-finite values resolve to `0`.                         |

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

#### GET /api/webhooks/delivery-failures

List webhook deliveries that exhausted every retry, most recent first. This is the dead-letter trail referenced by §6.6 — a receiver outage longer than the retry window, an over-budget payload, or a blocked (SSRF-guarded) URL lands here instead of vanishing.

**Auth:** API key (ADMIN) · **Scope:** results are confined to the calling key's `allowedSessions`, so a session-restricted ADMIN key cannot read another session's rows via `sessionId`

**Query parameters**

| Name        | Type             | Required | Default | Description                                                                                                          |
| ----------- | ---------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | string           | No       | —       | Narrow to one session. A value outside the key's `allowedSessions` returns `[]` (no cross-session existence oracle). |
| `limit`     | integer (1-1000) | No       | `1000`  | Max records to return; oversized/non-finite values are clamped/fallback to the default window.                       |
| `offset`    | integer          | No       | `0`     | Records to skip for paging; negative/non-finite values resolve to `0`.                                               |

**Response** `200`

```json
[
  {
    "id": "8c0b1f2e-3d4a-5b6c-7d8e-9f0a1b2c3d4e",
    "webhookId": "f1e2d3c4-b5a6-7890-1234-567890abcdef",
    "sessionId": "my-session",
    "event": "message.received",
    "url": "https://your-server.com/webhook",
    "idempotencyKey": "msg_my-session_3EB0..._f1e2d3c4-b5a6-7890-1234-567890abcdef",
    "deliveryId": "dlv_0f8c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b",
    "attempts": 4,
    "lastStatusCode": 502,
    "lastError": "Request failed with status code 502",
    "createdAt": "2026-06-25T11:59:00.000Z"
  }
]
```

Bare array of `WebhookDeliveryFailure` rows, ordered by `createdAt` descending. `lastStatusCode` is `null` when the failure was a network/timeout/SSRF error rather than a non-2xx response; `idempotencyKey`/`deliveryId` let you correlate the lost event with your own receiver logs.

**Errors:** `401` missing/invalid API key · `403` key role below ADMIN

#### POST /api/sessions/:sessionId/webhooks

Create a webhook for the session.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                                                                                                              |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| sessionId | string | Session the webhook is scoped to; stored as `webhook.sessionId`. No session-existence check is performed at create time. |

**Request body** — `CreateWebhookDto`

| Field      | Type                   | Required | Constraints                                                                                                                                                                                                                                                                                                                                                            | Description                                                                                                                                             |
| ---------- | ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| url        | string                 | yes      | `@IsUrl({ require_tld: false })` (allows hostnames without a dot, e.g. `http://localhost:3000`); also run through the SSRF guard, which can reject with `400`. Entity column max 2048 chars.                                                                                                                                                                           | Webhook URL to receive events.                                                                                                                          |
| events     | string[]               | no       | `@IsArray`, `@ArrayMinSize(1)`, `@IsIn([...WEBHOOK_EVENTS, '*'], { each: true })`                                                                                                                                                                                                                                                                                      | Event names to subscribe to (see allowed set above). Defaults to `["message.received"]` when omitted.                                                   |
| secret     | string                 | no       | `@IsString`, `@MaxLength(255)`                                                                                                                                                                                                                                                                                                                                         | HMAC-SHA256 signing key. **Write-only** — never returned. Used for `X-OpenWA-Signature`. Defaults to `null`.                                            |
| headers    | Record<string,string>  | no       | `@IsHeaderMap()` — flat object (not array), ≤50 entries, names match `/^[A-Za-z0-9-]+$/`, values are strings ≤1024 chars with no C0 control/DEL (CR/LF injection guard).                                                                                                                                                                                               | Custom headers added to deliveries. **Write-only** — never returned. At delivery, `content-type` and `x-openwa-*` names are stripped. Defaults to `{}`. |
| filters    | WebhookFilters \| null | no       | `@IsValidWebhookFilters()` — `{ conditions: [...] }`; each condition `{ field, operator('is'\|'isNot'\|'contains'\|'equals'), value(string\|string[]\|boolean), caseSensitive?:boolean }`; bounds: max 20 conditions, 100 values/condition, 1000-char text values. Message fields: `sender`, `recipient`, `body`, `type`, `isGroup`, `fromMe`, `hasMedia`, `mentions`. | Optional AND pre-filter; **all** conditions must match for the webhook to fire. Omit/null = fire on every subscribed event. Defaults to `null`.         |
| retryCount | number (int)           | no       | `@IsInt`, `@Min(0)`, `@Max(5)`                                                                                                                                                                                                                                                                                                                                         | Delivery retry attempts on failure. Defaults to `3`.                                                                                                    |

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

**Errors:** `400` validation failure, unknown body field (whitelist), SSRF URL rejection, or the per-session webhook limit (`WEBHOOK_MAX_PER_SESSION`, default 16 — delete an existing webhook before registering another; webhooks already above the cap are grandfathered and keep working) · `401` missing/invalid API key · `403` insufficient role

#### PUT /api/sessions/:sessionId/webhooks/:id

Update a webhook. Partial — only fields present in the body are changed.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type          | Description                                                                                        |
| --------- | ------------- | -------------------------------------------------------------------------------------------------- |
| sessionId | string        | Session scope; the webhook is looked up by `(sessionId, id)` first → `404` if not in this session. |
| id        | string (uuid) | Webhook ID.                                                                                        |

**Request body** — `UpdateWebhookDto` (all fields optional; only fields where the value is not `undefined` are applied)

| Field      | Type                   | Required | Constraints                                                                                               | Description                                                                   |
| ---------- | ---------------------- | -------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| url        | string                 | no       | `@IsOptional`, `@IsUrl({ require_tld: false })`; re-runs the SSRF guard when provided → `400` if blocked. | New URL.                                                                      |
| events     | string[]               | no       | `@IsOptional`, `@IsArray`, `@ArrayMinSize(1)`, `@IsIn([...WEBHOOK_EVENTS, '*'], { each: true })`          | Same allowed set as create (incl. `*`).                                       |
| secret     | string                 | no       | `@IsOptional`, `@IsString`, `@MaxLength(255)`                                                             | **Write-only.** An empty string is normalized to `null`, which disables HMAC. |
| headers    | Record<string,string>  | no       | `@IsOptional`, `@IsHeaderMap()` (same constraints as create)                                              | **Write-only.** Replaces existing headers wholesale when provided.            |
| filters    | WebhookFilters \| null | no       | `@IsOptional`, `@IsValidWebhookFilters()`                                                                 | Set to `null` to clear filters.                                               |
| active     | boolean                | no       | `@IsOptional`, `@IsBoolean`                                                                               | Enable/disable the webhook. (Present only on update, not create.)             |
| retryCount | number (int)           | no       | `@IsOptional`, `@IsInt`, `@Min(0)`, `@Max(5)`                                                             | Retry attempts.                                                               |

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

| Name      | Type          | Description                                                    |
| --------- | ------------- | -------------------------------------------------------------- |
| sessionId | string        | Session scope; looked up first → `404` if not in this session. |
| id        | string (uuid) | Webhook ID.                                                    |

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

| Name      | Type          | Description                                                    |
| --------- | ------------- | -------------------------------------------------------------- |
| sessionId | string        | Session scope; looked up first → `404` if not in this session. |
| id        | string (uuid) | Webhook ID.                                                    |

**Response** `204`

No content (empty body; explicit `@HttpCode(204)`).

**Errors:** `401` missing/invalid API key · `403` insufficient role · `404` webhook not found in this session

### 6.4.9 API Keys

API keys are managed under `/api/auth/api-keys`. All management routes (create/list/get/update/delete/revoke) require an **ADMIN** key **with no session scope**: the controller is fenced with `@RequireUnscopedKey`, so a key whose `allowedSessions` is non-empty is rejected with `403` whatever its role — otherwise a confined admin key could mint an unrestricted one. The guard evaluates the role requirement _before_ that fence, so a scoped VIEWER/OPERATOR key is refused with `Insufficient permissions. Required: admin`; only a scoped ADMIN key reaches the fence and sees `Session-scoped API keys are not permitted on this route`. Both are `403`. The plaintext key string is returned **only once**, at creation. Validation of the caller's own key lives at `POST /api/auth/validate` (a separate controller, not fenced) and accepts any valid key.

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

**Errors:** `401` missing/invalid `X-API-Key` · `403` key role below ADMIN, or the key is session-scoped

#### GET /api/auth/api-keys/:id

Get a single API key's details by id. No plaintext key.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type          | Description                                         |
| ---- | ------------- | --------------------------------------------------- |
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

**Errors:** `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped · `404` `"API key with id '<id>' not found"`

#### POST /api/auth/api-keys

Create a new API key; returns the full plaintext key exactly once.

**Auth:** API key (ADMIN)

**Request body** — `CreateApiKeyDto`

| Field             | Type                                   | Required | Constraints                                                             | Description                          |
| ----------------- | -------------------------------------- | -------- | ----------------------------------------------------------------------- | ------------------------------------ |
| `name`            | string                                 | yes      | length 3–100                                                            | Friendly name for the key.           |
| `role`            | enum `admin` \| `operator` \| `viewer` | no       | `@IsEnum`                                                               | Defaults to `operator` when omitted. |
| `allowedIps`      | string[]                               | no       | each entry a valid **IPv4** address or IPv4 CIDR `/0-32`; IPv6 rejected | IP whitelist (IPv4-only by design).  |
| `allowedSessions` | string[]                               | no       | each `@IsString`                                                        | Session IDs this key may access.     |
| `expiresAt`       | string (ISO 8601 date)                 | no       | `@IsDateString`                                                         | Stored as a `Date`.                  |

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

**Errors:** `400` validation (bad `name` length, invalid `role` enum, non-IPv4 `allowedIps` entry, bad `expiresAt`, or any non-whitelisted body field) · `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped

#### PUT /api/auth/api-keys/:id

Update mutable fields of an API key. `isActive` is **not** updatable here — use the revoke route to deactivate.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type          | Description |
| ---- | ------------- | ----------- |
| `id` | string (uuid) | API key id. |

**Request body** — `UpdateApiKeyDto`

| Field             | Type                                   | Required | Constraints              | Description                                               |
| ----------------- | -------------------------------------- | -------- | ------------------------ | --------------------------------------------------------- |
| `name`            | string                                 | no       | length 3–100             | Applied only if truthy.                                   |
| `role`            | enum `admin` \| `operator` \| `viewer` | no       | `@IsEnum`                | Applied only if truthy.                                   |
| `allowedIps`      | string[]                               | no       | IPv4 address / CIDR only | Applied if not `undefined` (can be set to `[]` to clear). |
| `allowedSessions` | string[]                               | no       | each `@IsString`         | Applied if not `undefined`.                               |
| `expiresAt`       | string (ISO 8601 date)                 | no       | `@IsDateString`          | Applied if not `undefined`; empty/falsy clears to `null`. |

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

**Errors:** `400` validation (incl. `forbidNonWhitelisted` for unknown fields such as `isActive`) · `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped · `404` not found · `409` change would remove the last usable admin key

#### POST /api/auth/api-keys/:id/revoke

Revoke (deactivate) an API key without deleting it. No request body required.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type          | Description |
| ---- | ------------- | ----------- |
| `id` | string (uuid) | API key id. |

**Response** `200` — `ApiKeyResponseDto`

Sets `isActive` to `false` and returns the key with explicit HTTP `200`. After revoke, the key fails validation with `401 "API key is revoked"`.

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

**Errors:** `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped · `404` not found · `409` target is the last usable admin key

#### DELETE /api/auth/api-keys/:id

Permanently delete an API key (hard delete). Also drops any un-flushed usage accumulator.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type          | Description |
| ---- | ------------- | ----------- |
| `id` | string (uuid) | API key id. |

**Response** `204`

`@HttpCode(204)` — no response body.

**Errors:** `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped · `404` `"API key with id '<id>' not found"` · `409` target is the last usable admin key

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

### 6.4.10 System (Health, Metrics, Stats, Settings, Audit)

System endpoints expose operational status, Prometheus metrics, aggregate statistics, runtime settings, and the audit log. Health and metrics use non-standard auth (public / Bearer token); stats, settings and audit use the API key, with several routes gated to `ADMIN`.

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
# TYPE openwa_messages_total gauge
openwa_messages_total{direction="outgoing"} 1280
openwa_messages_total{direction="incoming"} 940
# TYPE openwa_messages_failed_total gauge
openwa_messages_failed_total 4
```

Values come from `StatsService.getOverview()` plus `process.memoryUsage()`/`process.uptime()`. The render is memoized for 5000 ms to avoid re-running the overview query on every scrape.

**Errors:** `401` — `METRICS_TOKEN` is configured but the bearer is missing or does not match (`{ "statusCode": 401, "message": "Invalid metrics token", "error": "Unauthorized" }`) · `404` — `METRICS_TOKEN` is unset/blank, so the endpoint is disabled (`{ "statusCode": 404, "message": "Metrics endpoint is disabled (set METRICS_TOKEN to enable)", "error": "Not Found" }`).

#### GET /api/stats/overview

Get overall cross-session aggregate statistics (sessions by status + message totals + today's counts).

**Auth:** API key (ADMIN) that is not restricted to specific sessions — a global cross-tenant aggregate, so a session-scoped key has no claim on it and is rejected with `403` (`@RequireUnscopedKey`).

**Response** `200`

```json
{
  "sessions": {
    "active": 2,
    "total": 3,
    "byStatus": { "ready": 2, "disconnected": 1 }
  },
  "messages": {
    "sent": 1280,
    "received": 940,
    "failed": 4,
    "today": { "sent": 42, "received": 30 }
  }
}
```

Notes: raw handler return (no envelope). `sessions.byStatus` is keyed by the stored `SessionStatus` values — lowercase, per §6.4.1 — with per-status counts; `sessions.active` counts only `ready`. `messages.sent`/`received` are all-time outgoing/incoming COUNTs; `failed` is the `FAILED`-status COUNT; `today.*` are the same counts since local midnight. Side effect: caches the `sessions` block via `CacheService`.

**Errors:** `401` — missing/invalid `X-API-Key` · `403` — key role below `ADMIN`, or the key is session-restricted.

#### GET /api/stats/messages

Get message statistics over a period: time series, counts by type, by session, and top chats.

**Auth:** API key (ADMIN) that is not restricted to specific sessions — a cross-session aggregate, so a session-scoped key is rejected with `403` (`@RequireUnscopedKey`).

**Query parameters**

| Name     | Type                     | Required | Default | Description                                                                                                                    |
| -------- | ------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `period` | `'24h' \| '7d' \| '30d'` | No       | `24h`   | Window for the report. `@IsIn(['24h','7d','30d'])` — any other value → `400`. Bucket interval is `hour` for `24h`, else `day`. |

**Response** `200`

```json
{
  "timeSeries": [
    { "timestamp": "2026-06-25 10:00:00", "sent": 12, "received": 8 },
    { "timestamp": "2026-06-25 11:00:00", "sent": 20, "received": 14 }
  ],
  "byType": { "chat": 180, "image": 24, "unknown": 3 },
  "bySession": [{ "sessionId": "9f1c…", "name": "support-line", "sent": 200, "received": 140 }],
  "topChats": [{ "chatId": "6281234567890@c.us", "messageCount": 320 }]
}
```

Notes: raw handler return. `timeSeries.timestamp` is a DB-formatted bucket string — hourly `YYYY-MM-DD HH:00:00` for `24h`, daily `YYYY-MM-DD` for `7d`/`30d` — sorted ascending. `byType` keys are message-type strings (a null type becomes `unknown`). `bySession.name` is `Unknown` when the session is not found. `topChats` is the top 10 by `messageCount` DESC. All counts are numbers.

**Errors:** `400` — `period` not in the enum, or any non-whitelisted query field (strict `whitelist` + `forbidNonWhitelisted`) · `401` — missing/invalid API key · `403` — role below `ADMIN`, or the key is session-restricted.

#### GET /api/stats/sessions/:sessionId

Get statistics for a single session: identity, message counts, top chats, and 24 h hourly activity.

**Auth:** API key — any valid key (VIEWER and up); there is no `@RequireRole`. Scope still applies: the global guard feeds the `:sessionId` route param to the key's `allowedSessions`, so a session-scoped key asking for a session outside its list gets `401 "API key not authorized for this session"`. Only an unscoped key can read any session's stats.

**Path parameters**

| Name        | Type   | Description                                                           |
| ----------- | ------ | --------------------------------------------------------------------- |
| `sessionId` | string | Session entity id. No format validation; `404` if no session matches. |

**Response** `200`

```json
{
  "session": { "id": "9f1c…", "name": "support-line", "status": "ready" },
  "messages": { "sent": 200, "received": 140, "today": 18, "failed": 1 },
  "topChats": [{ "chatId": "6281234567890@c.us", "count": 64, "lastActive": "2026-06-25 11:42:07" }],
  "hourlyActivity": [
    { "hour": 0, "sent": 0, "received": 0 },
    { "hour": 1, "sent": 3, "received": 2 }
  ]
}
```

Notes: raw handler return. `session.status` is the `SessionStatus` enum value. `messages.sent`/`received` are all-time outgoing/incoming COUNTs; `today` is the total message count since local midnight; `failed` is the `FAILED`-status count. `topChats` is the top 10 by count DESC, with `lastActive` = `MAX(createdAt)` as a DB-native datetime string. `hourlyActivity` always has 24 entries (hour `0..23`), missing hours zero-filled, computed over the last 24 h.

**Errors:** `401` — missing/invalid API key, or the key is not scoped to this session · `404` — session not found (`Session not found`).

#### GET /api/settings

Get application settings (environment-derived; `general`/`api`/`notifications` groups).

**Auth:** API key (ADMIN) that is not restricted to specific sessions. Settings describe the whole deployment, so the route requires an unrestricted key (`@RequireUnscopedKey`): the role check alone does not exclude a key confined to a subset of sessions, which has no claim on deployment-wide configuration, so a session-scoped ADMIN key is rejected with `403`. A key below `ADMIN` is also rejected with `403`.

**Response** `200`

```json
{
  "general": {
    "apiBaseUrl": "http://localhost:2785",
    "autoReconnect": true,
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

Notes: raw return of an in-memory `Settings` object built once in the controller constructor from `ConfigService` (snapshotted at construction, not re-read per request). `api.rateLimitWindow` is in ms. `enableDocs` reflects the `ENABLE_SWAGGER` gate (enabled by default outside production; disabled by default in production unless explicitly enabled). Only `notifications.*` is currently hardcoded (`emailEnabled: false`, `notificationEmail: ''`, `webhookAlerts: true`).

**Errors:** `401` — missing/invalid `X-API-Key` · `403` — API key lacks the ADMIN role, or the key is session-restricted.

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

#### GET /api/audit

List audit-log entries, newest first. Every API-key lifecycle change, session/message/webhook event and ADMIN infra operation lands here.

**Auth:** API key (ADMIN) · **Scope:** rows are confined to the calling key's `allowedSessions` — the `sessionId` query may only narrow within that list, never widen it

**Query parameters**

| Name        | Type                          | Required | Default | Description                                                                                                                   |
| ----------- | ----------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `action`    | string                        | No       | —       | Filter by `AuditAction` (e.g. `api_key_created`, `session_started`, `message_sent`, `webhook_failed`, `infra_data_imported`). |
| `severity`  | `'info' \| 'warn' \| 'error'` | No       | —       | Filter by `AuditSeverity`.                                                                                                    |
| `sessionId` | string                        | No       | —       | Narrow to one session. A value outside the key's `allowedSessions` returns `{ "data": [], "total": 0 }`.                      |
| `apiKeyId`  | string                        | No       | —       | Filter by the acting key's id.                                                                                                |
| `limit`     | integer                       | No       | `50`    | Page size, clamped to a maximum of `200`.                                                                                     |
| `offset`    | integer                       | No       | `0`     | Rows to skip; a negative value resolves to `0`.                                                                               |

**Response** `200`

```json
{
  "data": [
    {
      "id": "6b3f…",
      "action": "session_started",
      "severity": "info",
      "apiKeyId": "1c2d…",
      "apiKeyName": "dashboard",
      "sessionId": "9f1c…",
      "sessionName": "support-line",
      "ipAddress": "203.0.113.7",
      "userAgent": "curl/8.4.0",
      "method": "POST",
      "path": "/api/sessions/9f1c…/start",
      "statusCode": 200,
      "metadata": null,
      "errorMessage": null,
      "createdAt": "2026-06-25T11:42:07.000Z"
    }
  ],
  "total": 1
}
```

Unlike the other list routes this one is **not** a bare array: `data` is the page and `total` the unpaginated match count. Nullable columns (`apiKeyId`, `sessionId`, `metadata`, `errorMessage`, …) are `null` when the event has no such dimension.

**Errors:** `401` missing/invalid API key · `403` key role below ADMIN

### 6.4.11 Administration (Infrastructure, Plugins, MCP)

Admin-facing operations: infrastructure status & config, the data/storage migration tooling, plugin lifecycle, and the optional MCP transport. Almost every route is **API key (ADMIN)**; the two exceptions are the public `GET /api/infra/health` and the `POST /mcp` JSON-RPC endpoint (see end of section).

> Note on the infra/MCP request bodies: the `POST /api/infra/import-data` body and the entire `POST /mcp` envelope (mounted as a raw Express handler, outside the Nest pipe chain) are **plain TS interfaces, not class-validator DTOs** — the global `whitelist`/`forbidNonWhitelisted` ValidationPipe does **not** run on them. Unknown fields pass through silently and no type/constraint checks happen, except the few field-level guards noted per endpoint. The other infra bodies — `SaveConfigDto` (`PUT /api/infra/config`), `RestartDto` (`POST /api/infra/restart`), `ImportStorageDto` (`POST /api/infra/storage/import`) — and the plugin DTOs (`InstallFromUrlDto`, `PluginConfigDto`, `PluginSessionsDto`) _are_ class-validated and reject unknown fields with `400`.

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
  "database": { "connected": true, "type": "sqlite", "host": "", "builtIn": false },
  "redis": { "enabled": false, "connected": false, "host": "localhost", "port": 6379, "builtIn": false },
  "queue": {
    "enabled": false,
    "webhooks": { "pending": 0, "completed": 0, "failed": 0 }
  },
  "storage": { "type": "local", "path": "./data/media", "builtIn": false },
  "engine": {
    "type": "whatsapp-web.js",
    "headless": true,
    "sessionDataPath": "./data/sessions",
    "browserArgs": "--no-sandbox --disable-gpu",
    "webVersion": "2.3000.1040641150-alpha",
    "webVersionSource": "auto"
  }
}
```

The `queue.webhooks` counters are live BullMQ job counts (`pending` = waiting + active + delayed; plus `completed`/`failed`), degrading to zeros when the queue is disabled or Redis is unreachable. `redis.connected` is a live probe.

`builtIn` (on `database`/`redis`/`storage`) reports whether OpenWA's own bundled container is actually running _and_ backing this service, detected live from the labelled container; when Docker is unreachable it falls back to the saved `*_BUILTIN` intent from `data/.env.generated`. In S3 mode `storage` additionally carries `bucket` (when one is configured) and `s3Available` (a throttled re-probe); in local mode neither key is present. `engine.webVersion`/`engine.webVersionSource` (`pinned` / `auto` / `native`) appear only on `whatsapp-web.js`; `webVersion` is `null` until the auto-resolve first succeeds.

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
    "type": "sqlite",
    "builtIn": false,
    "host": "",
    "port": "",
    "username": "",
    "database": "",
    "schema": "public",
    "poolSize": 10,
    "sslEnabled": false,
    "sslRejectUnauthorized": true,
    "passwordSet": false
  },
  "redis": { "enabled": false, "builtIn": false, "host": "", "port": "", "passwordSet": false },
  "queue": { "enabled": false },
  "storage": {
    "type": "local",
    "builtIn": false,
    "localPath": "./data/media",
    "s3Bucket": "",
    "s3Region": "",
    "s3Endpoint": "",
    "s3CredentialsSet": false
  },
  "engine": {
    "type": "whatsapp-web.js",
    "headless": true,
    "sessionDataPath": "./data/sessions",
    "browserArgs": "--no-sandbox --disable-gpu"
  }
}
```

When `data/.env.generated` does not exist, empty-string/default values are returned (`schema='public'`, `poolSize=10`, `sslRejectUnauthorized=true`, `engine.type='whatsapp-web.js'`, `headless=true`).

**Errors:** `401` · `403`

---

#### PUT /api/infra/config

Merge-save infrastructure config to `data/.env.generated` (a `0600` secret file). A partial payload preserves untouched keys; empty/omitted secret fields keep the existing stored secret.

**Auth:** API key (ADMIN)

**Request body** — `SaveConfigDto` (recursively class-validated; unknown or mistyped fields are rejected)

| Field                                                 | Type                     | Required                 | Constraints                               | Description                                                                                                                             |
| ----------------------------------------------------- | ------------------------ | ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `database`                                            | object                   | No                       | —                                         | DB section (see nested)                                                                                                                 |
| `database.type`                                       | `'sqlite' \| 'postgres'` | If `database` is present | enum                                      | `sqlite` drops stale postgres keys; `postgres` writes connection keys                                                                   |
| `database.builtIn`                                    | boolean                  | No                       | —                                         | When `true`+postgres, forces the bundled `postgres` container creds + pushes `postgres` Docker profile                                  |
| `database.host` / `.port` / `.username` / `.database` | string                   | No                       | `port` is a string                        | External postgres connection (defaults `localhost`/`5432`/`postgres`/`openwa`)                                                          |
| `database.schema`                                     | string                   | No                       | —                                         | Postgres schema, saved as `POSTGRES_SCHEMA`; an empty value writes `public` (also forced to `public` when switching to the built-in DB) |
| `database.password`                                   | string                   | No                       | secret                                    | Empty/omitted keeps the existing stored secret                                                                                          |
| `database.poolSize`                                   | number                   | No                       | —                                         | Default 10                                                                                                                              |
| `database.sslEnabled`                                 | boolean                  | No                       | —                                         | Default false                                                                                                                           |
| `database.sslRejectUnauthorized`                      | boolean                  | No                       | —                                         | Only written when `sslEnabled` is true; default true                                                                                    |
| `redis.enabled` / `.builtIn`                          | boolean                  | No                       | —                                         | `builtIn`+enabled forces `redis` container + profile                                                                                    |
| `redis.host` / `.port`                                | string                   | No                       | `port` is a string                        | Defaults `localhost`/`6379`                                                                                                             |
| `redis.password`                                      | string                   | No                       | secret                                    | Empty keeps existing                                                                                                                    |
| `queue.enabled`                                       | boolean                  | No                       | —                                         | Writes `QUEUE_ENABLED`                                                                                                                  |
| `storage.type`                                        | `'local' \| 's3'`        | If `storage` is present  | enum                                      | `local` drops stale S3 keys; `s3` drops `STORAGE_LOCAL_PATH`                                                                            |
| `storage.builtIn`                                     | boolean                  | No                       | —                                         | `true`+s3 uses bundled MinIO defaults + pushes `minio` profile                                                                          |
| `storage.localPath`                                   | string                   | No                       | —                                         | Default `./data/media`                                                                                                                  |
| `storage.s3Bucket` / `.s3Region` / `.s3Endpoint`      | string                   | No                       | —                                         | External S3                                                                                                                             |
| `storage.s3AccessKey` / `.s3SecretKey`                | string                   | No                       | secret                                    | Empty keeps existing                                                                                                                    |
| `engine.type`                                         | string                   | No                       | **must be a known engine id, else `400`** | The only validated field in the body                                                                                                    |
| `engine.headless`                                     | boolean                  | No                       | —                                         | Default true; saved as `PUPPETEER_HEADLESS`                                                                                             |
| `engine.sessionDataPath`                              | string                   | No                       | —                                         | Default `./data/sessions`                                                                                                               |
| `engine.browserArgs`                                  | string                   | No                       | —                                         | Saved as `PUPPETEER_ARGS`                                                                                                               |

```json
{
  "database": {
    "type": "postgres",
    "builtIn": false,
    "host": "db.example.com",
    "port": "5432",
    "username": "openwa",
    "password": "s3cret",
    "database": "openwa",
    "poolSize": 10,
    "sslEnabled": true,
    "sslRejectUnauthorized": false
  },
  "redis": { "enabled": true, "builtIn": true },
  "queue": { "enabled": true },
  "storage": {
    "type": "s3",
    "builtIn": false,
    "s3Bucket": "my-bucket",
    "s3Region": "ap-southeast-1",
    "s3AccessKey": "AKIA...",
    "s3SecretKey": "...",
    "s3Endpoint": "https://s3.example.com"
  },
  "engine": {
    "type": "whatsapp-web.js",
    "headless": true,
    "sessionDataPath": "./data/sessions",
    "browserArgs": "--no-sandbox --disable-gpu"
  }
}
```

**Response** `200`

```json
{
  "message": "Configuration saved. Server restart required.",
  "saved": true,
  "envPath": "data/.env.generated",
  "profiles": ["postgres", "redis"]
}
```

Write/IO errors are caught and returned as HTTP `200` with `{ "saved": false, "envPath": "", "profiles": [], "message": "Failed to save configuration: …" }`. DTO validation, an unknown engine type, and CR/LF injection are real HTTP `400` responses. `profiles` lists newly-required Docker profiles.

**Errors:** `400` unknown/mistyped body field, missing nested `database.type`/`storage.type`, unknown
`engine.type`, or CR-LF in a value · `401` · `403`

---

#### POST /api/infra/restart

Request a graceful server restart, optionally orchestrating Docker profiles (add/remove services). Schedules process shutdown as a side-effect.

**Auth:** API key (ADMIN)

**Request body** — optional `RestartDto` (class-validated; unknown fields and non-string array members reject)

| Field              | Type     | Required | Default | Description                                                         |
| ------------------ | -------- | -------- | ------- | ------------------------------------------------------------------- |
| `profiles`         | string[] | No       | `[]`    | Docker profiles to enable/start (e.g. `postgres`, `redis`, `minio`) |
| `profilesToRemove` | string[] | No       | `[]`    | Docker profiles whose containers should be stopped/removed          |

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

Export every row of the 13 migration tables from the Data DB as JSON. Read-only, but runs raw `SELECT *` on the `data` DataSource.

**Auth:** API key (ADMIN)

The migration set (`MigrationTables`) is, in payload-key order: `sessions`, `webhooks`, `messages`, `messageBatches`, `templates`, `baileysStoredMessages`, `lidMappings`, `pluginInstances`, `conversationMappings`, `ingressEvents`, `webhookDeliveryFailures`, `integrationDeliveryFailures`, `statusUpdates`.

**Response** `200`

```json
{
  "exportedAt": "2026-06-25T12:00:00.000Z",
  "dataDbType": "sqlite",
  "tables": {
    "sessions": [
      {
        "id": "s1",
        "name": "main",
        "status": "ready",
        "phone": "15551234567",
        "pushName": "Me",
        "config": {},
        "proxyUrl": null,
        "proxyType": null,
        "connectedAt": "2026-06-25T00:00:00.000Z",
        "lastActiveAt": "2026-06-25T00:00:00.000Z",
        "createdAt": "2026-06-25T00:00:00.000Z",
        "updatedAt": "2026-06-25T00:00:00.000Z"
      }
    ],
    "webhooks": [],
    "messages": [],
    "messageBatches": [],
    "templates": [],
    "baileysStoredMessages": [],
    "lidMappings": [],
    "pluginInstances": [],
    "conversationMappings": [],
    "ingressEvents": [],
    "webhookDeliveryFailures": [],
    "integrationDeliveryFailures": [],
    "statusUpdates": []
  },
  "counts": {
    "sessions": 1,
    "webhooks": 0,
    "messages": 0,
    "messageBatches": 0,
    "templates": 0,
    "baileysStoredMessages": 0,
    "lidMappings": 0,
    "pluginInstances": 0,
    "conversationMappings": 0,
    "ingressEvents": 0,
    "webhookDeliveryFailures": 0,
    "integrationDeliveryFailures": 0,
    "statusUpdates": 0
  },
  "skippedTables": []
}
```

Rows are raw DB column shapes (e.g. `messageBatches` rows use snake_case columns: `batch_id`, `session_id`, `current_index`, `created_at`, …). **`webhooks` rows include `secret` in cleartext**, and `pluginInstances` rows carry integration secrets — treat the payload as a credential dump. On Postgres the generated `body_ts` FTS column is stripped from `messages` so archives stay dialect-neutral.

`sessions`/`webhooks` are queried directly, so a hard DB error there yields `500`. The other 11 are queried tolerantly: a _genuinely missing_ table (an older DB that has not run the migration) exports as `[]` and its name is listed in `skippedTables`; any other error (lock, I/O, timeout) fails the export rather than reporting the table as empty. Check `skippedTables` before restoring — a skipped table is "not migrated yet", not "exported empty".

**Errors:** `401` · `403` · `500` DB error

---

#### POST /api/infra/import-data

Replace all Data DB rows with the supplied export. **Destructive and transactional (all-or-nothing).**

> **The replace covers all 13 migration tables, not just the ones you send.** Inside the transaction every table in the migration set is emptied first and only then re-populated from the payload, so a table you omit ends up **empty**, not untouched. Always restore a payload produced by `GET /api/infra/export-data` of the same or a newer build — a hand-built body carrying only a subset silently wipes the rest.

**Auth:** API key (ADMIN)

**Request body** — inline `{ tables: Partial<MigrationTables>; force?: boolean; stopOrphans?: boolean }` (plain interface, not class-validated)

| Field                         | Type                | Required | Description                                                                                                                                                                  |
| ----------------------------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tables`                      | object              | Yes      | Container of per-table row arrays, keyed exactly as the export's `tables`. Accessing `data.tables` directly means a missing/null value throws `500`                          |
| `tables.sessions`             | `SessionRow[]`      | No       | Inserted first; a row whose `name` is not a safe directory name is skipped with a warning (which then rolls the whole restore back)                                          |
| `tables.webhooks`             | `WebhookRow[]`      | No       | Includes `secret`                                                                                                                                                            |
| `tables.messageBatches`       | `MessageBatchRow[]` | No       | snake_case columns                                                                                                                                                           |
| `tables.*` (the remaining 10) | `Row[]`             | No       | Same keys as the export; an omitted table restores **zero** rows into an emptied table                                                                                       |
| `stopOrphans`                 | boolean             | No       | Stop the running engines for sessions the backup does not contain, inside this request and before the replace (best-effort, time-bounded per engine). Preferred over `force` |
| `force`                       | boolean             | No       | Legacy escape hatch: proceed despite orphaned engines and leave them running until a process restart (`restartRequired: true`)                                               |

```json
{
  "tables": {
    "sessions": [
      {
        "id": "s1",
        "name": "main",
        "status": "ready",
        "phone": "15551234567",
        "pushName": "Me",
        "config": {},
        "proxyUrl": null,
        "proxyType": null,
        "connectedAt": "2026-06-25T00:00:00.000Z",
        "lastActiveAt": "2026-06-25T00:00:00.000Z",
        "createdAt": "2026-06-25T00:00:00.000Z",
        "updatedAt": "2026-06-25T00:00:00.000Z"
      }
    ],
    "webhooks": [],
    "messages": [],
    "messageBatches": [],
    "templates": [],
    "baileysStoredMessages": [],
    "lidMappings": [],
    "pluginInstances": [],
    "conversationMappings": [],
    "ingressEvents": [],
    "webhookDeliveryFailures": [],
    "integrationDeliveryFailures": [],
    "statusUpdates": []
  },
  "stopOrphans": true
}
```

**Response** `200`

```json
{
  "imported": true,
  "counts": {
    "sessions": 1,
    "webhooks": 0,
    "messages": 0,
    "messageBatches": 0,
    "templates": 0,
    "baileysStoredMessages": 0,
    "lidMappings": 0,
    "pluginInstances": 0,
    "conversationMappings": 0,
    "ingressEvents": 0,
    "webhookDeliveryFailures": 0,
    "integrationDeliveryFailures": 0,
    "statusUpdates": 0
  },
  "warnings": [],
  "notices": [],
  "restartRequired": false,
  "orphanedEngines": [],
  "stoppedOrphanEngines": [],
  "failedOrphanEngines": []
}
```

`warnings` are per-row import failures — they force a **rollback** and `imported:false`. `notices` are non-fatal operator messages (orphan-engine reconciliation detail) and never roll anything back. `restartRequired` is `true` when engines were left pointing at sessions the restore removed (`force`) or when an orphan teardown failed. `orphanedEngines` lists the session ids with a live engine the restored data no longer contains; `stoppedOrphanEngines`/`failedOrphanEngines` report how `stopOrphans` went.

**Orphan-engine pre-flight.** Before the transaction opens, any running engine whose session id is absent from `tables.sessions` is an orphan (the replace would delete its DB row, leaving an unstoppable engine writing into freshly restored tables). Default behaviour is to refuse with `409` listing those ids; `stopOrphans: true` stops them in-request and proceeds; `force: true` proceeds and leaves them running until restart.

Because that pre-flight runs _before_ the transaction, its teardown is not covered by the rollback. A response with `imported:false` therefore still reports the engines it really stopped, and `restartRequired` on that path means only that a teardown **failed** — a cleanly stopped orphan leaves its session row intact (restart it with `POST /sessions/{id}/start`), and an engine `force` left running was never orphaned after all, since the data that would have orphaned it was not replaced.

Inside the transaction every migration table is emptied. `webhooks` and `sessions` are DELETEd directly, so a missing table there fails the restore; the other 11 go through a tolerant helper where a _genuinely missing_ table is skipped. Any other DELETE failure propagates to the rollback. Rows are then re-inserted, sessions first. JSON object/array fields are auto-stringified before insert, and the Postgres-form `$N` placeholders are rewritten for SQLite. Two guards return `imported:false` after a rollback: any `warnings`, and a payload that restores **zero** rows in total (a wrong/empty backup would otherwise commit a silent wipe — the response then carries `Backup contained no rows to restore; refused to replace existing data. Check the file.`). On commit the lid→phone mirror is reloaded from the restored rows.

**Errors:** `401` · `403` · `409` refused, with the reason in `code` — `IMPORT_WOULD_ORPHAN_ENGINES` (live engines exist for sessions the backup does not contain; retry with `stopOrphans` or `force`), `IMPORT_ALREADY_RUNNING` (another import is running; wait for it), `IMPORT_NESTED_TRANSACTION` (another database transaction holds the connection; retry with nothing else in flight) · `500` `tables` missing/null or unrecoverable DB error

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

**Request body** — `ImportStorageDto` (class-validated; path-safety is additionally enforced manually)

| Field      | Type   | Required | Constraints                                                        | Description                                                     |
| ---------- | ------ | -------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `filePath` | string | Yes      | Must resolve inside `<cwd>/data` **and** exist on disk, else `400` | Path to the archive (constrained to `data/` to block traversal) |

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

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

**Response** `200` — single `PluginDto` (same shape as the list element, secrets redacted).

**Errors:** `401` · `403` · `404` `Plugin {id} not found`

---

#### GET /api/plugins/:id/config-ui

Serve a plugin's sandboxed config-UI entry HTML (for an opaque-origin iframe `srcdoc`; the dashboard
applies its document-specific CSP nonce to inline scripts and keeps any declared schema form available as fallback).

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

**Response** `200` — raw HTML (not JSON). Headers: `Content-Type: text/html; charset=utf-8`, `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`.

**Errors:** `401` · `403` · `404` plugin missing, no `configUi.entry`, file missing, or containment-check failure

---

#### GET /api/plugins/:id/health

Check a plugin's health (delegates to the loader / sandboxed workers).

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

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

| Field  | Type            | Required | Constraints                                  | Description                         |
| ------ | --------------- | -------- | -------------------------------------------- | ----------------------------------- |
| `file` | binary (`.zip`) | Yes      | ≤ 5 MB; must contain a valid plugin manifest | Form field name is literally `file` |

**Response** `201` — the newly installed `PluginDto`.

**Errors:** `400` no file / invalid package / install failed · `401` · `403` · `409` plugin id or directory already exists

---

#### POST /api/plugins/install-url

Install a plugin by downloading its `.zip` from an HTTPS URL (SSRF-guarded fetch: host validated, redirects followed with every hop re-validated through the guard and the chain capped at 5 hops, size-capped at `plugins.downloadMaxBytes`, default 5 MB). Plain `http://` is rejected — the package is executable code and must be integrity-protected in transit; private-network targets remain subject to the SSRF guard. A redirect hop that downgrades back to plain `http://` mid-chain is likewise refused (set `PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS=true` only if your vendor genuinely redirects that way); a chain over the cap fails with an explicit "too many redirects" error.

Optional content pinning: append `#sha256=<64 hex>` (URL fragment — never sent to the server) to require the downloaded bytes to match that digest; the fragment is the only honored marker — query params are deliberately ignored. A mismatch or a malformed marker fails the install closed; no marker means no verification (HTTPS + the SSRF guard are the baseline).

**Auth:** API key (ADMIN)

**Request body** — `InstallFromUrlDto` (class-validated; extra fields → `400`)

| Field | Type   | Required | Constraints                                              | Description                                                       |
| ----- | ------ | -------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| `url` | string | Yes      | `@IsUrl({ protocols:['https'], require_protocol:true })` | Absolute https URL of the package; optional `#sha256=` digest pin |

```json
{ "url": "https://github.com/openwa-plugins/chat-flow/releases/download/v1.0.0/chat-flow.zip" }
```

**Response** `201` — the newly installed `PluginDto`.

**Errors:** `400` invalid URL / download, integrity check, or package invalid · `401` · `403` · `409` already installed

---

#### POST /api/plugins/:id/enable

Enable a plugin.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

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

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

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

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

**Request body** — `PluginConfigDto` (class-validated; body must be exactly `{config:{…}}`)

| Field    | Type   | Required | Constraints   | Description                                                                                                 |
| -------- | ------ | -------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `config` | object | Yes      | `@IsObject()` | Whole config object. Masked/sentinel secret values mean "unchanged" and are restored from the stored config |

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

| Name        | Type   | Description                     |
| ----------- | ------ | ------------------------------- |
| `id`        | string | Plugin id                       |
| `sessionId` | string | Session the override applies to |

**Request body** — `PluginConfigDto`

| Field    | Type   | Required | Constraints   | Description                                                                                                                                         |
| -------- | ------ | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config` | object | Yes      | `@IsObject()` | Per-session override slice. Empty `{}` clears the override (falls back to base config). Masked secrets restored from the existing per-session value |

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

Set which sessions a session-scoped plugin is activated for. This is a **full replacement** of the plugin's global activation set: the supplied `sessions` array overwrites `activeSessions` in its entirety (not a merge), so an omitted session is deactivated and `[]` deactivates the plugin for every session.

**Auth:** API key (ADMIN) that is **not restricted to specific sessions** (`@RequireUnscopedKey`). Because the route replaces the whole activation set, a session-scoped key is rejected with `403` whatever it sends — even a request confined to its own `allowedSessions` would silently delete every other session's activation, so the fence refuses scoped keys before the handler runs. Use an unrestricted ADMIN key. (The per-session config override route `PUT /api/plugins/:id/config/:sessionId` is a different operation and stays scoped to the addressed session.)

**Path parameters**

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

**Request body** — `PluginSessionsDto` (class-validated)

| Field      | Type     | Required | Constraints                              | Description                                             |
| ---------- | -------- | -------- | ---------------------------------------- | ------------------------------------------------------- |
| `sessions` | string[] | Yes      | `@IsArray()`, `@IsString({ each:true })` | Session ids to activate for. `["*"]` = all, `[]` = none |

```json
{ "sessions": ["*"] }
```

**Response** `200` — the updated `PluginDto` (reflecting the new `activeSessions`).

**Errors:** `400` plugin is global · `401` · `403` key is session-scoped (full activation replacement requires an unrestricted key) · `404` unknown id

---

#### POST /api/plugins/:id/update

Update an installed plugin in place from a URL, preserving config + enabled state. The new package is written to a staging sibling and validated BEFORE the running plugin is stopped, then swapped in with two renames (live → backup, staging → live); a failure before or during the swap restores the previous version, and a process crash mid-swap is reconciled at boot (the backup is restored when the live directory is missing), so an interrupted update can never make the plugin silently vanish. Accepts the same optional `#sha256=` digest pin as `install-url` (fail-closed on mismatch).

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type   | Description                                      |
| ---- | ------ | ------------------------------------------------ |
| `id` | string | Plugin id (must match the package's manifest id) |

**Request body** — `InstallFromUrlDto` (class-validated)

| Field | Type   | Required | Constraints                                              | Description                                                                                  |
| ----- | ------ | -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `url` | string | Yes      | `@IsUrl({ protocols:['https'], require_protocol:true })` | Absolute https URL of the new `.zip` (SSRF-guarded download); optional `#sha256=` digest pin |

```json
{ "url": "https://example.com/plugins/chat-flow-1.1.0.zip" }
```

**Response** `201` — the updated `PluginDto`.

**Errors:** `400` download/package invalid, manifest id mismatch, or built-in plugin · `401` · `403` · `404` unknown id

---

#### DELETE /api/plugins/:id

Uninstall a plugin: dispatch its `onUnload` lifecycle hook, delete its files, drop its registry entry, and remove its `ctx.storage` data directory (`<dataDir>/plugins/<id>` — a separate tree when `PLUGINS_DIR` points outside the data dir). Built-in plugins are protected.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

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
- MCP is **read-only by default**: only read-tier tools are registered unless you set `MCP_READONLY=false` to expose write tools. Per-key sliding-window rate limit: `MCP_RATE_LIMIT_MAX` (default 60) per `MCP_RATE_LIMIT_WINDOW_MS` (default 60000).
- Stateless transport (no SSE/session id for normal calls).

**Request body** — JSON-RPC 2.0 envelope (validated by the MCP SDK, **not** the Nest ValidationPipe)

| Field     | Type                     | Required | Description                                                                                                        |
| --------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `jsonrpc` | string                   | Yes      | Must be `"2.0"`                                                                                                    |
| `id`      | string \| number \| null | No       | Request id echoed back; null/absent for notifications                                                              |
| `method`  | string                   | Yes      | `initialize`, `tools/list`, `tools/call`, plus MCP lifecycle methods. Unknown → JSON-RPC error `-32601`            |
| `params`  | object                   | No       | Method-specific. For `tools/call`: `{ name, arguments }` where `arguments` must match the tool's zod `inputSchema` |

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "session_send_text",
    "arguments": { "sessionId": "default", "to": "6281234567890", "text": "Hello from MCP" }
  }
}
```

**Response** `200` — JSON-RPC 2.0 envelope

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": { "content": [{ "type": "text", "text": "{\"success\":true,\"messageId\":\"…\"}" }] }
}
```

For `tools/call` the result is an MCP `CallToolResult` (`content` array of `text` or embedded base64 `resource` items — payloads over 4096 bytes become a `resource`). **Tool-level failures are returned in-band as `CallToolResult` with `isError:true`** (HTTP stays 200), including missing/invalid API key (`name:'UnauthorizedException'`) and rate-limit hits (`message:'MCP rate limit exceeded'`).

**Errors:** in-band JSON-RPC errors `-32601` (unknown method), `-32602` (invalid params / unknown tool), `-32700` (parse error), all at HTTP 200 · `500` only if the transport throws before headers are sent · `404` when `MCP_ENABLED` is not `true`

> The full catalog of MCP tools (names, tiers, schemas) is documented separately — see **doc 24, MCP Integration**. This section documents only the transport endpoint.

### 6.4.12 Search

Base path `/api/search`. Cross-session full-text message search over an open `SearchProvider` contract;
the built-in database full-text provider (PostgreSQL `tsvector`/`GIN`, SQLite `FTS5`) answers by
default with zero external dependencies. Search is on by default; set `SEARCH_ENABLED=false` to remove
the route and module entirely (the index is DB-maintained regardless — see
[26 - Global Search](./26-global-search.md)). Requires at least `OPERATOR` role.

**Auth:** API key (≥ `OPERATOR`) · **Scope:** session-scoped — a scoped key's `allowedSessions` is
injected server-side from the key (never from the query), so a scoped key cannot broaden its reach; an
ADMIN / null-allowlist key searches all sessions.

#### GET /api/search

Search messages across sessions (active search provider).

**Query parameters**

| Name        | Type                            | Required | Default | Description                                                                                                                                                                                   |
| ----------- | ------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`         | string                          | **Yes**  | —       | Search term. Must be non-empty after trim; whitespace-only is rejected with `400`. Passed to the active provider's native full-text matcher.                                                  |
| `sessionId` | string                          | No       | —       | Restrict to a single session id (intersected with the key's `allowedSessions` scope).                                                                                                         |
| `chatId`    | string                          | No       | —       | Restrict to a single chat id.                                                                                                                                                                 |
| `direction` | enum (`incoming` \| `outgoing`) | No       | —       | Filter by message direction.                                                                                                                                                                  |
| `type`      | string                          | No       | —       | Filter by stored message `type` (e.g. `text`, `image`, `video`). Compared against `messages.type`; not an enum validation, any string is accepted and unmatched values simply return no hits. |
| `from`      | string                          | No       | —       | Filter by sender.                                                                                                                                                                             |
| `dateFrom`  | integer (epoch ms)              | No       | —       | Inclusive lower bound on `timestamp`. A non-numeric value is rejected with `400`.                                                                                                             |
| `dateTo`    | integer (epoch ms)              | No       | —       | Inclusive upper bound on `timestamp`. A non-numeric value is rejected with `400`.                                                                                                             |
| `limit`     | integer (≥ 1)                   | No       | `50`    | Max hits to return. Clamped to `SEARCH_LIMIT_MAX` (default `100`). A non-numeric value is rejected with `400`.                                                                                |
| `offset`    | integer (≥ 0)                   | No       | `0`     | Pagination offset. A non-numeric value is rejected with `400`.                                                                                                                                |

**Response** `200` — `SearchResults`

```json
{
  "hits": [
    {
      "messageId": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
      "waMessageId": "true_62812...@c.us_3A...",
      "sessionId": "a1b2c3d4-...",
      "chatId": "6281234567890@c.us",
      "body": "full original message body...",
      "snippet": "...order <mark>confirmed</mark> for tomorrow…",
      "timestamp": 1751904000000,
      "type": "text",
      "direction": "incoming",
      "from": "6281234567890@c.us",
      "score": 0.075
    }
  ],
  "total": 23,
  "tookMs": 6,
  "provider": "builtin-fts"
}
```

- `snippet` is an XSS-safe text excerpt with `<mark>`/`</mark>` highlight markers around the matched
  term (both dialects emit the same markers). Render it as text, never as HTML.
- `total` is an exact count for pagination, computed lazily only when the returned page could be full.
- `provider` names which backend answered (e.g. `builtin-fts`); it is the registered `SearchProvider`
  id, so it changes when a plugin backend is selected via `SEARCH_PROVIDER`.
- `score` is optional and provider-specific (rank ordering is stable within a provider; cross-provider
  scores are not comparable).

**Errors:** `400` empty/whitespace `q`, a non-numeric `dateFrom`/`dateTo`/`limit`/`offset`, or a malformed
SQLite FTS5 query (unbalanced quote/paren, bare operator) — Postgres's `websearch_to_tsquery` is
tolerant and has no equivalent · `401` missing/invalid `X-API-Key` · `403` key role below `OPERATOR` ·
`501` no search provider configured (including a non-FTS5 SQLite build, where the provider is absent) ·
`503` active provider unhealthy (**reserved**: the built-in provider does not return it; it is the
contract surface for a future plugin provider whose `search()` throws `ServiceUnavailableException`).

> Scoping is authoritative: a scoped API key's `allowedSessions` is applied server-side and cannot be
> overridden via the query — there is no `sessionIds` query parameter, and `SearchService` overwrites
> any session scope at the provider boundary.

### 6.4.13 Profile (own account)

Manage the linked account's own profile. All routes are nested under `/api/sessions/:sessionId/profile` and require an **OPERATOR** key.

#### PUT /api/sessions/:sessionId/profile/name

Set the account display name (max 25 chars).

**Auth:** API key (OPERATOR)

```json
{ "name": "ACME Support" }
```

**Response** `200` — `{ "success": true, "message": "Profile name updated" }`

**Errors:** `400` session is not started / invalid name · `401` · `403` · `500` engine refused the change

#### PUT /api/sessions/:sessionId/profile/status

Set the account about/status text (max 139 chars; empty string clears it).

**Auth:** API key (OPERATOR)

```json
{ "status": "We reply within one business day" }
```

**Response** `200` — `{ "success": true, "message": "Profile status updated" }`

**Errors:** `400` session is not started / status too long · `401` · `403`

#### PUT /api/sessions/:sessionId/profile/picture

Set the account profile picture from a URL or base64 image (same media DTO conventions as message sends, §6.3).

**Auth:** API key (OPERATOR)

```json
{ "url": "https://example.com/avatar.png" }
```

or

```json
{ "base64": "iVBORw0KGgo...", "mimetype": "image/png" }
```

**Response** `200` — `{ "success": true, "message": "Profile picture updated" }`

**Errors:** `400` neither `url` nor `base64` provided / base64 without `mimetype` · `401` · `403` · `500` engine refused the change

### 6.4.14 Calls

Incoming-call management. A `call.received` webhook/socket event (§6.6) announces an incoming ringing call and carries the `callId` used below.

#### POST /api/sessions/:sessionId/calls/:callId/reject

Reject a currently ringing incoming call. Only a live call can be rejected — the id is valid while the call rings (a short server-side cache); afterwards it expires.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                            |
| --------- | ------ | -------------------------------------- |
| sessionId | string | Session ID                             |
| callId    | string | Call ID from the `call.received` event |

**Request body** — none.

**Response** `200` — `{ "success": true }`

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role · `404` call not found or no longer ringing

> **Auto-reject per session.** Set `"config": { "autoRejectCalls": true }` when creating a session to have the server reject every incoming call automatically — the `call.received` event is still dispatched first, so automations keep full visibility.

### 6.4.15 Media conversion (opt-in)

Server-side transcoding into the shapes WhatsApp clients actually play. Disabled by default; set
`MEDIA_CONVERSION_ENABLED=true`. The official Docker image already ships the `ffmpeg` binary these
endpoints run — on a source install it must be present, or they answer `503`.

Nothing is converted implicitly: sends behave exactly as before unless a caller runs media through
these endpoints first and posts the result.

> **Why voice conversion matters.** WhatsApp renders a playable voice-note bubble only for Ogg/Opus.
> Posting MP3 bytes to `send-audio` with `ptt: true` sends those bytes as they are, so the recipient
> gets a mic bubble that will not play. Converting first is what produces a real voice note.

#### GET /api/sessions/:sessionId/media/convert

Report whether conversion is both switched on and actually runnable here, so a client can choose
between converting server-side and converting before it sends.

**Auth:** API key

**Response** `200` — `{ "available": true }`

#### POST /api/sessions/:sessionId/media/convert/voice

Convert audio (or the audio track of a video) into a WhatsApp voice note: Ogg/Opus, mono, 48 kHz,
tuned for speech. Post the returned `base64` to `send-audio` with `ptt: true`.

**Auth:** API key (OPERATOR)

**Request body**

| Name   | Type   | Description                                             |
| ------ | ------ | ------------------------------------------------------- |
| url    | string | Public http(s) URL to fetch (server-side, SSRF-guarded) |
| base64 | string | Inline bytes. Takes precedence when both are given      |

Exactly one of `url` / `base64` is required. No `mimetype` is accepted: the input format is
identified from the bytes.

**Response** `200`

```json
{ "base64": "T2dnUwACAAAA...", "mimetype": "audio/ogg; codecs=opus", "bytes": 14970 }
```

**Errors:** `400` neither field given, or ffmpeg refused the input (its reason is included) · `401`
missing/invalid `X-API-Key` · `403` key lacks OPERATOR role · `413` media above the size cap · `503`
conversion disabled, or the binary is not runnable

#### POST /api/sessions/:sessionId/media/convert/video

Convert video into an MP4 every WhatsApp client accepts: baseline H.264 with AAC audio, long edge
bounded at 1280 (never upscaled), index moved to the front so playback can start before the whole
file arrives.

Request body and errors are identical to the voice endpoint.

**Response** `200`

```json
{ "base64": "AAAAIGZ0eXBpc29t...", "mimetype": "video/mp4", "bytes": 90660 }
```

**Size note.** Both endpoints return the converted media inline, so the response is bounded by the
same `MEDIA_CONVERSION_MAX_OUTPUT_BYTES` cap (default 50 MiB) — and a client posting it onward is
still bound by `BODY_SIZE_LIMIT` (default 25 MiB) on that next request.

### 6.4.16 Automation rules (autoreply)

Single-message autoreply rules, managed under `/api/sessions/:sessionId/automation-rules`
(`AutomationRuleController`). Every route requires an API key with **OPERATOR** role or higher.

When an inbound message arrives, the session's enabled rules are evaluated in order — creation
time, `id` as the same-second tiebreak — and the **first** rule whose `conditions` match replies
into the chat with its `replyText`. The reply goes through the ordinary send path, so send pacing
and plugin vetoes apply to it like any other outbound message. Evaluation is fire-and-forget off
the receive path and runs at most once per message (engine re-fires are deduplicated).

`conditions` uses the **webhook filter format** (`message` family — see 6.4.8): a flat AND list of
conditions over `sender`, `recipient`, `body`, `type`, `isGroup`, `fromMe`, `hasMedia`, `mentions`.
Omitted or empty conditions match every inbound message.

Loop safety: a rule never answers the account's own (`fromMe`) messages, messages older than
5 minutes get no automated answer (so a reconnect never burst-replies the offline-queued backlog),
and `cooldownSeconds` (default 60, `0` disables, max 86400) keeps the rule quiet per chat after it
fires. Be clear about what this guarantees: the cooldown **rate-bounds** an
autoreply-vs-autoreply exchange with another bot, it does not terminate one — and
`cooldownSeconds: 0` removes that bound entirely, so disable it only for rules whose conditions
cannot match another bot's replies. The cooldown state is in-process: it resets on restart.

#### POST /api/sessions/:sessionId/automation-rules

Create a rule. **Auth:** API key (OPERATOR)

**Request body**

| Field           | Type    | Required | Description                                                        |
| --------------- | ------- | -------- | ------------------------------------------------------------------ |
| name            | string  | yes      | Display name, max 100 chars.                                       |
| replyText       | string  | yes      | Reply content, max 4096 chars (the send-text limit).               |
| conditions      | object  | no       | Webhook-filter conditions (`message` family). Omitted = match all. |
| cooldownSeconds | number  | no       | Per-chat quiet period, 0–86400. Default `60`.                      |
| enabled         | boolean | no       | Default `true`.                                                    |

**Response** `201`

```json
{
  "id": "f1e2d3c4-b5a6-7890-1234-567890abcdef",
  "sessionId": "0d7a2a4e-...",
  "name": "Greet new enquiries",
  "enabled": true,
  "conditions": { "conditions": [{ "field": "body", "operator": "contains", "value": "price" }] },
  "replyText": "Thanks for reaching out — we reply within the hour.",
  "cooldownSeconds": 60,
  "createdAt": "2026-08-04T10:00:00.000Z",
  "updatedAt": "2026-08-04T10:00:00.000Z"
}
```

`400` — invalid conditions (unknown field/operator, over-limit values) or over-limit text.

#### GET /api/sessions/:sessionId/automation-rules

List the session's rules in evaluation order. **Auth:** API key (OPERATOR) · **Response** `200` — array of the shape above.

#### GET /api/sessions/:sessionId/automation-rules/:ruleId

Get one rule. **Auth:** API key (OPERATOR) · `200` or `404` when the rule does not belong to the session.

#### PUT /api/sessions/:sessionId/automation-rules/:ruleId

Partial update (any subset of the create fields). **Auth:** API key (OPERATOR) · `200` or `404`.

#### DELETE /api/sessions/:sessionId/automation-rules/:ruleId

Delete a rule. **Auth:** API key (OPERATOR) · **Response** `204`.

## 6.5 Real-time API (WebSocket)

Live events are delivered over a **Socket.IO** connection (not a raw WebSocket). The server mounts a single Socket.IO namespace, **`/events`**, on the same port as the REST API. There are no REST routes in this module.

### Connecting

Point a Socket.IO client at `<host>:2785` with path-less namespace `/events`:

```
ws://<host>:2785/events      (or wss:// behind TLS)
```

The client must authenticate during the Socket.IO handshake. Two sources are accepted, in this precedence order:

1. **Handshake `auth` (recommended)** — `io(url, { auth: { apiKey } })`. Not written to URLs or access logs.
2. **Header** — `x-api-key: <key>`.

> The former `?apiKey=<key>` query fallback was **removed** — it leaked the credential into proxy/access logs. Pass the key via the handshake `auth` field or the `x-api-key` header only.

If no key is supplied, or validation fails, the server emits an `error` message (`code: "UNAUTHORIZED"`) on the `message` event and immediately disconnects the socket. CORS for the namespace reuses the HTTP `CORS_ORIGINS` policy (dev allows any origin; production uses the allowlist).

### Protocol — client → server

All client commands are sent on the Socket.IO event named **`message`** using a single **flat** envelope:

```
{ type, sessionId, events, requestId }
```

| Field       | Type                                     | Applies to             | Description                                               |
| ----------- | ---------------------------------------- | ---------------------- | --------------------------------------------------------- |
| `type`      | `"subscribe" \| "unsubscribe" \| "ping"` | all                    | Command discriminator.                                    |
| `sessionId` | string                                   | subscribe, unsubscribe | A session id, or `"*"` for all sessions.                  |
| `events`    | string[]                                 | subscribe              | Event names to subscribe to, or `["*"]` for all.          |
| `requestId` | string (optional)                        | all                    | Echoed back on the matching server reply for correlation. |

A `ping` carries only `{ type: "ping", requestId? }`.

### Protocol — server → client

All server replies and pushed events also arrive on the Socket.IO event named **`message`**.

Command acknowledgements are **flat** and include an ISO-8601 `timestamp`:

```json
{
  "type": "subscribed",
  "sessionId": "main",
  "events": ["message.received", "session.status"],
  "requestId": "r1",
  "timestamp": "2026-06-25T10:00:00.000Z"
}
```

```json
{ "type": "unsubscribed", "sessionId": "main", "requestId": "r2", "timestamp": "2026-06-25T10:00:01.000Z" }
```

```json
{ "type": "pong", "requestId": "r3", "timestamp": "2026-06-25T10:00:02.000Z" }
```

```json
{
  "type": "error",
  "code": "FORBIDDEN_SESSION",
  "message": "API key is not authorized for this session",
  "requestId": "r1",
  "timestamp": "2026-06-25T10:00:00.000Z"
}
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
message.edited
session.status
session.qr
session.authenticated
session.disconnected
session.restriction
presence.update
group.join
group.leave
group.update
call.received
call.accepted
call.rejected
call.missed
status.received
```

A subscribe request whose `events` array contains no recognized name (after filtering) is rejected with `INVALID_EVENTS`. Unknown names mixed with valid ones are silently dropped; the `subscribed` reply echoes only the accepted events.

> `message.failed` and `session.reconnect_loop` are webhook-only — they are not subscribable on the socket.

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

socket.on('message', msg => {
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
  "data": {}
}
```

`event`, `timestamp` (ISO-8601 dispatch time), `sessionId`, `idempotencyKey`, and `deliveryId` are always present; `data` holds the event-specific payload. The same values are mirrored into request headers (below). The HMAC `signature` is **not** in the body — it travels in the `X-OpenWA-Signature` header.

### Event catalog

These are the events OpenWA actually emits. A webhook is registered with an `events` list; an event is delivered to a webhook when its `events` array includes the event name or `"*"`.

| Event                                             | When it fires                                                                                                                                                                                                                         | `data` payload sketch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.received`                                | An inbound message arrives                                                                                                                                                                                                            | The full message object: `id`, `from`, `to`, `body`, `type`, `timestamp` (epoch **seconds**), `isGroup`, `kind` (user-facing chat discriminator of `chatId` — `individual\|group\|channel\|status\|broadcast\|unknown`), `hasMedia`, `contact{…}` (plus optional `senderPhone` for `@lid` senders)                                                                                                                                                                                                                                                                                       |
| `message.sent`                                    | An outbound message is created/sent from this session                                                                                                                                                                                 | Same message object shape as `message.received`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `message.ack`                                     | A delivery/read receipt updates an outbound message                                                                                                                                                                                   | `{ id, messageId, status, ack }` — `status` is the canonical state (`pending`/`sent`/`delivered`/`read`/`failed`); `ack` is the deprecated legacy integer derived from it                                                                                                                                                                                                                                                                                                                                                                                                                |
| `message.failed`                                  | A receipt resolves to `failed` (dispatched in addition to `message.ack`)                                                                                                                                                              | `{ id, messageId, status: "failed", ack: -1 }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `message.revoked`                                 | A message is deleted/recalled                                                                                                                                                                                                         | `{ id, revokedId?, chatId, from, to, type: "revoked", body: "", timestamp }` — **reconcile on `revokedId`** (the original deleted message's id), falling back to `id`. On whatsapp-web.js `id` is the _revocation notification_ (a distinct message that won't match a stored id) and `revokedId` may be absent when the original isn't cached locally; on Baileys the two coincide                                                                                                                                                                                                      |
| `message.reaction`                                | A reaction is added, changed, or removed                                                                                                                                                                                              | `{ messageId, chatId, reaction, senderId, reactions }` — `reactions` is the post-apply `{ senderId: emoji }` snapshot; `reaction` is empty when removed                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `message.edited`                                  | A message body or media caption is edited                                                                                                                                                                                             | `{ messageId, chatId, body, senderId, from, to, fromMe, isGroup, type, hasMedia, author?, mentionedIds?, timestamp }` — `messageId` is the original message id, `body` is the latest text/caption, and `timestamp` is the edit occurrence time in epoch **seconds** (not the original creation time)                                                                                                                                                                                                                                                                                     |
| `session.qr`                                      | A new pairing QR is generated                                                                                                                                                                                                         | `{ sessionId, qr }` (raw QR string)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `session.authenticated`                           | The session pairs and becomes ready                                                                                                                                                                                                   | `{ sessionId, phone, pushName }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.disconnected`                            | The session disconnects on the engine or WhatsApp side (drop, conflict, or a phone-initiated unlink). Not fired for API-initiated stop/logout/delete — those are acknowledged by the API response and the `session.status` transition | `{ sessionId, reason }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session.reconnect_loop`                          | Every 5th consecutive reconnect attempt is scheduled (attempt 5, 10, 15, …) — the session is failing to come back up                                                                                                                  | `{ sessionId, attempts, nextDelayMs }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `presence.update`                                 | A subscribed chat's presence changed — someone came online, started typing, or stopped. Only actual CHANGES are dispatched: WhatsApp repeats itself freely, and every repeat would otherwise be a delivery                            | `{ sessionId, chatId, participants: [{ id, state, lastSeen? }], groupOnlineCount? }` — `state` is `available`/`unavailable`/`composing`/`recording`/`paused`; `lastSeen` is epoch **seconds** and absent when the contact hides it. Requires `POST .../presence/subscribe` first, and Baileys — whatsapp-web.js cannot observe presence                                                                                                                                                                                                                                                  |
| `session.restriction`                             | WhatsApp places a restriction on the account, or lifts one. Deduped: an unchanged restriction is not re-announced, and a lift is only sent when one was in force                                                                      | `{ sessionId, active, kind, code, expiresAt }` — `active` is `false` for a lift and `kind`/`code` then describe the restriction that ended; `expiresAt` is an ISO timestamp or `null`. See `restriction` on the session response for the `kind` values                                                                                                                                                                                                                                                                                                                                   |
| `session.status`                                  | The session status transitions                                                                                                                                                                                                        | `{ sessionId, status }` where `status` is one of `created` / `initializing` / `qr_ready` / `authenticating` / `ready` / `disconnected` / `action_required` / `failed`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `group.join`                                      | Participant(s) are added to or join a group this session is in                                                                                                                                                                        | `{ groupId, actorId?, participantIds, timestamp }` — `actorId` is the admin/inviter when known                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `group.leave`                                     | Participant(s) leave or are removed from a group                                                                                                                                                                                      | `{ groupId, actorId?, participantIds, timestamp }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `group.update`                                    | Group metadata changes (subject, description, announce/locked settings)                                                                                                                                                               | `{ groupId, actorId?, participantIds, changes?, timestamp }` — `changes` carries only the fields that changed: `subject?`, `description?`, `announce?`, `locked?`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `call.received`                                   | An incoming voice/video call starts ringing                                                                                                                                                                                           | `{ callId, from, isVideo, isGroup, timestamp }` — `callId` is the id to pass to `POST /sessions/:sessionId/calls/:callId/reject`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `call.accepted` / `call.rejected` / `call.missed` | A ringing call ended — answered, declined, or never picked up. **Baileys only**: whatsapp-web.js hooks the call collection's insert and sees no status at all, so it can report the ring but never its outcome                        | `{ sessionId, callId, from, outcome, isVideo, isGroup, timestamp }` — `callId` matches the `call.received` that preceded it, so the pair can be correlated. The engines report _what_ happened, never _who_ did it: an accept can come from any linked device. An outcome is only sent for a call this session saw ring, and offline-replayed signalling for calls that ended while disconnected is dropped. WhatsApp's `terminate` is deliberately unmapped — it covers both a caller hanging up before answer and either side ending an answered call, with nothing to tell them apart |
| `status.received`                                 | A contact posts a status/story (opt-in — see below)                                                                                                                                                                                   | `{ sessionId, statusId, contact: { id, name?, pushName? }, type, caption?, hasMedia, mediaOmitted, omitReason?, postedAt, expiresAt }` — `statusId` is the store's `id` (usable with the status endpoints below); `postedAt`/`expiresAt` are epoch **milliseconds** (unlike the epoch-seconds convention for message timestamps), matching the `GET /status` store's own `Date`-backed fields                                                                                                                                                                                            |

> **`status.received` is opt-in and carries no media blob.** Unlike every other event above, `status.received` is only delivered to a webhook whose `events` list explicitly includes `"status.received"` (or `"*"`) — registering for other events does not implicitly subscribe you to it. The payload never embeds media bytes: when `hasMedia` is `true`, fetch the file separately via `GET /api/sessions/:sessionId/status/:statusId/media`. Your own posted statuses never trigger this event — only inbound stories from contacts (an own-send echo is dropped before ingest).

> **`STORE_EPHEMERAL_MESSAGES=false` affects `message.received`.** When `STORE_EPHEMERAL_MESSAGES` is set to `false`, incoming disappearing messages (those with `ephemeralDuration > 0`) are **not** persisted nor dispatched — no DB insert, no webhook delivery, and no websocket event. Downstream consumers and the dashboard both stop seeing them. Default is `true` (backward compatible — store and dispatch everything).

> **Large media is not inlined into webhook payloads.** A `media` blob whose decoded size exceeds `WEBHOOK_MEDIA_INLINE_MAX_BYTES` (default **1 MiB**; `0` = never inline) is replaced — before the payload is fanned out to your webhook — with the marker form `media: { mimetype, filename?, omitted: true, sizeBytes }`, the same shape the engine emits for capped inbound media. Media at or under the cap stays inline unchanged. Additionally, if the serialized body still exceeds `WEBHOOK_MAX_PAYLOAD_BYTES` (default **1 MiB**) after `webhook:before` hooks ran, any remaining inline media is shed the same way so the event is still delivered; only a payload that is over budget _without_ inline media is dropped (recorded in `GET /api/webhooks/delivery-failures`). Because shedding happens before enqueue, queued and failed BullMQ jobs in Redis never carry the blob either — failed-job retention is bounded by the queue's `removeOnComplete`/`removeOnFail` windows (1h/1000 completed, 24h/5000 failed). Fetch the media itself afterwards via `GET /api/sessions/:sessionId/messages/:chatId/history?includeMedia=true` when you need it.

> There is **no** `contact.update` event. `presence.update` is emitted only for chats you have subscribed to (see the presence-subscription endpoint); call outcomes are reported as `call.accepted`, `call.rejected` and `call.missed` alongside `call.received`.

> **Group-event timing caveat (Baileys).** Membership/metadata changes that occurred while a Baileys session was offline are replayed by WhatsApp on reconnect and are dispatched like live events — but the engine does not forward their original occurrence time, so they carry the **receipt time** as `timestamp`. Treat `group.*` payloads as change notifications rather than a precise clock; stale offline _calls_ are never emitted this way (they are filtered by the `offline` flag).

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

| Header                     | Meaning                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `X-OpenWA-Event`           | The event name (mirrors `event`)                                                                             |
| `X-OpenWA-Idempotency-Key` | Content-derived key; **stable across retries** of the same occurrence — dedupe on this                       |
| `X-OpenWA-Delivery-Id`     | A fresh `dlv_<uuid>` generated **per delivery** (differs per retry and per webhook) — for tracing, not dedup |
| `X-OpenWA-Retry-Count`     | Retry attempt number (`0` = first attempt)                                                                   |
| `X-OpenWA-Signature`       | HMAC (only when a secret is set)                                                                             |

**Idempotency key derivation.** The key is content-derived so duplicates of the same logical event collapse to one value:

- `message.received` / `message.sent`: `msg_{sessionId}_{messageId}`
- `message.ack`: `ack_{sessionId}_{messageId}_{status}`
- `message.failed`: `failed_{sessionId}_{messageId}_{status}`
- `message.revoked`: `rev_{sessionId}_{messageId}`
- `message.edited`: `edit_{sessionId}_{messageId}_{occurredAt}`
- `message.reaction`: `react_{sessionId}_{messageId}_{senderId}_{occurredAt}`
- `session.qr`: `qr_{sessionId}_{hash(qr)}`
- `session.status`: `sess_{sessionId}_{status}_{occurredAt}`
- `session.authenticated`: `auth_{sessionId}_{hash(data)}_{occurredAt}`
- `session.disconnected`: `disc_{sessionId}_{hash(reason)}_{occurredAt}`
- `group.join` / `group.leave`: `grp_{groupId}_{hash(participantIds)}_{join|leave}_{occurredAt}`
- `group.update`: `grp_{groupId}_update_{hash(changes)}_{occurredAt}`
- `call.received`: `call_{sessionId}_{callId}` (a call id is unique per call, so no `occurredAt` salt)

Recurring lifecycle events (and `message.reaction` / `message.edited`) carry the same content across occurrences — the same phone on every reconnect, a constant disconnect reason, a re-applied emoji, or editing the same message multiple times — so they are salted with an `occurredAt` timestamp captured **once per dispatch and reused across that dispatch's retries**. This gives distinct occurrences distinct keys while keeping retries of one occurrence stable. Message keys are scoped by `sessionId` because WhatsApp message ids are unique per account, not globally.

### Retries with exponential backoff

When the queue is enabled, a non-2xx response, timeout (`WEBHOOK_TIMEOUT`, default `10000` ms), or network error schedules a retry. The number of attempts comes from the webhook's `retryCount` (default `3`) and the delay grows **exponentially** from a base of `WEBHOOK_RETRY_DELAY` (default `5000` ms). Each retry reuses the same `idempotencyKey` and increments `X-OpenWA-Retry-Count`. If Redis/BullMQ rejects the initial enqueue, OpenWA logs a `webhook:error` hook event and falls back to direct delivery with the same inline retry budget. When the queue is disabled, delivery is direct with the same retry budget applied inline.

### SSRF guard on registration

Webhook URLs are validated at **registration time**, not just at delivery. When SSRF protection is enabled (the default), creating or updating a webhook with a URL that resolves to a private/internal/loopback address is rejected synchronously with `400 Bad Request` instead of failing silently later at delivery. The `SSRF_ALLOWED_HOSTS` escape-hatch applies equally to registration and delivery. Operator-supplied custom headers that target reserved names (`Content-Type` or any `X-OpenWA-*`) are stripped, so a webhook config cannot forge the signature, event, or idempotency headers.

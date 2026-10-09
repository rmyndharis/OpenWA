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

> **Auth is header-only (never in a URL).** A query-parameter API key is **not** accepted anywhere. REST routes take the key via the `X-API-Key` header or `Authorization: Bearer <key>` (`X-API-Key` wins when both are sent); the WebSocket (Socket.IO) handshake — see §6.5 Real-time API — accepts it only via the handshake `auth.apiKey` field or the `X-API-Key` header. The former `?apiKey=` query fallback was **removed** (it leaked the credential into proxy/access logs). Never put the key in a URL.

Three kinds of route are public and take no API key. The metrics endpoint authenticates with `Authorization: Bearer <METRICS_TOKEN>` instead. The ingress routes (`/api/ingress/:pluginId/:instanceId/*`) verify each delivery with the route's own provider scheme (an HMAC signature or token; see §6.4.17). The health routes (`/api/health`, `/api/health/live`, `/api/health/ready`) and `GET /api/infra/health` take no credential at all.

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

A key may additionally be scoped to specific sessions (`allowedSessions`) and/or source IPs (`allowedIps`). The scope/IP check runs in the guard **before** any role check, so a request outside that scope is rejected with `403` even if the role would otherwise allow it. `401` is kept for a missing, unknown, revoked or expired key.

A key may also be restricted to selected chats (`allowedChats`: group `<id>@g.us`, contact `<phone>@c.us` or `<lid>@lid`, or a bare phone number, which is stored as `<phone>@c.us`). An empty or absent list leaves the key unrestricted. A chat-restricted key is **denied by default**: it may call only routes marked as chat-scoped, and every other route (webhooks, automation, status, channels, key management, and any route added later) answers `403 "API key is restricted to selected chats"` after the role check. On a chat-scoped route, every chat id the request names (a `:chatId` / `:groupId` / `:contactId` path param, `?chatId=`, a body `chatId` / `fromChatId` / `toChatId`, and each `messages[].chatId` of a bulk send) must be inside the allowlist, or the request answers `403 "API key not authorized for this chat"`; a contact entry also matches its mapped `@lid` form, and the reverse. The chat, group, contact and label-chat list routes (`GET /api/sessions/:sessionId/chats`, `/groups`, `/contacts` and `/labels/:labelId/chats`) return only the allowed entries, filtered before paging. `GET /api/search` with the built-in provider narrows its hits to the allowed chats before `limit`/`offset`/`total` apply, and an optional `?chatId=` must name an allowed chat. Plugin providers return `403` for these keys before the worker is invoked; set `SEARCH_PROVIDER=builtin-fts` to enable scoped search. `GET /api/sessions/:sessionId/groups/:groupId` and its `GET`/`PUT .../settings` admit a group inside the allowlist and answer `403` for any other. On `GET /api/sessions/:sessionId/messages` such a key must pass `?chatId=`; omitting it answers `403`. A `quotedMessageId` is refused with `403` everywhere except the reply route, which binds the quote to the chat it sends into. The `/events` WebSocket admits chat-restricted keys and delivers only chat events inside their allowlist. MCP tools enforce the same chat fence, filter list results before paging, and refuse tools without chat-scoped authorization. The Bull Board queue dashboard still refuses chat-restricted keys with `403`.

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

Errors use the NestJS default shape, published in `openapi.json` as the `ErrorResponse` schema. The HTTP status is on the status line and mirrored in `statusCode`:

```json
{
  "statusCode": 404,
  "message": "Session 'my-session' not found",
  "error": "Not Found"
}
```

A few refusals add a stable machine-readable `code`, so a client can branch without parsing `message`:

| `code`                          | Status | Meaning                                                                                                                                       |
| ------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_NAME_TEARDOWN_PENDING` | `409`  | The previous session's credential teardown under that name is still in flight; retry once it settles                                          |
| `SESSION_STOP_INCOMPLETE`       | `502`  | The engine did not confirm the stop; retryable                                                                                                |
| `SESSION_LOGOUT_INCOMPLETE`     | `502`  | The engine did not confirm the logout; retryable                                                                                              |
| `SESSION_FORCE_KILL_INCOMPLETE` | `502`  | The engine did not confirm the force-kill; its process may still be running                                                                   |
| `SEND_PACING_LIMITED`           | `429`  | Send pacing refused the send; the body also carries `retryAfterSeconds`                                                                       |
| `ENGINE_PAGE_ERROR`             | `500`  | whatsapp-web.js: WhatsApp Web rejected the operation in the page; the body also carries `pageError` and, when the page could read it, `build` |
| `IMPORT_ALREADY_RUNNING`        | `409`  | Another data import is in progress                                                                                                            |
| `IMPORT_WOULD_ORPHAN_ENGINES`   | `409`  | The backup lacks sessions running, starting or waiting to relaunch here; retry with `stopOrphans=true` or `force=true`                        |
| `IMPORT_NESTED_TRANSACTION`     | `409`  | Another database transaction is open on the connection; retry with no other data operation in flight                                          |
| `EXPORT_IN_PROGRESS`            | `409`  | A data export is in progress; retry the import after it finishes                                                                              |

Validation failures (`statusCode: 400`) return `message` as an **array** of field-level strings, with `error: "Bad Request"`, when field detail is enabled: by default outside production, or anywhere with `VALIDATION_ERROR_DETAIL=true`. Under `NODE_ENV=production` (the Docker image, compose and Helm default) detail is off unless that variable is set, and the body is only `{ "statusCode": 400, "message": "Bad Request" }`. Clients should accept `message` as either a string or an array of strings. A global `ValidationPipe` runs with `whitelist` + `forbidNonWhitelisted`, so any request-body field not declared on the DTO is rejected with `400`. A request whose path or query string contains `%00`, or whose body holds a NUL character (U+0000) in any string, is refused with `400` before the route runs. The body check does not cover three routes: `POST /api/infra/import-data` accepts a backup holding one and drops it from the stored text listed below and from template names, bodies, headers and footers and automation-rule names and replies, so a SQLite backup with a NUL there restores on PostgreSQL, the ingress route (`/api/ingress/:pluginId/:instanceId/:path`) reads its body raw and hands it to its plugin as delivered, and `POST /mcp` runs outside the Nest pipe chain, so a NUL in its tool input gets an in-band `BadRequestException` tool error instead of a `400`. Message text, captions, chat and contact names, media types and the account's own profile name received from WhatsApp, and dead-letter errors, are stored without NUL characters.

### General Error Codes

| HTTP Status | Meaning               | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`       | Bad Request           | DTO validation failed, unknown body field, a NUL character in the URL or (outside the import, ingress and MCP routes) the body, or a business precondition not met (e.g. session not active, media over cap)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `401`       | Unauthorized          | Missing/invalid/expired/revoked `X-API-Key` (or `METRICS_TOKEN` for metrics)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `403`       | Forbidden             | A valid key refused by its `allowedIps` (a blocked or undeterminable source IP) or used outside its `allowedSessions` scope, a key whose **role** is below the route's `@RequireRole` requirement, or a key with `allowedChats` that calls a route that is not chat-scoped, names a chat outside its allowlist, or sends a `quotedMessageId` outside the reply route (see Roles & Authorization); or WhatsApp itself refused an otherwise well-formed operation (for example a group write without admin rights), in which case the key is fine and each route's Errors line names the refusal; or, on an ingress `GET` verification challenge, the `verifyToken` did not match                                                                                                                                                                                                                                           |
| `404`       | Not Found             | The addressed resource (session, message, webhook, batch, …) does not exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `409`       | Conflict              | A uniqueness constraint was violated (e.g. duplicate name); a credential teardown for the same session name is still in flight on `start`/`delete` (retryable; body carries `code: 'SESSION_NAME_TEARDOWN_PENDING'`); or, on routes that reach a WhatsApp engine, the engine exists but is not ready yet (retryable; each route section carries the exact wording); or, on a multi-node deployment, another node currently owns the session's live engine (retryable)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `413`       | Payload Too Large     | The request body exceeds `BODY_SIZE_LIMIT`, or base64 or downloaded media exceeds the media byte cap (see §6.3), or the declared `Content-Length` is larger than the in-flight body budget, or the caller's share of it, could ever admit (not retryable, no `Retry-After`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `415`       | Unsupported Media     | The request has a body carrying a `Content-Encoding` other than `identity`; compressed request bodies are not accepted, as the aggregate body cap counts wire bytes. On the ingress route, also a body in a content type no parser reads (only `application/json` and `application/x-www-form-urlencoded` are read); that answer is the plain-text body `unsupported ingress content type`, not the JSON error shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `429`       | Too Many Requests     | A rate limit was exceeded: the per-client-IP tiers, the ingress per-instance limit, the concurrent bulk batch cap, or send pacing (body carries `code: 'SEND_PACING_LIMITED'` and `retryAfterSeconds`); honor `Retry-After` when present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `500`       | Internal Server Error | Send failed at the WhatsApp engine or an unexpected server error; when WhatsApp Web itself threw during a whatsapp-web.js send or status post, the body carries `code: 'ENGINE_PAGE_ERROR'`, `pageError` (`name`, `message`) and, when the page could read it, the WhatsApp Web `build`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `501`       | Not Implemented       | The operation is not supported by the active engine (see the capability matrix, docs/29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `502`       | Bad Gateway           | An engine transport failure (e.g. a dead Baileys socket; retryable), an upstream component returned something unusable (not retryable; each route section carries the exact wording), or, on a multi-node deployment, forwarding a session-scoped request to its owner node failed after the request may already have been sent, so a non-idempotent call must not be replayed blindly (see docs/13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `503`       | Service Unavailable   | A dependency or the session is not ready (boot draining or shutdown teardown, a datastore down, the engine reconnecting, a media `url` fetch through the session's egress proxy failing before any response, whether the proxy or the target is at fault), or WhatsApp did not answer an engine operation within its deadline; retryable, except that a write which timed out waiting for WhatsApp may still have been applied, so a non-idempotent call must not be replayed blindly (treat a `503` on a write as outcome-unknown unless the route section says repeating it is safe). On a multi-node deployment a forward that fails before reaching the owner node answers `503` and was not carried out (see docs/13); a `503` from the owner itself is relayed unchanged and keeps that route's meaning. Also answered, with `Retry-After`, when too many request bodies are in flight at once                      |
| `504`       | Gateway Timeout       | An upstream the gateway waits on did not answer in time: on a multi-node deployment, the owner node did not answer a forwarded session-scoped request within `SESSION_PROXY_TIMEOUT_MS`; on `POST /sessions/{sessionId}/start` (see §6.4.1), the engine did not finish starting within its timeout, either because initialization never finished at all (WhatsApp Web, the network or the session `proxyUrl` unreachable in a way that hangs the connection, or a browser stalled mid-startup, for example under a container memory or resource limit) or, on whatsapp-web.js, because its auth poll expired after the page loaded (typically an unreachable `proxyUrl`; on Baileys an unreachable proxy does not fail the start), and the message names which. On the forwarding path the request may still have been carried out on the owner node, so a non-idempotent call must not be replayed blindly (see docs/13) |

### Timestamp Conventions

OpenWA uses **two** timestamp representations — be careful which a field is:

- **Message timestamps are epoch numbers (Unix seconds), not ISO strings.** This applies to the `timestamp` field on messages returned by send responses, history, and persisted message records (the persisted column is stored as a bigint and surfaced as a `number`).
- **Entity audit fields use ISO-8601 UTC strings** (example: `2026-02-02T10:00:00.000Z`). This applies to `createdAt` / `updatedAt` on persisted entities, `expiresAt`, batch `startedAt` / `completedAt`, and similar metadata fields.

## 6.3 Media Specifications

### Media DTO (flat shape)

All media send routes (`send-image`, `send-video`, `send-audio`, `send-document`, `send-sticker`) share one **flat** request DTO — `SendMediaMessageDto`. There is **no** nested `{ image: { url } }` wrapper; the media source fields sit at the top level of the body:

| Field      | Type     | Required    | Constraints                                         | Description                                                                                                                                                                               |
| ---------- | -------- | ----------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatId`   | string   | yes         | non-empty                                           | Recipient — `<phone>@c.us` or `<groupId>@g.us`                                                                                                                                            |
| `url`      | string   | conditional | valid http/https URL; required when `base64` absent | Remote media URL. Fetched server-side through an SSRF guard; a blocked/internal URL, a non-2xx answer, a timeout or a failed connection yields `400`, a download over the media cap `413` |
| `base64`   | string   | conditional | required when `url` absent                          | Raw base64 media data. Decoded size is checked against the media cap                                                                                                                      |
| `mimetype` | string   | conditional | required when `base64` is used                      | MIME type, e.g. `image/jpeg`, `video/mp4`, `application/pdf`                                                                                                                              |
| `filename` | string   | no          | max 255 chars                                       | Optional file name (also used as the persisted body fallback for documents)                                                                                                               |
| `caption`  | string   | no          | max 1024 chars                                      | Optional caption (not persisted for audio)                                                                                                                                                |
| `mentions` | string[] | no          | array of WIDs                                       | WIDs to @mention in the caption (e.g. `["62811@c.us"]`). See **Mentions** below                                                                                                           |

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

There is a **single shared media byte cap**, not a per-type table. A base64 (or downloaded) media blob whose **decoded** size exceeds the cap is rejected with `413 Payload Too Large`. The cap is `MEDIA_DOWNLOAD_MAX_BYTES`, default **50 MiB (52,428,800 bytes)**; the same value bounds outbound base64 sends, remote-URL downloads, and inbound media. It takes a raw byte count, not a unit string, and the gateway refuses to boot on a non-positive or non-numeric value rather than falling back silently (`50mb` would parse to 50 bytes).

A whole request body is separately capped by `BODY_SIZE_LIMIT` (`25mb` by default), and base64 is about a third larger than the bytes it encodes, so with default settings a base64 send above roughly 18 MiB decoded is rejected with `413` by the body parser before the media cap applies. Raise `BODY_SIZE_LIMIT` to send larger base64 media, or send it by `url`.

### Text Limit

`send-text` enforces a maximum body length of **4096 characters** (`text` is `@MaxLength(4096)`). Media captions are limited to **1024 characters**.

### Mentions

`send-text`, the media send routes, `send-template`, `send-bulk` (per item), `reply` and `edit` all accept an optional `mentions` array of WIDs (`<phone>@c.us`) to tag participants — most useful in groups. On `edit` the tags are re-applied rather than preserved: an edit replaces the message content, so a rewritten body that still reads `@62811` loses the tag unless the list is sent again. Two things are required for WhatsApp to render a tag and notify the participant:

1. The `mentions` array lists the WID(s), e.g. `["62811@c.us"]`.
2. The `text`/`caption` contains the matching `@<number>` token, e.g. `Hello @62811`.

The contract is engine-neutral: pass neutral `@c.us` WIDs and the active engine (whatsapp-web.js or Baileys) de-normalizes them internally. Whether a mention surfaces a notification is ultimately client-side — outside a shared group some clients may not render it.

### Send response: `201` means accepted, not delivered

Single-recipient send routes under `/messages` return **HTTP 201** with `{ "messageId", "timestamp" }` as soon as the gateway hands the message to the WhatsApp client. This confirms the send was _accepted_ — it does **not** confirm the recipient received it. Two routes differ: `POST send-bulk` returns **202** with a batch envelope (`{ batchId, status, totalMessages, … }`), and the `status/send-*` routes return **201** with `{ statusId, timestamp, expiresAt }` — a `statusId`, not a `messageId`, and an ISO timestamp rather than epoch seconds.

Two consequences worth knowing:

1. **A number reported as unregistered is refused before sending.** Baileys checks a phone destination when it has no LID mapping: a negative answer returns `400`, and an unanswered lookup returns `503`. Known LIDs skip that query. whatsapp-web.js also returns `400` when it cannot resolve the recipient, which can include its first-contact limitation. Neither result guarantees that a registered recipient will receive the message.
2. **There is no synchronous delivery confirmation on either engine** (whatsapp-web.js or Baileys), so the `201` cannot be made to mean "delivered."

**Before sending to a new number**, you can confirm it is a registered WhatsApp account with `GET /api/sessions/:sessionId/contacts/check/:number` (returns `{ exists, whatsappId }`; needs an `OPERATOR` key, like the send itself; see the Contacts reference).

**For real delivery state**, track the stored message's `status`, which advances asynchronously as WhatsApp sends acks: `sent → delivered → read`, or `failed` when WhatsApp reports an error for the message — which also dispatches a `message.failed` webhook. See the message shape under the Messages reference.

A message resting at `sent` is **not** diagnostic on its own. It means no ack has advanced it yet, and a registered recipient whose device has not come online since the send stays at `sent` indefinitely too — that is the designed behavior, not a fault. Use `contacts/check` to tell an unregistered number apart from a registered one that simply has not received yet.

## 6.4 REST API Reference

Every path below is prefixed with `/api`. Unless marked **public**, send `X-API-Key: <key>`; `OPERATOR`/`ADMIN` annotations require a key of at least that role. Responses are the raw payload (no envelope); list endpoints return a bare array.

### 6.4.1 Sessions

Base path `/api/sessions`. All routes that return a session return data shaped by `SessionResponseDto.fromEntity` (via `transformSession`), which **strips** `config` and the raw credential-bearing `proxyUrl` / `proxyType` columns and renames the entity field `lastActiveAt` to `lastActive`. Masked proxy details are available from `GET/PATCH /api/sessions/:sessionId/proxy` only. Session `status` wire values are lowercase: `created | initializing | qr_ready | authenticating | ready | disconnected | action_required | failed`.

#### GET /api/sessions

List all sessions, scoped to the API key's `allowedSessions`, ordered `createdAt` DESC.

**Auth:** API key · **Scope:** session-scoped (a key with a non-empty `allowedSessions` sees only those sessions, whatever its role; a key with a null or empty `allowedSessions` lists all)

**Query parameters**

| Name     | Type             | Required | Default | Description                                                                                                                                                                                             |
| -------- | ---------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`  | integer (1-1000) | No       | `1000`  | Max sessions to return; oversized/non-finite values are clamped/fallback to the default window.                                                                                                         |
| `offset` | integer          | No       | `0`     | Sessions to skip for paging; negative/non-finite values resolve to `0`.                                                                                                                                 |
| `name`   | string           | No       |         | Return only the session with exactly this name (case-sensitive). No match, including a name outside a scoped key's `allowedSessions`, returns `200 []`. An empty value or a repeated key returns `400`. |

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

`lastError` can be non-null only when `status` is `failed` or `action_required`, or `initializing` from the fifth consecutive reconnect attempt of a session whose engine retries a dropped connection on its own (Baileys), until the session is ready or a QR arrives (a QR window that runs out unscanned is not an attempt), or `initializing` while a reconnect waits to retry after the engine failed to relaunch, carrying that failure's reason until the next attempt starts; any other status clears it. It is held in memory per process, so it reads `null` after a restart and on a node not running the session. `config` and the raw `proxyUrl` / `proxyType` columns are not present (stripped by `fromEntity`).

`restriction` reports a limit **WhatsApp itself** has placed on the account, as opposed to `lastError`, which describes a fault on the gateway's side of the link. It is `null` when there is none, and otherwise `{ kind, code, expiresAt }`:

| `kind`              | Meaning                                                                                                                                                                                   | Engine          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `reachout_timelock` | The account stays connected and existing chats keep working; WhatsApp blocks only the **start of new conversations**. `expiresAt` carries the end of enforcement when WhatsApp states it. | Baileys         |
| `tos_block`         | WhatsApp Web refuses the link on Terms-of-Service grounds (`TOS_BLOCK`, or `SMB_TOS_BLOCK` for a business account).                                                                       | whatsapp-web.js |
| `proxy_block`       | WhatsApp Web refuses the egress address the session connects from (`PROXYBLOCK`) — about the route, not the account.                                                                      | whatsapp-web.js |

`code` is the engine's own token for the cause, passed through verbatim (`TOS_BLOCK`, `BIZ_QUALITY`, `WEB_COMPANION_ONLY`, …), so a value newer than your gateway build still reaches you rather than being flattened. Because `tos_block`/`proxy_block` prevent the session from linking at all, neither can appear alongside a `ready` status; a `reachout_timelock` can, and usually does. Like `engineLoaded`, the field is derived from live engine state, never persisted, and re-established on the next connect. Changes are also delivered as the `session.restriction` webhook.

`engineLoaded` reports whether a node of the gateway holds a live engine for the session at the moment of the response: the process that answered, or, in a multi-node deployment, the node with a live claim on the session. It is the precondition the lifecycle routes enforce, and **`status` is not a substitute for it**: `disconnected` covers both a session whose engine is still registered while an automatic reconnect backs off — where `POST /start` answers `400` — and one stopped through `POST /stop`, which has no engine and does need a start. When `engineLoaded` is `true`, `stop`, `logout` and `force-kill` can act; when it is `false`, `start` is the applicable route. For a session another node holds, that assumes request routing (`NODE_URL` set on every node, see [13 - Horizontal Scaling](./13-horizontal-scaling.md)): the lifecycle routes are then forwarded to the owner and act there. Without routing only the owner can act on the session; on any other node `start` and `stop` answer `409` and `logout` and `force-kill` answer `400`. The field is derived per request from live state (this process's engines and the other nodes' session claims), so it is never persisted and never appears in historical/exported data.

**Errors:** `400` empty or repeated `name` · `401` missing/invalid `X-API-Key`

#### GET /api/sessions/:sessionId

Get a single session by ID.

**Auth:** API key · **Scope:** session-scoped (key's `allowedSessions` enforced against `:sessionId`)

**Path parameters**

| Name        | Type   | Description           |
| ----------- | ------ | --------------------- |
| `sessionId` | string | WhatsApp session UUID |

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
  "restriction": null,
  "engineLoaded": true
}
```

**Errors:** `401` missing/invalid key · `403` key not scoped to this session · `404` session not found

#### GET /api/sessions/:sessionId/config

Get the effective tunable configuration for a session. Only the three recognised keys are reported,
resolved through the same clamps the engine applies — the opaque stored `config` column is never
echoed back (it is stripped from `SessionResponseDto` alongside the raw `proxyUrl` column, and anything else placed
in it is stored but ignored).

**Auth:** API key · **Scope:** session-scoped (key's `allowedSessions` enforced against `:sessionId`)

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Response** `200`

```json
{ "autoRejectCalls": false, "maxReconnectAttempts": null, "reconnectBaseDelay": 5000 }
```

`maxReconnectAttempts: null` means unlimited (the default); `reconnectBaseDelay` is milliseconds.
Both bound the gateway's own reconnect, whose attempt count restarts only once the session has
stayed READY for 5 minutes, so a session that keeps dropping sooner than that spends its cap. On
Baileys that covers only the reconnect after a logged-out close: that engine retries a transient drop
internally, with a fixed 1s to 60s backoff and no attempt cap. See §5 (Database Design) for what each
key does and the moment it is read.

**Errors:** `401` missing/invalid key · `403` key not scoped to this session · `404` session not found

#### PATCH /api/sessions/:sessionId/config

Merge a patch into the session's tunable configuration. No restart is required or performed:
omitted keys keep their stored value, and an explicit `null` clears a key back to its default (the
only way back to unlimited reconnect attempts once a cap is set). `autoRejectCalls` is re-read on
every incoming call, so it applies immediately; the two reconnect settings are read once per start
and therefore apply on the next start, leaving a reconnect sequence already in flight alone.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Request body** — `UpdateSessionConfigDto` (any subset; each key also accepts `null`)

| Field                  | Type    | Constraints               | Description                                                                                                                                                                                      |
| ---------------------- | ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autoRejectCalls`      | boolean | none                      | Auto-reject every incoming call as soon as it rings (Baileys only)                                                                                                                               |
| `maxReconnectAttempts` | number  | integer, 0–20             | Reconnect attempt cap (`0` disables reconnect; `null` = unlimited). Bounds the gateway's own reconnect: every reconnect on whatsapp-web.js, and on Baileys only the one after a logged-out close |
| `reconnectBaseDelay`   | number  | integer, 1000–300000 (ms) | Base delay of the reconnect backoff, on the same engine scope                                                                                                                                    |

```json
{ "maxReconnectAttempts": 5 }
```

**Response** `200` — the resulting `SessionConfigResponseDto` (same shape as the GET above).

**Errors:** `400` a supplied value is outside its accepted range · `401` missing/invalid key · `403` key not scoped to this session, or key lacks OPERATOR role · `404` session not found · `409` the config kept changing under concurrent requests; retry

#### GET /api/sessions/:sessionId/proxy

Read a session's masked proxy configuration. Credentials embedded in the stored `proxyUrl` are **never** returned — only the parsed `proxyHost:port`, a `proxyType` derived from the URL scheme, and a `hasCredentials` flag.

**Auth:** API key · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Response** `200` — `SessionProxyResponseDto`

```json
{
  "enabled": true,
  "proxyType": "http",
  "proxyHost": "proxy.example.com:8080",
  "hasCredentials": true
}
```

When no proxy is configured, `enabled` is `false` and the other fields are `null`/`false`.

**Errors:** `401` missing/invalid key · `403` key not scoped to this session · `404` session not found

#### PATCH /api/sessions/:sessionId/proxy

Update per-session proxy settings. No restart is required or performed — changes apply on the **next** `POST /start`. Send `proxyUrl: null` to clear the proxy.

**Auth:** API key (ADMIN) that is not restricted to specific sessions. The proxy carries all of the session's egress, including the gateway's fetches of URLs a caller supplies, and its host is trusted egress that is not checked against internal addresses, so setting or clearing it is an administrator's decision. A key below ADMIN, or a session-scoped key, is rejected with `403` (`@RequireRole(ADMIN)`, `@RequireUnscopedKey`). Reading it (`GET` above) stays available to any key and never returns credentials.

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Request body** — `UpdateSessionProxyDto` (any subset; each key also accepts `null`)

| Field      | Type   | Constraints                                                                                                                                              | Description                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxyUrl` | string | `@IsOptional`; `@IsString`; max 255; `@IsUrl` (protocols `http`/`https`/`socks4`/`socks5`, `require_protocol`, `require_tld:false`, `allow_underscores`) | Per-session proxy egress; credentialed `http://user:pass@host` and single-label hosts allowed. Send `null` to clear. ⚠ **Must be a real, reachable proxy** when set — an unreachable value blocks the WhatsApp WebSocket on start: on whatsapp-web.js the start times out (~30s, 504); on Baileys the start succeeds and the session keeps retrying. |

```json
{ "proxyUrl": "http://user:pass@proxy.example.com:8080" }
```

**Response** `200` — the resulting `SessionProxyResponseDto` (same shape as the GET above).

**Errors:** `400` validation (bad `proxyUrl`) · `401` missing/invalid key · `403` key not scoped to this session, key lacks ADMIN role, or the key is restricted to specific sessions · `404` session not found

#### GET /api/sessions/:sessionId/qr

Get the QR code (PNG data URL) for session authentication.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Response** `200` — `QRCodeResponseDto`

```json
{
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "status": "qr_ready"
}
```

`status` is the session's current lowercase status.

**Errors:** `400` session not started / QR not ready yet / already authenticated · `401` · `403` · `404` not found

#### GET /api/sessions/:sessionId/groups

Get all groups the session is a member of (paginated).

**Auth:** API key · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

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

**Errors:** `400` session not started (engine not in memory) · `401` · `403` · `404` session not found · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### GET /api/sessions/:sessionId/chats

Get active chats for a session, most-recent first (paginated).

**Auth:** API key · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

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
    "lastMessage": "See you tomorrow",
    "lastMessageType": "text",
    "archived": false,
    "pinned": false,
    "muted": false
  }
]
```

`lastMessageType` uses the same engine-neutral types as messages, such as `text`, `image`, `voice`, and `document`. It identifies media even when `lastMessage` has no caption. The field is omitted when the engine has no last message available; on Baileys it becomes available after history sync or a new message.

`archived`, `pinned` and `muted` are the read side of the `chats/archive`, `chats/pin` and
`chats/mute` endpoints. `muted` is the verdict; `muteExpiration`, present only when `muted` is true,
is the instant the mute ends in epoch milliseconds (`0` = indefinite), the same unit as
`chats/mute`'s `muteUntil`, so a value read here can be written straight back.

Sorted by `timestamp` DESC (most recent first) then paginated. `timestamp` is an epoch number (seconds). `kind` is the user-facing chat discriminator — one of `individual|group|channel|status|broadcast|unknown`; `isGroup` is retained for back-compat (true only for `kind: "group"`).

On the Baileys engine the list is rebuilt after a restart: groups and chats with a persisted archive, pin or mute state come back at once, and any other 1:1 chat when its next message arrives. See `docs/29-engine-capability-matrix.md` §29.7 (`getChats` after a restart).

**Errors:** `400` session not started · `401` · `403` · `404` session not found · `409` session not connected (also answered for a few seconds while WhatsApp Web reloads its page and the engine re-injects) · `503` page connection died mid-read, or the command timed out

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

`byStatus` is keyed by lowercase status values. `memoryUsage` values are megabytes (`Math.round(bytes / 1024 / 1024)`). `active` = count of running engines on the node that answered; in a multi-node deployment it is that node's count, not the cluster's (see docs/13). A scoped key sees only its `allowedSessions` stats.

**Errors:** `401` missing/invalid `X-API-Key`

#### POST /api/sessions

Create a new WhatsApp session.

**Auth:** API key (OPERATOR) that is not restricted to specific sessions. Creating a session is a deployment-level act: the new session is outside the caller's `allowedSessions` by construction, so a session-scoped key is rejected with `403` (`@RequireUnscopedKey`). An unscoped OPERATOR/ADMIN key may create a session; setting `proxyUrl` requires an ADMIN key.

**Request body** — `CreateSessionDto`

| Field       | Type                                      | Required | Constraints                                                                                                                                                                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | string                                    | Yes      | `@IsString`; length 3–50; `@Matches(/^[a-zA-Z0-9-]+$/)` (letters, numbers, hyphens only)                                                                                      | Unique session name; duplicate → `409`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `config`    | object                                    | No       | `@IsOptional`; `@IsObject`; `autoRejectCalls`, `maxReconnectAttempts` and `reconnectBaseDelay` validated as on `PATCH /config` (400 naming the key); other keys not validated | Session settings. Only `autoRejectCalls` (boolean, Baileys only), `maxReconnectAttempts` (integer 0-20, default unlimited) and `reconnectBaseDelay` (ms, integer 1000-300000, default 5000) are read; other keys are stored but ignored. Change them later with `PATCH /api/sessions/:sessionId/config`. Defaults to `{}`; never returned in responses                                                                                                                     |
| `proxyUrl`  | string                                    | No       | `@IsOptional`; `@IsString`; max 255; `@IsUrl` (protocols `http`/`https`/`socks4`/`socks5`, `require_protocol`, `require_tld:false`, `allow_underscores`)                      | Per-session proxy egress; credentialed `http://user:pass@host` and single-label hosts allowed; trusted egress, not SSRF-blocked; setting it requires an ADMIN key (`403` otherwise). ⚠ **Must be a real, reachable proxy** — an unreachable value silently blocks the WhatsApp WebSocket (no QR; on whatsapp-web.js the start answers `504`, on Baileys it succeeds and the session keeps retrying); leave unset unless you need it. See "Per-session egress proxy" below. |
| `proxyType` | `http` \| `https` \| `socks4` \| `socks5` | No       | `@IsOptional`; `@IsIn([...])`                                                                                                                                                 | Deprecated and ignored: the `proxyUrl` scheme selects the proxy protocol                                                                                                                                                                                                                                                                                                                                                                                                   |

```json
{
  "name": "my-bot",
  "config": { "autoRejectCalls": false, "maxReconnectAttempts": 5, "reconnectBaseDelay": 5000 }
}
```

Minimal: `{ "name": "my-bot" }`.

**Optional — per-session egress proxy.** Route a session's traffic through a proxy only if your
network cannot reach WhatsApp directly. Set `proxyUrl` on the same request:

```json
{
  "name": "my-bot",
  "proxyUrl": "http://user:pass@your-real-proxy.host:8080"
}
```

> ⚠ `proxyUrl` **must point at a real, reachable proxy server.** A placeholder or unreachable value
> (e.g. `http://proxy.example.com:8080`) launches the engine pinned to a dead proxy, so the WhatsApp
> WebSocket never connects, **no QR code is ever delivered**, and `POST /api/sessions/:sessionId/start`
> returns `504 Gateway Timeout` after ~30s on whatsapp-web.js; on Baileys it succeeds and the session
> keeps retrying the connection. Leave `proxyUrl` unset unless you genuinely need a proxy.

On the Baileys engine the proxy carries everything the engine fetches over HTTP, on all four schemes: inbound
media, the WhatsApp Web version lookup, the history-sync and app-state payloads of the initial sync, and a
product card's `imageUrl`. SOCKS4 has no authentication step, so credentials in a `socks4://` URL are not a
login: the user name travels as the connect request's user id and the password is dropped, which a warning
says at session start. Use `socks5`, `http` or `https` for a proxy that needs a password.

A URL **you** supply is fetched through the session proxy too, on both engines: the media URL of a send, the
`url` of `POST /api/sessions/:sessionId/media/convert/voice|video`, and the link preview of a text send. The
session named in the request decides which proxy that is: the one its running engine started with, or, when
the session is not running, the one stored on its row. Set `SESSION_PROXY_URL_FETCH=false` to fetch those URLs
from the gateway's own address instead, for a proxy that only routes to WhatsApp. The SSRF guard applies
either way: the scheme and the destination are checked before any socket is opened, and the checked addresses
are what a SOCKS proxy is asked to connect to, in resolver order, so a proxy that routes only one address
family still reaches a dual-stack host (a `socks4` proxy is always given an IPv4 one, the only family that
protocol carries). Behind an HTTP or HTTPS proxy the destination is named to the proxy (in the `CONNECT` line
for an https URL, in the request line for an http one) and resolved by the proxy, so the connection there
cannot be pinned to the address that was vetted: a name that passes the check and then re-resolves to an
internal address reaches it, if the proxy can. Use a SOCKS proxy, or `SESSION_PROXY_URL_FETCH=false`, to keep
that DNS-rebinding protection.

Only an ADMIN key may set or clear a session proxy (`proxyUrl` here, or `PATCH /api/sessions/:sessionId/proxy`).
The proxy host itself is trusted egress chosen by the administrator: it is not checked against internal
addresses, so a loopback or private-network proxy works. The destinations of URLs you supply are checked
whichever proxy they go through.

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
  "restriction": null,
  "engineLoaded": false
}
```

Like every other session route, this returns the `SessionResponseDto` shape (via `fromEntity`), so `config`, `proxyUrl` and `proxyType` are stripped and `lastActiveAt` appears as `lastActive`. Newly created `status` is `created`. Masked proxy details come only from `GET /api/sessions/{sessionId}/proxy`.

**Errors:** `400` validation (bad `name`/`proxyUrl`/`proxyType`, or an extra non-whitelisted field) · `401` · `403` key lacks OPERATOR role, `proxyUrl` set by a key below ADMIN, or the key is restricted to specific sessions · `409` session name already exists

#### POST /api/sessions/:sessionId/start

Start a session and initialize the WhatsApp connection.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

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
  "restriction": null,
  "engineLoaded": true
}
```

Returned via `transformSession`. Status typically transitions to `initializing` / `qr_ready`.

A session stopped with `POST /stop` or `POST /force-kill` is marked to run again only once the start gets past the `400` and `409` refusals below; a refused start leaves the stop in place.

**Errors:** `400` session already started / already starting, or this node already holds `MAX_CONCURRENT_SESSIONS` slots, counting running and starting engines and sessions waiting to relaunch after a failed reconnect (`Maximum concurrent sessions reached (N)`, answered only after the `404` and the `409` for a session running on another node; the session is not started, so retry once a slot frees or on a node with room) · `401` · `403` · `404` not found · `409` credential teardown for the same session name still in flight (retryable; body carries `code: 'SESSION_NAME_TEARDOWN_PENDING'`; no destructive side effect runs before the refusal — a retry after cleanup settles proceeds), or another node currently holds this session's engine (refused before any engine is launched), or, with no `code`, a `POST /stop`, a `POST /force-kill` that found a running engine to kill, or a data import (`stopOrphans`) of this session that began or finished while the start was waiting, or a delete of it still running (the start yields and launches nothing; after a stop or force-kill a new `POST /start` clears it and starts the session, after a delete or an import that removed the session the retry answers `404`) · `503` the gateway is shutting down, or the engine's browser or socket connection died during launch and the one automatic retry failed too; no engine is left running, so the start can be retried · `504` the engine did not finish starting within its timeout (WhatsApp Web or the network unreachable, a stalled browser or resource limit, or, on whatsapp-web.js, an unreachable `proxyUrl`); the engine is torn down, so the start can be retried once the cause is addressed

#### POST /api/sessions/:sessionId/stop

Stop a session and disconnect WhatsApp.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

No request body.

**Response** `200`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "disconnected",
  "phone": "6281234567890",
  "pushName": "My Bot",
  "connectedAt": "2026-06-25T08:14:02.000Z",
  "lastActive": "2026-06-25T09:01:55.000Z",
  "createdAt": "2026-06-20T11:30:00.000Z",
  "updatedAt": "2026-06-25T09:10:00.000Z",
  "lastError": null,
  "restriction": null,
  "engineLoaded": false
}
```

Returned via `transformSession`; status typically becomes `disconnected`.

A stopped session stays down: boot auto-start (`AUTO_START_SESSIONS`) and the multi-node takeover sweep skip it until an explicit `POST /start`. The stop is recorded before the teardown, so a `502` stop keeps it too; a `409` refusal records nothing.

**Errors:** `401` · `403` · `404` not found · `409` another node currently holds this session's live engine (multi-node deployments) · `502` `SESSION_STOP_INCOMPLETE` — session stopped locally but the engine teardown did not complete (retryable; the graceful disconnect and the force-destroy escalation both failed, status `disconnected`, no success audit)

#### POST /api/sessions/:sessionId/logout

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
and a `502` logout clear `phone`, and a WhatsApp-initiated unlink reported by a running engine clears
it the same way, so none of those are auto-started on boot — an incomplete-logout (`502`)
session must be started explicitly and the logout retried by hand. A session stopped through
`POST /stop` or `POST /force-kill` is not auto-started either, until an explicit `POST /start`.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

No request body.

**Response** `200`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "disconnected",
  "phone": null,
  "pushName": "My Bot",
  "connectedAt": "2026-06-25T08:14:02.000Z",
  "lastActive": "2026-06-25T09:01:55.000Z",
  "createdAt": "2026-06-20T11:30:00.000Z",
  "updatedAt": "2026-06-25T09:11:00.000Z",
  "lastError": null,
  "restriction": null,
  "engineLoaded": false
}
```

Returned via `transformSession`; status becomes `disconnected` and `phone` is cleared (so the boot
auto-start does not resurrect the session). Recorded in the audit log as `session_logged_out`,
distinguishing an intentional unlink from a plain stop.

**Errors:** `400` session is not started (no engine to send through; the row is left untouched) · `401` · `403` · `404` not found · `502` `SESSION_LOGOUT_INCOMPLETE` — session stopped locally but the logout operation did not complete (retryable; `phone` cleared, no success audit)

#### POST /api/sessions/:sessionId/force-kill

Force-kill a stuck session (SIGKILL the wedged engine, then tear it down).

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

No request body.

**Response** `200`

```json
{
  "id": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "name": "my-bot",
  "status": "disconnected",
  "phone": "6281234567890",
  "pushName": "My Bot",
  "connectedAt": "2026-06-25T08:14:02.000Z",
  "lastActive": "2026-06-25T09:01:55.000Z",
  "createdAt": "2026-06-20T11:30:00.000Z",
  "updatedAt": "2026-06-25T09:12:00.000Z",
  "lastError": null,
  "restriction": null,
  "engineLoaded": false
}
```

Returned via `transformSession`.

Like `stop`, a force-killed session stays down across restarts and takeover until an explicit `POST /start`; a `400` refusal records nothing.

**Errors:** `400` session is not started (no live engine to kill) · `401` · `403` · `404` not found · `502` `SESSION_FORCE_KILL_INCOMPLETE`: session stopped locally but the engine force-kill did not complete (status `disconnected`, no success audit; a retry answers `400` because the engine is no longer registered, so restart the node to reap a leaked process)

#### POST /api/sessions/:sessionId/pairing-code

Request an 8-char pairing code to link via phone number (alternative to QR).

> ⚠️ **On the whatsapp-web.js engine, only request a code for a number you are prepared to re-link.** A request for a number that already has a linked session has been observed to end with WhatsApp revoking that device: the linked session logs a LOGOUT, its credentials are deleted, and it falls back to `qr_ready` with no phone. Nothing here refuses such a request: the guards check the session's state, never the number. The request runs inside the shared WhatsApp Web page and resets its linking mode before asking for a code, so the blast radius is the account rather than the session. Baileys was not affected in the same tests. Link by QR when a session of that number must stay up.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

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

**Errors:** `400` validation, or session not started, or already authenticated · `401` · `403` · `404` not found · `409` session not waiting to be linked yet; wait for `status` to read `qr_ready` and retry (after a code was accepted, wait for `ready` instead). On Baileys a session that already reads `qr_ready` can still answer `409` while its socket is closing, for up to the WebSocket close timeout (30 s); that is retryable and the status follows shortly. · `503` whatsapp-web.js only: the gateway stopped waiting after its attempt budget, usually because WhatsApp Web kept reloading its QR page; retryable, and the last attempt's reason rides in the message. An attempt that timed out may still have reached WhatsApp, and a retry starts the linking flow again, so the unlink warning above applies to the retry too.

#### POST /api/sessions/:sessionId/presence/subscribe

Ask WhatsApp to start reporting who is online or typing in a chat.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped · **Engines:** Baileys only

There is no synchronous answer: presence cannot be _fetched_ from either engine, only received.
Updates arrive as the `presence.update` webhook and socket event; the latest is readable at
`GET /api/sessions/:sessionId/presence/:chatId`.

Two properties to design around:

- **The subscription belongs to the connection.** It does not survive a restart or an automatic
  reconnect, and must be re-issued. The gateway does not silently replay subscriptions, because a
  replay would report a presence the account never actually asked for.
- **Subscribe per chat, not to everything.** WhatsApp emits an update on every transition — each time
  someone starts and stops typing — so a broad subscription is a firehose. Only genuine state
  _changes_ are dispatched onward, which bounds the event volume but not the socket traffic.

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Request body** — `SubscribePresenceDto`

| Field    | Type   | Required | Constraints                                                                                 | Description                                                                           |
| -------- | ------ | -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `chatId` | string | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace) | Engine-native JID, e.g. `1234567890@c.us` (wwebjs) or `1234@s.whatsapp.net` (Baileys) |

**Response** `200`

```json
{ "success": true }
```

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found · `501` the active engine cannot observe presence (whatsapp-web.js exposes only `sendPresenceAvailable`/`sendPresenceUnavailable`, which publish the account's _own_ presence, and emits no presence event) · `409` conflict or engine not ready (retryable) · `503` Baileys recipient lookup failed or timed out before the operation was sent

#### GET /api/sessions/:sessionId/presence/:chatId

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

#### PUT /api/sessions/:sessionId/presence

Set the account's OWN global presence: appear online or offline. WhatsApp routes notifications away
from the phone while a linked device announces itself online, so a headless bot that never goes
offline suppresses the phone's own alerts — `available: false` hands them back. Supported on both
engines.

A successful call is remembered for the life of the running engine and re-applied once each time
that connection opens, including a Baileys transient reconnect. Baileys announces itself on connect
(`available` unless `BAILEYS_MARK_ONLINE_ON_CONNECT=false`), which would otherwise replace the
caller's choice. The preference is dropped whenever the gateway replaces the engine: stop, restart,
reconnect recovery, a watchdog recycle, or a takeover by another node. Re-issue it after
`session.status` reports `ready` again. On Baileys, typing, recording and outbound sends do not
change global presence.

Not best-effort — a failure surfaces instead of leaving the account silently online. On Baileys a
`409` is also returned when the account push name has not synced yet: `sendPresenceUpdate` returns
without sending until `creds.me.name` is set, and the endpoint refuses that case instead of
reporting success.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Request body** — `SetOwnPresenceDto`

| Field     | Type    | Required | Description                                      |
| --------- | ------- | -------- | ------------------------------------------------ |
| available | boolean | Yes      | `true` = appear online, `false` = appear offline |

```json
{ "available": false }
```

**Response** `200`

```json
{ "success": true }
```

**Errors:** `400` session not started / validation · `401` · `403` key lacks OPERATOR role · `404` session not found · `409` engine not ready · `503` the whatsapp-web.js page died or did not answer within the protocol timeout (retryable)

#### POST /api/sessions/:sessionId/chats/read

Mark a chat as read/seen.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Request body** — `MarkChatReadDto`

| Field        | Type     | Required | Constraints                                                                                   | Description                                                                                                          |
| ------------ | -------- | -------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `chatId`     | string   | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace)   | Engine-native JID, e.g. `1234567890@c.us` (wwebjs) or `1234@s.whatsapp.net` (Baileys)                                |
| `messageIds` | string[] | No       | `@IsArray`; `@ArrayNotEmpty`; `@ArrayMaxSize(100)`; each a non-empty token with no whitespace | Messages to acknowledge. Omit the field to acknowledge only the newest received message; an empty array is rejected. |

Baileys acknowledges individual messages rather than chats, and the receipt enumerates ids instead of carrying a read-up-to watermark. Without `messageIds` only the newest received message the engine still holds in memory gets a receipt, so a burst leaves its earlier messages unread and a session restarted since the message arrived has nothing to acknowledge at all. Each supplied id is resolved through the message store, which is what carries the `participant` a group receipt needs. Ignored by whatsapp-web.js, whose own `sendSeen` is chat-level.

```json
{ "chatId": "1234567890@c.us", "messageIds": ["3EB0C767D26B8A3F1A2B", "3EB0C767D26B8A3F1A2C"] }
```

**Response** `200`

```json
{ "success": true }
```

Returns HTTP `200`, matching the OpenAPI contract.

> **`success: false` is a real outcome on the Baileys engine.** The read receipt is sent against the
> newest message the chat received, so a chat the session has received no message in (one holding
> only the account's own sends included) is reported as declined rather than marked read. The
> whatsapp-web.js engine reads the chat from the page and needs no local history, but it still
> answers `success: false` for a chat the page cannot find or when the page declines the read.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found · `409` the session is not connected (engine exists but is not `ready`) · `503` WhatsApp did not answer within the request budget, or the engine’s browser page died — the change may or may not have been applied

#### POST /api/sessions/:sessionId/chats/unread

Mark a chat as unread.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Request body** — `MarkChatUnreadDto`

| Field    | Type   | Required | Constraints                                                 | Description                               |
| -------- | ------ | -------- | ----------------------------------------------------------- | ----------------------------------------- |
| `chatId` | string | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` | Engine-native JID, e.g. `1234567890@c.us` |

This route takes `chatId` alone. It previously shared `MarkChatReadDto`, which is why the two are described separately now that the read body carries `messageIds`.

```json
{ "chatId": "1234567890@c.us" }
```

**Response** `200`

```json
{ "success": true }
```

Returns HTTP `200`, matching the OpenAPI contract.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found · `409` the session is not connected (engine exists but is not `ready`) · `503` WhatsApp did not answer within the request budget, or the engine’s browser page died — the change may or may not have been applied

#### DELETE /api/sessions/:sessionId/chats/:chatId/messages

Delete every message in a chat, keeping the chat itself in the list.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description                                                                           |
| ----------- | ------ | ------------------------------------------------------------------------------------- |
| `sessionId` | string | Session UUID                                                                          |
| `chatId`    | string | Engine-native JID, e.g. `1234567890-123@g.us`. URL-encode it if your client does not. |

**Response** `200`

```json
{ "success": true }
```

On success the gateway also removes its stored copies of the chat's messages (rows, inline and archived media, search entries) and emits `message:deleted` for each. Changes made on the phone are not mirrored.

> **`success: false` is a real outcome**, as with `chats/archive`: an unknown chat on
> whatsapp-web.js, or on Baileys a chat with no known history — the clear is an app-state
> modification keyed to the chat's last message.

**Errors:** `400` session not ready · `401` missing/invalid API key · `404` session not found · `409` the session is not connected (engine exists but is not `ready`) · `503` WhatsApp did not answer within the request budget, or the engine’s browser page died — the change may or may not have been applied

#### POST /api/sessions/:sessionId/chats/archive

Archive or unarchive a chat.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Request body** — `ArchiveChatDto`

| Field     | Type    | Required | Constraints                                                                                                                                              | Description                                   |
| --------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `chatId`  | string  | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace)                                                              | Engine-native JID, e.g. `1234567890-123@g.us` |
| `archive` | boolean | Yes      | `@IsBoolean` (strict: the exact strings `"true"`/`"false"` map to booleans; any other string such as `"0"` or `"no"` is rejected, not coerced to `true`) | `true` to archive, `false` to unarchive       |

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

**Errors:** `400` session not ready · `401` missing/invalid API key · `404` session not found · `409` the session is not connected (engine exists but is not `ready`) · `503` WhatsApp did not answer within the request budget, or the engine’s browser page died — the change may or may not have been applied

#### POST /api/sessions/:sessionId/chats/mute

Mute a chat's notifications until a given moment, or unmute it.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Request body** — `MuteChatDto`

| Field       | Type           | Required | Constraints                                                                                 | Description                                                     |
| ----------- | -------------- | -------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `chatId`    | string         | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace) | Engine-native JID, e.g. `1234567890-123@g.us`                   |
| `muteUntil` | number \| null | Yes      | `@IsInt`; `@Min(1)` when not `null`                                                         | Epoch **milliseconds** the mute expires at, or `null` to unmute |

```json
{ "chatId": "1234567890-123@g.us", "muteUntil": 1800000000000 }
```

```json
{ "chatId": "1234567890-123@g.us", "muteUntil": null }
```

**Response** `200`

```json
{ "success": true }
```

> **`muteUntil` is required, and `null` is not the same as omitting it.** The two plausible readings
> of a missing field — unmute, or mute forever — are opposites, so the endpoint rejects the omission
> with a `400` instead of guessing. Send `null` to unmute. To mute indefinitely, send a far-future
> timestamp: neither engine exposes a portable "forever" value (whatsapp-web.js uses `-1` internally,
> Baileys has none), so the API keeps one well-defined shape.

> **Milliseconds, not seconds.** This was measured against a live WhatsApp account rather than read
> off the protocol: the app-state field is the unsuffixed `MuteAction.muteEndTimestamp` while the same
> proto spells other millisecond fields `…Ms`, which reads as seconds and is wrong. A seconds-scale
> value is an instant in 1970, so the mute expires the moment it is set — and the request still
> answers `200`, because nothing in the chain rejects a timestamp in the past.

> **Unlike `chats/archive`, there is no declined outcome.** The mute change is not keyed to the chat's
> last message on either engine, so a chat with no known history mutes like any other. The response is
> always `{ "success": true }` or an error.

**Errors:** `400` session not ready, invalid `chatId`/`muteUntil`, or a `chatId` the whatsapp-web.js engine cannot resolve (the Baileys engine writes the mute without resolving the chat first and answers `success: true` for a chat that does not exist) · `401` missing/invalid API key · `404` session not found · `409` the session is not connected (engine exists but is not `ready`) · `503` WhatsApp did not answer within the request budget, or the engine’s browser page died — the change may or may not have been applied

#### POST /api/sessions/:sessionId/chats/pin

Pin a chat to the top of the chat list, or unpin it. Chat-level — distinct from
`messages/pin`, which pins a message inside a chat.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Request body** — `PinChatDto`

| Field    | Type    | Required | Constraints                                                                                                                                              | Description                                   |
| -------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `chatId` | string  | Yes      | `@IsString`; `@IsNotEmpty`; `@Matches(/^[^\s@]+@[^\s@]+$/)` (localpart@host, no whitespace)                                                              | Engine-native JID, e.g. `1234567890-123@g.us` |
| `pin`    | boolean | Yes      | `@IsBoolean` (strict: the exact strings `"true"`/`"false"` map to booleans; any other string such as `"0"` or `"no"` is rejected, not coerced to `true`) | `true` to pin, `false` to unpin               |

```json
{ "chatId": "1234567890-123@g.us", "pin": true }
```

**Response** `200`

```json
{ "success": true }
```

> **`success: false` means WhatsApp refused the pin, and only a pin can be refused.** WhatsApp allows
> at most **three** pinned chats. On the whatsapp-web.js engine a fourth pin returns `success: false`
> without changing anything. Unpinning always succeeds.

> **The Baileys engine cannot see that cap.** It writes an app-state patch and WhatsApp reports
> nothing back, so it answers `success: true` for every accepted request — including a fourth pin
> that WhatsApp may then decline on its own. Treat `true` on that engine as "the request was sent",
> not "the chat is pinned". Unlike `chats/archive` the patch is not keyed to the chat's last message,
> so a chat with no known history pins normally.

**Errors:** `400` session not ready, or a `chatId` the whatsapp-web.js engine cannot resolve (the Baileys engine answers `success: true` for a chat that does not exist) · `401` missing/invalid API key · `404` session not found · `409` the session is not connected (engine exists but is not `ready`) · `503` WhatsApp did not answer within the request budget, or the engine’s browser page died — the change may or may not have been applied

#### POST /api/sessions/:sessionId/chats/delete

Delete a chat from the chat list (e.g. a group you have left).

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

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

On success the gateway also removes its stored copies of the chat's messages (rows, inline and archived media, search entries) and emits `message:deleted` for each. Changes made on the phone are not mirrored.

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found · `409` the session is not connected (engine exists but is not `ready`) · `503` WhatsApp did not answer within the request budget, or the engine’s browser page died — the change may or may not have been applied

#### POST /api/sessions/:sessionId/chats/typing

Send a typing/recording presence indicator to a chat (or clear it with `paused`).

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

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

**Errors:** `400` validation, or session not started · `401` · `403` · `404` session not found · `409` conflict or engine not ready (retryable)

#### DELETE /api/sessions/:sessionId

Delete a session.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Path parameters**

| Name        | Type   | Description  |
| ----------- | ------ | ------------ |
| `sessionId` | string | Session UUID |

**Response** `204` — empty body (`@HttpCode(204)`, returns void). A `findOne` lookup runs first, so a missing id yields `404`.

The delete removes, in one transaction, the session's messages, message batches, chat states, received statuses, webhooks, templates, stored Baileys messages, automation rules, webhook outbox rows, webhook delivery-failure records and integration dead-letter rows, then purges its on-disk auth data. It keeps the audit log, the LID mappings, and the integration conversation mappings (so a re-paired session keeps its provider conversations); ingress dedup rows age out on their own after `INGRESS_DEDUP_RETENTION_DAYS` (default 7).

**Errors:** `401` missing/invalid key · `403` key not scoped to this session, or key role below OPERATOR · `404` session not found · `409` credential teardown for the same session name still in flight (retryable; body carries `code: 'SESSION_NAME_TEARDOWN_PENDING'`; on a `409` the row is **not** deleted and no hook/auth-purge runs — retry after cleanup settles), or, on a multi-node deployment, another node currently holds this session's live engine (no `code`; nothing is deleted; send the delete to the owning node)

### 6.4.2 Messages

All routes are mounted under `/api/sessions/:sessionId/messages`. Reads (`GET` history, batch status, reactions) accept any valid API key (including VIEWER). All write/send routes require **API key (OPERATOR)** or higher. Single-recipient send routes return `MessageResponseDto { messageId, timestamp }` (`timestamp` is an epoch **number** in seconds; there is no `status` field); `POST send-bulk` instead returns `202` with `BulkMessageResponseDto`. The global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so any body field not listed below is rejected with `400`.

#### Idempotent sends

The single-recipient send routes (`send-text`, `send-template`, `send-image`, `send-video`, `send-audio`, `send-document`, `send-location`, `send-contact`, `send-sticker`, `send-poll`, `reply`, `forward`) accept an optional `Idempotency-Key` request header, so a client can retry after a timeout or a dropped connection without sending the message twice. Without the header nothing changes.

The key is 1-255 visible ASCII characters (a UUID works), unique per session, and is held for **24 hours** from the first request. Within that window:

| Retry with the same key                                                                         | Answer                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| first request succeeded, same route and body                                                    | the first response again, with `Idempotent-Replayed: true`; nothing is sent                                |
| first request still running                                                                     | `409` `IDEMPOTENCY_KEY_IN_PROGRESS`; retry after it finishes                                               |
| first request failed with an uncertain delivery outcome                                         | `409` `IDEMPOTENCY_OUTCOME_UNKNOWN`: the message may have gone out; check the chat, then use a **new** key |
| first request was refused with `4xx` or `501` before calling the engine                         | the key was freed, so the retry runs as a new request                                                      |
| transport explicitly reported that nothing was sent, such as a Baileys recipient lookup timeout | the key was freed, so the retry runs as a new request                                                      |
| different route or body (key order in the JSON does not matter)                                 | `422` `IDEMPOTENCY_KEY_REUSED`                                                                             |

A malformed key, or the header sent twice, gets `400` `IDEMPOTENCY_KEY_INVALID`. A request still pending ten minutes after it was claimed (its node most likely stopped) also reads as `IDEMPOTENCY_OUTCOME_UNKNOWN`. HTTP status alone does not prove that nothing was sent: an engine can report `409` after attempting delivery, so engine-stage failures retain the key unless transport explicitly proves that nothing was sent. Keys are stored in the data database (`send_idempotency_keys`); concurrent processes using that database share the claim, and the session-owner proxy forwards the header. This does not change the deployment support limits in [Horizontal scaling](./13-horizontal-scaling.md). `send-bulk` does not take the header: retrying its request can create another batch. A call that outlives the 24-hour key window is outside the retry guarantee.

#### GET /api/sessions/:sessionId/messages

Get persisted message history for a session from the local DB (paginated, filterable). Reads the DB only — does not hit WhatsApp.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Query parameters**

| Name        | Type    | Required | Default   | Description                                                                                                                                                                                                                             |
| ----------- | ------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chatId      | string  | No       | —         | Filter by chat ID. Matched across `@c.us` / `@s.whatsapp.net` dialects via the lid-mapping table. Required for a key restricted to selected chats.                                                                                      |
| from        | string  | No       | —         | Filter by sender; matches `from` or a group message's `author`. A phone also matches any lid that resolves to it.                                                                                                                       |
| limit       | integer | No       | 50        | Clamped to `[1,100]`; a non-finite value falls back to 50.                                                                                                                                                                              |
| offset      | integer | No       | 0         | Clamped to `>=0`; a non-finite value falls back to 0.                                                                                                                                                                                   |
| after       | string  | No       | —         | Keyset cursor: the `id` of the last message of the previous page. Anchors the window to a row rather than a count, so a message arriving mid-walk cannot shift it. Takes precedence over `offset`. Unknown in this session gives `400`. |
| inlineMedia | boolean | No       | true      | Set `false` (or `0`) to omit every inline media payload, leaving each row's `{ omitted, sizeBytes }` marker and the media endpoint. The budget below is per response, so a paged walk pulls it afresh on every page.                    |
| messageId   | string  | No       | (none)    | Exact WhatsApp message reference within the session and optional chat filter.                                                                                                                                                           |
| since       | number  | No       | (none)    | Inclusive lower message-time bound, Unix epoch milliseconds.                                                                                                                                                                            |
| until       | number  | No       | (none)    | Exclusive upper message-time bound, Unix epoch milliseconds.                                                                                                                                                                            |
| direction   | string  | No       | (none)    | `incoming` or `outgoing`.                                                                                                                                                                                                               |
| type        | string  | No       | (none)    | Exact stored type token, such as `text`, `image` or `voice`; no search text required.                                                                                                                                                   |
| orderBy     | string  | No       | createdAt | Newest first by ingestion time (`createdAt`) or message time (`timestamp`).                                                                                                                                                             |

Time bounds accept decimal or scientific notation from 0 to 9007199254740991 milliseconds. Blank, malformed, non-finite, unsafe or reversed bounds return `400`. They compare against stored whole-second message times, with `since` inclusive and `until` exclusive. `orderBy=timestamp` uses the message UUID as its tie-breaker and excludes unknown message times. Without these options, ingestion-time ordering and existing stored rows are preserved.

With a time bound or `orderBy=timestamp`, `unknownTimestampTotal` counts rows matching all non-time filters whose message time is unknown. Those rows are excluded from `messages` and `total`. This describes stored history; exhausting a page does not prove complete remote WhatsApp history.

Keep the same filters and order when continuing with `after`. When using the new filters, the anchor must belong to the selected session, chat, sender, type, direction, message reference and time window. An unknown, deleted or mismatched anchor returns `400`. Concurrent older arrivals may appear on subsequent pages; pagination does not freeze the archive.

Example (stored messages for 2026-09-20 in Europe/Vienna):

```http
GET /api/sessions/:sessionId/messages?since=1789855200000&until=1789941600000&orderBy=timestamp&inlineMedia=false&limit=100
```

**Response** `200`

```json
{
  "messages": [
    {
      "id": "9f1c2e7a-2b3d-4c5e-8a91-0d1e2f3a4b5c",
      "sessionId": "3f6b2a1c-8d4e-4f7a-9b2c-5e1d0a7c6b48",
      "waMessageId": "true_628123456789@c.us_3EB0ABCD",
      "chatId": "628123456789@c.us",
      "from": "6281234567890",
      "to": "628123456789@c.us",
      "chatName": null,
      "author": null,
      "body": "Hello from OpenWA!",
      "type": "text",
      "direction": "outgoing",
      "timestamp": 1719312000,
      "metadata": null,
      "mediaPath": null,
      "mediaMimetype": null,
      "status": "sent",
      "createdAt": "2026-06-25T09:20:00.000Z"
    }
  ],
  "total": 1
}
```

Each `Message`: `{ id (uuid), sessionId, waMessageId (string|null), chatId, from, to, chatName (string|null; the sender's push name, or their saved contact name when no push name was reported), author (string|null; the real sender of a group, status or broadcast-list message, where from holds the group, status@broadcast or list id; on Baileys a list message the account received is filed under the sender, so from is the sender too), body (string|null), type, direction ('incoming'|'outgoing'), timestamp (number|null), metadata (object|null), mediaPath (string|null; storage key of archived media), mediaMimetype (string|null), status ('pending'|'sent'|'delivered'|'read'|'failed'), createdAt (ISO date) }`. By default, ordered by `createdAt` DESC, then by a dialect-dependent second key. The tiebreaker matters: `createdAt` is not unique (SQLite stores whole seconds, a PostgreSQL bulk write ties every row it inserts, and a history backfill carries WhatsApp's own second-resolution timestamp), and without a total order two pages of one walk can repeat a row and omit another. On SQLite the second key is `rowid`, the stored insertion sequence, so messages sharing a second come back in the order they arrived. PostgreSQL has no equivalent (`ctid` moves on every ack update), so it keeps `id`, a random uuid: the walk is equally correct there, but a same-second group is not in arrival order. Note that `offset` still addresses a position by count, so a list taking concurrent writes can shift under a walk: a message arriving mid-walk pushes every older row down one, and the next page re-serves a row the previous one already returned. Pass `after` instead to walk a live chat safely; it anchors on the last row you received, which an arriving message cannot move. The response is the raw service object (no envelope). Unlike the live `IncomingMessage` shape below, this persisted `Message` does **not** carry `kind` — re-derive the chat kind from `chatId` (see `ChatKind` / `chatKind()`) if needed. When present, `metadata` may include `media`, `quotedMessage`, `call`, `reactions`, and, for Baileys inbound business prompts, `buttons: [{ id, text }, …]` so a client (including the dashboard Chats thread) can re-render the choices after reload and tap them via [`POST .../click-button`](#post-apisessionssessionidmessagesclick-button).

> **Inline media is carried up to a budget, then omitted.** `MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES` (8 MiB of encoded base64 by default) bounds how much inline media one response may hold across its rows. A row is not a bounded object, `limit` is clamped to `[1,100]` but each row can carry its base64 in `metadata.media.data`, so a page of media rows could otherwise reach hundreds of megabytes and fail the read outright. The budget is spent newest-first, matching the selected descending order, so a page that cannot carry everything keeps the most recent media. Past it a payload is replaced with `{ mimetype, filename?, omitted: true, sizeBytes }`, the same marker the engine emits for inbound media over `MEDIA_DOWNLOAD_MAX_BYTES`, and the bytes remain available from [`GET /messages/:chatId/:messageId/media`](#get-apisessionssessionidmessageschatidmessageidmedia). Two rules bound the edges: the newest payload is always inlined even when it alone exceeds the budget (otherwise a single large photo would be permanently unreadable through this route), and a budget of `0` means "never inline" and grants no such allowance. The knob is validated at boot, `8MiB` would parse to 8 bytes, and is forwarded by both compose files. The MCP `MessageList` tool shares this path and the same budget. A row stored under `MESSAGE_INLINE_MEDIA=archive` arrives with the marker already in place, plus `archived: true`, its bytes live only in the chat-media archive, behind the same media route (see that route for the mode).

**Errors:** `400` invalid filters or an unknown or mismatched cursor · `401` missing/invalid API key · `403` a key restricted to selected chats sent no `chatId`, or one outside its allowlist

A blank `after` is treated as absent, the way a blank `limit` or `offset` already is, so a client
templating a cursor it has not got yet keeps the unfiltered first page rather than a `400`.

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

Returns a bare array of engine-neutral `IncomingMessage` objects: the chat's most recent `limit` messages, oldest first
(ascending `timestamp`).

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
    "author": "628123456789@c.us"
  }
]
```

Each item may also include `isStatusBroadcast`, `mentionedIds`, `isLidSender`, `ephemeralDuration` (the chat's disappearing-messages timer in seconds, present only when one is set), `contact`, `media { mimetype, filename?, data?, omitted?, sizeBytes? }`, `quotedMessage { id, body }`, `call { video, missed }` (for `call` messages), `location { latitude, longitude, description?, address?, url? }`, `order { orderId, token? }` (for `order` messages) and `product { productId, title?, description?, businessOwnerJid? }` (for `product` messages). `senderPhone` is **not** among them: this endpoint reads live from the engine and performs no privacy-id resolution, which runs only on the inbound `message.received` path (§6.6). To map an `@lid` sender seen here, call `GET /api/sessions/:sessionId/contacts/:contactId/phone`. `type` is one of `text|image|video|audio|voice|document|sticker|location|contact|poll|call|revoked|order|product|masked|unknown`. An `order` is a cart the customer placed from the business catalog and a `product` is a single catalog product shared into the chat. Only whatsapp-web.js serves this route (Baileys answers `501`), so every `order` and `product` block here comes from that engine. The message carries no line items and this API exposes no order lookup, so `orderId` plus the single-order `token` are a correlation handle you redeem elsewhere. The catalog routes answer `501` on whatsapp-web.js, so a `productId` read here does not resolve through them. whatsapp-web.js exposes no catalog field and cannot tell a share of a whole catalog from a product: a `product` message without a product id arrives with no `product` block. On Baileys the blocks arrive on `message.received`, where `GET /api/sessions/:sessionId/catalog/products/:productId` resolves a `productId` only when the product came from the session's own catalog (`businessOwnerJid` says whose it is), and a share of a whole catalog is typed `unknown`, both live and in the rows history sync stores. A Baileys `message.received` may also carry `button { id, text? }` when the sender tapped a WhatsApp Business button, template quick-reply, list row, or native-flow control (this live-history route never sees it, since Baileys answers `501` here). A `masked` message is one WhatsApp deliberately withholds from linked/companion devices — e.g. a high-security business OTP — so its `body` is empty by design (the content is only available on the primary phone) rather than a parsing failure; this occurs on the Baileys engine. `kind` is the user-facing chat discriminator of `chatId` — one of `individual|group|channel|status|broadcast|unknown`; it supersedes `isStatusBroadcast` (equivalent to `kind === 'status'`), which is retained for back-compat.

**Errors:** `400` session not active · `401` missing/invalid API key · `500` engine error · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine · `503` the whatsapp-web.js page died mid-read (retryable)

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

**Errors:** `400` session not active · `401` missing/invalid API key · `500` engine error · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine · `503` the whatsapp-web.js page died mid-read (retryable)

Poll creation messages include `poll { name, options, allowMultipleAnswers }` when the engine provides the choices. Live `message.received` and `message.sent` events and whatsapp-web.js history carry it at the top level. Stored-message responses carry the same object in `metadata.poll`, including polls sent through `send-poll`. The dashboard displays these option texts. Use the exact strings in `options` when voting; their order and whitespace are preserved.

Legacy stored polls may have no choices because they were captured before this field was stored. Vote counts are not included.

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
>
> A text that matches no option is ignored. When **none** of the texts match, the route answers `400`
> with `code: "POLL_OPTION_NOT_FOUND"` and the poll's exact texts in `validOptions`, and nothing is
> sent, so the current vote stays. (Before, whatsapp-web.js sent an empty selection, which cleared the
> vote, and the route answered `200`.) Send `[]` to clear the vote on purpose.

> **Only recent polls can be voted on.** The poll must be within the 100-message window the engine
> fetches for the chat — the same limit that applies to react/delete/edit/pin. An older poll comes
> back `404`.

> **Baileys returns `501`.** The library exposes no vote-send helper at all — only `decryptPollVote`
> for _receiving_ votes. Sending one requires hand-building a `PollUpdateMessage` with HMAC-SHA256
> vote encryption keyed by the poll creation's `messageSecret`, which is not wired here.

**Errors:** `400` session not active, the target message is not a poll, or none of the option texts match the poll (`POLL_OPTION_NOT_FOUND`) · `401` missing/invalid API key · `403` key lacks OPERATOR role · `404` poll not found in recent history · `501` Baileys engine · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-request; repeating it is safe (retryable)

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

**Errors:** `400` session not active, or `durationSeconds` outside the three accepted values · `401` missing/invalid API key · `403` the whatsapp-web.js engine refused the pin (in a group only admins may pin; the Baileys engine has no acceptance signal and answers `200`) · `404` message not found in the chat · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-request; a retry is safe but restarts the pin duration

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

**Errors:** `400` session not active · `401` missing/invalid API key · `404` message not found in the chat · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

#### POST /api/sessions/:sessionId/messages/unpin

Remove a message's pin. Takes no duration.

**Auth:** API key (OPERATOR)

**Body**

| Field     | Type   | Required | Description                 |
| --------- | ------ | -------- | --------------------------- |
| chatId    | string | yes      | Chat containing the message |
| messageId | string | yes      | Message to unpin            |

**Response** `200` — `{ "success": true }`

**Errors:** `400` session not active · `401` missing/invalid API key · `403` the whatsapp-web.js engine refused the unpin (in a group only admins may unpin; the Baileys engine has no acceptance signal and answers `200`) · `404` message not found in the chat · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-request; repeating it is safe (retryable)

#### GET /api/sessions/:sessionId/messages/:chatId/:messageId/media

Download a message's **stored** media bytes.

The route serves the chat-media **archive** first, and falls back to the **inline base64 copy** on
the message row when no archived file is servable. Archiving is **opt-in and off by default**
(`CHAT_MEDIA_ARCHIVE_ENABLED`); when enabled, each inbound message's media is written to whatever
backs `StorageService` (local disk or S3) in addition to the inline copy. Media **sent by this
account** is archived too when `CHAT_MEDIA_ARCHIVE_OUTBOUND=true` is set alongside it — off by
default, since it doubles storage again for the outbound half.

Media sent by this account is downloadable here regardless of that flag, because its payload is
stored inline: base64 API sends persist it on the send path, and media composed on a linked phone is
downloaded by the engine for the own-send echo. The flag buys a durable copy with its own lifecycle
(S3 portability, TTL retention), not retrievability. A **URL-based send is the exception**: the
gateway fetches those bytes at send time and stores none, so there is nothing to serve or archive.

The inline fallback also keeps an inbound message's media downloadable after
`CHAT_MEDIA_ARCHIVE_TTL_DAYS` retention purges the archived file, since retention leaves the inline
copy in place.

**Archive-only storage (`MESSAGE_INLINE_MEDIA=archive`).** By default an archived file is a second
copy: the row keeps its inline base64 too. Setting `MESSAGE_INLINE_MEDIA=archive` (it needs
`CHAT_MEDIA_ARCHIVE_ENABLED=true`; the boot fails otherwise) stores each archived file once: after
the file is written, read back byte for byte and the row points at it, the row's
`metadata.media` is replaced with `{ mimetype, filename?, omitted: true, sizeBytes, archived: true }`,
and this route becomes the only way to the bytes. Storage or verification failures leave the inline
copy intact. Concurrent row updates are preserved, and a revoked message stays revoked.
What it does not cover: media over `CHAT_MEDIA_ARCHIVE_MAX_BYTES` is
not archived and stays inline; a row without a WhatsApp message ID keeps its inline bytes;
outbound media is archived (and replaced) only with
`CHAT_MEDIA_ARCHIVE_OUTBOUND=true`; rows stored before the switch keep their inline copy. Two
consequences to weigh before enabling it: with a non-zero `CHAT_MEDIA_ARCHIVE_TTL_DAYS`, retention
now removes the only copy, after which this route answers `404`; and a database export no longer
carries those bytes, so back up the media store alongside the database. Webhook payloads carry the
in-memory engine message rather than the row, so they are unaffected. The dashboard previews
archived images, video and audio inline by fetching them from this route. The latest 100 inline or
archived previews share a memory cap; older media keeps its download button.

A revoked message (deleted for everyone, or through `POST /messages/delete`) has no media: its row is
cleared on revoke, and this route answers `404` for it.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                 |
| --------- | ------ | ------------------------------------------- |
| sessionId | string | Session ID                                  |
| chatId    | string | Chat ID containing the message              |
| messageId | string | WhatsApp message ID whose media to download |

**Response** `200` — the raw media bytes as the response body, served as an **attachment**
(`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`). `Content-Type` is the essence of the
stored mimetype (the part before any `;`, trimmed and lowercased; parameters are dropped) when that is in a
conservative inert set (common image/video/audio types) and
`application/octet-stream` otherwise — a document, or an `image/svg+xml`, is never served as active
content on the API origin.

**Errors:** `401` missing/invalid API key · `403` key not scoped to this session · `404`
`No media stored for this message` — the message carries no media, `MEDIA_DOWNLOAD_ENABLED=false`
or the media was above `MEDIA_DOWNLOAD_MAX_BYTES` when it was stored (the row holds a size-only
marker), it was a URL-based API send (the gateway fetches those bytes at send time and never stores
them), or the message is not in this gateway's history (e.g. history backfill, which is media-free)

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
    }
  ],
  "startedAt": "2026-06-25T09:20:55.000Z",
  "completedAt": null
}
```

`status` is one of `pending|processing|completed|cancelled|failed`; `results` holds one entry per recipient attempted as of the last saved checkpoint, with `status` `sent` or `failed`. While the batch is `processing`, the row is saved after every recipient, so `results` and `progress` trail the send loop by at most the recipient in flight, and a cancel from another node stops the run after at most one more recipient; a recipient not yet attempted, or dropped by a cancel, appears only in the `progress` counters. A failed result carries a sanitized `error { code, message }` (internals are not leaked).

**Errors:** `401` missing/invalid API key · `404` batch not found for this session

### Send pacing (opt-in, `429 SEND_PACING_LIMITED`)

Every outbound message send — the `messages/send-*` routes, `messages/edit`, `messages/forward`,
bulk batches, status posts and the catalog send (`messages/send-product`) — passes an optional pacing governor before
it reaches WhatsApp. Actions on existing messages (react, vote, pin, star) are not sends and are
not paced. It is **off by default**: unless `SEND_PACING_ENABLED=true`, nothing is refused and no
extra work is done.

When enabled, three rules can refuse a send:

| Rule              | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Warm-up daily cap | The session has used its allowance for the current **UTC** day. The allowance grows with the session's age (`SEND_PACING_WARMUP_SCHEDULE`), because a brand-new WhatsApp account that immediately sends at volume is the pattern that gets numbers banned. The count comes from the messages table, so it survives restarts — and so it only sees sends that write a row there. Status posts and message edits are checked against the cap but never counted into it (a status post writes no row, and an edit only updates one), and neither is a bulk item the engine refuses, because bulk persists its row only after the send succeeds. A Baileys product send writes no row itself: it is counted once its own-send echo writes the outgoing row, shortly after the send returns, and a product send into a disappearing-messages chat is not counted at all when `STORE_EPHEMERAL_MESSAGES=false`. A session using any of them can exceed its stated allowance. Clearing or deleting a chat removes its stored rows, so that chat's sends today stop counting toward either cap, and the next send to it counts as a new conversation (the cold-reachout cap may refuse it). A bulk item that succeeds is counted, as is a failed single send, whose PENDING row is kept as FAILED. |
| Cold-reachout cap | The session has used its allowance of **new conversations** for the UTC day (`SEND_PACING_COLD_DAILY_CAP`). A send is a cold reachout when the account has no history with that chat in **either** direction — replying to someone who wrote to you first is never counted, and never refused by this rule. Status posts address no chat and are exempt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Failure breaker   | Consecutive send failures reached `SEND_PACING_BREAKER_THRESHOLD`, which usually means WhatsApp has already started refusing this account. The streak has no time decay — only a successful send resets it, so failures spread across a long quiet period still accumulate toward the threshold. Sends resume after `SEND_PACING_BREAKER_COOLDOWN_MS`, or immediately after any send succeeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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
`code`. The difference matters to a client: the throttler's 429 clears in seconds, while a cap reached
by stored sends lasts until the next UTC day. Do not retry a `SEND_PACING_LIMITED` response before
`retryAfterSeconds`, and read it rather than assume a day-long wait.

A chat send (not an edit) also counts toward both caps before its row lands, so parallel sends cannot
together pass them. A single send, which writes its row before WhatsApp is asked, is held for 10 seconds
from its admission. A bulk item or product send is held while it is in flight (at most 5 minutes) and
for 10 seconds after. A held send also stays held for as long as any send admitted after it is still
held; for the cold-reachout cap, only a later cold send keeps an earlier one held. A send that fails
before WhatsApp may have taken it hands its place back at once. A daily or
cold-reachout refusal can therefore come while the stored count is still under the cap; when only such
held sends push it over, including for the group participant adds below, its `retryAfterSeconds` is 10
or less instead of the time to the next UTC day; while a held send is still in flight or holding, a
retry at that hint can be refused again. The hold is best-effort at two edges: a message sent from the
linked phone while API sends are in flight, and a send still in flight when the UTC day changes, can
each let one extra API send past a cap.

Inside a bulk batch a refusal fails just that item (honouring `stopOnError`), not the batch — the
allowance may free up, and a batch killed outright could not be resumed.

**Group participant adds draw on the same cold budget.** `POST .../groups/:groupId/participants` and
`POST .../groups` put the account in front of people who did not ask for it, in bulk, in a single
call — the most ban-associated action available — so each participant the account has no history
with costs one cold reachout. A repeated id costs one; participants already known cost nothing. The
whole request is refused rather than partially applied, so a `429` can never be confused with the
per-participant failures those endpoints report normally. A request naming more new contacts than
the whole day's allowance cannot fit that day however long it waits, so it is refused with `400` and
no `retryAfterSeconds`; split it into batches no larger than the allowance. No message is sent, so
neither call consumes the overall daily send allowance.

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
| quotedMessageId   | string   | No       | non-empty                      | Quote an earlier message, making this a reply. See [Quoted sends](#quoted-sends) below       |

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
approach would leave open. The pin holds on a direct fetch and through a SOCKS session proxy; behind
an HTTP or HTTPS session proxy the proxy resolves the name, so that window stays open there (see
"Per-session egress proxy" above). The fetch is always guarded, independent of `WEBHOOK_SSRF_PROTECT`; a deployment
that intentionally allows an internal host lists it in `SSRF_ALLOWED_HOSTS`. A refused, slow or broken site
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

`messageId` is the WhatsApp message id from the engine. By default (`SIMULATE_TYPING`; set it to `false` to disable) a typing indicator and a humanising pause run before the send: 500 ms plus 45 ms per character, capped at `SIMULATE_TYPING_MAX_MS` (default 5000 ms), with +/-15% jitter.

**Errors:** `400` unknown body field, validation failure, or session not active / blocked by a plugin hook · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends)) · `503` Baileys recipient lookup failed or timed out before the operation was sent

##### Quoted sends

Nine `send-*` routes accept an optional `quotedMessageId`: `send-text` above, and `send-image`,
`send-video`, `send-audio`, `send-document`, `send-sticker`, `send-location`, `send-contact` and
`send-poll` below. Supplying it turns that send into a reply, so a reply can carry media, a location,
a contact card or a poll — not only text. `POST .../messages/reply` remains the text shorthand, and
like the send routes it accepts `mentions`.

`send-template`, `send-bulk` and `send-product` do NOT accept the field, and reject it
as an unknown property.

```json
{
  "chatId": "628123456789@c.us",
  "contactName": "Alice",
  "contactNumber": "628999888777",
  "quotedMessageId": "true_628123456789@c.us_3EB0ABCD"
}
```

**The id is engine-specific and is deliberately not harmonised.**

|                      | whatsapp-web.js                                  | Baileys                           |
| -------------------- | ------------------------------------------------ | --------------------------------- |
| id to supply         | the serialized message id (`true_<chat>_<hash>`) | the raw message key id            |
| where it is resolved | in the WhatsApp Web page                         | the gateway's local message store |
| message not found    | `404` — the send is refused                      | `404` — the send is refused       |

An id the engine cannot resolve **fails the send** rather than delivering the message unquoted. On
whatsapp-web.js that is a deliberate choice: the library's default is to send anyway and report
success, which would hand back `201` for a message that is not a reply.

One upstream gap remains on whatsapp-web.js and cannot be switched off from here: if the quoted
message resolves but the page decides it is not replyable, the message is sent without the quote and
the call still succeeds.

On whatsapp-web.js a quoted send to a channel, `status@broadcast` or a broadcast list answers `501`
and nothing is sent: the library drops a reply to those recipients without sending it, so the
gateway refuses it before the call. The Baileys engine does not refuse it.

On Baileys a message deleted for everyone is not found (`404`): the store drops its content, so the
deleted text or media is never quoted back into the chat. An edited message is quoted with its edited
text.

Quoting a message from a **different chat** is not validated on these `send-*` routes on either
engine; the id is passed through as given. `POST /messages/reply` is stricter: both engines refuse a
quoted id that does not belong to the target chat, with `404`.

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
| mentions     | string[]                | No          | array of WIDs                                     | WIDs to @mention in the rendered body                       |
| linkPreview  | boolean                 | No          | —                                                 | Same engine split as `send-text`; see **Link previews**     |

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

**Errors:** `400` unknown body field, validation failure, neither `templateId` nor `templateName` given, or session not active · `401` missing/invalid API key · `403` key role below OPERATOR · `404` session or template not found · `500` engine error · `409` conflict or engine not ready (retryable) · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends)) · `503` Baileys recipient lookup failed or timed out before the operation was sent

#### POST /api/sessions/:sessionId/messages/send-image

Send an image (by URL or base64) with an optional caption.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendMediaMessageDto`

| Field           | Type     | Required    | Constraints                           | Description                                                                              |
| --------------- | -------- | ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| chatId          | string   | Yes         | non-empty                             | Target chat                                                                              |
| url             | string   | Conditional | URL; required when `base64` is absent | http/https media URL (SSRF-guarded; a blocked internal or unreachable URL maps to `400`) |
| base64          | string   | Conditional | string; required when `url` is absent | Base64 media data (capped to the media byte limit)                                       |
| mimetype        | string   | Conditional | string; required when using `base64`  | MIME type of the media                                                                   |
| filename        | string   | No          | max 255                               | File name                                                                                |
| caption         | string   | No          | max 1024                              | Caption text                                                                             |
| mentions        | string[] | No          | array of WIDs                         | WIDs to @mention in the caption. See **Mentions** above                                  |
| quotedMessageId | string   | No          | non-empty                             | Quote an earlier message, making this a reply — see [Quoted sends](#quoted-sends)        |

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/image.jpg", "caption": "Check out this image!" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` neither `url` nor `base64`, base64 without `mimetype`, SSRF-blocked URL, a `url` that answers non-2xx, times out or cannot be reached, session not active, or unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `413` base64 or downloaded media over the media cap (see §6.3) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable) · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends))

#### POST /api/sessions/:sessionId/messages/send-video

Send a video (by URL or base64) with an optional caption. Uses the same `SendMediaMessageDto` (and the same validation rules and errors) as `send-image`.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendMediaMessageDto` (fields `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption`, `mentions`, `quotedMessageId` — see `send-image`)

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/clip.mp4", "caption": "video" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` media validation failure / a `url` that answers non-2xx, times out or cannot be reached / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `413` base64 or downloaded media over the media cap (see §6.3) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable) · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends))

#### POST /api/sessions/:sessionId/messages/send-audio

Send an audio message (by URL or base64). Uses `SendAudioMessageDto`. A `caption` is accepted by the DTO but not persisted for audio. Set `ptt: true` to send a real WhatsApp **voice note** (microphone bubble + waveform) instead of a plain audio file. `ptt` is a JSON boolean, exclusive to this endpoint and to `audio` items of `send-bulk`, and — because voice notes require `audio/ogg; codecs=opus` — the server defaults the mimetype to that when you set `ptt` without one; for reliable playback (especially on the Baileys engine, which does not transcode) supply OGG/Opus bytes. A `ptt` voice note is stored as message `type: "voice"`.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendAudioMessageDto` (all `SendMediaMessageDto` fields — `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption`, `mentions`, `quotedMessageId` — plus optional `ptt` boolean)

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/voice.ogg", "mimetype": "audio/ogg", "ptt": true }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` media validation failure / a `url` that answers non-2xx, times out or cannot be reached / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `413` base64 or downloaded media over the media cap (see §6.3) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable) · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends))

#### POST /api/sessions/:sessionId/messages/send-document

Send a document/file (by URL or base64). Uses `SendMediaMessageDto`; `filename` is used as the persisted body fallback.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendMediaMessageDto` (fields `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption`, `mentions`, `quotedMessageId` — see `send-image`)

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

**Engine differences:** Baileys always sends a document as a document, while whatsapp-web.js deliberately keeps normal mimetype classification for `status@broadcast` and broadcast lists; the library returns `null` for document-mode sends to those recipients, so forcing the flag there would turn a working send into a failure. For URL-based sends without an explicit `filename`, whatsapp-web.js derives the URL basename, percent-decoded; Baileys falls back to the literal `file`.

**Errors:** `400` media validation failure / a `url` that answers non-2xx, times out or cannot be reached / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `413` base64 or downloaded media over the media cap (see §6.3) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable) · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends))

#### POST /api/sessions/:sessionId/messages/send-location

Send a location pin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendLocationDto`

| Field           | Type   | Required | Constraints     | Description                                                                       |
| --------------- | ------ | -------- | --------------- | --------------------------------------------------------------------------------- |
| chatId          | string | Yes      | non-empty       | Target chat                                                                       |
| latitude        | number | Yes      | valid latitude  | Latitude (out-of-range → `400`)                                                   |
| longitude       | number | Yes      | valid longitude | Longitude (out-of-range → `400`)                                                  |
| description     | string | No       | string          | Pin description                                                                   |
| address         | string | No       | string          | Pin address                                                                       |
| quotedMessageId | string | No       | non-empty       | Quote an earlier message, making this a reply — see [Quoted sends](#quoted-sends) |

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

**Errors:** `400` invalid coords / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` whatsapp-web.js cannot send a location to a channel (`<id>@newsletter`) or a status or broadcast list (`@broadcast`); nothing is sent · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends)) · `503` Baileys recipient lookup failed or timed out before the operation was sent

#### POST /api/sessions/:sessionId/messages/send-contact

Send a contact card (vCard).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendContactDto`

| Field           | Type   | Required | Constraints | Description                                                                       |
| --------------- | ------ | -------- | ----------- | --------------------------------------------------------------------------------- |
| chatId          | string | Yes      | non-empty   | Target chat                                                                       |
| contactName     | string | Yes      | non-empty   | Display name for the contact card                                                 |
| contactNumber   | string | Yes      | non-empty   | Contact phone number                                                              |
| quotedMessageId | string | No       | non-empty   | Quote an earlier message, making this a reply — see [Quoted sends](#quoted-sends) |

```json
{ "chatId": "628123456789@c.us", "contactName": "John Doe", "contactNumber": "628987654321" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` whatsapp-web.js cannot send a contact card to a channel (`<id>@newsletter`) or a status or broadcast list (`@broadcast`); nothing is sent · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends)) · `503` Baileys recipient lookup failed or timed out before the operation was sent

#### POST /api/sessions/:sessionId/messages/send-sticker

Send a sticker (by URL or base64; typically webp). Reuses `SendMediaMessageDto`.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendMediaMessageDto` (fields `chatId`, `url`, `base64`, `mimetype`, `filename`, `caption`, `mentions`, `quotedMessageId` — see `send-image`)

```json
{ "chatId": "628123456789@c.us", "url": "https://example.com/sticker.webp", "mimetype": "image/webp" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1719312000 }
```

**Errors:** `400` media validation failure / a `url` that answers non-2xx, times out or cannot be reached / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `413` base64 or downloaded media over the media cap (see §6.3) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine, or (whatsapp-web.js) a sticker to a channel, `status@broadcast` or a broadcast list · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable) · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends))

#### POST /api/sessions/:sessionId/messages/send-poll

Send a native WhatsApp poll.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendPollDto`

| Field                | Type     | Required | Constraints                               | Description                                                  |
| -------------------- | -------- | -------- | ----------------------------------------- | ------------------------------------------------------------ |
| chatId               | string   | Yes      | non-empty                                 | Target chat                                                  |
| name                 | string   | Yes      | max 255                                   | Poll question / title                                        |
| options              | string[] | Yes      | 2–12 items, each non-empty, max 100 chars | Options to vote on                                           |
| allowMultipleAnswers | boolean  | No       | —                                         | Allow picking several options (default single choice)        |
| quotedMessageId      | string   | No       | non-empty                                 | Quote an earlier message — see [Quoted sends](#quoted-sends) |

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

**Errors:** `400` validation failure (option count/length) / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the `quotedMessageId` could not be resolved (see Quoted sends) · `500` engine error · `409` conflict or engine not ready (retryable) · `501` whatsapp-web.js cannot send a poll to a status or broadcast list (`@broadcast`), nor one with `quotedMessageId` to a channel (`<id>@newsletter`); nothing is sent · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends)) · `503` Baileys recipient lookup failed or timed out before the operation was sent

#### POST /api/sessions/:sessionId/messages/reply

Reply to a message, quoting a prior message.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `ReplyMessageDto`

| Field           | Type     | Required | Constraints   | Description                              |
| --------------- | -------- | -------- | ------------- | ---------------------------------------- |
| chatId          | string   | Yes      | non-empty     | Target chat                              |
| quotedMessageId | string   | Yes      | non-empty     | WhatsApp id of the message being quoted  |
| text            | string   | Yes      | non-empty     | Reply text                               |
| mentions        | string[] | No       | array of WIDs | WIDs to @mention. See **Mentions** above |

```json
{ "chatId": "628123456789@c.us", "quotedMessageId": "true_628123456789@c.us_3EB0ABCD", "text": "Replying to you" }
```

**Response** `201`

```json
{ "messageId": "true_628123456789@c.us_3EB0EFGH", "timestamp": 1719312100 }
```

The quoted body is best-effort resolved from the DB for the reply preview.

**Errors:** `400` validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the quoted message is not found in this chat · `500` engine error · `409` conflict or engine not ready (retryable) · `501` whatsapp-web.js cannot send a reply to a channel (`<id>@newsletter`) or a status or broadcast list (`@broadcast`); nothing is sent · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends)) · `503` Baileys recipient lookup failed or timed out before the operation was sent

#### POST /api/sessions/:sessionId/messages/click-button

Tap a choice on a WhatsApp Business button / list prompt by sending the structured reply proto WhatsApp expects.

**Auth:** API key (OPERATOR) · **Engines:** Baileys only; whatsapp-web.js returns `501`

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body**: `ClickButtonDto`

| Field     | Type   | Required | Constraints         | Description                                                                  |
| --------- | ------ | -------- | ------------------- | ---------------------------------------------------------------------------- |
| chatId    | string | Yes      | non-empty           | Chat that holds the prompt                                                   |
| messageId | string | Yes      | non-empty           | WhatsApp id of the inbound prompt (`buttons` on `message.received`)          |
| buttonId  | string | Yes      | non-empty, max 256  | Stable id of the choice (`buttons[].id`)                                     |
| text      | string | No       | non-empty, max 4096 | Visible label; resolved from the stored prompt when omitted, else `buttonId` |

```json
{ "chatId": "5519987517809@c.us", "messageId": "0587502EE4F5C80E5C", "buttonId": "yes", "text": "Sim" }
```

**Response** `201`

```json
{ "messageId": "3EB0CLICK1", "timestamp": 1719312100 }
```

> **Baileys only.** whatsapp-web.js has no interactive-reply send path and answers `501`.

> **Not a native UI tap.** Classic prompts go out through Baileys' `buttonReply` /
> `listReply` helpers quoted to the stored prompt. Native-flow `interactiveMessage` replies are
> unverified against a live business prompt and must not be treated as fully supported. WhatsApp may
> reject or treat any of these differently from a phone tap. The prompt must already be in the
> Baileys message store (received while the session was live); persisted `metadata.buttons` can still
> render after the store evicts the prompt, and a tap then 404s. URL/call CTA buttons cannot be
> clicked this way, only quick-reply style choices and list rows.

**Errors:** `400` validation failure, session not active, the message is not a clickable prompt, or `buttonId` is not among its choices · `401` · `403` · `404` prompt not in the engine store / wrong chat · `501` whatsapp-web.js · `409` conflict or engine not ready (retryable) · `500` engine error · `503` Baileys recipient lookup failed or timed out before the operation was sent

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

**Errors:** `400` validation failure / session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` the message to forward is not found in `fromChatId` · `500` engine error · `409` conflict or engine not ready (retryable) · `422` the `Idempotency-Key` was already used for a different request (see [Idempotent sends](#idempotent-sends)) · `503` Baileys recipient lookup failed or timed out before the operation was sent

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

**Errors:** `400` session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` message not found in this chat · `500` engine error · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-request; repeating it is safe (retryable)

#### POST /api/sessions/:sessionId/messages/delete

Delete a message (for everyone by default); also clears the stored record and flags it `revoked`.

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

After the engine delete, the stored message's body and `metadata` (inline media, quote, reactions) are cleared, its archived-media pointer is removed, and its `type` is set to `revoked`, the same as when the engine reports a revoke (`message.revoked`). The archived file itself is deleted later by the chat-media orphan sweep, once it has stayed unreferenced for the sweep's grace window. Note the `200` status (via `@HttpCode`).

```json
{ "success": true }
```

**Errors:** `400` session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR · `404` message not found in this chat · `500` engine error · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

#### POST /api/sessions/:sessionId/messages/edit

Edit the text of a message sent by this account; also updates the stored record's body.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `EditMessageDto`

| Field     | Type     | Required | Constraints             | Description                                       |
| --------- | -------- | -------- | ----------------------- | ------------------------------------------------- |
| chatId    | string   | Yes      | non-empty               | Chat containing the message                       |
| messageId | string   | Yes      | non-empty               | Message to edit (the send response's `messageId`) |
| body      | string   | Yes      | non-empty, ≤ 4096 chars | New text content                                  |
| mentions  | string[] | No       | array of WIDs           | Re-applies participant tags to the new body       |

```json
{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "body": "Corrected text" }
```

**Response** `200`

Both fields describe the edited message rather than the edit itself, on both engines: `messageId` is the id you passed, and `timestamp` is the time that message was originally sent, since an edit does not move a message in the chat.

```json
{ "messageId": "true_628123456789@c.us_3EB0ABCD", "timestamp": 1760000000 }
```

**Errors:** `400` session not active / unknown body field · `401` missing/invalid API key · `403` key role below OPERATOR, or the engine refused the edit (both engines refuse a message the account did not send; whatsapp-web.js also refuses one that is not text, where the Baileys engine has no acceptance signal and answers `200`) · `404` message not found · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-request; repeating it is safe (retryable)

#### POST /api/sessions/:sessionId/messages/send-bulk

Send messages to multiple recipients as an async batch — returns immediately and processes in the background.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `SendBulkMessageDto`

| Field    | Type                  | Required | Constraints                      | Description                                                                                                                                                                                                                          |
| -------- | --------------------- | -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| batchId  | string                | No       | string                           | Auto-generated `batch_<hex>` if omitted; a duplicate id returns `400`                                                                                                                                                                |
| messages | BulkMessageItemDto[]  | Yes      | array, max 100, nested-validated | The batch items (see below); exact duplicate entries (same `chatId`, `type`, `content` and `variables`) are collapsed before processing, first occurrence wins, order preserved; distinct messages to the same `chatId` are all sent |
| options  | BulkMessageOptionsDto | No       | nested-validated                 | Pacing/error options (see below)                                                                                                                                                                                                     |

Each `BulkMessageItemDto`: `{ chatId: string, type: 'text'|'image'|'video'|'audio'|'document', content: BulkMessageContentDto, variables?: Record<string,string> }`. `content` (all fields optional, nested-validated): `text?: string`, `image?`/`video?`/`audio?`/`document?`: `{ url?, base64?, mimetype?, filename?, ptt? }` (`ptt` applies to `audio` only), `caption?: string`, `mentions?: string[]` (per item; a batch fans out to many chats, and a WID is only taggable in a chat the participant is in).

`BulkMessageOptionsDto`: `{ delayBetweenMessages?: number (1000–60000, default 3000), randomizeDelay?: boolean (default true), stopOnError?: boolean (default false) }`.

Each item must carry what its `type` sends: a non-empty `chatId`, a non-empty `content.text` for `text`, and a `url` or `base64` under `content.<type>` for a media type. Without `base64`, the `url` must be an absolute http(s) URL; a `url` holding a placeholder is checked once `variables` fill it in. If any item does not, the request answers `400` and nothing is queued. The check runs again per item after `variables` and the `message:sending` gate, where a failure fails that item only.

Each item's base64 media is checked against the media byte cap (`MEDIA_DOWNLOAD_MAX_BYTES`) twice: at batch creation, and again per item after `variables` and the `message:sending` plugin gate are applied. An item that outgrows the cap only after rendering fails individually (`failed` in `results`, with `message:failed` fired) instead of being sent. `totalMessages` in the response reflects the de-duplicated item count.

The rendered text is bounded the same way, by `TEMPLATE_RENDER_MAX_CHARS` (default 64 KiB) — the limit the single-send template path already applied. `content.text` and `content.caption` are length-validated _before_ substitution, so caller-supplied `variables` could otherwise inflate each item without bound while the request body stayed far below the in-flight body budget. An item whose `text` or `caption` exceeds the limit after substitution fails individually with a message naming it, rather than being truncated silently or sent. Media is not bounded by this cap — `MEDIA_DOWNLOAD_MAX_BYTES` governs it, three orders of magnitude higher, because a 100 KB image is already ~137,000 base64 characters and would fail the character limit on every personalised media send.

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

`202 Accepted` (via `@HttpCode`). `statusUrl` points at the batch-status route below, with the session id and `batchId` percent-encoded.

```json
{
  "batchId": "batch_a1b2c3d4",
  "status": "pending",
  "totalMessages": 2,
  "estimatedCompletionTime": "2026-06-25T09:21:00.000Z",
  "statusUrl": "/api/sessions/my-session/messages/batch/batch_a1b2c3d4"
}
```

**Errors:** `400` session not active, duplicate `batchId`, a `batchId` of `.` or `..`, or DTO/nested validation failure (unknown nested field rejected) · `401` missing/invalid API key · `403` key role below OPERATOR · `413` base64 media over the media cap (see §6.3) · `429` too many bulk batches already in progress on this node (`BULK_MAX_CONCURRENT_BATCHES`, default 50); retry shortly · `500` engine error · `503` the server is shutting down; nothing was sent, so retry the batch shortly

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

**Errors:** `400` batch already completed, cancelled or failed · `401` missing/invalid API key · `403` key role below OPERATOR · `404` batch not found

### 6.4.3 Contacts

Contact endpoints are scoped under a session: `/api/sessions/:sessionId/contacts`. All read routes require a valid API key, except the number check (`GET .../check/:number`), which requires an `OPERATOR` key because each call queries WhatsApp about a third party and bulk checks put the linked account's standing at risk; every write (saving or removing an addressbook entry with `PUT`/`DELETE` `/:contactId`, block and unblock) requires an `OPERATOR` key. Every route returns `400 "Session is not started"` when the session has no running engine (missing or stopped); a started session whose engine is not ready yet (initializing, waiting for QR, reconnecting) answers `409` (retryable). Responses are the raw handler payload (no envelope).

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

`name`, `pushName`, and `profilePicUrl` are optional and may be absent. `profilePicUrl` is a cached URL that only Baileys can fill (whatsapp-web.js never sets it), and it is often absent there too, so its absence says nothing about whether the contact has a picture; use `GET /api/sessions/:sessionId/contacts/:contactId/profile-picture` for that.

#### GET /api/sessions/:sessionId/contacts

List all contacts for a session, returned as an in-memory paginated window.

On Baileys the list is the saved address book: contacts with a name saved on the phone (`isMyContact: true`), rebuilt from WhatsApp's app-state contact collection on connect, including after a process restart. A peer known only by its pushname is not listed but still resolves through the get-by-id route below with `isMyContact: false`. whatsapp-web.js lists what the WhatsApp Web page holds, which also includes unsaved chat partners (`isMyContact: false`). An entry the page cannot read (for example a device-scoped id), or one without a readable id, is left out of the list; the gateway logs a warning with the count, and the response does not signal it.

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

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key not scoped to this session · `409` conflict or engine not ready (retryable) · `500` engine error, including whatsapp-web.js when entries could not be read and no unblocked contact was, or when no entry had a readable id (a page-wide failure, not an empty address book) · `503` the WhatsApp page died while reading contacts or the command timed out (retry shortly)

#### GET /api/sessions/:sessionId/contacts/blocked

The contacts this account has blocked — the read half of the block/unblock endpoints. A bare array
of neutral contact ids, and ids only: whatsapp-web.js resolves full contact models, but Baileys'
blocklist query answers bare jids, and inventing the other fields on one engine would make the two
engines claim different things about the same account.

**Auth:** API key

**Response** `200`

```json
["628123456789@c.us", "628987654321@c.us"]
```

**Errors:** `400` session not started · `401` missing/invalid `X-API-Key` · `409` engine not ready · `503` WhatsApp did not answer the blocklist query (on Baileys the gateway bounds the query with its own clock — an unanswered query is a `503`, never an empty list)

#### GET /api/sessions/:sessionId/contacts/check/:number

Check whether a phone number exists on WhatsApp and return its canonical WhatsApp id when it does.

**Auth:** API key (`OPERATOR`)

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

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key lacks OPERATOR role, is not scoped to this session, is restricted to selected chats, or its IP allow-list excludes the client · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

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

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` `Contact <id> not found` (engine returned null) · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-read or the command timed out, so the lookup reached no answer (distinct from the `404`, which asserts the contact does not exist)

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

`url` is `null` when there is no picture or the contact's privacy hides it — both are answers. A
lookup that could not reach an answer is **not** reported this way; it answers `503`, so a caller can
tell "this contact has no avatar" from "we could not find out".

> The path segment is `profile-picture` (hyphenated), not `profile-pic`.

**Errors:** `400` session is not started · `401` missing/invalid API key · `409` conflict or engine not ready (retryable) · `503` the engine could not complete the lookup

Note the batch route below keeps its best-effort contract: it has no per-id error channel, so a
failed lookup there still appears as `null`.

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

An engine that is not ready is the exception: it describes the session rather than one id, so the whole request answers `409` and no partial result is returned.

> Route-order caveat: `profile-pictures` is declared **before** `GET /:contactId`, so the literal segment wins — a contact whose id is literally `profile-pictures` cannot be fetched through the single-contact route.

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key not scoped to this session · `409` conflict or engine not ready (retryable)

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

For inbound messages the gateway can attach this automatically instead: `RESOLVE_LID_TO_PHONE=true` adds `senderPhone` to every `message.received` payload (§6.6). It is off by default; this endpoint works either way.

**Errors:** `400` session is not started · `401` missing/invalid API key · `409` conflict or engine not ready (retryable)

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
> stored as if it were a real phone. Pass a phone-based contact id instead. Any other id that does not
> name a person (a group, newsletter, broadcast or non-numeric id) is refused with `400` as well.

**Errors:** `400` session not active, invalid request, or the contact id does not name a phone-based individual (a `@lid`, group, newsletter, broadcast or non-numeric id) · `401` missing/invalid API key · `403` key lacks OPERATOR role · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

#### DELETE /api/sessions/:sessionId/contacts/:contactId

Remove a contact from the account's addressbook. Does not block the contact or delete the chat.

**Auth:** API key (OPERATOR)

**Response** `200` — `{ "success": true, "message": "Contact deleted" }`

**Errors:** `400` session not active, or the contact id does not name a phone-based individual (a `@lid`, group, newsletter, broadcast or non-numeric id; same reason as the `PUT` above) · `401` missing/invalid API key · `403` key lacks OPERATOR role · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

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

**Errors:** `400` session is not started, or the id does not name an individual (group/newsletter/broadcast/free text are refused on both engines; a phone-based or privacy `@lid` id is accepted, because the blocklist read answers both shapes), or, on Baileys, an id the session cannot map between phone and privacy-id form (a `@lid` with no known phone, a phone-based id with no known `@lid`) · `401` missing/invalid API key · `403` key role below OPERATOR · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

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

**Errors:** `400` session is not started, or the id does not name an individual (group/newsletter/broadcast/free text are refused on both engines; a phone-based or privacy `@lid` id is accepted, because the blocklist read answers both shapes), or, on Baileys, a phone-based id the session cannot map to its `@lid` · `401` missing/invalid API key · `403` key role below OPERATOR · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

### 6.4.4 Groups

All group routes are nested under a session: base path `/api/sessions/:sessionId/groups`. Reads (`GET`) require a plain API key, except the invite-code read (`GET .../:groupId/invite-code`), which requires an `OPERATOR` role key because the code is a join capability rather than data; writes (create/modify/leave/revoke) require an `OPERATOR` role key. All routes resolve the engine for the session first, so a session that is not started yields `400 Session is not started`.

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

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `404` session not found · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` a key restricted to selected chats names a group outside its allowlist · `404` `Group <groupId> not found` · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### GET /api/sessions/:sessionId/groups/:groupId/picture

Get the group's picture URL.

**Auth:** API key

**Response** `200` — `{ "url": "https://…" }`, or `{ "url": null }` when the group has no picture or
it is hidden by privacy settings.

**Errors:** `400` the id does not name a group, or the session is not active · `401` missing/invalid API key · `409` engine not ready · `503` WhatsApp did not answer within the request budget — nothing could be read; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408) or fails on its side (code 500 or above): retry after a pause

#### PUT /api/sessions/:sessionId/groups/:groupId/picture

Set the group's picture. The account must be a group admin.

**Auth:** API key (OPERATOR)

**Request body** — `SetGroupPictureDto` (same shape as the profile-picture body)

| Field    | Type   | Required          | Constraints          | Description                                       |
| -------- | ------ | ----------------- | -------------------- | ------------------------------------------------- |
| url      | string | One of url/base64 | http(s) URL          | Fetched server-side through the SSRF guard        |
| base64   | string | One of url/base64 | —                    | Wins over `url` when both are present             |
| mimetype | string | With `base64`     | must match `image/*` | Defaults to `image/jpeg` when only `url` is given |

**Response** `200` — `{ "success": true, "message": "Group picture updated" }`

**Errors:** `400` the id does not name a group, the session is not active, neither `url` nor `base64` was supplied, or the `url` answers non-2xx, times out or cannot be reached · `401` missing/invalid API key · `403` key lacks OPERATOR role, or the engine refused (admin rights required) · `404` no such group · `409` the session is not connected (engine exists but is not `ready`) · `413` base64 or downloaded media over the media cap (see §6.3) · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable), or WhatsApp did not answer within the request budget — the change may or may not have been applied; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### DELETE /api/sessions/:sessionId/groups/:groupId/picture

Remove the group's picture. The account must be a group admin.

**Auth:** API key (OPERATOR)

**Response** `200` — `{ "success": true, "message": "Group picture removed" }`

**Errors:** `400` the id does not name a group, or the session is not active · `401` missing/invalid API key · `403` key lacks OPERATOR role, or the engine refused (admin rights required) · `404` no such group · `409` the session is not connected (engine exists but is not `ready`) · `503` WhatsApp did not answer within the request budget — the change may or may not have been applied; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### GET /api/sessions/:sessionId/groups/:groupId/invite-code

Get the group invite code and full invite link. The code is a transferable join capability rather than plain read data, so it sits at OPERATOR, like the QR endpoint.

**Auth:** API key (OPERATOR)

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

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or the engine refused (admin rights required) · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### POST /api/sessions/:sessionId/groups

Create a new group with an initial set of participants.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `CreateGroupDto`

| Field        | Type     | Required | Constraints                                                        | Description                                               |
| ------------ | -------- | -------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| name         | string   | Yes      | `@IsString`, `@IsNotEmpty`, 1..100 chars                           | Group subject/name                                        |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})`, 1..256 ids | Non-empty array of WhatsApp IDs, e.g. `628123456789@c.us` |

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

**Errors:** `400` validation (missing/empty `name` or `participants`, or any non-DTO field) / session not started, or a participant does not name an individual (phone, `<phone>@c.us` or `<lid>@lid`), or (send pacing on) the request names more new contacts than the whole day's cold-reachout allowance (no `retryAfterSeconds`; split the batch, see Send pacing) · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or WhatsApp refused the create · `409` conflict or engine not ready (retryable) · `429` `SEND_PACING_LIMITED` when send pacing is enabled (cold-reachout cap reached for today, see Send pacing) · `501` not supported on the active engine · `503` WhatsApp rate-limited the create on Baileys (code 429; nothing was created, so a retry is safe; a create WhatsApp timed out, code 408, answers `500` instead, as it may have succeeded: check before retrying)

#### POST /api/sessions/:sessionId/groups/:groupId/participants

Add participants to a group.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `ParticipantsDto`

| Field        | Type     | Required | Constraints                                                        | Description                     |
| ------------ | -------- | -------- | ------------------------------------------------------------------ | ------------------------------- |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})`, 1..256 ids | Non-empty array of WhatsApp IDs |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200`

Status is forced to `200` via `@HttpCode(HttpStatus.OK)` (overriding the POST default). `results` carries the engine's per-participant outcome — a partial refusal does **not** fail the batch, so check `results[].success` rather than the envelope's `success`. If every listed participant is refused, the request fails with `403` instead.

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

**Errors:** `400` validation / session not started, or a participant does not name an individual (phone, `<phone>@c.us` or `<lid>@lid`), or (send pacing on) the request names more new contacts than the whole day's cold-reachout allowance (no `retryAfterSeconds`; split the batch, see Send pacing) · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or WhatsApp refused every listed participant (a partial refusal still returns `200`) · `404` group not found · `409` conflict or engine not ready (retryable) · `429` `SEND_PACING_LIMITED` when send pacing is enabled (cold-reachout cap reached for today, see Send pacing) · `503` session not ready or dependency unavailable (retryable), or WhatsApp did not answer within the request budget, so no per-participant outcome was read; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### DELETE /api/sessions/:sessionId/groups/:groupId/participants

Remove participants from a group. Note: this DELETE carries a JSON request body.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `ParticipantsDto`

| Field        | Type     | Required | Constraints                                                        | Description                     |
| ------------ | -------- | -------- | ------------------------------------------------------------------ | ------------------------------- |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})`, 1..256 ids | Non-empty array of WhatsApp IDs |

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

**Errors:** `400` validation / session not started, or a participant does not name an individual (phone, `<phone>@c.us` or `<lid>@lid`) · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or WhatsApp refused every listed participant (a partial refusal still returns `200`) · `404` group not found · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable), or WhatsApp did not answer within the request budget, so no per-participant outcome was read; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### POST /api/sessions/:sessionId/groups/:groupId/participants/promote

Promote participants to group admin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `ParticipantsDto`

| Field        | Type     | Required | Constraints                                                        | Description                     |
| ------------ | -------- | -------- | ------------------------------------------------------------------ | ------------------------------- |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})`, 1..256 ids | Non-empty array of WhatsApp IDs |

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

**Errors:** `400` validation / session not started, or a participant does not name an individual (phone, `<phone>@c.us` or `<lid>@lid`) · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or WhatsApp refused every listed participant (a partial refusal still returns `200`) · `404` group not found · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable), or WhatsApp did not answer within the request budget, so no per-participant outcome was read; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### POST /api/sessions/:sessionId/groups/:groupId/participants/demote

Demote participants from group admin.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `ParticipantsDto`

| Field        | Type     | Required | Constraints                                                        | Description                     |
| ------------ | -------- | -------- | ------------------------------------------------------------------ | ------------------------------- |
| participants | string[] | Yes      | `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})`, 1..256 ids | Non-empty array of WhatsApp IDs |

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

**Errors:** `400` validation / session not started, or a participant does not name an individual (phone, `<phone>@c.us` or `<lid>@lid`) · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or WhatsApp refused every listed participant (a partial refusal still returns `200`) · `404` group not found · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable), or WhatsApp did not answer within the request budget, so no per-participant outcome was read; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### PUT /api/sessions/:sessionId/groups/:groupId/subject

Change the group name/subject.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `GroupSubjectDto`

| Field   | Type   | Required | Constraints                              | Description            |
| ------- | ------ | -------- | ---------------------------------------- | ---------------------- |
| subject | string | Yes      | `@IsString`, `@IsNotEmpty`, 1..100 chars | New group subject/name |

```json
{ "subject": "New Team Name" }
```

**Response** `200`

No `@HttpCode`; PUT default is `200`.

```json
{ "success": true, "message": "Group subject updated" }
```

**Errors:** `400` validation (empty `subject`) / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or the engine refused (admin rights required) · `404` no such group · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### PUT /api/sessions/:sessionId/groups/:groupId/description

Change the group description. An empty string clears the description.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `GroupDescriptionDto`

| Field       | Type   | Required | Constraints                                  | Description                                                                |
| ----------- | ------ | -------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| description | string | Yes      | `@IsString` (no `@IsNotEmpty`), ≤ 1024 chars | Must be present and a string, but `""` is valid and clears the description |

```json
{ "description": "Internal coordination group." }
```

**Response** `200`

No `@HttpCode`; PUT default is `200`.

```json
{ "success": true, "message": "Group description updated" }
```

**Errors:** `400` validation (`description` missing / not a string) / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or the engine refused (admin rights required) · `404` no such group · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or the engine refused · `404` no such group · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or the engine refused (admin rights required) · `404` no such group · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

**Errors:** `400` no code supplied, or session not started · `401` · `404` no such invite — invalid, expired, or revoked · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### POST /api/sessions/:sessionId/groups/join

Join a group via an invite code (the part after `https://chat.whatsapp.com/`).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |

**Request body** — `JoinGroupDto`

| Field      | Type   | Required | Constraints  | Description       |
| ---------- | ------ | -------- | ------------ | ----------------- |
| inviteCode | string | Yes      | 1..128 chars | Group invite code |

```json
{ "inviteCode": "XyZ987654321" }
```

**Response** `200`

```json
{ "success": true, "groupId": "120363000000000000@g.us" }
```

**Errors:** `400` session is not started / invalid invite code · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` a key restricted to selected chats names a group outside its allowlist · `404` group not found · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

**Errors:** `400` session is not started / empty patch / unknown body field · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, the account is not a group admin (`memberAddMode` on whatsapp-web.js), or a key restricted to selected chats names a group outside its allowlist · `501` `ephemeralSeconds` on the whatsapp-web.js engine (library limitation) · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### GET /api/sessions/:sessionId/groups/:groupId/membership-requests

List the pending join requests of a group with join-approval mode turned on — the queue the
`group.join_request` webhook/socket event announces. Admin-only on both engines: a non-admin read
is refused by WhatsApp, not silently emptied.

**Auth:** API key

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Response** `200` — a bare array; fields the engine does not report are omitted rather than defaulted.

```json
[
  {
    "participantId": "628123456789@c.us",
    "addedById": "628987654321@c.us",
    "method": "invite_link",
    "requestedAt": 1754700000
  }
]
```

Each entry is a `GroupMembershipRequest`: `participantId` (the user asking to join), optional
`addedById` (who created the request — differs from the requester on a non-admin add), optional
`method` (`invite_link` | `non_admin_add` | `linked_group_join`), optional `requestedAt` (unix
seconds).

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` the engine refused the read — admin rights required · `404` no such group · `409` engine not ready · `503` WhatsApp did not answer within the request budget; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### POST /api/sessions/:sessionId/groups/:groupId/membership-requests/approve

Approve pending join requests — the named requesters, or **every** pending request when the body
names none. Approving an empty queue is a no-op that returns an empty `results` list. Deliberately
not paced by the cold-reachout governor: unlike `POST .../participants`, the people here asked for
the contact themselves. On whatsapp-web.js the engine pauses 250–500ms between requesters
(upstream anti-abuse pacing), so acting on a large queue is a proportionally long request.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description |
| --------- | ------ | ----------- |
| sessionId | string | Session ID  |
| groupId   | string | Group ID    |

**Request body** — `MembershipRequestActionDto`

| Field        | Type     | Required | Constraints                                                                                                | Description                                                   |
| ------------ | -------- | -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| participants | string[] | No       | omit to skip (explicit `null` → `400`), `@IsArray`, `@ArrayNotEmpty`, `@IsString({each:true})`, 1..256 ids | Requester WhatsApp IDs. Omit to act on every pending request. |

```json
{ "participants": ["628123456789@c.us"] }
```

**Response** `200`

Status is forced to `200` via `@HttpCode(HttpStatus.OK)` (overriding the POST default). `results`
carries the engine's per-participant outcome — the same `ParticipantOperationResult` contract as
the participant writes: a partial refusal does **not** fail the batch, while a batch that failed
for every **named** requester is a `403`.

```json
{
  "success": true,
  "message": "Membership requests approved",
  "results": [{ "id": "628123456789@c.us", "success": true, "status": 200 }]
}
```

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or the engine refused (admin rights / every named requester failed) · `404` no such group · `409` engine not ready · `503` WhatsApp did not answer within the request budget; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### POST /api/sessions/:sessionId/groups/:groupId/membership-requests/reject

Reject pending join requests. Same body, response shape, batch-guard contract and error map as
`.../membership-requests/approve`; rejecting an empty queue is likewise a no-op.

**Errors:** `400` validation / session not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role, or the engine refused (admin rights / every named requester failed) · `404` no such group · `409` engine not ready · `503` WhatsApp did not answer within the request budget; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

```json
{
  "success": true,
  "message": "Membership requests rejected",
  "results": [{ "id": "628123456789@c.us", "success": true, "status": 200 }]
}
```

### 6.4.5 Message Templates

Reusable message templates scoped to a session, with `{{variable}}` placeholders rendered at send time. All routes are nested under `/api/sessions/:sessionId/templates` and require an **OPERATOR** key. The `sessionId` is stored on the template; only `POST` checks that the session exists, the other handlers do not validate it.

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

| Name      | Type   | Description                                                                                 |
| --------- | ------ | ------------------------------------------------------------------------------------------- |
| sessionId | string | Session ID; stored as `template.sessionId`. Must name an existing session, otherwise `404`. |

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

**Errors:** `400` validation failure (missing/empty `name`/`body`, over-length, or any extra field rejected by `forbidNonWhitelisted`) · `401` missing/invalid `X-API-Key` · `403` key below OPERATOR role · `404` no session with that id (`{ "statusCode": 404, "message": "Session with id '<id>' not found", "error": "Not Found" }`) · `409` duplicate `name` for the session

#### PUT /api/sessions/:sessionId/templates/:id

Update a template's name/body/header/footer (partial; only provided fields change).

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description              |
| --------- | ------ | ------------------------ |
| sessionId | string | Session ID.              |
| id        | string | Template UUID to update. |

**Request body** — `UpdateTemplateDto`

| Field  | Type   | Required | Constraints                           | Description                                                                                                                                                                                                                                                                                                         |
| ------ | ------ | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name   | string | no       | if present: non-empty, max 100 chars  | Applied only when not `undefined`; explicit `null` → `400`. Duplicate name → `409`.                                                                                                                                                                                                                                 |
| body   | string | no       | if present: non-empty, max 4096 chars | Applied only when not `undefined`; explicit `null` → `400`.                                                                                                                                                                                                                                                         |
| header | string | no       | if present: max 1024 chars            | Applied only when not `undefined`. Explicit `null` is accepted and **clears** the stored header (`200`); omit the key to leave it unchanged. The published schema types this field as a non-nullable `string`, so a generated or typed SDK client sends `""` instead, which the renderer skips exactly like `null`. |
| footer | string | no       | if present: max 1024 chars            | Applied only when not `undefined`. Explicit `null` is accepted and **clears** the stored footer (`200`); omit the key to leave it unchanged. The published schema types this field as a non-nullable `string`, so a generated or typed SDK client sends `""` instead, which the renderer skips exactly like `null`. |

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

WhatsApp Business catalog browsing/sending and channel (newsletter) operations. Catalog read routes (`/catalog…`) require any valid API key; the product **send** route (`POST /api/sessions/:sessionId/messages/send-product`) lives under the `/messages` path and requires an **OPERATOR** key. Channel read routes require any valid API key; every channel write (create, delete, mute, admin demote, ownership transfer, subscribe, unsubscribe) requires **OPERATOR**.

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
  "productCount": 12,
  "url": "https://wa.me/c/6281234567890"
}
```

**Baileys engine only.** whatsapp-web.js has no native Catalog API (the former null-returning stub was removed) and answers `501`; its readiness guard runs first, so a session that exists but is not `READY` (initializing, waiting on a QR, reconnecting) gets `409` instead. Baileys returns the catalog synthesized from its first collection; a business without collections has no catalog to describe and the route answers `200` with an empty body. WhatsApp does not always answer the underlying `w:biz:catalog` query for a business account: when the server stays silent (the socket is healthy and other queries reply) the request spends its budget and answers `503`. That is a WhatsApp-side limitation for the affected account, not a transient a retry clears, so a `503` here can be permanent. A rate limit from WhatsApp also answers `503`, and that one can clear on retry. Any other 4xx-class error WhatsApp answers the query with is a `403` (a WhatsApp 408 is a `503` like the rate limit), except item-not-found on the first query, which reads as an account with no catalog.

**Errors:** `401` missing/invalid API key · `403` WhatsApp refused the catalog query · `404` `Session <sessionId> not found or not connected` · `409` session present but not READY · `501` whatsapp-web.js only (no Catalog API) · `503` the catalog query went unanswered or was rate-limited by WhatsApp, or the session/dependency is not ready (a rate limit or the not-ready case can clear on retry; a silently unanswered catalog query does not)

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
      "priceFormatted": "IDR 49,990",
      "imageUrl": "https://example.com/img/earbuds.jpg",
      "url": "https://wa.me/p/PROD_12345/6281234567890",
      "isAvailable": true,
      "retailerId": "SKU-EB-01"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`price` and `priceFormatted` are absent for a product WhatsApp lists without a price, and `currency` is absent for one listed without a currency (a price with no currency is formatted as a bare number).

**Baileys engine only.** whatsapp-web.js answers `501` (its readiness guard runs first, so a session that exists but is not `READY` gets `409` instead). Baileys pages the products with a cursor; query validation still runs first, so a bad `page`/`limit` is a `400`.

**Errors:** `400` invalid `page`/`limit` or unknown query key · `401` missing/invalid API key · `403` WhatsApp refused the catalog query · `404` `Session <sessionId> not found or not connected` · `409` session present but not READY · `501` whatsapp-web.js only (no Catalog API) · `503` the catalog query went unanswered or was rate-limited by WhatsApp, or the session/dependency is not ready (a rate limit or the not-ready case can clear on retry; a silently unanswered catalog query does not)

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
  "priceFormatted": "IDR 49,990",
  "imageUrl": "https://example.com/img/earbuds.jpg",
  "url": "https://wa.me/p/PROD_12345/6281234567890",
  "isAvailable": true,
  "retailerId": "SKU-EB-01"
}
```

`price`, `priceFormatted` and `currency` are absent under the same conditions as in the list above.

**Baileys engine only.** whatsapp-web.js answers `501` (readiness-guarded as above). Baileys resolves the product from the session catalog; an id no product carries answers `200` with an empty body.

**Errors:** `401` missing/invalid API key · `403` WhatsApp refused the catalog query · `404` `Session <sessionId> not found or not connected` · `409` session present but not READY · `501` whatsapp-web.js only (no Catalog API) · `503` the catalog query went unanswered or was rate-limited by WhatsApp, or the session/dependency is not ready (a rate limit or the not-ready case can clear on retry; a silently unanswered catalog query does not)

#### POST /api/sessions/:sessionId/messages/send-product

Send a product message (catalog product card) to a chat. Note: this route lives under the `/messages` path but belongs to the catalog module.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name        | Type   | Description          |
| ----------- | ------ | -------------------- |
| `sessionId` | string | WhatsApp session id. |

**Request body** — `SendProductDto`

| Field       | Type   | Required | Constraints                             | Description                                                       |
| ----------- | ------ | -------- | --------------------------------------- | ----------------------------------------------------------------- |
| `chatId`    | string | Yes      | `@IsString @IsNotEmpty`                 | Target chat/recipient id (e.g. `6281234567890@c.us`).             |
| `productId` | string | Yes      | `@IsString @IsNotEmpty @MaxLength(255)` | Catalog product id to send.                                       |
| `body`      | string | No       | `@IsString @MaxLength(4096)`            | Optional message body/caption; `null` is the same as omitting it. |

```json
{
  "chatId": "6281234567890@c.us",
  "productId": "PROD_12345",
  "body": "Check out this item!"
}
```

**Response** `201` (Baileys engine only) — the sent `MessageResult`

**Errors:** `400` missing or empty `chatId`/`productId`, a `productId` over 255 or a `body` over 4096 characters, wrong types, any field not on the DTO, a product with no image (a product card needs one), or a `message:sending` plugin blocked the send or returned an invalid `productId`/`body` · `401` missing/invalid API key · `403` API-key role below OPERATOR, or WhatsApp refused the catalog query · `404` `Session <sessionId> not found or not connected`, or the product is not in the session catalog · `409` session present but not READY (retryable) · `500` engine error · `501` whatsapp-web.js only (no Catalog API) · `503` the catalog query went unanswered or was rate-limited by WhatsApp, or the session/dependency is not ready (a rate limit or the not-ready case can clear on retry; a silently unanswered catalog query does not)

On whatsapp-web.js the readiness guard runs before the refusal, so a session that exists but is not
`READY` gets `409` instead of `501`. Baileys resolves the product from the session catalog and sends
the single-product message; an id with no catalog row is a `404` before anything is sent.

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
    "verified": true
  }
]
```

Bare array, no envelope. Only the whatsapp-web.js engine serves this route, and its channel mapping
fills neither `picture` nor `createdAt`, so neither field appears here even though the channel schema
declares them.

**Errors:** `400` `Session is not started` · `401` missing/invalid API key · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine

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
  "verified": true,
  "createdAt": 1717200000
}
```

> **`createdAt` is Baileys-only, and the lookup reaches further there.** The whatsapp-web.js engine
> exposes no per-id channel lookup, so the adapter scans the subscribed-channel list: a channel the
> account does not follow answers `404` even though it exists, and `createdAt` is always absent from
> the payload. The Baileys engine resolves any channel by id and fills `createdAt`. Neither engine
> fills `picture`: WhatsApp reports the channel picture as a media path, not a URL.

**Errors:** `400` `Session is not started` · `401` missing/invalid API key · `404` `Channel <channelId> not found` (engine returned null; on whatsapp-web.js this includes a channel the account does not follow) · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### GET /api/sessions/:sessionId/channels/:channelId/messages

Get recent messages from a channel/newsletter.

**Auth:** API key

**Path parameters**

| Name        | Type   | Description                                  |
| ----------- | ------ | -------------------------------------------- |
| `sessionId` | string | WhatsApp session id. Engine must be started. |
| `channelId` | string | Channel/newsletter id.                       |

**Query parameters**

| Name    | Type   | Required | Default | Description                                                                                                                                                                                                                                                                                                                             |
| ------- | ------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit` | number | No       | `50`    | Max messages to return. Taken as a raw query string and run through `parseInt(limit, 10)` when present. There is **no** DTO/ValidationPipe on this value; a missing or non-numeric `limit` (e.g. `?limit=abc`) uses `50`, and any other value is clamped to 1..100 (above 100 returns at most 100, `0` or a negative value asks for 1). |

**Response** `200`

```json
[
  {
    "id": "false_120363000000000000@newsletter_3EB0...",
    "body": "v0.7.3 is out!",
    "timestamp": 1719331200,
    "hasMedia": false
  }
]
```

Bare array. `timestamp` is an epoch number (seconds). Neither engine populates `mediaUrl` on channel messages today; use `hasMedia` to tell a media post apart.

**Errors:** `400` `Session is not started` · `401` missing/invalid API key · `404` `Channel <channelId> not found` (on whatsapp-web.js, the id is not among the channels the account follows) · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine

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

**Errors:** `400` validation, or session not started · `401` · `403` the engine refused (on whatsapp-web.js this includes channel creation being disabled for the account) · `409` conflict or engine not ready (retryable) · `503` WhatsApp rate-limited the create on Baileys (code 429; nothing was created, so a retry is safe; a create WhatsApp timed out, code 408, answers `500` instead, as it may have succeeded: check before retrying)

#### POST /api/sessions/:sessionId/channels/:channelId/delete

Delete a channel this account owns. Supported on **both** engines.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

Irreversible, and every subscriber loses the channel.

> **Why not `DELETE /channels/:channelId`?** That route already exists and means _unsubscribe_.
> Leaving a channel and destroying it are very different acts, and they must not be reachable by the
> same request with one wrong verb — so deletion takes an explicit path, matching the
> `POST .../messages/delete` and `POST .../chats/delete` convention used elsewhere.

**Response** `200` — `{ "success": true }`

**Errors:** `400` session not started · `401` · `403` the engine refused (not found, or this account does not own it) · `404` the id is not a channel (does not end in `@newsletter`) · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

**Errors:** `400` validation, or session not started · `401` · `403` the engine refused · `404` the id is not a channel (does not end in `@newsletter`); on whatsapp-web.js, also a channel id that is not among the session's subscribed channels or has not synced into the local collection yet · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### POST /api/sessions/:sessionId/channels/:channelId/admins/demote

Demote a channel admin back to a plain subscriber. **Baileys only** — the whatsapp-web.js engine
answers `501`.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

Requires this account to own the channel. There is **no promote counterpart**, and that is an
upstream limit rather than a gap here: neither engine library exposes one, so an admin is promoted
from the WhatsApp app and can then be demoted through this endpoint.

`whatsapp-web.js` declares `Client.demoteChannelAdmin`, but its page body calls a WhatsApp Web
module (`WAWebDemoteNewsletterAdminAction`) that no longer exports the function, so every call
fails. Rather than ship a route that always errors on that engine, it answers `501` there.

**Request body** — `DemoteChannelAdminDto`

| Field    | Type   | Required | Description                                  |
| -------- | ------ | -------- | -------------------------------------------- |
| `userId` | string | Yes      | WhatsApp ID of the admin, e.g. `628xxx@c.us` |

**Response** `200` — `{ "success": true }`

**Errors:** `400` validation, or session not started · `401` · `403` the engine refused (not the owner, or the user is not an admin) · `409` conflict or engine not ready (retryable) · `501` the whatsapp-web.js engine cannot perform this · `503` WhatsApp did not answer within the request budget; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

#### POST /api/sessions/:sessionId/channels/:channelId/owner/transfer

Hand a channel this account owns to a new owner. **Baileys only** — the whatsapp-web.js engine
answers `501`.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

> **Irreversible.** Once the transfer lands, this session is no longer the owner and cannot take the
> channel back through this API.

The upstream option to also dismiss yourself as an admin in the same call is **not exposed**: the
WhatsApp Web function it depends on no longer exists, and it sits inside a branch that swallows its
own errors, so it would fail silently instead of refusing.

`whatsapp-web.js` declares `Client.transferChannelOwnership` and its page function is present, but on
current WhatsApp Web it rejects every call **locally** — measured at 4-9ms against a 352-531ms
known-server baseline in the same page — against a subscriber list the library has no working path to
repopulate. Rather than ship a route that always fails on that engine, it answers `501` there.

**Request body** — `TransferChannelOwnershipDto`

| Field        | Type   | Required | Description                                      |
| ------------ | ------ | -------- | ------------------------------------------------ |
| `newOwnerId` | string | Yes      | WhatsApp ID of the new owner, e.g. `628xxx@c.us` |

**Response** `200` — `{ "success": true }`

**Errors:** `400` validation, or session not started · `401` · `403` WhatsApp refused the transfer · `409` conflict or engine not ready (retryable) · `501` the whatsapp-web.js engine cannot perform this · `503` WhatsApp did not answer within the request budget, and the transfer may or may not have applied; on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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
  "verified": true,
  "createdAt": 1717200000
}
```

**Errors:** `400` `Session is not started`, missing/empty `inviteCode`, or any unknown body field · `401` missing/invalid API key · `403` API-key role below OPERATOR, or WhatsApp refused the follow · `404` no channel for that invite code · `409` conflict or engine not ready (retryable) · `501` not supported on the active engine · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

Note: the controller returns a literal `{ success: true }` after the void engine call resolves, as the channel delete, mute, admin demote and ownership transfer routes do. There is no `@HttpCode` override, so it returns `200`, not `204`.

**Errors:** `400` `Session is not started` · `401` missing/invalid API key · `403` API-key role below OPERATOR, or WhatsApp refused the unfollow (for example the account does not follow the channel) · `404` the id is not a channel (does not end in `@newsletter`) · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable); on Baileys, also when WhatsApp rate-limits or times out the request (code 429 or 408): retry after a pause

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

**Reads are store-backed, not engine-direct.** `GET /status` and `GET /status/:id` no longer call the engine — they read from an OpenWA-side store that ingests inbound status/story broadcasts as they arrive (plus a best-effort backfill of currently-active stories on session connect), with a 24h TTL matching WhatsApp's own story expiry. This makes reads **identical on both engines**: `whatsapp-web.js` (which had a native `getBroadcasts()`/`getBroadcastById()` path) and Baileys (which never had one — `fetchStatus` only returns the _about_ text, not stories, so the raw engine methods still throw `501` if called directly, they're just no longer on the read path) now return the same shape from the same source. A status older than 24h, or received before the store existed, will not appear.

#### GET /api/sessions/:sessionId/labels

List all labels defined for the session. Labels exist only on a WhatsApp Business account: on whatsapp-web.js a personal account answers `200` with an empty array, not an error. Baileys has no label read and answers `501` on either account type.

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

**Errors:** `400` session is not started (no live engine) · `401` missing/invalid API key · `501` the Baileys engine does not implement label reads (whatsapp-web.js only) · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-read (retryable)

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

**Errors:** `400` session is not started · `401` missing/invalid API key · `404` `Label <labelId> not found` · `501` the Baileys engine does not implement label reads (whatsapp-web.js only) · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-read (retryable)

#### GET /api/sessions/:sessionId/labels/:labelId/chats

Every chat carrying a label.

**Auth:** API key · **Scope:** session-scoped · **Engines:** whatsapp-web.js only

**Response** `200` — a bare array of `ChatSummary`, the same shape `GET /sessions/:sessionId/chats` returns.

**Errors:** `400` session not started (also when the session does not exist) · `401` · `404` label or chat not found · `501` Baileys, which has no label query · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died or the command timed out, so nothing was read (retryable; says nothing about whether the label exists)

#### PUT /api/sessions/:sessionId/labels/:labelId

Create or update a label.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped · **Engines:** Baileys only

The label id is **yours to choose** and travels in the path. Whether this creates or updates depends
only on whether that id already exists — reusing one rewrites that label rather than failing.
The write replaces the whole label, so send every field it should keep: an omitted name or colour
is not preserved.

**Request body** — `UpsertLabelDto`

| Field   | Type   | Required | Constraints  | Description                                  |
| ------- | ------ | -------- | ------------ | -------------------------------------------- |
| `name`  | string | No       | 1–100 chars  | Not preserved when omitted                   |
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

**Errors:** `400` validation, or session not started (also when the session does not exist) · `401` · `403` · `501` whatsapp-web.js, which cannot edit labels · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

#### DELETE /api/sessions/:sessionId/labels/:labelId

Delete a label. It disappears from every chat it was on.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped · **Engines:** Baileys only

**Response** `200`

```json
{ "success": true }
```

**Errors:** `400` session not started (also when the session does not exist) · `401` · `403` · `501` whatsapp-web.js, which cannot edit labels · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

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

**Errors:** `400` session is not started · `401` missing/invalid API key · `501` the Baileys engine does not implement label reads (whatsapp-web.js only) · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-read (retryable)

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

**Errors:** `400` validation failure (missing/empty/non-string `labelId`, or any unknown body field — strict whitelist), or session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` (whatsapp-web.js) the chat does not exist on this session, so nothing was written, or the account has no label with this `labelId` (`Label <labelId> not found`), so the chat's labels are unchanged · `409` conflict or engine not ready (retryable) · `422` labels require a WhatsApp Business account, or the chat type has no labels · `503` session not ready or dependency unavailable (retryable)

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

**Errors:** `400` session is not started · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` (whatsapp-web.js) the chat does not exist on this session, so nothing was written · `409` conflict or engine not ready (retryable) · `422` labels require a WhatsApp Business account, or the chat type has no labels · `503` session not ready or dependency unavailable (retryable)

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
      "mediaUrl": "/api/sessions/0a941dac-a965-45e7-b318-74ae8be134f0/status/false_6281234567890@c.us_3A1F.../media",
      "backgroundColor": "#25D366",
      "font": 2,
      "timestamp": "2026-06-25T08:30:00.000Z",
      "expiresAt": "2026-06-26T08:30:00.000Z"
    }
  ]
}
```

The controller wraps the store array in `{ statuses }`, ordered newest-first. `type` is one of `text | image | video | voice` (`voice` was added with the send-voice endpoint below; before that anything that was not an image or a video read back as `text`); `caption`, `backgroundColor`, `font` are optional. `mediaUrl` is present only when the status carried media that the store kept (see the media endpoint below) — it is a same-origin path into this API, not an external WhatsApp CDN link. `timestamp` and `expiresAt` serialize to ISO strings (these are `Date` values, not the epoch-number convention used by message timestamps).

**Errors:** `401` missing/invalid API key · `403` key not scoped to this session

#### GET /api/sessions/:sessionId/status/:id

Get status updates posted by a specific contact, read from the store (24h TTL, both engines).

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                                       |
| --------- | ------ | ----------------------------------------------------------------- |
| sessionId | string | WhatsApp session identifier                                       |
| id        | string | Contact JID/id whose statuses to read (e.g. `6281234567890@c.us`) |

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

**Errors:** `401` missing/invalid API key · `403` key not scoped to this session

#### GET /api/sessions/:sessionId/status/:statusId/media

Stream a stored status's media bytes (the file behind a `mediaUrl` returned above).

**Auth:** API key

**Path parameters**

| Name      | Type   | Description                                          |
| --------- | ------ | ---------------------------------------------------- |
| sessionId | string | WhatsApp session identifier                          |
| statusId  | string | The status `id` (e.g. from a `GET /status` response) |

**Response** `200` — the raw media bytes as the response body, served as an **attachment** (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`). `Content-Type` is the essence of the stored mimetype (see below) when that is a single image, video or audio type other than `image/svg+xml`, which is scriptable despite the `image/` prefix, and `application/octet-stream` otherwise, so no stored status media is ever served as active content on the API origin. Streamed via `StreamableFile` from whatever backs `StorageService` (local disk or S3 — the route does not care which).

Only the essence of the stored mimetype is checked and served: the part before any `;`, trimmed and lowercased, since MIME types are case-insensitive. Parameters are dropped, and a value that is not a single well-formed type (a comma-joined list, for example) is served as `application/octet-stream`.

**Errors:** `401` missing/invalid API key · `403` key not scoped to this session · `404` `Status media not found or expired` — the status is text-only, its media was omitted (e.g. over the configured size cap), or the 24h TTL has since purged the row

Note: `:statusId/media` is a two-path-segment route, so it never collides with the single-segment `GET /status/:id` above regardless of declaration order.

#### POST /api/sessions/:sessionId/status/send-text

Post a text status (story) to the session's status feed. The recipients allow-list is honored on Baileys only; whatsapp-web.js broadcasts to the account's status-privacy audience.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                 |
| --------- | ------ | --------------------------- |
| sessionId | string | WhatsApp session identifier |

**Request body** — `SendTextStatusDto`

| Field           | Type     | Required | Constraints                                                          | Description                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------- | -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text            | string   | yes      | not blank (`@Matches(/\S/)`), `@MaxLength(4096)`                     | Status text body                                                                                                                                                                                                                                                                                                                                   |
| recipients      | string[] | no       | 0–256 items, each matching `^\d+@(c\.us\|lid)$`                      | JIDs of the contacts permitted to view the status. **Honored on Baileys only** (passed as `statusJidList`), where it is required: an absent or empty list is refused with `400` `recipients is required to post a status on the Baileys engine`. whatsapp-web.js ignores it and broadcasts to the account's status-privacy audience; omit it there |
| backgroundColor | string   | no       | 6-digit hex color matching `^#[0-9A-Fa-f]{6}$`                       | e.g. `#25D366`; bad value → `backgroundColor must be a hex color (e.g., #25D366)`                                                                                                                                                                                                                                                                  |
| font            | integer  | no       | `@IsIn([0, 1, 2, 6, 7, 8, 9, 10])` — `3`–`5` are rejected with `400` | WhatsApp status font index: `0` (default), `1`, `2`, `6` (bold), `7`, `8`, `9`, `10`. whatsapp-web.js honors only `0`–`7` and clamps anything above back to the default                                                                                                                                                                            |

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

**Errors:** `400` validation failure (unknown body field, a JID not matching `@c.us`/`@lid`, more than 256 recipients, `text` over 4096 chars, bad `backgroundColor`/`font`), or (Baileys) no `recipients`, or the post was blocked by a plugin · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected · `409` conflict or engine not ready (retryable)

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

**Errors:** `400` validation failure (unknown body field, an empty media wrapper, a JID not matching `@c.us`/`@lid`, more than 256 recipients, or a caption over 1024 chars), or a `url` that answers non-2xx, times out or cannot be reached, or (Baileys) no `recipients`, or the post was blocked by a plugin · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected · `409` conflict or engine not ready (retryable) · `413` base64 or downloaded media over the media cap (see §6.3) · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable)

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

**Errors:** `400` validation failure (unknown body field, an empty media wrapper, a JID not matching `@c.us`/`@lid`, more than 256 recipients, or a caption over 1024 chars), or a `url` that answers non-2xx, times out or cannot be reached, or (Baileys) no `recipients`, or the post was blocked by a plugin · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected · `409` conflict or engine not ready (retryable) · `413` base64 or downloaded media over the media cap (see §6.3) · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable)

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

**Errors:** `400` validation failure, neither `url` nor `base64` supplied, or a `url` that answers non-2xx, times out or cannot be reached, or (Baileys) no `recipients`, or the post was blocked by a plugin · `401` missing/invalid API key · `403` key lacks `OPERATOR` role · `404` session not found / not connected · `413` base64 or downloaded media exceeds `MEDIA_DOWNLOAD_MAX_BYTES` · `409` conflict or engine not ready (retryable) · `503` a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable)

#### DELETE /api/sessions/:sessionId/status/:id

Delete one of the session's own posted statuses.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                                                             |
| --------- | ------ | ----------------------------------------------------------------------- |
| sessionId | string | WhatsApp session identifier                                             |
| id        | string | Id of the status to delete (the `statusId` returned by a `send-*` call) |

**Response** `200`

```json
{ "message": "Status deleted successfully" }
```

The service returns `void`; the controller returns a fixed success object. DELETE default status is `200`.

**Errors:** `401` missing/invalid API key · `403` key lacks `OPERATOR` role, or (whatsapp-web.js) the id is not one of the account's own statuses, or (Baileys) this session did not post the status in the last 24 hours, so its recipients are unknown (a status posted from the phone or from another node, or before this session's engine was last created, is refused too: a process restart, a session stop and start, and a reconnect the gateway runs itself, such as after a failed liveness check, each create a new one) · `404` `Session {id} not found or not connected` · `409` conflict or engine not ready (retryable) · `503` the whatsapp-web.js page died mid-request, so the revoke did not complete

Safe to retry: revoking an already-revoked status converges. The status POST routes deliberately do
NOT answer `503` for the same failure, because whatsapp-web.js can throw after the request is on the
wire and a client replaying on `503` would publish the status a second time. They answer an opaque
`500` there, exactly as the message sends do.

### 6.4.8 Webhooks (management)

Webhooks are configured per session and managed under `/api/sessions/:sessionId/webhooks` (handled by `WebhookController`). Three cross-session endpoints live on `WebhooksListController`: `GET /api/webhooks` (list, **OPERATOR**), `GET /api/webhooks/delivery-failures` (dead-letter log, **ADMIN**) and `POST /api/webhooks/delivery-failures/redrive` (replay of that log, **ADMIN**). Every other route requires an API key with **OPERATOR** role or higher.

Two fields — `secret` and `headers` — are **write-only**: they are accepted on create/update but are never returned by any webhook route (the response DTO has no `@Expose` for them, so `fromEntity` drops them). `GET /api/infra/export-data` also omits both from its `webhooks` rows, so a backup no longer carries webhook credentials — a restored webhook comes back unsigned (`secret` null, `headers` `{}`) until you set them again. The `secret` is used to compute the `X-OpenWA-Signature: sha256=<hex>` HMAC-SHA256 header on deliveries.

The `events` array accepts these members plus the `*` wildcard: `message.received`, `message.sent`, `message.ack`, `message.failed`, `message.revoked`, `message.reaction`, `message.edited`, `session.status`, `session.qr`, `session.authenticated`, `session.disconnected`, `session.reconnect_loop`, `session.restriction`, `presence.update`, `call.accepted`, `call.rejected`, `call.missed`, `group.join`, `group.leave`, `group.update`, `group.join_request`, `call.received`, `status.received`. All of them are actively dispatched by at least one engine — none is a reserved placeholder. Four are **Baileys only**, because whatsapp-web.js produces no callback behind them: `presence.update` (its prerequisite `POST .../presence/subscribe` answers `501` there, so this one announces itself) and `call.accepted` / `call.rejected` / `call.missed` (whatsapp-web.js has no call-outcome callback, so these three are accepted on subscribe and then simply never fire). `call.received` is dispatched by both engines but is not reliable on whatsapp-web.js: it fired there in a live test on 2026-09-17 and did not in one on 2026-08-10. See the per-event catalog below for engine scope.

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

List webhook deliveries that exhausted their retries or were not sent (attempts 0), most recent first. A shed or shutdown-refused delivery is replayed by the outbox until its replay budget runs out; an oversize payload or a preflight failure on first dispatch is not replayed. This is the dead-letter trail referenced by §6.6 — a receiver outage longer than the retry window, an over-budget payload, or a blocked (SSRF-guarded) URL lands here instead of vanishing.

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
    "lastError": "HTTP 502: Bad Gateway",
    "createdAt": "2026-06-25T11:59:00.000Z",
    "replayable": false
  }
]
```

Bare array of `WebhookDeliveryFailure` rows, ordered by `createdAt` descending. `lastStatusCode` is `null` when the failure was a network/timeout/SSRF error rather than a non-2xx response; `idempotencyKey`/`deliveryId` let you correlate the lost event with your own receiver logs.

`replayable` is `true` when the row still holds the event data and can be replayed with [`POST /api/webhooks/delivery-failures/redrive`](#post-apiwebhooksdelivery-failuresredrive). The event data itself is never returned. Only terminal rows (`attempts` > 0) recorded while `WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS` > 0 keep it, and only until that window passes; with the default `0` every row reads `false`.

A delivery shed because the dispatch queue was full, or refused during shutdown, is recorded here with `attempts: 0` while its outbox row stays pending, so the outbox sweep replays it. With the queue disabled, a delivery that shutdown interrupts while it waits out a retry backoff is recorded the same way (`attempts: 0`, `lastError` `ConcurrencyLimiter closed`) if the backoff ends within `WEBHOOK_SHUTDOWN_DRAIN_MS`, although its earlier attempts were sent and their responses are not in the row; one still asleep when the drain ends is only logged (`webhook_delivery_abandoned_shutdown`). Either way its outbox row stays pending, and the replay on the next start replaces or clears the row. Any delivery the receiver accepts with a `2xx`, inline or from a queued job, removes the rows filed under its idempotency key, so a replay that succeeds leaves none. A replay that exhausts its retries files a row carrying the real error and attempt count and only then removes the `attempts: 0` row, so the event stays on record throughout, across a restart or a lost queue job too. A replay that fails before sending (a payload over the size cap after the `webhook:before` hooks, or one that cannot be serialized) gives the `attempts: 0` row that reason instead. A replay that keeps failing files no second row. `openwa_webhook_delivery_failures_total` counts the original shed, and counts once more if a replay also exhausts its retries.

**Errors:** `401` missing/invalid API key · `403` key role below ADMIN

Queued deliveries retain their pre-hook outbox copy until the worker completes delivery or stores a terminal failure. The reconciler checks the current job before replaying and keeps rows while Redis cannot be inspected. If failure persistence is unavailable after the replay budget is spent, it retries the storage handoff without another POST. This recovery boundary is best effort before the outbox row is created; receivers must still deduplicate repeated POSTs.

#### POST /api/webhooks/delivery-failures/redrive

Replay recorded webhook deliveries that still hold their event data, in one bounded batch, with the lowest attempt counts first, then oldest first. A row is replayable when it is terminal (`attempts` > 0; an `attempts: 0` row is the outbox's to replay) and was recorded while `WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS` > 0, until that window passes. With the default `0` nothing is kept and this call replays nothing.

Each replay reuses the row's stored `idempotencyKey` (sent as `X-OpenWA-Idempotency-Key`), so receivers can deduplicate a POST that timed out after processing. `webhook:before` hooks run again on the stored pre-hook data. Each row gets **one direct POST** inside the request, including when ordinary dispatch uses the queue. Success removes its row and closes any outbox copy the sweep still holds for that event, so the sweep does not send it again; another failure keeps it and raises its attempt count. A sweep replay of the same event already under way can still POST it again under the same key. Calls on one node run serially. Graceful shutdown stops a batch at its next row and waits for the replays still running (at most four), including their `webhook:before` hooks; each POST is bounded by `WEBHOOK_TIMEOUT`. Rows it did not reach stay for a later call, and a call queued behind it replays nothing. The audit log records counts without payload content.

Choose a batch limit that fits the client's timeout, especially for unavailable receivers. A client
timeout does not cancel the batch; inspect the failure log before retrying it.

**Auth:** API key (ADMIN) · **Scope:** rows are confined to the calling key's `allowedSessions`; the body's `sessionId` can only narrow that. A row is replayed only to the webhook it was recorded for, and only while that webhook still belongs to the row's session.

**Request body** (every field optional; an empty body `{}` takes the eligible rows with the fewest attempts)

| Field       | Type            | Required | Validation                                   | Description                                                               |
| ----------- | --------------- | -------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `sessionId` | string          | no       | `@IsString`, `@MaxLength(128)`               | Only rows of this session.                                                |
| `webhookId` | string          | no       | `@IsString`, `@MaxLength(128)`               | Only rows of this webhook.                                                |
| `ids`       | string[]        | no       | `@IsArray`, `@ArrayMaxSize(500)`, each ≤ 128 | Only these failure rows (ids from `GET /api/webhooks/delivery-failures`). |
| `limit`     | integer (1-500) | no       | `@IsInt`, `@Min(1)`, `@Max(500)`             | Max rows replayed by this call. Defaults to `100`.                        |

**Response** `200`

```json
{
  "redriven": 3,
  "delivered": 3,
  "enqueued": 0,
  "failed": 0,
  "skipped": 0,
  "remaining": 0
}
```

`redriven` equals `delivered`; `enqueued` is retained for response compatibility and is always `0`. A row is excluded before applying the limit when it has `attempts: 0`, holds no event data, is past the retention window or out of scope, or its webhook is removed, disabled, unsubscribed from the event or no longer in the row's session. `skipped` counts selected rows cancelled by a hook or invalidated during the call. `remaining` counts eligible rows in the same requested session, webhook and IDs after the call. Retry another batch only after resolving persistent failures or hook cancellations; `remaining > 0` alone does not mean another call will succeed.

**Errors:** `400` body fails validation · `401` missing/invalid API key · `403` key role below ADMIN

#### POST /api/sessions/:sessionId/webhooks

Create a webhook for the session.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                                                                                                                                   |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| sessionId | string | Session the webhook is scoped to; stored as `webhook.sessionId`. The session must exist — an unknown id is refused with `404` at create time. |

**Request body** — `CreateWebhookDto`

| Field      | Type                   | Required | Constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| url        | string                 | yes      | `@IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })` (allows hostnames without a dot, e.g. `http://localhost:3000`), `@MaxCodePoints(2048)`; also run through the SSRF guard, which can reject with `400`.                                                                                                                                                                                                                                                                                                                      | Webhook URL to receive events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| events     | string[]               | no       | `@IsArray`, `@ArrayMinSize(1)`, `@IsIn([...WEBHOOK_EVENTS, '*'], { each: true })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Event names to subscribe to (see allowed set above). Defaults to `["message.received"]` when omitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| secret     | string                 | no       | `@IsString`, `@MinLength(16)`, `@MaxCodePoints(255)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | HMAC-SHA256 signing key. **Write-only** — never returned by a webhook route (not returned by `GET /api/infra/export-data` either). Used for `X-OpenWA-Signature`. Defaults to `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| headers    | Record<string,string>  | no       | `@IsHeaderMap()`: flat object (not array), ≤50 entries, names match `/^[A-Za-z0-9-]+$/` and are unique ignoring case, values are strings ≤1024 chars with no C0 control/DEL (CR/LF injection guard) and nothing above U+00FF (Latin-1 only).                                                                                                                                                                                                                                                                                                                      | Custom headers added to deliveries. **Write-only** — never returned by a webhook route (not returned by `GET /api/infra/export-data` either). At delivery, `content-type`, `user-agent` and `x-openwa-*` names are stripped, and so are the connection-level names the HTTP client owns: `connection`, `content-length`, `expect`, `keep-alive`, `te`, `trailer`, `transfer-encoding` and `upgrade`. Defaults to `{}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| filters    | WebhookFilters \| null | no       | `@IsValidWebhookFilters()`, i.e. `{ conditions: [...] }`; each condition `{ field, operator('is'\|'isNot'\|'contains'\|'equals'), value(string\|string[]\|boolean), caseSensitive?:boolean }`; bounds: max 20 conditions, 100 values/condition, 1000-char text values. Message fields: `sender`, `recipient`, `chatId`, `body`, `type`, `isGroup`, `kind`, `fromMe`, `hasMedia`, `mentions`. An id-valued condition accepts a bare phone number, but a group must be written as its full `<id>@g.us` JID: bare digits canonicalise to `@c.us` and match no group. | Optional AND pre-filter; **all** conditions must match for the webhook to fire. Omit/null = fire on every subscribed event. Defaults to `null`. ⚠️ A condition whose field is DEFINED for the event family but absent from that event's payload does not scope the event, it decides it outright: an `is`, `contains` or `equals` condition cannot match and suppresses the event, while an `isNot` condition passes it, and so does a boolean field compared with `false`, because an absent boolean reads as `false` (a field with no definition for the family is skipped instead). `message.ack`/`message.failed` carry `{ id, messageId, status, ack, chatId? }` and `message.reaction` carries `{ messageId, chatId, reaction, senderId }`, none of which has a sender or body, so a `sender` `is` filter silently drops all three and a `sender` `isNot` filter delivers all three. The `chatId` on an ack or failure is the conversation the acked message belongs to, present whenever the engine's update names the chat (both engines do on the live path), so a `chatId` condition scopes acks and failures to that chat; on a payload without it the generic absent-field rule above applies. Scope the subscription with `events[]` rather than relying on a filter to be inert. Set `LOG_LEVEL=debug` to see each suppression and the payload fields that were available. |
| retryCount | number (int)           | no       | `@IsInt`, `@Min(0)`, `@Max(5)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Total delivery attempts per event, including the first: `0` and `1` both mean a single attempt with no retry. An event that exhausts them is recorded in `GET /api/webhooks/delivery-failures`; the webhook stays active. Defaults to `3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

```json
{
  "url": "https://your-server.com/webhook",
  "events": ["message.received", "session.status"],
  "secret": "your-webhook-signing-secret",
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

**Errors:** `400` validation failure, unknown body field (whitelist), URL rejection (SSRF guard, or embedded credentials in the URL), or the per-session webhook limit (`WEBHOOK_MAX_PER_SESSION`, default 16 — delete an existing webhook before registering another; webhooks already above the cap are grandfathered and keep working) · `401` missing/invalid API key · `403` insufficient role · `404` session not found (message `"Session with id '<id>' not found"`)

#### PUT /api/sessions/:sessionId/webhooks/:id

Update a webhook. Partial — only fields present in the body are changed.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type          | Description                                                                                        |
| --------- | ------------- | -------------------------------------------------------------------------------------------------- |
| sessionId | string        | Session scope; the webhook is looked up by `(sessionId, id)` first → `404` if not in this session. |
| id        | string (uuid) | Webhook ID.                                                                                        |

**Request body** — `UpdateWebhookDto` (all fields optional; only fields where the value is not `undefined` are applied)

| Field      | Type                   | Required | Constraints                                                                                                                                                                                                                                                 | Description                                                                   |
| ---------- | ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| url        | string                 | no       | omit to skip (explicit `null` → `400`), `@IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })`, `@MaxCodePoints(2048)`; re-runs the credential and SSRF checks only when it differs from the stored URL → `400` if blocked. | New URL.                                                                      |
| events     | string[]               | no       | omit to skip (explicit `null` → `400`), `@IsArray`, `@ArrayMinSize(1)`, `@IsIn([...WEBHOOK_EVENTS, '*'], { each: true })`                                                                                                                                   | Same allowed set as create (incl. `*`).                                       |
| secret     | string                 | no       | `@IsOptional`, `@IsString`, `@MinLength(16)` (skipped for `""`, which clears it), `@MaxCodePoints(255)`                                                                                                                                                     | **Write-only.** An empty string is normalized to `null`, which disables HMAC. |
| headers    | Record<string,string>  | no       | omit to skip (explicit `null` → `400`), `@IsHeaderMap()` (same constraints as create)                                                                                                                                                                       | **Write-only.** Replaces existing headers wholesale when provided.            |
| filters    | WebhookFilters \| null | no       | `@IsOptional`, `@IsValidWebhookFilters()`                                                                                                                                                                                                                   | Set to `null` or `{ conditions: [] }` to clear filters.                       |
| active     | boolean                | no       | omit to skip (explicit `null` → `400`), `@IsBoolean`                                                                                                                                                                                                        | Enable/disable the webhook. (Present only on update, not create.)             |
| retryCount | number (int)           | no       | omit to skip (explicit `null` → `400`), `@IsInt`, `@Min(0)`, `@Max(5)`                                                                                                                                                                                      | Total delivery attempts per event, including the first.                       |

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

**Errors:** `400` validation failure, unknown body field (whitelist), or URL rejection (SSRF guard, or embedded credentials in the URL) · `401` missing/invalid API key · `403` insufficient role · `404` webhook not found in this session

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

Every test call carries a fresh `X-OpenWA-Idempotency-Key` (`test_<deliveryId>_<webhookId>`), so a receiver that dedups on it runs its handler for each test.

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

API keys are managed under `/api/auth/api-keys`. All management routes (create/list/get/update/delete/revoke) require an **ADMIN** key **with no session scope**: the controller is fenced with `@RequireUnscopedKey`, so a key whose `allowedSessions` is non-empty is rejected with `403` whatever its role — otherwise a confined admin key could mint an unrestricted one. The guard evaluates the role requirement _before_ that fence, so a scoped VIEWER/OPERATOR key is refused with `Insufficient permissions. Required: admin`; only a scoped ADMIN key reaches the fence and sees `Session-scoped API keys are not permitted on this route`. Both are `403`. A key restricted with `allowedChats` that passes the role check is refused next, before the session fence, with `403 "API key is restricted to selected chats"`: no management route is open to a chat-scoped key. The plaintext key string is returned **only once**, at creation. Validation of the caller's own key lives at `POST /api/auth/validate` (a separate controller, not fenced) and accepts any valid key except one its `allowedIps` refuses or one restricted with `allowedChats`, each refused with `403` (the latter like every route not open to a chat-scoped key).

#### GET /api/auth/api-keys

List all API keys, newest first. The plaintext key is never returned.

**Auth:** API key (ADMIN)

**Response** `200`

Bare JSON array (no envelope), ordered by `createdAt` DESC. Null array/date fields are omitted. A key stored with an expiry that cannot be read as a date reports `expiresAt` as `1970-01-01T00:00:00.000Z` here and in every other key response, and is refused as expired; give it a new expiry with `PUT /api/auth/api-keys/:id`.

```json
[
  {
    "id": "3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33",
    "name": "Production Bot",
    "keyPrefix": "owa_k1_a1b2c",
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

**Errors:** `401` missing/invalid `X-API-Key` · `403` key role below ADMIN, or the key is session-scoped or restricted with `allowedChats`

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
  "keyPrefix": "owa_k1_a1b2c",
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

**Errors:** `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped or restricted with `allowedChats` · `404` `"API key with id '<id>' not found"`

#### POST /api/auth/api-keys

Create a new API key; returns the full plaintext key exactly once.

**Auth:** API key (ADMIN)

**Request body** — `CreateApiKeyDto`

| Field             | Type                                   | Required | Constraints                                                                                                                                                  | Description                                                                       |
| ----------------- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `name`            | string                                 | yes      | length 3–100                                                                                                                                                 | Friendly name for the key.                                                        |
| `role`            | enum `admin` \| `operator` \| `viewer` | no       | `@IsEnum`                                                                                                                                                    | Defaults to `operator` when omitted.                                              |
| `allowedIps`      | string[]                               | no       | each entry a valid **IPv4** address or IPv4 CIDR `/0-32`; IPv6 rejected                                                                                      | IP whitelist (IPv4-only by design).                                               |
| `allowedSessions` | string[]                               | no       | each `@IsString`, `@ArrayUnique`; each entry non-empty, no surrounding whitespace, no comma                                                                  | Session IDs this key may access.                                                  |
| `allowedChats`    | string[]                               | no       | unique entries, each a group `<id>@g.us`, a contact `<phone>@c.us` / `<lid>@lid`, or a bare phone number                                                     | Chat IDs this key may reach (see [Roles & Authorization](#roles--authorization)). |
| `expiresAt`       | string (ISO 8601 date)                 | no       | `@IsDateString`, and must parse as a date: an ISO week, ordinal or basic form such as `2026-W40-1` is refused with `400 "expiresAt is not a parseable date"` | Stored as a `Date`.                                                               |

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
  "keyPrefix": "owa_k1_01234",
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

**Errors:** `400` validation (bad `name` length, invalid `role` enum, non-IPv4 `allowedIps` entry, bad `expiresAt`, or any non-whitelisted body field) · `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped or restricted with `allowedChats`

#### PUT /api/auth/api-keys/:id

Update mutable fields of an API key. `isActive` is **not** updatable here — use the revoke route to deactivate.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type          | Description |
| ---- | ------------- | ----------- |
| `id` | string (uuid) | API key id. |

**Request body** — `UpdateApiKeyDto`

| Field             | Type                                   | Required | Constraints                                                                                 | Description                                                                                              |
| ----------------- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `name`            | string                                 | no       | length 3–100                                                                                | Applied only if truthy.                                                                                  |
| `role`            | enum `admin` \| `operator` \| `viewer` | no       | `@IsEnum`                                                                                   | Applied only if truthy.                                                                                  |
| `allowedIps`      | string[]                               | no       | IPv4 address / CIDR only                                                                    | Applied if not `undefined` (can be set to `[]` to clear).                                                |
| `allowedSessions` | string[]                               | no       | each `@IsString`, `@ArrayUnique`; each entry non-empty, no surrounding whitespace, no comma | Applied if not `undefined`.                                                                              |
| `allowedChats`    | string[]                               | no       | same as create                                                                              | Applied if not `undefined` (`[]` clears it, making the key unrestricted).                                |
| `expiresAt`       | string (ISO 8601 date) \| null         | no       | `@IsDateString`, and must parse as a date (same as create)                                  | Applied if not `undefined`; `null` clears the expiry (an empty string fails `@IsDateString` with `400`). |

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
  "keyPrefix": "owa_k1_a1b2c",
  "role": "viewer",
  "allowedIps": ["203.0.113.5"],
  "isActive": true,
  "expiresAt": "2028-01-01T00:00:00.000Z",
  "usageCount": 42,
  "createdAt": "2026-06-01T10:00:00.000Z"
}
```

**Errors:** `400` validation (incl. `forbidNonWhitelisted` for unknown fields such as `isActive`), or an `expiresAt` that does not parse as a date · `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped or restricted with `allowedChats` · `404` not found · `409` change would remove the last usable admin key, or no other usable admin key lasts at least as long

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
  "keyPrefix": "owa_k1_a1b2c",
  "role": "operator",
  "isActive": false,
  "usageCount": 42,
  "createdAt": "2026-06-01T10:00:00.000Z"
}
```

**Errors:** `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped or restricted with `allowedChats` · `404` not found · `409` target is the last usable admin key, or no other usable admin key lasts at least as long

#### DELETE /api/auth/api-keys/:id

Permanently delete an API key (hard delete). Also drops any un-flushed usage accumulator.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type          | Description |
| ---- | ------------- | ----------- |
| `id` | string (uuid) | API key id. |

**Response** `204`

`@HttpCode(204)` — no response body.

**Errors:** `401` missing/invalid key · `403` key role below ADMIN, or the key is session-scoped or restricted with `allowedChats` · `404` `"API key with id '<id>' not found"` · `409` target is the last usable admin key, or no other usable admin key lasts at least as long

#### POST /api/auth/validate

Validate the supplied `X-API-Key` and report its validity, its role, and the engine the gateway runs.

**Auth:** API key (any valid role — VIEWER+)

The key is read from the `X-API-Key` header, not the body; send an empty body. This route sits behind the global guard (it is not `@Public`), so a missing/invalid/revoked/expired key is rejected with `401` at the guard before the handler runs, and a key refused by its `allowedIps` with `403`. On success it returns the caller's role and `engineType`, the engine the process resolved at boot (`whatsapp-web.js` or `baileys`). The engine is reported to every role because `GET /api/infra/engines/current` is ADMIN-only. It also returns `scoped`, true when the key is restricted to selected sessions (a non-empty `allowedSessions`). A key restricted with `allowedChats` is refused with `403 "API key is restricted to selected chats"`: the route is not open to a chat-scoped key.

**Response** `200`

```json
{ "valid": true, "role": "operator", "engineType": "whatsapp-web.js", "scoped": false }
```

**Errors:** `401` missing/invalid/revoked/expired key (raised by the global guard before the handler); `403` a key refused by its `allowedIps` (blocked or undeterminable client IP), or one restricted with `allowedChats`

> Implemented by `AuthValidateController` (`@Controller('auth')`), sharing the same `/api/auth` base.

### 6.4.10 System (Health, Metrics, Stats, Settings, Audit)

System endpoints expose operational status, Prometheus metrics, aggregate statistics, runtime settings, and the audit log. Health and metrics use non-standard auth (public / Bearer token); stats, settings and audit use the API key, with several routes gated to `ADMIN`.

#### GET /api/health

Basic health check returning status and the current timestamp; the running app version is disclosed only to authenticated callers.

**Auth:** public — the check itself needs no credentials, so uptime probes keep working. The `version` field is added only when the request carries a valid API key (`X-API-Key` header or `Authorization: Bearer`); an absent or invalid key still answers `200` without it.

**Response** `200`

```json
{ "status": "ok", "timestamp": "2026-06-25T12:34:56.789Z", "version": "0.7.3" }
```

Notes: `timestamp` is an ISO-8601 string (`new Date().toISOString()`). `version` is read from `package.json` at module load and present only on an authenticated request. Exempt from rate limiting (`@SkipThrottle`).

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

**Errors:** `503` — either datasource fails or exceeds its 3 s `SELECT 1` timeout, or the app is shutting down. The handler throws `ServiceUnavailableException` with the `{ status, details }` object, and NestJS sends that object as the whole body (no `statusCode`/`message`/`error` wrapper):

```json
{
  "status": "error",
  "details": { "mainDatabase": { "status": "up" }, "dataDatabase": { "status": "down" } }
}
```

During shutdown the `details` instead read `{ "shutdown": { "status": "draining" } }`. Probes run in parallel via `Promise.all`. There is no `health/detailed` route.

#### GET /api/metrics

Prometheus exposition scrape of OpenWA process + session + message metrics; gated by a `METRICS_TOKEN` bearer (disabled when the token is unset).

**Auth:** Bearer METRICS_TOKEN — `Authorization: Bearer <METRICS_TOKEN>`. This route is `@Public()` (it bypasses the `X-API-Key` guard); access is instead validated inside the service with a constant-time compare. The `Bearer ` prefix is stripped case-insensitively. Published in the OpenAPI spec under the `metrics-bearer` security scheme.

**Response** `200`

Content-Type `text/plain; version=0.0.4; charset=utf-8`, `Cache-Control: no-store`. Raw text (no JSON envelope):

When the data database cannot be read the database-derived series (`openwa_sessions*`,
`openwa_messages*`) are OMITTED rather than reported as zero — a zero would fire an alert
claiming every session had dropped. `openwa_stats_available` is what tells the two cases apart,
so alert on it rather than reading a missing series as zero. `docs/10` lists every series.

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
# TYPE openwa_stats_available gauge
openwa_stats_available 1
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

Values come from `StatsService.getOverview()` plus `process.memoryUsage()`/`process.uptime()`. The render is memoized for 5000 ms to avoid re-running the overview query on every scrape, and `getOverview()` is itself memoized for `STATS_CACHE_TTL_MS` (default 30 s), so the database-derived series and `openwa_stats_available` can trail the data database by up to `STATS_CACHE_TTL_MS` + 5 s plus the time the overview query takes (the memo TTL counts from when the query completes).

**Errors:** `401` — `METRICS_TOKEN` is configured but the bearer is missing or does not match (`{ "statusCode": 401, "message": "Invalid metrics token", "error": "Unauthorized" }`) · `404` — `METRICS_TOKEN` is unset/blank, so the endpoint is disabled (`{ "statusCode": 404, "message": "Metrics endpoint is disabled (set METRICS_TOKEN to enable)", "error": "Not Found" }`) · `429`: 10 failed token attempts from one client within a minute; only failures count, and the block lifts as the window slides (`{ "statusCode": 429, "message": "Too many failed metrics token attempts" }`).

The 429 applies to every request from the locked-out client, a valid token included, so scrape from an address that untrusted clients do not share (behind a reverse proxy, set `TRUSTED_PROXIES` so each client resolves to its own address).

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

Notes: raw handler return (no envelope). `sessions.byStatus` is keyed by the stored `SessionStatus` values — lowercase, per §6.4.1 — with per-status counts; `sessions.active` counts only `ready`. `messages.sent`/`received` are all-time outgoing/incoming COUNTs; `failed` is the `FAILED`-status COUNT; `today.*` are the same counts since local midnight.

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

Notes: raw handler return. `timeSeries.timestamp` is a DB-formatted bucket string — hourly `YYYY-MM-DD HH:00:00` for `24h`, daily `YYYY-MM-DD` for `7d`/`30d` — sorted ascending. `byType` keys are message-type strings (a null type becomes `unknown`). `bySession.name` is `Unknown` when the session is not found. `topChats` is the top 10 by `messageCount` DESC; each `chatName` is the contact's push name for a 1:1 chat, taken from its incoming messages, and `null` for a group or when none is known. All counts are numbers.

**Errors:** `400` — `period` not in the enum, or any non-whitelisted query field (strict `whitelist` + `forbidNonWhitelisted`) · `401` — missing/invalid API key · `403` — role below `ADMIN`, or the key is session-restricted.

#### GET /api/stats/sessions/:sessionId

Get statistics for a single session: identity, message counts, top chats, and 24 h hourly activity.

**Auth:** API key — any valid key (VIEWER and up); there is no `@RequireRole`. Scope still applies: the global guard feeds the `:sessionId` route param to the key's `allowedSessions`, so a session-scoped key asking for a session outside its list gets `403 "API key not authorized for this session"`. Only an unscoped key can read any session's stats.

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

Notes: raw handler return. `session.status` is the `SessionStatus` enum value. `messages.sent`/`received` are all-time outgoing/incoming COUNTs; `today` is the total message count since local midnight; `failed` is the `FAILED`-status count. `topChats` is the top 10 by count DESC, with `lastActive` = `MAX(createdAt)` as zone-less UTC text, `YYYY-MM-DD HH:MM:SS`, on both SQLite and PostgreSQL and `chatName` as in `GET /api/stats/messages`. `hourlyActivity` always has 24 entries (UTC hour `0..23`), missing hours zero-filled, computed over the last 24 h.

**Errors:** `401` — missing/invalid API key · `403` (the key is not scoped to this session) · `404` — session not found (`Session not found`).

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
    "webhookAlerts": false
  }
}
```

Notes: raw return of an in-memory `Settings` object built once in the controller constructor from the environment (snapshotted at construction, not re-read per request). `general.apiBaseUrl` reads `BASE_URL` (default `http://localhost:<PORT>`) and `general.debugMode` mirrors `DATABASE_LOGGING`. `api.rateLimitWindow` is in ms. `enableDocs` reflects the `ENABLE_SWAGGER` gate (enabled by default outside production; disabled by default in production unless explicitly enabled). `general.autoReconnect` (always `true`) and `notifications.*` (`emailEnabled: false`, `notificationEmail: ''`, `webhookAlerts: false`) are hardcoded; the `notifications.*` fields are fixed placeholders with no feature behind them.

**Errors:** `401` — missing/invalid `X-API-Key` · `403` — API key lacks the ADMIN role, or the key is session-restricted.

#### GET /api/audit

List audit-log entries, newest first. API-key lifecycle changes, session lifecycle events and ADMIN infra operations land here. **The eight actions below are never emitted**, so filtering for any of them returns zero rows by design: `message_sent` and `message_failed` (every send and its outcome is in the `messages` table), `webhook_triggered` and `webhook_failed` (tracked in `webhook_delivery_failures` and the `openwa_webhook_delivery_failures_total` counter), `webhook_created` and `webhook_deleted` (not wired yet), `api_key_used` (it would fire on every authenticated request; failed authentication is audited as `api_key_auth_failed`), and `session_connected` (an engine-level transition already reflected in `sessions.status`; the user-initiated `session_started` and `session_stopped` are audited).

**Auth:** API key (ADMIN) · **Scope:** rows are confined to the calling key's `allowedSessions` — the `sessionId` query may only narrow within that list, never widen it

**Query parameters**

| Name        | Type                          | Required | Default | Description                                                                                                                                                                                 |
| ----------- | ----------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`    | string                        | No       | —       | Filter by `AuditAction` (e.g. `api_key_created`, `session_started`, `infra_data_imported`). Message, webhook, `api_key_used` and `session_connected` actions are never emitted (see above). |
| `severity`  | `'info' \| 'warn' \| 'error'` | No       | —       | Filter by `AuditSeverity`.                                                                                                                                                                  |
| `sessionId` | string                        | No       | —       | Narrow to one session. A value outside the key's `allowedSessions` returns `{ "data": [], "total": 0 }`.                                                                                    |
| `apiKeyId`  | string                        | No       | —       | Filter by the acting key's id.                                                                                                                                                              |
| `limit`     | integer                       | No       | `50`    | Page size, clamped to a maximum of `200`.                                                                                                                                                   |
| `offset`    | integer                       | No       | `0`     | Rows to skip; a negative value resolves to `0`.                                                                                                                                             |

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
      "userAgent": null,
      "method": null,
      "path": null,
      "statusCode": null,
      "metadata": null,
      "errorMessage": null,
      "createdAt": "2026-06-25T11:42:07.000Z"
    }
  ],
  "total": 1
}
```

Unlike the other list routes this one is **not** a bare array: `data` is the page and `total` the unpaginated match count. Nullable columns (`apiKeyId`, `sessionId`, `metadata`, `errorMessage`, …) are `null` when the event has no such dimension. `userAgent` and `statusCode` are reserved columns nothing populates, so rows carry `null`. `method` and `path` are populated only where an emitter passes them explicitly (API-key auth failures, key lifecycle changes, queue-board mutations); session/message-flow rows like the sample leave them `null`.

**Errors:** `400` repeated `action` or `severity`, or a value not in its list · `401` missing/invalid API key · `403` key role below ADMIN

### 6.4.11 Administration (Infrastructure, Plugins, MCP)

Admin-facing operations: infrastructure status & config, the data/storage migration tooling, plugin lifecycle, and the optional MCP transport. Almost every route is **API key (ADMIN)**; the two exceptions are the public `GET /api/infra/health` and the `POST /mcp` JSON-RPC endpoint (see end of section). Every `/api/infra/*` and `/api/plugins/*` route except `GET /api/infra/health` and `PUT /api/plugins/:id/config/:sessionId` also refuses a key restricted to specific sessions (`@RequireUnscopedKey`): a key with a non-empty `allowedSessions` gets `403` `Session-scoped API keys are not permitted on this route` whatever its role, so use an unrestricted ADMIN key.

> Note on the MCP request body: the entire `POST /mcp` envelope (mounted as a raw Express handler, outside the Nest pipe chain) is a **plain TS interface, not a class-validator DTO** — the global `whitelist`/`forbidNonWhitelisted` ValidationPipe does **not** run on it. Unknown fields pass through silently and no type/constraint checks happen, except the few field-level guards noted per endpoint. The infra bodies — `ImportDataDto` (`POST /api/infra/import-data`), `SaveConfigDto` (`PUT /api/infra/config`), `RestartDto` (`POST /api/infra/restart`), `ImportStorageDto` (`POST /api/infra/storage/import`) — and the plugin DTOs (`InstallFromUrlDto`, `PluginConfigDto`, `PluginSessionsDto`) _are_ class-validated and reject unknown fields with `400`. `ImportDataDto` additionally accepts, and ignores, the five metadata fields the export wraps `tables` in, so the backup file posts back unmodified.

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
  "database": { "connected": true, "type": "sqlite", "host": "localhost", "builtIn": false },
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
    "browserArgs": "--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --lang=en-US",
    "webVersion": "2.3000.1040641150-alpha",
    "webVersionSource": "auto"
  },
  "envPinned": ["ENGINE_TYPE"]
}
```

The `queue.webhooks` counters are live BullMQ job counts (`pending` = waiting + active + delayed; plus `completed`/`failed`), degrading to zeros when the queue is disabled or Redis is unreachable. `redis.connected` is a live probe. `database.host` is the configured `DATABASE_HOST` (default `localhost`) and is reported on SQLite too, so read `type`, not `host`, to tell the database apart.

`builtIn` (on `database`/`redis`/`storage`) reports whether OpenWA's own bundled container is actually running _and_ backing this service, detected live from the labelled container; when Docker is unreachable it falls back to the saved `*_BUILTIN` intent from `data/.env.generated`. In S3 mode `storage` additionally carries `bucket` (when one is configured) and `s3Available` (re-probed, throttled, while false; once true it stays true until a restart, so a later outage does not clear it); in local mode neither key is present. `engine.webVersion`/`engine.webVersionSource` (`pinned` / `auto` / `native`) appear only on `whatsapp-web.js`; `webVersion` is `null` until the auto-resolve first succeeds. `engine.browserArgs` is the effective launch argument list: `PUPPETEER_ARGS` (or the four defaults shown) with `--lang=en-US` appended unless a `--lang` flag is already present.

`envPinned` lists which of `DATABASE_TYPE`, `REDIS_ENABLED`, `STORAGE_TYPE`, `STORAGE_LOCAL_PATH`, `ENGINE_TYPE`, `PUPPETEER_HEADLESS`, `SESSION_DATA_PATH` and `PUPPETEER_ARGS` the host environment or the project `.env` sets. Those layers win over `data/.env.generated`, so a value saved for one of these keys through `PUT /api/infra/config` cannot take effect until that layer is changed.

**Errors:** `401` missing/invalid key · `403` key role < ADMIN, or key is session-scoped

---

#### GET /api/infra/engines

List available WhatsApp engine plugins.

**Auth:** API key (ADMIN)

**Response** `200` — bare array

```json
[
  {
    "id": "whatsapp-web.js",
    "name": "WhatsApp Web.js Engine",
    "enabled": true,
    "features": ["text-messages", "media-messages", "group-management", "labels", "channels", "status-updates"],
    "library": { "name": "whatsapp-web.js", "version": "1.34.7" }
  }
]
```

`features` is shortened here. It is the engine plugin's own `getFeatures()` list, so it differs per engine:
Baileys adds `catalog` and omits `labels`, while whatsapp-web.js omits `catalog`. `library` is optional and may be
omitted per engine.

**Errors:** `401` · `403`

---

#### GET /api/infra/engines/current

Get the currently active engine type. A non-admin key reads the same value from `POST /api/auth/validate`.

**Auth:** API key (ADMIN)

**Response** `200`

```json
{ "engineType": "whatsapp-web.js" }
```

**Errors:** `401` · `403`

---

#### GET /api/infra/update-check

Compare the running version with the latest published OpenWA release. The dashboard uses it to show
admins a link to the release notes next to the version. The gateway reads GitHub's latest release
through the SSRF-guarded fetch and caches the answer for six hours (fifteen minutes after a failure).
The request goes out directly, not through `HTTP(S)_PROXY`. A pre-release or draft is never offered. A
failure never becomes an error response: an instance that has never reached `api.github.com` answers
`latest: null`, and one that has keeps the last release it saw. `UPDATE_CHECK_ENABLED=false` turns the
outbound request off.

A running pre-release counts as older than its own final release, so `X.Y.Z` is offered to an
instance on `X.Y.Z-rc.1`.

`current` is the running code's `package.json` version, so a build from `main` reports the last
release number until the next release bumps it.

**Auth:** API key (ADMIN)

**Response** `200`

```json
{
  "current": "0.23.5",
  "latest": "0.23.6",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/rmyndharis/OpenWA/releases/tag/v0.23.6"
}
```

**Errors:** `401` · `403`

---

#### GET /api/infra/config

Read the effective infrastructure config used to hydrate the dashboard form. Each field resolves with the boot precedence: a value pinned by the host environment (e.g. Compose `environment:`) or the project `.env` wins over `data/.env.generated`, while a key that only ever lived in the saved file reports the freshly-saved value even before a restart applies it ("saved, pending restart"). **Secrets are never returned** — only `*Set`/`*CredentialsSet` booleans indicate that a secret is stored.

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
    "browserArgs": "--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu"
  }
}
```

When nothing supplies a key — no pinned environment value and the file absent or silent about it — empty-string/default values are returned (`schema='public'`, `poolSize=10`, `sslRejectUnauthorized=true`, `engine.type='whatsapp-web.js'`, `headless=true`).

**Errors:** `401` · `403`

---

#### PUT /api/infra/config

Merge-save infrastructure config to `data/.env.generated` (a `0600` secret file). A partial payload preserves untouched keys; empty/omitted secret fields keep the existing stored secret.

**Auth:** API key (ADMIN)

**Request body** — `SaveConfigDto` (recursively class-validated; unknown or mistyped fields are rejected)

| Field                                                 | Type                     | Required                 | Constraints                               | Description                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------ | ------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database`                                            | object                   | No                       | —                                         | DB section (see nested)                                                                                                                                                        |
| `database.type`                                       | `'sqlite' \| 'postgres'` | If `database` is present | enum                                      | `sqlite` drops stale postgres keys; `postgres` writes connection keys                                                                                                          |
| `database.builtIn`                                    | boolean                  | No                       | —                                         | When `true`+postgres, forces the bundled `postgres` container creds + pushes `postgres` Docker profile                                                                         |
| `database.host` / `.port` / `.username` / `.database` | string                   | No                       | `port` is a string                        | External postgres connection (defaults `localhost`/`5432`/`postgres`/`openwa`)                                                                                                 |
| `database.schema`                                     | string                   | No                       | lower-case, no `pg_` prefix (else 400)    | Postgres schema, saved as `POSTGRES_SCHEMA`; an empty value writes `public` (also forced to `public` when switching to the built-in DB)                                        |
| `database.password`                                   | string                   | No                       | secret                                    | Empty/omitted keeps the existing stored secret                                                                                                                                 |
| `database.poolSize`                                   | number                   | No                       | —                                         | Default 10                                                                                                                                                                     |
| `database.sslEnabled`                                 | boolean                  | No                       | —                                         | Default false                                                                                                                                                                  |
| `database.sslRejectUnauthorized`                      | boolean                  | No                       | —                                         | Only written when `sslEnabled` is true; default true                                                                                                                           |
| `redis.enabled` / `.builtIn`                          | boolean                  | No                       | —                                         | `builtIn`+enabled forces `redis` container + profile                                                                                                                           |
| `redis.host` / `.port`                                | string                   | No                       | `port` is a string                        | Defaults `localhost`/`6379`                                                                                                                                                    |
| `redis.password`                                      | string                   | No                       | secret                                    | Empty keeps existing                                                                                                                                                           |
| `queue.enabled`                                       | boolean                  | No                       | —                                         | Writes `QUEUE_ENABLED`                                                                                                                                                         |
| `storage.type`                                        | `'local' \| 's3'`        | If `storage` is present  | enum                                      | `local` drops stale S3 keys; `s3` drops `STORAGE_LOCAL_PATH`                                                                                                                   |
| `storage.builtIn`                                     | boolean                  | No                       | —                                         | `true`+s3 uses bundled MinIO defaults + pushes `minio` profile                                                                                                                 |
| `storage.localPath`                                   | string                   | No                       | —                                         | Default `./data/media`                                                                                                                                                         |
| `storage.s3Bucket` / `.s3Region` / `.s3Endpoint`      | string                   | No                       | —                                         | External S3                                                                                                                                                                    |
| `storage.s3AccessKey` / `.s3SecretKey`                | string                   | No                       | secret                                    | Empty keeps existing                                                                                                                                                           |
| `engine.type`                                         | string                   | No                       | **must be a known engine id, else `400`** | Saved as `ENGINE_TYPE`                                                                                                                                                         |
| `engine.headless`                                     | boolean                  | No                       | —                                         | Default true; saved as `PUPPETEER_HEADLESS`                                                                                                                                    |
| `engine.sessionDataPath`                              | string                   | No                       | —                                         | Default `./data/sessions`                                                                                                                                                      |
| `engine.browserArgs`                                  | string                   | No                       | —                                         | Saved as `PUPPETEER_ARGS`. Empty saves the default `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu`; a non-empty value replaces that list in full |

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
    "browserArgs": "--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu"
  }
}
```

**Response** `200`

```json
{
  "message": "Configuration saved successfully. Docker profiles required: redis. Server restart required to apply changes.",
  "saved": true,
  "envPath": "data/.env.generated",
  "profiles": ["redis"]
}
```

Write/IO errors are caught and returned as HTTP `200` with `{ "saved": false, "envPath": "", "profiles": [], "message": "Failed to save configuration: …" }`. DTO validation, an unknown engine type, an invalid `database.schema`, CR/LF injection, a value that cannot be stored so that it reads back unchanged, and a merged config the production boot guard would reject (an empty or default `DATABASE_PASSWORD` or S3 key on an external datastore, or a placeholder `REDIS_PASSWORD`; message starts `Refusing to save a configuration that would be rejected at production boot.`) are real HTTP `400` responses, and nothing is written. `profiles` lists newly-required Docker profiles.

**Errors:** `400` unknown/mistyped body field, missing nested `database.type`/`storage.type`, unknown
`engine.type`, invalid `database.schema`, CR-LF in a value, a value that cannot round-trip through the
env file, or a config the production boot secret guard would reject · `401` · `403`

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
  "message": "Server is restarting. Enabling: postgres, redis. Disabling: minio.",
  "restarting": true,
  "profiles": ["postgres", "redis"],
  "profilesToRemove": ["minio"],
  "estimatedTime": 53
}
```

`estimatedTime` (seconds) = base 15 + 20/postgres + 13/redis + 15/minio + 5/removal. The echoed `profilesToRemove`, and the removal count, already omit any bundled service the environment pins the app to (for example `DATABASE_HOST=postgres` set in the host environment or the project `.env`); such a service is never stopped. `orchestration` is present only when Docker is available and at least one managed profile (`postgres`, `redis`, `minio`) remains in `profiles`; `removal` only when Docker is available and at least one managed profile remains in `profilesToRemove` after dropping pinned services and profiles that are also being started. Without Docker, a `data/.orchestration-request.json` signal file is written instead. After responding, `shutdownService.shutdown()` runs (default ~3s grace); readiness returns `503` during drain.

**Errors:** `401` · `403`

---

#### GET /api/infra/export-data

Export every row of the 16 migration tables from the Data DB as JSON. Read-only, but runs raw SQL on the `data` DataSource: `SELECT *` for most tables, while `messages` and `message_batches` are read as ids first and then as full rows in chunks, newest-first, of at most 200 rows and max(`EXPORT_INLINE_MEDIA_BUDGET_BYTES`, 1 MiB) of stored payload each (a larger single row is read on its own). Each chunk's payloads are dropped against the budget below before the next is read, so the export holds the rows it returns, one chunk and the budget's worth of media, never every inline payload in the database at once. Rows keep the order the database returns them in.

**Auth:** API key (ADMIN)

> **Inline media is carried up to a budget, then omitted.** `EXPORT_INLINE_MEDIA_BUDGET_BYTES` (8 MiB of encoded base64 by default) bounds how much inline media one export may hold, counted across both `messages` and `messageBatches`. Within each of those tables it is spent newest-first — messages by `timestamp`, batches by `created_at` — so an export that cannot carry everything keeps the most recent media rather than whatever the database happened to return first. Messages are served before batches, so a long history can exhaust the budget before any batch is reached. An over-budget payload on a `messages` row arrives as the omitted marker — `{ mimetype, filename?, omitted: true, sizeBytes }`, the same shape the engine emits when an inbound payload exceeds `MEDIA_DOWNLOAD_MAX_BYTES` — so those messages restore without their pictures. A `messageBatches` entry carries no marker: it simply loses its `base64` and keeps `url`, `mimetype` and `caption`, which is the shape a batch already has once it reaches a terminal state. Without the bound, one 50 MiB attachment becomes 66 MiB of base64 and exceeds the import's own request-body limit (`BODY_SIZE_LIMIT`, 25mb by default), producing a backup this gateway refuses to restore with `413`.
>
> An **http/https** payload is never counted or dropped: `metadata.media.data` holds either base64 or the URL a send was given, and such a URL is a pointer worth a few dozen bytes. The scheme is matched case-insensitively, as both engine adapters do when they fetch it; a URL with any other scheme is treated as bytes.
>
> This bounds the media, not the export — a large enough text-only history still exceeds the import limit, because every row costs a few hundred bytes of scaffolding whatever was said. For a backup that keeps everything, use `scripts/backup.sh`: it snapshots the database file itself (and `pg_dump`s Postgres), so inline media rides along regardless of this budget.

The migration set (`MigrationTables`) is, in payload-key order: `sessions`, `webhooks`, `messages`, `messageBatches`, `templates`, `baileysStoredMessages`, `lidMappings`, `chatStates`, `pluginInstances`, `conversationMappings`, `ingressEvents`, `webhookDeliveryFailures`, `webhookOutboxEvents`, `integrationDeliveryFailures`, `statusUpdates`, `automationRules`.

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
    "chatStates": [],
    "pluginInstances": [],
    "conversationMappings": [],
    "ingressEvents": [],
    "webhookDeliveryFailures": [],
    "webhookOutboxEvents": [],
    "integrationDeliveryFailures": [],
    "statusUpdates": [],
    "automationRules": []
  },
  "counts": {
    "sessions": 1,
    "webhooks": 0,
    "messages": 0,
    "messageBatches": 0,
    "templates": 0,
    "baileysStoredMessages": 0,
    "lidMappings": 0,
    "chatStates": 0,
    "pluginInstances": 0,
    "conversationMappings": 0,
    "ingressEvents": 0,
    "webhookDeliveryFailures": 0,
    "webhookOutboxEvents": 0,
    "integrationDeliveryFailures": 0,
    "statusUpdates": 0,
    "automationRules": 0
  },
  "skippedTables": [],
  "omittedInlineMedia": { "messages": 0, "messageBatches": 0 }
}
```

Rows are raw DB column shapes (e.g. `messageBatches` rows use snake_case columns: `batch_id`, `session_id`, `current_index`, `created_at`, …). **`webhooks` rows omit `secret` and `headers`** (webhook credentials are excluded from backups; they restore as `null`/`{}`), while `pluginInstances` rows still carry integration secrets — treat the payload as a credential dump. **`sessions` rows have any `user:pass` stripped from `proxyUrl`** (a value that does not parse as a URL exports as `null`), so a restored authenticated proxy reads `hasCredentials: false` and fails on the session's next start until the credentials are re-entered with `PATCH /api/sessions/:sessionId/proxy`. On Postgres the generated `body_ts` FTS column is stripped from `messages` so archives stay dialect-neutral.

`sessions`/`webhooks` are queried directly, so a hard DB error there yields `500`. The other 14 are queried tolerantly: a _genuinely missing_ table (an older DB that has not run the migration) exports as `[]` and its name is listed in `skippedTables`; any other error (lock, I/O, timeout) fails the export rather than reporting the table as empty. Check `skippedTables` before restoring — a skipped table is "not migrated yet", not "exported empty".

`omittedInlineMedia` counts, per table, the inline media payloads the `EXPORT_INLINE_MEDIA_BUDGET_BYTES` budget dropped. Zeroes mean everything fitted; an archive with a non-zero count still restores, but those rows come back without their media.

**Errors:** `401` · `403` · `409` `IMPORT_ALREADY_RUNNING` (a data import is running; export after it finishes) · `500` DB error

---

#### POST /api/infra/import-data

Replace all Data DB rows with the supplied export. **Destructive and transactional (all-or-nothing).**

> **The replace covers all 16 migration tables, not just the ones you send.** Inside the transaction every table in the migration set is emptied first and only then re-populated from the payload, so a table you omit ends up **empty**, not untouched. Always restore a payload produced by `GET /api/infra/export-data` of the same or a newer build — a hand-built body carrying only a subset silently wipes the rest.

**Auth:** API key (ADMIN)

**Request body** — `ImportDataDto`. Post the whole export file: alongside `tables`, `force` and `stopOrphans`, the DTO accepts and ignores the export's `exportedAt`, `dataDbType`, `counts`, `skippedTables` and `omittedInlineMedia`. Any other property is rejected with `400`.

| Field                         | Type                | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tables`                      | object              | Yes      | Container of per-table row arrays, keyed exactly as the export's `tables`. Absent, `null` or not an object is rejected `400` before the restore runs                                                                                                                                                                                                                                                                                                                              |
| `tables.sessions`             | `SessionRow[]`      | No       | Inserted first; a row whose `id` or `name` is not a safe directory name refuses the whole restore before any engine is stopped or the transaction opens (`imported:false`, the row named in `warnings`; see the orphan-engine pre-flight below). An ACTIVE status in the backup (`ready`, `initializing`, ...) describes the source host's engines: restored as `disconnected` (a notice counts them), unless the session is held by a live peer whose claim the import preserves |
| `tables.webhooks`             | `WebhookRow[]`      | No       | Export rows omit `secret`/`headers`; an absent key restores as `null`/`{}`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tables.messageBatches`       | `MessageBatchRow[]` | No       | snake_case columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tables.*` (the remaining 13) | `Row[]`             | No       | Same keys as the export; an omitted table restores **zero** rows into an emptied table                                                                                                                                                                                                                                                                                                                                                                                            |
| `stopOrphans`                 | boolean             | No       | Stop the running engines for sessions the backup does not contain, inside this request and before the replace (best-effort, time-bounded per engine). Preferred over `force`                                                                                                                                                                                                                                                                                                      |
| `force`                       | boolean             | No       | Legacy escape hatch: proceed despite orphaned engines and leave them running until a process restart (`restartRequired: true`)                                                                                                                                                                                                                                                                                                                                                    |

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
    "chatStates": [],
    "pluginInstances": [],
    "conversationMappings": [],
    "ingressEvents": [],
    "webhookDeliveryFailures": [],
    "webhookOutboxEvents": [],
    "integrationDeliveryFailures": [],
    "statusUpdates": [],
    "automationRules": []
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
    "chatStates": 0,
    "pluginInstances": 0,
    "conversationMappings": 0,
    "ingressEvents": 0,
    "webhookDeliveryFailures": 0,
    "webhookOutboxEvents": 0,
    "integrationDeliveryFailures": 0,
    "statusUpdates": 0,
    "automationRules": 0
  },
  "warnings": [],
  "notices": [],
  "restartRequired": false,
  "orphanedEngines": [],
  "stoppedOrphanEngines": [],
  "failedOrphanEngines": []
}
```

`warnings` are per-row import failures — they force a **rollback** and `imported:false`. On PostgreSQL the import stops at the first row the database rejects, so `warnings` holds that one failure; SQLite lists every rejected row. `notices` are non-fatal operator messages (orphan-engine reconciliation detail, sessions restored as disconnected, a failed plugin binding re-sync) and never roll anything back. `restartRequired` is `true` from any of four causes: engines left pointing at sessions the restore removed (`force`), an orphan teardown that failed, sessions running on another node, which this request has no channel to stop, or plugin instance bindings that could not be re-synced after the commit. `orphanedEngines` lists the orphaned session ids the restored data no longer contains; `stoppedOrphanEngines`/`failedOrphanEngines` report how `stopOrphans` went.

**Orphan-engine pre-flight.** An archive with no rows in any table never reaches it: it is refused first with `200`, `imported:false` and the warning `Backup contained no rows to restore; refused to replace existing data. Check the file.`, so no `409` is raised, no engine is stopped and no transaction opens, whatever `force` or `stopOrphans` say. An archive holding a row the import would refuse (an unsafe session id or name, malformed webhook events or filters, malformed automation-rule conditions, two templates of one session whose names match once NUL characters are dropped) is refused the same way, with each such row named in `warnings`. For any other archive, before the transaction opens, any session whose id is absent from `tables.sessions` and that has a running or starting engine on this node, or is waiting to relaunch after a failed reconnect, is an orphan (the replace would delete its DB row, leaving an unstoppable engine writing into freshly restored tables). Default behaviour is to refuse with `409` listing those ids; `stopOrphans: true` stops them in-request and proceeds (a session with no engine yet has its start aborted or its pending relaunch cancelled, and is named in `notices` rather than `stoppedOrphanEngines`); `force: true` proceeds and leaves them running until restart.

Because that pre-flight runs _before_ the transaction, its teardown is not covered by the rollback. A response with `imported:false` therefore still reports the engines it really stopped, and `restartRequired` on that path means only that a teardown **failed** — a cleanly stopped orphan leaves its session row intact (restart it with `POST /sessions/{sessionId}/start`), and an engine `force` left running was never orphaned after all, since the data that would have orphaned it was not replaced.

Inside the transaction every migration table is emptied. `webhooks` and `sessions` are DELETEd directly, so a missing table there fails the restore; 13 more go through a tolerant helper where a _genuinely missing_ table is skipped; and `automation_rules` is emptied by the `DELETE FROM sessions` cascade rather than by the helper. Any other DELETE failure propagates to the rollback. Rows are then re-inserted, sessions first. JSON object/array fields are auto-stringified before insert, and the Postgres-form `$N` placeholders are rewritten for SQLite. Two guards return `imported:false` after a rollback: any `warnings`, and a payload that holds rows but restores **zero** of them (a wrong backup would otherwise commit a silent wipe — the response then carries `Backup contained no rows to restore; refused to replace existing data. Check the file.`). On commit the lid→phone mirror is reloaded from the restored rows.

On commit, plugin instance bindings are also re-applied: a session bound only by an instance the backup lacks, or restores disabled, is dropped from that plugin's active sessions and its per-session config is cleared, then every restored enabled instance is bound again. Sessions activated through `PUT /api/plugins/:id/sessions` with no instance behind them are left alone. If that re-sync fails the import still commits, with a notice and `restartRequired: true`. A restart re-applies the restored enabled instances but does not retire a binding the restore dropped, so check each plugin with `GET /api/plugins/:id` and correct it with `PUT /api/plugins/:id/sessions`, as the notice says. A session-wide (wildcard) instance's config was merged into the plugin's base config when it was bound, and a restore does not remove it; overwrite those keys with `PUT /api/plugins/:id/config`.

**Errors:** `400` `tables` absent/not an object, a table whose value is not an array of rows, a row that is not an object (`null`, a bare string, a nested array), a flag spelled as anything but a boolean or exact `true`/`false`, or a property the route does not accept — nothing is written, and field-level detail is suppressed in production unless `VALIDATION_ERROR_DETAIL=true` · `401` · `403` · `409` refused, with the reason in `code` — `IMPORT_WOULD_ORPHAN_ENGINES` (sessions the backup does not contain are running, starting or waiting to relaunch; retry with `stopOrphans` or `force`), `IMPORT_ALREADY_RUNNING` (another import is running; wait for it), `EXPORT_IN_PROGRESS` (a data export is running; wait for it), `IMPORT_NESTED_TRANSACTION` (another database transaction holds the connection; retry with nothing else in flight) · `500` unrecoverable DB error

> A malformed archive is answered before the restore opens its transaction. Every table present is checked for being an array, and every row in it for being an object — not just `sessions`, since the rest are read inside the transaction where the same mistake would fail mid-restore instead of ahead of it. A hand-edited or truncated backup therefore reports `400` naming the offending `tables.<name>[<index>]`, rather than the `500` that told the operator the server had broken when their file was simply wrong.

---

#### GET /api/infra/storage/files/count

File count and total size in the active storage backend.

**Auth:** API key (ADMIN)

**Response** `200`

```json
{ "storageType": "local", "count": 128, "sizeBytes": 5242880, "sizeMB": "5.00" }
```

**Errors:** `401` · `403` · `500` · `503` `STORAGE_TYPE=s3` but the bucket has not been reachable since boot, or its credentials are missing (this route, the export and the import refuse rather than report on the local fallback directory; an outage after the bucket was reachable answers `500`)

---

#### GET /api/infra/storage/export

Export all storage files into a `tar.gz` under `data/exports` and return its **server-side path** (not a download stream).

**Auth:** API key (ADMIN)

**Response** `200`

```json
{ "message": "Storage export completed", "download": "data/exports/storage-export-1750000000000-abc.tar.gz" }
```

`download` is a server filesystem path — feed it back to `POST /api/infra/storage/import`. The archive is auto-deleted after `STORAGE_EXPORT_TTL_MS` (default 1h).

**Errors:** `401` · `403` · `500` · `503` S3 configured but not reachable since boot (a later outage answers `500`)

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
{ "imported": true, "count": 128, "failed": 0, "storageType": "local" }
```

`failed` counts archive entries the store refused to write; a bad or traversing entry is skipped without failing the rest. `imported` is `false` when entries failed and none was written.

**Errors:** `400` missing/out-of-`data/`/not-found path, or `Storage import failed: <reason>` when the file is not a readable gzip tar archive or exceeds the import resource caps (an abort keeps the entries written before it, since there is no rollback; re-run the import once the archive is fixed, as each entry overwrites) · `401` · `403` · `500` · `503` S3 configured but not reachable since boot (a later outage answers `200` with `imported: false` and the entries in `failed`)

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
    "ingressCapable": false,
    "sessionScoped": true,
    "activeSessions": ["*"],
    "loadedAt": "2026-06-25T00:00:00.000Z",
    "enabledAt": "2026-06-25T00:01:00.000Z"
  }
]
```

`type` is one of `engine | storage | queue | auth | extension`; `status` is `installed | enabled | disabled | error`. `activeSessions: ["*"]` means all sessions. `ingressCapable` is `true` when the plugin declares an ingress route and the `webhook:ingress` permission. Optional fields: `configSchema`, `configUi`, `i18n`, `sessionConfig` (secrets redacted), `error`.

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
    "download": "https://github.com/openwa-plugins/group-translate/releases/download/v1.2.0/group-translate.zip#sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "installed": true,
    "installedVersion": "1.1.0",
    "updateAvailable": true
  }
]
```

The catalog is fetched from `PLUGIN_CATALOG_URL`, which defaults to the OpenWA-plugins `plugins.json` on raw.githubusercontent.com. An empty value falls back to that default, so the catalog cannot be disabled, and on a host that cannot reach it this route answers `400`.

The dashboard installs and updates an entry by passing its `download` URL to `POST /api/plugins/install-url` or `POST /api/plugins/:id/update`, so the pin rule of those routes applies: under `NODE_ENV=production` (unless `PLUGIN_INSTALL_REQUIRE_PIN=false`) an entry whose `download` has no `#sha256=` pin cannot be installed. Every entry in the default catalog carries one.

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

Reinstalling over a plugin whose code went missing is supported and is the recovery the boot warning
prescribes: its `ctx.storage` directory, config, session activations and enabled-on-boot decision are
all kept. A directory the gateway did not install is still refused.

**Errors:** `400` no file / invalid package / install failed · `401` · `403` · `409` plugin already loaded, or a directory under that id the gateway did not install · `413` package larger than 5 MB

---

#### POST /api/plugins/install-url

Install a plugin by downloading its `.zip` from a URL (SSRF-guarded fetch: host validated, redirects followed with every hop re-validated through the guard and the chain capped at 5 hops, size-capped at `plugins.downloadMaxBytes`, default 5 MB). `https://` is accepted (production also requires the content pin, below); plain `http://` is only accepted when the URL carries a content pin (below) — the package is executable code and must be integrity-protected in transit; private-network targets remain subject to the SSRF guard. A redirect hop that downgrades back to plain `http://` mid-chain is likewise refused (set `PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS=true` only if your vendor genuinely redirects that way); a chain over the cap fails with an explicit "too many redirects" error.

Content pinning: append `#sha256=<64 hex>` (URL fragment — never sent to the server) to require the downloaded bytes to match that digest; the fragment is the only honored marker — query params are deliberately ignored. A mismatch or a malformed marker fails the install closed. The pin is always REQUIRED over plain HTTP, which is rejected without one. Over HTTPS it is also REQUIRED when `NODE_ENV=production` (the Docker image, compose and Helm default) unless `PLUGIN_INSTALL_REQUIRE_PIN=false`; elsewhere it is optional over HTTPS (TLS + the SSRF guard are the baseline) unless `PLUGIN_INSTALL_REQUIRE_PIN=true`. An unpinned URL the deployment requires a pin for fails with `400`.

**Auth:** API key (ADMIN)

**Request body** — `InstallFromUrlDto` (class-validated; extra fields → `400`)

| Field | Type   | Required | Constraints                                                     | Description                                                                                                        |
| ----- | ------ | -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `url` | string | Yes      | `@IsUrl({ protocols:['http','https'], require_protocol:true })` | Absolute URL of the package; plain http only with a `#sha256=` digest pin, which production also requires on https |

```json
{
  "url": "https://github.com/openwa-plugins/chat-flow/releases/download/v1.0.0/chat-flow.zip#sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The digest shown is a placeholder: use the SHA-256 of the `.zip` (`sha256sum chat-flow.zip`).

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
{ "success": true, "message": "Plugin chat-flow enabled successfully" }
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
{ "success": true, "message": "Plugin chat-flow disabled successfully" }
```

The engine plugin `ENGINE_TYPE` selects (`baileys` or `whatsapp-web.js`) cannot be disabled at runtime:
the gateway runs that engine whatever its plugin status says. The request is refused in-band as
`{ "success": false, "message": "…" }` (still HTTP 200) and changes nothing; set `ENGINE_TYPE` and
restart to switch engines.

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

| Field    | Type   | Required | Constraints   | Description                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------ | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config` | object | Yes      | `@IsObject()` | Keys to set, merged over the stored config: omitted keys keep their value. Every key sent is stored, and for a built-in engine plugin (`whatsapp-web.js`, `baileys`) a stored key overrides its `.env`-derived setting on every later boot, so send only the keys you mean to change, not the whole object `GET /api/plugins/:id` returns. Masked/sentinel secret values mean "unchanged" and are restored from the stored config |

```json
{ "config": { "apiKey": "sk-...", "replyDelayMs": 1500 } }
```

**Response** `200`

```json
{ "success": true, "message": "Plugin chat-flow configuration updated" }
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
{ "success": true, "message": "Plugin chat-flow configuration for session session-1 updated" }
```

**Errors:** `400` plugin is global (not session-scoped) / extra field · `401` · `403` · `404` unknown id

---

#### PUT /api/plugins/:id/sessions

Set which sessions a session-scoped plugin is activated for. This is a **full replacement** of the plugin's global activation set: the supplied `sessions` array overwrites `activeSessions` in its entirety (not a merge), so an omitted session is deactivated and `[]` deactivates the plugin for every session.

**Auth:** API key (ADMIN) that is **not restricted to specific sessions** (`@RequireUnscopedKey`). As on the other plugin lifecycle routes, a session-scoped key is rejected with `403` whatever it sends. Here it matters most: because the route replaces the whole activation set, even a request confined to its own `allowedSessions` would silently delete every other session's activation, so the fence refuses scoped keys before the handler runs. Use an unrestricted ADMIN key. (The per-session config override route `PUT /api/plugins/:id/config/:sessionId` is a different operation and stays scoped to the addressed session.)

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

Update an installed plugin in place from a URL, preserving config + enabled state. The new package is written to a staging sibling and validated BEFORE the running plugin is stopped, then swapped in with two renames (live → backup, staging → live); a failure before or during the swap restores the previous version, and a process crash mid-swap is reconciled at boot (the backup is restored when the live directory is missing), so an interrupted update can never make the plugin silently vanish. An update of a plugin the operator switched on (not one in `error`) that is still applying once shutdown has begun is refused, or rolled back if the swap already happened, and answered with `503`, since the new version cannot be started to prove it works. The URL follows the same transport and pin rules as `install-url`: plain http only with a `#sha256=` digest pin, and https needs the pin too under `NODE_ENV=production` unless `PLUGIN_INSTALL_REQUIRE_PIN=false` (fail-closed on mismatch).

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type   | Description                                      |
| ---- | ------ | ------------------------------------------------ |
| `id` | string | Plugin id (must match the package's manifest id) |

**Request body** — `InstallFromUrlDto` (class-validated)

| Field | Type   | Required | Constraints                                                     | Description                                                                                                                      |
| ----- | ------ | -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `url` | string | Yes      | `@IsUrl({ protocols:['http','https'], require_protocol:true })` | Absolute URL of the new `.zip` (SSRF-guarded download); http only with a `#sha256=` pin, which production also requires on https |

```json
{
  "url": "https://example.com/plugins/chat-flow-1.1.0.zip#sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

**Response** `201` — the updated `PluginDto`.

**Errors:** `400` download/package invalid, manifest id mismatch, or built-in plugin · `401` · `403` · `404` unknown id · `503` shutdown began before the update of a plugin the operator switched on finished applying (the previous version is kept)

---

#### DELETE /api/plugins/:id

Uninstall a plugin: dispatch its `onUnload` lifecycle hook, delete its files, drop its registry entry, and remove its `ctx.storage` data directory (`<dataDir>/plugins/<id>` — a separate tree when `PLUGINS_DIR` points outside the data dir). Built-in plugins are protected. A plugin that is installed but not loaded — one whose code went missing — can be uninstalled too; there is simply no runtime to tear down first. `404` therefore means an id the gateway has no registry entry for.

**Auth:** API key (ADMIN)

**Path parameters**

| Name | Type   | Description |
| ---- | ------ | ----------- |
| `id` | string | Plugin id   |

**Response** `200`

```json
{ "success": true, "message": "Plugin chat-flow uninstalled successfully" }
```

Note: this DELETE returns `200` with a body (not the usual `204`).

**Errors:** `400` cannot uninstall (e.g. built-in) · `401` · `403` · `404` unknown id

---

#### POST /api/integration/instances/:pluginId/:instanceId/redrive

Re-dispatch one bounded batch of dead-lettered inbound deliveries for an integration instance (see
**doc 25, Integration Fabric** for the DLQ and redrive design). Rows are drained fewest-attempts-first,
then oldest-first, up to `batchSize` (100) — so a row that keeps failing moves behind never-retried
rows instead of livelocking the window, while staying redrivable. `remaining` reports the DLQ depth
still outstanding after this batch.

**Auth:** API key (ADMIN) · **Scope:** session-scoped (a key restricted to `allowedSessions` may only
redrive an instance whose current `sessionScope` is inside that allowlist; out of scope and missing
instances both answer `404`, so redrive can't be used to probe other sessions). An instance that is
disabled, or deleted when the key is not session-restricted, answers `409`: ingress dispatch refuses
such an instance, so its rows could only fail again. Re-enable the instance to replay its backlog.

**Path parameters**

| Name         | Type   | Description                   |
| ------------ | ------ | ----------------------------- |
| `pluginId`   | string | Plugin id owning the instance |
| `instanceId` | string | Instance id to redrive        |

**Response** `201`

```json
{ "redriven": 3, "remaining": 0, "batchSize": 100 }
```

**Errors:** `401` · `403` key role < ADMIN · `404` a **scoped** key's instance that is missing or outside its `allowedSessions` · `409` the instance is deleted or disabled

---

#### POST /mcp

MCP Streamable-HTTP / JSON-RPC 2.0 transport that exposes the agent-tool registry over the Model Context Protocol. **This is a transport, not a REST resource** — there is no NestJS controller, no DTO, and no `{success,data}` shape.

**Auth:** API key — sent as `X-Api-Key: <key>` **or** `Authorization: Bearer <key>`. Every request, including `initialize` and `tools/list`, needs a valid key: a missing, unknown, revoked or expired key, or a key carrying `allowedIps` (there is no genuine client IP on this mount), is refused before any MCP method runs, with an HTTP error, a JSON-RPC error body (`code: -32000`, `id: null`) and `WWW-Authenticate: Bearer` on a `401`. The role, session and chat checks run **per tool call** inside the MCP layer (not by the global Nest guard) and surface in-band.

Key facts:

- **Path is exactly `POST /mcp` — no `/api` prefix.** The global `api` prefix applies only to Nest controllers; this route is mounted straight on Express.
- Gated by **`MCP_ENABLED=true`**. When off, the module/route is never mounted and `POST /mcp` returns `404`.
- MCP is **read-only by default**: only read-tier tools are registered unless you set `MCP_READONLY=false` to expose write tools. Per-key sliding-window rate limit: `MCP_RATE_LIMIT_MAX` (default 60) per `MCP_RATE_LIMIT_WINDOW_MS` (default 60000).
- Stateless transport: no session id and no standalone stream. Every POST must send `Content-Type: application/json` and `Accept: application/json, text/event-stream` (both types, even though the answer is a single message). A `200` answer is `text/event-stream` carrying one `event: message` frame whose `data:` line is the JSON-RPC envelope; a POST that carries only notifications gets `202` with an empty body. `GET /mcp` and `DELETE /mcp` answer `405` with `Allow: POST` and a JSON-RPC error body.
- Pre-auth per-IP throttle: `MCP_IP_RATE_LIMIT_MAX` (default 120) JSON-RPC messages per `MCP_IP_RATE_LIMIT_WINDOW_MS` (default 60000). Each element of a batch counts; an over-budget request gets HTTP `429` with a JSON-RPC error body and runs none of its messages, but still spends whatever budget the IP had left.

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
    "name": "MessageSendText",
    "arguments": { "sessionId": "default", "chatId": "6281234567890@c.us", "text": "Hello from MCP" }
  }
}
```

`MessageSendText` is a write tool: it is listed only with `MCP_READONLY=false` and needs an `OPERATOR` key.

**Response** `200` — `text/event-stream`; the `data:` line of its `event: message` frame is this JSON-RPC 2.0 envelope

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": { "content": [{ "type": "text", "text": "{\"messageId\":\"…\",\"timestamp\":1719312000}" }] }
}
```

For `tools/call` the result is an MCP `CallToolResult` (`content` array of `text` or embedded base64 `resource` items — payloads over 4096 bytes become a `resource`). **Tool-level failures are returned in-band as `CallToolResult` with `isError:true`** (HTTP stays 200), including a role, session or chat refusal (`name:'ForbiddenException'`), rate-limit hits (`message:'MCP rate limit exceeded'`), and an unknown tool or arguments that fail the tool's `inputSchema` (text `MCP error -32602: …`).

**Errors:** `401` for a missing or invalid key and `403` for a key carrying `allowedIps`, each with a JSON-RPC error body · `406` when `Accept` does not list both `application/json` and `text/event-stream` · `415` for a non-JSON `Content-Type` · `400` for malformed JSON, or with a `-32700` JSON-RPC error body for JSON that is not a valid JSON-RPC message · in-band JSON-RPC errors `-32601` (unknown method) and `-32603` (params that fail the method's schema, such as a `tools/call` without `name`; the message carries the validation issues), at HTTP 200 · `500` if the key lookup fails for a reason other than a refused key, or if the transport throws before headers are sent · `404` when `MCP_ENABLED` is not `true`

> The full catalog of MCP tools (names, tiers, schemas) is documented separately — see **doc 24, MCP Integration**. This section documents only the transport endpoint.

### 6.4.12 Search

Base path `/api/search`. Cross-session full-text message search over an open `SearchProvider` contract;
the built-in database full-text provider (PostgreSQL `tsvector`/`GIN`, SQLite `FTS5`) answers by
default with zero external dependencies. Search is on by default; set `SEARCH_ENABLED=false` to remove
the route and module entirely (the index is DB-maintained regardless — see
[26 - Global Search](./26-global-search.md)). Requires at least `OPERATOR` role.

**Auth:** API key (≥ `OPERATOR`) · **Scope:** session-scoped — a scoped key's `allowedSessions` is
injected server-side from the key (never from the query), so a scoped key cannot broaden its reach; a
key with a non-empty `allowedSessions` searches only those sessions, whatever its role; a key with a
null or empty `allowedSessions` searches all sessions.

#### GET /api/search

Search messages across sessions (active search provider).

**Query parameters**

| Name        | Type                            | Required | Default | Description                                                                                                                                                                                   |
| ----------- | ------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`         | string                          | **Yes**  | —       | Search term. Must be non-empty after trim; whitespace-only is rejected with `400`. Passed to the active provider's native full-text matcher.                                                  |
| `sessionId` | string                          | No       | —       | Restrict to a single session id (intersected with the key's `allowedSessions` scope).                                                                                                         |
| `chatId`    | string                          | No       | —       | Restrict to a single chat id. For a key restricted to selected chats this must name an allowed chat (`403` otherwise), and its hits are additionally narrowed to the allowlist.               |
| `direction` | enum (`incoming` \| `outgoing`) | No       | —       | Filter by message direction.                                                                                                                                                                  |
| `type`      | string                          | No       | —       | Filter by stored message `type` (e.g. `text`, `image`, `video`). Compared against `messages.type`; not an enum validation, any string is accepted and unmatched values simply return no hits. |
| `from`      | string                          | No       | —       | Filter by sender.                                                                                                                                                                             |
| `dateFrom`  | integer (epoch ms)              | No       | —       | Inclusive lower bound on `timestamp`. A non-numeric value is rejected with `400`.                                                                                                             |
| `dateTo`    | integer (epoch ms)              | No       | —       | Inclusive upper bound on `timestamp`. A non-numeric value is rejected with `400`.                                                                                                             |
| `limit`     | integer (≥ 1)                   | No       | `50`    | Max hits to return. Clamped to `SEARCH_LIMIT_MAX` (default `100`). A non-integer value is rejected with `400`.                                                                                |
| `offset`    | integer (≥ 0)                   | No       | `0`     | Pagination offset, at most `100000`. A non-integer or larger value is rejected with `400`.                                                                                                    |

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

- `snippet` is a text excerpt with `<mark>`/`</mark>` highlight markers around the matched term (both
  dialects emit the same markers). The body text inside it is not HTML-escaped: split on the literal
  markers and render each segment as text, never the raw snippet as HTML.
- `total` is an exact count for pagination, computed lazily only when the returned page could be full.
- `provider` names which backend answered (e.g. `builtin-fts`); it is the registered `SearchProvider`
  id, so it changes when a plugin backend is selected via `SEARCH_PROVIDER`.
- `score` is optional and provider-specific (rank ordering is stable within a provider; cross-provider
  scores are not comparable).

**Errors:** `400` empty/whitespace `q`, a non-numeric `dateFrom`/`dateTo`/`limit`/`offset`, an `offset` above `100000`, or a malformed
SQLite FTS5 query (unbalanced quote/paren, bare operator) — Postgres's `websearch_to_tsquery` is
tolerant and has no equivalent · `401` missing/invalid `X-API-Key` · `403` key role below `OPERATOR`, or a chat-restricted key
that names a `chatId` outside its allowlist or uses a plugin provider ·
`501` no search provider configured (including a non-FTS5 SQLite build, where the provider is absent) ·
`502` the active plugin provider returned an invalid result shape (not retryable until the plugin is fixed) ·
`503` the active plugin provider did not answer (worker not running, timed out, or reported a failure;
retryable). The built-in provider returns neither `502` nor `503`.

> Scoping is authoritative: a scoped API key's `allowedSessions` is applied server-side and cannot be
> overridden via the query — there is no `sessionIds` query parameter, and `SearchService` overwrites
> any session scope at the provider boundary. The same holds for the chat scope: a key restricted to
> selected chats sees only hits inside its allowlist with the built-in provider (expanded lid-aware
> before SQL filtering, so `limit`/`offset`/`total` all describe the scoped result set). A compiled
> chat scope with no valid ids returns no hits and a zero total. Plugin search refuses these keys
> before invoking the worker. There is no `chatIds` query parameter.

### 6.4.13 Profile (own account)

Manage the linked account's own profile. All routes are nested under `/api/sessions/:sessionId/profile` and require an **OPERATOR** key.

#### PUT /api/sessions/:sessionId/profile/name

Set the account display name (max 25 chars).

**Auth:** API key (OPERATOR)

```json
{ "name": "ACME Support" }
```

**Response** `200` — `{ "success": true, "message": "Profile name updated" }`

**Errors:** `400` session is not started / invalid name · `401` · `403` the whatsapp-web.js engine refused the change (the Baileys engine has no acceptance signal and answers `200`) · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

#### PUT /api/sessions/:sessionId/profile/status

Set the account about/status text (max 139 chars; empty string clears it).

**Auth:** API key (OPERATOR)

```json
{ "status": "We reply within one business day" }
```

**Response** `200` — `{ "success": true, "message": "Profile status updated" }`

**Errors:** `400` session is not started / status too long · `401` · `403` · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

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

**Errors:** `400` neither `url` nor `base64` provided / base64 without `mimetype` / a `url` that answers non-2xx, times out or cannot be reached · `401` · `403` the whatsapp-web.js engine refused the change (the Baileys engine has no acceptance signal and answers `200`) · `409` conflict or engine not ready (retryable) · `413` base64 or downloaded image over the media cap (see §6.3) · `503` session not ready, dependency unavailable, or a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault (retryable)

#### DELETE /api/sessions/:sessionId/profile/picture

Remove the account profile picture, leaving the account with WhatsApp's default avatar.

**Auth:** API key (OPERATOR)

No request body.

**Response** `200` — `{ "success": true, "message": "Profile picture removed" }`

Removing a picture that is already absent is a no-op and also answers `200`, so the call is safe to
repeat.

**Errors:** `400` session is not started · `401` · `403` engine refused the removal · `409` conflict or engine not ready (retryable) · `503` session not ready or dependency unavailable (retryable)

### 6.4.14 Calls

Incoming-call management. A `call.received` webhook/socket event (§6.6) announces an incoming ringing call and carries the `callId` used below.

> **Call rejection and the call outcome events are Baileys only, and `call.received` is not reliable on whatsapp-web.js.** Both engines dispatch `call.received`, but on whatsapp-web.js it fired in a live test on 2026-09-17 and did not in one on 2026-08-10. whatsapp-web.js cannot reject a call: a rejection it sent did not stop the call from ringing in a live test, so the reject route answers `501` there and `autoRejectCalls` logs a failed auto-reject instead. The caller id in `from` may be an `@lid` privacy id on either engine; resolve it with `GET /api/sessions/:sessionId/contacts/:contactId/phone`. `POST .../calls/link` works on both engines.

#### POST /api/sessions/:sessionId/calls/link

Generate a shareable WhatsApp call link.

**Auth:** API key (OPERATOR) · **Scope:** session-scoped

**Request body** — `CreateCallLinkDto`

| Field       | Type   | Required | Constraints                                   | Description                                           |
| ----------- | ------ | -------- | --------------------------------------------- | ----------------------------------------------------- |
| `type`      | string | Yes      | `@IsIn(['audio','video'])`                    | Which kind of call the link opens                     |
| `startTime` | number | Yes      | `@IsInt`; `@Min(1)`; `@Max(8640000000000000)` | Epoch **milliseconds** the call is scheduled to start |

```json
{ "type": "video", "startTime": 1800000000000 }
```

**Response** `200`

```json
{ "link": "https://call.whatsapp.com/video/XxXxXxXxXxXxXx" }
```

> **`startTime` is required on purpose.** whatsapp-web.js generates an _event-linked_ call and has no
> notion of "no start time", so a link for right now is `Date.now()` rather than an omitted field.
> Sending it in seconds instead of milliseconds produces a link scheduled in 1970.

> **`audio` is the neutral spelling; WhatsApp's own URL path is `/voice/`.** Baileys uses `audio`,
> whatsapp-web.js uses `voice`, and the generated link reads
> `https://call.whatsapp.com/voice/…` either way.

> **A refusal is a `403`, never a `200` with an empty link.** whatsapp-web.js returns an empty string
> when generation fails and Baileys returns no token; both become `EngineRefusedError`, because a
> caller handed `{ "link": "" }` — or a bare prefix with nothing after it — would pass it to a user
> before discovering it is dead.

**Errors:** `400` session not ready, or an invalid `type`/`startTime` · `401` missing/invalid API key · `403` WhatsApp generated no link · `409` conflict or engine not ready (retryable) · `500` the whatsapp-web.js page died mid-request, or on Baileys WhatsApp did not answer within the request budget; a link may have been minted on either engine, so this is deliberately not `503`: each call mints a new link, so a client replaying a `503` would create a second one

#### POST /api/sessions/:sessionId/calls/:callId/reject

Reject a currently ringing incoming call. **Baileys only**: the whatsapp-web.js engine answers `501`. Only a live call can be rejected: the id is valid while the call rings (a short server-side cache); afterwards it expires.

**Auth:** API key (OPERATOR)

**Path parameters**

| Name      | Type   | Description                            |
| --------- | ------ | -------------------------------------- |
| sessionId | string | Session ID                             |
| callId    | string | Call ID from the `call.received` event |

**Request body** — none.

**Response** `200` — `{ "success": true }`

**Errors:** `400` session is not started · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role · `404` call not found or no longer ringing · `409` conflict or engine not ready (retryable) · `501` the whatsapp-web.js engine cannot reject a call · `503` session not ready or dependency unavailable (retryable)

> **Auto-reject per session.** Set `"config": { "autoRejectCalls": true }` when creating a session to have the server reject every incoming call automatically, and the `call.received` event is still dispatched first, so automations keep full visibility. Baileys only; see the note at the top of this section.

### 6.4.15 Media conversion (opt-in)

Server-side transcoding into the shapes WhatsApp clients actually play. Disabled by default; set
`MEDIA_CONVERSION_ENABLED=true`. The official Docker image already ships the `ffmpeg` binary these
endpoints run — on a source install it must be present, or they answer `503`. Video conversion
needs ffmpeg 4.4 or newer.

Nothing is converted implicitly: sends behave exactly as before unless a caller runs media through
these endpoints first and posts the result.

A `url` is fetched by the gateway through the egress proxy of the session in the path, exactly as a
send by URL is (see "Per-session egress proxy" under `POST /api/sessions`); `SESSION_PROXY_URL_FETCH=false`
sends it direct instead. ffmpeg never sees the URL either way: it is handed bytes this gateway already
fetched and checked.

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

At least one of `url` / `base64` is required; when both are given, `base64` is used.
No `mimetype` is accepted: the input format is
identified from the bytes. Both conversion routes accept single-file media inputs only: MP4, M4A,
3GP and MOV, Matroska and WebM, Ogg, MP3, WAV and W64, AAC, AC-3 and E-AC-3, FLAC, WavPack, AU,
AMR, AVI, MPEG-PS and MPEG-TS, ASF, FLV, CAF, AIFF, GIF, and raw H.264 and HEVC. Anything else,
including playlists and manifests, is refused with `400`.

**Response** `200`

```json
{ "base64": "T2dnUwACAAAA...", "mimetype": "audio/ogg; codecs=opus", "bytes": 14970 }
```

**Errors:** `400` neither field given, a `url` that answers non-2xx, times out or cannot be reached, or ffmpeg refused the input (its reason is included) · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role · `413` media above the size cap · `503` conversion is disabled, the ffmpeg binary is not runnable, the conversion queue is saturated, or a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault

#### POST /api/sessions/:sessionId/media/convert/video

Convert video into an MP4 every WhatsApp client accepts: baseline H.264 with AAC audio, frame
fitted inside 1280x720, or 720x1280 for portrait (never upscaled), frame rate capped at 30 fps, index moved to the front so playback can start before the whole
file arrives.

**Errors:** `400` neither field given, a `url` that answers non-2xx, times out or cannot be reached, or ffmpeg refused the input (its reason is included) · `401` missing/invalid `X-API-Key` · `403` key lacks OPERATOR role · `413` media above the size cap · `503` conversion is disabled, the ffmpeg binary is not runnable, the conversion queue is saturated, or a `url` fetch through the session's egress proxy failed before any response, the proxy or the target at fault

**Response** `200`

```json
{ "base64": "AAAAIGZ0eXBpc29t...", "mimetype": "video/mp4", "bytes": 90660 }
```

**Size note.** Both endpoints return the converted media inline, so the response is bounded by the
same `MEDIA_CONVERSION_MAX_OUTPUT_BYTES` cap (default 50 MiB) — and a client posting it onward is
still bound by `BODY_SIZE_LIMIT` (default 25 MiB) on that next request.
ffmpeg stops writing once its output passes that cap, and such a conversion fails with `400`.

### 6.4.16 Automation rules (autoreply)

Single-message autoreply rules, managed under `/api/sessions/:sessionId/automation-rules`
(`AutomationRuleController`). Every route requires an API key with **OPERATOR** role or higher.

When an inbound message arrives, the session's enabled rules are evaluated in order — creation
time, `id` as the same-second tiebreak — and the **first** rule whose `conditions` match replies
into the chat with its `replyText`. The reply goes through the ordinary send path, so send pacing
and plugin vetoes apply to it like any other outbound message. Evaluation is fire-and-forget off
the receive path and runs at most once per message (engine re-fires are deduplicated).

`conditions` uses the **webhook filter format** (`message` family — see 6.4.8): a flat AND list of
conditions over `sender`, `recipient`, `chatId`, `body`, `type`, `isGroup`, `kind`, `fromMe`, `hasMedia`, `mentions`.
Omitted or empty conditions match every inbound message except channel, broadcast-list and status
messages: a rule answers those only when its conditions include a `kind` condition that matches
them (for example `kind is channel`). A rule without one skips those chats, because a reply into a
channel the account administers is published to every follower, and anywhere else WhatsApp refuses
it. On Baileys a message the account received through a contact's broadcast list is filed under the
sender's own chat (`kind` `individual`), as WhatsApp lists it, so a rule without a `kind` condition
matches it.

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

| Field           | Type    | Required | Description                                                                                 |
| --------------- | ------- | -------- | ------------------------------------------------------------------------------------------- |
| name            | string  | yes      | Display name, max 100 chars.                                                                |
| replyText       | string  | yes      | Reply content, max 4096 chars (the send-text limit).                                        |
| conditions      | object  | no       | Webhook-filter conditions (`message` family). Omitted = match all (see above for channels). |
| cooldownSeconds | number  | no       | Per-chat quiet period, 0–86400. Default `60`.                                               |
| enabled         | boolean | no       | Default `true`.                                                                             |

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

`400`: invalid conditions (unknown field/operator, over-limit values) or over-limit text, or the session already holds `AUTOMATION_MAX_PER_SESSION` rules (default 32; `0` disables the cap). `404` when no session has this id.

#### GET /api/sessions/:sessionId/automation-rules

List the session's rules in evaluation order. **Auth:** API key (OPERATOR) · **Response** `200` — array of the shape above.

#### GET /api/sessions/:sessionId/automation-rules/:ruleId

Get one rule. **Auth:** API key (OPERATOR) · `200` or `404` when the rule does not belong to the session.

#### PUT /api/sessions/:sessionId/automation-rules/:ruleId

Partial update (any subset of the create fields). **Auth:** API key (OPERATOR) · `200`, `400` for an invalid field (same rules as create), or `404`.

#### DELETE /api/sessions/:sessionId/automation-rules/:ruleId

Delete a rule. **Auth:** API key (OPERATOR) · **Response** `204`.

### 6.4.17 Integration fabric (ingress & instances)

The operator surface of the Integration Fabric — **doc 25** holds the design (DLQ, ordering,
per-instance fairness); this section is the route reference. An ADMIN key provisions per-plugin
instances — one bound provider account, e.g. one Chatwoot inbox — and each instance gets one
ingress URL per route the plugin declares. Only a plugin that declares an ingress route AND the
`webhook:ingress` permission can have instances; any other plugin is rejected before persistence.

An instance's ingress `secret` and `verifyToken` are revealed **once** — in the create and
regenerate-secret responses — and masked (`***`) on every later read. `config` fields flagged
`secret` in the plugin's config schema stay masked even in those one-shot reveal responses.

Every instance route is session-scope aware: a key restricted to `allowedSessions` only sees
instances bound to one of its own sessions, and an out-of-scope instance answers `404` (identical
to a missing one), so the routes cannot probe which instances exist on other sessions. The DLQ
redrive route is documented with the administration routes in §6.4.11.

#### POST /api/integration/plugins/:pluginId/instances

Create an instance of an ingress-capable plugin.

**Auth:** API key (ADMIN)

**Path parameters**

| Name       | Type   | Description                                                      |
| ---------- | ------ | ---------------------------------------------------------------- |
| `pluginId` | string | Plugin to instantiate (must declare ingress + `webhook:ingress`) |

**Request body** — `CreateInstanceDto`

| Field          | Type   | Required | Constraints                                 | Description                                                                                |
| -------------- | ------ | -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `instanceId`   | string | Yes      | `^[a-zA-Z0-9_-]{1,64}$`                     | Operator-chosen id, unique within the plugin; namespaces the ingress URL and the secret    |
| `sessionScope` | string | No       | non-empty when present, ≤ 256 chars         | Session id the instance is bound to. Omit for all sessions                                 |
| `verifyToken`  | string | No       | ≤ 512 chars                                 | Token echoed in the provider's verification handshake. Auto-generated when omitted         |
| `secret`       | string | No       | 16–512 chars                                | Ingress HMAC secret shared with the provider. Omit to auto-generate a random 64-hex secret |
| `config`       | object | No       | shape defined by the plugin's config schema | Per-instance config slice passed to the adapter                                            |

```json
{ "instanceId": "chatwoot-prod-1", "sessionScope": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a" }
```

**Response** `201` — the `InstanceView`, with the plaintext `secret` and `verifyToken` revealed
**in this response only** — store them immediately.

```json
{
  "id": "chatwoot:chatwoot-prod-1",
  "pluginId": "chatwoot",
  "instanceId": "chatwoot-prod-1",
  "sessionScope": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "secret": "9f2c…64-hex…",
  "verifyToken": "a1b2c3d4e5f6",
  "config": { "inboxId": 42 },
  "enabled": true,
  "createdAt": "2026-08-01T10:00:00.000Z",
  "updatedAt": "2026-08-01T10:00:00.000Z",
  "ingressUrls": [
    { "route": "chatwoot", "url": "https://wa.example.com/api/ingress/chatwoot/chatwoot-prod-1/chatwoot" }
  ]
}
```

`ingressUrls[].url` is absolute when `BASE_URL` is set, otherwise a relative path to prepend with
the deployment's own host.

**Errors:** `400` validation, or the plugin is not ingress-capable · `401` · `403` key role < ADMIN, or `sessionScope` outside the key's `allowedSessions` · `404` unknown plugin · `409` instance id already exists

#### GET /api/integration/plugins/:pluginId/instances

List the plugin's instances visible to the calling key (secrets masked).

**Auth:** API key (ADMIN)

**Response** `200` — bare array of `InstanceView`. An instance whose `sessionScope` is outside the
key's `allowedSessions` is filtered out of the list.

**Errors:** `401` · `403`

#### GET /api/integration/plugins/:pluginId/instances/:instanceId

Get one instance (secret masked).

**Auth:** API key (ADMIN)

**Path parameters**

| Name         | Type   | Description |
| ------------ | ------ | ----------- |
| `pluginId`   | string | Plugin id   |
| `instanceId` | string | Instance id |

**Response** `200` — the `InstanceView`.

**Errors:** `401` · `403` · `404` unknown instance, or one outside the key's `allowedSessions`

#### PATCH /api/integration/plugins/:pluginId/instances/:instanceId

Update an instance (secret masked in the response). Any subset of:

| Field          | Type           | Description                                                                                                                                                                                                                  |
| -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`      | boolean        | Whether ingress is accepted and dispatch is active                                                                                                                                                                           |
| `sessionScope` | string \| null | Re-bind to another session, or `null` to serve all sessions again (the new scope must be inside the key's `allowedSessions`, so a key restricted to sessions cannot send `null`; the old scope's binding is torn down first) |
| `config`       | object         | Replace the per-instance config slice                                                                                                                                                                                        |

**Auth:** API key (ADMIN)

**Response** `200` — the updated `InstanceView`.

**Errors:** `400` validation · `401` · `403` key role < ADMIN, or the new `sessionScope` outside the key's `allowedSessions` (`null` included) · `404` unknown instance, or one outside the key's scope

#### DELETE /api/integration/plugins/:pluginId/instances/:instanceId

Delete the instance and tear down its session-scope binding.

**Auth:** API key (ADMIN)

**Response** `204`

**Errors:** `401` · `403` · `404` unknown instance, or one outside the key's scope

#### POST /api/integration/plugins/:pluginId/instances/:instanceId/regenerate-secret

Rotate the instance's ingress HMAC secret.

**Auth:** API key (ADMIN)

**Response** `200` — the `InstanceView` with the **new** plaintext `secret` revealed in this
response only; the `verifyToken` is also shown (unchanged).

**Errors:** `401` · `403` · `404` unknown instance, or one outside the key's scope

#### GET /api/ingress/:pluginId/:instanceId/:path

**Errors:** `400` an encoded NUL (`%00`) in the path or query, or a JSON body that does not parse · `401` signature verification failed (missing, stale, or wrong per-instance secret) · `413` payload too large · `415` body in a content type no parser reads · `429` rate limit exceeded · `503` a route declaring a `session-alive` preflight whose bound session has no running engine, or its engine has failed

#### POST /api/ingress/:pluginId/:instanceId/:path

**Errors:** `400` an encoded NUL (`%00`) in the path or query, or a JSON body that does not parse · `401` signature verification failed (missing, stale, or wrong per-instance secret) · `413` payload too large · `415` body in a content type no parser reads · `429` rate limit exceeded · `503` a route declaring a `session-alive` preflight whose bound session has no running engine, or its engine has failed

#### PUT /api/ingress/:pluginId/:instanceId/:path

**Errors:** `400` an encoded NUL (`%00`) in the path or query, or a JSON body that does not parse · `401` signature verification failed (missing, stale, or wrong per-instance secret) · `413` payload too large · `415` body in a content type no parser reads · `429` rate limit exceeded · `503` a route declaring a `session-alive` preflight whose bound session has no running engine, or its engine has failed

#### PATCH /api/ingress/:pluginId/:instanceId/:path

**Errors:** `400` an encoded NUL (`%00`) in the path or query, or a JSON body that does not parse · `401` signature verification failed (missing, stale, or wrong per-instance secret) · `413` payload too large · `415` body in a content type no parser reads · `429` rate limit exceeded · `503` a route declaring a `session-alive` preflight whose bound session has no running engine, or its engine has failed

#### DELETE /api/ingress/:pluginId/:instanceId/:path

One route, any HTTP method: the inbound webhook endpoint an external provider delivers to. The
trailing `:path` is the plugin-declared route, a single path segment (e.g. `chatwoot`): only the
first segment selects the route and any further segments are ignored. A plugin whose manifest
declares a route with a `/` is refused at install and at boot. A delivery to a route the plugin did
not claim is a `404`.

**Auth:** **none** — `@Public` by design, because a provider cannot present an API key. What
authenticates a delivery is the per-instance HMAC signature over the exact raw body bytes (the body
is read raw, never DTO-bound, so the signed bytes reach the verifier unchanged). A `GET` on a route
that declares `challenge` is the provider's verification handshake and answers only when its
`verifyToken` matches; any other request, a `GET` included, is a signed delivery.

**Response** — the primary success path is `202`: the delivery is persisted and queued for async
plugin processing. `200` means the `GET` verification-challenge echo, or a route whose declared
`ack` sets it. A route may shape the synchronous status/body/headers the provider sees via its
declarative `ack` config (doc 25); the plugin itself always runs async. A re-delivery of an
already-persisted event is answered with the route's ack, with the same status and headers as the
first delivery, and is not enqueued again. The ack is rendered from the retry, so `{timestamp}` in
an ack body is the retry's time and `{rawBody}` is the retry's body. A retry still passes the checks
that run before dedup: while a `session-alive` route's bound session has no running engine, or its
engine has failed, it gets the `503`.

**Errors:** `400` an encoded NUL (`%00`) in the path or query, or a JSON body that does not parse · `401` signature verification failed (missing, stale, or wrong secret) · `403` `GET` verification challenge failed on a route that declares `challenge` (`verifyToken` mismatch) · `404` unknown pluginId/instanceId, or no such claimed route · `413` body over the route's `maxBodyBytes` · `415` a body in a content type no parser reads (only `application/json` and `application/x-www-form-urlencoded` are read) · `429` rate limit: the per-instance bucket (`INGRESS_INSTANCE_LIMIT`, counted only for deliveries that pass signature verification) or the per-client-IP bucket (`INGRESS_IP_LIMIT`), both per `INGRESS_INSTANCE_TTL`; the global per-IP tiers skip this route, so these two are its bounds, and `Retry-After-instance` / `Retry-After-ingress-ip` names the one that shed the request, alongside a plain `Retry-After` carrying the same delay · `503` a route declaring a `session-alive` preflight whose bound session has no running engine, or its engine has failed (a session that is starting, reconnecting, waiting for a QR scan, or disconnected but still loaded is answered with the route's ack and queued): the delivery is not persisted, so the provider's retry is treated as a new delivery, and `Retry-After` carries the delay

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

Error `code` values include `UNAUTHORIZED`, `INVALID_MESSAGE`, `INVALID_SESSION`, `INVALID_EVENTS`, `FORBIDDEN_SESSION`, `FORBIDDEN_EVENTS`, `TOO_MANY_SUBSCRIPTIONS`, and `RATE_LIMITED`. `RATE_LIMITED` is followed by a disconnect when a handshake exceeds the per-IP connection-attempt window or the key's concurrent-socket cap; a frame over the per-key frame budget gets `RATE_LIMITED` and is dropped undispatched, and the socket stays open. A subscribe answers `INVALID_SESSION` when `sessionId` is missing, or is neither `"*"` nor a session id of at most 128 letters, digits and hyphens. An unsubscribe answers `INVALID_SESSION` when `sessionId` is missing, empty or not a string. A subscribe answers `TOO_MANY_SUBSCRIPTIONS` when it would take the connection past 4096 rooms; chat-restricted subscriptions count every literal chat address form for each session and event. Unsubscribe before subscribing to more.

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
group.join_request
call.received
call.accepted
call.rejected
call.missed
status.received
```

A subscribe request whose `events` array contains no recognized name (after filtering) is rejected with `INVALID_EVENTS`. Unknown names mixed with valid ones are silently dropped; the `subscribed` reply echoes only the accepted events.

> `message.failed` and `session.reconnect_loop` are webhook-only — they are not subscribable on the socket.

### Wildcards and scoping

- **Chat-restricted keys receive only events for `allowedChats`.** Message and presence events require `data.chatId`; group events require `data.groupId`. Persisted phone/LID aliases are matched at delivery time, including mappings learned after subscribing. An event without a resolvable chat is omitted. Account events, calls, statuses, and QR codes are omitted even with `events: ["*"]`; a request containing only account events answers `FORBIDDEN_EVENTS`. These filters apply across Redis replicas. A changed chat authorization disconnects the socket on its next subscribe.
- **`sessionId: "*"`** subscribes to every session; **`events: ["*"]`** subscribes to every subscribable event. They combine (e.g. `"*"` + `["*"]` = every event of every session).
- The API key is **re-validated on every `subscribe`** (not just at connect), so a key revoked or expired mid-connection is caught — the server replies `UNAUTHORIZED` and disconnects.
- **Per-key session scope is enforced** against the fresh key: a key restricted via `allowedSessions` may NOT subscribe to `"*"` and may NOT subscribe to a session outside its allowlist — either is rejected with `FORBIDDEN_SESSION`. An unrestricted key (no `allowedSessions`) may subscribe to anything, including `"*"`.
- **Live sockets are re-validated against the database once a minute**, with no client activity required. A socket carries the key as it stood when it connected, and rooms joined earlier are never revisited, so that snapshot is what the sweep compares against the current row, along with any later `subscribe` whose key no longer matched it (what that `subscribe` granted outlives the change, so putting the row back does not spare the socket). It closes the key's sockets with an `UNAUTHORIZED` frame naming the cause: `API key has been deleted`, `API key has been revoked`, `API key has expired`, or `API key authorization changed; please reconnect` when `role`, `allowedIps`, `allowedSessions`, `allowedChats` or `expiresAt` moved. A change made through this API still evicts synchronously in the same request; the sweep is what catches an expiry, a change written straight to this node's main database, or one committed in the instant a socket was connecting. API keys are per node (see [13 - Horizontal Scaling](./13-horizontal-scaling.md)), so a change made on another node never reaches this node's sockets; repeat it on every node. A rename, and the usage counters the gateway itself writes, evict nobody. Treat these frames as "reconnect and resubscribe", not as fatal.
- **`session.qr` requires the OPERATOR role**, matching `GET /api/sessions/{sessionId}/qr`. A VIEWER key may still subscribe to it, by name or through a wildcard, but the QR is never delivered to its sockets; every other event is. The role is read from the key re-validated on each `subscribe`, so a key narrowed to VIEWER stops receiving the QR from its next `subscribe`. Between subscribes the QR gate rests on the same snapshot as every other event: a key demoted right after a `subscribe` keeps receiving the QR until its sockets are evicted, which is immediate on the node processing the change; other nodes keep their own copy of the key and are unaffected until the change is repeated there.

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
  "idempotencyKey": "msg_my-session_3EB0ABC123_f1e2d3c4-b5a6-7890-1234-567890abcdef",
  "deliveryId": "dlv_550e8400-e29b-41d4-a716-446655440000",
  "data": {}
}
```

`event`, `timestamp` (ISO-8601 dispatch time), `sessionId`, `idempotencyKey`, and `deliveryId` are always present; `data` holds the event-specific payload. The same values are mirrored into request headers (below). The HMAC `signature` is **not** in the body — it travels in the `X-OpenWA-Signature` header.

### Event catalog

These are the events OpenWA actually emits. A webhook is registered with an `events` list; an event is delivered to a webhook when its `events` array includes the event name or `"*"`.

| Event                                             | When it fires                                                                                                                                                                                                                         | `data` payload sketch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.received`                                | An inbound message arrives                                                                                                                                                                                                            | The full message object: `id`, `from`, `to`, `body`, `type`, `timestamp` (epoch **seconds**), `isGroup`, `kind` (user-facing chat discriminator of `chatId` — `individual\|group\|channel\|status\|broadcast\|unknown`), `fromMe`, `chatId`, `media{mimetype,filename?,data?,omitted?,sizeBytes?}` (media messages only), `contact{…}` (plus optional `senderPhone` for `@lid` senders, `order{orderId,token?}` / `product{productId,…}` on `order` / `product` messages, `buttons:[{id,text}]` on a WhatsApp Business prompt that offers choices, and `button{id,text?}` when the sender tapped one; **Baileys only**) |
| `message.sent`                                    | An outbound message is created/sent from this session                                                                                                                                                                                 | Same message object shape as `message.received`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `message.ack`                                     | A delivery/read receipt updates an outbound message                                                                                                                                                                                   | `{ id, messageId, status, ack, chatId? }` — `status` is the canonical state (`pending`/`sent`/`delivered`/`read`/`failed`); `ack` is the deprecated legacy integer derived from it; `chatId` is the conversation the acked message belongs to, present whenever the engine's update names the chat (both engines do on the live path)                                                                                                                                                                                                                                                                                   |
| `message.failed`                                  | A receipt resolves to `failed` (dispatched in addition to `message.ack`)                                                                                                                                                              | `{ id, messageId, status: "failed", ack: -1, chatId? }`; `chatId` follows the same rules as `message.ack`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `message.revoked`                                 | A message is deleted/recalled                                                                                                                                                                                                         | `{ id, revokedId?, chatId, from, to, type: "revoked", body: "", timestamp }` — **reconcile on `revokedId`** (the original deleted message's id), falling back to `id`. On whatsapp-web.js `id` is the _revocation notification_ (a distinct message that won't match a stored id) and `revokedId` may be absent when the original isn't cached locally; on Baileys the two coincide                                                                                                                                                                                                                                     |
| `message.reaction`                                | A reaction is added, changed, or removed                                                                                                                                                                                              | `{ messageId, chatId, reaction, senderId, reactions? }` — `reactions` is the post-apply `{ senderId: emoji }` snapshot, omitted when the gateway holds no stored copy of the message to compute it from (an ephemeral message, or one predating the session going live); treat it as unknown rather than empty and keep the map you already hold. `reaction` is empty when removed                                                                                                                                                                                                                                      |
| `message.edited`                                  | A message body or media caption is edited                                                                                                                                                                                             | `{ messageId, chatId, body, senderId, from, to, fromMe, isGroup, type, hasMedia, author?, mentionedIds?, timestamp }` — `messageId` is the original message id, `body` is the latest text/caption, and `timestamp` is the edit occurrence time in epoch **seconds** (not the original creation time)                                                                                                                                                                                                                                                                                                                    |
| `session.qr`                                      | A new pairing QR is generated                                                                                                                                                                                                         | `{ sessionId, qr }` — `qr` is a **PNG data URL** (`data:image/png;base64,…`), the same rendered value `GET /api/sessions/{sessionId}/qr` returns as `qrCode`, not the raw `2@…` linking ref. Render it directly in an `<img src>`; the raw ref never leaves the engine adapter                                                                                                                                                                                                                                                                                                                                          |
| `session.authenticated`                           | The session pairs and becomes ready                                                                                                                                                                                                   | `{ sessionId, phone, pushName }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session.disconnected`                            | The session disconnects on the engine or WhatsApp side (drop, conflict, or a phone-initiated unlink). Not fired for API-initiated stop/logout/delete — those are acknowledged by the API response and the `session.status` transition | `{ sessionId, reason }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `session.reconnect_loop`                          | Every 5th consecutive reconnect attempt is scheduled (attempt 5, 10, 15, …) — the session is failing to come back up                                                                                                                  | `{ sessionId, attempts, nextDelayMs }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `presence.update`                                 | A subscribed chat's presence changed — someone came online, started typing, or stopped. Only actual CHANGES are dispatched: WhatsApp repeats itself freely, and every repeat would otherwise be a delivery                            | `{ sessionId, chatId, participants: [{ id, state, lastSeen? }], groupOnlineCount? }` — `state` is `available`/`unavailable`/`composing`/`recording`/`paused`; `lastSeen` is epoch **seconds** and absent when the contact hides it. Requires `POST .../presence/subscribe` first, and Baileys — whatsapp-web.js cannot observe presence                                                                                                                                                                                                                                                                                 |
| `session.restriction`                             | WhatsApp places a restriction on the account, or lifts one. Deduped: an unchanged restriction is not re-announced, and a lift is only sent when one was in force                                                                      | `{ sessionId, active, kind, code, expiresAt }` — `active` is `false` for a lift and `kind`/`code` then describe the restriction that ended; `expiresAt` is an ISO timestamp or `null`. See `restriction` on the session response for the `kind` values                                                                                                                                                                                                                                                                                                                                                                  |
| `session.status`                                  | The session status transitions                                                                                                                                                                                                        | `{ sessionId, status }` where `status` is one of `created` / `initializing` / `qr_ready` / `authenticating` / `ready` / `disconnected` / `action_required` / `failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `group.join`                                      | Participant(s) are added to or join a group this session is in                                                                                                                                                                        | `{ groupId, actorId?, participantIds, timestamp }`. `actorId` is the admin/inviter when known. **Baileys**: a session added to or joining a group reports only its own id in `participantIds` (members added with it are not listed)                                                                                                                                                                                                                                                                                                                                                                                    |
| `group.leave`                                     | Participant(s) leave or are removed from a group                                                                                                                                                                                      | `{ groupId, actorId?, participantIds, timestamp }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `group.update`                                    | Group metadata changes (subject, description, announce/locked settings)                                                                                                                                                               | `{ groupId, actorId?, participantIds, changes?, timestamp }` — `changes` carries only the fields that changed: `subject?`, `description?`, `announce?`, `locked?`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `group.join_request`                              | Someone asked to join a group this session administers (join-approval mode on)                                                                                                                                                        | `{ groupId, actorId?, participantIds, timestamp }` — `participantIds` are the users asking to join; `actorId` is who created the request when the engine reports one (differs from the requester on a non-admin add). Act on it via `GET/POST .../groups/:groupId/membership-requests[...]` **Baileys caveat**: the library (7.0.0-rc14) emits this only for non-admin-add requests — an invite-link self-request may produce no event there (upstream TODO); the membership-requests list endpoint still reports it.                                                                                                   |
| `call.received`                                   | An incoming voice/video call starts ringing. Dispatched by both engines, but **not reliable on whatsapp-web.js**: it fired in a live test on 2026-09-17 and did not in one on 2026-08-10                                              | `{ callId, from, isVideo, isGroup, timestamp }` — `callId` is the id to pass to `POST /sessions/:sessionId/calls/:callId/reject` (Baileys only). `from` may be an `@lid` privacy id on either engine; resolve it with `GET /api/sessions/:sessionId/contacts/:contactId/phone`                                                                                                                                                                                                                                                                                                                                          |
| `call.accepted` / `call.rejected` / `call.missed` | A ringing call ended, whether answered, declined, or never picked up. **Baileys only**: whatsapp-web.js emits no call-outcome event                                                                                                   | `{ sessionId, callId, from, outcome, isVideo, isGroup, timestamp }`. `callId` matches the `call.received` that preceded it, so the pair can be correlated. The engines report _what_ happened, never _who_ did it: an accept can come from any linked device. An outcome is only sent for a call this session saw ring, and offline-replayed signalling for calls that ended while disconnected is dropped. WhatsApp's `terminate` is deliberately unmapped: it covers both a caller hanging up before answer and either side ending an answered call, with nothing to tell them apart                                  |
| `status.received`                                 | A contact posts a status/story (opt-in — see below)                                                                                                                                                                                   | `{ sessionId, statusId, contact: { id, name?, pushName? }, type, caption?, hasMedia, mediaOmitted, omitReason?, postedAt, expiresAt }` — `statusId` is the store's `id` (usable with the status endpoints below); `postedAt`/`expiresAt` are epoch **milliseconds** (unlike the epoch-seconds convention for message timestamps), matching the `GET /status` store's own `Date`-backed fields                                                                                                                                                                                                                           |

> **`status.received` is opt-in and carries no media blob.** Unlike every other event above, `status.received` is only delivered to a webhook whose `events` list explicitly includes `"status.received"` (or `"*"`) — registering for other events does not implicitly subscribe you to it. The payload never embeds media bytes: when `hasMedia` is `true`, fetch the file separately via `GET /api/sessions/:sessionId/status/:statusId/media`. Your own posted statuses never trigger this event — only inbound stories from contacts (an own-send echo is dropped before ingest).

> **`STORE_EPHEMERAL_MESSAGES=false` affects `message.received`.** When `STORE_EPHEMERAL_MESSAGES` is set to `false`, incoming disappearing messages (those with `ephemeralDuration > 0`) are **not** persisted nor dispatched — no DB insert, no webhook delivery, and no websocket event. Downstream consumers and the dashboard both stop seeing them. Default is `true` (backward compatible — store and dispatch everything).

> **`senderPhone` on `message.received` is opt-in (`RESOLVE_LID_TO_PHONE`).** When a sender is identified by a WhatsApp privacy id (`…@lid`) rather than a phone number, setting `RESOLVE_LID_TO_PHONE=true` attaches a best-effort `senderPhone` — MSISDN digits, or `null` when the engine cannot map the id — before dispatch, so the webhook and the websocket event both carry it in the same pass. Default is **off**, and while it is off the field is absent from every payload: resolving costs a per-sender lookup (cached). Only inbound privacy-id senders are resolved — a sender that already is a phone number needs no lookup, and own-sends are skipped. The on-demand `GET /api/sessions/:sessionId/contacts/:contactId/phone` works regardless of this flag.

> **`contact` on `message.received` is minimal unless you opt in (`WEBHOOK_CONTACT_DETAILS`).** By default the payload carries only `contact { name?, pushName? }`. Setting `WEBHOOK_CONTACT_DETAILS=true` adds `id`, `number`, `shortName`, `type`, `isMyContact`, `isWAContact`, `isBusiness`, `isEnterprise`, `verifiedName`, `verifiedLevel`, `isBlocked` and `labels`, each present only when the engine has a value for it. Every field is copied from the contact record the engine has already loaded for the message, so opting in costs no extra WhatsApp lookup and cannot add rate-limiting pressure. The same enrichment reaches the websocket event, since both are dispatched from one payload. `contact` itself is omitted entirely when the engine has no value for any of its fields, so treat the whole object as optional rather than just its members. **whatsapp-web.js only** — the Baileys path emits `contact { pushName }` when a push name is available, and never reads this flag.

> **Large media is not inlined into webhook payloads.** A `media` blob whose decoded size exceeds `WEBHOOK_MEDIA_INLINE_MAX_BYTES` (default **1 MiB**; `0` = never inline) is replaced — before the payload is fanned out to your webhook — with the marker form `media: { mimetype, filename?, omitted: true, sizeBytes }`, the same shape the engine emits for capped inbound media. Media at or under the cap stays inline unchanged. Additionally, if the serialized body still exceeds `WEBHOOK_MAX_PAYLOAD_BYTES` (default **1 MiB**) after `webhook:before` hooks ran, any remaining inline media is shed the same way so the event is still delivered; only a payload that is over budget _without_ inline media is dropped (recorded in `GET /api/webhooks/delivery-failures`). Because shedding happens before enqueue, queued and failed BullMQ jobs in Redis never carry the blob either — failed-job retention is bounded by the queue's `removeOnComplete`/`removeOnFail` windows (1h/1000 completed, 24h/5000 failed). The two limits compound: `WEBHOOK_MAX_PAYLOAD_BYTES` is measured on the serialized JSON body after `WEBHOOK_MEDIA_INLINE_MAX_BYTES` has been applied, and base64 inflates media by a third, so at the defaults media above roughly **768 KiB** reaches your webhook as the omitted marker. To inline larger media, raise both together and keep the payload limit at least 4/3 of the inline limit plus room for the rest of the event (for example `5242880` inline with `7340032` payload). The **WebSocket** `message.received` / `message.sent` events apply only the inline cap, with the same marker: an over-cap blob is never broadcast to subscribed sockets (or, with the Redis adapter enabled, replicated across every replica's pub/sub link). On either sink, media the engine downloaded stays retrievable from [`GET /api/sessions/:sessionId/messages/:chatId/:messageId/media`](#get-apisessionssessionidmessageschatidmessageidmedia), which returns `404` when nothing was stored.

> There is **no** `contact.update` event. `presence.update` is emitted only for chats you have subscribed to (see the presence-subscription endpoint); call outcomes are reported as `call.accepted`, `call.rejected` and `call.missed` alongside `call.received`.

> **Group-event timing caveat (Baileys).** Membership/metadata changes that occurred while a Baileys session was offline are replayed by WhatsApp on reconnect and are dispatched like live events — but the engine does not forward their original occurrence time, so they carry the **receipt time** as `timestamp`. Treat `group.*` payloads as change notifications rather than a precise clock; stale offline _calls_ are never emitted this way (they are filtered by the `offline` flag).

### Delivery semantics — at-least-once

Webhook delivery is **at-least-once**. A consumer can legitimately receive the same logical event more than once because:

- The underlying WhatsApp engine can re-fire an event for a single message.
- A failed delivery (non-2xx response, timeout, or network error) is retried.

**Crash boundary.** For an ordinary dispatch, a successfully written outbox record retains the pre-hook event data until delivery succeeds, the subscription becomes ineligible, or the terminal failure is stored. Queued records keep this copy even after enqueue; the worker retires it only after one of those outcomes. If failure recording fails, the copy remains eligible for recovery. The bounded sweep (`WEBHOOK_RECONCILE_INTERVAL_MS`, default 60s) checks the stored job before replaying, leaves active jobs alone, and reuses the stored `X-OpenWA-Idempotency-Key`. If Redis cannot confirm the job state, replay waits. A missing or failed job, or a stranded direct delivery, can be replayed within `WEBHOOK_RECONCILE_MAX_ATTEMPTS`. A replay sent directly (the queue off, or its enqueue failed) that exhausts its retries stores its terminal failure row but keeps the outbox copy pending, so later sweeps replay it until that budget is spent; exhausting it retires the outbox only after terminal failure recording succeeds. Receiver deduplication remains necessary because a crash after receiver processing can cause another POST.

Outbox creation is best effort, and message persistence and outbox insertion are separate transactions. A write failure or crash between them can still lose the webhook delivery. Failure records with zero attempts are excluded from operator redrive. Capacity and shutdown rejections can still be recovered from an unsettled outbox record; shutdown during retry backoff may follow earlier POSTs. The direct dispatcher leaves its local in-flight work alone during reconciliation. Graceful shutdown drains current queue jobs; direct sends, and an outbox replay in flight with its plugin hooks, get up to `WEBHOOK_SHUTDOWN_DRAIN_MS` (default 5s). That replay sends at most one more POST, bounded by `WEBHOOK_TIMEOUT`, and no further row is replayed; the next start replays what it left pending.

Before downgrading to a version that does not recognize the `queued` outbox state, drain or recover those records and take a backup. Its cleanup may otherwise treat an unsettled queued record as settled. Reverting the terminal-identity migration removes its index but does not restore historical duplicates.

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
  if (typeof header !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so a short or forged header must return false first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Complete Express and FastAPI receivers are in [`examples/webhook-signature-verification.md`](examples/webhook-signature-verification.md). From the next SDK release (after 0.5.0), the SDKs ship this check: `verifyWebhookSignature` (JavaScript), `verify_webhook_signature` (Python), `VerifyWebhookSignature` (Go), `WebhookSignature.verify` (Java) and `WebhookSignature::verify` (PHP).

If no `secret` is configured the `X-OpenWA-Signature` header is omitted entirely.

### Idempotency & delivery headers

Every delivery includes:

| Header                     | Meaning                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `X-OpenWA-Event`           | The event name (mirrors `event`)                                                                             |
| `X-OpenWA-Idempotency-Key` | Content-derived key; **stable across retries** of the same occurrence — dedupe on this                       |
| `X-OpenWA-Delivery-Id`     | `dlv_<uuid>` per webhook per event, **same on every automatic retry**; replays get a new one. Not for dedup. |
| `X-OpenWA-Retry-Count`     | Retry attempt number (`0` = first attempt)                                                                   |
| `X-OpenWA-Signature`       | HMAC (only when a secret is set)                                                                             |

**Idempotency key derivation.** The key is content-derived so duplicates of the same logical event collapse to one value. Every key below is then suffixed with `_{webhookId}`, so two webhooks subscribed to the same event never share a key:

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
- `session.reconnect_loop`: `loop_{sessionId}_{attempts}_{occurredAt}`
- `group.join` / `group.leave`: `grp_{groupId}_{hash(participantIds)}_{join|leave}_{occurredAt}`
- `group.update`: `grp_{groupId}_update_{hash(changes)}_{occurredAt}`
- `group.join_request`: `grp_{groupId}_{hash(participantIds)}_join_request_{occurredAt}` (salted like `group.join` — a rejected user can legitimately ask again)
- `call.received`: `call_{sessionId}_{callId}` (a call id is unique per call, so no `occurredAt` salt)
- `call.accepted` / `call.rejected` / `call.missed`: `call_{sessionId}_{callId}_{outcome}` (each call ends once, so no `occurredAt` salt)
- `session.restriction`: `restr_{sessionId}_{kind}_{active}_{occurredAt}`
- `presence.update`: `pres_{sessionId}_{chatId}_{hash(participants)}_{occurredAt}`
- any other event (for example `status.received`): `evt_{event with . replaced by _}_{hash(data)}`

Recurring lifecycle events (and `message.reaction` / `message.edited` / `presence.update`) carry the same content across occurrences — the same phone on every reconnect, a constant disconnect reason, a re-applied emoji, or editing the same message multiple times — so they are salted with an `occurredAt` timestamp captured **once per dispatch and reused across that dispatch's retries**. This gives distinct occurrences distinct keys while keeping retries of one occurrence stable. Message keys are scoped by `sessionId` because WhatsApp message ids are unique per account, not globally.

### Retries with exponential backoff

When the queue is enabled, a non-2xx response, timeout (`WEBHOOK_TIMEOUT`, default `10000` ms), or network error schedules a retry. The number of attempts comes from the webhook's `retryCount` (default `3`) and the delay grows **exponentially** from a base of `WEBHOOK_RETRY_DELAY` (default `5000` ms). Each retry reuses the same `idempotencyKey` and increments `X-OpenWA-Retry-Count`. If Redis/BullMQ rejects the initial enqueue, OpenWA logs a `webhook:error` hook event and falls back to direct delivery with the same inline retry budget. When the queue is disabled, delivery is direct with the same retry budget and the same exponential backoff applied inline. Every retry, queued or direct, re-reads the webhook first: a webhook deleted, disabled or unsubscribed from the event since the dispatch gets no further attempt and no delivery-failure row, and a changed URL, secret or header map applies from the next attempt. With the queue disabled, a delivery that waited behind the failing-webhook cap (`WEBHOOK_DEGRADED_SESSION_CONCURRENCY`) re-reads the webhook the same way before its first attempt; if that read fails, the attempt uses the webhook as loaded at dispatch.

### SSRF guard on registration

Webhook URLs are validated at **registration time**, not just at delivery. When SSRF protection is enabled (the default), creating a webhook, or updating one to a different URL, with a URL that resolves to a private/internal/loopback address is rejected synchronously with `400 Bad Request` instead of failing silently later at delivery. The `SSRF_ALLOWED_HOSTS` escape-hatch applies equally to registration and delivery. Independently of the SSRF flag, a URL embedding credentials (`https://user:pass@host/hook`) is rejected with `400` — such credentials would otherwise be persisted and echoed into delivery logs and dead-letter rows. An update that re-sends the stored URL unchanged skips both checks, so a webhook whose host became blocked can still be deactivated or re-filtered; delivery still applies the SSRF guard. Operator-supplied custom headers that target reserved names (`Content-Type`, `User-Agent` or any `X-OpenWA-*`, in any letter case) are stripped, so a webhook config cannot forge the signature, event, or idempotency headers. A header map with two names that differ only in case is rejected with `400`. The connection-level names the HTTP client owns (`Connection`, `Content-Length`, `Expect`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) are stripped as well, since setting one would fail or corrupt the delivery.

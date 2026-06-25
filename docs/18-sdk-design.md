# 18 - SDK Design

## 18.1 Overview

OpenWA ships three official, hand-written client libraries for the REST API. They are not generated from an OpenAPI spec — each is written directly against the real API surface (paths, request DTOs, response shapes) and **unit-tested with a mocked HTTP transport that asserts on the exact request path, method, and body**, so contract drift is caught at test time rather than in production.

| Language | Package | Install | Notes |
| --- | --- | --- | --- |
| JavaScript / TypeScript | [`@rmyndharis/openwa`](https://www.npmjs.com/package/@rmyndharis/openwa) | `npm install @rmyndharis/openwa` | Dual ESM + CJS, bundled `.d.ts` types, Node 18+ |
| Python | [`rmyndharis-openwa`](https://pypi.org/project/rmyndharis-openwa/) | `pip install rmyndharis-openwa` | Synchronous (httpx), PEP 561 typed, Python 3.9+ |
| PHP | [`rmyndharis/openwa`](https://packagist.org/packages/rmyndharis/openwa) | `composer require rmyndharis/openwa` | Synchronous (Guzzle 7), PSR-4, PHP 8.1+ |

> The import names differ from the dist names where the ecosystem requires it. Python installs `rmyndharis-openwa` but imports `openwa`; the client class is `OpenWAClient` in JS/Python and `OpenWA\Client` in PHP.

### Design Principles

- **One client, fluent resources.** A single client object (`OpenWAClient` / `OpenWA\Client`) exposes every resource as a property — `client.messages.sendText(...)`, `client.sessions.start(...)`. All three SDKs expose the **same** resource surface; only the language idioms differ (camelCase methods + objects in JS/PHP, snake_case methods + dicts in Python).
- **It is a request/response client, not an event SDK.** There is no WebSocket, EventEmitter, or `client.on(...)`. To receive inbound messages and acks, register a webhook (the `webhooks` resource) and host your own receiver, or connect to the real-time Socket.IO API directly (see [API Specification §6.5](./06-api-specification.md)).
- **Typed errors.** Non-2xx responses raise/throw a typed error mapped from the HTTP status (`401/403/404/409/429/501`), plus a timeout error — all `instanceof`/`catch`-checkable. See each language's Error Handling subsection.
- **Injectable transport.** The HTTP layer is replaceable (`fetch` in JS, an `httpx` transport in Python, a Guzzle client in PHP) — the extension point for retry/observability middleware and for testing without the network.
- **Safe by default.** Redirects are never followed (so the API key is never re-sent to a redirect target), the auth/JSON headers always take precedence over caller-supplied defaults, path segments are percent-encoded, a base-URL path prefix (e.g. behind a reverse proxy at `/v1`) is preserved, and there is a default 30s per-request timeout. **No automatic retries** — wrap calls in your own backoff if you need them (especially for `429`).

### Resource Coverage

All three SDKs expose the same fluent surface:

| Resource | Methods |
| --- | --- |
| `sessions` | list, get, create, delete, start, stop, forceKill, getQrCode, requestPairingCode, stats |
| `messages` | list, sendText, sendImage/Video/Audio/Document/Sticker, sendLocation, sendContact, sendTemplate, reply, forward, react, delete, history, reactions, sendBulk, batchStatus, cancelBatch |
| `contacts` | list, get, check, profilePicture, phone, block, unblock |
| `groups` | list, get, create, add/remove/promote/demoteParticipants, setSubject, setDescription, leave, inviteCode, revokeInviteCode |
| `webhooks` | list, get, create, update, delete, test |
| `chats` | list, markRead, markUnread, delete, sendState |
| `labels` | list, get, forChat, addToChat, removeFromChat *(WhatsApp Business)* |
| `channels` | list, get, messages, subscribe, unsubscribe *(Newsletters)* |
| `catalog` | info, products, product, sendProduct, sendCatalog *(WhatsApp Business)* |
| `status` | list, fromContact, sendText, sendImage, sendVideo, delete *(Stories)* |
| `templates` | list, get, create, update, delete |
| `health` | check, live, ready |

> The operator/admin-only server modules — `docker`, `metrics`, `infra`, `plugins`, `mcp` — are intentionally **not** exposed in the SDKs; all user-facing resources above are. Methods that require an `OPERATOR`-level key are annotated **OPERATOR** in the per-language tables below.

## 18.2 TypeScript / JavaScript SDK

The official JavaScript/TypeScript SDK is published as **`@rmyndharis/openwa`**. It is a pure promise-based HTTP client: a single `OpenWAClient` exposes every API resource as a typed property. There is no event model — the SDK does not open WebSockets, emit events, or expose `client.on(...)`. To receive inbound messages and acks, configure a webhook (see the `webhooks` resource) and host your own HTTP receiver.

The package ships **dual CJS + ESM** with bundled `.d.ts` types, so it is consumable from both `require()` and `import`.

### Installation

```bash
npm install @rmyndharis/openwa
# or
yarn add @rmyndharis/openwa
# or
pnpm add @rmyndharis/openwa
```

> **Node 18+ required.** The transport uses the global `fetch` (and `AbortController`), both built into Node 18 and later. To run on an older runtime, pass your own `fetch` implementation via the client constructor (see [Client Configuration](#client-configuration)).

### Quick Start

```typescript
import { OpenWAClient } from '@rmyndharis/openwa';

const client = new OpenWAClient({
  baseUrl: 'http://localhost:2785',
  apiKey: 'owa_k1_…',
});

async function main() {
  // Start a session and bring the WhatsApp connection up.
  await client.sessions.start('my-session');

  // Send a text message.
  const result = await client.messages.sendText('my-session', {
    chatId: '628123456789@c.us',
    text: 'Hello from the OpenWA SDK!',
  });

  console.log(result.messageId); // -> the WhatsApp message id
}

main();
```

`sendText` resolves to a `MessageResponse` (`{ messageId: string; timestamp: number }`). `timestamp` is the Unix epoch value returned by the API — **seconds**, passed through unchanged.

CommonJS consumers use the same API via `require`:

```javascript
const { OpenWAClient } = require('@rmyndharis/openwa');
```

### Client Configuration

The constructor takes a single `OpenWAClientOptions` object. `baseUrl` and `apiKey` are required (the constructor throws synchronously if either is missing).

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `baseUrl` | `string` | yes | — | Base URL of the OpenWA API, e.g. `http://localhost:2785`. A trailing slash is trimmed; a path prefix (e.g. `https://host/v1`) is preserved. |
| `apiKey` | `string` | yes | — | API key sent as the `X-API-Key` header on every request. |
| `timeoutMs` | `number` | no | `30000` | Per-request timeout in milliseconds. Overridable per call via `RequestOptions.timeoutMs` on the raw `request()` method. |
| `defaultHeaders` | `Record<string, string>` | no | `{}` | Headers merged onto every request. The `Content-Type: application/json` and `X-API-Key` headers always take precedence. |
| `fetch` | `FetchLike` | no | `globalThis.fetch` | Injectable transport (the WHATWG `fetch` signature). Use this to wrap requests with retry/observability middleware, or to supply a `fetch` on runtimes that lack a global one. |

### Resources & Methods

All resources are accessed as properties on the client (`client.<resource>.<method>`). Every method returns a `Promise`. Methods marked **OPERATOR** require an API key with the `OPERATOR` role; a non-operator key receives a `403` (`OpenWAForbiddenError`).

The top-level client also exposes:

| Method | Signature | Description |
| --- | --- | --- |
| `auth` | `client.auth()` | Validate the configured API key and resolve its role (`{ valid, role? }`). |
| `request` | `client.request<T>(options)` | Raw escape hatch — issue an arbitrary request against the API. |

#### `sessions`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list()` | List all sessions (scoped to the key's `allowedSessions`). |
| `get` | `get(id)` | Get a single session by id. |
| `create` | `create(body)` | Create a new session (`body.name` required). **OPERATOR** |
| `delete` | `delete(id)` | Delete a session. **OPERATOR** |
| `start` | `start(id)` | Start a session and initialize the WhatsApp connection. |
| `stop` | `stop(id)` | Stop a session and disconnect gracefully. |
| `forceKill` | `forceKill(id)` | Force-kill a stuck session (SIGKILL + teardown). |
| `getQrCode` | `getQrCode(id)` | Get the current QR code for authentication (live from the engine). |
| `requestPairingCode` | `requestPairingCode(id, body)` | Request an 8-character pairing code for phone-based login. |
| `stats` | `stats()` | Aggregate statistics across the key's sessions. |

#### `messages`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId, query?)` | List messages (filter by chat/sender); returns `{ messages, total }`. |
| `sendText` | `sendText(sessionId, { chatId, text })` | Send a text message (`text` max 4096 chars). |
| `sendImage` | `sendImage(sessionId, body)` | Send an image (`url` or `base64`). |
| `sendVideo` | `sendVideo(sessionId, body)` | Send a video (`url` or `base64`). |
| `sendAudio` | `sendAudio(sessionId, body)` | Send an audio file (`url` or `base64`). |
| `sendDocument` | `sendDocument(sessionId, body)` | Send a document (`url` or `base64`; `filename` recommended). |
| `sendSticker` | `sendSticker(sessionId, body)` | Send a sticker (`url` or `base64`). |
| `sendLocation` | `sendLocation(sessionId, body)` | Send a location (`{ chatId, latitude, longitude, description? }`). |
| `sendContact` | `sendContact(sessionId, body)` | Send a contact card. |
| `sendTemplate` | `sendTemplate(sessionId, body)` | Render and send a stored message template. |
| `reply` | `reply(sessionId, body)` | Reply to a specific message. |
| `forward` | `forward(sessionId, body)` | Forward a message to another chat. |
| `react` | `react(sessionId, body)` | React to a message (empty `reaction` removes it). |
| `delete` | `delete(sessionId, body)` | Delete a message. |
| `history` | `history(sessionId, chatId, query?)` | Get message history for a chat (read live from WhatsApp). |
| `reactions` | `reactions(sessionId, chatId, messageId)` | Get reactions for a specific message. |
| `sendBulk` | `sendBulk(sessionId, body)` | Send a batch asynchronously (202 + batch id); poll via `batchStatus`. |
| `batchStatus` | `batchStatus(sessionId, batchId)` | Poll the status/progress of a bulk-send batch. |
| `cancelBatch` | `cancelBatch(sessionId, batchId)` | Cancel a running batch. **OPERATOR** |

Media bodies share the `SendMediaRequest` shape: `{ chatId, url? | base64?, mimetype?, filename?, caption? }` (`url` and `base64` are mutually exclusive; `base64` requires `mimetype`).

#### `contacts`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId, query?)` | List contacts known to the session. |
| `get` | `get(sessionId, contactId)` | Get details for a single contact by JID. |
| `check` | `check(sessionId, number)` | Check whether a phone number is registered on WhatsApp. |
| `profilePicture` | `profilePicture(sessionId, contactId)` | Get the contact's profile picture URL (or null). |
| `phone` | `phone(sessionId, contactId)` | Resolve a contact id (e.g. a `@lid`) to a phone number. |
| `block` | `block(sessionId, contactId)` | Block a contact. **OPERATOR** |
| `unblock` | `unblock(sessionId, contactId)` | Unblock a contact. **OPERATOR** |

#### `groups`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId, query?)` | List all groups for the session. |
| `get` | `get(sessionId, groupId)` | Get detailed group info including participants. |
| `create` | `create(sessionId, body)` | Create a new group. **OPERATOR** |
| `addParticipants` | `addParticipants(sessionId, groupId, participants)` | Add participants (`string[]`) to a group. **OPERATOR** |
| `removeParticipants` | `removeParticipants(sessionId, groupId, participants)` | Remove participants from a group. **OPERATOR** |
| `promoteParticipants` | `promoteParticipants(sessionId, groupId, participants)` | Promote participants to group admin. **OPERATOR** |
| `demoteParticipants` | `demoteParticipants(sessionId, groupId, participants)` | Demote participants from group admin. **OPERATOR** |
| `setSubject` | `setSubject(sessionId, groupId, subject)` | Update the group subject (name). **OPERATOR** |
| `setDescription` | `setDescription(sessionId, groupId, description)` | Update the group description (empty clears it). **OPERATOR** |
| `leave` | `leave(sessionId, groupId)` | Leave a group. **OPERATOR** |
| `inviteCode` | `inviteCode(sessionId, groupId)` | Get the group invite code and link. |
| `revokeInviteCode` | `revokeInviteCode(sessionId, groupId)` | Revoke the current invite code and generate a new one. **OPERATOR** |

#### `chats`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId, query?)` | List active chats, most recent first. |
| `markRead` | `markRead(sessionId, body)` | Mark a chat as read/seen. **OPERATOR** |
| `markUnread` | `markUnread(sessionId, body)` | Mark a chat as unread. **OPERATOR** |
| `delete` | `delete(sessionId, body)` | Delete a chat from the chat list. **OPERATOR** |
| `sendState` | `sendState(sessionId, body)` | Send a chat presence state (typing/recording/paused). **OPERATOR** |

#### `webhooks`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId)` | List all webhooks for a session. |
| `get` | `get(sessionId, id)` | Get a single webhook by id. |
| `create` | `create(sessionId, body)` | Create a new webhook. **OPERATOR** |
| `update` | `update(sessionId, id, body)` | Update a webhook. **OPERATOR** |
| `delete` | `delete(sessionId, id)` | Delete a webhook. **OPERATOR** |
| `test` | `test(sessionId, id)` | Trigger a test dispatch to the webhook URL and report the result. **OPERATOR** |

#### `labels` *(WhatsApp Business)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId)` | List all labels available in the business account. |
| `get` | `get(sessionId, labelId)` | Get a single label by id. |
| `forChat` | `forChat(sessionId, chatId)` | Get the labels currently applied to a chat. |
| `addToChat` | `addToChat(sessionId, chatId, body)` | Add a label to a chat. **OPERATOR** |
| `removeFromChat` | `removeFromChat(sessionId, chatId, labelId)` | Remove a label from a chat. **OPERATOR** |

#### `channels` *(Newsletters)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId)` | List all channels/newsletters the session is subscribed to. |
| `get` | `get(sessionId, channelId)` | Get a single channel by id. |
| `messages` | `messages(sessionId, channelId, query?)` | Get recent messages from a channel. |
| `subscribe` | `subscribe(sessionId, body)` | Subscribe to a channel using its invite code. **OPERATOR** |
| `unsubscribe` | `unsubscribe(sessionId, channelId)` | Unsubscribe from a channel. **OPERATOR** |

#### `catalog` *(WhatsApp Business)*

| Method | Signature | Description |
| --- | --- | --- |
| `info` | `info(sessionId)` | Get the business catalog info. |
| `products` | `products(sessionId, query?)` | List catalog products; returns `{ products, pagination }`. |
| `product` | `product(sessionId, productId)` | Get a single product by id. |
| `sendProduct` | `sendProduct(sessionId, body)` | Send a product message. **OPERATOR** |
| `sendCatalog` | `sendCatalog(sessionId, body)` | Send a catalog link message. **OPERATOR** |

#### `status` *(Stories)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId)` | Get all status updates (`{ statuses }`). |
| `fromContact` | `fromContact(sessionId, contactId)` | Get status updates from a specific contact. |
| `sendText` | `sendText(sessionId, body)` | Post a text status update. **OPERATOR** |
| `sendImage` | `sendImage(sessionId, body)` | Post an image status update. **OPERATOR** |
| `sendVideo` | `sendVideo(sessionId, body)` | Post a video status update. **OPERATOR** |
| `delete` | `delete(sessionId, statusId)` | Delete a status update by id. **OPERATOR** |

> This is WhatsApp "Status/Stories", distinct from session lifecycle status.

#### `templates`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(sessionId)` | List all templates for a session. |
| `get` | `get(sessionId, id)` | Get a single template by id. |
| `create` | `create(sessionId, body)` | Create a new template. **OPERATOR** |
| `update` | `update(sessionId, id, body)` | Update a template. **OPERATOR** |
| `delete` | `delete(sessionId, id)` | Delete a template. **OPERATOR** |

#### `health`

| Method | Signature | Description |
| --- | --- | --- |
| `check` | `check()` | General health (also returns the running version). |
| `live` | `live()` | Kubernetes liveness probe (`{ status }`). |
| `ready` | `ready()` | Kubernetes readiness probe — checks both DB connections. |

### Error Handling

On a non-2xx response the SDK throws a typed `OpenWAApiError` subclass carrying `.status` (HTTP status), `.body` (parsed JSON error envelope, or raw text), and `.errorKind` (the NestJS `error` field). All error classes extend `OpenWAError` and are exported, so they are `instanceof`-checkable. A timeout throws `OpenWATimeoutError`, which extends `OpenWAError` directly (not `OpenWAApiError`).

| Error class | HTTP status | Meaning |
| --- | --- | --- |
| `OpenWAAuthError` | 401 | Missing or invalid API key. |
| `OpenWAForbiddenError` | 403 | The key's role is insufficient (e.g. an OPERATOR-only route). |
| `OpenWANotFoundError` | 404 | Resource not found. |
| `OpenWAConflictError` | 409 | Conflict — typically the engine is not ready. |
| `OpenWARateLimitError` | 429 | Rate limited. |
| `OpenWANotImplementedError` | 501 | The active engine does not support this operation. |
| `OpenWAApiError` | any other | Generic non-2xx (the base API error, e.g. `400`; also surfaced for unfollowed 3xx redirects). |
| `OpenWATimeoutError` | — | The request exceeded the configured timeout. |

```typescript
import {
  OpenWAClient,
  OpenWAConflictError,
  OpenWANotFoundError,
  OpenWARateLimitError,
  OpenWATimeoutError,
  OpenWAApiError,
} from '@rmyndharis/openwa';

try {
  await client.messages.sendText('my-session', {
    chatId: '628123456789@c.us',
    text: 'Hi!',
  });
} catch (err) {
  if (err instanceof OpenWAConflictError) {
    // 409 — engine not ready; start the session first.
  } else if (err instanceof OpenWANotFoundError) {
    // 404 — session/chat does not exist.
  } else if (err instanceof OpenWARateLimitError) {
    // 429 — back off and retry.
  } else if (err instanceof OpenWATimeoutError) {
    // request timed out.
  } else if (err instanceof OpenWAApiError) {
    console.error(`API error ${err.status}:`, err.body);
  } else {
    throw err; // network/transport error
  }
}
```

### Notable Behaviors

- **Redirects are never followed.** The transport uses `redirect: 'manual'`, so a `3xx` surfaces to the caller as an error (via `OpenWAApiError`) rather than being followed — this guarantees the `X-API-Key` header is never re-sent to a redirect target (potentially a different origin).
- **Auth and JSON headers take precedence.** Request headers are merged in the order `Content-Type: application/json` → `defaultHeaders` → per-call headers → `X-API-Key`. The `X-API-Key` is applied last and cannot be overridden; `Content-Type` defaults to JSON.
- **Path segments are percent-encoded.** Ids (session, chat, message, etc.) are encoded so a value cannot break out of its path position, while keeping the WhatsApp-safe characters `@`, `:`, and `+` readable (e.g. `628123456789@c.us`).
- **Base-URL path prefix is preserved.** A `baseUrl` such as `https://gateway.example.com/v1` keeps its `/v1` prefix on every request; only a trailing slash is trimmed.
- **No automatic retries.** A failed request rejects immediately — the SDK does not retry, even on `429`. Wrap calls in your own backoff if you need retries.
- **Injectable transport.** Supply a custom `fetch` to wrap outbound calls with retry, logging, or observability middleware, or to run on a runtime without a global `fetch`. This is also the recommended way to unit-test without monkey-patching globals.
- **Dual CJS + ESM.** The package exposes both an `import` (ESM) and `require` (CommonJS) entry point with bundled type declarations, so it works in either module system without configuration.

## 18.3 Python SDK

The Python SDK is a **synchronous** client built on [`httpx`](https://www.python-httpx.org/). It ships its own type hints (PEP 561) so editors and type-checkers see the full surface without stubs. There is **no async client and no event/streaming model** — every call is a blocking method that returns a plain `dict`/`list` (or `None` for a 204), and request payloads are plain `dict`s.

### Installation

The PyPI distribution name and the import package differ:

```bash
pip install rmyndharis-openwa
```

```python
from openwa import OpenWAClient
```

- **Distribution (PyPI):** `rmyndharis-openwa`
- **Import package:** `openwa`
- **Client class:** `OpenWAClient`
- **Python:** `>=3.9` (per `pyproject.toml`)
- **Runtime dependency:** `httpx>=0.25.0,<1.0`
- **Typed:** ships `py.typed` markers for `openwa` and `openwa.resources` (PEP 561)

### Quick Start

```python
from openwa import OpenWAClient

client = OpenWAClient(
    base_url="http://localhost:2785",
    api_key="owa_k1_…",
)

# Create then start a session
client.sessions.create({"name": "my-session"})
client.sessions.start("my-session")

# Send a text message
result = client.messages.send_text("my-session", {
    "chatId": "628123456789@c.us",
    "text": "Hello from the OpenWA Python SDK!",
})
print(result["messageId"])

client.close()
```

`OpenWAClient` is also a context manager, so the connection pool is closed for you:

```python
with OpenWAClient(base_url="http://localhost:2785", api_key="owa_k1_…") as client:
    print(client.health.check())
```

### Client Configuration

Constructor signature (from `client.py`):

```python
OpenWAClient(
    base_url: str,
    api_key: str,
    *,
    timeout: float = 30.0,
    default_headers: Mapping[str, str] | None = None,
    transport: httpx.BaseTransport | None = None,
)
```

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `base_url` | `str` | *(required)* | Gateway base URL, e.g. `http://localhost:2785`. Raises `ValueError` if empty. A trailing `/` is stripped; any path prefix is preserved. |
| `api_key` | `str` | *(required)* | API key sent as the `X-API-Key` header. Raises `ValueError` if empty. |
| `timeout` | `float` | `30.0` | Per-request timeout in seconds. A breach raises `OpenWATimeoutError`. |
| `default_headers` | `Mapping[str, str] \| None` | `None` | Extra headers applied to every request. Applied **first**, so the SDK's `X-API-Key` and `Content-Type: application/json` always win. |
| `transport` | `httpx.BaseTransport \| None` | `None` | Optional `httpx` transport override (e.g. `httpx.MockTransport`) sharing the one connection pool. Useful for testing. |

The client also exposes a few non-resource members:

| Member | Signature | Description |
| --- | --- | --- |
| `auth` | `auth() -> AuthValidateResponse` | `POST /api/auth/validate` — validate the configured API key. |
| `request` | `request(method, path, *, query=None, body=None) -> Any` | Raw escape hatch; `path` begins with `/`. |
| `close` | `close() -> None` | Close the underlying `httpx.Client`. |

### Resources & Methods

Resources are accessed as properties on the client (e.g. `client.messages`). All methods are **snake_case**; `body`/`query` arguments are plain dicts. Methods marked **OPERATOR** require an `OPERATOR`-level API key.

#### `client.sessions`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list() -> list[SessionResponse]` | List all sessions. |
| `get` | `get(session_id) -> SessionResponse` | Get one session. |
| `create` | `create(body) -> SessionResponse` | Create a session (`body["name"]` required). |
| `delete` | `delete(session_id) -> None` | Delete a session. |
| `start` | `start(session_id) -> SessionResponse` | Start (connect) a session. |
| `stop` | `stop(session_id) -> SessionResponse` | Stop a session. |
| `force_kill` | `force_kill(session_id) -> SessionResponse` | Force-terminate a session. |
| `get_qr_code` | `get_qr_code(session_id) -> QrCodeResponse` | Fetch the login QR code. |
| `request_pairing_code` | `request_pairing_code(session_id, body) -> PairingCodeResponse` | Request a phone-number pairing code. |
| `stats` | `stats() -> SessionStatsOverview` | Session statistics overview. |

#### `client.messages`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id, query=None) -> MessageListResponse` | List stored messages. |
| `send_text` | `send_text(session_id, body) -> MessageResponse` | Send a text message. |
| `send_image` | `send_image(session_id, body) -> MessageResponse` | Send an image. |
| `send_video` | `send_video(session_id, body) -> MessageResponse` | Send a video. |
| `send_audio` | `send_audio(session_id, body) -> MessageResponse` | Send audio. |
| `send_document` | `send_document(session_id, body) -> MessageResponse` | Send a document. |
| `send_sticker` | `send_sticker(session_id, body) -> MessageResponse` | Send a sticker. |
| `send_location` | `send_location(session_id, body) -> MessageResponse` | Send a location. |
| `send_contact` | `send_contact(session_id, body) -> MessageResponse` | Send a contact card. |
| `send_template` | `send_template(session_id, body) -> MessageResponse` | Send a stored template. |
| `reply` | `reply(session_id, body) -> MessageResponse` | Reply to a message. |
| `forward` | `forward(session_id, body) -> MessageResponse` | Forward a message. |
| `react` | `react(session_id, body) -> SuccessResult` | React to a message. |
| `delete` | `delete(session_id, body) -> SuccessResult` | Delete a message. |
| `history` | `history(session_id, chat_id, query=None) -> list[ChatHistoryMessage]` | Fetch chat history. |
| `reactions` | `reactions(session_id, chat_id, message_id) -> list[ReactionRecord]` | List reactions on a message. |
| `send_bulk` | `send_bulk(session_id, body) -> BulkMessageResponse` | Enqueue a bulk send batch. |
| `batch_status` | `batch_status(session_id, batch_id) -> BatchStatusResponse` | Get bulk batch status. |
| `cancel_batch` | `cancel_batch(session_id, batch_id) -> BatchStatusResponse` | Cancel a running batch. **OPERATOR** |

#### `client.contacts`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id, query=None) -> list[ContactRecord]` | List contacts (`query`: `limit`, `offset`). |
| `get` | `get(session_id, contact_id) -> ContactRecord` | Get one contact. |
| `check` | `check(session_id, number) -> CheckNumberResponse` | Check whether a number is on WhatsApp. |
| `profile_picture` | `profile_picture(session_id, contact_id) -> ProfilePictureResponse` | Get a contact's profile picture. |
| `phone` | `phone(session_id, contact_id) -> ContactPhoneResponse` | Resolve a contact's phone number. |
| `block` | `block(session_id, contact_id) -> SuccessResult` | Block a contact. **OPERATOR** |
| `unblock` | `unblock(session_id, contact_id) -> SuccessResult` | Unblock a contact. **OPERATOR** |

#### `client.groups`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id, query=None) -> list[GroupSummary]` | List groups (`query`: `limit`, `offset`). |
| `get` | `get(session_id, group_id) -> GroupInfo` | Get group details. |
| `create` | `create(session_id, body) -> GroupInfo` | Create a group. **OPERATOR** |
| `add_participants` | `add_participants(session_id, group_id, participants) -> SuccessResult` | Add participants (`list[str]`). **OPERATOR** |
| `remove_participants` | `remove_participants(session_id, group_id, participants) -> SuccessResult` | Remove participants. **OPERATOR** |
| `promote_participants` | `promote_participants(session_id, group_id, participants) -> SuccessResult` | Promote to admin. **OPERATOR** |
| `demote_participants` | `demote_participants(session_id, group_id, participants) -> SuccessResult` | Demote from admin. **OPERATOR** |
| `set_subject` | `set_subject(session_id, group_id, subject) -> SuccessResult` | Set group subject. **OPERATOR** |
| `set_description` | `set_description(session_id, group_id, description) -> SuccessResult` | Set group description. **OPERATOR** |
| `leave` | `leave(session_id, group_id) -> SuccessResult` | Leave the group. **OPERATOR** |
| `invite_code` | `invite_code(session_id, group_id) -> InviteCodeResponse` | Get the invite code. |
| `revoke_invite_code` | `revoke_invite_code(session_id, group_id) -> InviteCodeResponse` | Revoke and regenerate the invite code. **OPERATOR** |

#### `client.chats`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id, query=None) -> list[ChatSummary]` | List chats (`query`: `limit`, `offset`). |
| `mark_read` | `mark_read(session_id, body) -> SuccessResult` | Mark a chat as read. **OPERATOR** |
| `mark_unread` | `mark_unread(session_id, body) -> SuccessResult` | Mark a chat as unread. **OPERATOR** |
| `delete` | `delete(session_id, body) -> SuccessResult` | Delete a chat. **OPERATOR** |
| `send_state` | `send_state(session_id, body) -> SuccessResult` | Send a typing/recording chat state. **OPERATOR** |

#### `client.webhooks`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id) -> list[WebhookResponse]` | List webhooks. |
| `get` | `get(session_id, webhook_id) -> WebhookResponse` | Get one webhook. |
| `create` | `create(session_id, body) -> WebhookResponse` | Create a webhook. **OPERATOR** |
| `update` | `update(session_id, webhook_id, body) -> WebhookResponse` | Update a webhook. **OPERATOR** |
| `delete` | `delete(session_id, webhook_id) -> None` | Delete a webhook. **OPERATOR** |
| `test` | `test(session_id, webhook_id) -> WebhookTestResult` | Send a test delivery. **OPERATOR** |

#### `client.labels` *(WhatsApp Business)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id) -> list[LabelRecord]` | List labels. |
| `get` | `get(session_id, label_id) -> LabelRecord` | Get one label. |
| `for_chat` | `for_chat(session_id, chat_id) -> list[LabelRecord]` | Labels applied to a chat. |
| `add_to_chat` | `add_to_chat(session_id, chat_id, body) -> SuccessResult` | Add a label to a chat. **OPERATOR** |
| `remove_from_chat` | `remove_from_chat(session_id, chat_id, label_id) -> SuccessResult` | Remove a label from a chat. **OPERATOR** |

#### `client.channels` *(Newsletters)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id) -> list[ChannelRecord]` | List subscribed channels. |
| `get` | `get(session_id, channel_id) -> ChannelRecord` | Get one channel. |
| `messages` | `messages(session_id, channel_id, query=None) -> list[MessageRecord]` | List channel messages. |
| `subscribe` | `subscribe(session_id, body) -> ChannelRecord` | Subscribe via invite code. **OPERATOR** |
| `unsubscribe` | `unsubscribe(session_id, channel_id) -> SuccessResult` | Unsubscribe from a channel. **OPERATOR** |

#### `client.catalog` *(WhatsApp Business)*

| Method | Signature | Description |
| --- | --- | --- |
| `info` | `info(session_id) -> CatalogInfo` | Get catalog info. |
| `products` | `products(session_id, query=None) -> PaginatedProducts` | List products (paginated). |
| `product` | `product(session_id, product_id) -> CatalogProduct` | Get one product. |
| `send_product` | `send_product(session_id, body) -> MessageResponse` | Send a product message. **OPERATOR** |
| `send_catalog` | `send_catalog(session_id, body) -> MessageResponse` | Send a catalog link message. **OPERATOR** |

#### `client.status` *(Stories)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id) -> dict[str, list[StatusRecord]]` | List all status updates. |
| `from_contact` | `from_contact(session_id, contact_id) -> dict[str, list[StatusRecord]]` | Status updates from one contact. |
| `send_text` | `send_text(session_id, body) -> StatusRecord` | Post a text status. **OPERATOR** |
| `send_image` | `send_image(session_id, body) -> StatusRecord` | Post an image status. **OPERATOR** |
| `send_video` | `send_video(session_id, body) -> StatusRecord` | Post a video status. **OPERATOR** |
| `delete` | `delete(session_id, status_id) -> None` | Delete a status. **OPERATOR** |

#### `client.templates`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(session_id) -> list[TemplateRecord]` | List templates. |
| `get` | `get(session_id, template_id) -> TemplateRecord` | Get one template. |
| `create` | `create(session_id, body) -> TemplateRecord` | Create a template. **OPERATOR** |
| `update` | `update(session_id, template_id, body) -> TemplateRecord` | Update a template. **OPERATOR** |
| `delete` | `delete(session_id, template_id) -> None` | Delete a template. **OPERATOR** |

#### `client.health`

| Method | Signature | Description |
| --- | --- | --- |
| `check` | `check() -> HealthResponse` | Aggregate health check. |
| `live` | `live() -> dict[str, str]` | Liveness probe. |
| `ready` | `ready() -> HealthReadyResponse` | Readiness probe. |

### Error Handling

Every error inherits from `OpenWAError`. A non-2xx response raises an `OpenWAApiError` (or a more specific subclass picked by status); a timeout raises `OpenWATimeoutError`. The API-error classes carry `.status` (HTTP code), `.body` (parsed JSON or raw text), and `.error_kind` (the NestJS `error` field).

| Exception | Trigger |
| --- | --- |
| `OpenWAAuthError` | HTTP `401` — missing or invalid API key |
| `OpenWAForbiddenError` | HTTP `403` — insufficient role |
| `OpenWANotFoundError` | HTTP `404` — resource not found |
| `OpenWAConflictError` | HTTP `409` — typically engine-not-ready |
| `OpenWARateLimitError` | HTTP `429` — too many requests |
| `OpenWANotImplementedError` | HTTP `501` — active engine doesn't support the operation |
| `OpenWAApiError` | any other non-2xx status (incl. unfollowed `3xx`) |
| `OpenWATimeoutError` | request exceeded `timeout` (has a `.timeout` attribute) |

```python
from openwa import (
    OpenWAClient,
    OpenWAConflictError,
    OpenWANotFoundError,
    OpenWARateLimitError,
    OpenWATimeoutError,
    OpenWAApiError,
)

client = OpenWAClient(base_url="http://localhost:2785", api_key="owa_k1_…")

try:
    client.messages.send_text("my-session", {
        "chatId": "628123456789@c.us",
        "text": "Hi!",
    })
except OpenWAConflictError:
    print("Session engine not ready yet — start it first.")
except OpenWANotFoundError:
    print("Session does not exist.")
except OpenWARateLimitError:
    print("Rate limited — back off and retry.")
except OpenWATimeoutError as e:
    print(f"Timed out after {e.timeout}s")
except OpenWAApiError as e:
    print(f"API error {e.status} ({e.error_kind}): {e.body}")
```

### Notable Behaviors

- **Redirects are never followed.** `follow_redirects` is forced off so the `X-API-Key` header is never re-sent to a redirect target. An unfollowed `3xx` therefore surfaces as an `OpenWAApiError` rather than a success.
- **Auth/JSON headers always win.** `default_headers` are applied first; the SDK then sets `Content-Type: application/json` and `X-API-Key`, so caller headers can never clobber them.
- **Path segments are percent-encoded.** Each path value (session/chat/message id, etc.) is encoded so a `/`, `#`, or `?` can't break out of its position; already-safe id characters `@`, `:`, `+` are left readable. Boolean query params are serialized lowercase (`true`/`false`); `None` query values are dropped.
- **Base-URL path prefix is preserved.** A trailing `/` is stripped from `base_url`, but any path prefix (e.g. when running behind a reverse proxy) is kept on every request.
- **No automatic retries.** Each call issues exactly one request; retry/backoff is the caller's responsibility. Wrap or inject a custom `transport` for retry or observability middleware.
- **Testable transport injection.** Pass `transport=httpx.MockTransport(handler)` to intercept requests in tests — no global monkey-patching.
- **204 / non-JSON handling.** A `204` (or empty body) returns `None`; a 2xx body that isn't valid JSON is returned as raw text instead of raising.
- **PEP 561 typed.** The package ships `py.typed`, so type-checkers consume the bundled hints directly.

## 18.4 PHP SDK

The PHP SDK is a hand-written, synchronous client built on Guzzle 7. It mirrors the full user-facing API surface: every resource method maps to one REST endpoint, request/response payloads are plain associative arrays, and non-2xx responses are translated into a typed `OpenWA*Exception` hierarchy.

### Installation

```bash
composer require rmyndharis/openwa
```

Requirements:

- **PHP 8.1+** (`declare(strict_types=1)` throughout; typed properties, `match`).
- **Guzzle 7** (`guzzlehttp/guzzle: ^7.9`).
- PSR-4 autoloaded under the `OpenWA\` namespace (`"OpenWA\\": "src/"`).

### Quick Start

```php
<?php
require 'vendor/autoload.php';

use OpenWA\Client;

$client = new Client([
    'baseUrl' => 'http://localhost:2785',
    'apiKey'  => 'owa_k1_…',
]);

$client->sessions->start('my-session');

$result = $client->messages->sendText('my-session', [
    'chatId' => '628123456789@c.us',
    'text'   => 'Hello from the OpenWA PHP SDK!',
]);

echo $result['messageId'];
```

The entry class is `OpenWA\Client`. It validates that `baseUrl` and `apiKey` are present (throwing `OpenWAException` otherwise), constructs the shared HTTP transport, and exposes each resource as a public property: `$client->sessions`, `$client->messages`, `$client->contacts`, `$client->groups`, `$client->webhooks`, `$client->chats`, `$client->status`, `$client->health`, `$client->labels`, `$client->channels`, `$client->catalog`, `$client->templates`.

Two escape hatches sit on the client itself:

| Method | Signature | Description |
| --- | --- | --- |
| `auth` | `auth(): array` | `POST /api/auth/validate` — validate the configured key and resolve its role. |
| `request` | `request(string $method, string $path, array $query = [], mixed $body = null): mixed` | Raw request against any path (advanced use); returns decoded JSON or `null` for empty/204. |

### Client Configuration

The constructor takes a single associative `$config` array:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `baseUrl` | `string` | — (**required**) | API base URL, e.g. `http://localhost:2785`. A trailing `/` is stripped; any path prefix (e.g. `/v1` behind a proxy) is preserved. |
| `apiKey` | `string` | — (**required**) | Sent as the `X-API-Key` header on every request. |
| `timeout` | `float` | `30.0` | Per-request timeout in seconds. |
| `httpClient` | `?\GuzzleHttp\ClientInterface` | `null` | Inject a Guzzle client (e.g. one built on a `MockHandler`) for testing or middleware. When `null`, a default Guzzle client is created with the configured timeout. |
| `defaultHeaders` | `array<string,string>` | `[]` | Extra headers applied on every request, **under** the SDK's auth/JSON headers (which always win). |

Missing `baseUrl` or `apiKey` throws `OpenWA\Exceptions\OpenWAException` from the constructor.

### Resources & Methods

All payloads are associative arrays; all listed methods are synchronous and return the decoded JSON (an `array`), except the `void` deletes. Methods marked **OPERATOR** require an operator-level API key.

#### `sessions`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(): array` | List all sessions. |
| `get` | `get(string $id): array` | Get one session. |
| `create` | `create(array $body): array` | Create a session (`$body['name']` required). |
| `delete` | `delete(string $id): void` | Delete a session. |
| `start` | `start(string $id): array` | Start a session. |
| `stop` | `stop(string $id): array` | Stop a session. |
| `forceKill` | `forceKill(string $id): array` | Force-kill a session. |
| `getQrCode` | `getQrCode(string $id): array` | Fetch the current QR code. |
| `requestPairingCode` | `requestPairingCode(string $id, array $body): array` | Request a phone-pairing code. |
| `stats` | `stats(): array` | `GET /api/sessions/stats/overview`. |

#### `messages`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId, array $query = []): array` | List stored messages. |
| `sendText` | `sendText(string $sessionId, array $body): array` | Send a text message (`send-text`). |
| `sendImage` | `sendImage(string $sessionId, array $body): array` | Send an image. |
| `sendVideo` | `sendVideo(string $sessionId, array $body): array` | Send a video. |
| `sendAudio` | `sendAudio(string $sessionId, array $body): array` | Send audio. |
| `sendDocument` | `sendDocument(string $sessionId, array $body): array` | Send a document. |
| `sendSticker` | `sendSticker(string $sessionId, array $body): array` | Send a sticker. |
| `sendLocation` | `sendLocation(string $sessionId, array $body): array` | Send a location. |
| `sendContact` | `sendContact(string $sessionId, array $body): array` | Send a contact card. |
| `sendTemplate` | `sendTemplate(string $sessionId, array $body): array` | Send a stored template. |
| `reply` | `reply(string $sessionId, array $body): array` | Reply to a message. |
| `forward` | `forward(string $sessionId, array $body): array` | Forward a message. |
| `react` | `react(string $sessionId, array $body): array` | React to a message. |
| `delete` | `delete(string $sessionId, array $body): array` | Delete a message. |
| `history` | `history(string $sessionId, string $chatId, array $query = []): array` | Fetch chat history. |
| `reactions` | `reactions(string $sessionId, string $chatId, string $messageId): array` | List reactions on a message. |
| `sendBulk` | `sendBulk(string $sessionId, array $body): array` | Enqueue a bulk send batch. |
| `batchStatus` | `batchStatus(string $sessionId, string $batchId): array` | Get bulk batch status. |
| `cancelBatch` | `cancelBatch(string $sessionId, string $batchId): array` | Cancel a bulk batch. **OPERATOR** |

#### `contacts`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId, array $query = []): array` | List contacts. |
| `get` | `get(string $sessionId, string $contactId): array` | Get one contact. |
| `check` | `check(string $sessionId, string $number): array` | Check whether a number is on WhatsApp. |
| `profilePicture` | `profilePicture(string $sessionId, string $contactId): array` | Get a contact's profile picture. |
| `phone` | `phone(string $sessionId, string $contactId): array` | Resolve a contact's phone number. |
| `block` | `block(string $sessionId, string $contactId): array` | Block a contact. **OPERATOR** |
| `unblock` | `unblock(string $sessionId, string $contactId): array` | Unblock a contact. **OPERATOR** |

#### `groups`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId, array $query = []): array` | List groups. |
| `get` | `get(string $sessionId, string $groupId): array` | Get one group. |
| `create` | `create(string $sessionId, array $body): array` | Create a group. **OPERATOR** |
| `addParticipants` | `addParticipants(string $sessionId, string $groupId, array $participants): array` | Add participants. **OPERATOR** |
| `removeParticipants` | `removeParticipants(string $sessionId, string $groupId, array $participants): array` | Remove participants. **OPERATOR** |
| `promoteParticipants` | `promoteParticipants(string $sessionId, string $groupId, array $participants): array` | Promote to admin. **OPERATOR** |
| `demoteParticipants` | `demoteParticipants(string $sessionId, string $groupId, array $participants): array` | Demote admins. **OPERATOR** |
| `setSubject` | `setSubject(string $sessionId, string $groupId, string $subject): array` | Update the group subject. **OPERATOR** |
| `setDescription` | `setDescription(string $sessionId, string $groupId, string $description): array` | Update the group description. **OPERATOR** |
| `leave` | `leave(string $sessionId, string $groupId): array` | Leave the group. **OPERATOR** |
| `inviteCode` | `inviteCode(string $sessionId, string $groupId): array` | Get the invite code. |
| `revokeInviteCode` | `revokeInviteCode(string $sessionId, string $groupId): array` | Revoke and regenerate the invite code. **OPERATOR** |

#### `chats`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId, array $query = []): array` | List chats. |
| `markRead` | `markRead(string $sessionId, array $body): array` | Mark chat(s) read. **OPERATOR** |
| `markUnread` | `markUnread(string $sessionId, array $body): array` | Mark chat(s) unread. **OPERATOR** |
| `delete` | `delete(string $sessionId, array $body): array` | Delete chat(s). **OPERATOR** |
| `sendState` | `sendState(string $sessionId, array $body): array` | Send a typing/recording state. **OPERATOR** |

#### `webhooks`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId): array` | List webhooks. |
| `get` | `get(string $sessionId, string $id): array` | Get one webhook. |
| `create` | `create(string $sessionId, array $body): array` | Create a webhook. **OPERATOR** |
| `update` | `update(string $sessionId, string $id, array $body): array` | Update a webhook. **OPERATOR** |
| `delete` | `delete(string $sessionId, string $id): void` | Delete a webhook. **OPERATOR** |
| `test` | `test(string $sessionId, string $id): array` | Send a test event. **OPERATOR** |

#### `labels` *(WhatsApp Business)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId): array` | List labels. |
| `get` | `get(string $sessionId, string $labelId): array` | Get one label. |
| `forChat` | `forChat(string $sessionId, string $chatId): array` | List labels applied to a chat. |
| `addToChat` | `addToChat(string $sessionId, string $chatId, array $body): array` | Add a label to a chat (`$body` needs `labelId`). **OPERATOR** |
| `removeFromChat` | `removeFromChat(string $sessionId, string $chatId, string $labelId): array` | Remove a label from a chat. **OPERATOR** |

#### `channels` *(Newsletters)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId): array` | List channels. |
| `get` | `get(string $sessionId, string $channelId): array` | Get one channel. |
| `messages` | `messages(string $sessionId, string $channelId, array $query = []): array` | Recent channel messages. |
| `subscribe` | `subscribe(string $sessionId, array $body): array` | Subscribe via invite code (`$body` needs `inviteCode`). **OPERATOR** |
| `unsubscribe` | `unsubscribe(string $sessionId, string $channelId): array` | Unsubscribe from a channel. **OPERATOR** |

#### `catalog` *(WhatsApp Business)*

| Method | Signature | Description |
| --- | --- | --- |
| `info` | `info(string $sessionId): array` | Get catalog info. |
| `products` | `products(string $sessionId, array $query = []): array` | List products (e.g. `['page' => 1, 'limit' => 20]`). |
| `product` | `product(string $sessionId, string $productId): array` | Get one product. |
| `sendProduct` | `sendProduct(string $sessionId, array $body): array` | Send a product message (`chatId` + `productId`). **OPERATOR** |
| `sendCatalog` | `sendCatalog(string $sessionId, array $body): array` | Send a catalog link (`chatId`). **OPERATOR** |

#### `status` *(Stories)*

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId): array` | List status updates. |
| `fromContact` | `fromContact(string $sessionId, string $contactId): array` | Status updates from one contact. |
| `sendText` | `sendText(string $sessionId, array $body): array` | Post a text status. **OPERATOR** |
| `sendImage` | `sendImage(string $sessionId, array $body): array` | Post an image status. **OPERATOR** |
| `sendVideo` | `sendVideo(string $sessionId, array $body): array` | Post a video status. **OPERATOR** |
| `delete` | `delete(string $sessionId, string $statusId): void` | Delete a status. **OPERATOR** |

#### `templates`

| Method | Signature | Description |
| --- | --- | --- |
| `list` | `list(string $sessionId): array` | List templates. |
| `get` | `get(string $sessionId, string $templateId): array` | Get one template. |
| `create` | `create(string $sessionId, array $body): array` | Create a template (`$body` needs `name` and `body`; `header`/`footer` optional). **OPERATOR** |
| `update` | `update(string $sessionId, string $templateId, array $body): array` | Update a template. **OPERATOR** |
| `delete` | `delete(string $sessionId, string $templateId): void` | Delete a template. **OPERATOR** |

#### `health`

| Method | Signature | Description |
| --- | --- | --- |
| `check` | `check(): array` | `GET /api/health`. |
| `live` | `live(): array` | Liveness probe. |
| `ready` | `ready(): array` | Readiness probe. |

### Error Handling

All exceptions live in `OpenWA\Exceptions` and descend from `OpenWAException` (which extends PHP's `\Exception`). Any non-2xx response is raised as an `OpenWAApiException`; the static `classify()` factory picks the most specific subclass by status code. An `OpenWAApiException` carries the HTTP status (`getStatus(): int`), the parsed error body (`getBody(): mixed`), and the NestJS `error` kind when present (`getErrorKind(): ?string`).

| Exception | Extends | Trigger |
| --- | --- | --- |
| `OpenWAException` | `\Exception` | Base for all SDK errors (also thrown for missing `baseUrl`/`apiKey`). |
| `OpenWAApiException` | `OpenWAException` | Any non-2xx (including unfollowed 3xx and other 4xx/5xx). |
| `OpenWAAuthException` | `OpenWAApiException` | `401` — missing/invalid API key. |
| `OpenWAForbiddenException` | `OpenWAApiException` | `403` — insufficient role (e.g. operator-only endpoint). |
| `OpenWANotFoundException` | `OpenWAApiException` | `404` — resource not found. |
| `OpenWAConflictException` | `OpenWAApiException` | `409` — conflict (e.g. engine not ready). |
| `OpenWARateLimitException` | `OpenWAApiException` | `429` — rate limited. |
| `OpenWANotImplementedException` | `OpenWAApiException` | `501` — active engine does not support the operation. |
| `OpenWATimeoutException` | `OpenWAException` | Request exceeded the timeout (`getTimeout(): float`). Not an API error — has no status/body. |

```php
<?php
use OpenWA\Client;
use OpenWA\Exceptions\OpenWAConflictException;
use OpenWA\Exceptions\OpenWARateLimitException;
use OpenWA\Exceptions\OpenWATimeoutException;
use OpenWA\Exceptions\OpenWAApiException;

try {
    $result = $client->messages->sendText('my-session', [
        'chatId' => '628123456789@c.us',
        'text'   => 'Hello!',
    ]);
} catch (OpenWAConflictException $e) {
    // 409 — engine not ready yet
} catch (OpenWARateLimitException $e) {
    // 429 — back off and retry yourself (no auto-retry)
} catch (OpenWATimeoutException $e) {
    fwrite(STDERR, "timed out after {$e->getTimeout()}s\n");
} catch (OpenWAApiException $e) {
    // any other non-2xx
    fwrite(STDERR, "API {$e->getStatus()}: {$e->getMessage()}\n");
    var_dump($e->getBody());
}
```

### Notable Behaviors

- **Redirects are never followed.** Guzzle is configured with `allow_redirects => false`, so a `3xx` surfaces as an `OpenWAApiException` rather than being followed — the `X-API-Key` header is never re-sent to a redirect target.
- **Auth/JSON headers take precedence.** `defaultHeaders` are merged in first, then `X-API-Key`, `Content-Type: application/json`, and `Accept: application/json` are applied on top, so they can't be clobbered.
- **Path segments are percent-encoded.** Ids (chat/message/group ids, session names) pass through `encodeSegment()`, which `rawurlencode`s the value but keeps the WhatsApp-id-safe characters `@`, `:`, and `+` readable — so a value containing `/`, `#`, or `?` cannot break out of its path position.
- **Base-URL path prefix is preserved.** The base URL has its trailing `/` trimmed and requests are issued against an absolute `baseUrl . $path`; Guzzle's `base_uri` is intentionally unset, so a prefix like `/v1` behind a reverse proxy is retained.
- **Null query values are dropped.** Absent optional query parameters (`null`) are filtered out before the request, so they are never sent.
- **No automatic retries.** A failed request throws immediately; wrap calls in your own backoff if you need retries (notably for `429`). The injectable `httpClient` is the extension point for retry/observability middleware.
- **Empty/204 responses return `null`.** A `204` or empty body decodes to `null`; resource methods that promise an `array` coalesce this to `[]` (or to the resource object for single-item gets).
- **Testing without the network.** Inject a Guzzle client built on a `GuzzleHttp\Handler\MockHandler` via the `httpClient` config key — no global state, no live calls. The shipped test suite asserts on the exact path, method, and body.
- **PSR-4 autoloading.** Everything lives under the `OpenWA\` namespace mapped to `src/`; `composer require rmyndharis/openwa` wires up the autoloader.

## 18.5 n8n Community Node

OpenWA's n8n integration is **not** part of these SDK packages. It is a separate community node maintained in its own repository, which speaks the same REST + webhook contract documented in [API Specification](./06-api-specification.md):

- An **action/HTTP** path that calls the REST endpoints (e.g. `POST /api/sessions/:id/messages/send-text`) with the `X-API-Key` header.
- A **trigger** path that registers a webhook (the `webhooks` resource) and receives inbound events, verifying the `X-OpenWA-Signature` HMAC.

For installation and node-by-node configuration, see the dedicated [n8n Integration guide](./22-n8n-integration.md). Because the node consumes the public API contract, the verified route/event reference in docs 06 and §6.6 (Webhook Events) is the authority for what it can call and receive.

## 18.6 SDK Versioning & Releases

### Versioning

The three SDKs are versioned **independently of the gateway** and of each other, each following SemVer. They are currently published at `0.1.0` while the gateway is at `0.7.3`; an SDK version does **not** track the gateway version. Pin the SDK version your code is tested against and treat a major SDK bump as potentially breaking.

| SDK | Registry | Package |
| --- | --- | --- |
| JavaScript/TypeScript | npm | `@rmyndharis/openwa` |
| Python | PyPI | `rmyndharis-openwa` |
| PHP | Packagist | `rmyndharis/openwa` |

### Contract-drift protection

The wire types live in a dedicated module (`types.ts` / `types.py`) so they can later be regenerated by an OpenAPI codegen pass without touching the hand-written resource methods. Until then, each SDK's test suite mocks the HTTP transport and **asserts on the exact request path, method, and body** — so a drift between an SDK method and the real API (the class of bug that once shipped `messages/text` instead of the real `messages/send-text`) breaks a test rather than reaching users.

### Release process

```bash
# JavaScript
cd sdk/javascript && npm test && npm run build && npm run smoke   # smoke = require()+import() packaging check
# Python
cd sdk/python && python -m pytest -q
# PHP
cd sdk/php && composer install && ./vendor/bin/phpunit
```

CI runs all three suites (path-filtered to `sdk/**`). The PHP package is mirrored to its own Packagist repository via a `git subtree split`, and that mirror publish is gated on the PHP tests passing, so a broken SDK cannot auto-publish. Bump the version, update the SDK's CHANGELOG, run the suite above, then tag/publish to the relevant registry.

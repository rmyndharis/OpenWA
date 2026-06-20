# Chat History Limits

OpenWA has two different history paths, and they answer different questions.

## Local Message History

```http
GET /api/sessions/{sessionId}/messages
```

This endpoint reads from OpenWA's local database. It returns messages that OpenWA has observed and persisted while the session was connected.

Use this when you want stable pagination over messages already stored by OpenWA.

## Live WhatsApp Chat History

```http
GET /api/sessions/{sessionId}/messages/{chatId}/history?limit=50
```

This endpoint asks the active WhatsApp engine for recent messages in a chat. It bypasses OpenWA's local database and can be useful for retrieving messages that are visible to the linked WhatsApp Web session but were not yet stored locally.

The endpoint is intentionally bounded:

- `limit` defaults to `50`.
- `limit` is clamped to the range `1`–`100` (or `1`–`2000` with `deep=true`, see below).
- Values such as `limit=999` do not request unbounded history; they are reduced to the maximum allowed limit.
- `includeMedia=true` downloads media data and is slower than metadata-only history.
- `deep=true` raises the ceiling to `2000` for reaching further back, and forces metadata-only.

## How Deep It Can Reach

By default the live history endpoint returns at most the **100 most recent** messages per request (the
`limit` clamp above). The `whatsapp-web.js` engine *can* load older messages on demand — internally it
drives WhatsApp Web's "load earlier messages" mechanism — so reaching further back is bounded by
**OpenWA's cap**, not by what WhatsApp Web is willing to expose.

To go back weeks or months, set `deep=true`. This raises the ceiling to **2000** messages per request:

```http
GET /api/sessions/{sessionId}/messages/{chatId}/history?limit=2000&deep=true
```

Deep mode is **metadata-only** — `includeMedia` is ignored, because downloading base64 media for up to
2000 messages would produce an enormous, slow response. Fetch media separately for the specific messages
you need. Note that a very large, rapid history pull is heavier on the linked session and can increase the
risk of WhatsApp rate-limiting; use the smallest window that meets your need.

Deep mode applies to the `whatsapp-web.js` engine. The Baileys engine does not expose on-demand history
(it has no message-history sync), so the history endpoint returns `501 Not Implemented` there regardless
of `deep`; consume Baileys history through local storage / webhooks / WebSocket as it arrives instead.

There is still an ultimate ceiling: once WhatsApp's servers stop returning older messages for the linked
session, no further history is retrievable through the web engine, regardless of `limit`. So the endpoint
does not guarantee a complete import of all server-side WhatsApp history.

## Recommended Usage

For reliable long-term history, keep the OpenWA session connected and consume messages as they arrive through local storage, webhooks, or WebSocket events.

Use the live history endpoint as a bounded recent-history helper, not as a full historical import mechanism.

## Example

```bash
curl -H "X-API-Key: $API_KEY" \
  "http://localhost:2785/api/sessions/default/messages/628123456789@c.us/history?limit=100"
```

Use `limit=100` when you want the maximum single-request live history window currently allowed by OpenWA.

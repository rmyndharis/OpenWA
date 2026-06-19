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
- `limit` is clamped to the range `1`–`100`.
- Values such as `limit=999` do not request unbounded history; they are reduced to the maximum allowed limit.
- `includeMedia=true` downloads media data and is slower than metadata-only history.

## How Deep It Can Reach

The live history endpoint returns at most the **100 most recent** messages per request (the `limit` clamp
above). The `whatsapp-web.js` engine *can* load older messages on demand — internally it drives WhatsApp
Web's "load earlier messages" mechanism — so reaching further back is bounded by **OpenWA's current cap**,
not by what WhatsApp Web is willing to expose. To go back weeks or months you would need a much larger
window than 100; a deeper-history mode is tracked in [#347](https://github.com/rmyndharis/OpenWA/issues/347).

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

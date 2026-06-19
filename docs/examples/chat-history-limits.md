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

## What It Does Not Guarantee

The live history endpoint does not guarantee a complete import of all server-side WhatsApp history.

For the `whatsapp-web.js` engine, available history is limited by what WhatsApp Web exposes to the browser session. If WhatsApp Web itself requires manual loading of older messages from the phone, OpenWA cannot assume that the entire account history is already available through a single history request.

## Recommended Usage

For reliable long-term history, keep the OpenWA session connected and consume messages as they arrive through local storage, webhooks, or WebSocket events.

Use the live history endpoint as a bounded recent-history helper, not as a full historical import mechanism.

## Example

```bash
curl -H "X-API-Key: $API_KEY" \
  "http://localhost:2785/api/sessions/default/messages/628123456789@c.us/history?limit=100"
```

Use `limit=100` when you want the maximum single-request live history window currently allowed by OpenWA.

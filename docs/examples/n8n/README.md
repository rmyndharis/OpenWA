# n8n Workflow: OpenWA to Discord

This example demonstrates how to receive OpenWA webhooks using n8n and forward incoming WhatsApp messages to a Discord channel using n8n's built-in HTTP Request node. No custom n8n node package is required.

## Prerequisites

1. An n8n instance.
2. A Discord Webhook URL.
3. OpenWA configured and running.

## Setup

1. **Import the Workflow**: Open n8n, click the "Import from file" option, and select the [`workflow.json`](./workflow.json) file.
2. **Set the Discord Webhook URL**: Open the Post to Discord node and replace the placeholder URL with your Discord webhook URL. Paste the URL itself rather than reading it from `$env`: n8n 2.0 and later block `$env` in expressions by default.
3. **Protect the Webhook**: Open the OpenWA Webhook node, set **Authentication** to **Header Auth**, and create a Header Auth credential with **Name** `X-Webhook-Token` and a long random **Value**. Without it, anyone who learns the URL can post into your Discord channel. Header Auth only guards the n8n URL: the message text still comes from any WhatsApp sender, so the workflow sends it with Discord's `allowed_mentions: { "parse": [] }` and a message cannot ping `@everyone`, `@here`, a role, or a user.
4. **Get the Webhook URL**: Publish the workflow (activate it on n8n 1.x) and copy the **Production URL** from the OpenWA Webhook node (e.g., `https://n8n.example.com/webhook/openwa-discord`).
5. **Register in OpenWA**: Register the Production URL for the `message.received` event, with the same header and value:

   ```bash
   curl -X POST https://openwa.example.com/api/sessions/<sessionId>/webhooks \
     -H "X-API-Key: <your API key>" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://n8n.example.com/webhook/openwa-discord",
       "events": ["message.received"],
       "headers": { "X-Webhook-Token": "<the same random value>" }
     }'
   ```

   If n8n is only reachable at a private address (`localhost`, a Docker service name), add its host to `SSRF_ALLOWED_HOSTS` on the OpenWA server, or the registration is refused with `400`. The other webhook options, including a `secret` that signs every delivery, are in the [API Specification](../../06-api-specification.md) and [Webhook Signature Verification](../webhook-signature-verification.md).

### API Key Scope

The API key used to register the webhook in OpenWA needs the **`OPERATOR`** role (or higher, such as `ADMIN`). A `VIEWER` key cannot register webhooks.

### Webhook Payload Expected

This workflow expects the standard OpenWA webhook payload for the `message.received` event.

```json
{
  "event": "message.received",
  "timestamp": "2024-01-15T10:30:00Z",
  "sessionId": "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a",
  "idempotencyKey": "msg_8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a_3EB0F5A2B4C..._f1e2d3c4-b5a6-7890-1234-567890abcdef",
  "deliveryId": "dlv_0f8c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b",
  "data": {
    "id": "3EB0F5A2B4C...",
    "chatId": "628123456789@c.us",
    "from": "628123456789@c.us",
    "body": "Hello!",
    "type": "text",
    "timestamp": 1705312200
  }
}
```

The workflow posts `data.author || data.from` as the sender and `data.body` as the message. In a group, `from` is the group and `author` is the member who sent the message; a direct message has no `author`, so `from` is used. Discord rejects a message over 2000 characters, and n8n has already answered OpenWA by then, so nothing would retry it; the workflow therefore cuts a longer message at 2000 characters.

# 22 - n8n Integration

## Overview

OpenWA provides official n8n community nodes for integrating WhatsApp automation into n8n workflows. This enables users to build powerful automations combining WhatsApp messaging with hundreds of other services available in n8n.

**Repository:** https://github.com/rmyndharis/OpenWA-n8n
**npm Package:** `@rmyndharis/n8n-nodes-openwa`

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   n8n Workflow  │────▶│  OpenWA Node    │────▶│  OpenWA API     │
│                 │     │  (credentials)  │     │  (your server)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   n8n Workflow  │◀────│ OpenWA Trigger  │◀────│  Webhook POST   │
│   (triggered)   │     │  (listens)      │     │  from OpenWA    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Installation

### Via n8n Community Nodes (Recommended)

1. Go to **Settings > Community Nodes**
2. Select **Install**
3. Enter `@rmyndharis/n8n-nodes-openwa`
4. Agree to the risks and install
5. Restart n8n

### Manual Installation

```bash
cd ~/.n8n/nodes
npm install @rmyndharis/n8n-nodes-openwa
```

## Nodes

### OpenWA Node

Execute operations on your OpenWA server.

#### Credentials Setup

| Field      | Description                      | Example                  |
| ---------- | -------------------------------- | ------------------------ |
| Server URL | OpenWA server URL (without /api) | `https://wa.example.com` |
| API Key    | API key from OpenWA dashboard    | `owa_xxxxxxxx...`        |

#### Resources & Operations

| Resource | Operation     | Description                 | Endpoint                                        |
| -------- | ------------- | --------------------------- | ----------------------------------------------- |
| Session  | Get Status    | Get session status          | `GET /api/sessions/:id`                         |
| Session  | List All      | List all sessions           | `GET /api/sessions`                             |
| Message  | Send Text     | Send text message           | `POST /api/sessions/:id/messages/send-text`     |
| Message  | Send Image    | Send image (URL/Base64)     | `POST /api/sessions/:id/messages/send-image`    |
| Message  | Send Document | Send file/document          | `POST /api/sessions/:id/messages/send-document` |
| Message  | Send Location | Send location pin           | `POST /api/sessions/:id/messages/send-location` |
| Contact  | Check Exists  | Check if number on WhatsApp | `GET /api/sessions/:id/contacts/check/:number`  |
| Contact  | Get Info      | Get contact information     | `GET /api/sessions/:id/contacts/:contactId`     |
| Webhook  | Create        | Create a webhook            | `POST /api/sessions/:id/webhooks`               |
| Webhook  | Delete        | Delete a webhook            | `DELETE /api/sessions/:id/webhooks/:webhookId`  |

### OpenWA Trigger Node

Start workflows when WhatsApp events occur.

#### Supported Events

| Event                   | Description                         | Use Case                  |
| ----------------------- | ----------------------------------- | ------------------------- |
| `message.received`      | New incoming message                | Auto-reply, lead capture  |
| `message.sent`          | Message sent successfully           | Delivery confirmation     |
| `message.ack`           | Delivery/read status advanced       | Read receipts             |
| `message.failed`        | Outgoing message failed             | Failure alerting          |
| `message.revoked`       | Message deleted for everyone        | Deletion tracking         |
| `session.status`        | Session status changed              | Lifecycle tracking        |
| `session.qr`            | QR code generated                   | Reconnection alerts       |
| `session.authenticated` | Session logged in (phone available) | Startup notifications     |
| `session.disconnected`  | Session lost connection             | Alert monitoring          |

> **Reserved:** `group.join`, `group.leave`, and `group.update` are accepted by the
> subscription API but are not emitted yet — don't depend on them until a release notes
> them as live.

#### How It Works

1. When workflow is activated, the trigger creates a webhook in OpenWA
2. OpenWA sends events to n8n's webhook URL
3. When workflow is deactivated, the webhook is automatically deleted

#### Output Data Format

```json
{
  "event": "message.received",
  "timestamp": "2024-01-15T10:30:00Z",
  "sessionId": "default",
  "idempotencyKey": "a1b2c3d4e5f6...",
  "deliveryId": "9f8e7d6c5b4a...",
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

> **Deduplication.** Every delivery includes `idempotencyKey` and `deliveryId` in the body **and** as the
> `X-OpenWA-Idempotency-Key` / `X-OpenWA-Delivery-Id` headers. `idempotencyKey` is **stable across retries**
> of the same event, while `deliveryId` is unique per HTTP attempt. Because a webhook can be retried, add a
> dedup step keyed on `idempotencyKey` (e.g. an n8n IF or "Remove Duplicates" node) so a retried delivery
> isn't processed twice.

## Example Workflows

### 1. Auto-Reply Bot

Automatically reply to incoming messages with a welcome message.

```
[OpenWA Trigger] → [IF: Check keyword] → [OpenWA: Send Text]
     │
     └── Events: message.received
```

**Configuration:**

- Trigger: `message.received`
- IF Node: Check if `{{$json.data.body}}` contains "hello"
- OpenWA: Send Text with welcome message

### 2. Lead Collection to Google Sheets

Capture incoming messages and save to Google Sheets.

```
[OpenWA Trigger] → [Google Sheets: Append] → [OpenWA: Send Text]
     │                    │
     │                    └── Save: name, phone, message
     └── Events: message.received
```

### 3. Session Monitoring

Get notified on Slack when WhatsApp session disconnects.

```
[OpenWA Trigger] → [Slack: Send Message]
     │
     └── Events: session.disconnected
```

**Slack Message:**

```
⚠️ WhatsApp session "{{$json.sessionId}}" disconnected!
Time: {{$json.timestamp}}
Please check and reconnect.
```

### 4. Order Notification

Send WhatsApp notification when new order is received.

```
[Webhook: New Order] → [OpenWA: Send Text]
                            │
                            └── "Thank you for your order #{{$json.orderId}}"
```

### 5. Scheduled Reminders

Send daily reminders to a list of contacts.

```
[Schedule Trigger] → [Google Sheets: Get Rows] → [Loop] → [OpenWA: Send Text]
     │                      │                                    │
     └── Daily 9AM          └── Get contacts                     └── Send reminder
```

### 6. Appointment Booking

Collect appointment requests over WhatsApp, check availability in an external scheduling source, and send a confirmation or alternative time slots.

See [n8n Appointment Booking Workflow](./examples/n8n-appointment-booking.md) for a complete example.

```
[OpenWA Trigger] → [IF: Booking intent?] → [Set: Normalize request]
                                               │
                                               ▼
                                      [Availability Source]
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         ▼                                           ▼
              [Create Booking] → [OpenWA: Send Text]      [OpenWA: Send Text]
                  confirmed confirmation                  alternative slots
```

## Best Practices

### 1. Error Handling

Always add error handling in your workflows:

```
[OpenWA Node] → [IF: Check success] → [Continue...]
                      │
                      └── [Error Handler]
```

### 2. Rate Limiting

WhatsApp has rate limits. Add delays between messages:

```
[Loop Over Items] → [Wait: 2 seconds] → [OpenWA: Send Text]
```

### 3. Message Formatting

Use WhatsApp formatting in your messages:

- Bold: `*text*`
- Italic: `_text_`
- Strikethrough: `~text~`
- Monospace: `` `text` ``

### 4. Phone Number Format

Always use the correct format for chat IDs:

- Personal: `628123456789@c.us`
- Group: `123456789-123456789@g.us`

## Troubleshooting

### Credential Test Failed

1. Verify OpenWA server is running
2. Check API key is correct
3. Ensure server URL doesn't have trailing slash
4. Verify network connectivity between n8n and OpenWA

### Trigger Not Receiving Events

1. Check webhook was created in OpenWA dashboard
2. Verify n8n webhook URL is accessible from OpenWA server
3. Check firewall/proxy settings
4. Ensure session is connected and active

### Message Not Sending

1. Verify session status is "READY"
2. Check chat ID format is correct
3. Ensure recipient number exists on WhatsApp
4. Check message content isn't empty

## Development

### Building from Source

```bash
git clone https://github.com/rmyndharis/OpenWA-n8n.git
cd OpenWA-n8n
npm install
npm run build
```

### Local Development

```bash
# Watch mode
npm run dev

# Link to local n8n
cd ~/.n8n/nodes
npm link /path/to/OpenWA-n8n
```

### Testing

Test your changes with a local n8n instance:

```bash
# Start n8n
n8n start

# Or with Docker
docker run -it --rm \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

## Related Documentation

- [OpenWA API Specification](./06-api-specification.md)
- [Webhook System](./03-system-architecture.md#webhooks)
- [n8n Appointment Booking Workflow](./examples/n8n-appointment-booking.md)
- [n8n Documentation](https://docs.n8n.io/)

---

<div align="center">

[← 21 - Glossary](./21-glossary.md) · [Documentation Index](./README.md)

</div>

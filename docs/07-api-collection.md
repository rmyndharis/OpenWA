# 07 - API Collection

## 07.1 Overview

This document provides a complete collection of OpenWA API endpoints with request/response examples for each endpoint. It can be used as a quick reference or imported into tools such as Postman, Insomnia, or Bruno.

### Base URL

```
Development: http://localhost:2785
Production:  https://api.your-domain.com
```

### Authentication

All endpoints (except `/health`) require an API Key:

```http
X-API-Key: your-api-key-here
```

### Response Format

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2026-02-02T10:30:00Z",
    "requestId": "req_abc123"
  }
}
```

### Error Format

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid phone number format",
    "details": {
      "field": "phone",
      "expected": "format: 628xxx@c.us"
    }
  },
  "meta": {
    "timestamp": "2026-02-02T10:30:00Z",
    "requestId": "req_abc123"
  }
}
```

## 07.2 Health & System

### GET /health

Basic health check.

```bash
curl http://localhost:2785/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-02T10:30:00Z"
}
```

### GET /health/detailed

Detailed health check with system status.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/health/detailed
```

**Response:**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 86400,
  "timestamp": "2026-02-02T10:30:00Z",
  "checks": {
    "database": "ok",
    "redis": "ok",
    "sessions": {
      "total": 5,
      "connected": 4,
      "disconnected": 1
    }
  }
}
```

### GET /api/metrics

System metrics (Prometheus format).

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/metrics
```

**Response:**
```
# HELP openwa_sessions_total Total number of sessions
# TYPE openwa_sessions_total gauge
openwa_sessions_total{status="connected"} 4
openwa_sessions_total{status="disconnected"} 1

# HELP openwa_messages_total Total messages processed
# TYPE openwa_messages_total counter
openwa_messages_total{direction="incoming"} 15234
openwa_messages_total{direction="outgoing"} 8567

# HELP openwa_api_requests_total Total API requests
# TYPE openwa_api_requests_total counter
openwa_api_requests_total{method="GET",status="200"} 45678
openwa_api_requests_total{method="POST",status="200"} 12345
```

## 07.3 Sessions API

### GET /api/sessions

List all sessions.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| status | string | Filter by status: `CONNECTED`, `DISCONNECTED`, `INITIALIZING` |
| limit | number | Max results (default: 20) |
| offset | number | Pagination offset |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "default",
      "name": "Default Session",
      "status": "CONNECTED",
      "phoneNumber": "628123456789",
      "profileName": "John Doe",
      "profilePicture": "https://...",
      "createdAt": "2026-02-01T00:00:00Z",
      "lastSeen": "2026-02-02T10:30:00Z"
    }
  ],
  "meta": {
    "total": 1,
    "limit": 20,
    "offset": 0
  }
}
```

### POST /api/sessions

Create new session.

```bash
curl -X POST http://localhost:2785/api/sessions \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "session-1",
    "name": "Customer Support",
    "config": {
      "autoReconnect": true,
      "webhookUrl": "https://your-server.com/webhook"
    }
  }'
```

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | No | Session ID (auto-generated if not provided) |
| name | string | No | Display name |
| config.autoReconnect | boolean | No | Auto reconnect on disconnect (default: true) |
| config.webhookUrl | string | No | Webhook URL for this session |
| config.proxy | string | No | Proxy URL (http://user:pass@host:port) |

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "session-1",
    "name": "Customer Support",
    "status": "INITIALIZING",
    "qr": null,
    "createdAt": "2026-02-02T10:30:00Z"
  }
}
```

### GET /api/sessions/:id

Get session details.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/session-1
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "session-1",
    "name": "Customer Support",
    "status": "CONNECTED",
    "phoneNumber": "628123456789",
    "profileName": "John Doe",
    "profilePicture": "https://...",
    "pushName": "John",
    "platform": "android",
    "config": {
      "autoReconnect": true,
      "webhookUrl": "https://your-server.com/webhook"
    },
    "stats": {
      "messagesReceived": 1234,
      "messagesSent": 567,
      "lastMessageAt": "2026-02-02T10:25:00Z"
    },
    "createdAt": "2026-02-01T00:00:00Z",
    "lastSeen": "2026-02-02T10:30:00Z"
  }
}
```

### DELETE /api/sessions/:id

Delete session.

```bash
curl -X DELETE \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/session-1
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| keepAuth | boolean | Keep auth files for quick reconnect (default: false) |

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Session deleted successfully"
  }
}
```

### GET /api/sessions/:id/qr

Get QR code for authentication.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/session-1/qr
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| format | string | `base64` (default), `raw`, `image` |

**Response (format=base64):**
```json
{
  "success": true,
  "data": {
    "qr": "data:image/png;base64,iVBORw0KGgo...",
    "expiresAt": "2026-02-02T10:31:00Z"
  }
}
```

**Response (format=image):**
Returns PNG image directly with `Content-Type: image/png`

### POST /api/sessions/:id/restart

Restart session.

```bash
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/session-1/restart
```

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Session restarting",
    "status": "INITIALIZING"
  }
}
```

### POST /api/sessions/:id/logout

Logout session (clear auth).

```bash
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/session-1/logout
```

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Session logged out successfully"
  }
}
```

## 07.4 Messages API

### POST /api/sessions/:id/messages

Send message.

```bash
# Text message
curl -X POST http://localhost:2785/api/sessions/default/messages \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "628123456789@c.us",
    "type": "text",
    "body": "Hello, World!"
  }'
```

**Request Body - Text:**
```json
{
  "phone": "628123456789@c.us",
  "type": "text",
  "body": "Hello, World!",
  "options": {
    "quotedMessageId": "MSG_ABC123",
    "mentions": ["628111222333@c.us"]
  }
}
```

**Request Body - Image:**
```json
{
  "phone": "628123456789@c.us",
  "type": "image",
  "media": {
    "url": "https://example.com/image.jpg"
  },
  "caption": "Check this out!"
}
```

**Request Body - Image (Base64):**
```json
{
  "phone": "628123456789@c.us",
  "type": "image",
  "media": {
    "base64": "iVBORw0KGgo...",
    "mimetype": "image/jpeg",
    "filename": "photo.jpg"
  },
  "caption": "Photo from base64"
}
```

**Request Body - Document:**
```json
{
  "phone": "628123456789@c.us",
  "type": "document",
  "media": {
    "url": "https://example.com/document.pdf"
  },
  "filename": "report.pdf",
  "caption": "Monthly report"
}
```

**Request Body - Location:**
```json
{
  "phone": "628123456789@c.us",
  "type": "location",
  "location": {
    "latitude": -6.2088,
    "longitude": 106.8456,
    "name": "Monas",
    "address": "Jakarta, Indonesia"
  }
}
```

**Request Body - Contact:**
```json
{
  "phone": "628123456789@c.us",
  "type": "contact",
  "contact": {
    "name": "John Doe",
    "phone": "+628111222333"
  }
}
```

**Interactive messages (Buttons / List): not supported**

> ⚠️ **Buttons and List (interactive) messages are not available** through OpenWA's
> whatsapp-web.js engine. WhatsApp stopped honoring the interactive-message payload
> for unofficial web clients around 2021–2022 — the `Buttons` / `List` classes still
> exist in the library, but messages built with them are **silently dropped and never
> delivered** to recipients. OpenWA therefore does not expose `type: "buttons"` or
> `type: "list"` endpoints; sending interactive messages requires the official
> WhatsApp Business Cloud API. (The earlier examples here were speculative and never
> implemented — see #158.)

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "MSG_ABC123DEF456",
    "phone": "628123456789@c.us",
    "type": "text",
    "body": "Hello, World!",
    "status": "PENDING",
    "timestamp": "2026-02-02T10:30:00Z"
  }
}
```

### POST /api/sessions/:id/messages (Multipart)

Send message with file upload.

```bash
curl -X POST http://localhost:2785/api/sessions/default/messages \
  -H "X-API-Key: $API_KEY" \
  -F "phone=628123456789@c.us" \
  -F "type=image" \
  -F "media=@/path/to/image.jpg" \
  -F "caption=Uploaded via multipart"
```

### GET /api/sessions/:id/messages

Get message history.

```bash
curl -H "X-API-Key: $API_KEY" \
  "http://localhost:2785/api/sessions/default/messages?phone=628123456789@c.us&limit=50"
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| phone | string | Filter by chat (required) |
| limit | number | Max results (default: 50, max: 200) |
| before | string | Messages before this ID |
| after | string | Messages after this ID |
| type | string | Filter by type: `chat`, `image`, `video`, etc. |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "MSG_ABC123",
      "from": "628123456789@c.us",
      "to": "628987654321@c.us",
      "body": "Hello!",
      "type": "chat",
      "timestamp": "2026-02-02T10:25:00Z",
      "status": "READ",
      "isFromMe": false
    }
  ],
  "meta": {
    "hasMore": true,
    "nextCursor": "MSG_DEF456"
  }
}
```

### GET /api/sessions/:id/messages/:messageId

Get specific message.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/messages/MSG_ABC123
```

### DELETE /api/sessions/:id/messages/:messageId

Delete/revoke message.

```bash
curl -X DELETE \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/messages/MSG_ABC123
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| forEveryone | boolean | Delete for everyone (default: true) |

### POST /api/sessions/:id/messages/:messageId/react

React to message.

```bash
curl -X POST http://localhost:2785/api/sessions/default/messages/MSG_ABC123/react \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"emoji": "👍"}'
```

## 07.5 Contacts API

### GET /api/sessions/:id/contacts

Get all contacts.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/contacts
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "628123456789@c.us",
      "name": "John Doe",
      "pushName": "John",
      "shortName": "John",
      "isMyContact": true,
      "isBlocked": false,
      "profilePicture": "https://..."
    }
  ]
}
```

### GET /api/sessions/:id/contacts/:phone

Get contact info.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/contacts/628123456789
```

### GET /api/sessions/:id/contacts/check/:number

Check if number exists on WhatsApp.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/contacts/check/628123456789
```

**Response:**
```json
{
  "number": "628123456789",
  "exists": true,
  "whatsappId": "628123456789@c.us"
}
```

`whatsappId` is the engine's canonical WhatsApp ID (`null` when `exists` is
`false`); it may be normalized and differ from the submitted number.

### POST /api/sessions/:id/contacts/:phone/block

Block contact.

```bash
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/contacts/628123456789/block
```

### POST /api/sessions/:id/contacts/:phone/unblock

Unblock contact.

```bash
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/contacts/628123456789/unblock
```

## 07.6 Groups API

### GET /api/sessions/:id/groups

Get all groups.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/groups
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "120363123456789@g.us",
      "name": "Family Group",
      "description": "Family chat",
      "participantsCount": 15,
      "isAdmin": true,
      "profilePicture": "https://...",
      "createdAt": "2025-01-15T00:00:00Z"
    }
  ]
}
```

### POST /api/sessions/:id/groups

Create new group.

```bash
curl -X POST http://localhost:2785/api/sessions/default/groups \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "New Group",
    "participants": [
      "628123456789@c.us",
      "628987654321@c.us"
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "120363987654321@g.us",
    "name": "New Group",
    "inviteCode": "ABC123XYZ"
  }
}
```

### GET /api/sessions/:id/groups/:groupId

Get group info.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/groups/120363123456789@g.us
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "120363123456789@g.us",
    "name": "Family Group",
    "description": "Family chat",
    "owner": "628111222333@c.us",
    "participants": [
      {
        "id": "628123456789@c.us",
        "isAdmin": true,
        "isSuperAdmin": false
      },
      {
        "id": "628987654321@c.us",
        "isAdmin": false,
        "isSuperAdmin": false
      }
    ],
    "settings": {
      "announce": false,
      "restrict": false
    },
    "inviteCode": "ABC123XYZ",
    "createdAt": "2025-01-15T00:00:00Z"
  }
}
```

### PATCH /api/sessions/:id/groups/:groupId

Update group info.

```bash
curl -X PATCH http://localhost:2785/api/sessions/default/groups/120363123456789@g.us \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Group Name",
    "description": "New description"
  }'
```

### DELETE /api/sessions/:id/groups/:groupId

Leave group.

```bash
curl -X DELETE \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/groups/120363123456789@g.us
```

### POST /api/sessions/:id/groups/:groupId/participants

Add participants to group.

```bash
curl -X POST http://localhost:2785/api/sessions/default/groups/120363123456789@g.us/participants \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "participants": ["628111222333@c.us", "628444555666@c.us"]
  }'
```

### DELETE /api/sessions/:id/groups/:groupId/participants

Remove participants from group.

```bash
curl -X DELETE http://localhost:2785/api/sessions/default/groups/120363123456789@g.us/participants \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "participants": ["628111222333@c.us"]
  }'
```

### POST /api/sessions/:id/groups/:groupId/admins

Promote to admin.

```bash
curl -X POST http://localhost:2785/api/sessions/default/groups/120363123456789@g.us/admins \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "participants": ["628123456789@c.us"]
  }'
```

### DELETE /api/sessions/:id/groups/:groupId/admins

Demote from admin.

```bash
curl -X DELETE http://localhost:2785/api/sessions/default/groups/120363123456789@g.us/admins \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "participants": ["628123456789@c.us"]
  }'
```

### GET /api/sessions/:id/groups/:groupId/invite-code

Get group invite code.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/groups/120363123456789@g.us/invite-code
```

**Response:**
```json
{
  "success": true,
  "data": {
    "inviteCode": "ABC123XYZ",
    "inviteUrl": "https://chat.whatsapp.com/ABC123XYZ"
  }
}
```

### POST /api/sessions/:id/groups/:groupId/invite-code/revoke

Revoke and generate new invite code.

```bash
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/default/groups/120363123456789@g.us/invite-code/revoke
```

## 07.7 Webhooks API

### GET /api/sessions/:sessionId/webhooks

List all webhooks.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/sess_abc123/webhooks
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "wh_123",
      "url": "https://your-server.com/webhook",
      "events": ["message.received", "message.ack"],
      "sessionId": "sess_abc123",
      "enabled": true,
      "secret": "whsec_***",
      "createdAt": "2026-02-01T00:00:00Z"
    }
  ]
}
```

### POST /api/sessions/:sessionId/webhooks

Create webhook.

```bash
curl -X POST http://localhost:2785/api/sessions/sess_abc123/webhooks \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["message.received", "message.ack", "session.status"],
    "headers": {
      "Authorization": "Bearer your-token"
    }
  }'
```

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| url | string | Yes | Webhook endpoint URL |
| events | string[] | Yes | Events to subscribe |
| headers | object | No | Custom headers to send |
| secret | string | No | Secret for signature verification |

**Available Events:**
```
message.received       - New incoming message
message.sent           - Message sent
message.ack            - Message status (sent, delivered, read)
message.revoked        - Message deleted
session.status         - Session status change
session.qr             - QR code generated
session.authenticated  - Session authenticated
session.disconnected   - Session disconnected
group.join             - Someone joined group
group.leave            - Someone left group
group.update           - Group settings changed
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "wh_456",
    "url": "https://your-server.com/webhook",
    "events": ["message.received", "message.ack", "session.status"],
    "sessionId": "sess_abc123",
    "enabled": true,
    "secret": "whsec_abc123xyz",
    "createdAt": "2026-02-02T10:30:00Z"
  }
}
```

### GET /api/sessions/:sessionId/webhooks/:id

Get webhook details.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/sess_abc123/webhooks/wh_456
```

### PATCH /api/sessions/:sessionId/webhooks/:webhookId

Update webhook.

```bash
curl -X PATCH http://localhost:2785/api/sessions/sess_abc123/webhooks/wh_456 \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": ["message.received"],
    "enabled": false
  }'
```

### DELETE /api/sessions/:sessionId/webhooks/:webhookId

Delete webhook.

```bash
curl -X DELETE \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/sess_abc123/webhooks/wh_456
```

### GET /api/sessions/:sessionId/webhooks/:id/logs

Get webhook delivery logs.

```bash
curl -H "X-API-Key: $API_KEY" \
  "http://localhost:2785/api/sessions/sess_abc123/webhooks/wh_456/logs?limit=20"
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "log_789",
      "webhookId": "wh_456",
      "event": "message.received",
      "status": "success",
      "statusCode": 200,
      "duration": 150,
      "attempt": 1,
      "payload": { ... },
      "response": { ... },
      "createdAt": "2026-02-02T10:30:00Z"
    }
  ]
}
```

### POST /api/sessions/:sessionId/webhooks/:id/test

Test webhook.

```bash
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions/sess_abc123/webhooks/wh_456/test
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "success",
    "statusCode": 200,
    "duration": 125,
    "response": {
      "received": true
    }
  }
}
```

## 07.8 API Keys API

All API key management endpoints require an admin API key in `X-API-Key`.
OpenWA creates the initial admin key on first run, prints it in the startup
logs, and writes it to `data/.api-key` (or `/app/data/.api-key` inside the API
container). By default a random `owa_k1_...` admin key is generated on first run
in all environments; set `ALLOW_DEV_API_KEY=true` to seed the well-known
`dev-admin-key` for local development only.

### GET /api/auth/api-keys

List API keys.

```bash
curl -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/auth/api-keys
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "2a8f41e3-3b9a-4a1d-b6d0-b9910df8f0be",
      "name": "Production Key",
      "keyPrefix": "owa_k1_abcd",
      "role": "operator",
      "allowedIps": ["192.168.1.10"],
      "allowedSessions": ["session-uuid-1"],
      "isActive": true,
      "lastUsedAt": "2026-02-02T10:30:00Z",
      "usageCount": 12,
      "expiresAt": null,
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ]
}
```

### POST /api/auth/api-keys

Create API key.

```bash
curl -X POST http://localhost:2785/api/auth/api-keys \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Integration Key",
    "role": "operator",
    "allowedIps": ["192.168.1.10"],
    "allowedSessions": ["default"],
    "expiresAt": "2027-01-01T00:00:00Z"
  }'
```

**Roles:**
```
admin     - Full access, including API key management
operator  - Operational API access for integrations
viewer    - Read-only API access where supported
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "4d0564f1-5fb7-4e4a-baae-4cb0d154e861",
    "name": "Integration Key",
    "keyPrefix": "owa_k1_efgh",
    "role": "operator",
    "allowedIps": ["192.168.1.10"],
    "allowedSessions": ["default"],
    "isActive": true,
    "usageCount": 0,
    "expiresAt": "2027-01-01T00:00:00Z",
    "createdAt": "2026-02-02T10:30:00Z",
    "apiKey": "owa_k1_efgh5678..."
  }
}
```

**Note:** The full `apiKey` is only shown once at creation.

### PUT /api/auth/api-keys/:id

Update API key metadata, role, IP allowlist, session allowlist, or expiry.

```bash
curl -X PUT http://localhost:2785/api/auth/api-keys/4d0564f1-5fb7-4e4a-baae-4cb0d154e861 \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Integration Key - Production",
    "role": "operator"
  }'
```

### POST /api/auth/api-keys/:id/revoke

Revoke API key without deleting its record.

```bash
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/auth/api-keys/4d0564f1-5fb7-4e4a-baae-4cb0d154e861/revoke
```

### DELETE /api/auth/api-keys/:id

Delete API key.

```bash
curl -X DELETE \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/auth/api-keys/4d0564f1-5fb7-4e4a-baae-4cb0d154e861
```

### POST /api/auth/validate

Validate the API key provided in the `X-API-Key` header.

```bash
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/auth/validate
```

## 07.9 Postman Collection

```json
{
  "info": {
    "name": "OpenWA API",
    "description": "OpenWA WhatsApp API Gateway",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "variable": [
    {
      "key": "baseUrl",
      "value": "http://localhost:2785",
      "type": "string"
    },
    {
      "key": "apiKey",
      "value": "your-api-key",
      "type": "string"
    },
    {
      "key": "sessionId",
      "value": "default",
      "type": "string"
    }
  ],
  "auth": {
    "type": "apikey",
    "apikey": [
      {
        "key": "key",
        "value": "X-API-Key",
        "type": "string"
      },
      {
        "key": "value",
        "value": "{{apiKey}}",
        "type": "string"
      },
      {
        "key": "in",
        "value": "header",
        "type": "string"
      }
    ]
  },
  "item": [
    {
      "name": "Health",
      "item": [
        {
          "name": "Health Check",
          "request": {
            "method": "GET",
            "url": "{{baseUrl}}/health"
          }
        },
        {
          "name": "Detailed Health",
          "request": {
            "method": "GET",
            "url": "{{baseUrl}}/health/detailed"
          }
        }
      ]
    },
    {
      "name": "Sessions",
      "item": [
        {
          "name": "List Sessions",
          "request": {
            "method": "GET",
            "url": "{{baseUrl}}/api/sessions"
          }
        },
        {
          "name": "Create Session",
          "request": {
            "method": "POST",
            "url": "{{baseUrl}}/api/sessions",
            "body": {
              "mode": "raw",
              "raw": "{\n  \"id\": \"{{sessionId}}\",\n  \"name\": \"My Session\"\n}",
              "options": {
                "raw": {
                  "language": "json"
                }
              }
            }
          }
        },
        {
          "name": "Get Session",
          "request": {
            "method": "GET",
            "url": "{{baseUrl}}/api/sessions/{{sessionId}}"
          }
        },
        {
          "name": "Get QR Code",
          "request": {
            "method": "GET",
            "url": "{{baseUrl}}/api/sessions/{{sessionId}}/qr"
          }
        },
        {
          "name": "Delete Session",
          "request": {
            "method": "DELETE",
            "url": "{{baseUrl}}/api/sessions/{{sessionId}}"
          }
        }
      ]
    },
    {
      "name": "Messages",
      "item": [
        {
          "name": "Send Text Message",
          "request": {
            "method": "POST",
            "url": "{{baseUrl}}/api/sessions/{{sessionId}}/messages",
            "body": {
              "mode": "raw",
              "raw": "{\n  \"phone\": \"628123456789@c.us\",\n  \"type\": \"text\",\n  \"body\": \"Hello from OpenWA!\"\n}",
              "options": {
                "raw": {
                  "language": "json"
                }
              }
            }
          }
        },
        {
          "name": "Send Image (URL)",
          "request": {
            "method": "POST",
            "url": "{{baseUrl}}/api/sessions/{{sessionId}}/messages",
            "body": {
              "mode": "raw",
              "raw": "{\n  \"phone\": \"628123456789@c.us\",\n  \"type\": \"image\",\n  \"media\": {\n    \"url\": \"https://example.com/image.jpg\"\n  },\n  \"caption\": \"Check this out!\"\n}",
              "options": {
                "raw": {
                  "language": "json"
                }
              }
            }
          }
        },
        {
          "name": "Get Message History",
          "request": {
            "method": "GET",
            "url": {
              "raw": "{{baseUrl}}/api/sessions/{{sessionId}}/messages?phone=628123456789@c.us&limit=50",
              "host": ["{{baseUrl}}"],
              "path": ["api", "sessions", "{{sessionId}}", "messages"],
              "query": [
                {"key": "phone", "value": "628123456789@c.us"},
                {"key": "limit", "value": "50"}
              ]
            }
          }
        }
      ]
    }
  ]
}
```

Download: [openwa-postman-collection.json](./assets/openwa-postman-collection.json)

## 07.10 cURL Examples Collection

```bash
#!/bin/bash
# openwa-curl-examples.sh

BASE_URL="http://localhost:2785"
API_KEY="your-api-key"
SESSION_ID="default"

# Health Check
echo "=== Health Check ==="
curl -s "$BASE_URL/health" | jq

# Create Session
echo "=== Create Session ==="
curl -s -X POST "$BASE_URL/api/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$SESSION_ID\", \"name\": \"Test Session\"}" | jq

# Get QR Code
echo "=== Get QR Code ==="
curl -s "$BASE_URL/api/sessions/$SESSION_ID/qr" \
  -H "X-API-Key: $API_KEY" | jq -r '.data.qr'

# Send Text Message
echo "=== Send Text Message ==="
curl -s -X POST "$BASE_URL/api/sessions/$SESSION_ID/messages" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "628123456789@c.us",
    "type": "text",
    "body": "Hello from cURL!"
  }' | jq

# Send Image
echo "=== Send Image ==="
curl -s -X POST "$BASE_URL/api/sessions/$SESSION_ID/messages" \
  -H "X-API-Key: $API_KEY" \
  -F "phone=628123456789@c.us" \
  -F "type=image" \
  -F "media=@./test-image.jpg" \
  -F "caption=Uploaded via cURL" | jq

# Get Contacts
echo "=== Get Contacts ==="
curl -s "$BASE_URL/api/sessions/$SESSION_ID/contacts" \
  -H "X-API-Key: $API_KEY" | jq

# Get Groups
echo "=== Get Groups ==="
curl -s "$BASE_URL/api/sessions/$SESSION_ID/groups" \
  -H "X-API-Key: $API_KEY" | jq

# Create Webhook
echo "=== Create Webhook ==="
curl -s -X POST "$BASE_URL/api/sessions/$SESSION_ID/webhooks" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["message.received", "message.ack"]
  }' | jq
```
---

<div align="center">

[← 06 - API Specification](./06-api-specification.md) · [Documentation Index](./README.md) · [Next: 08 - Development Guidelines →](./08-development-guidelines.md)

</div>

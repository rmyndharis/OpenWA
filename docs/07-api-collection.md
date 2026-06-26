# 07 - API Collection

## 07.1 Overview

This collection gives a runnable cURL for every OpenWA REST endpoint. The examples assume two environment variables — set them once and reuse them:

```bash
export BASE=http://localhost:2785
export API_KEY=owa_k1_your-api-key-here
```

(For the metrics endpoint also `export METRICS_TOKEN=...`.)

### Authentication

Every request carries the key in the `X-API-Key` header — REST auth is **header-only**, an `?apiKey=` query value is not accepted. Routes that mutate state need an `operator` key; API-key and settings management need an `admin` key; read-only routes accept any valid key. The metrics endpoint uses `Authorization: Bearer $METRICS_TOKEN` instead.

```bash
# the auth header that prefixes nearly every call below
-H "X-API-Key: $API_KEY"
```

### Responses

Responses are the **raw payload** — no `{ success, data }` envelope. A resource route returns the object directly; a list route returns a bare JSON array. Errors return the NestJS default shape `{ "statusCode", "message", "error" }`. Add `Content-Type: application/json` only when sending a body.

### Sections

Sessions · Messages · Webhooks · Groups · Contacts · Chats · Labels · Channels · Catalog · Templates · Plugins · Settings · Auth (API Keys) · Health · Infrastructure · Stats · Metrics · Events (WebSocket).

## 07.2 Endpoints

All examples assume `BASE` and `API_KEY` are exported (see 07.1). Paths are prefixed with `/api`.

### 07.3 Sessions

All routes are under `$BASE/api/sessions` and require `X-API-Key: $API_KEY` (some require an OPERATOR-role key). Reads come first, then writes.

#### GET /api/sessions

List all sessions visible to the key.

```bash
curl -X GET "$BASE/api/sessions" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:id

Get a single session by ID.

```bash
curl -X GET "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:id/qr

Get the QR code (PNG data URL) for authentication.

```bash
curl -X GET "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/qr" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:id/groups

List groups the session belongs to (paginated).

```bash
curl -X GET "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/groups?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:id/chats

List active chats, most-recent first (paginated).

```bash
curl -X GET "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/stats/overview

Aggregate session statistics for monitoring.

```bash
curl -X GET "$BASE/api/sessions/stats/overview" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions

Create a new session (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "my-bot", "config": { "autoReconnect": true }, "proxyUrl": "http://proxy.example.com:8080", "proxyType": "http" }'
```

#### POST /api/sessions/:id/start

Start a session and initialize the connection (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/start" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:id/stop

Stop a session and disconnect (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/stop" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:id/force-kill

Force-kill a stuck session (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/force-kill" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:id/pairing-code

Request an 8-char pairing code via phone number (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/pairing-code" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "phoneNumber": "628123456789" }'
```

#### POST /api/sessions/:id/chats/read

Mark a chat as read/seen (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/read" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890@c.us" }'
```

#### POST /api/sessions/:id/chats/unread

Mark a chat as unread (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/unread" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890@c.us" }'
```

#### POST /api/sessions/:id/chats/delete

Delete a chat from the chat list (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/delete" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890-123@g.us" }'
```

#### POST /api/sessions/:id/chats/typing

Send a typing/recording presence indicator (or clear it with `paused`) (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a/chats/typing" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "1234567890@c.us", "state": "typing" }'
```

#### DELETE /api/sessions/:id

Delete a session (OPERATOR). Returns `204` with no body.

```bash
curl -X DELETE "$BASE/api/sessions/8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a" \
  -H "X-API-Key: $API_KEY"
```

### 07.4 Messages

All routes are under `/api/sessions/:sessionId/messages`. Reads accept any API key; send/write routes need an OPERATOR (or higher) key.

#### GET /api/sessions/:sessionId/messages

Get persisted message history from the local DB (paginated, filterable).

```bash
curl "$BASE/api/sessions/my-session/messages?chatId=628123456789@c.us&limit=20&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/messages/:chatId/history

Fetch chat history live from WhatsApp, bypassing the DB.

```bash
curl "$BASE/api/sessions/my-session/628123456789@c.us/history?limit=100&deep=true" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/messages/:chatId/:messageId/reactions

Get reactions for a message, grouped by emoji.

```bash
curl "$BASE/api/sessions/my-session/628123456789@c.us/true_628123456789@c.us_3EB0ABCD/reactions" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/messages/batch/:batchId

Get the status and progress of a bulk batch.

```bash
curl "$BASE/api/sessions/my-session/messages/batch/batch_a1b2c3d4" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/messages/send-text

Send a plain text message.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-text" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "text": "Hello from OpenWA!" }'
```

#### POST /api/sessions/:sessionId/messages/send-template

Render a stored template (`{{vars}}` substituted) and send it as text.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-template" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "templateName": "order-confirmation", "vars": { "customer": "Alice", "orderId": "1234" } }'
```

#### POST /api/sessions/:sessionId/messages/send-image

Send an image by URL or base64 with an optional caption.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-image" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/image.jpg", "caption": "Check out this image!" }'
```

#### POST /api/sessions/:sessionId/messages/send-video

Send a video by URL or base64 with an optional caption.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-video" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/clip.mp4", "caption": "video" }'
```

#### POST /api/sessions/:sessionId/messages/send-audio

Send an audio/voice message by URL or base64.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-audio" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/voice.ogg", "mimetype": "audio/ogg" }'
```

#### POST /api/sessions/:sessionId/messages/send-document

Send a document/file by URL or base64.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-document" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/report.pdf", "filename": "report.pdf", "mimetype": "application/pdf" }'
```

#### POST /api/sessions/:sessionId/messages/send-location

Send a location pin.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-location" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "latitude": -6.2088, "longitude": 106.8456, "description": "Jakarta", "address": "Central Jakarta" }'
```

#### POST /api/sessions/:sessionId/messages/send-contact

Send a contact card (vCard).

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-contact" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "contactName": "John Doe", "contactNumber": "628987654321" }'
```

#### POST /api/sessions/:sessionId/messages/send-sticker

Send a sticker by URL or base64 (typically webp).

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-sticker" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "url": "https://example.com/sticker.webp", "mimetype": "image/webp" }'
```

#### POST /api/sessions/:sessionId/messages/reply

Reply to a message, quoting a prior one.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/reply" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "quotedMessageId": "true_628123456789@c.us_3EB0ABCD", "text": "Replying to you" }'
```

#### POST /api/sessions/:sessionId/messages/forward

Forward a message from one chat to another.

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/forward" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "fromChatId": "628111111111@c.us", "toChatId": "628222222222@c.us", "messageId": "true_628111111111@c.us_3EB0XYZ" }'
```

#### POST /api/sessions/:sessionId/messages/react

Add a reaction (send an empty `emoji` to remove it).

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/react" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "emoji": "👍" }'
```

#### POST /api/sessions/:sessionId/messages/delete

Delete a message (for everyone by default).

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/delete" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "628123456789@c.us", "messageId": "true_628123456789@c.us_3EB0ABCD", "forEveryone": true }'
```

#### POST /api/sessions/:sessionId/messages/send-bulk

Send to multiple recipients as an async batch (max 100 messages).

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-bulk" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      { "chatId": "628111111111@c.us", "type": "text", "content": { "text": "Hi {{name}}" }, "variables": { "name": "Alice" } },
      { "chatId": "628222222222@c.us", "type": "image", "content": { "image": { "url": "https://example.com/promo.jpg" }, "caption": "Promo" } }
    ],
    "options": { "delayBetweenMessages": 3000, "randomizeDelay": true, "stopOnError": false }
  }'
```

#### POST /api/sessions/:sessionId/messages/batch/:batchId/cancel

Cancel a running bulk batch (no body).

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/batch/batch_a1b2c3d4/cancel" \
  -H "X-API-Key: $API_KEY"
```

### 07.5 Contacts

#### GET /api/sessions/:sessionId/contacts

List contacts for a session (paginated window).

```bash
curl -X GET "$BASE/api/sessions/main/contacts?limit=100&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/contacts/check/:number

Check whether a phone number is on WhatsApp.

```bash
curl -X GET "$BASE/api/sessions/main/contacts/check/628123456789" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/contacts/:contactId

Get a single contact by its WhatsApp id.

```bash
curl -X GET "$BASE/api/sessions/main/contacts/6281234567890@c.us" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/contacts/:contactId/profile-picture

Get a contact's profile picture URL.

```bash
curl -X GET "$BASE/api/sessions/main/contacts/6281234567890@c.us/profile-picture" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/contacts/:contactId/phone

Resolve a contact id (e.g. an @lid) to a phone number.

```bash
curl -X GET "$BASE/api/sessions/main/contacts/12345678901234@lid/phone" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/contacts/:contactId/block

Block a contact (requires an OPERATOR key). Send an empty body.

```bash
curl -X POST "$BASE/api/sessions/main/contacts/6281234567890@c.us/block" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

#### DELETE /api/sessions/:sessionId/contacts/:contactId/block

Unblock a contact (requires an OPERATOR key).

```bash
curl -X DELETE "$BASE/api/sessions/main/contacts/6281234567890@c.us/block" \
  -H "X-API-Key: $API_KEY"
```

### 07.6 Groups

#### GET /api/sessions/:sessionId/groups

List all groups for a session (paginated).

```bash
curl -X GET "$BASE/api/sessions/my-session/groups?limit=1000&offset=0" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/groups/:groupId

Get detailed group info including participants.

```bash
curl -X GET "$BASE/api/sessions/my-session/groups/120363021234567890@g.us" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/groups/:groupId/invite-code

Get the group invite code and full invite link.

```bash
curl -X GET "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/invite-code" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/groups

Create a new group with an initial set of participants (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/my-session/groups" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Project Team", "participants": ["628123456789@c.us", "628987654321@c.us"] }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/participants

Add participants to a group (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/participants" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### DELETE /api/sessions/:sessionId/groups/:groupId/participants

Remove participants from a group (OPERATOR). This DELETE takes a JSON body.

```bash
curl -X DELETE "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/participants" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/participants/promote

Promote participants to group admin (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/participants/promote" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/participants/demote

Demote participants from group admin (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/participants/demote" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "participants": ["628123456789@c.us"] }'
```

#### PUT /api/sessions/:sessionId/groups/:groupId/subject

Change the group name/subject (OPERATOR).

```bash
curl -X PUT "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/subject" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "subject": "New Team Name" }'
```

#### PUT /api/sessions/:sessionId/groups/:groupId/description

Change the group description; an empty string clears it (OPERATOR).

```bash
curl -X PUT "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/description" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "description": "Internal coordination group." }'
```

#### POST /api/sessions/:sessionId/groups/:groupId/leave

Leave a group (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/leave" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/groups/:groupId/invite-code/revoke

Revoke the current invite code and generate a new one (OPERATOR).

```bash
curl -X POST "$BASE/api/sessions/my-session/groups/120363021234567890@g.us/invite-code/revoke" \
  -H "X-API-Key: $API_KEY"
```

### 07.7 Message Templates

All template routes are nested under a session and require an OPERATOR-level key.

#### GET /api/sessions/:sessionId/templates

List all templates for a session, newest first.

```bash
curl "$BASE/api/sessions/$SESSION_ID/templates" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/templates/:id

Get a single template by ID.

```bash
curl "$BASE/api/sessions/$SESSION_ID/templates/$TEMPLATE_ID" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/templates

Create a message template with `{{variable}}` placeholders.

```bash
curl -X POST "$BASE/api/sessions/$SESSION_ID/templates" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "order-confirmation",
    "body": "Hi {{customer}}, your order {{orderId}} has shipped.",
    "header": "OpenWA Store",
    "footer": "Reply STOP to unsubscribe."
  }'
```

#### PUT /api/sessions/:sessionId/templates/:id

Update a template (partial; only provided fields change).

```bash
curl -X PUT "$BASE/api/sessions/$SESSION_ID/templates/$TEMPLATE_ID" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "Hi {{customer}}, your order {{orderId}} is out for delivery.",
    "footer": "Thanks for shopping with us."
  }'
```

#### DELETE /api/sessions/:sessionId/templates/:id

Delete a template by ID (returns `204` empty body).

```bash
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/templates/$TEMPLATE_ID" \
  -H "X-API-Key: $API_KEY"
```

### 07.8 Catalog & Channels

#### GET /api/sessions/:sessionId/catalog

Get business catalog info for the session.

```bash
curl -X GET "$BASE/api/sessions/my-session/catalog" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/catalog/products

List catalog products with pagination.

```bash
curl -X GET "$BASE/api/sessions/my-session/catalog/products?page=1&limit=20" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/catalog/products/:productId

Get a specific catalog product by id (unknown id returns 200 with `null`).

```bash
curl -X GET "$BASE/api/sessions/my-session/catalog/products/PROD_12345" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/messages/send-product

Send a product card to a chat (OPERATOR key required).

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-product" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "6281234567890@c.us", "productId": "PROD_12345", "body": "Check out this item!" }'
```

#### POST /api/sessions/:sessionId/messages/send-catalog

Send the business catalog link to a chat (OPERATOR key required).

```bash
curl -X POST "$BASE/api/sessions/my-session/messages/send-catalog" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "chatId": "6281234567890@c.us", "body": "Browse our full catalog here" }'
```

#### GET /api/sessions/:sessionId/channels

List subscribed channels/newsletters.

```bash
curl -X GET "$BASE/api/sessions/my-session/channels" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/channels/:channelId

Get a single channel by id.

```bash
curl -X GET "$BASE/api/sessions/my-session/channels/120363000000000000@newsletter" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/channels/:channelId/messages

Get recent messages from a channel.

```bash
curl -X GET "$BASE/api/sessions/my-session/channels/120363000000000000@newsletter/messages?limit=50" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/channels/subscribe

Subscribe to a channel by invite code (OPERATOR key required).

```bash
curl -X POST "$BASE/api/sessions/my-session/channels/subscribe" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "inviteCode": "ABC123xyz" }'
```

#### DELETE /api/sessions/:sessionId/channels/:channelId

Unsubscribe from a channel (OPERATOR key required).

```bash
curl -X DELETE "$BASE/api/sessions/my-session/channels/120363000000000000@newsletter" \
  -H "X-API-Key: $API_KEY"
```

### 07.9 Labels & Status

```bash
# List all labels for a session (WhatsApp Business only)
curl -X GET "$BASE/api/sessions/$SESSION_ID/labels" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Get a single label by ID
curl -X GET "$BASE/api/sessions/$SESSION_ID/labels/5" \
  -H "X-API-Key: $API_KEY"
```

```bash
# List labels assigned to a chat
curl -X GET "$BASE/api/sessions/$SESSION_ID/labels/chat/6281234567890@c.us" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Add a label to a chat (OPERATOR)
curl -X POST "$BASE/api/sessions/$SESSION_ID/labels/chat/6281234567890@c.us" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "labelId": "5" }'
```

```bash
# Remove a label from a chat (OPERATOR)
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/labels/chat/6281234567890@c.us/5" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Get all status updates (stories) visible to the session
curl -X GET "$BASE/api/sessions/$SESSION_ID/status" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Get status updates posted by a specific contact
curl -X GET "$BASE/api/sessions/$SESSION_ID/status/6281234567890@c.us" \
  -H "X-API-Key: $API_KEY"
```

```bash
# Post a text status (OPERATOR)
curl -X POST "$BASE/api/sessions/$SESSION_ID/status/send-text" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Hello from OpenWA!", "backgroundColor": "#25D366", "font": 2 }'
```

```bash
# Post an image status from a URL (OPERATOR)
curl -X POST "$BASE/api/sessions/$SESSION_ID/status/send-image" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "image": { "url": "https://example.com/photo.jpg" }, "caption": "My status" }'
```

```bash
# Post a video status from a URL (OPERATOR)
curl -X POST "$BASE/api/sessions/$SESSION_ID/status/send-video" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "video": { "url": "https://example.com/clip.mp4" }, "caption": "Watch this" }'
```

```bash
# Delete one of the session's own posted statuses (OPERATOR)
curl -X DELETE "$BASE/api/sessions/$SESSION_ID/status/false_status@broadcast_3A1F" \
  -H "X-API-Key: $API_KEY"
```

### 07.10 Webhooks (management)

All routes require an API key with OPERATOR role or higher. `secret` and `headers` are write-only (never returned). The per-session routes live under `/api/sessions/:sessionId/webhooks`; the cross-session list is `/api/webhooks`.

#### GET /api/sessions/:sessionId/webhooks

List all webhooks for a session (newest first).

```bash
curl -X GET "$BASE/api/sessions/my-session/webhooks" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/sessions/:sessionId/webhooks/:id

Get a single webhook by ID, scoped to the session.

```bash
curl -X GET "$BASE/api/sessions/my-session/webhooks/f1e2d3c4-b5a6-7890-1234-567890abcdef" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/webhooks

List webhooks visible to the calling key (scoped to its allowed sessions).

```bash
curl -X GET "$BASE/api/webhooks" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/sessions/:sessionId/webhooks

Create a webhook for the session.

```bash
curl -X POST "$BASE/api/sessions/my-session/webhooks" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

#### PUT /api/sessions/:sessionId/webhooks/:id

Update a webhook (partial; only provided fields change).

```bash
curl -X PUT "$BASE/api/sessions/my-session/webhooks/f1e2d3c4-b5a6-7890-1234-567890abcdef" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": ["*"],
    "active": false,
    "retryCount": 5,
    "filters": null
  }'
```

#### POST /api/sessions/:sessionId/webhooks/:id/test

Send a synthetic test payload to the webhook URL and report the result (no request body).

```bash
curl -X POST "$BASE/api/sessions/my-session/webhooks/f1e2d3c4-b5a6-7890-1234-567890abcdef/test" \
  -H "X-API-Key: $API_KEY"
```

#### DELETE /api/sessions/:sessionId/webhooks/:id

Delete a webhook (returns `204` no content).

```bash
curl -X DELETE "$BASE/api/sessions/my-session/webhooks/f1e2d3c4-b5a6-7890-1234-567890abcdef" \
  -H "X-API-Key: $API_KEY"
```

### 07.11 API Keys

All `/api/auth/api-keys` routes require an **ADMIN** key. `POST /api/auth/validate` accepts any valid key. The plaintext key is returned only by the create call.

#### GET /api/auth/api-keys

List all API keys (newest first).

```bash
curl -X GET "$BASE/api/auth/api-keys" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/auth/api-keys/:id

Get one API key by id.

```bash
curl -X GET "$BASE/api/auth/api-keys/3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/auth/api-keys

Create a key; the response includes the full plaintext key once.

```bash
curl -X POST "$BASE/api/auth/api-keys" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Bot",
    "role": "operator",
    "allowedIps": ["192.168.1.1", "10.0.0.0/8"],
    "allowedSessions": ["session-uuid-1"],
    "expiresAt": "2027-12-31T23:59:59Z"
  }'
```

#### PUT /api/auth/api-keys/:id

Update name/role/allowedIps/allowedSessions/expiresAt.

```bash
curl -X PUT "$BASE/api/auth/api-keys/3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Renamed Bot",
    "role": "viewer",
    "allowedIps": ["203.0.113.5"],
    "expiresAt": "2028-01-01T00:00:00Z"
  }'
```

#### POST /api/auth/api-keys/:id/revoke

Deactivate a key without deleting it (no body).

```bash
curl -X POST "$BASE/api/auth/api-keys/3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33/revoke" \
  -H "X-API-Key: $API_KEY"
```

#### DELETE /api/auth/api-keys/:id

Permanently delete a key (returns `204`, no body).

```bash
curl -X DELETE "$BASE/api/auth/api-keys/3f2a1c9e-1b2d-4a5f-9c8e-aa11bb22cc33" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/auth/validate

Validate the supplied key and report its role (empty body; key read from the header).

```bash
curl -X POST "$BASE/api/auth/validate" \
  -H "X-API-Key: $API_KEY"
```

### 07.12 System (Health, Metrics, Stats, Settings)

#### GET /api/health

Basic health check (status, timestamp, version). Public.

```bash
curl "$BASE/api/health"
```

#### GET /api/health/live

Liveness probe — always `{ "status": "ok" }`. Public.

```bash
curl "$BASE/api/health/live"
```

#### GET /api/health/ready

Readiness probe — checks both datasources; `503` while draining or on DB failure. Public.

```bash
curl "$BASE/api/health/ready"
```

#### GET /api/metrics

Prometheus scrape. Gated by the metrics bearer token (not the API key); `404` when `METRICS_TOKEN` is unset.

```bash
curl "$BASE/api/metrics" \
  -H "Authorization: Bearer $METRICS_TOKEN"
```

#### GET /api/stats/overview

Cross-session aggregate stats. ADMIN key required.

```bash
curl "$BASE/api/stats/overview" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/stats/messages

Message stats over a period (`24h` | `7d` | `30d`, default `24h`). ADMIN key required.

```bash
curl "$BASE/api/stats/messages?period=7d" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/stats/sessions/:sessionId

Per-session stats. Any valid API key (not session-scoped).

```bash
curl "$BASE/api/stats/sessions/9f1c2d3e-…" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/settings

Read runtime settings (env-derived). Any valid API key.

```bash
curl "$BASE/api/settings" \
  -H "X-API-Key: $API_KEY"
```

#### PUT /api/settings

Always returns `501` — settings are read-only at runtime. ADMIN key required (still `501`).

```bash
curl -X PUT "$BASE/api/settings" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "general": { "sessionTimeout": 10 } }'
```

### 07.13 Administration (Infrastructure, Plugins, MCP)

ADMIN-only operations (except the public health check and the MCP transport). Assumes `BASE`, `API_KEY`, and — for MCP — that `MCP_ENABLED=true`.

#### GET /api/infra/health

Public liveness probe.

```bash
curl "$BASE/api/infra/health"
```

#### GET /api/infra/status

Aggregate infra status (DB, Redis, queue, storage, engine).

```bash
curl "$BASE/api/infra/status" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/infra/engines

List available WhatsApp engine plugins.

```bash
curl "$BASE/api/infra/engines" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/infra/engines/current

Get the currently active engine type.

```bash
curl "$BASE/api/infra/engines/current" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/infra/config

Read saved infrastructure config (secrets omitted).

```bash
curl "$BASE/api/infra/config" \
  -H "X-API-Key: $API_KEY"
```

#### PUT /api/infra/config

Merge-save infrastructure config to `data/.env.generated`.

```bash
curl -X PUT "$BASE/api/infra/config" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "database": { "type": "postgres", "host": "db.example.com", "port": "5432", "username": "openwa", "password": "s3cret", "database": "openwa", "poolSize": 10, "sslEnabled": true, "sslRejectUnauthorized": false },
    "redis": { "enabled": true, "builtIn": true },
    "queue": { "enabled": true },
    "storage": { "type": "s3", "s3Bucket": "my-bucket", "s3Region": "ap-southeast-1", "s3AccessKey": "AKIA...", "s3SecretKey": "...", "s3Endpoint": "https://s3.example.com" },
    "engine": { "type": "whatsapp-web.js", "headless": true }
  }'
```

#### POST /api/infra/restart

Request a graceful restart, optionally orchestrating Docker profiles.

```bash
curl -X POST "$BASE/api/infra/restart" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "profiles": ["postgres", "redis"], "profilesToRemove": ["minio"] }'
```

#### GET /api/infra/export-data

Export all Data DB rows as JSON for migration.

```bash
curl "$BASE/api/infra/export-data" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/infra/import-data

Replace all Data DB rows with a prior export (destructive, all-or-nothing).

```bash
curl -X POST "$BASE/api/infra/import-data" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tables": {
      "sessions": [ { "id": "s1", "name": "main", "status": "READY", "phone": "15551234567", "pushName": "Me", "config": {}, "proxyUrl": null, "proxyType": null, "connectedAt": "2026-06-25T00:00:00.000Z", "lastActiveAt": "2026-06-25T00:00:00.000Z", "createdAt": "2026-06-25T00:00:00.000Z", "updatedAt": "2026-06-25T00:00:00.000Z" } ],
      "webhooks": [], "messages": [], "messageBatches": [], "templates": [], "baileysStoredMessages": []
    }
  }'
```

#### GET /api/infra/storage/files/count

File count and total size in the active storage backend.

```bash
curl "$BASE/api/infra/storage/files/count" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/infra/storage/export

Export all storage files to a tar.gz; returns its server-side path.

```bash
curl "$BASE/api/infra/storage/export" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/infra/storage/import

Import storage files from a tar.gz located inside `data/`.

```bash
curl -X POST "$BASE/api/infra/storage/import" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "filePath": "./data/exports/storage-export-1750000000000-abc.tar.gz" }'
```

#### GET /api/plugins

List all loaded plugins (secrets redacted).

```bash
curl "$BASE/api/plugins" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/plugins/catalog

List the remote plugin catalog with install state.

```bash
curl "$BASE/api/plugins/catalog" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/plugins/:id

Get a single plugin by id.

```bash
curl "$BASE/api/plugins/chat-flow" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/plugins/:id/config-ui

Fetch a plugin's sandboxed config-UI HTML (for an iframe srcdoc).

```bash
curl "$BASE/api/plugins/chat-flow/config-ui" \
  -H "X-API-Key: $API_KEY"
```

#### GET /api/plugins/:id/health

Check a plugin's health.

```bash
curl "$BASE/api/plugins/chat-flow/health" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/plugins/install

Install a plugin from an uploaded .zip (multipart, field `file`, max 5 MB).

```bash
curl -X POST "$BASE/api/plugins/install" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@my-plugin.zip"
```

#### POST /api/plugins/install-url

Install a plugin by downloading its .zip from a URL (SSRF-guarded).

```bash
curl -X POST "$BASE/api/plugins/install-url" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://github.com/openwa-plugins/chat-flow/releases/download/v1.0.0/chat-flow.zip" }'
```

#### POST /api/plugins/:id/enable

Enable a plugin.

```bash
curl -X POST "$BASE/api/plugins/chat-flow/enable" \
  -H "X-API-Key: $API_KEY"
```

#### POST /api/plugins/:id/disable

Disable a plugin.

```bash
curl -X POST "$BASE/api/plugins/chat-flow/disable" \
  -H "X-API-Key: $API_KEY"
```

#### PUT /api/plugins/:id/config

Update a plugin's base configuration.

```bash
curl -X PUT "$BASE/api/plugins/chat-flow/config" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "config": { "apiKey": "sk-...", "replyDelayMs": 1500 } }'
```

#### PUT /api/plugins/:id/config/:sessionId

Set (or clear with `{}`) a per-session plugin config override.

```bash
curl -X PUT "$BASE/api/plugins/chat-flow/config/session-1" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "config": { "replyDelayMs": 3000 } }'
```

#### PUT /api/plugins/:id/sessions

Set which sessions a session-scoped plugin is activated for (`["*"]` = all).

```bash
curl -X PUT "$BASE/api/plugins/chat-flow/sessions" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "sessions": ["*"] }'
```

#### POST /api/plugins/:id/update

Update an installed plugin in place from a URL.

```bash
curl -X POST "$BASE/api/plugins/chat-flow/update" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/plugins/chat-flow-1.1.0.zip" }'
```

#### DELETE /api/plugins/:id

Uninstall a plugin (built-ins protected).

```bash
curl -X DELETE "$BASE/api/plugins/chat-flow" \
  -H "X-API-Key: $API_KEY"
```

#### POST /mcp

MCP JSON-RPC 2.0 transport (no `/api` prefix; gated by `MCP_ENABLED=true`). The API key goes via `X-Api-Key` or `Authorization: Bearer`; auth is enforced per tool call. See doc 24 for the tool catalog.

```bash
# Initialize handshake
curl -X POST "$BASE/mcp" \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "openwa-collection", "version": "1.0.0" } } }'

# List available tools
curl -X POST "$BASE/mcp" \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }'

# Call a tool (arguments must match the tool's zod inputSchema)
curl -X POST "$BASE/mcp" \
  -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "session_send_text", "arguments": { "sessionId": "default", "to": "6281234567890", "text": "Hello from MCP" } } }'
```

### 07.14 Real-time (WebSocket)

Events are delivered over **Socket.IO** on the `/events` namespace (not a raw WebSocket). Use the `socket.io-client` package. Set `BASE_WS` (e.g. `ws://localhost:2785`) and `API_KEY`.

```bash
npm install socket.io-client
```

```js
// realtime.mjs — run: BASE_WS=ws://localhost:2785 API_KEY=... SESSION_ID=main node realtime.mjs
import { io } from 'socket.io-client';

const BASE_WS = process.env.BASE_WS || 'ws://localhost:2785';
const API_KEY = process.env.API_KEY;
const SESSION_ID = process.env.SESSION_ID || 'main';

const socket = io(`${BASE_WS}/events`, {
  auth: { apiKey: API_KEY }, // or transport.headers / ?apiKey=
});

socket.on('connect', () => {
  console.log('connected:', socket.id);
  socket.emit('message', {
    type: 'subscribe',
    sessionId: SESSION_ID,
    events: ['*'], // or e.g. ['message.received', 'session.status']
    requestId: 'sub-1',
  });
});

socket.on('message', (msg) => {
  if (msg.type === 'event') {
    console.log(`[${msg.payload.event}] ${msg.payload.sessionId}`, msg.payload.data);
  } else {
    console.log(`[${msg.type}]`, msg); // subscribed | unsubscribed | pong | error
  }
});

socket.on('connect_error', (err) => console.error('connect_error:', err.message));
socket.on('disconnect', (reason) => console.log('disconnected:', reason));
```

# Session Phone-Number Pairing

OpenWA supports linking an existing WhatsApp account to a session by phone number as an alternative to scanning a QR code.

This flow returns an 8-character pairing code that the user enters in WhatsApp on their phone.

> This does **not** create or register a new WhatsApp account. It only links an existing WhatsApp account as a companion device for an OpenWA session.

> **On the whatsapp-web.js engine, request a code only for a number you are prepared to re-link.** A pairing request for a number that already has a linked session has been observed to end with WhatsApp revoking that device: within about a minute the linked session logs `WhatsApp unlinked this device (LOGOUT)`, its stored credentials are deleted, and it returns to `qr_ready` with no phone. The request runs inside the shared WhatsApp Web page and resets its linking mode before it asks for a code, so the blast radius is the account, not the session. Baileys has no such page and was not affected in the same tests. If a session of that number must stay up, link the new one by QR.

## Flow

```
[Create Session]
      │
      ▼
[Start Session]
      │
      ▼
[Wait for status qr_ready]
      │
      ▼
[Request Pairing Code]
      │
      ▼
[Enter Code in WhatsApp]
      │
      ▼
[Session Connected]
```

## 1. Create a Session

```bash
curl -X POST http://localhost:2785/api/sessions \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "support-bot"
  }'
```

Save the returned session `id`.

## 2. Start the Session

```bash
curl -X POST http://localhost:2785/api/sessions/{sessionId}/start \
  -H "X-API-Key: $API_KEY"
```

The session must be started before requesting a pairing code, and the engine needs a moment to connect after `start` returns. Poll `GET /api/sessions/{sessionId}` until `status` is `qr_ready`: that is the point the engine can accept a pairing request. Requesting a code before that returns 409. Treat `qr_ready` as the signal to try, not a guarantee: on Baileys the socket can already be closing while the status has not caught up, so a 409 is still possible for a few seconds and is worth one retry.

## 3. Request a Pairing Code

```bash
curl -X POST http://localhost:2785/api/sessions/{sessionId}/pairing-code \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "628123456789"
  }'
```

`phoneNumber` must be digits only in international format: country code + number, without `+`, spaces, or dashes.

Example values:

| Country       | Example        |
| ------------- | -------------- |
| Indonesia     | `628123456789` |
| Spain         | `34612345678`  |
| United States | `14155552671`  |

## Response

```json
{
  "pairingCode": "ABCD1234",
  "status": "qr_ready"
}
```

## 4. Enter the Code in WhatsApp

On the phone that owns the WhatsApp account:

1. Open WhatsApp.
2. Go to **Settings**.
3. Open **Linked Devices**.
4. Choose **Link with phone number**.
5. Enter the pairing code returned by OpenWA.

After the code is accepted, the OpenWA session should move to a connected/ready state.

## Troubleshooting

- If OpenWA returns `Session is not started`, call `POST /api/sessions/{sessionId}/start` first.
- If OpenWA returns `Session is already authenticated`, the account is already linked and no pairing code is needed. Nothing refuses a request whose number is linked to a DIFFERENT session, or to a device outside this gateway, and on whatsapp-web.js that is the request that can unlink it; see the warning at the top.
- If OpenWA returns 409 `Session is not waiting to be linked`, the engine is still connecting (or reconnecting after a drop). Wait for `status` to read `qr_ready` and request again. After a code was accepted the same 409 is answered until the session is `ready`; do not request another code then. On Baileys the same 409 can also answer while `status` already reads `qr_ready`, for as long as the WebSocket takes to finish closing (up to 30 s on a silently dropped connection); retry rather than treating it as a bad state.
- If the phone number is rejected, send digits only in international format, without `+`, spaces, or punctuation.
- If pairing keeps failing with a generic "check the phone number" rejection even though the number is correct and in the right format, WhatsApp is refusing the linked-device identity for that account rather than the number itself. The default device name `OpenWA` is carried into the pairing request, and some accounts reject a non-standard one. Set `BAILEYS_BROWSER_NAME=Ubuntu` (or another standard OS name), restart OpenWA itself (the name is read at boot, so stopping and starting the session is not enough), and request a fresh code.
- If you want to create a brand-new WhatsApp account programmatically, that is outside OpenWA's scope. OpenWA only links an existing WhatsApp account.

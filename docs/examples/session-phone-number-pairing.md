# Session Phone-Number Pairing

OpenWA supports linking an existing WhatsApp account to a session by phone number as an alternative to scanning a QR code.

This flow returns an 8-character pairing code that the user enters in WhatsApp on their phone.

> This does **not** create or register a new WhatsApp account. It only links an existing WhatsApp account as a companion device for an OpenWA session.

## Flow

```
[Create Session]
      │
      ▼
[Start Session]
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

The session must be started before requesting a pairing code.

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

| Country | Example |
| ------- | ------- |
| Indonesia | `628123456789` |
| Spain | `34612345678` |
| United States | `14155552671` |

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
- If OpenWA returns `Session is already authenticated`, the account is already linked and no pairing code is needed.
- If the phone number is rejected, send digits only in international format, without `+`, spaces, or punctuation.
- If you want to create a brand-new WhatsApp account programmatically, that is outside OpenWA's scope. OpenWA only links an existing WhatsApp account.

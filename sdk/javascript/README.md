# @rmyndharis/openwa

This document describes SDK 0.8.0. `groups.setMemberLabel`, the `match` key of the search query, and the `thumbnailUrl` and `thumbnailBase64` fields of `customLinkPreview` require OpenWA 0.27.0 or later. Send idempotency, webhook failure redrive, message-window filters, poll choices, last-message types, and the `event.response` webhook event name require OpenWA 0.25.0 or later. The `message.receipt` and `poll.vote` webhook event names require OpenWA 0.26.0 or later.

Official JavaScript/TypeScript SDK for [OpenWA](https://github.com/rmyndharis/OpenWA), the open-source WhatsApp API Gateway. OpenWA is an independent project, not affiliated with or endorsed by WhatsApp or Meta.

Ships dual CJS + ESM builds with bundled type declarations.

## Install

```bash
npm install @rmyndharis/openwa
```

Requires Node.js >= 18 (relies on the global `fetch`).

## Usage

```typescript
import { OpenWAClient } from '@rmyndharis/openwa';

const client = new OpenWAClient({
  baseUrl: 'https://your-gateway.example.com',
  apiKey: 'owa_k1_…',
});

// Sessions are addressed by the UUID that create() returns, not by name. Create a session once;
// afterwards, find its id with client.sessions.list({ name: 'my-session' }).
const session = await client.sessions.create({ name: 'my-session' });
await client.sessions.start(session.id);

// Link the account before sending: scan sessions.getQrCode (or use sessions.requestPairingCode for a number with no linked session),
// then wait for status 'ready'. An unlinked session answers the send with 409.
const result = await client.messages.sendText(session.id, {
  chatId: '628123456789@c.us',
  text: 'Hello from the OpenWA SDK!',
});
console.log(result.messageId);
```

CommonJS consumers use `require('@rmyndharis/openwa')` identically.

## Messaging

> Voice notes: pass `ptt: true` to `sendAudio` to send a real WhatsApp voice note (PTT). Supply `audio/ogg; codecs=opus` audio for reliable playback; the server defaults the mimetype to that when `ptt` is set without one.

## Errors

Non-2xx responses throw a typed `OpenWAApiError` subclass (`OpenWAAuthError`,
`OpenWAForbiddenError`, `OpenWANotFoundError`, `OpenWAConflictError`,
`OpenWARateLimitError`, `OpenWANotImplementedError`,
`OpenWAServiceUnavailableError` for 503), each carrying `.status` and the parsed
`.body`. Timeouts throw `OpenWATimeoutError`. The SDK does **not** retry — wrap
calls with your own backoff if needed. 503 means the gateway could not complete
the request right now: the path to WhatsApp failed, the gateway is draining or
short of a dependency, or, on Baileys, WhatsApp throttled (code 429) or timed
out (code 408) the request. Back off and retry later instead of at once, because
repeating a throttled request straight away prolongs the throttle; a catalog 503
can persist because WhatsApp may never answer that query, so bound any retry. A
429 from the global rate limiter lifts when its window expires (seconds for the
per-second tier, up to an hour for the hourly tier by default), and
`.retryAfterSeconds` carries its `Retry-After` header, never above 2147483 seconds (about 24.8 days),
so that `retryAfterSeconds * 1000` is always a valid `setTimeout` delay. A 429 whose `.code` is
`"SEND_PACING_LIMITED"` is usually not transient: do not retry it before
`.retryAfterSeconds`, which then comes from the body: a few seconds when only
sends still in flight caused it, the rest of the failure breaker's cooldown
(`SEND_PACING_BREAKER_COOLDOWN_MS`, 15 minutes by default) after a run of send
failures, otherwise up to the next UTC day. Every API error also exposes the
response `.headers`. A 503 does not always prove a write was never carried out:
when WhatsApp timed out, the change may still have been applied, so re-read the
state before repeating it. A throttle on a send or a single write was turned
away before it ran, so nothing was sent or applied; a send also sent nothing
when its recipient lookup failed, its connection closed before the message was
written, or its media or preview image URL could not be fetched through the
session's proxy. Each of these frees a keyed send's `Idempotency-Key`. A group
settings update with several fields applies them one at a time, so a 503 on a
later field, a throttle included, leaves the earlier ones applied; its message
lists them after `already applied:`, so re-read the settings before retrying, or
send one field per request. In a routed deployment a forward that fails before
reaching the owner node answers 503, one that fails after the request reached it
answers 502 or 504, and a 503 from the owner itself is relayed unchanged.

## Receiving webhooks

A webhook configured with a secret signs each delivery in its
`X-OpenWA-Signature` header. Check it with `verifyWebhookSignature` against the
raw request body, exactly as received, and parse the JSON only after the check
passes: a re-serialized body can differ byte for byte and will not verify. The
helper resolves `false` (never throws) for a missing, malformed or non-matching
signature. `WebhookDelivery` types the parsed body.

```typescript
import express from 'express';
import { verifyWebhookSignature, type WebhookDelivery } from '@rmyndharis/openwa';

const app = express();

app.post('/openwa/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!(await verifyWebhookSignature(req.body, req.get('X-OpenWA-Signature'), secret))) {
    return res.status(401).send('Invalid signature');
  }
  const delivery = JSON.parse(req.body.toString('utf8')) as WebhookDelivery;
  // Process delivery.event and delivery.data here.
  return res.status(200).send('OK');
});
```

## Releasing

Publishing to npm is done by the
[`js-sdk-release.yml`](../../.github/workflows/js-sdk-release.yml) workflow,
which authenticates with **npm Trusted Publishing (OIDC)**. There is no npm
token in the workflow or in the repository secrets: npm mints a short-lived
credential from the GitHub OIDC token, and attaches build provenance
automatically. Nothing long-lived exists to leak, expire, or migrate when
2FA-bypass tokens lose direct publish in January 2027.

One-time setup, required **before** the first tag — on npmjs.com, open the
package settings for `@rmyndharis/openwa` and add a Trusted Publisher:

- Provider: **GitHub Actions**
- Organization: `rmyndharis`
- Repository: `OpenWA`
- Workflow filename: `js-sdk-release.yml` (the extension is part of the value)

There are no repository secrets to add. Until the trusted publisher exists npm
rejects the publish, so configure it first.

Cutting a release:

1. Bump `version` in `package.json` and land it on `main`.
2. Tag that commit `js-sdk-v<version>` (e.g. `js-sdk-v0.8.0`) and push the tag.
   The SDK has its own version line — the monorepo's `v*` tags are the app
   version and never trigger an SDK publish.
3. The workflow audits the SDK lockfile (`npm audit --audit-level=high`),
   re-runs the SDK's tests, typecheck, build and dual CJS/ESM smoke check
   (packaging plus requests through each build's client), then packs the
   tarball. A second job, the only one that can mint the publish credential,
   uploads that tarball and runs no project code: the published bytes are the
   ones those gates passed, not a later rebuild. It receives the tarball as a
   workflow artifact and passes its absolute path to `npm publish`, which takes
   one file, so a missing or a second tarball fails the release.

## Send idempotency

The example below requires SDK 0.6.0 or later and OpenWA 0.25.0 or later. SDK 0.5.1 does not expose this per-send key argument.

Supply a unique caller-owned key for one logical send and reuse it when retrying that same call. Keys contain 1-255 visible ASCII characters; unrelated calls must use different keys. The SDK forwards the key without changing its retry policy or generating one automatically.

```javascript
await client.messages.sendText(sessionId, { chatId: '628123@c.us', text: 'Hello' }, 'order-123');
```

The gateway supports text, image, video, audio, document, sticker, location, contact, template, poll, reply and forward sends. Completed calls replay their response; a 409 with the error `code` `IDEMPOTENCY_KEY_IN_PROGRESS` means the first request is still running, so retry with the same key later; a 409 `IDEMPOTENCY_OUTCOME_UNKNOWN` means the message may have been sent, so check the chat and, if it did not arrive, send again with a new key (the `code` tells them apart from the 409 for a session that is not connected). A changed request with the same key returns 422. The gateway retains keys for 24 hours. Bulk, product and button operations have no such guarantee. Omit the key to preserve existing behavior.

## License

MIT

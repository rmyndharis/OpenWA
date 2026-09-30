# @rmyndharis/openwa

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
`OpenWAServiceUnavailableError` for 503), each carrying `.status` and the
parsed `.body`. Timeouts throw `OpenWATimeoutError`. The SDK does **not**
retry — wrap calls with your own backoff if needed. 503 is transient, but a
catalog 503 can persist because WhatsApp may never answer that query, so bound
any retry. A 429 from the global rate limiter lifts when its window expires
(seconds for the per-second tier, up to an hour for the hourly tier by
default), and `.retryAfterSeconds` carries its `Retry-After` header. A 429 whose
`.code` is `"SEND_PACING_LIMITED"` is not transient: do not retry it before
`.retryAfterSeconds`, which then comes from the body and can be hours. Every API
error also exposes the response `.headers`. In a routed deployment only 503
proves the request was never carried out: a forward that fails after the request
reached the owner node answers 502 or 504.

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
2. Tag that commit `js-sdk-v<version>` (e.g. `js-sdk-v0.5.0`) and push the tag.
   The SDK has its own version line — the monorepo's `v*` tags are the app
   version and never trigger an SDK publish.
3. The workflow re-runs the SDK's tests, typecheck, build and dual CJS/ESM
   smoke check, then publishes. The published tarball is the one those gates
   passed, not a later rebuild.

## License

MIT

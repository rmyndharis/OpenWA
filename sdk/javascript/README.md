# @rmyndharis/openwa

Official JavaScript/TypeScript SDK for the [OpenWA](https://github.com/rmyndharis/OpenWA) WhatsApp API Gateway.

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

await client.sessions.start('my-session');

const result = await client.messages.sendText('my-session', {
  chatId: '628123456789@c.us',
  text: 'Hello from the OpenWA SDK!',
});
console.log(result.messageId);
```

CommonJS consumers use `require('@rmyndharis/openwa')` identically.

## Messaging

> Voice notes: pass `ptt: true` to `sendAudio` to send a real WhatsApp voice note (PTT). Supply `audio/ogg; codecs=opus` audio for reliable playback; the server defaults the mimetype to that when `ptt` is set without one.

## Errors

Non-2xx responses throw a typed `OpenWAApiError` subclass
(`OpenWAAuthError`, `OpenWAForbiddenError`, `OpenWANotFoundError`,
`OpenWAConflictError`, `OpenWARateLimitError`, `OpenWANotImplementedError`),
each carrying `.status` and the parsed `.body`. Timeouts throw
`OpenWATimeoutError`. The SDK does **not** retry — wrap calls with your own
backoff if needed.

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
2. Tag that commit `js-sdk-v<version>` (e.g. `js-sdk-v0.2.0`) and push the tag.
   The SDK has its own version line — the monorepo's `v*` tags are the app
   version and never trigger an SDK publish.
3. The workflow re-runs the SDK's tests, typecheck, build and dual CJS/ESM
   smoke check, then publishes. The published tarball is the one those gates
   passed, not a later rebuild.

## License

MIT

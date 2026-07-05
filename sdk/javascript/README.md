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

## License

MIT

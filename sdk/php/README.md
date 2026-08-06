# rmyndharis/openwa

Official PHP SDK for the [OpenWA](https://github.com/rmyndharis/OpenWA) WhatsApp API Gateway.

A synchronous client built on [Guzzle](https://docs.guzzlephp.org/), PSR-4 autoloaded.

## Install

```bash
composer require rmyndharis/openwa
```

Requires PHP 8.1+ and Guzzle 7. The namespace is `OpenWA\`.

## Usage

```php
<?php
require 'vendor/autoload.php';

use OpenWA\Client;

$client = new Client([
    'baseUrl' => 'https://your-gateway.example.com',
    'apiKey'  => 'owa_k1_…',
]);

$client->sessions->start('my-session');

$result = $client->messages->sendText('my-session', [
    'chatId' => '628123456789@c.us',
    'text'   => 'Hello from the OpenWA PHP SDK!',
]);
echo $result['messageId'];
```

For tests, inject a Guzzle client whose handler is a `MockHandler` — no network, no global state:

```php
$client = new Client([
    'baseUrl'    => 'http://x',
    'apiKey'     => 'k',
    'httpClient' => $mockGuzzleClient,
]);
```

## Messaging

> Voice notes: pass `'ptt' => true` to `sendAudio` to send a real WhatsApp voice note (PTT). Supply `audio/ogg; codecs=opus` audio for reliable playback; the server defaults the mimetype to that when `ptt` is set without one.

## Errors

A non-2xx response throws a typed `OpenWA\Exceptions\OpenWAApiException` subclass —
`OpenWAAuthException` (401), `OpenWAForbiddenException` (403), `OpenWANotFoundException` (404),
`OpenWAConflictException` (409), `OpenWARateLimitException` (429),
`OpenWANotImplementedException` (501) — each exposing `getStatus()` and the parsed `getBody()`.
A timeout throws `OpenWATimeoutException`.

```php
use OpenWA\Exceptions\OpenWANotFoundException;

try {
    $client->sessions->get('missing');
} catch (OpenWANotFoundException $e) {
    echo $e->getStatus();  // 404
}
```

## Notes

- **Use HTTPS in production** — the API key is sent as `X-API-Key` and is bearer-equivalent.
- The SDK does **not** retry, and **never follows redirects** (so the key is never re-sent to
  a redirect target). Path segments are percent-encoded; a base-URL path prefix (e.g. behind a
  reverse proxy) is preserved.
- Escape hatch for endpoints the SDK does not wrap:
  `$client->request($method, $path, $query, $body)`.

## Releasing

Packagist installs this SDK from the mirror repository
[`rmyndharis/openwa-php`](https://github.com/rmyndharis/openwa-php), not from the
monorepo — Composer needs `composer.json` at a repository root and does not
support subdirectories. Two workflows keep that mirror correct:

- [`split-php-sdk.yml`](../../.github/workflows/split-php-sdk.yml) syncs the
  mirror's `main` on every push that touches `sdk/php/**`, which is what
  Packagist's `dev-main` follows.
- [`php-sdk-release.yml`](../../.github/workflows/php-sdk-release.yml) cuts a
  versioned release by pushing a **tag** to the mirror. Packagist derives
  versions from that repository's tags, so a tag in this monorepo alone
  publishes nothing.

There is no `version` field in `composer.json`, and there should not be —
Composer takes the version from the tag, and a hardcoded field drifts. **The tag
is the version.**

Cutting a release:

1. If the minor line changes, update `extra.branch-alias.dev-main` in
   `composer.json` (e.g. `0.1.x-dev` → `0.2.x-dev`) and land it on `main`. The
   release workflow refuses to publish when the alias does not match the tag.
2. Tag that commit `php-sdk-v<version>` (e.g. `php-sdk-v0.2.0`) and push the
   tag. The SDK has its own version line — the monorepo's `v*` tags are the app
   version and never trigger an SDK release.
3. The workflow runs the test suite, then tags the mirror `<version>` (no `v`
   prefix, matching the existing tags there). Packagist picks it up from its
   GitHub hook within a minute or two.

> **A released version is effectively immutable.** Packagist caches a tag's
> contents, so moving one does not reliably reach anyone who already resolved
> it. The workflow refuses to overwrite an existing mirror tag — bump the
> version instead of re-tagging.

Requires the `PHP_SDK_SPLIT_TOKEN` secret, the same one the mirror workflow
uses. Unlike the mirror workflow, which skips with a notice when the token is
absent, the release **fails**: a release that silently publishes nothing looks
exactly like one that worked.

## License

MIT

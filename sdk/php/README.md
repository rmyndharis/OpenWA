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

## License

MIT

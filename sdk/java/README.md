# OpenWA Java SDK

Official Java client for [OpenWA](https://github.com/rmyndharis/OpenWA), the
open-source WhatsApp API Gateway. OpenWA is an independent project, not
affiliated with or endorsed by WhatsApp or Meta.

Hand-written against the exact API surface (paths, DTOs, response shapes) and
unit-tested with a mock HTTP transport that asserts on the precise request URL,
method, and body — so contract drift is caught at test time. Synchronous,
Java 17+, one runtime dependency ([Gson](https://github.com/google/gson)).

## Install

**Maven**

```xml
<dependency>
  <groupId>com.rmyndharis</groupId>
  <artifactId>openwa</artifactId>
  <version>0.5.0</version>
</dependency>
```

**Gradle**

```groovy
implementation 'com.rmyndharis:openwa:0.5.0'
```

## Quickstart

```java
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.model.CreateSessionRequest;
import com.rmyndharis.openwa.model.MessageResponse;
import com.rmyndharis.openwa.model.SendTextRequest;
import com.rmyndharis.openwa.model.SessionResponse;

OpenWAClient client = new OpenWAClient("http://localhost:2785", "owa_k1_…");

// Sessions are addressed by the UUID that create() returns, not by name. Create a session once;
// afterwards, find its id with client.sessions.list(ListSessionsQuery.builder().name("my-session").build()).
SessionResponse session = client.sessions.create(CreateSessionRequest.builder().name("my-session").build());
client.sessions.start(session.id());

MessageResponse result = client.messages.sendText(session.id(),
    SendTextRequest.builder()
        .chatId("628123456789@c.us")
        .text("Hello from the OpenWA Java SDK!")
        .build());

System.out.println(result.messageId());
```

For full control over configuration (timeout, default headers, a custom
transport), build a `ClientConfig`:

```java
import com.rmyndharis.openwa.ClientConfig;
import java.time.Duration;

OpenWAClient client = new OpenWAClient(ClientConfig.builder()
    .baseUrl("https://wa.example.com")
    .apiKey("owa_k1_…")
    .timeout(Duration.ofSeconds(15))
    .build());
```

## Resources

The client exposes the same fluent resource surface as the JavaScript, Python,
and PHP SDKs:

`sessions` · `messages` · `contacts` · `groups` · `webhooks` · `chats` ·
`labels` · `channels` · `catalog` · `status` · `templates` · `health` · `search` ·
`profile` · `calls` · `media`,
plus `client.auth()`.

Operator-only modules (`docker`, `metrics`, `infra`, `plugins`, `mcp`) are
intentionally not exposed; all user-facing resources are.

`UpdateWebhookRequest` omits null fields, so `filters(null)` leaves a
webhook's filters unchanged. To remove every filter, pass
`new WebhookFilters(List.of())` instead.

A response enum value newer than this SDK decodes to that enum's `UNKNOWN`
constant (for example `SessionStatus.UNKNOWN`) rather than `null`, so give a
`switch` over one a `default` branch. `WebhookEvent`, `ProxyType` and
`MessageDirection` are also sent in requests and have no `UNKNOWN`: an
unrecognised value there still decodes to `null`.

## Error handling

Errors are a typed, unchecked hierarchy — branch with `instanceof` or on
`.status()`:

```java
import com.rmyndharis.openwa.errors.OpenWAConflictError;
import com.rmyndharis.openwa.errors.OpenWANotFoundError;

try {
    client.messages.sendText(sessionId, body);
} catch (OpenWAConflictError e) {
    // 409 — engine not ready
} catch (OpenWANotFoundError e) {
    // 404 — session or chat not found
}
```

| Class                           | HTTP | Meaning                                 |
| ------------------------------- | ---- | --------------------------------------- |
| `OpenWAAuthError`               | 401  | Missing or invalid API key              |
| `OpenWAForbiddenError`          | 403  | API key role or scope refuses the call  |
| `OpenWANotFoundError`           | 404  | Resource not found                      |
| `OpenWAConflictError`           | 409  | Engine not ready                        |
| `OpenWARateLimitError`          | 429  | Rate limited                            |
| `OpenWANotImplementedError`     | 501  | Active engine does not support the call |
| `OpenWAServiceUnavailableError` | 503  | Engine did not confirm in time          |
| `OpenWAApiError`                | —    | Any other non-2xx (carries `.status()`) |
| `OpenWATimeoutError`            | —    | Request exceeded the configured timeout |

All extend `OpenWAError` (a `RuntimeException`). 503 is transient, but a catalog 503 can persist because WhatsApp may never answer that query, so bound any retry. A 429 from the global rate limiter lifts when its window expires (seconds for the per-second tier, up to an hour for the hourly tier by default), and `retryAfterSeconds()` carries its `Retry-After` header. A 429 whose `code()` is `"SEND_PACING_LIMITED"` is not transient: do not retry it before `retryAfterSeconds()`, which then comes from the body and can be hours. `headers()` returns the response headers. In a routed deployment only 503 proves the request was never carried out: a forward that fails after the request reached the owner node answers 502 or 504.

## Reliability & security

- **Use HTTPS in production.** The API key is sent as `X-API-Key` on every
  request and is bearer-equivalent — never send it over plaintext `http://`
  outside local development.
- **No automatic retries.** A failed request throws immediately; wrap calls in
  your own backoff if you need retries (especially for `429`). Inject a custom
  `HttpTransport` for retry or observability middleware.
- **Redirects are never followed.** A `3xx` surfaces as an `OpenWAApiError`
  rather than being followed, so the API key is never re-sent to a redirect
  target.
- **Default per-request timeout** is 30 s (configurable). Path segments (chat /
  message ids) are percent-encoded; a base-URL path prefix (e.g. behind a proxy
  at `/v1`) is preserved.
- **Empty and dot ids are refused.** An empty, `.` or `..` id throws
  `IllegalArgumentException` and nothing is sent, so a proxy that resolves dot
  segments cannot turn the call into one on the parent resource. The raw
  `request*` methods refuse a `.` or `..` segment the same way but send an
  empty one (a trailing slash) as written.

## Development

```bash
cd sdk/java
mvn -B verify        # compile + run the full test suite
```

Tests inject a recording `HttpTransport` and assert on the exact path — so the
regression that would ship a broken `messages/text` path (the real path is
`messages/send-text`) can never recur silently.

## Releasing

Publishing to Maven Central is done by the
[`java-sdk-release.yml`](../../.github/workflows/java-sdk-release.yml) workflow,
which deploys with `mvn -B -Prelease deploy`. The `release` profile attaches the
sources/javadoc jars, GPG-signs every artifact, and auto-publishes via the
Sonatype Central Publishing plugin — a plain `mvn verify` never runs any of it.

One-time setup (repository secrets):

- `MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD` — the two halves of a
  Sonatype Central Portal user token for the verified `com.rmyndharis`
  namespace.
- `GPG_PRIVATE_KEY` — ASCII-armored signing key.
- `GPG_PASSPHRASE` — passphrase for that key.

All four secrets are checked before anything is built, and a missing one **fails
the run**. That is deliberate: skipping the deploy and reporting green is
indistinguishable from a real release in the run list, so configure the secrets
before tagging rather than tagging to see what happens.

Cutting a release:

1. Bump `<version>` in `pom.xml` and land it on `main`.
2. Tag that commit `java-sdk-v<version>` (e.g. `java-sdk-v0.5.0`) and push the
   tag. The SDK has its own version line — the monorepo's `v*` tags are the app
   version and never trigger an SDK publish.
3. The workflow builds, signs, and publishes; Central syncs within a few hours.

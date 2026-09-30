# OpenWA Go SDK

Idiomatic Go client for the [OpenWA](https://github.com/rmyndharis/OpenWA) WhatsApp
API Gateway. Stdlib-only (no dependencies), context-first, with typed errors and
an injectable transport pipeline.

OpenWA is an independent project, not affiliated with or endorsed by WhatsApp or
Meta.

```bash
go get github.com/rmyndharis/OpenWA/sdk/go
```

Requires Go 1.22+.

## Quick start

```go
package main

import (
	"context"
	"log"

	openwa "github.com/rmyndharis/OpenWA/sdk/go"
)

func main() {
	client, err := openwa.New("http://localhost:2785", "owa_k1_…")
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	// Sessions are addressed by the UUID that Create returns, not by name. Create a
	// session once; afterwards, find its ID with Sessions.List and a Name filter.
	session, err := client.Sessions.Create(ctx, openwa.CreateSessionRequest{Name: "my-session"})
	if err != nil {
		log.Fatal(err)
	}
	if _, err := client.Sessions.Start(ctx, session.ID); err != nil {
		log.Fatal(err)
	}

	res, err := client.Messages.SendText(ctx, session.ID, openwa.SendTextRequest{
		ChatID: "628123456789@c.us",
		Text:   "Hello from the OpenWA Go SDK!",
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Println(res.MessageID)
}
```

## Design

- **Client entry point** — `openwa.New(baseURL, apiKey, opts...)` returns a
  `*Client`. Required credentials are positional; everything else is a functional
  Option. The client is safe for concurrent use.
- **Services by domain** — the API is grouped onto exported fields:
  `client.Sessions`, `client.Messages`, `client.Contacts`, `client.Groups`,
  `client.Webhooks`, `client.Chats`, `client.Status`, `client.Labels`,
  `client.Channels`, `client.Catalog`, `client.Templates`, `client.Health`,
  `client.Search`, `client.Auth`, `client.Profile`, `client.Calls`,
  `client.Media`.
- **Context-first** — every network method takes `ctx context.Context` as its
  first argument; the context bounds the request (and any retries).
- **Functional options + DI** — inject dependencies instead of relying on
  globals: `WithHTTPClient`, `WithTransport`, `WithLogger`, `WithRetry`,
  `WithMiddleware`, `WithTimeout`, `WithUserAgent`, `WithHeader`.
- **Typed errors** — match with `errors.Is` against the sentinels, or unwrap the
  concrete `*APIError` with `errors.As`.

## Configuration

| Option                  | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `WithTimeout(d)`        | Per-request timeout (default 30s).                             |
| `WithHTTPClient(hc)`    | Inject a preconfigured `*http.Client` (pool, jar, timeout).    |
| `WithTransport(rt)`     | Inject the base `http.RoundTripper` (proxy, TLS, test double). |
| `WithLogger(l)`         | Inject a `Logger` (default: no-op).                            |
| `WithRetry(p)`          | Enable automatic retries (off by default).                     |
| `WithMiddleware(mw...)` | Add transport middleware (tracing, metrics, auth).             |
| `WithUserAgent(ua)`     | Override the `User-Agent`.                                     |
| `WithHeader(k, v)`      | Add a default header on every request.                         |
| `WithInsecureHTTP()`    | Suppress the plaintext-`http://` warning.                      |

## Typed errors

```go
res, err := client.Messages.SendText(ctx, sessionID, req)
switch {
case errors.Is(err, openwa.ErrConflict):
	// 409 — engine not ready; retry once the session is "ready".
case errors.Is(err, openwa.ErrNotFound):
	// 404 — unknown session/resource.
case err != nil:
	var apiErr *openwa.APIError
	if errors.As(err, &apiErr) {
		log.Printf("API %d: %s (body: %v)", apiErr.StatusCode, apiErr.Message, apiErr.Body)
	}
}
```

Sentinels: `ErrUnauthorized` (401), `ErrForbidden` (403), `ErrNotFound` (404),
`ErrConflict` (409), `ErrRateLimited` (429), `ErrNotImplemented` (501),
`ErrServiceUnavailable` (503). 503 is transient, but a catalog 503 can persist
because WhatsApp may never answer that query, so bound any retry. A 429 from
the global rate limiter lifts when its window expires (seconds for the
per-second tier, up to an hour for the hourly tier by default);
`APIError.RetryAfter` carries its `Retry-After` header, which `WithRetry` also
honors. A 429 whose `APIError.Code` is `"SEND_PACING_LIMITED"` is not transient:
do not retry it before `RetryAfter`, which then comes from the body and can be
hours. `APIError.Header` holds the response headers. A timeout surfaces as
`*openwa.TimeoutError`. In a routed deployment only 503 proves the request was
never carried out: a forward that fails after the request reached the owner node
answers 502 or 504.

## Retries

Off by default. Opt in with a policy. Idempotent requests (GET, HEAD, OPTIONS,
PUT, DELETE) are retried on network errors and on the policy's statuses (default
429/500/502/503/504). A POST or PATCH (every send endpoint is a POST) is never
retried after a network error and is retried only on 429 or 503 (when the policy
lists them): a 500/502/504 can arrive after the message was already sent, so
replaying it could send it twice. A 429 whose body has `code: "SEND_PACING_LIMITED"` is
never retried, whatever the method: its delay is the body's `retryAfterSeconds`, which can be
hours. Backoff is exponential, `Retry-After` is honored, and request bodies are safely rewound
on each attempt.

```go
client, _ := openwa.New(baseURL, apiKey,
	openwa.WithRetry(openwa.DefaultRetryPolicy()),
)
```

## Middleware / transport pipeline

Inject cross-cutting concerns (tracing, metrics, custom auth) as `Middleware`.
The first middleware is the outermost layer. The SDK's own auth, logging, and
retry layers sit inside yours, so every attempt is authenticated and observable.

```go
tracing := func(next http.RoundTripper) http.RoundTripper {
	return openwa.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		// start span, inject headers…
		return next.RoundTrip(req)
	})
}
client, _ := openwa.New(baseURL, apiKey, openwa.WithMiddleware(tracing))
```

## Dependency injection & testing

Inject a mock `http.RoundTripper` — no network, no global state:

```go
type mockRT struct{}
func (mockRT) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(`{"messageId":"m1","timestamp":1}`)),
		Header:     http.Header{},
	}, nil
}

client, _ := openwa.New("https://api.test", "key", openwa.WithTransport(mockRT{}))
```

## Escape hatch

For endpoints the typed services don't cover, use `client.Do`:

```go
var out map[string]any
err := client.Do(ctx, "GET", "/api/some/new/path", nil, nil, &out)
```

## Security & reliability

- **Use HTTPS in production.** The API key is sent as `X-API-Key` on every
  request and is bearer-equivalent. Over plaintext `http://` to a non-localhost
  host the SDK logs a warning (silence it with `WithInsecureHTTP`).
- **Redirects are never followed** — a `3xx` surfaces as an `*APIError` rather
  than re-sending the API key to the redirect target.
- Path segments (chat/message ids) are percent-encoded; a base-URL path prefix
  (e.g. behind a proxy at `/v1`) is preserved.
- **Empty and dot ids are refused.** An empty, `.` or `..` id returns an error
  and nothing is sent, so a proxy that resolves dot segments cannot turn the
  call into one on the parent resource. `Client.Do` refuses a `.` or `..`
  segment the same way but sends an empty one (a trailing slash) as written.

## Development

```bash
cd sdk/go
go test -race -cover ./...
go vet ./...
```

The `TestRouting` table asserts the exact method and path of every service call,
so a wrong path (the historical `/messages/text` vs `/messages/send-text`) fails
at test time.

## Releasing

There is no publish workflow, and none is possible: Go has no registry to push
to. The module proxy serves whatever a repository tag points at, so **tagging
is the release**.

The tag must carry the module's directory prefix, because the module lives in a
subdirectory rather than at the repository root:

```bash
# Correct — `sdk/go/` prefix, matching `module github.com/rmyndharis/OpenWA/sdk/go`
git tag sdk/go/v0.5.0 && git push origin sdk/go/v0.5.0
```

A bare `v0.5.0` tag is the _app_ version and does nothing for this module.
Without a prefixed tag, `go get` resolves a pseudo-version
(`v0.0.0-<date>-<commit>`) — usable, but callers cannot pin a release.

Cutting a release:

1. Bump `DefaultUserAgent` in `options.go` (it carries the SDK version and is
   sent on every request, so it drifts silently if only the tag moves).
2. Land that on `main`.
3. Tag that commit `sdk/go/v<version>` and push the tag.

> **A published version is immutable.** Once the module proxy has served
> `sdk/go/vX.Y.Z` it caches it permanently — deleting or moving the tag does not
> take it back, and the only remedy is to publish a higher version (and, if the
> bad one must be discouraged, a `retract` directive in `go.mod`). Tag a commit
> that is already green on `main`.

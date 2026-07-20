# OpenWA Go SDK

Idiomatic Go client for the [OpenWA](https://github.com/rmyndharis/OpenWA) WhatsApp
API Gateway. Stdlib-only (no dependencies), context-first, with typed errors and
an injectable transport pipeline.

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
	if _, err := client.Sessions.Start(ctx, "my-session"); err != nil {
		log.Fatal(err)
	}

	res, err := client.Messages.SendText(ctx, "my-session", openwa.SendTextRequest{
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
  `client.Search`, `client.Auth`, `client.Profile`, `client.Calls`.
- **Context-first** — every network method takes `ctx context.Context` as its
  first argument; the context bounds the request (and any retries).
- **Functional options + DI** — inject dependencies instead of relying on
  globals: `WithHTTPClient`, `WithTransport`, `WithLogger`, `WithRetry`,
  `WithMiddleware`, `WithTimeout`, `WithUserAgent`, `WithHeader`.
- **Typed errors** — match with `errors.Is` against the sentinels, or unwrap the
  concrete `*APIError` with `errors.As`.

## Configuration

| Option | Purpose |
| ------ | ------- |
| `WithTimeout(d)` | Per-request timeout (default 30s). |
| `WithHTTPClient(hc)` | Inject a preconfigured `*http.Client` (pool, jar, timeout). |
| `WithTransport(rt)` | Inject the base `http.RoundTripper` (proxy, TLS, test double). |
| `WithLogger(l)` | Inject a `Logger` (default: no-op). |
| `WithRetry(p)` | Enable automatic retries (off by default). |
| `WithMiddleware(mw...)` | Add transport middleware (tracing, metrics, auth). |
| `WithUserAgent(ua)` | Override the `User-Agent`. |
| `WithHeader(k, v)` | Add a default header on every request. |
| `WithInsecureHTTP()` | Suppress the plaintext-`http://` warning. |

## Typed errors

```go
res, err := client.Messages.SendText(ctx, "my-session", req)
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
`ErrConflict` (409), `ErrRateLimited` (429), `ErrNotImplemented` (501). A timeout
surfaces as `*openwa.TimeoutError`.

## Retries

Off by default. Opt in with a policy; only network errors and retryable statuses
(429/5xx) are retried, with exponential backoff and `Retry-After` support.
Request bodies are safely rewound on each attempt.

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

## Development

```bash
cd sdk/go
go test -race -cover ./...
go vet ./...
```

The `TestRouting` table asserts the exact method and path of every service call,
so a wrong path (the historical `/messages/text` vs `/messages/send-text`) fails
at test time.

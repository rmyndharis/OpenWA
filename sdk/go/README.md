# OpenWA Go SDK

This document describes `main`. Send idempotency, webhook failure redrive, message-window filters, poll choices, and last-message types are unreleased additions after SDK 0.5.1 and require the corresponding server changes after OpenWA 0.24.0.

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

	// Link the account before sending: scan Sessions.QRCode or use Sessions.RequestPairingCode,
	// then wait for status "ready". An unlinked session answers the send with 409.
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

Sentinels: `ErrBadRequest` (400), `ErrUnauthorized` (401),
`ErrForbidden` (403), `ErrNotFound` (404), `ErrConflict` (409),
`ErrRateLimited` (429), `ErrNotImplemented` (501),
`ErrServiceUnavailable` (503). 503 is transient, but a catalog 503 can persist
because WhatsApp may never answer that query, so bound any retry. A 429 from
the global rate limiter lifts when its window expires (seconds for the
per-second tier, up to an hour for the hourly tier by default);
`APIError.RetryAfter` carries its `Retry-After` header, which `WithRetry` also
honors. A 429 whose `APIError.Code` is `"SEND_PACING_LIMITED"` is usually not
transient: do not retry it before `RetryAfter`, which then comes from the body:
a few seconds when only sends still in flight caused it, the rest of the failure
breaker's cooldown (`SEND_PACING_BREAKER_COOLDOWN_MS`, 15 minutes by default)
after a run of send failures, otherwise up to the next UTC day. `APIError.Header`
holds the response headers. A timeout surfaces as `*openwa.TimeoutError`. A 503
does not prove a write was never carried out: the
engine answers it when WhatsApp did not confirm in time, and the change may still
have been applied, so re-read the state before repeating it. In a routed
deployment a forward that fails before reaching the owner node answers 503, one
that fails after the request reached it answers 502 or 504, and a 503 from the
owner itself is relayed unchanged.

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

## Receiving webhooks

A webhook configured with a secret signs each delivery in its
`X-OpenWA-Signature` header. Check it with `VerifyWebhookSignature` against the
raw request body, exactly as received, and decode the JSON only after the check
passes: a re-serialized body can differ byte for byte and will not verify. The
helper returns `false` for a missing, malformed or non-matching signature.
`WebhookDelivery` types the decoded body.

```go
http.HandleFunc("/openwa/webhook", func(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if !openwa.VerifyWebhookSignature(body, r.Header.Get("X-OpenWA-Signature"), secret) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var delivery openwa.WebhookDelivery
	if err := json.Unmarshal(body, &delivery); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	// Process delivery.Event and delivery.Data here.
	w.WriteHeader(http.StatusOK)
})
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
git tag sdk/go/v0.5.1 && git push origin sdk/go/v0.5.1
```

A bare `v0.5.1` tag is the _app_ version and does nothing for this module.
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

## Send idempotency

The example below requires the unreleased SDK changes on `main`; SDK 0.5.1 does not expose this per-send key argument. The server must also include the send idempotency changes after OpenWA 0.24.0.

Supply a unique caller-owned key for one logical send and reuse it when retrying that same call. Keys contain 1-255 visible ASCII characters; unrelated calls must use different keys. The SDK forwards the key without changing its retry policy or generating one automatically.

```go
ctx := openwa.WithIdempotencyKey(context.Background(), "order-123")
_, err := client.Messages.SendText(ctx, sessionID, openwa.SendTextRequest{ChatID: "628123@c.us", Text: "Hello"})
```

The gateway supports text, image, video, audio, document, sticker, location, contact, template, poll, reply and forward sends. Completed calls replay their response; pending or uncertain outcomes return 409, and a changed request with the same key returns 422. The gateway retains keys for 24 hours. Bulk, product and button operations have no such guarantee. Omit the key to preserve existing behavior.

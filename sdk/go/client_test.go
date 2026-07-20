package openwa

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// recordTransport is a mock http.RoundTripper that records the last request and
// replies with a canned response. It is injected via WithTransport — no network,
// no global state.
type recordTransport struct {
	status  int
	body    string
	header  http.Header
	lastReq *http.Request
	lastRaw []byte
}

func (t *recordTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	t.lastReq = req
	if req.Body != nil {
		t.lastRaw, _ = io.ReadAll(req.Body)
	}
	h := t.header
	if h == nil {
		h = http.Header{}
	}
	return &http.Response{
		StatusCode: t.status,
		Body:       io.NopCloser(strings.NewReader(t.body)),
		Header:     h,
		Request:    req,
	}, nil
}

func newTestClient(t *testing.T, rt http.RoundTripper, opts ...Option) *Client {
	t.Helper()
	all := append([]Option{WithTransport(rt)}, opts...)
	c, err := New("https://api.example.com", "owa_k1_test", all...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c
}

func TestNewValidation(t *testing.T) {
	if _, err := New("", "key"); err == nil {
		t.Fatal("expected error for empty baseURL")
	}
	if _, err := New("https://x", ""); err == nil {
		t.Fatal("expected error for empty apiKey")
	}
}

func TestSendTextHitsCorrectPath(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"messageId":"m1","timestamp":123}`}
	c := newTestClient(t, rt)

	res, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{
		ChatID: "628123@c.us",
		Text:   "hi",
	})
	if err != nil {
		t.Fatalf("SendText: %v", err)
	}
	if res.MessageID != "m1" || res.Timestamp != 123 {
		t.Fatalf("unexpected response: %+v", res)
	}

	// The historically-broken path was /messages/text; the real one is send-text.
	wantPath := "/api/sessions/s1/messages/send-text"
	if got := rt.lastReq.URL.Path; got != wantPath {
		t.Fatalf("path = %q, want %q", got, wantPath)
	}
	if rt.lastReq.Method != "POST" {
		t.Fatalf("method = %q, want POST", rt.lastReq.Method)
	}
	if got := rt.lastReq.Header.Get("X-API-Key"); got != "owa_k1_test" {
		t.Fatalf("X-API-Key = %q", got)
	}

	var sent SendTextRequest
	if err := json.Unmarshal(rt.lastRaw, &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent.ChatID != "628123@c.us" || sent.Text != "hi" {
		t.Fatalf("sent body = %+v", sent)
	}
}

func TestJIDPathIsReadable(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{}`}
	c := newTestClient(t, rt)

	_, _ = c.Contacts.Check(context.Background(), "s1", "628999@c.us")
	// @ stays readable, not percent-encoded.
	want := "/api/sessions/s1/contacts/check/628999@c.us"
	if got := rt.lastReq.URL.EscapedPath(); got != want {
		t.Fatalf("escaped path = %q, want %q", got, want)
	}
}

func TestQueryEncoding(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"messages":[],"total":0}`}
	c := newTestClient(t, rt)

	_, err := c.Messages.List(context.Background(), "s1", &ListMessagesQuery{
		ChatID: Ptr("628@c.us"),
		Limit:  Ptr(10),
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	q := rt.lastReq.URL.Query()
	if q.Get("chatId") != "628@c.us" || q.Get("limit") != "10" {
		t.Fatalf("query = %v", rt.lastReq.URL.RawQuery)
	}
	if _, ok := q["offset"]; ok {
		t.Fatal("nil offset should not appear in query")
	}
}

func TestNilQueryOmitted(t *testing.T) {
	rt := &recordTransport{status: 200, body: `[]`}
	c := newTestClient(t, rt)

	// Typed-nil pointer must not panic and must send no query string.
	var q *ListContactsQuery
	if _, err := c.Contacts.List(context.Background(), "s1", q); err != nil {
		t.Fatalf("List: %v", err)
	}
	if rt.lastReq.URL.RawQuery != "" {
		t.Fatalf("expected empty query, got %q", rt.lastReq.URL.RawQuery)
	}
}

func TestTypedErrors(t *testing.T) {
	rt := &recordTransport{
		status: 409,
		body:   `{"statusCode":409,"message":"engine not ready","error":"Conflict"}`,
	}
	c := newTestClient(t, rt)

	_, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{ChatID: "x", Text: "y"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("errors.Is ErrConflict = false for %v", err)
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("errors.As *APIError failed for %v", err)
	}
	if apiErr.StatusCode != 409 || apiErr.Kind != "Conflict" || apiErr.Message != "engine not ready" {
		t.Fatalf("APIError = %+v", apiErr)
	}
}

func TestArrayMessageError(t *testing.T) {
	rt := &recordTransport{
		status: 400,
		body:   `{"statusCode":400,"message":["chatId must be a string","text should not be empty"],"error":"Bad Request"}`,
	}
	c := newTestClient(t, rt)

	_, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %v", err)
	}
	if !strings.Contains(apiErr.Message, "chatId must be a string, text should not be empty") {
		t.Fatalf("message = %q", apiErr.Message)
	}
}

func TestRedirectNotFollowed(t *testing.T) {
	rt := &recordTransport{status: 302, body: "", header: http.Header{"Location": {"https://evil.example"}}}
	c := newTestClient(t, rt)
	_, err := c.Sessions.List(context.Background(), nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 302 {
		t.Fatalf("expected 302 APIError, got %v", err)
	}
}

func TestDeleteReturnsNoBody(t *testing.T) {
	rt := &recordTransport{status: 204, body: ""}
	c := newTestClient(t, rt)
	if err := c.Sessions.Delete(context.Background(), "s1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if rt.lastReq.Method != "DELETE" {
		t.Fatalf("method = %q", rt.lastReq.Method)
	}
}

// retryTransport fails the first N calls with a 503, then succeeds. It rewinds
// and asserts the body is present on every attempt.
type retryTransport struct {
	failuresLeft int32
	calls        int32
	gotBodies    []string
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	atomic.AddInt32(&t.calls, 1)
	var b []byte
	if req.Body != nil {
		b, _ = io.ReadAll(req.Body)
	}
	t.gotBodies = append(t.gotBodies, string(b))
	if atomic.AddInt32(&t.failuresLeft, -1) >= 0 {
		return &http.Response{StatusCode: 503, Body: io.NopCloser(bytes.NewReader(nil)), Header: http.Header{}, Request: req}, nil
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"messageId":"ok","timestamp":1}`)), Header: http.Header{}, Request: req}, nil
}

func TestRetryPolicy(t *testing.T) {
	rt := &retryTransport{failuresLeft: 2}
	c := newTestClient(t, rt, WithRetry(RetryPolicy{
		MaxRetries: 3,
		BaseDelay:  time.Millisecond,
		MaxDelay:   5 * time.Millisecond,
	}))

	res, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{ChatID: "x", Text: "y"})
	if err != nil {
		t.Fatalf("SendText with retry: %v", err)
	}
	if res.MessageID != "ok" {
		t.Fatalf("res = %+v", res)
	}
	if rt.calls != 3 {
		t.Fatalf("expected 3 attempts, got %d", rt.calls)
	}
	// Body must be re-sent (rewound) on every attempt.
	for i, b := range rt.gotBodies {
		if !strings.Contains(b, `"chatId":"x"`) {
			t.Fatalf("attempt %d had empty/rewound-broken body: %q", i, b)
		}
	}
}

// statusTransport always replies with the same status, counting attempts.
type statusTransport struct {
	status int
	calls  int32
}

func (t *statusTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	atomic.AddInt32(&t.calls, 1)
	if req.Body != nil {
		io.Copy(io.Discard, req.Body)
	}
	return &http.Response{
		StatusCode: t.status,
		Body:       io.NopCloser(strings.NewReader(`{"statusCode":500,"message":"boom","error":"Internal"}`)),
		Header:     http.Header{},
		Request:    req,
	}, nil
}

// A 500/502/504 can be returned after the gateway already sent the message, so
// replaying a POST on those would double-send. Only 429/503 — which prove the
// server declined before acting — may retry a non-idempotent request.
func TestRetryDoesNotReplayPostOnAmbiguousStatus(t *testing.T) {
	for _, status := range []int{500, 502, 504} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			rt := &statusTransport{status: status}
			c := newTestClient(t, rt, WithRetry(RetryPolicy{
				MaxRetries: 3, BaseDelay: time.Millisecond, MaxDelay: 5 * time.Millisecond,
				RetryableStatuses: []int{429, 500, 502, 503, 504},
			}))

			_, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{ChatID: "x", Text: "y"})
			if err == nil {
				t.Fatal("expected an error")
			}
			if rt.calls != 1 {
				t.Fatalf("POST on %d must not be replayed: got %d attempts, want 1", status, rt.calls)
			}
		})
	}
}

// The same statuses ARE retried for an idempotent method — the conservative
// rule must not blunt retries where replay is safe.
func TestRetryStillReplaysIdempotentOnAmbiguousStatus(t *testing.T) {
	rt := &statusTransport{status: 500}
	c := newTestClient(t, rt, WithRetry(RetryPolicy{
		MaxRetries: 2, BaseDelay: time.Millisecond, MaxDelay: 5 * time.Millisecond,
		RetryableStatuses: []int{429, 500, 502, 503, 504},
	}))

	_, err := c.Sessions.List(context.Background(), nil)
	if err == nil {
		t.Fatal("expected an error")
	}
	if rt.calls != 3 {
		t.Fatalf("GET on 500 should retry: got %d attempts, want 3", rt.calls)
	}
}

// 429/503 mean the server declined before acting, so a POST may still retry.
func TestRetryReplaysPostOnBackpressure(t *testing.T) {
	for _, status := range []int{429, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			rt := &statusTransport{status: status}
			c := newTestClient(t, rt, WithRetry(RetryPolicy{
				MaxRetries: 2, BaseDelay: time.Millisecond, MaxDelay: 5 * time.Millisecond,
				RetryableStatuses: []int{429, 500, 502, 503, 504},
			}))

			_, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{ChatID: "x", Text: "y"})
			if err == nil {
				t.Fatal("expected an error")
			}
			if rt.calls != 3 {
				t.Fatalf("POST on %d is backpressure and should retry: got %d attempts, want 3", status, rt.calls)
			}
		})
	}
}

func TestMiddlewarePipeline(t *testing.T) {
	rt := &recordTransport{status: 200, body: `[]`}
	var hits int32
	mw := func(next http.RoundTripper) http.RoundTripper {
		return RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			atomic.AddInt32(&hits, 1)
			req.Header.Set("X-Trace", "on")
			return next.RoundTrip(req)
		})
	}
	c := newTestClient(t, rt, WithMiddleware(mw))
	if _, err := c.Sessions.List(context.Background(), nil); err != nil {
		t.Fatalf("List: %v", err)
	}
	if hits != 1 {
		t.Fatalf("middleware hits = %d, want 1", hits)
	}
	if rt.lastReq.Header.Get("X-Trace") != "on" {
		t.Fatal("middleware header not propagated")
	}
}

// retryAfterTransport replies once with 429 + Retry-After, then success. It
// records the delay between the two calls so a test can assert Retry-After was
// honored.
type retryAfterTransport struct {
	calls  int32
	stamps []time.Time
	header string
}

func (t *retryAfterTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	atomic.AddInt32(&t.calls, 1)
	t.stamps = append(t.stamps, time.Now())
	if req.Body != nil {
		_, _ = io.ReadAll(req.Body)
	}
	if t.calls == 1 {
		return &http.Response{
			StatusCode: 429,
			Body:       io.NopCloser(strings.NewReader("")),
			Header:     http.Header{"Retry-After": {t.header}},
			Request:    req,
		}, nil
	}
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(`{"messageId":"ok","timestamp":1}`)),
		Header:     http.Header{},
		Request:    req,
	}, nil
}

func TestRetryHonorsRetryAfter(t *testing.T) {
	rt := &retryAfterTransport{header: "1"}
	c := newTestClient(t, rt, WithRetry(RetryPolicy{
		MaxRetries:        2,
		BaseDelay:         time.Millisecond, // computed backoff = 1ms; Retry-After = 1s dominates
		MaxDelay:          10 * time.Millisecond,
		RetryableStatuses: []int{429},
		RespectRetryAfter: true,
	}))

	if _, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{ChatID: "x", Text: "y"}); err != nil {
		t.Fatalf("SendText: %v", err)
	}
	if rt.calls != 2 {
		t.Fatalf("expected 2 attempts, got %d", rt.calls)
	}
	waited := rt.stamps[1].Sub(rt.stamps[0])
	if waited < 900*time.Millisecond {
		t.Fatalf("expected to wait ~1s for Retry-After, waited %s", waited)
	}
}

func TestParseRetryAfterHTTPDate(t *testing.T) {
	resp := &http.Response{Header: http.Header{"Retry-After": {time.Now().Add(2 * time.Second).UTC().Format(http.TimeFormat)}}}
	d, ok := parseRetryAfter(resp)
	if !ok {
		t.Fatal("expected HTTP-date Retry-After to parse")
	}
	if d < time.Second || d > 3*time.Second {
		t.Fatalf("unexpected duration: %s", d)
	}
}

// networkErrTransport always returns a network error, so it exercises the
// "retry on network error" branch instead of the "retry on status code" branch.
type networkErrTransport struct{ calls int32 }

func (t *networkErrTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	atomic.AddInt32(&t.calls, 1)
	return nil, errors.New("simulated network failure")
}

func TestRetrySkipsNonIdempotentOnNetworkError(t *testing.T) {
	rt := &networkErrTransport{}
	c := newTestClient(t, rt, WithRetry(RetryPolicy{
		MaxRetries: 3,
		BaseDelay:  time.Millisecond,
		MaxDelay:   time.Millisecond,
	}))

	// POST is not idempotent: a network error must NOT retry, or a message
	// could be double-sent.
	_, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{ChatID: "x", Text: "y"})
	if err == nil {
		t.Fatal("expected error")
	}
	if rt.calls != 1 {
		t.Fatalf("expected 1 attempt for POST on network error, got %d", rt.calls)
	}
}

func TestRetryIdempotentOnNetworkError(t *testing.T) {
	rt := &networkErrTransport{}
	c := newTestClient(t, rt, WithRetry(RetryPolicy{
		MaxRetries: 2,
		BaseDelay:  time.Millisecond,
		MaxDelay:   time.Millisecond,
	}))

	// GET is idempotent: a network error is safe to retry.
	_, err := c.Sessions.List(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if rt.calls != 3 {
		t.Fatalf("expected 3 attempts (1 + 2 retries) for GET on network error, got %d", rt.calls)
	}
}

func TestBadRequestSentinel(t *testing.T) {
	rt := &recordTransport{
		status: 400,
		body:   `{"statusCode":400,"message":"invalid","error":"Bad Request"}`,
	}
	c := newTestClient(t, rt)
	_, err := c.Messages.SendText(context.Background(), "s1", SendTextRequest{})
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("errors.Is ErrBadRequest = false for %v", err)
	}
}

func TestStatusListEnvelope(t *testing.T) {
	rt := &recordTransport{
		status: 200,
		body:   `{"statuses":[{"id":"s","contact":{"id":"c@c.us","name":"Cat"},"type":"text","mediaUrl":"","caption":"hi"}]}`,
	}
	c := newTestClient(t, rt)

	got, err := c.Status.List(context.Background(), "s1")
	if err != nil {
		t.Fatalf("Status.List: %v", err)
	}
	if len(got) != 1 || got[0].ID != "s" || got[0].Contact.Name != "Cat" {
		t.Fatalf("unexpected decode: %+v", got)
	}
}

func TestHealthReadyDependencyDecode(t *testing.T) {
	rt := &recordTransport{
		status: 200,
		body:   `{"status":"ok","details":{"mainDatabase":{"status":"up"},"dataDatabase":{"status":"up"}}}`,
	}
	c := newTestClient(t, rt)

	res, err := c.Health.Ready(context.Background())
	if err != nil {
		t.Fatalf("Health.Ready: %v", err)
	}
	if res.Details["mainDatabase"].Status != "up" || res.Details["dataDatabase"].Status != "up" {
		t.Fatalf("unexpected details: %+v", res.Details)
	}
}

func TestWithHeaderMultiValue(t *testing.T) {
	rt := &recordTransport{status: 200, body: `[]`}
	c := newTestClient(t, rt,
		WithHeader("X-Trace", "a"),
		WithHeader("X-Trace", "b"),
	)
	if _, err := c.Sessions.List(context.Background(), nil); err != nil {
		t.Fatalf("List: %v", err)
	}
	got := rt.lastReq.Header.Values("X-Trace")
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("X-Trace values = %v, want [a b]", got)
	}
}

func TestWithTimeoutZeroUsesDefault(t *testing.T) {
	rt := &recordTransport{status: 200, body: `[]`}
	c := newTestClient(t, rt, WithTimeout(0))
	if c.timeout != DefaultTimeout {
		t.Fatalf("timeout = %s, want %s", c.timeout, DefaultTimeout)
	}
}

func TestInjectedHTTPClientTimeoutIsHonoredUnlessWithTimeoutIsExplicit(t *testing.T) {
	injected := &http.Client{Timeout: 45 * time.Second}
	c, err := New("http://localhost:2785", "k", WithHTTPClient(injected))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if c.timeout != 45*time.Second {
		t.Fatalf("injected timeout = %s, want 45s", c.timeout)
	}

	c, err = New("http://localhost:2785", "k", WithHTTPClient(injected), WithTimeout(5*time.Second))
	if err != nil {
		t.Fatalf("New explicit: %v", err)
	}
	if c.timeout != 5*time.Second {
		t.Fatalf("explicit timeout = %s, want 5s", c.timeout)
	}
}

func TestBulkMediaContentOmitsChatID(t *testing.T) {
	// The bulk media block must not emit a chatId key — the outer item carries
	// it, and BulkMediaDto rejects a stray empty one via forbidNonWhitelisted.
	body := SendBulkRequest{
		Messages: []BulkMessageItem{{
			ChatID: "628@c.us",
			Type:   "image",
			Content: BulkMessageContent{
				Image: &BulkMediaContent{URL: "https://x/y.png"},
			},
		}},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), `"chatId":""`) {
		t.Fatalf("bulk media block must not emit empty chatId; got: %s", raw)
	}
}

func TestBulkAudioSerializesPTT(t *testing.T) {
	// Bulk audio with PTT must emit "ptt":true so the server sends it as a voice
	// note; the media block must not emit a "caption" key (not whitelisted by
	// BulkMediaDto — caption lives at the content level).
	body := SendBulkRequest{
		Messages: []BulkMessageItem{{
			ChatID: "628@c.us",
			Type:   "audio",
			Content: BulkMessageContent{
				Audio:   &BulkMediaContent{URL: "https://x/v.ogg", PTT: true},
				Caption: "voicenote",
			},
		}},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"ptt":true`) {
		t.Fatalf("bulk audio must emit ptt:true; got: %s", raw)
	}
	audioBlock := string(raw)
	if i := strings.Index(audioBlock, `"audio":{`); i >= 0 {
		if j := strings.Index(audioBlock[i:], "}"); j >= 0 && strings.Contains(audioBlock[i:i+j], `"caption"`) {
			t.Fatalf("bulk media block must not emit caption; got: %s", raw)
		}
	}
}

// capturingLogger records what the SDK logs.
type capturingLogger struct{ msgs []string }

func (l *capturingLogger) Log(_ context.Context, _ string, msg string, _ ...any) {
	l.msgs = append(l.msgs, msg)
}

// The insecure-http warning must reach an injected logger...
func TestInsecureHTTPWarnsInjectedLogger(t *testing.T) {
	lg := &capturingLogger{}
	if _, err := New("http://wa.example.com:2785", "k", WithLogger(lg)); err != nil {
		t.Fatalf("New: %v", err)
	}
	if len(lg.msgs) != 1 || !strings.Contains(lg.msgs[0], "insecure http://") {
		t.Fatalf("expected an insecure-http warning, got %v", lg.msgs)
	}
}

// ...and must stay silent for https, localhost, or when explicitly suppressed.
func TestInsecureHTTPWarningSuppressed(t *testing.T) {
	cases := []struct {
		name string
		url  string
		opts []Option
	}{
		{"https", "https://wa.example.com", nil},
		{"localhost", "http://localhost:2785", nil},
		{"loopback ip", "http://127.0.0.1:2785", nil},
		{"explicitly allowed", "http://wa.example.com", []Option{WithInsecureHTTP()}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lg := &capturingLogger{}
			if _, err := New(tc.url, "k", append([]Option{WithLogger(lg)}, tc.opts...)...); err != nil {
				t.Fatalf("New: %v", err)
			}
			if len(lg.msgs) != 0 {
				t.Fatalf("expected no warning, got %v", lg.msgs)
			}
		})
	}
}

// The server types status timestamps as Date, which serializes to RFC 3339.
func TestStatusTimestampsDecodeRFC3339(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"statuses":[{"id":"s1","contact":{"id":"62@c.us"},"timestamp":"2026-07-17T10:30:00.000Z","expiresAt":"2026-07-18T10:30:00.000Z"}]}`}
	c := newTestClient(t, rt)

	out, err := c.Status.List(context.Background(), "s1")
	if err != nil {
		t.Fatalf("Status.List: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("want 1 status, got %d", len(out))
	}
	got := out[0]
	if want := time.Date(2026, 7, 17, 10, 30, 0, 0, time.UTC); !got.Timestamp.Equal(want) {
		t.Fatalf("Timestamp = %v, want %v", got.Timestamp, want)
	}
	if want := time.Date(2026, 7, 18, 10, 30, 0, 0, time.UTC); !got.ExpiresAt.Equal(want) {
		t.Fatalf("ExpiresAt = %v, want %v", got.ExpiresAt, want)
	}
}

func TestContextCancel(t *testing.T) {
	rt := &recordTransport{status: 200, body: `[]`}
	c := newTestClient(t, rt)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.Sessions.List(ctx, nil)
	if err == nil {
		t.Fatal("expected context cancellation error")
	}
}

// The channel routes return the engine-neutral Channel verbatim (no DTO), so the record must carry
// inviteCode/picture/verified/createdAt and must not invent pictureUrl/role (#754).
func TestChannelListDecodesWireShape(t *testing.T) {
	rt := &recordTransport{
		status: 200,
		body: `[{"id":"123@newsletter","name":"News","description":"d","inviteCode":"abc123",` +
			`"subscriberCount":7,"picture":"https://x/p.jpg","verified":true,"createdAt":1700000000}]`,
	}
	c := newTestClient(t, rt)

	got, err := c.Channels.List(context.Background(), "s1")
	if err != nil {
		t.Fatalf("Channels.List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 channel, got %d", len(got))
	}
	ch := got[0]
	if ch.InviteCode == nil || *ch.InviteCode != "abc123" {
		t.Errorf("InviteCode: %+v", ch.InviteCode)
	}
	if ch.Picture == nil || *ch.Picture != "https://x/p.jpg" {
		t.Errorf("Picture: %+v", ch.Picture)
	}
	if ch.Verified == nil || !*ch.Verified {
		t.Errorf("Verified: %+v", ch.Verified)
	}
	if ch.CreatedAt == nil || *ch.CreatedAt != 1700000000 {
		t.Errorf("CreatedAt: %+v", ch.CreatedAt)
	}
}

// Channel messages are the live engine payload, not the persisted MessageRecord (#754).
func TestChannelMessagesDecodeEngineShape(t *testing.T) {
	rt := &recordTransport{
		status: 200,
		body:   `[{"id":"m1","body":"hi","timestamp":1700000000,"hasMedia":true,"mediaUrl":"https://x/m.jpg"}]`,
	}
	c := newTestClient(t, rt)

	got, err := c.Channels.Messages(context.Background(), "s1", "123@newsletter", nil)
	if err != nil {
		t.Fatalf("Channels.Messages: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 message, got %d", len(got))
	}
	msg := got[0]
	if msg.ID != "m1" || msg.Body != "hi" || msg.Timestamp != 1700000000 {
		t.Errorf("scalar decode: %+v", msg)
	}
	if !msg.HasMedia {
		t.Errorf("HasMedia: %+v", msg.HasMedia)
	}
	if msg.MediaURL != "https://x/m.jpg" {
		t.Errorf("MediaURL: %q", msg.MediaURL)
	}
}

func TestEditMessage(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"messageId":"m1","timestamp":1700000001}`}
	c := newTestClient(t, rt)

	res, err := c.Messages.EditMessage(context.Background(), "s1", EditMessageRequest{
		ChatID:    "628123@c.us",
		MessageID: "m1",
		Body:      "edited",
	})
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if res.MessageID != "m1" || res.Timestamp != 1700000001 {
		t.Fatalf("unexpected response: %+v", res)
	}

	wantPath := "/api/sessions/s1/messages/edit"
	if got := rt.lastReq.URL.Path; got != wantPath {
		t.Fatalf("path = %q, want %q", got, wantPath)
	}
	if rt.lastReq.Method != "POST" {
		t.Fatalf("method = %q, want POST", rt.lastReq.Method)
	}

	var sent EditMessageRequest
	if err := json.Unmarshal(rt.lastRaw, &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent.ChatID != "628123@c.us" || sent.MessageID != "m1" || sent.Body != "edited" {
		t.Fatalf("sent body = %+v", sent)
	}
}

func TestEditMessageNotFound(t *testing.T) {
	rt := &recordTransport{
		status: 404,
		body:   `{"statusCode":404,"message":"Message not found","error":"Not Found"}`,
	}
	c := newTestClient(t, rt)

	_, err := c.Messages.EditMessage(context.Background(), "s1", EditMessageRequest{
		ChatID: "x", MessageID: "nope", Body: "y",
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("errors.Is ErrNotFound = false for %v", err)
	}
}

func TestJoinGroup(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"success":true,"groupId":"120363@g.us"}`}
	c := newTestClient(t, rt)

	res, err := c.Groups.JoinGroup(context.Background(), "s1", JoinGroupRequest{InviteCode: "abc123"})
	if err != nil {
		t.Fatalf("JoinGroup: %v", err)
	}
	if !res.Success || res.GroupID != "120363@g.us" {
		t.Fatalf("unexpected response: %+v", res)
	}

	var sent JoinGroupRequest
	if err := json.Unmarshal(rt.lastRaw, &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent.InviteCode != "abc123" {
		t.Fatalf("sent body = %+v", sent)
	}
}

func TestGetGroupSettings(t *testing.T) {
	// ephemeralSeconds is absent when the engine does not report it — it must
	// decode as nil, not as a zero-valued present field.
	rt := &recordTransport{status: 200, body: `{"announce":true,"locked":false}`}
	c := newTestClient(t, rt)

	got, err := c.Groups.GetGroupSettings(context.Background(), "s1", "g1")
	if err != nil {
		t.Fatalf("GetGroupSettings: %v", err)
	}
	if got.Announce == nil || !*got.Announce {
		t.Errorf("Announce: %+v", got.Announce)
	}
	if got.Locked == nil || *got.Locked {
		t.Errorf("Locked: %+v", got.Locked)
	}
	if got.EphemeralSeconds != nil {
		t.Errorf("EphemeralSeconds should be nil when absent, got %+v", *got.EphemeralSeconds)
	}
}

// An update must only touch the settings that were set — unset pointer fields
// are omitted from the body so the server leaves them alone.
func TestUpdateGroupSettingsOmitsUnsetFields(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"success":true,"message":"Group settings updated"}`}
	c := newTestClient(t, rt)

	res, err := c.Groups.UpdateGroupSettings(context.Background(), "s1", "g1", GroupSettings{Announce: Ptr(true)})
	if err != nil {
		t.Fatalf("UpdateGroupSettings: %v", err)
	}
	if !res.Success || res.Message != "Group settings updated" {
		t.Fatalf("unexpected response: %+v", res)
	}
	if rt.lastReq.Method != "PUT" {
		t.Fatalf("method = %q, want PUT", rt.lastReq.Method)
	}

	var sent map[string]any
	if err := json.Unmarshal(rt.lastRaw, &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent["announce"] != true {
		t.Fatalf("announce = %v", sent["announce"])
	}
	if _, ok := sent["locked"]; ok {
		t.Fatal("unset locked should be omitted from body")
	}
	if _, ok := sent["ephemeralSeconds"]; ok {
		t.Fatal("unset ephemeralSeconds should be omitted from body")
	}
}

// Setting ephemeralSeconds on the whatsapp-web.js engine surfaces as 501.
func TestUpdateGroupSettingsNotImplemented(t *testing.T) {
	rt := &recordTransport{
		status: 501,
		body:   `{"statusCode":501,"message":"Engine does not support ephemeral messages","error":"Not Implemented"}`,
	}
	c := newTestClient(t, rt)

	_, err := c.Groups.UpdateGroupSettings(context.Background(), "s1", "g1", GroupSettings{EphemeralSeconds: Ptr(86400)})
	if !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("errors.Is ErrNotImplemented = false for %v", err)
	}
}

func TestSetProfileName(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"success":true,"message":"Profile name updated"}`}
	c := newTestClient(t, rt)

	res, err := c.Profile.SetProfileName(context.Background(), "s1", SetProfileNameRequest{Name: "Acme"})
	if err != nil {
		t.Fatalf("SetProfileName: %v", err)
	}
	if !res.Success {
		t.Fatalf("unexpected response: %+v", res)
	}

	wantPath := "/api/sessions/s1/profile/name"
	if got := rt.lastReq.URL.Path; got != wantPath {
		t.Fatalf("path = %q, want %q", got, wantPath)
	}
	var sent SetProfileNameRequest
	if err := json.Unmarshal(rt.lastRaw, &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent.Name != "Acme" {
		t.Fatalf("sent body = %+v", sent)
	}
}

// An empty status clears the about text — the field must still be sent.
func TestSetProfileStatusEmptyClears(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"success":true,"message":"Profile status updated"}`}
	c := newTestClient(t, rt)

	if _, err := c.Profile.SetProfileStatus(context.Background(), "s1", SetProfileStatusRequest{Status: ""}); err != nil {
		t.Fatalf("SetProfileStatus: %v", err)
	}
	if !strings.Contains(string(rt.lastRaw), `"status":""`) {
		t.Fatalf("empty status must be sent, body = %s", rt.lastRaw)
	}
}

// The picture body is either {url} or {base64, mimetype} — never a mix, and
// empty alternates are omitted.
func TestSetProfilePictureBody(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"success":true,"message":"Profile picture updated"}`}
	c := newTestClient(t, rt)

	if _, err := c.Profile.SetProfilePicture(context.Background(), "s1", SetProfilePictureRequest{
		Base64:   "aW1hZ2U=",
		Mimetype: "image/jpeg",
	}); err != nil {
		t.Fatalf("SetProfilePicture: %v", err)
	}

	var sent map[string]any
	if err := json.Unmarshal(rt.lastRaw, &sent); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if sent["base64"] != "aW1hZ2U=" || sent["mimetype"] != "image/jpeg" {
		t.Fatalf("sent body = %v", sent)
	}
	if _, ok := sent["url"]; ok {
		t.Fatal("empty url should be omitted from body")
	}
}

func TestRejectCall(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"success":true}`}
	c := newTestClient(t, rt)

	res, err := c.Calls.RejectCall(context.Background(), "s1", "call-1")
	if err != nil {
		t.Fatalf("RejectCall: %v", err)
	}
	if !res.Success {
		t.Fatalf("unexpected response: %+v", res)
	}

	wantPath := "/api/sessions/s1/calls/call-1/reject"
	if got := rt.lastReq.URL.Path; got != wantPath {
		t.Fatalf("path = %q, want %q", got, wantPath)
	}
	if rt.lastReq.Method != "POST" {
		t.Fatalf("method = %q, want POST", rt.lastReq.Method)
	}
}

// A call that is no longer ringing surfaces as 404.
func TestRejectCallNotRinging(t *testing.T) {
	rt := &recordTransport{
		status: 404,
		body:   `{"statusCode":404,"message":"Call not found or no longer ringing","error":"Not Found"}`,
	}
	c := newTestClient(t, rt)

	_, err := c.Calls.RejectCall(context.Background(), "s1", "call-1")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("errors.Is ErrNotFound = false for %v", err)
	}
}

// The Event* constants are the wire values of the server's WEBHOOK_EVENTS
// catalog — a typo here silently subscribes to nothing.
func TestWebhookEventWireValues(t *testing.T) {
	want := map[WebhookEvent]string{
		EventMessageReceived:      "message.received",
		EventMessageSent:          "message.sent",
		EventMessageAck:           "message.ack",
		EventMessageFailed:        "message.failed",
		EventMessageRevoked:       "message.revoked",
		EventMessageReaction:      "message.reaction",
		EventMessageEdited:        "message.edited",
		EventSessionStatus:        "session.status",
		EventSessionQR:            "session.qr",
		EventSessionAuthenticated: "session.authenticated",
		EventSessionDisconnected:  "session.disconnected",
		EventSessionReconnectLoop: "session.reconnect_loop",
		EventGroupJoin:            "group.join",
		EventGroupLeave:           "group.leave",
		EventGroupUpdate:          "group.update",
		EventCallReceived:         "call.received",
		EventAll:                  "*",
	}
	for got, w := range want {
		if got != w {
			t.Errorf("event constant = %q, want %q", got, w)
		}
	}
}

// The group event payload decodes join/leave (participants, no changes) and
// update (changes delta, empty participants) shapes alike.
func TestGroupEventPayloadDecodes(t *testing.T) {
	join := `{"groupId":"120363@g.us","actorId":"628@c.us","participantIds":["629@c.us"],"timestamp":1700000000}`
	var j GroupEventPayload
	if err := json.Unmarshal([]byte(join), &j); err != nil {
		t.Fatalf("join payload: %v", err)
	}
	if j.GroupID != "120363@g.us" || j.ActorID == nil || *j.ActorID != "628@c.us" {
		t.Fatalf("join decode: %+v", j)
	}
	if len(j.ParticipantIDs) != 1 || j.ParticipantIDs[0] != "629@c.us" {
		t.Fatalf("join participants: %+v", j.ParticipantIDs)
	}
	if j.Changes != nil {
		t.Fatalf("join should carry no changes, got %+v", j.Changes)
	}

	update := `{"groupId":"120363@g.us","participantIds":[],"changes":{"subject":"New","locked":true},"timestamp":1700000001}`
	var u GroupEventPayload
	if err := json.Unmarshal([]byte(update), &u); err != nil {
		t.Fatalf("update payload: %v", err)
	}
	if u.Changes == nil || u.Changes.Subject == nil || *u.Changes.Subject != "New" {
		t.Fatalf("update changes: %+v", u.Changes)
	}
	if u.Changes.Locked == nil || !*u.Changes.Locked {
		t.Fatalf("update locked: %+v", u.Changes.Locked)
	}
	if u.Changes.Announce != nil || u.Changes.Description != nil {
		t.Fatalf("unchanged settings must stay nil: %+v", u.Changes)
	}
}

func TestCallReceivedPayloadDecodes(t *testing.T) {
	body := `{"callId":"call-1","from":"628@c.us","isVideo":true,"isGroup":false,"timestamp":1700000000}`
	var p CallReceivedPayload
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatalf("call payload: %v", err)
	}
	if p.CallID != "call-1" || p.From != "628@c.us" || !p.IsVideo || p.IsGroup || p.Timestamp != 1700000000 {
		t.Fatalf("call decode: %+v", p)
	}
}

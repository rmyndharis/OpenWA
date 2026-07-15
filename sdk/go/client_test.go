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

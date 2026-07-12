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
	_, err := c.Sessions.List(context.Background())
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
	if _, err := c.Sessions.List(context.Background()); err != nil {
		t.Fatalf("List: %v", err)
	}
	if hits != 1 {
		t.Fatalf("middleware hits = %d, want 1", hits)
	}
	if rt.lastReq.Header.Get("X-Trace") != "on" {
		t.Fatal("middleware header not propagated")
	}
}

func TestContextCancel(t *testing.T) {
	rt := &recordTransport{status: 200, body: `[]`}
	c := newTestClient(t, rt)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := c.Sessions.List(ctx)
	if err == nil {
		t.Fatal("expected context cancellation error")
	}
}

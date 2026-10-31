package openwa

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// Sentinel errors for the common failure modes. Match them with errors.Is:
//
//	if errors.Is(err, openwa.ErrNotFound) { ... }
//
// They are matched against an *APIError by its HTTP status code, so you never
// need to inspect the status yourself for the common cases. For everything else
// (or to read the response body), unwrap the concrete type with errors.As:
//
//	var apiErr *openwa.APIError
//	if errors.As(err, &apiErr) { log.Println(apiErr.StatusCode, apiErr.Body) }
var (
	// ErrBadRequest is returned for a 400 (invalid request payload).
	ErrBadRequest = errors.New("openwa: bad request")
	// ErrUnauthorized is returned for a 401 (missing or invalid API key).
	ErrUnauthorized = errors.New("openwa: unauthorized")
	// ErrForbidden is returned for a 403: the API key's role or scope (session,
	// IP or chat allow-list) refuses the call, or WhatsApp itself refused the
	// operation (for example, missing group admin rights).
	ErrForbidden = errors.New("openwa: forbidden")
	// ErrNotFound is returned for a 404.
	ErrNotFound = errors.New("openwa: not found")
	// ErrConflict is returned for a 409: a conflicting state, typically a session that is not ready for the
	// operation, or a keyed send that is pending or may already have been sent (see the error code).
	ErrConflict = errors.New("openwa: conflict")
	// ErrRateLimited is returned for a 429 (too many requests). The global rate
	// limiter's 429 lifts when its window expires (seconds for the per-second
	// tier, up to an hour for the hourly tier by default); APIError.RetryAfter
	// carries its Retry-After header, which WithRetry also honors. A 429 whose
	// Code is "SEND_PACING_LIMITED" is usually not transient: do not retry it
	// before RetryAfter, which then comes from the body: a few seconds when
	// only sends still in flight caused it, the rest of the failure breaker's
	// cooldown (SEND_PACING_BREAKER_COOLDOWN_MS, 15 minutes by default) after a
	// run of send failures, otherwise up to the next UTC day.
	ErrRateLimited = errors.New("openwa: rate limited")
	// ErrNotImplemented is returned for a 501 (the active engine does not
	// support this operation).
	ErrNotImplemented = errors.New("openwa: not implemented")
	// ErrServiceUnavailable is returned for a 503: the gateway could not
	// complete the request right now. The path to WhatsApp failed (WhatsApp
	// never replied, the socket was down, or the request budget ran out), the
	// gateway is draining or short of a dependency, or, on Baileys, WhatsApp
	// itself throttled (code 429) or timed out (code 408) the request; a
	// throttle or timeout names its code in the message. It is retryable, but
	// back off and retry later instead of at once: repeating a throttled
	// request straight away prolongs the throttle. A catalog 503 can persist
	// because WhatsApp may never answer that query, so bound any retry.
	//
	// On a send or a single write, a throttle turned the request away before it
	// ran, so nothing was sent or applied. A send also sent nothing when its
	// recipient lookup failed, its connection closed before the message was
	// written, or its media or preview image URL could not be fetched through
	// the session's proxy. Each of these frees a keyed send's Idempotency-Key
	// for the retry. A group settings update with several fields applies them
	// one at a time, so a 503 on a later field, a throttle included, leaves the
	// earlier ones applied; the message lists them after "already applied:", so
	// re-read the settings before retrying, or send one field per request. Any
	// other timeout proves nothing: the write may still have been applied, and a
	// keyed send keeps its key taken. The non-idempotent sends are deliberately
	// left unbounded by the gateway so a slow WhatsApp reply never answers one,
	// and in a multi-node deployment a forward that fails before reaching the
	// owner node answers 503. A 503 from the owner itself is relayed unchanged
	// and keeps its meaning, so a bounded write that timed out may still have
	// been applied; re-read the state before repeating it. A forward that fails
	// after the request was sent answers 502 or 504 instead: the owner may
	// already have carried it out, so do not repeat a non-idempotent send on
	// those unchecked.
	ErrServiceUnavailable = errors.New("openwa: service unavailable")
)

// APIError is returned when the API responds with a non-2xx status. A 3xx also
// surfaces as an APIError: redirects are deliberately never followed, so the
// API key is never re-sent to a redirect target.
type APIError struct {
	// StatusCode is the HTTP status code of the response.
	StatusCode int
	// Message is a human-readable description: the "message" of the JSON body
	// (the gateway's NestJS error envelope, or a proxy's own), the raw body when
	// it is not JSON, else the text of the status.
	Message string
	// Kind is the value of the body's "error" field (e.g. "Not Found",
	// "Conflict"), when it is a string.
	Kind string
	// Body is the parsed JSON body, or the raw string when the body is not
	// valid JSON.
	Body any
	// Context is the "METHOD /path" that produced the error.
	Context string
	// Code is the body's machine-readable "code" (e.g. "SEND_PACING_LIMITED"),
	// when the body carries one.
	Code string
	// RetryAfter is how long to wait before retrying: the body's
	// retryAfterSeconds when present, else the Retry-After header (seconds or
	// an HTTP date). Zero when the response names no delay. A delay too long
	// for a time.Duration is reported as the largest Duration (about 292
	// years), a sentinel for "do not retry", not the delay the server named.
	RetryAfter time.Duration
	// Header is the response header.
	Header http.Header
}

func (e *APIError) Error() string {
	return fmt.Sprintf("openwa: API %d — %s: %s", e.StatusCode, e.Context, e.Message)
}

// Is bridges the concrete APIError to the sentinel errors above so callers can
// use errors.Is(err, ErrNotFound) without matching on the status code directly.
func (e *APIError) Is(target error) bool {
	switch e.StatusCode {
	case 400:
		return target == ErrBadRequest
	case 401:
		return target == ErrUnauthorized
	case 403:
		return target == ErrForbidden
	case 404:
		return target == ErrNotFound
	case 409:
		return target == ErrConflict
	case 429:
		return target == ErrRateLimited
	case 501:
		return target == ErrNotImplemented
	case 503:
		return target == ErrServiceUnavailable
	}
	return false
}

// TimeoutError is returned when a request exceeds the configured timeout (or the
// caller's context deadline), whether waiting for the response or reading its body.
type TimeoutError struct {
	// Timeout is the client timeout that ran out, or zero when the caller's
	// context deadline fired first.
	Timeout time.Duration
	// Err is the underlying cause (context.DeadlineExceeded or a net timeout).
	Err error
}

func (e *TimeoutError) Error() string {
	if e.Timeout > 0 {
		return fmt.Sprintf("openwa: request timed out after %s", e.Timeout)
	}
	return "openwa: request timed out"
}

func (e *TimeoutError) Unwrap() error { return e.Err }

// parseAPIError builds an *APIError from a raw response body. The message is read from any JSON
// object that carries one, so an error from a proxy or WAF in front of the gateway reads like the
// gateway's own.
func parseAPIError(status int, raw []byte, context string, header http.Header) *APIError {
	var body any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			body = string(raw)
		}
	}
	fields, _ := body.(map[string]any)
	kind, _ := fields["error"].(string)

	apiErr := &APIError{
		StatusCode: status,
		Message:    messageFromBody(status, body),
		Kind:       kind,
		Body:       body,
		Context:    context,
		Header:     header,
	}
	apiErr.Code, _ = fields["code"].(string)
	// The body's retryAfterSeconds wins: send pacing puts its wait (possibly
	// hours) only there, and a header added by a proxy must not shorten it.
	if secs, ok := fields["retryAfterSeconds"].(float64); ok && secs >= 0 {
		if nanos := secs * float64(time.Second); nanos >= float64(maxRetryAfter) {
			apiErr.RetryAfter = maxRetryAfter
		} else {
			apiErr.RetryAfter = time.Duration(nanos)
		}
	} else if d, ok := retryAfterHeader(header); ok {
		apiErr.RetryAfter = d
	}
	return apiErr
}

// messageFromBody is the text of an error answer: the "message" of a JSON object (a string, or an
// array whose strings are joined), else a plain-text body, else what the status itself says.
func messageFromBody(status int, body any) string {
	switch b := body.(type) {
	case map[string]any:
		switch m := b["message"].(type) {
		case string:
			if m != "" {
				return m
			}
		case []any:
			var parts []string
			for _, p := range m {
				if s, ok := p.(string); ok {
					parts = append(parts, s)
				}
			}
			if len(parts) > 0 {
				return joinComma(parts)
			}
		}
	case string:
		if b != "" {
			return b
		}
	}
	if status >= 300 && status < 400 {
		return "Unexpected redirect (not followed; the API key is never re-sent to a redirect target)"
	}
	if text := http.StatusText(status); text != "" {
		return text
	}
	return "request failed"
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}

package openwa

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// idempotentMethods is the set of HTTP methods that are safe to retry after a
// network error — the request has RFC-defined idempotent semantics, so
// re-issuing it will not cause a duplicate side effect.
var idempotentMethods = map[string]bool{
	http.MethodGet:     true,
	http.MethodHead:    true,
	http.MethodOptions: true,
	http.MethodPut:     true,
	http.MethodDelete:  true,
}

// isIdempotent reports whether it is safe to retry a request that failed with a
// network error (as opposed to a retryable HTTP status the server explicitly
// sent). POST is treated as non-idempotent because we cannot tell whether the
// server processed the request before the connection dropped — replaying it
// could double-send a WhatsApp message.
func isIdempotent(method string) bool { return idempotentMethods[method] }

// backpressureStatuses are the statuses a non-idempotent method may retry on:
// 429 (rate limited) and 503 (unavailable), which usually mean the server
// declined the request before acting on it. Not always: a 503 for a write
// WhatsApp did not confirm in time can follow a write that was applied, so a
// replayed POST may then report a conflict for a change that succeeded, and a
// send-pacing 429 is never retried at all (see isSendPacingRefusal).
//
// The rest of the retryable set (500/502/504) can be returned AFTER the gateway
// has already sent the WhatsApp message — a 504 from a reverse proxy is the
// textbook case — so replaying a POST on those would duplicate the send. The
// SDK declines the retry rather than risk a second message, with or without an
// idempotency key from WithIdempotencyKey: it does not widen the policy for one.
var backpressureStatuses = map[int]bool{
	http.StatusTooManyRequests:    true, // 429
	http.StatusServiceUnavailable: true, // 503
}

// retryableForMethod reports whether a retryable status may be retried for this
// method. Idempotent methods may retry any status in the policy; a
// non-idempotent one (POST) is limited to the backpressure statuses.
func retryableForMethod(method string, status int) bool {
	if isIdempotent(method) {
		return true
	}
	return backpressureStatuses[status]
}

// RetryPolicy controls automatic retries. Retries are OFF by default — pass one
// with WithRetry to opt in. Only network errors and the statuses in
// RetryableStatuses are retried; a non-retryable response is returned as-is.
//
// Non-idempotent requests (POST — every send endpoint) are retried
// conservatively, with or without an idempotency key from WithIdempotencyKey:
// never after a network error, and on a retryable status only for 429 and 503,
// which usually mean the server declined the request before acting on it. A
// 500/502/504 may arrive after the gateway already sent the message, so a POST
// is not replayed on those. Idempotent methods retry the full policy.
//
// A 429 whose body carries code SEND_PACING_LIMITED is never retried, whatever
// the method: it has no Retry-After, and its delay (body.retryAfterSeconds)
// can be hours, so the refusal goes back to the caller at once.
//
// Because every request the SDK issues sets req.GetBody, request bodies are
// safely rewound on each attempt.
type RetryPolicy struct {
	// MaxRetries is the number of retries AFTER the first attempt. 3 means up
	// to 4 total attempts.
	MaxRetries int
	// BaseDelay is the delay before the first retry. Each subsequent retry
	// doubles it (exponential backoff), capped at MaxDelay.
	BaseDelay time.Duration
	// MaxDelay caps the per-retry backoff delay.
	MaxDelay time.Duration
	// RetryableStatuses is the set of HTTP statuses that trigger a retry.
	// Defaults (via DefaultRetryPolicy) to 429, 500, 502, 503, 504.
	RetryableStatuses []int
	// RespectRetryAfter honors a Retry-After header on a 429/503 response,
	// using it as the delay when it is longer than the computed backoff. A
	// delay that would outlast the request deadline is not waited out: the
	// response is returned as-is.
	RespectRetryAfter bool
}

// DefaultRetryPolicy returns a sensible retry policy: 3 retries, 200ms base
// delay with exponential backoff capped at 5s, retrying 429/500/502/503/504 and
// honoring Retry-After.
func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		MaxRetries:        3,
		BaseDelay:         200 * time.Millisecond,
		MaxDelay:          5 * time.Second,
		RetryableStatuses: []int{429, 500, 502, 503, 504},
		RespectRetryAfter: true,
	}
}

func (p RetryPolicy) retryableStatus(status int) bool {
	statuses := p.RetryableStatuses
	if statuses == nil {
		statuses = []int{429, 500, 502, 503, 504}
	}
	for _, s := range statuses {
		if s == status {
			return true
		}
	}
	return false
}

// backoff returns the delay before the retry that follows attempt (0-indexed):
// BaseDelay * 2^attempt, capped at MaxDelay.
func (p RetryPolicy) backoff(attempt int) time.Duration {
	base := p.BaseDelay
	if base <= 0 {
		base = 200 * time.Millisecond
	}
	d := base
	for i := 0; i < attempt; i++ {
		d *= 2
		if p.MaxDelay > 0 && d >= p.MaxDelay {
			return p.MaxDelay
		}
	}
	if p.MaxDelay > 0 && d > p.MaxDelay {
		return p.MaxDelay
	}
	return d
}

func parseRetryAfter(resp *http.Response) (time.Duration, bool) {
	if resp == nil {
		return 0, false
	}
	return retryAfterHeader(resp.Header)
}

// maxRetryAfter stands for a delay too long to count: it is past any request deadline.
const maxRetryAfter = time.Duration(1<<63 - 1)

// retryAfterHeader reads Retry-After as whole seconds or an HTTP date. A count of seconds that does
// not fit a Duration is reported as maxRetryAfter, not wrapped around to a short or negative wait.
func retryAfterHeader(h http.Header) (time.Duration, bool) {
	v := h.Get("Retry-After")
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.ParseInt(v, 10, 64); err == nil && secs >= 0 {
		if secs > int64(maxRetryAfter/time.Second) {
			return maxRetryAfter, true
		}
		return time.Duration(secs) * time.Second, true
	}
	// ParseInt also fails on a count beyond int64: that is still a long delay, unlike "-5" or "soon".
	if digits := strings.TrimPrefix(v, "+"); digits != "" && strings.Trim(digits, "0123456789") == "" {
		return maxRetryAfter, true
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d, true
		}
	}
	return 0, false
}

// isSendPacingRefusal reports whether resp is the gateway's send-pacing 429,
// which must not be retried before the body's retryAfterSeconds. It reads the
// body and puts the bytes back, so the caller still gets the full error. A body that cannot be read
// to the end is returned as an error, not replaced by the part that arrived.
func isSendPacingRefusal(resp *http.Response) (bool, error) {
	if resp.StatusCode != http.StatusTooManyRequests || resp.Body == nil {
		return false, nil
	}
	data, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return false, err
	}
	resp.Body = io.NopCloser(bytes.NewReader(data))
	var body struct {
		Code string `json:"code"`
	}
	return json.Unmarshal(data, &body) == nil && body.Code == "SEND_PACING_LIMITED", nil
}

// retryMiddleware retries network errors and retryable statuses per policy,
// rewinding the body via req.GetBody and respecting context cancellation.
func retryMiddleware(p RetryPolicy, log Logger) Middleware {
	return func(next http.RoundTripper) http.RoundTripper {
		return RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			for attempt := 0; ; attempt++ {
				r := req.Clone(req.Context())
				if req.GetBody != nil {
					body, err := req.GetBody()
					if err != nil {
						return nil, err
					}
					r.Body = body
				}

				resp, err := next.RoundTrip(r)

				retryable := false
				switch {
				case err != nil:
					// Never retry a context cancellation/deadline — the
					// caller has already stopped waiting.
					if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
						return resp, err
					}
					// Network error: only retry idempotent methods, since we
					// can't tell whether the server processed the request
					// before the connection dropped.
					retryable = isIdempotent(req.Method)
				case resp != nil && p.retryableStatus(resp.StatusCode):
					// A retryable HTTP status is the server explicitly telling
					// us to back off, but only 429/503 usually mean it declined
					// the request before acting on it. A 500/502/504 can arrive
					// after the gateway already sent the message, so replaying
					// a POST on those would double-send. A send-pacing 429 is
					// usually not transient, so it goes back to the caller.
					retryable = retryableForMethod(req.Method, resp.StatusCode) && attempt < p.MaxRetries
					if retryable {
						pacing, readErr := isSendPacingRefusal(resp)
						if readErr != nil {
							return nil, readErr
						}
						retryable = !pacing
					}
				}
				if !retryable || attempt >= p.MaxRetries {
					return resp, err
				}

				delay := p.backoff(attempt)
				if resp != nil && p.RespectRetryAfter {
					if ra, ok := parseRetryAfter(resp); ok && ra > delay {
						delay = ra
					}
				}
				// A wait that outlasts the request deadline can only end in a
				// timeout. Return this attempt's result now, so the caller gets
				// the typed 429/503 at once instead of a *TimeoutError later.
				if dl, ok := req.Context().Deadline(); ok && time.Until(dl) < delay {
					return resp, err
				}

				// Drain and close the response body so the connection can be
				// reused before the next attempt.
				if resp != nil {
					_, _ = io.Copy(io.Discard, resp.Body)
					_ = resp.Body.Close()
				}

				log.Log(req.Context(), LevelWarn, "openwa retrying request",
					"method", req.Method, "url", req.URL.Redacted(),
					"attempt", attempt+1, "delay_ms", delay.Milliseconds())

				timer := time.NewTimer(delay)
				select {
				case <-timer.C:
				case <-req.Context().Done():
					timer.Stop()
					return nil, req.Context().Err()
				}
			}
		})
	}
}

package openwa

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
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

// backpressureStatuses are the statuses that mean the server declined the
// request before acting on it: 429 (rate limited) and 503 (unavailable). Only
// these are safe to retry for a non-idempotent method.
//
// The rest of the retryable set (500/502/504) can be returned AFTER the gateway
// has already sent the WhatsApp message — a 504 from a reverse proxy is the
// textbook case — so replaying a POST on those would duplicate the send. The
// SDK has no idempotency key to deduplicate with, so it declines the retry
// rather than risk a second message.
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
// conservatively, because the SDK has no idempotency key to deduplicate with:
// never after a network error, and on a retryable status only for 429 and 503,
// which prove the server declined the request before acting on it. A
// 500/502/504 may arrive after the gateway already sent the message, so a POST
// is not replayed on those. Idempotent methods retry the full policy.
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
	// using it as the delay when it is longer than the computed backoff.
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
	v := resp.Header.Get("Retry-After")
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d, true
		}
	}
	return 0, false
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
					// us to back off — but only 429/503 prove it declined the
					// request before acting on it. A 500/502/504 can arrive
					// after the gateway already sent the message, so replaying
					// a POST on those would double-send.
					retryable = retryableForMethod(req.Method, resp.StatusCode)
				}
				if !retryable || attempt >= p.MaxRetries {
					return resp, err
				}

				// Drain and close the response body so the connection can be
				// reused before the next attempt.
				delay := p.backoff(attempt)
				if resp != nil {
					if p.RespectRetryAfter {
						if ra, ok := parseRetryAfter(resp); ok && ra > delay {
							delay = ra
						}
					}
					_, _ = io.Copy(io.Discard, resp.Body)
					_ = resp.Body.Close()
				}

				log.Log(req.Context(), LevelWarn, "openwa retrying request",
					"method", req.Method, "url", req.URL.String(),
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

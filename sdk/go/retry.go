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

// RetryPolicy controls automatic retries. Retries are OFF by default — pass one
// with WithRetry to opt in. Only network errors and the statuses in
// RetryableStatuses are retried; a non-retryable response is returned as-is.
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
					// us to back off. Safe to retry for any method: the server
					// has rejected the request before processing it.
					retryable = true
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

package openwa

import (
	"net/http"
	"time"
)

// RoundTripperFunc adapts a function to an http.RoundTripper, so a middleware
// can be written as a closure instead of a named type.
type RoundTripperFunc func(*http.Request) (*http.Response, error)

// RoundTrip implements http.RoundTripper.
func (f RoundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

// Middleware wraps an http.RoundTripper to add behavior (retry, logging,
// metrics, tracing, custom auth). Middlewares compose into a pipeline: the
// first one passed to WithMiddleware is the outermost (runs first on the way
// out, last on the way back). Inject cross-cutting concerns like this instead
// of subclassing the client.
//
//	client, _ := openwa.New(baseURL, apiKey,
//	    openwa.WithMiddleware(tracingMiddleware, metricsMiddleware),
//	)
type Middleware func(next http.RoundTripper) http.RoundTripper

// buildTransport composes the request pipeline from the base transport outward:
//
//	base -> auth -> logging -> retry -> user middlewares (index 0 outermost)
//
// Auth sits innermost so every attempt — including retries — carries the API
// key. Retry wraps logging+auth so each attempt is logged and re-authenticated.
func buildTransport(cfg *config, base http.RoundTripper) http.RoundTripper {
	rt := base
	rt = authMiddleware(cfg)(rt)
	rt = loggingMiddleware(cfg.logger)(rt)
	if cfg.retry != nil {
		rt = retryMiddleware(*cfg.retry, cfg.logger)(rt)
	}
	for i := len(cfg.middlewares) - 1; i >= 0; i-- {
		rt = cfg.middlewares[i](rt)
	}
	return rt
}

// authMiddleware injects the API key and default headers on every outbound
// request. Caller-supplied default headers are applied first so the auth and
// content headers below always win and can never be clobbered.
func authMiddleware(cfg *config) Middleware {
	return func(next http.RoundTripper) http.RoundTripper {
		return RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			// Clone so we never mutate the caller's request headers.
			r := req.Clone(req.Context())
			for k, vs := range cfg.headers {
				// Only apply defaults for a header the caller has not already
				// set. The check runs once per key so all default values are
				// added (not just the first, which the earlier per-value check
				// silently dropped).
				if r.Header.Get(k) != "" {
					continue
				}
				for _, v := range vs {
					r.Header.Add(k, v)
				}
			}
			r.Header.Set("X-API-Key", cfg.apiKey)
			if cfg.userAgent != "" && r.Header.Get("User-Agent") == "" {
				r.Header.Set("User-Agent", cfg.userAgent)
			}
			return next.RoundTrip(r)
		})
	}
}

// loggingMiddleware logs one record per attempt at debug level, and errors at
// error level. It is a no-op in practice when the injected logger is nopLogger.
func loggingMiddleware(log Logger) Middleware {
	return func(next http.RoundTripper) http.RoundTripper {
		return RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			start := time.Now()
			resp, err := next.RoundTrip(req)
			dur := time.Since(start)
			if err != nil {
				log.Log(req.Context(), LevelError, "openwa request failed",
					"method", req.Method, "url", req.URL.String(),
					"duration_ms", dur.Milliseconds(), "error", err.Error())
				return resp, err
			}
			log.Log(req.Context(), LevelDebug, "openwa request",
				"method", req.Method, "url", req.URL.String(),
				"status", resp.StatusCode, "duration_ms", dur.Milliseconds())
			return resp, nil
		})
	}
}

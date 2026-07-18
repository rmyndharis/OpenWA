package openwa

import (
	"net/http"
	"time"
)

// DefaultTimeout is the per-request timeout applied when none is configured.
const DefaultTimeout = 30 * time.Second

// DefaultUserAgent is sent on every request unless overridden with
// WithUserAgent or a caller-supplied User-Agent header.
const DefaultUserAgent = "openwa-go/0.1.0"

// config is the resolved, internal configuration assembled from the options.
type config struct {
	baseURL       string
	apiKey        string
	timeout       time.Duration
	timeoutSet    bool
	httpClient    *http.Client
	baseTransport http.RoundTripper
	logger        Logger
	retry         *RetryPolicy
	middlewares   []Middleware
	userAgent     string
	headers       http.Header
	allowInsecure bool
}

// Option configures the client. Options are the single, uniform way to inject
// dependencies (HTTP client, transport, logger, retry, middleware) and tune
// behavior — no globals, no singletons.
type Option func(*config)

// WithTimeout sets the per-request timeout. Zero uses DefaultTimeout. The
// timeout also bounds retries, since it is enforced via the request context.
func WithTimeout(d time.Duration) Option {
	return func(c *config) {
		c.timeout = d
		c.timeoutSet = true
	}
}

// WithHTTPClient injects a fully-configured *http.Client (connection pool,
// timeout, cookie jar). The SDK wraps its Transport with the middleware
// pipeline and forces a non-following redirect policy for safety; it never
// mutates the client you pass. If both WithHTTPClient and WithTransport are
// given, WithTransport wins as the base transport.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *config) { c.httpClient = hc }
}

// WithTransport injects the base http.RoundTripper the pipeline is built on top
// of. Use this to plug in a custom transport (proxy, TLS config, a recording
// transport in tests) without supplying a whole *http.Client.
func WithTransport(rt http.RoundTripper) Option {
	return func(c *config) { c.baseTransport = rt }
}

// WithLogger injects a Logger. The default is a no-op, so the SDK stays silent
// unless you opt in.
func WithLogger(l Logger) Option {
	return func(c *config) {
		if l != nil {
			c.logger = l
		}
	}
}

// WithRetry enables automatic retries with the given policy. Retries are off by
// default. Use openwa.DefaultRetryPolicy() for sensible defaults:
//
//	openwa.WithRetry(openwa.DefaultRetryPolicy())
func WithRetry(p RetryPolicy) Option {
	return func(c *config) { c.retry = &p }
}

// WithMiddleware appends one or more middlewares to the transport pipeline. The
// first argument is the outermost layer. Use it for tracing, metrics, or custom
// auth without touching the SDK internals.
func WithMiddleware(mw ...Middleware) Option {
	return func(c *config) { c.middlewares = append(c.middlewares, mw...) }
}

// WithUserAgent overrides the User-Agent header sent on every request.
func WithUserAgent(ua string) Option {
	return func(c *config) { c.userAgent = ua }
}

// WithHeader adds a default header sent on every request. Auth and content
// headers set by the SDK always take precedence and cannot be overridden.
// Repeated calls accumulate.
func WithHeader(key, value string) Option {
	return func(c *config) {
		if c.headers == nil {
			c.headers = http.Header{}
		}
		c.headers.Add(key, value)
	}
}

// WithInsecureHTTP suppresses the warning logged when base URL uses plaintext
// http:// against a non-localhost host. The API key is bearer-equivalent — only
// use this when TLS is terminated by a trusted proxy in front of the API.
func WithInsecureHTTP() Option {
	return func(c *config) { c.allowInsecure = true }
}

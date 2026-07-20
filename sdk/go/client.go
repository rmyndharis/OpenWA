// Package openwa is the official Go client for the OpenWA WhatsApp API Gateway.
//
// The single entry point is New, which returns a *Client whose exported fields
// are the domain services:
//
//	client, err := openwa.New("http://localhost:2785", "owa_k1_…")
//	if err != nil {
//	    log.Fatal(err)
//	}
//
//	ctx := context.Background()
//	if _, err := client.Sessions.Start(ctx, "my-session"); err != nil {
//	    log.Fatal(err)
//	}
//	res, err := client.Messages.SendText(ctx, "my-session", openwa.SendTextRequest{
//	    ChatID: "628123456789@c.us",
//	    Text:   "Hello from the OpenWA Go SDK!",
//	})
//
// Every network method is context-first. Configuration and dependency injection
// go through functional Options (WithHTTPClient, WithTransport, WithLogger,
// WithRetry, WithMiddleware). Errors are typed — match them with errors.Is
// against the sentinels (ErrNotFound, ErrConflict, …) or errors.As against
// *APIError.
//
// Use HTTPS in production: the API key is sent as X-API-Key on every request
// and is bearer-equivalent. Redirects are never followed, so the key is never
// re-sent to a redirect target.
package openwa

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// Client is the entry point to the OpenWA API. Construct it with New. It is safe
// for concurrent use by multiple goroutines. The exported service fields group
// the API by domain.
type Client struct {
	baseURL    string
	httpClient *http.Client
	timeout    time.Duration

	// Services.
	Sessions  *SessionsService
	Messages  *MessagesService
	Contacts  *ContactsService
	Groups    *GroupsService
	Webhooks  *WebhooksService
	Chats     *ChatsService
	Status    *StatusService
	Labels    *LabelsService
	Channels  *ChannelsService
	Catalog   *CatalogService
	Templates *TemplatesService
	Health    *HealthService
	Search    *SearchService
	Auth      *AuthService
	Profile   *ProfileService
	Calls     *CallsService
}

var localhostHosts = map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}

// New constructs a Client for the API at baseURL, authenticating with apiKey.
// Both are required. Everything else is configured through Options.
func New(baseURL, apiKey string, opts ...Option) (*Client, error) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, errors.New("openwa: baseURL is required")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("openwa: apiKey is required")
	}

	cfg := &config{
		baseURL:   strings.TrimRight(baseURL, "/"),
		apiKey:    apiKey,
		timeout:   DefaultTimeout,
		logger:    nopLogger{},
		userAgent: DefaultUserAgent,
	}
	for _, opt := range opts {
		opt(cfg)
	}
	// A zero (or negative) timeout means "use the default" per WithTimeout's
	// documentation — never an infinite timeout, which would silently pin
	// goroutines waiting for a dead peer.
	if cfg.timeout <= 0 {
		cfg.timeout = DefaultTimeout
	}

	warnIfInsecure(cfg)

	base := cfg.baseTransport
	if base == nil {
		if cfg.httpClient != nil && cfg.httpClient.Transport != nil {
			base = cfg.httpClient.Transport
		} else {
			base = http.DefaultTransport
		}
	}
	pipeline := buildTransport(cfg, base)

	hc := &http.Client{
		Transport: pipeline,
		// Never auto-follow redirects: doing so would re-send X-API-Key to the
		// redirect target. ErrUseLastResponse surfaces the 3xx to do(), which
		// then treats it as an error.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Timeout: cfg.timeout,
	}
	if cfg.httpClient != nil {
		hc.Jar = cfg.httpClient.Jar
		if cfg.httpClient.Timeout > 0 && !cfg.timeoutSet {
			hc.Timeout = cfg.httpClient.Timeout
		}
	}

	c := &Client{
		baseURL:    cfg.baseURL,
		httpClient: hc,
		timeout:    hc.Timeout,
	}
	c.Sessions = &SessionsService{client: c}
	c.Messages = &MessagesService{client: c}
	c.Contacts = &ContactsService{client: c}
	c.Groups = &GroupsService{client: c}
	c.Webhooks = &WebhooksService{client: c}
	c.Chats = &ChatsService{client: c}
	c.Status = &StatusService{client: c}
	c.Labels = &LabelsService{client: c}
	c.Channels = &ChannelsService{client: c}
	c.Catalog = &CatalogService{client: c}
	c.Templates = &TemplatesService{client: c}
	c.Health = &HealthService{client: c}
	c.Search = &SearchService{client: c}
	c.Auth = &AuthService{client: c}
	c.Profile = &ProfileService{client: c}
	c.Calls = &CallsService{client: c}
	return c, nil
}

const insecureWarning = "openwa: baseURL uses insecure http:// — the API key is sent in cleartext; use https:// in production"

// warnIfInsecure warns once, at construction, when the API key would travel in
// cleartext to a non-localhost host.
//
// Unlike the SDK's per-request logging, this does not stay silent under the
// default nopLogger: the caller most likely to point at a plaintext http:// URL
// by accident is the one who has not wired a logger up yet, so a discarded
// warning would be no warning at all. An injected logger receives it instead of
// stderr, and WithInsecureHTTP silences it entirely.
func warnIfInsecure(cfg *config) {
	if cfg.allowInsecure {
		return
	}
	u, err := url.Parse(cfg.baseURL)
	if err != nil {
		return
	}
	host := strings.Trim(u.Hostname(), "[]")
	if u.Scheme != "http" || localhostHosts[host] {
		return
	}
	if _, isNop := cfg.logger.(nopLogger); isNop {
		fmt.Fprintf(os.Stderr, "%s (host: %s)\n", insecureWarning, host)
		return
	}
	cfg.logger.Log(context.Background(), LevelWarn, insecureWarning, "host", host)
}

// Do issues a raw request against the API and decodes the JSON response into
// out (pass nil to ignore the body). It is the escape hatch for endpoints the
// typed services do not cover. path must begin with "/".
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	return c.do(ctx, method, path, query, body, out)
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var bodyBytes []byte
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("openwa: encoding request body: %w", err)
		}
		bodyBytes = b
		reader = bytes.NewReader(b)
	}

	rawURL := c.baseURL + path
	if len(query) > 0 {
		rawURL += "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return fmt.Errorf("openwa: building request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.ContentLength = int64(len(bodyBytes))
		// GetBody lets the retry middleware rewind the body on each attempt.
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(bodyBytes)), nil
		}
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		if isTimeout(err) {
			return &TimeoutError{Timeout: c.timeout, Err: err}
		}
		return fmt.Errorf("openwa: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("openwa: reading response body: %w", err)
	}

	// Any non-2xx (including an unfollowed 3xx) is an error.
	if resp.StatusCode >= 300 {
		return parseAPIError(resp.StatusCode, data, method+" "+path)
	}
	if out == nil || resp.StatusCode == http.StatusNoContent || len(data) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("openwa: decoding response: %w", err)
	}
	return nil
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var timeouter interface{ Timeout() bool }
	if errors.As(err, &timeouter) {
		return timeouter.Timeout()
	}
	return false
}

// pathEscape percent-encodes a single path segment so a value containing "/",
// "#", or "?" can't break out of its path position. WhatsApp-JID characters
// that are already path-safe ("@", ":", "+") are kept readable.
func pathEscape(segment string) string {
	escaped := url.PathEscape(segment)
	return jidRestorer.Replace(escaped)
}

var jidRestorer = strings.NewReplacer("%40", "@", "%3A", ":", "%2B", "+")

// query helpers used by the typed *Query structs.

func setStr(v url.Values, key string, p *string) {
	if p != nil {
		v.Set(key, *p)
	}
}

func setInt(v url.Values, key string, p *int) {
	if p != nil {
		v.Set(key, strconv.Itoa(*p))
	}
}

func setBool(v url.Values, key string, p *bool) {
	if p != nil {
		if *p {
			v.Set(key, "true")
		} else {
			v.Set(key, "false")
		}
	}
}

func setInt64(v url.Values, key string, p *int64) {
	if p != nil {
		v.Set(key, strconv.FormatInt(*p, 10))
	}
}

// queryValuer is implemented by the typed *Query structs.
type queryValuer interface{ values() url.Values }

// valuesOf encodes a query, treating a nil (including a typed-nil pointer) as
// "no query params".
func valuesOf(q queryValuer) url.Values {
	if q == nil {
		return nil
	}
	rv := reflect.ValueOf(q)
	if rv.Kind() == reflect.Ptr && rv.IsNil() {
		return nil
	}
	return q.values()
}

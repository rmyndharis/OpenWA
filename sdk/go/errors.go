package openwa

import (
	"encoding/json"
	"errors"
	"fmt"
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
	// ErrForbidden is returned for a 403 (insufficient role).
	ErrForbidden = errors.New("openwa: forbidden")
	// ErrNotFound is returned for a 404.
	ErrNotFound = errors.New("openwa: not found")
	// ErrConflict is returned for a 409 (typically an engine-not-ready condition).
	ErrConflict = errors.New("openwa: conflict")
	// ErrRateLimited is returned for a 429 (too many requests).
	ErrRateLimited = errors.New("openwa: rate limited")
	// ErrNotImplemented is returned for a 501 (the active engine does not
	// support this operation).
	ErrNotImplemented = errors.New("openwa: not implemented")
)

// APIError is returned when the API responds with a non-2xx status. A 3xx also
// surfaces as an APIError: redirects are deliberately never followed, so the
// API key is never re-sent to a redirect target.
type APIError struct {
	// StatusCode is the HTTP status code of the response.
	StatusCode int
	// Message is a human-readable description derived from the NestJS error
	// envelope (or the raw body when the response is not the standard shape).
	Message string
	// Kind is the value of the NestJS envelope's "error" field (e.g.
	// "Not Found", "Conflict"), when present.
	Kind string
	// Body is the parsed JSON body, or the raw string when the body is not
	// valid JSON.
	Body any
	// Context is the "METHOD /path" that produced the error.
	Context string
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
	}
	return false
}

// TimeoutError is returned when a request exceeds the configured timeout (or the
// caller's context deadline).
type TimeoutError struct {
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

// nestEnvelope is the standard NestJS error shape:
// {"statusCode": int, "message": string|[]string, "error": string}.
type nestEnvelope struct {
	StatusCode int             `json:"statusCode"`
	Message    json.RawMessage `json:"message"`
	Error      string          `json:"error"`
}

// parseAPIError builds an *APIError from a raw response body, extracting a
// readable message from the NestJS envelope when the body matches that shape.
func parseAPIError(status int, raw []byte, context string) *APIError {
	var body any
	var envelope *nestEnvelope

	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			body = string(raw)
		}
		var env nestEnvelope
		if err := json.Unmarshal(raw, &env); err == nil && env.StatusCode != 0 {
			envelope = &env
		}
	}

	message := messageFromEnvelope(envelope, body)
	kind := ""
	if envelope != nil {
		kind = envelope.Error
	}

	return &APIError{
		StatusCode: status,
		Message:    message,
		Kind:       kind,
		Body:       body,
		Context:    context,
	}
}

func messageFromEnvelope(envelope *nestEnvelope, body any) string {
	if envelope != nil && len(envelope.Message) > 0 {
		// message may be a string or an array of strings.
		var single string
		if err := json.Unmarshal(envelope.Message, &single); err == nil {
			return single
		}
		var many []string
		if err := json.Unmarshal(envelope.Message, &many); err == nil {
			return joinComma(many)
		}
	}
	if s, ok := body.(string); ok && s != "" {
		return s
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

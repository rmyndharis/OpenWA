package openwa

// ── Health ──────────────────────────────────────────────

// HealthResponse is the /health payload.
type HealthResponse struct {
	Status    string `json:"status"`
	Timestamp string `json:"timestamp,omitempty"`
	Version   string `json:"version,omitempty"`
}

// DependencyStatus is one dependency's health snapshot inside a readiness
// payload (e.g. {"mainDatabase":{"status":"up"}}).
type DependencyStatus struct {
	Status string `json:"status"`
}

// HealthReadyResponse is the /health/ready payload. Details maps a dependency
// name (e.g. "mainDatabase", "dataDatabase") to its DependencyStatus.
type HealthReadyResponse struct {
	Status  string                      `json:"status"`
	Details map[string]DependencyStatus `json:"details,omitempty"`
}

// ── Auth ─────────────────────────────────────────────────

// AuthValidateResponse reports whether the API key is valid, its role, and the
// engine the gateway runs.
type AuthValidateResponse struct {
	Valid      bool   `json:"valid"`
	Role       string `json:"role,omitempty"`
	EngineType string `json:"engineType,omitempty"`
}

// ── Template ───────────────────────────────────────────

// TemplateRecord is a stored message template with {{variable}} placeholders.
type TemplateRecord struct {
	ID        string  `json:"id"`
	SessionID string  `json:"sessionId"`
	Name      string  `json:"name"`
	Body      string  `json:"body"`
	Header    *string `json:"header,omitempty"`
	Footer    *string `json:"footer,omitempty"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

type TemplateType string

const (
	TemplateTypeText  TemplateType = "text"
	TemplateTypeImage TemplateType = "image"
)

// CreateTemplateRequest creates a template. Name and Body required.
type CreateTemplateRequest struct {
	Name     string       `json:"name"`
	Body     string       `json:"body"`
	Header   string       `json:"header,omitempty"`
	Footer   string       `json:"footer,omitempty"`
	Type     TemplateType `json:"type,omitempty"`
	MediaURL string       `json:"mediaUrl,omitempty"`
}

// UpdateTemplateRequest updates a template; all fields optional.
//
// Header and Footer are pointers because an empty string is how the server is told to REMOVE them.
// As value types with `omitempty` they marshalled away, so a Go caller could never clear a header
// once set — every rendered message kept prepending the old text while the update reported success.
type UpdateTemplateRequest struct {
	Name   string  `json:"name,omitempty"`
	Body   string  `json:"body,omitempty"`
	Header *string `json:"header,omitempty"`
	Footer *string `json:"footer,omitempty"`
}

// ── Label (WhatsApp Business) ────────────────────────────────

// LabelRecord is a WhatsApp Business chat label.
type LabelRecord struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	HexColor string `json:"hexColor,omitempty"`
}

// AddLabelRequest applies a label to a chat.
type AddLabelRequest struct {
	LabelID string `json:"labelId"`
}

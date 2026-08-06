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

// AuthValidateResponse reports whether the API key is valid and its role.
type AuthValidateResponse struct {
	Valid bool   `json:"valid"`
	Role  string `json:"role,omitempty"`
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

// CreateTemplateRequest creates a template. Name and Body required.
type CreateTemplateRequest struct {
	Name   string `json:"name"`
	Body   string `json:"body"`
	Header string `json:"header,omitempty"`
	Footer string `json:"footer,omitempty"`
}

// UpdateTemplateRequest updates a template; all fields optional.
type UpdateTemplateRequest struct {
	Name   string `json:"name,omitempty"`
	Body   string `json:"body,omitempty"`
	Header string `json:"header,omitempty"`
	Footer string `json:"footer,omitempty"`
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

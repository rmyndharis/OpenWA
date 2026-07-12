package openwa

// WebhookFilterCondition is one condition in a webhook filter.
type WebhookFilterCondition struct {
	Field    string   `json:"field"`
	Operator string   `json:"operator"`
	Value    []string `json:"value"`
}

// WebhookFilters groups filter conditions.
type WebhookFilters struct {
	Conditions []WebhookFilterCondition `json:"conditions"`
}

// CreateWebhookRequest registers a webhook. RetryCount is 0–5 (default 3).
type CreateWebhookRequest struct {
	URL        string            `json:"url"`
	Events     []string          `json:"events"`
	Secret     string            `json:"secret,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Filters    *WebhookFilters   `json:"filters,omitempty"`
	RetryCount *int              `json:"retryCount,omitempty"`
}

// UpdateWebhookRequest updates a webhook; all fields optional.
type UpdateWebhookRequest struct {
	URL        string            `json:"url,omitempty"`
	Events     []string          `json:"events,omitempty"`
	Secret     string            `json:"secret,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Filters    *WebhookFilters   `json:"filters,omitempty"`
	RetryCount *int              `json:"retryCount,omitempty"`
	Active     *bool             `json:"active,omitempty"`
}

// WebhookResponse is a stored webhook (secret/headers are omitted on reads).
type WebhookResponse struct {
	ID              string          `json:"id"`
	SessionID       string          `json:"sessionId"`
	URL             string          `json:"url"`
	Events          []string        `json:"events"`
	Active          bool            `json:"active"`
	Filters         *WebhookFilters `json:"filters,omitempty"`
	RetryCount      int             `json:"retryCount,omitempty"`
	LastTriggeredAt *string         `json:"lastTriggeredAt,omitempty"`
	CreatedAt       string          `json:"createdAt"`
	UpdatedAt       string          `json:"updatedAt"`
}

// WebhookTestResult is the outcome of a webhook test delivery.
type WebhookTestResult struct {
	Success    bool   `json:"success"`
	StatusCode int    `json:"statusCode,omitempty"`
	Error      string `json:"error,omitempty"`
}

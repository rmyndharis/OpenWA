package openwa

// WebhookEvent names an event a webhook may subscribe to. It is an alias for
// string so the Event* constants drop straight into the []string Events fields
// of CreateWebhookRequest / UpdateWebhookRequest without a conversion. Use
// EventAll ("*") to receive every event.
type WebhookEvent = string

// Events a webhook may subscribe to, mirroring the server's WEBHOOK_EVENTS
// catalog (src/modules/webhook/dto/webhook.dto.ts).
const (
	EventMessageReceived      WebhookEvent = "message.received"
	EventMessageSent          WebhookEvent = "message.sent"
	EventMessageAck           WebhookEvent = "message.ack"
	EventMessageFailed        WebhookEvent = "message.failed"
	EventMessageRevoked       WebhookEvent = "message.revoked"
	EventMessageReaction      WebhookEvent = "message.reaction"
	EventMessageEdited        WebhookEvent = "message.edited"
	EventSessionStatus        WebhookEvent = "session.status"
	EventSessionQR            WebhookEvent = "session.qr"
	EventSessionAuthenticated WebhookEvent = "session.authenticated"
	EventSessionDisconnected  WebhookEvent = "session.disconnected"
	EventSessionReconnectLoop WebhookEvent = "session.reconnect_loop"
	EventGroupJoin            WebhookEvent = "group.join"
	EventGroupLeave           WebhookEvent = "group.leave"
	EventGroupUpdate          WebhookEvent = "group.update"
	EventCallReceived         WebhookEvent = "call.received"
	EventAll                  WebhookEvent = "*"
)

// GroupEventChanges is the metadata delta on a group.update event. Fields are
// pointers: only the settings that actually changed are populated.
type GroupEventChanges struct {
	Subject     *string `json:"subject,omitempty"`
	Description *string `json:"description,omitempty"`
	Announce    *bool   `json:"announce,omitempty"`
	Locked      *bool   `json:"locked,omitempty"`
}

// GroupEventPayload is the payload of the group.join / group.leave /
// group.update events (webhook and socket alike). ParticipantIDs carries the
// affected users for join/leave and is empty for metadata updates; Changes is
// the metadata delta, present on group.update. Timestamp is unix seconds.
type GroupEventPayload struct {
	GroupID        string             `json:"groupId"`
	ActorID        *string            `json:"actorId,omitempty"`
	ParticipantIDs []string           `json:"participantIds"`
	Changes        *GroupEventChanges `json:"changes,omitempty"`
	Timestamp      int64              `json:"timestamp"`
}

// CallReceivedPayload is the payload of the call.received event. CallID is the
// handle Calls.RejectCall accepts while the call is still ringing. Timestamp
// is unix seconds.
type CallReceivedPayload struct {
	CallID    string `json:"callId"`
	From      string `json:"from"`
	IsVideo   bool   `json:"isVideo"`
	IsGroup   bool   `json:"isGroup"`
	Timestamp int64  `json:"timestamp"`
}

// WebhookFilterCondition is one condition in a webhook filter. Value is
// polymorphic per field kind — the server accepts a string (text fields), a
// []string (id/idArray/enum fields), or a bool (boolean fields). Passing a
// []string for a text/boolean field triggers a 400. Use any so all shapes
// round-trip cleanly for both create and read-back.
type WebhookFilterCondition struct {
	Field         string `json:"field"`
	Operator      string `json:"operator"`
	Value         any    `json:"value"`
	CaseSensitive *bool  `json:"caseSensitive,omitempty"`
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

package openwa

import "encoding/json"

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
	EventSessionRestriction   WebhookEvent = "session.restriction"
	EventPresenceUpdate       WebhookEvent = "presence.update"
	EventEventResponse        WebhookEvent = "event.response"
	EventCallAccepted         WebhookEvent = "call.accepted"
	EventCallRejected         WebhookEvent = "call.rejected"
	EventCallMissed           WebhookEvent = "call.missed"
	EventGroupJoin            WebhookEvent = "group.join"
	EventGroupLeave           WebhookEvent = "group.leave"
	EventGroupUpdate          WebhookEvent = "group.update"
	EventGroupJoinRequest     WebhookEvent = "group.join_request"
	EventCallReceived         WebhookEvent = "call.received"
	EventStatusReceived       WebhookEvent = "status.received"
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
// group.update / group.join_request events (webhook and socket alike).
// ParticipantIDs carries the affected users for join/leave, the users asking
// to join for join_request, and is empty for metadata updates; Changes is the
// metadata delta, present on group.update. Timestamp is unix seconds.
type GroupEventPayload struct {
	GroupID        string             `json:"groupId"`
	ActorID        *string            `json:"actorId,omitempty"`
	ParticipantIDs []string           `json:"participantIds"`
	Changes        *GroupEventChanges `json:"changes,omitempty"`
	Timestamp      int64              `json:"timestamp"`
}

// CallReceivedPayload is the payload of the call.received event. CallID is the
// handle Calls.RejectCall accepts while the call is still ringing (Baileys
// only; whatsapp-web.js answers 501). Timestamp is unix seconds.
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

// MarshalJSON encodes a nil Conditions as `[]` rather than `null`.
//
// The gateway requires conditions to be an array and answers 400 for `null`, so the zero value
// &WebhookFilters{} could not express the documented empty filter `{ "conditions": [] }`.
func (f WebhookFilters) MarshalJSON() ([]byte, error) {
	type alias WebhookFilters
	out := alias(f)
	if out.Conditions == nil {
		out.Conditions = []WebhookFilterCondition{}
	}
	return json.Marshal(out)
}

// CreateWebhookRequest registers a webhook. RetryCount is 0–5 (default 3).
//
// Secret is optional and signs every delivery as X-OpenWA-Signature: sha256=<hex>. The gateway
// enforces a 16-character minimum and answers 400 below it; omit Secret for unsigned deliveries.
type CreateWebhookRequest struct {
	URL        string            `json:"url"`
	Events     []string          `json:"events"`
	Secret     string            `json:"secret,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Filters    *WebhookFilters   `json:"filters,omitempty"`
	RetryCount *int              `json:"retryCount,omitempty"`
}

// UpdateWebhookRequest updates a webhook; all fields optional.
//
// The server distinguishes an ABSENT field (leave it alone) from an explicit empty or null value
// (clear it). Secret and Headers are therefore pointers: with a value type, `omitempty` dropped an
// empty string and an empty map from the body, so the two documented "clear this" values could not
// be expressed at all and the stored values survived an update that meant to remove them.
//
// Filters cannot use the same trick — a nil pointer marshals away under omitempty, and dropping
// omitempty would send "filters": null on EVERY update, clearing filters nobody asked to touch. Set
// ClearFilters instead; MarshalJSON turns it into the explicit null the server reads.
//
// The gateway's 16-character minimum on Secret applies here too, with one exception: the empty
// string is the documented "clear the secret" value and is accepted.
type UpdateWebhookRequest struct {
	URL        string             `json:"url,omitempty"`
	Events     []string           `json:"events,omitempty"`
	Secret     *string            `json:"secret,omitempty"`
	Headers    *map[string]string `json:"headers,omitempty"`
	Filters    *WebhookFilters    `json:"filters,omitempty"`
	RetryCount *int               `json:"retryCount,omitempty"`
	Active     *bool              `json:"active,omitempty"`

	// ClearFilters removes any stored filters. Ignored when Filters is set — setting and clearing
	// the same field in one request is a caller error, and setting is the more specific intent.
	ClearFilters bool `json:"-"`
}

// MarshalJSON emits the explicit `"filters": null` the server reads as "remove the filters", which
// no combination of struct tags can express for a nil pointer.
func (r UpdateWebhookRequest) MarshalJSON() ([]byte, error) {
	type payload UpdateWebhookRequest // alias sheds this method, so json.Marshal does not recurse
	encoded, err := json.Marshal(payload(r))
	if err != nil {
		return nil, err
	}
	if !r.ClearFilters || r.Filters != nil {
		return encoded, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	fields["filters"] = json.RawMessage("null")
	return json.Marshal(fields)
}

// WebhookResponse is a stored webhook (secret/headers are omitted on reads).
type WebhookResponse struct {
	ID              string          `json:"id"`
	SessionID       string          `json:"sessionId"`
	URL             string          `json:"url"`
	Events          []string        `json:"events"`
	Active          bool            `json:"active"`
	Filters         *WebhookFilters `json:"filters,omitempty"`
	RetryCount      int             `json:"retryCount"`
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

// WebhookDeliveryFailure is a webhook delivery the gateway gave up on or could
// not dispatch, as listed by the delivery-failure log. A later successful
// delivery removes the row.
type WebhookDeliveryFailure struct {
	ID        string `json:"id"`
	WebhookID string `json:"webhookId"`
	SessionID string `json:"sessionId"`
	Event     string `json:"event"`
	URL       string `json:"url"`
	// IdempotencyKey is the key the receiver would have deduped on.
	IdempotencyKey *string `json:"idempotencyKey,omitempty"`
	DeliveryID     *string `json:"deliveryId,omitempty"`
	// Attempts is the number of attempts made before giving up; 0 when the
	// delivery was not given up after retries (oversize or unserializable
	// payload, capacity shed, or shutdown, possibly in a retry backoff after
	// earlier attempts were sent).
	Attempts int `json:"attempts"`
	// LastStatusCode is the last HTTP status when the failure was a non-2xx
	// response; nil for a network or timeout error, or when Attempts is 0.
	LastStatusCode *int   `json:"lastStatusCode,omitempty"`
	LastError      string `json:"lastError"`
	// CreatedAt is the ISO timestamp of when the failure was first recorded.
	CreatedAt string `json:"createdAt"`
	// Replayable is true when the row still holds the event data and can be
	// replayed with RedriveDeliveryFailures: a terminal row (Attempts > 0)
	// recorded while the gateway's WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS is
	// above 0, until that window passes.
	Replayable bool `json:"replayable"`
}

// RedriveWebhookDeliveriesRequest is the body of RedriveDeliveryFailures.
// Every field narrows; an empty body takes eligible rows with the fewest attempts.
type RedriveWebhookDeliveriesRequest struct {
	// SessionID limits the batch to one session (within the key's allowedSessions).
	SessionID string `json:"sessionId,omitempty"`
	// WebhookID limits the batch to one webhook.
	WebhookID string `json:"webhookId,omitempty"`
	// IDs limits the batch to these failure rows (at most 500).
	// A nil pointer uses the default scope; a pointer to an empty slice replays nothing.
	IDs *[]string `json:"ids,omitempty"`
	// Limit caps the rows replayed by this call (1-500, default 100).
	Limit int `json:"limit,omitempty"`
}

// WebhookRedriveResult is the outcome of RedriveDeliveryFailures.
type WebhookRedriveResult struct {
	// Redriven is the rows replayed by this call: Delivered plus Enqueued.
	Redriven int `json:"redriven"`
	// Delivered rows went out by a direct POST; their failure rows were removed.
	Delivered int `json:"delivered"`
	// Enqueued is reserved for compatibility; operator redrive always returns zero.
	Enqueued int `json:"enqueued"`
	// Failed replays failed again; their rows stay, with attempts raised by one.
	Failed int `json:"failed"`
	// Skipped rows were not replayed: the webhook was removed, disabled or
	// unsubscribed, or a plugin cancelled it.
	Skipped int `json:"skipped"`
	// Remaining is the replayable rows still in scope after this call.
	Remaining int `json:"remaining"`
}

// WebhookDelivery is the JSON body of a webhook delivery (docs/06 section
// 6.6). Event is "test" for a delivery sent by the test endpoint. Check the
// raw body with VerifyWebhookSignature before decoding it.
type WebhookDelivery struct {
	Event          WebhookEvent    `json:"event"`
	Timestamp      string          `json:"timestamp"`
	SessionID      string          `json:"sessionId"`
	IdempotencyKey string          `json:"idempotencyKey"`
	DeliveryID     string          `json:"deliveryId"`
	Data           json.RawMessage `json:"data"`
}

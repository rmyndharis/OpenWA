package openwa

import (
	"encoding/json"
	"net/url"
)

// ListSessionsQuery paginates GET /sessions. All fields optional.
type ListSessionsQuery struct {
	Limit  *int
	Offset *int
	// Name returns only the session with exactly this name (case-sensitive).
	Name *string
}

func (q *ListSessionsQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	setStr(v, "name", q.Name)
	return v
}

// GroupJoinInfo is what an invite code discloses about a group before joining. Not GroupInfo: a
// non-member has no participant list, only a count, and only when WhatsApp discloses one.
type GroupJoinInfo struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	Owner       *string `json:"owner,omitempty"`
	// CreatedAt is Unix seconds.
	CreatedAt        *int64 `json:"createdAt,omitempty"`
	ParticipantCount *int   `json:"participantCount,omitempty"`
}

// CreateChannelRequest is the body for creating a channel.
type CreateChannelRequest struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// DemoteChannelAdminRequest is the body for ChannelsService.DemoteAdmin.
type DemoteChannelAdminRequest struct {
	UserID string `json:"userId"`
}

// TransferChannelOwnershipRequest is the body for ChannelsService.TransferOwnership. The transfer
// is irreversible.
type TransferChannelOwnershipRequest struct {
	NewOwnerID string `json:"newOwnerId"`
}

// MuteChannelRequest is the body for muting or unmuting a channel. The subscription is unaffected
// either way.
type MuteChannelRequest struct {
	Mute bool `json:"mute"`
}

// CustomLinkPreview is a caller-supplied link preview. Nothing is fetched for these.
type CustomLinkPreview struct {
	URL string `json:"url"`
	// Title is required — WhatsApp will not render a preview without one.
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

// UpsertLabelRequest is a label create-or-update body. The id travels in the path, because WhatsApp
// keys the write on it.
type UpsertLabelRequest struct {
	// Name nil drops the current name: the write replaces the whole label.
	Name *string `json:"name,omitempty"`
	// Color is WhatsApp's colour INDEX (0-19), NOT a hex value — it does not round-trip with the
	// HexColor labels are read back with, because neither engine exposes the mapping. Nil drops
	// the current colour.
	Color *int `json:"color,omitempty"`
}

// ParticipantPresence is one participant's presence within a chat.
// SessionStatus is the session lifecycle state reported by the gateway.
type SessionStatus string

const (
	SessionStatusCreated        SessionStatus = "created"
	SessionStatusInitializing   SessionStatus = "initializing"
	SessionStatusQrReady        SessionStatus = "qr_ready"
	SessionStatusAuthenticating SessionStatus = "authenticating"
	SessionStatusReady          SessionStatus = "ready"
	SessionStatusDisconnected   SessionStatus = "disconnected"
	SessionStatusActionRequired SessionStatus = "action_required"
	SessionStatusFailed         SessionStatus = "failed"
)

// AccountRestrictionKind is the class of a WhatsApp-side account restriction.
type AccountRestrictionKind string

const (
	RestrictionReachoutTimelock AccountRestrictionKind = "reachout_timelock"
	RestrictionTosBlock         AccountRestrictionKind = "tos_block"
	RestrictionProxyBlock       AccountRestrictionKind = "proxy_block"
)

// PresenceState is a subscribed contact's presence.
type PresenceState string

const (
	PresenceAvailable   PresenceState = "available"
	PresenceUnavailable PresenceState = "unavailable"
	PresenceComposing   PresenceState = "composing"
	PresenceRecording   PresenceState = "recording"
	PresencePaused      PresenceState = "paused"
)

type ParticipantPresence struct {
	ID string `json:"id"`
	// State is one of: available, unavailable, composing, recording, paused. "composing" and
	// "recording" mean actively typing or recording; "paused" means they stopped.
	State PresenceState `json:"state"`
	// LastSeen is Unix SECONDS. Nil whenever the contact's privacy settings hide last-seen — the
	// common case, not an error.
	LastSeen *int64 `json:"lastSeen,omitempty"`
}

// ChatPresence is the last presence reported for a chat since it was subscribed.
type ChatPresence struct {
	ChatID       string                `json:"chatId"`
	Participants []ParticipantPresence `json:"participants"`
	// GroupOnlineCount is the online member count, groups only.
	GroupOnlineCount *int `json:"groupOnlineCount,omitempty"`
	// ObservedAt is when the gateway received the report — NOT a WhatsApp timestamp.
	ObservedAt string `json:"observedAt"`
}

// AccountRestriction is a restriction WhatsApp has in force on a session's account.
//
// "reachout_timelock" leaves the session connected and existing chats working -- only starting new
// conversations is blocked -- whereas "tos_block" and "proxy_block" refuse the connection itself and
// therefore cannot coexist with a "ready" status.
type AccountRestriction struct {
	// Kind is one of: reachout_timelock, tos_block, proxy_block.
	Kind AccountRestrictionKind `json:"kind"`
	// Code is the engine's own token for the cause, verbatim (TOS_BLOCK, BIZ_QUALITY, ...).
	Code string `json:"code"`
	// ExpiresAt is an ISO timestamp for the end of enforcement, when WhatsApp states one.
	ExpiresAt *string `json:"expiresAt,omitempty"`
}

// SessionResponse describes a WhatsApp session. Status is one of: created,
// initializing, qr_ready, authenticating, ready, disconnected, action_required,
// failed.
type SessionResponse struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Status      SessionStatus `json:"status"`
	Phone       *string       `json:"phone,omitempty"`
	PushName    *string       `json:"pushName,omitempty"`
	ConnectedAt *string       `json:"connectedAt,omitempty"`
	LastActive  *string       `json:"lastActive,omitempty"`
	CreatedAt   string        `json:"createdAt"`
	UpdatedAt   string        `json:"updatedAt"`
	LastError   *string       `json:"lastError,omitempty"`
	// Restriction reports a limit WhatsApp itself has placed on the account, or nil when there is
	// none. Distinct from LastError, which describes a fault on the gateway's side.
	Restriction *AccountRestriction `json:"restriction,omitempty"`
	// EngineLoaded reports whether the gateway holds a live engine for this session -- the
	// precondition stop/logout/force-kill require and start refuses. Not derivable from Status:
	// "disconnected" covers both a session mid automatic-reconnect (engine present) and one stopped
	// with no engine. Nil from a gateway that predates the field.
	EngineLoaded bool `json:"engineLoaded"`
}

// ProxyType is the scheme of a session proxy.
type ProxyType string

const (
	ProxyHTTP   ProxyType = "http"
	ProxyHTTPS  ProxyType = "https"
	ProxySOCKS4 ProxyType = "socks4"
	ProxySOCKS5 ProxyType = "socks5"
)

// CreateSessionRequest is the body for creating a session. ProxyType is one of:
// http, https, socks4, socks5.
type CreateSessionRequest struct {
	Name      string         `json:"name"`
	Config    map[string]any `json:"config,omitempty"`
	ProxyURL  string         `json:"proxyUrl,omitempty"`
	ProxyType ProxyType      `json:"proxyType,omitempty"`
}

// SessionProxy is the masked per-session proxy configuration returned by GET/PATCH /proxy.
type SessionProxy struct {
	Enabled        bool       `json:"enabled"`
	ProxyType      *ProxyType `json:"proxyType"`
	ProxyHost      *string    `json:"proxyHost"`
	HasCredentials bool       `json:"hasCredentials"`
}

// UpdateSessionProxyRequest updates per-session proxy settings. Changes apply on the next start,
// not to a running engine.
//
// Three states, the same shape as UpdateSessionConfigRequest: an absent key leaves the proxy
// unchanged, an explicit null clears it, and a value sets it. `omitempty` on a nil pointer OMITS the
// key rather than emitting null, so clearing needs its own flag and the MarshalJSON below.
type UpdateSessionProxyRequest struct {
	ProxyURL *string `json:"-"`

	// ClearProxyURL sends an explicit null, removing the proxy. It wins over ProxyURL if both are set.
	ClearProxyURL bool `json:"-"`
}

// MarshalJSON emits only what the caller addressed: the Clear flag becomes an explicit null, a
// non-nil pointer becomes its value, and neither leaves the key out so the server keeps the proxy
// it already has.
func (r UpdateSessionProxyRequest) MarshalJSON() ([]byte, error) {
	out := map[string]any{}
	if r.ClearProxyURL {
		out["proxyUrl"] = nil
	} else if r.ProxyURL != nil {
		out["proxyUrl"] = *r.ProxyURL
	}
	return json.Marshal(out)
}

// QrCodeResponse carries the current QR code for a session awaiting scan.
type QrCodeResponse struct {
	QrCode string        `json:"qrCode"`
	Status SessionStatus `json:"status"`
}

// PairingCodeResponse carries a phone-pairing code.
type PairingCodeResponse struct {
	PairingCode string `json:"pairingCode"`
	Status      string `json:"status"`
}

// RequestPairingCodeRequest requests a pairing code for a phone number.
type RequestPairingCodeRequest struct {
	PhoneNumber string `json:"phoneNumber"`
}

// MemoryUsage is the process memory snapshot in the stats overview.
type MemoryUsage struct {
	HeapUsed  int64 `json:"heapUsed"`
	HeapTotal int64 `json:"heapTotal"`
	RSS       int64 `json:"rss"`
}

// SessionStatsOverview is the aggregate session stats payload.
type SessionStatsOverview struct {
	Total        int            `json:"total"`
	Active       int            `json:"active"`
	Ready        int            `json:"ready"`
	Disconnected int            `json:"disconnected"`
	ByStatus     map[string]int `json:"byStatus,omitempty"`
	MemoryUsage  MemoryUsage    `json:"memoryUsage"`
}

// SessionConfig is a session's effective runtime configuration. A nil MaxReconnectAttempts means
// unlimited — not unset.
type SessionConfig struct {
	AutoRejectCalls      bool `json:"autoRejectCalls"`
	MaxReconnectAttempts *int `json:"maxReconnectAttempts"`
	ReconnectBaseDelay   int  `json:"reconnectBaseDelay"`
}

// UpdateSessionConfigRequest is a partial update of a RUNNING session's config — no re-link, no QR
// scan.
//
// The route needs THREE states per field, not two: a key that is absent leaves the value unchanged, a
// key sent as explicit null clears it back to the default, and a value sets it. A `*int` with
// `omitempty` can only express the first and the third — a nil pointer is OMITTED, never emitted as
// null — so the one operation this route exists for, restoring `maxReconnectAttempts` to unlimited
// (which no in-range number can express), was unreachable. The Clear* flags carry the null case, and
// MarshalJSON below is what actually emits it.
type UpdateSessionConfigRequest struct {
	AutoRejectCalls      *bool `json:"-"`
	MaxReconnectAttempts *int  `json:"-"`
	ReconnectBaseDelay   *int  `json:"-"`

	// ClearMaxReconnectAttempts sends an explicit null, restoring unlimited reconnect attempts. It
	// wins over MaxReconnectAttempts if both are set.
	ClearMaxReconnectAttempts bool `json:"-"`
	// ClearAutoRejectCalls sends an explicit null, restoring the server default.
	ClearAutoRejectCalls bool `json:"-"`
	// ClearReconnectBaseDelay sends an explicit null, restoring the server default.
	ClearReconnectBaseDelay bool `json:"-"`
}

// MarshalJSON emits only the fields the caller actually addressed: a Clear* flag becomes an explicit
// null, a non-nil pointer becomes its value, and a field that is neither is left out entirely so the
// server leaves it unchanged.
func (r UpdateSessionConfigRequest) MarshalJSON() ([]byte, error) {
	out := map[string]any{}
	if r.ClearAutoRejectCalls {
		out["autoRejectCalls"] = nil
	} else if r.AutoRejectCalls != nil {
		out["autoRejectCalls"] = *r.AutoRejectCalls
	}
	if r.ClearMaxReconnectAttempts {
		out["maxReconnectAttempts"] = nil
	} else if r.MaxReconnectAttempts != nil {
		out["maxReconnectAttempts"] = *r.MaxReconnectAttempts
	}
	if r.ClearReconnectBaseDelay {
		out["reconnectBaseDelay"] = nil
	} else if r.ReconnectBaseDelay != nil {
		out["reconnectBaseDelay"] = *r.ReconnectBaseDelay
	}
	return json.Marshal(out)
}

// DeliveryFailureQuery filters the cross-session webhook list and the delivery-failure log. Nil
// fields are omitted from the query string. SessionID is ignored by the plain webhook list.
type DeliveryFailureQuery struct {
	SessionID *string
	Limit     *int
	Offset    *int
}

func (q *DeliveryFailureQuery) values() url.Values {
	v := url.Values{}
	if q == nil {
		return v
	}
	setStr(v, "sessionId", q.SessionID)
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	return v
}

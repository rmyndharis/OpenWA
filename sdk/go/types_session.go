package openwa

import "net/url"

// ListSessionsQuery paginates GET /sessions. Both fields optional.
type ListSessionsQuery struct {
	Limit  *int
	Offset *int
}

func (q *ListSessionsQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
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
	// Name is left alone when nil.
	Name *string `json:"name,omitempty"`
	// Color is WhatsApp's colour INDEX (0-19), NOT a hex value — it does not round-trip with the
	// HexColor labels are read back with, because neither engine exposes the mapping. Nil leaves the
	// current colour alone.
	Color *int `json:"color,omitempty"`
}

// ParticipantPresence is one participant's presence within a chat.
type ParticipantPresence struct {
	ID string `json:"id"`
	// State is one of: available, unavailable, composing, recording, paused. "composing" and
	// "recording" mean actively typing or recording; "paused" means they stopped.
	State string `json:"state"`
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
	Kind string `json:"kind"`
	// Code is the engine's own token for the cause, verbatim (TOS_BLOCK, BIZ_QUALITY, ...).
	Code string `json:"code"`
	// ExpiresAt is an ISO timestamp for the end of enforcement, when WhatsApp states one.
	ExpiresAt *string `json:"expiresAt,omitempty"`
}

// SessionResponse describes a WhatsApp session. Status is one of: created,
// initializing, qr_ready, authenticating, ready, disconnected, action_required,
// failed.
type SessionResponse struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Status      string  `json:"status"`
	Phone       *string `json:"phone,omitempty"`
	PushName    *string `json:"pushName,omitempty"`
	ConnectedAt *string `json:"connectedAt,omitempty"`
	LastActive  *string `json:"lastActive,omitempty"`
	CreatedAt   string  `json:"createdAt,omitempty"`
	UpdatedAt   string  `json:"updatedAt,omitempty"`
	LastError   *string `json:"lastError,omitempty"`
	// Restriction reports a limit WhatsApp itself has placed on the account, or nil when there is
	// none. Distinct from LastError, which describes a fault on the gateway's side.
	Restriction *AccountRestriction `json:"restriction,omitempty"`
	// EngineLoaded reports whether the gateway holds a live engine for this session -- the
	// precondition stop/logout/force-kill require and start refuses. Not derivable from Status:
	// "disconnected" covers both a session mid automatic-reconnect (engine present) and one stopped
	// with no engine. Nil from a gateway that predates the field.
	EngineLoaded *bool `json:"engineLoaded,omitempty"`
}

// CreateSessionRequest is the body for creating a session. ProxyType is one of:
// http, https, socks4, socks5.
type CreateSessionRequest struct {
	Name      string         `json:"name"`
	Config    map[string]any `json:"config,omitempty"`
	ProxyURL  string         `json:"proxyUrl,omitempty"`
	ProxyType string         `json:"proxyType,omitempty"`
}

// QrCodeResponse carries the current QR code for a session awaiting scan.
type QrCodeResponse struct {
	QrCode string `json:"qrCode"`
	Status string `json:"status"`
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

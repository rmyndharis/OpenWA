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

// SessionResponse describes a WhatsApp session. Status is one of: created,
// initializing, qr_ready, authenticating, ready, disconnected, failed.
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

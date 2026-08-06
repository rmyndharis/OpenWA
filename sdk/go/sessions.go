package openwa

import "context"

// SessionsService manages the lifecycle of WhatsApp sessions.
// Backed by src/modules/session/session.controller.ts.
type SessionsService struct{ client *Client }

// List returns sessions. Pass nil for the default (server-side) limit/offset.
func (s *SessionsService) List(ctx context.Context, query *ListSessionsQuery) ([]SessionResponse, error) {
	var out []SessionResponse
	err := s.client.do(ctx, "GET", "/api/sessions", valuesOf(query), nil, &out)
	return out, err
}

// Get returns a single session.
func (s *SessionsService) Get(ctx context.Context, sessionID string) (*SessionResponse, error) {
	var out SessionResponse
	err := s.client.do(ctx, "GET", "/api/sessions/"+pathEscape(sessionID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Create provisions a new session.
func (s *SessionsService) Create(ctx context.Context, body CreateSessionRequest) (*SessionResponse, error) {
	var out SessionResponse
	err := s.client.do(ctx, "POST", "/api/sessions", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a session.
func (s *SessionsService) Delete(ctx context.Context, sessionID string) error {
	return s.client.do(ctx, "DELETE", "/api/sessions/"+pathEscape(sessionID), nil, nil, nil)
}

// Start connects a session (triggers QR / pairing).
func (s *SessionsService) Start(ctx context.Context, sessionID string) (*SessionResponse, error) {
	var out SessionResponse
	err := s.client.do(ctx, "POST", "/api/sessions/"+pathEscape(sessionID)+"/start", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Stop disconnects a session gracefully.
func (s *SessionsService) Stop(ctx context.Context, sessionID string) (*SessionResponse, error) {
	var out SessionResponse
	err := s.client.do(ctx, "POST", "/api/sessions/"+pathEscape(sessionID)+"/stop", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Logout attempts an engine-native unlink of this device, then tears the session down. A 200
// means the unlink operation AND the required local credential cleanup completed — it is not an
// independent observation that the handset UI no longer shows the linked device. Because a
// completed unlink wipes the stored credentials, a later Start requires a fresh QR scan or
// pairing code. Requires a running session. Returns an HTTP 502 error with
// code 'SESSION_LOGOUT_INCOMPLETE' when the session was stopped locally but the logout operation
// did not complete (no send, no acknowledgement, timeout/transport error, or local cleanup
// failure); phone is cleared and no success audit is written. Start the session again and retry
// the logout; do not assume the retry reconnects automatically or lands in a guaranteed QR state.
func (s *SessionsService) Logout(ctx context.Context, sessionID string) (*SessionResponse, error) {
	var out SessionResponse
	err := s.client.do(ctx, "POST", "/api/sessions/"+pathEscape(sessionID)+"/logout", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ForceKill terminates a stuck session immediately.
func (s *SessionsService) ForceKill(ctx context.Context, sessionID string) (*SessionResponse, error) {
	var out SessionResponse
	err := s.client.do(ctx, "POST", "/api/sessions/"+pathEscape(sessionID)+"/force-kill", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// QRCode returns the current QR code for a session awaiting scan.
func (s *SessionsService) QRCode(ctx context.Context, sessionID string) (*QrCodeResponse, error) {
	var out QrCodeResponse
	err := s.client.do(ctx, "GET", "/api/sessions/"+pathEscape(sessionID)+"/qr", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RequestPairingCode requests a phone-pairing code.
func (s *SessionsService) RequestPairingCode(ctx context.Context, sessionID string, body RequestPairingCodeRequest) (*PairingCodeResponse, error) {
	var out PairingCodeResponse
	err := s.client.do(ctx, "POST", "/api/sessions/"+pathEscape(sessionID)+"/pairing-code", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Stats returns the aggregate session stats overview.
func (s *SessionsService) Stats(ctx context.Context) (*SessionStatsOverview, error) {
	var out SessionStatsOverview
	err := s.client.do(ctx, "GET", "/api/sessions/stats/overview", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

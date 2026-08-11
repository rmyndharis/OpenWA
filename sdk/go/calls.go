package openwa

import "context"

// CallsService acts on incoming voice/video calls.
// Backed by src/modules/call/call.controller.ts.
type CallsService struct{ client *Client }

// CreateCallLinkRequest is the body for CallsService.CreateLink. Type is "audio" or "video";
// WhatsApp's own URL path for audio is /voice/. StartTime is absolute epoch MILLISECONDS.
type CreateCallLinkRequest struct {
	Type      string  `json:"type"`
	StartTime float64 `json:"startTime"`
}

// CallLinkResponse carries the shareable WhatsApp call link.
type CallLinkResponse struct {
	Link string `json:"link"`
}

func (s *CallsService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/calls"
}

// RejectCall rejects a ringing incoming call; callID comes from the
// call.received event (CallReceivedPayload.CallID). A call can only be
// rejected while it is still ringing — otherwise the server responds 404.
// Requires an OPERATOR-level key.
func (s *CallsService) RejectCall(ctx context.Context, sessionID, callID string) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/"+pathEscape(callID)+"/reject", nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateLink creates a shareable WhatsApp call link.
//
// Both fields are required. StartTime is absolute epoch MILLISECONDS — a link for right now is the
// current timestamp rather than a zero value, because whatsapp-web.js generates an event-linked call
// and has no notion of "no start time". A WhatsApp-side failure answers 403 rather than a success
// carrying an empty link.
func (s *CallsService) CreateLink(
	ctx context.Context, sessionID string, body CreateCallLinkRequest,
) (*CallLinkResponse, error) {
	var out CallLinkResponse
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/link", nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

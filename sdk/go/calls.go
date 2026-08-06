package openwa

import "context"

// CallsService acts on incoming voice/video calls.
// Backed by src/modules/call/call.controller.ts.
type CallsService struct{ client *Client }

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

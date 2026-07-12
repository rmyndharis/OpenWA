package openwa

import "context"

// StatusService posts and reads WhatsApp Status (Stories). This is distinct from
// session lifecycle status. Backed by src/modules/status/status.controller.ts.
type StatusService struct{ client *Client }

func (s *StatusService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/status"
}

// List returns the current status/stories grouped by contact.
func (s *StatusService) List(ctx context.Context, sessionID string) (map[string][]StatusRecord, error) {
	var out map[string][]StatusRecord
	err := s.client.do(ctx, "GET", s.base(sessionID), nil, nil, &out)
	return out, err
}

// FromContact returns the status/stories from a specific contact.
func (s *StatusService) FromContact(ctx context.Context, sessionID, contactID string) (map[string][]StatusRecord, error) {
	var out map[string][]StatusRecord
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(contactID), nil, nil, &out)
	return out, err
}

// SendText posts a text status.
func (s *StatusService) SendText(ctx context.Context, sessionID string, body SendTextStatusRequest) (*StatusRecord, error) {
	return s.send(ctx, sessionID, "/send-text", body)
}

// SendImage posts an image status.
func (s *StatusService) SendImage(ctx context.Context, sessionID string, body SendImageStatusRequest) (*StatusRecord, error) {
	return s.send(ctx, sessionID, "/send-image", body)
}

// SendVideo posts a video status.
func (s *StatusService) SendVideo(ctx context.Context, sessionID string, body SendVideoStatusRequest) (*StatusRecord, error) {
	return s.send(ctx, sessionID, "/send-video", body)
}

func (s *StatusService) send(ctx context.Context, sessionID, suffix string, body any) (*StatusRecord, error) {
	var out StatusRecord
	err := s.client.do(ctx, "POST", s.base(sessionID)+suffix, nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a status post.
func (s *StatusService) Delete(ctx context.Context, sessionID, statusID string) error {
	return s.client.do(ctx, "DELETE", s.base(sessionID)+"/"+pathEscape(statusID), nil, nil, nil)
}

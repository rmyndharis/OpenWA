package openwa

import "context"

// LabelsService manages WhatsApp Business chat labels. The session must be a
// business account. Backed by src/modules/label/label.controller.ts.
type LabelsService struct{ client *Client }

func (s *LabelsService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/labels"
}

// List returns all labels.
func (s *LabelsService) List(ctx context.Context, sessionID string) ([]LabelRecord, error) {
	var out []LabelRecord
	err := s.client.do(ctx, "GET", s.base(sessionID), nil, nil, &out)
	return out, err
}

// Get returns a single label.
func (s *LabelsService) Get(ctx context.Context, sessionID, labelID string) (*LabelRecord, error) {
	var out LabelRecord
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(labelID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ForChat returns the labels applied to a chat.
func (s *LabelsService) ForChat(ctx context.Context, sessionID, chatID string) ([]LabelRecord, error) {
	var out []LabelRecord
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/chat/"+pathEscape(chatID), nil, nil, &out)
	return out, err
}

// AddToChat applies a label to a chat. Requires an OPERATOR-level key.
func (s *LabelsService) AddToChat(ctx context.Context, sessionID, chatID string, body AddLabelRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+"/chat/"+pathEscape(chatID), nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveFromChat removes a label from a chat. Requires an OPERATOR-level key.
func (s *LabelsService) RemoveFromChat(ctx context.Context, sessionID, chatID, labelID string) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "DELETE", s.base(sessionID)+"/chat/"+pathEscape(chatID)+"/"+pathEscape(labelID), nil, nil, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

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

// Chats returns every chat carrying a label.
//
// whatsapp-web.js only — Baileys has label writes but no label query of any kind, and answers 501.
func (s *LabelsService) Chats(ctx context.Context, sessionID, labelID string) ([]ChatSummary, error) {
	var out []ChatSummary
	err := s.client.do(ctx, "GET", s.base(sessionID)+"/"+pathEscape(labelID)+"/chats", nil, nil, &out)
	return out, err
}

// Upsert creates or updates a label. Baileys only; whatsapp-web.js can read and assign labels but
// cannot edit one, and answers 501.
//
// PUT rather than POST because the caller chooses the id: WhatsApp carries one write keyed on it, so
// whether this creates or updates depends purely on whether that id already exists. Pick an unused
// id to create — reusing one rewrites that label rather than failing. Omitted fields are left alone.
func (s *LabelsService) Upsert(ctx context.Context, sessionID, labelID string, body UpsertLabelRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "PUT", s.base(sessionID)+"/"+pathEscape(labelID), nil, body, &out)
	return &out, err
}

// Delete removes a label; it disappears from every chat it was on. Baileys only.
func (s *LabelsService) Delete(ctx context.Context, sessionID, labelID string) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "DELETE", s.base(sessionID)+"/"+pathEscape(labelID), nil, nil, &out)
	return &out, err
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

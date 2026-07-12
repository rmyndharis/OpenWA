package openwa

import "context"

// ChatsService operates on the chat list (read/unread/delete/typing state).
// These endpoints live under the session controller (/api/sessions/:id/chats/*).
type ChatsService struct{ client *Client }

func (s *ChatsService) base(sessionID string) string {
	return "/api/sessions/" + pathEscape(sessionID) + "/chats"
}

// List returns chats for a session.
func (s *ChatsService) List(ctx context.Context, sessionID string, query *ListChatsQuery) ([]ChatSummary, error) {
	var out []ChatSummary
	err := s.client.do(ctx, "GET", s.base(sessionID), valuesOf(query), nil, &out)
	return out, err
}

// MarkRead marks a chat as read.
func (s *ChatsService) MarkRead(ctx context.Context, sessionID string, body MarkChatRequest) (*SuccessResult, error) {
	return s.post(ctx, sessionID, "/read", body)
}

// MarkUnread marks a chat as unread.
func (s *ChatsService) MarkUnread(ctx context.Context, sessionID string, body MarkChatRequest) (*SuccessResult, error) {
	return s.post(ctx, sessionID, "/unread", body)
}

// Delete deletes a chat.
func (s *ChatsService) Delete(ctx context.Context, sessionID string, body DeleteChatRequest) (*SuccessResult, error) {
	return s.post(ctx, sessionID, "/delete", body)
}

// SendState sends a typing/recording/paused state.
func (s *ChatsService) SendState(ctx context.Context, sessionID string, body SendChatStateRequest) (*SuccessResult, error) {
	return s.post(ctx, sessionID, "/typing", body)
}

func (s *ChatsService) post(ctx context.Context, sessionID, suffix string, body any) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", s.base(sessionID)+suffix, nil, body, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

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

// SubscribePresence asks WhatsApp to start reporting a chat's presence; updates then arrive as
// presence.update webhook/socket events. Presence cannot be fetched from either engine, only
// received.
//
// The subscription belongs to the connection and does NOT survive a restart or an automatic
// reconnect, so re-issue it when the session comes back. Subscribe per chat: WhatsApp emits an
// update on every transition, so a broad subscription is a firehose. whatsapp-web.js answers 501.
func (s *ChatsService) SubscribePresence(ctx context.Context, sessionID string, body MarkChatRequest) (*SuccessResult, error) {
	var out SuccessResult
	err := s.client.do(ctx, "POST", "/api/sessions/"+pathEscape(sessionID)+"/presence/subscribe", nil, body, &out)
	return &out, err
}

// GetPresence returns the last presence reported for a chat, or nil when none has been — the chat
// was never subscribed, or nothing has changed since. Held in memory, so a restart clears it.
func (s *ChatsService) GetPresence(ctx context.Context, sessionID, chatID string) (*ChatPresence, error) {
	var out *ChatPresence
	err := s.client.do(
		ctx, "GET", "/api/sessions/"+pathEscape(sessionID)+"/presence/"+pathEscape(chatID), nil, nil, &out,
	)
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

// Archive archives or unarchives a chat. A false Success means the engine
// declined — on Baileys a chat with no known history cannot be archived.
func (s *ChatsService) Archive(ctx context.Context, sessionID string, body ArchiveChatRequest) (*SuccessResult, error) {
	return s.post(ctx, sessionID, "/archive", body)
}

// ClearMessages deletes every message in a chat, keeping the chat itself. A
// false Success means the engine declined — an unknown chat, or on Baileys a
// chat with no known history.
func (s *ChatsService) ClearMessages(ctx context.Context, sessionID, chatID string) (*SuccessResult, error) {
	var out SuccessResult
	path := s.base(sessionID) + "/" + pathEscape(chatID) + "/messages"
	if err := s.client.do(ctx, "DELETE", path, nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
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

package openwa

import "net/url"

// ChatSummary is a chat-list entry.
type ChatSummary struct {
	ID          string  `json:"id"`
	Name        *string `json:"name,omitempty"`
	IsGroup     bool    `json:"isGroup"`
	UnreadCount int     `json:"unreadCount"`
	LastMessage string  `json:"lastMessage,omitempty"`
	Timestamp   any     `json:"timestamp,omitempty"`
}

// MarkChatRequest marks a chat read/unread.
type MarkChatRequest struct {
	ChatID string `json:"chatId"`
}

// SendChatStateRequest sets typing state. State is one of: typing, recording, paused.
type SendChatStateRequest struct {
	ChatID string `json:"chatId"`
	State  string `json:"state"`
}

// DeleteChatRequest deletes a chat.
type DeleteChatRequest struct {
	ChatID string `json:"chatId"`
}

// ListChatsQuery paginates the chat list.
type ListChatsQuery struct {
	Limit  *int
	Offset *int
}

func (q *ListChatsQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	return v
}

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
	Kind        string  `json:"kind"`
}

// SetOwnPresenceRequest is the body for SessionsService.SetOnlinePresence. Available reports
// whether the account should appear online (true) or offline (false).
type SetOwnPresenceRequest struct {
	Available bool `json:"available"`
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

// ArchiveChatRequest archives or unarchives a chat.
type ArchiveChatRequest struct {
	ChatID  string `json:"chatId"`
	Archive bool   `json:"archive"`
}

// PinChatRequest pins a chat to the top of the list, or unpins it.
type PinChatRequest struct {
	ChatID string `json:"chatId"`
	Pin    bool   `json:"pin"`
}

// MuteChatRequest mutes a chat until an absolute timestamp, or unmutes it.
type MuteChatRequest struct {
	ChatID string `json:"chatId"`
	// MuteUntil is an absolute epoch-MILLISECONDS timestamp, or nil to unmute now.
	//
	// Milliseconds, not seconds: a seconds-scale value is an instant in 1970, so the mute expires
	// the moment it is set while the request still answers 200.
	//
	// Deliberately no omitempty. The route requires the key, so a nil MuteUntil has to reach it as
	// an explicit null — omitting it is rejected, and the two readings of an absent value, unmute
	// now and mute indefinitely, are opposites.
	MuteUntil *int64 `json:"muteUntil"`
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

package openwa

import "net/url"

// ChatSummary is a chat-list entry.
type ChatSummary struct {
	ID              string      `json:"id"`
	Name            string      `json:"name"`
	IsGroup         bool        `json:"isGroup"`
	UnreadCount     int         `json:"unreadCount"`
	LastMessage     string      `json:"lastMessage,omitempty"`
	LastMessageType MessageType `json:"lastMessageType,omitempty"`
	Timestamp       int64       `json:"timestamp"`
	Kind            ChatKind    `json:"kind"`
	Archived        bool        `json:"archived"`
	Pinned          bool        `json:"pinned"`
	// Muted reports whether the chat is muted right now, not the expiry behind it.
	Muted bool `json:"muted"`
	// MuteExpiration is the epoch milliseconds the mute ends, present only when muted; 0 means
	// indefinitely. A pointer so an absent expiry and a 0 (indefinite) stay distinct on the wire.
	MuteExpiration *int64 `json:"muteExpiration,omitempty"`
}

// SetOwnPresenceRequest is the body for SessionsService.SetOnlinePresence. Available reports
// whether the account should appear online (true) or offline (false).
type SetOwnPresenceRequest struct {
	Available bool `json:"available"`
}

// MarkChatRequest marks a chat unread.
type MarkChatRequest struct {
	ChatID string `json:"chatId"`
}

// SubscribePresenceRequest subscribes to a chat's presence.
type SubscribePresenceRequest struct {
	ChatID string `json:"chatId"`
}

// MarkChatReadRequest marks a chat read, optionally naming the messages to acknowledge.
type MarkChatReadRequest struct {
	ChatID string `json:"chatId"`
	// MessageIDs are the messages to acknowledge (at most 100; an empty list is refused). Baileys
	// acknowledges individual messages, so without this only the newest received message gets a
	// receipt: the one the engine holds in memory, else the newest received one the gateway
	// stored. Ignored by whatsapp-web.js, whose own sendSeen is chat-level.
	//
	// A POINTER because the three states differ on the wire and a plain slice cannot tell two of
	// them apart: nil omits the key (acknowledge the newest), &[]string{} sends [] (the server
	// refuses it with a 400), and a populated slice names the messages. With `[]string` plus
	// omitempty an empty slice was dropped, so a caller asking for nothing to be acknowledged
	// silently acknowledged the newest message instead.
	MessageIDs *[]string `json:"messageIds,omitempty"`
}

// ChatState is the typing indicator a chat shows.
type ChatState string

const (
	ChatStateTyping    ChatState = "typing"
	ChatStateRecording ChatState = "recording"
	ChatStatePaused    ChatState = "paused"
)

// SendChatStateRequest sets typing state. State is one of: typing, recording, paused.
type SendChatStateRequest struct {
	ChatID string    `json:"chatId"`
	State  ChatState `json:"state"`
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

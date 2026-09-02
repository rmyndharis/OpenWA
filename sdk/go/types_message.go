package openwa

import (
	"encoding/json"
	"net/url"
)

// MessageResponse is the acknowledgement for a sent message.
type MessageResponse struct {
	MessageID string `json:"messageId"`
	Timestamp int64  `json:"timestamp"`
}

// SendTextRequest sends a plain text message.
type SendTextRequest struct {
	ChatID string `json:"chatId"`
	Text   string `json:"text"`
	// Mentions lists WIDs to @mention (e.g. ["62811@c.us"]). The text must
	// also contain the @<number> token.
	Mentions []string `json:"mentions,omitempty"`
	// LinkPreview controls the URL preview. False suppresses it on both engines. Otherwise the
	// engines differ: whatsapp-web.js builds one in-page by default, while on Baileys a preview is
	// OPT-IN — it needs true, because generating one is a blocking outbound fetch per URL.
	LinkPreview *bool `json:"linkPreview,omitempty"`
	// CustomLinkPreview attaches a preview you supply instead of one fetched from the URL. Nothing is
	// fetched, so it works even for a URL the gateway cannot reach. Baileys only — whatsapp-web.js
	// takes a boolean and answers 501. Cannot be combined with LinkPreview=false.
	CustomLinkPreview *CustomLinkPreview `json:"customLinkPreview,omitempty"`
	// QuotedMessageID quotes an earlier message, turning this send into a reply. Engine-specific:
	// whatsapp-web.js matches the serialized message id, Baileys the raw key id of a message it has
	// already stored. Omitted when empty, so an ordinary send carries no quote key.
	QuotedMessageID string `json:"quotedMessageId,omitempty"`
}

// SendMediaRequest sends image/video/document/sticker media. Provide exactly
// one of URL or Base64. For audio use SendAudioRequest (PTT lives there).
type SendMediaRequest struct {
	ChatID   string `json:"chatId"`
	URL      string `json:"url,omitempty"`
	Base64   string `json:"base64,omitempty"`
	Mimetype string `json:"mimetype,omitempty"`
	Filename string `json:"filename,omitempty"`
	Caption  string `json:"caption,omitempty"`
	// QuotedMessageID quotes an earlier message, turning this send into a reply. Engine-specific:
	// whatsapp-web.js matches the serialized message id, Baileys the raw key id of a message it has
	// already stored. Omitted when empty, so an ordinary send carries no quote key.
	QuotedMessageID string `json:"quotedMessageId,omitempty"`
	// WIDs to @mention; the caption must also contain the @<number> token.
	Mentions []string `json:"mentions,omitempty"`
}

// SendAudioRequest sends audio. PTT sends as a voice note. Server only accepts
// PTT on /send-audio, so it is kept off the shared media struct to avoid a 400.
type SendAudioRequest struct {
	ChatID   string `json:"chatId"`
	URL      string `json:"url,omitempty"`
	Base64   string `json:"base64,omitempty"`
	Mimetype string `json:"mimetype,omitempty"`
	Filename string `json:"filename,omitempty"`
	Caption  string `json:"caption,omitempty"`
	PTT      *bool  `json:"ptt,omitempty"`
	// QuotedMessageID quotes an earlier message, turning this send into a reply. Engine-specific:
	// whatsapp-web.js matches the serialized message id, Baileys the raw key id of a message it has
	// already stored. Omitted when empty, so an ordinary send carries no quote key.
	QuotedMessageID string `json:"quotedMessageId,omitempty"`
	// WIDs to @mention; the caption must also contain the @<number> token. Kept here as well as on
	// SendMediaRequest because this struct is flattened rather than embedding it.
	Mentions []string `json:"mentions,omitempty"`
}

// SendLocationRequest sends a location pin. ChatID/Latitude/Longitude required.
type SendLocationRequest struct {
	ChatID      string  `json:"chatId"`
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	Description string  `json:"description,omitempty"`
	Address     string  `json:"address,omitempty"`
	// QuotedMessageID quotes an earlier message, turning this send into a reply. Engine-specific:
	// whatsapp-web.js matches the serialized message id, Baileys the raw key id of a message it has
	// already stored. Omitted when empty, so an ordinary send carries no quote key.
	QuotedMessageID string `json:"quotedMessageId,omitempty"`
}

// SendContactRequest sends a contact card.
type SendContactRequest struct {
	ChatID        string `json:"chatId"`
	ContactName   string `json:"contactName"`
	ContactNumber string `json:"contactNumber"`
	// QuotedMessageID quotes an earlier message, turning this send into a reply. Engine-specific:
	// whatsapp-web.js matches the serialized message id, Baileys the raw key id of a message it has
	// already stored. Omitted when empty, so an ordinary send carries no quote key.
	QuotedMessageID string `json:"quotedMessageId,omitempty"`
}

// SendTemplateRequest sends a stored template. Provide exactly one of
// TemplateID or TemplateName.
type SendTemplateRequest struct {
	ChatID       string            `json:"chatId"`
	TemplateID   string            `json:"templateId,omitempty"`
	TemplateName string            `json:"templateName,omitempty"`
	Vars         map[string]string `json:"vars,omitempty"`
	// Mentions lists WIDs to @mention in the rendered body, which must carry the @<number> token.
	Mentions []string `json:"mentions,omitempty"`
	// LinkPreview controls the URL preview on the rendered body, with the same engine split as
	// SendTextRequest. A pointer so an explicit false is distinguishable from "not set".
	LinkPreview *bool `json:"linkPreview,omitempty"`
}

// SendPollRequest sends a native WhatsApp poll. Options holds the choices to
// vote on (WhatsApp allows between 2 and 12).
type SendPollRequest struct {
	ChatID string `json:"chatId"`
	// Name is the poll question / title (max 255 chars).
	Name    string   `json:"name"`
	Options []string `json:"options"`
	// AllowMultipleAnswers lets voters pick several options (default single choice).
	AllowMultipleAnswers *bool `json:"allowMultipleAnswers,omitempty"`
	// QuotedMessageID quotes an earlier message, turning this send into a reply. Engine-specific:
	// whatsapp-web.js matches the serialized message id, Baileys the raw key id of a message it has
	// already stored. Omitted when empty, so an ordinary send carries no quote key.
	QuotedMessageID string `json:"quotedMessageId,omitempty"`
}

// ReplyMessageRequest replies to a quoted message.
type ReplyMessageRequest struct {
	ChatID          string `json:"chatId"`
	QuotedMessageID string `json:"quotedMessageId"`
	Text            string `json:"text"`
	// Mentions lists WIDs to @mention. The text must also contain the @<number> token.
	Mentions []string `json:"mentions,omitempty"`
}

// ForwardMessageRequest forwards a message between chats.
type ForwardMessageRequest struct {
	FromChatID string `json:"fromChatId"`
	ToChatID   string `json:"toChatId"`
	MessageID  string `json:"messageId"`
}

// ReactMessageRequest adds an emoji reaction. Send an empty Emoji to remove.
type ReactMessageRequest struct {
	ChatID    string `json:"chatId"`
	MessageID string `json:"messageId"`
	Emoji     string `json:"emoji"`
}

// DeleteMessageRequest deletes a message. ForEveryone defaults to true server-side.
type DeleteMessageRequest struct {
	ChatID      string `json:"chatId"`
	MessageID   string `json:"messageId"`
	ForEveryone *bool  `json:"forEveryone,omitempty"`
}

// EditMessageRequest edits the text of a message sent by this account. Body is
// the replacement text, capped at 4096 chars server-side (the same limit as
// send-text — an edit cannot exceed what a send allows).
type EditMessageRequest struct {
	ChatID    string `json:"chatId"`
	MessageID string `json:"messageId"`
	Body      string `json:"body"`
	// Mentions re-applies participant tags: an edit REPLACES the body rather than amending it, so
	// tags the original carried are lost unless resent.
	Mentions []string `json:"mentions,omitempty"`
}

// ListMessagesQuery filters GET /sessions/:id/messages.
type ListMessagesQuery struct {
	ChatID *string
	From   *string
	Limit  *int
	Offset *int
	// After is a keyset cursor: the id of the last message of the previous page. Takes
	// precedence over Offset.
	After *string
}

func (q *ListMessagesQuery) values() url.Values {
	v := url.Values{}
	setStr(v, "chatId", q.ChatID)
	setStr(v, "from", q.From)
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
	setStr(v, "after", q.After)
	return v
}

// MessageHistoryQuery filters the live chat history read.
type MessageHistoryQuery struct {
	Limit        *int
	IncludeMedia *bool
	Deep         *bool
}

func (q *MessageHistoryQuery) values() url.Values {
	v := url.Values{}
	setInt(v, "limit", q.Limit)
	setBool(v, "includeMedia", q.IncludeMedia)
	setBool(v, "deep", q.Deep)
	return v
}

// DeliveryStatus is a message's send/read lifecycle state.
type DeliveryStatus string

const (
	DeliveryPending   DeliveryStatus = "pending"
	DeliverySent      DeliveryStatus = "sent"
	DeliveryDelivered DeliveryStatus = "delivered"
	DeliveryRead      DeliveryStatus = "read"
	DeliveryFailed    DeliveryStatus = "failed"
)

// MessageRecord is a persisted message row.
type MessageRecord struct {
	ID            string           `json:"id"`
	SessionID     string           `json:"sessionId"`
	WaMessageID   *string          `json:"waMessageId,omitempty"`
	ChatID        string           `json:"chatId"`
	From          string           `json:"from"`
	To            string           `json:"to"`
	Body          *string          `json:"body,omitempty"`
	Type          string           `json:"type"`
	Direction     MessageDirection `json:"direction"`
	ChatName      *string          `json:"chatName,omitempty"`
	Author        *string          `json:"author,omitempty"`
	MediaPath     *string          `json:"mediaPath,omitempty"`
	MediaMimetype *string          `json:"mediaMimetype,omitempty"`
	Timestamp     *int64           `json:"timestamp,omitempty"`
	Metadata      map[string]any   `json:"metadata,omitempty"`
	Status        DeliveryStatus   `json:"status"`
	CreatedAt     string           `json:"createdAt"`
}

// MessageListResponse is the paginated message list payload.
type MessageListResponse struct {
	Messages []MessageRecord `json:"messages"`
	Total    int             `json:"total"`
}

// ChatHistoryMedia is the media block on a live history message.
type ChatHistoryMedia struct {
	Mimetype  string `json:"mimetype,omitempty"`
	Filename  string `json:"filename,omitempty"`
	Data      string `json:"data,omitempty"`
	Omitted   bool   `json:"omitted,omitempty"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
}

// QuotedMessage is the quoted-message block on a live history message.
type QuotedMessage struct {
	ID   string `json:"id,omitempty"`
	Body string `json:"body,omitempty"`
}

// MessageLocation is the location block on a live history message.
type MessageLocation struct {
	Latitude    float64 `json:"latitude,omitempty"`
	Longitude   float64 `json:"longitude,omitempty"`
	Description string  `json:"description,omitempty"`
	Address     string  `json:"address,omitempty"`
	URL         string  `json:"url,omitempty"`
}

// ChatHistoryMessage is a message read live from WhatsApp by Messages.History —
// the richer engine payload, differently shaped from MessageRecord.
type ChatHistoryMessage struct {
	ID                string          `json:"id"`
	From              string          `json:"from"`
	To                string          `json:"to"`
	ChatID            string          `json:"chatId"`
	Body              string          `json:"body"`
	Type              MessageType     `json:"type"`
	Timestamp         int64           `json:"timestamp"`
	FromMe            bool            `json:"fromMe"`
	IsGroup           bool            `json:"isGroup"`
	IsStatusBroadcast bool            `json:"isStatusBroadcast,omitempty"`
	Kind              ChatKind        `json:"kind"`
	EphemeralDuration int             `json:"ephemeralDuration,omitempty"`
	Author            string          `json:"author,omitempty"`
	MentionedIDs      []string        `json:"mentionedIds,omitempty"`
	Call              *MessageCall    `json:"call,omitempty"`
	IsLidSender       bool            `json:"isLidSender,omitempty"`
	SenderPhone       *string         `json:"senderPhone,omitempty"`
	Contact           *MessageContact `json:"contact,omitempty"`
	BackgroundColor   string          `json:"backgroundColor,omitempty"`
	// Pointer because font index 0 is a real style, so a value type could not tell it from absent.
	// Matches StatusRecord.Font, which carries the same wire field.
	Font          *int              `json:"font,omitempty"`
	Media         *ChatHistoryMedia `json:"media,omitempty"`
	QuotedMessage *QuotedMessage    `json:"quotedMessage,omitempty"`
	Location      *MessageLocation  `json:"location,omitempty"`
}

// MessageCall is the call block on a live history message, present on call messages only.
type MessageCall struct {
	Video  bool `json:"video"`
	Missed bool `json:"missed"`
}

// MessageContact is the sender contact block on a live history message. History carries PushName
// only; the richer fields arrive on message.received when WEBHOOK_CONTACT_DETAILS is enabled.
type MessageContact struct {
	ID           string `json:"id,omitempty"`
	Number       string `json:"number,omitempty"`
	Name         string `json:"name,omitempty"`
	PushName     string `json:"pushName,omitempty"`
	ShortName    string `json:"shortName,omitempty"`
	Type         string `json:"type,omitempty"`
	IsMyContact  bool   `json:"isMyContact,omitempty"`
	IsWAContact  bool   `json:"isWAContact,omitempty"`
	IsBusiness   bool   `json:"isBusiness,omitempty"`
	IsEnterprise bool   `json:"isEnterprise,omitempty"`
	VerifiedName string `json:"verifiedName,omitempty"`
	// Pointer for the same reason as Font: level 0 (unverified) is a real value, not "absent".
	VerifiedLevel *int     `json:"verifiedLevel,omitempty"`
	IsBlocked     bool     `json:"isBlocked,omitempty"`
	Labels        []string `json:"labels,omitempty"`
}

// ReactionSender is one sender within a ReactionRecord.
type ReactionSender struct {
	SenderID  string `json:"senderId"`
	Emoji     string `json:"emoji"`
	Timestamp int64  `json:"timestamp"`
}

// ReactionRecord groups everyone who reacted with a given emoji.
type ReactionRecord struct {
	Emoji   string           `json:"emoji"`
	Senders []ReactionSender `json:"senders"`
}

// BulkMediaContent is a per-item media block for a bulk send. It mirrors the
// server's BulkMediaDto whitelist (url/base64/mimetype/filename/ptt) exactly. It
// deliberately omits chatId (the parent BulkMessageItem carries it) and caption
// (which lives at the BulkMessageContent level, not on the media object) so the
// server's forbidNonWhitelisted validator does not reject a stray field.
//
// PTT applies to audio only: set it true to send the audio as a WhatsApp voice
// note. It is ignored for image/video/document.
type BulkMediaContent struct {
	URL      string `json:"url,omitempty"`
	Base64   string `json:"base64,omitempty"`
	Mimetype string `json:"mimetype,omitempty"`
	Filename string `json:"filename,omitempty"`
	PTT      bool   `json:"ptt,omitempty"`
}

// BulkMessageContent is the per-item content of a bulk send.
type BulkMessageContent struct {
	Text     string            `json:"text,omitempty"`
	Image    *BulkMediaContent `json:"image,omitempty"`
	Video    *BulkMediaContent `json:"video,omitempty"`
	Audio    *BulkMediaContent `json:"audio,omitempty"`
	Document *BulkMediaContent `json:"document,omitempty"`
	Caption  string            `json:"caption,omitempty"`
	// Mentions is per item: a batch fans out to many chats, and a WID is only taggable in a chat
	// the participant is in.
	Mentions []string `json:"mentions,omitempty"`
}

// BulkMessageItem is one message in a bulk send. Type is one of: text, image,
// video, audio, document.
type BulkMessageItem struct {
	ChatID    string             `json:"chatId"`
	Type      BulkMessageType    `json:"type"`
	Content   BulkMessageContent `json:"content"`
	Variables map[string]string  `json:"variables,omitempty"`
}

// BulkOptions tunes bulk delivery pacing and error behavior.
type BulkOptions struct {
	DelayBetweenMessages *int  `json:"delayBetweenMessages,omitempty"`
	RandomizeDelay       *bool `json:"randomizeDelay,omitempty"`
	StopOnError          *bool `json:"stopOnError,omitempty"`
}

// SendBulkRequest queues a batch of messages.
type SendBulkRequest struct {
	Messages []BulkMessageItem `json:"messages"`
	Options  *BulkOptions      `json:"options,omitempty"`
	BatchID  string            `json:"batchId,omitempty"`
}

// BulkMessageResponse is the send-bulk acknowledgement.
type BulkMessageResponse struct {
	BatchID                 string `json:"batchId"`
	Status                  string `json:"status"`
	TotalMessages           int    `json:"totalMessages"`
	EstimatedCompletionTime string `json:"estimatedCompletionTime,omitempty"`
	StatusURL               string `json:"statusUrl"`
}

// BatchError is a per-message failure in a batch result.
type BatchError struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// BatchMessageStatus is one recipient's send outcome inside a batch.
type BatchMessageStatus string

const (
	BatchPending   BatchMessageStatus = "pending"
	BatchSent      BatchMessageStatus = "sent"
	BatchFailed    BatchMessageStatus = "failed"
	BatchCancelled BatchMessageStatus = "cancelled"
)

// BatchLifecycleStatus is the lifecycle of a whole batch.
type BatchLifecycleStatus string

const (
	BatchLifecyclePending    BatchLifecycleStatus = "pending"
	BatchLifecycleProcessing BatchLifecycleStatus = "processing"
	BatchLifecycleCompleted  BatchLifecycleStatus = "completed"
	BatchLifecycleFailed     BatchLifecycleStatus = "failed"
	BatchLifecycleCancelled  BatchLifecycleStatus = "cancelled"
)

// MessageType is the engine-normalized message kind.
type MessageType string

const (
	MsgText     MessageType = "text"
	MsgImage    MessageType = "image"
	MsgVideo    MessageType = "video"
	MsgAudio    MessageType = "audio"
	MsgVoice    MessageType = "voice"
	MsgDocument MessageType = "document"
	MsgSticker  MessageType = "sticker"
	MsgLocation MessageType = "location"
	MsgContact  MessageType = "contact"
	MsgPoll     MessageType = "poll"
	MsgCall     MessageType = "call"
	MsgRevoked  MessageType = "revoked"
	MsgMasked   MessageType = "masked"
	MsgUnknown  MessageType = "unknown"
)

// BulkMessageType is the media kind a bulk item may carry.
type BulkMessageType string

const (
	BulkText     BulkMessageType = "text"
	BulkImage    BulkMessageType = "image"
	BulkVideo    BulkMessageType = "video"
	BulkAudio    BulkMessageType = "audio"
	BulkDocument BulkMessageType = "document"
)

// ChatKind is the conversation kind a chat/message belongs to.
type ChatKind string

const (
	KindIndividual ChatKind = "individual"
	KindGroup      ChatKind = "group"
	KindChannel    ChatKind = "channel"
	KindStatus     ChatKind = "status"
	KindBroadcast  ChatKind = "broadcast"
	KindUnknown    ChatKind = "unknown"
)

// MessageDirection is which way a search hit traveled.
type MessageDirection string

const (
	DirectionIncoming MessageDirection = "incoming"
	DirectionOutgoing MessageDirection = "outgoing"
)

// BatchMessageResult is one message's outcome within a batch.
type BatchMessageResult struct {
	ChatID    string             `json:"chatId"`
	Status    BatchMessageStatus `json:"status"`
	MessageID string             `json:"messageId,omitempty"`
	SentAt    string             `json:"sentAt,omitempty"`
	Error     *BatchError        `json:"error,omitempty"`
}

// BatchProgress is the aggregate progress of a batch.
type BatchProgress struct {
	Total     int `json:"total"`
	Sent      int `json:"sent"`
	Failed    int `json:"failed"`
	Pending   int `json:"pending"`
	Cancelled int `json:"cancelled"`
}

// BatchStatusResponse is the response from the batch status / cancel endpoints.
type BatchStatusResponse struct {
	BatchID     string               `json:"batchId"`
	Status      BatchLifecycleStatus `json:"status"`
	Progress    BatchProgress        `json:"progress"`
	Results     []BatchMessageResult `json:"results"`
	StartedAt   *string              `json:"startedAt,omitempty"`
	CompletedAt *string              `json:"completedAt,omitempty"`
}

// MessageMedia is a message's stored media: the raw bytes plus the served
// content type. Non-JSON on the wire, like StatusMedia.
type MessageMedia struct {
	Data        []byte
	ContentType string
}

// PinDurationSeconds is one of the three windows WhatsApp accepts for a pinned message.
type PinDurationSeconds int

const (
	PinOneDay     PinDurationSeconds = 86400
	PinSevenDays  PinDurationSeconds = 604800
	PinThirtyDays PinDurationSeconds = 2592000
)

// PinMessageRequest pins a message in its chat. DurationSeconds must be 86400
// (24h), 604800 (7d) or 2592000 (30d); omit it to take the server default of 24h.
type PinMessageRequest struct {
	ChatID          string             `json:"chatId"`
	MessageID       string             `json:"messageId"`
	DurationSeconds PinDurationSeconds `json:"durationSeconds,omitempty"`
}

// UnpinMessageRequest removes a message's pin.
type UnpinMessageRequest struct {
	ChatID    string `json:"chatId"`
	MessageID string `json:"messageId"`
}

// StarMessageRequest stars or unstars a message. Best-effort on whatsapp-web.js,
// which silently ignores a message it will not star.
type StarMessageRequest struct {
	ChatID    string `json:"chatId"`
	MessageID string `json:"messageId"`
	Star      bool   `json:"star"`
}

// VotePollRequest casts a vote on a poll. Options are option TEXTS, not ids —
// no engine surfaces stable per-option ids. An empty (or nil) slice clears the vote.
type VotePollRequest struct {
	ChatID        string   `json:"chatId"`
	PollMessageID string   `json:"pollMessageId"`
	Options       []string `json:"options"`
}

// MarshalJSON encodes a nil Options as `[]` rather than `null`.
//
// Clearing a vote is exactly the zero-value case, and the API requires the field to be an array:
// `null` fails validation with a 400, so the one thing the zero value should express was the one
// thing it could not. Omitting the field would fail the same way, which is why there is no
// `omitempty` here.
func (r VotePollRequest) MarshalJSON() ([]byte, error) {
	type alias VotePollRequest
	out := alias(r)
	if out.Options == nil {
		out.Options = []string{}
	}
	return json.Marshal(out)
}

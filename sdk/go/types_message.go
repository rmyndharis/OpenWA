package openwa

import "net/url"

// MessageResponse is the acknowledgement for a sent message.
type MessageResponse struct {
	MessageID string `json:"messageId"`
	Timestamp int64  `json:"timestamp"`
}

// SendTextRequest sends a plain text message.
type SendTextRequest struct {
	ChatID string `json:"chatId"`
	Text   string `json:"text"`
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
}

// SendLocationRequest sends a location pin. ChatID/Latitude/Longitude required.
type SendLocationRequest struct {
	ChatID      string  `json:"chatId"`
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	Description string  `json:"description,omitempty"`
	Address     string  `json:"address,omitempty"`
}

// SendContactRequest sends a contact card.
type SendContactRequest struct {
	ChatID        string `json:"chatId"`
	ContactName   string `json:"contactName"`
	ContactNumber string `json:"contactNumber"`
}

// SendTemplateRequest sends a stored template. Provide exactly one of
// TemplateID or TemplateName.
type SendTemplateRequest struct {
	ChatID       string            `json:"chatId"`
	TemplateID   string            `json:"templateId,omitempty"`
	TemplateName string            `json:"templateName,omitempty"`
	Vars         map[string]string `json:"vars,omitempty"`
}

// ReplyMessageRequest replies to a quoted message.
type ReplyMessageRequest struct {
	ChatID          string `json:"chatId"`
	QuotedMessageID string `json:"quotedMessageId"`
	Text            string `json:"text"`
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
}

// ListMessagesQuery filters GET /sessions/:id/messages.
type ListMessagesQuery struct {
	ChatID *string
	From   *string
	Limit  *int
	Offset *int
}

func (q *ListMessagesQuery) values() url.Values {
	v := url.Values{}
	setStr(v, "chatId", q.ChatID)
	setStr(v, "from", q.From)
	setInt(v, "limit", q.Limit)
	setInt(v, "offset", q.Offset)
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

// MessageRecord is a persisted message row.
type MessageRecord struct {
	ID          string         `json:"id"`
	SessionID   string         `json:"sessionId"`
	WaMessageID *string        `json:"waMessageId,omitempty"`
	ChatID      string         `json:"chatId"`
	From        string         `json:"from"`
	To          string         `json:"to"`
	Body        *string        `json:"body,omitempty"`
	Type        string         `json:"type"`
	Direction   string         `json:"direction"`
	Timestamp   *int64         `json:"timestamp,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
	Status      string         `json:"status"`
	CreatedAt   string         `json:"createdAt"`
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
	ID                string            `json:"id"`
	From              string            `json:"from"`
	To                string            `json:"to"`
	ChatID            string            `json:"chatId"`
	Body              string            `json:"body,omitempty"`
	Type              string            `json:"type"`
	Timestamp         int64             `json:"timestamp"`
	FromMe            bool              `json:"fromMe"`
	IsGroup           bool              `json:"isGroup"`
	IsStatusBroadcast bool              `json:"isStatusBroadcast"`
	Author            string            `json:"author,omitempty"`
	MentionedIDs      []string          `json:"mentionedIds,omitempty"`
	IsLidSender       bool              `json:"isLidSender,omitempty"`
	SenderPhone       *string           `json:"senderPhone,omitempty"`
	Media             *ChatHistoryMedia `json:"media,omitempty"`
	QuotedMessage     *QuotedMessage    `json:"quotedMessage,omitempty"`
	Location          *MessageLocation  `json:"location,omitempty"`
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
}

// BulkMessageItem is one message in a bulk send. Type is one of: text, image,
// video, audio, document.
type BulkMessageItem struct {
	ChatID    string             `json:"chatId"`
	Type      string             `json:"type"`
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
	EstimatedCompletionTime string `json:"estimatedCompletionTime"`
	StatusURL               string `json:"statusUrl"`
}

// BatchError is a per-message failure in a batch result.
type BatchError struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// BatchMessageResult is one message's outcome within a batch.
type BatchMessageResult struct {
	ChatID    string      `json:"chatId"`
	Status    string      `json:"status"`
	MessageID string      `json:"messageId,omitempty"`
	SentAt    string      `json:"sentAt,omitempty"`
	Error     *BatchError `json:"error,omitempty"`
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
	Status      string               `json:"status"`
	Progress    BatchProgress        `json:"progress"`
	Results     []BatchMessageResult `json:"results,omitempty"`
	StartedAt   string               `json:"startedAt,omitempty"`
	CompletedAt string               `json:"completedAt,omitempty"`
}

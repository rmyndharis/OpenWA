package openwa

import "time"

// StatusContact is the poster of a status entry (from a GET list).
type StatusContact struct {
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
	PushName string `json:"pushName,omitempty"`
}

// StatusRecord is a status/story entry as returned by GET endpoints.
type StatusRecord struct {
	ID              string        `json:"id"`
	Contact         StatusContact `json:"contact"`
	Type            string        `json:"type,omitempty"`
	Caption         string        `json:"caption,omitempty"`
	MediaURL        string        `json:"mediaUrl,omitempty"`
	BackgroundColor string        `json:"backgroundColor,omitempty"`
	Font            *int          `json:"font,omitempty"`
	// The server types these as Date, which serializes to RFC 3339, so
	// time.Time decodes them directly. Zero when the server omits the field.
	Timestamp time.Time `json:"timestamp,omitempty"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
}

// StatusListResponse is the {"statuses": [...]} envelope returned by GET
// /sessions/:id/status and GET /sessions/:id/status/:contactId.
type StatusListResponse struct {
	Statuses []StatusRecord `json:"statuses"`
}

// StatusResult is the acknowledgement returned by Send{Text,Image,Video,Voice}Status.
// It intentionally differs from StatusRecord: the POST response has statusId +
// timing, no contact/media.
type StatusResult struct {
	StatusID  string    `json:"statusId"`
	Timestamp time.Time `json:"timestamp,omitempty"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
}

// StatusMedia is the one non-JSON shape on the wire: the raw bytes of a stored
// status media file plus the Content-Type the server served them as. Returned
// by StatusService.Media; a 404 surfaces when no media is stored.
type StatusMedia struct {
	Data        []byte
	ContentType string
}

// SendTextStatusRequest posts a text status. Recipients is required on the Baileys
// engine only (absent/empty → 400 there); whatsapp-web.js ignores it — leave nil.
type SendTextStatusRequest struct {
	Text            string   `json:"text"`
	Recipients      []string `json:"recipients,omitempty"`
	BackgroundColor string   `json:"backgroundColor,omitempty"`
	Font            *int     `json:"font,omitempty"`
}

// StatusMediaInput is a status media payload: provide URL or Base64.
type StatusMediaInput struct {
	URL      string `json:"url,omitempty"`
	Base64   string `json:"base64,omitempty"`
	Mimetype string `json:"mimetype,omitempty"`
}

// SendImageStatusRequest posts an image status (nested {image:{...}} body).
// Recipients: required on the Baileys engine only; omit on whatsapp-web.js.
type SendImageStatusRequest struct {
	Image      StatusMediaInput `json:"image"`
	Recipients []string         `json:"recipients,omitempty"`
	Caption    string           `json:"caption,omitempty"`
}

// SendVideoStatusRequest posts a video status (nested {video:{...}} body).
// Recipients: required on the Baileys engine only; omit on whatsapp-web.js.
type SendVideoStatusRequest struct {
	Video      StatusMediaInput `json:"video"`
	Recipients []string         `json:"recipients,omitempty"`
	Caption    string           `json:"caption,omitempty"`
}

// SendVoiceStatusRequest posts an audio status as a voice note. It carries no
// caption: WhatsApp has nowhere to render one on a status voice note.
//
// Audio.Mimetype defaults to "audio/ogg; codecs=opus", the only format WhatsApp
// plays as a status voice note. Neither engine transcodes — produce those bytes
// with MediaService.ConvertVoice.
type SendVoiceStatusRequest struct {
	Audio      StatusMediaInput `json:"audio"`
	Recipients []string         `json:"recipients,omitempty"`
	// BackgroundColor as "#RRGGBB", rendered behind the voice-note bubble.
	// Baileys only; whatsapp-web.js ignores it.
	BackgroundColor string `json:"backgroundColor,omitempty"`
}

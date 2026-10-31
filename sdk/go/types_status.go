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
	Type            string        `json:"type"`
	Caption         string        `json:"caption,omitempty"`
	MediaURL        string        `json:"mediaUrl,omitempty"`
	BackgroundColor string        `json:"backgroundColor,omitempty"`
	Font            *int          `json:"font,omitempty"`
	// The server types these as Date, which serializes to RFC 3339, so
	// time.Time decodes them directly. Zero when the server omits the field.
	Timestamp time.Time `json:"timestamp"`
	ExpiresAt time.Time `json:"expiresAt"`
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
	Timestamp time.Time `json:"timestamp"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// StatusMedia is the one non-JSON shape on the wire: the raw bytes of a stored
// status media file plus the Content-Type the server served them as. Returned
// by StatusService.Media; a 404 surfaces when no media is stored.
type StatusMedia struct {
	Data        []byte
	ContentType string
}

// StatusFont is a WhatsApp status font family: the wire value of the protocol's
// ExtendedTextMessage.FontType, and the constants carry the protocol's names for the ids. 3 to 5 are not
// part of the enum and the gateway rejects them. whatsapp-web.js honors only 0 to 7 and posts 8, 9 and 10
// in the default font.
type StatusFont int

const (
	StatusFontDefault              StatusFont = 0  // SYSTEM
	StatusFontSystemText           StatusFont = 1  // SYSTEM_TEXT
	StatusFontFBScript             StatusFont = 2  // FB_SCRIPT
	StatusFontBold                 StatusFont = 6  // SYSTEM_BOLD
	StatusFontMorningBreezeRegular StatusFont = 7  // MORNINGBREEZE_REGULAR
	StatusFontCalistogaRegular     StatusFont = 8  // CALISTOGA_REGULAR
	StatusFontExo2ExtraBold        StatusFont = 9  // EXO2_EXTRABOLD
	StatusFontCourierPrimeBold     StatusFont = 10 // COURIERPRIME_BOLD
)

// The names below came with the first release of these constants. They do not match the protocol's names
// for the same ids (7 is MORNINGBREEZE_REGULAR there, not Oswald; 9 is EXO2_EXTRABOLD, not Morning Breeze),
// so they are kept only for code that already uses them. Each carries the wire value it always had.
const (
	// Deprecated: use StatusFontSystemText.
	StatusFontSerif StatusFont = StatusFontSystemText
	// Deprecated: use StatusFontFBScript.
	StatusFontNorican StatusFont = StatusFontFBScript
	// Deprecated: use StatusFontMorningBreezeRegular.
	StatusFontOswald StatusFont = StatusFontMorningBreezeRegular
	// Deprecated: use StatusFontCalistogaRegular.
	StatusFontDamion StatusFont = StatusFontCalistogaRegular
	// Deprecated: use StatusFontExo2ExtraBold.
	StatusFontMorningbreeze StatusFont = StatusFontExo2ExtraBold
	// Deprecated: use StatusFontCourierPrimeBold.
	StatusFontBryndan StatusFont = StatusFontCourierPrimeBold
)

// SendTextStatusRequest posts a text status. Recipients is required on the Baileys
// engine only (absent/empty → 400 there); whatsapp-web.js ignores it — leave nil.
type SendTextStatusRequest struct {
	Text            string      `json:"text"`
	Recipients      []string    `json:"recipients,omitempty"`
	BackgroundColor string      `json:"backgroundColor,omitempty"`
	Font            *StatusFont `json:"font,omitempty"`
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

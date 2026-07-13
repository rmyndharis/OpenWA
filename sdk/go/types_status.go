package openwa

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
	Timestamp       any           `json:"timestamp,omitempty"`
	ExpiresAt       any           `json:"expiresAt,omitempty"`
}

// StatusListResponse is the {"statuses": [...]} envelope returned by GET
// /sessions/:id/status and GET /sessions/:id/status/:contactId.
type StatusListResponse struct {
	Statuses []StatusRecord `json:"statuses"`
}

// StatusResult is the acknowledgement returned by Send{Text,Image,Video}Status.
// It intentionally differs from StatusRecord: the POST response has statusId +
// timing, no contact/media.
type StatusResult struct {
	StatusID  string `json:"statusId"`
	Timestamp any    `json:"timestamp,omitempty"`
	ExpiresAt any    `json:"expiresAt,omitempty"`
}

// SendTextStatusRequest posts a text status. Recipients is required.
type SendTextStatusRequest struct {
	Text            string   `json:"text"`
	Recipients      []string `json:"recipients"`
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
type SendImageStatusRequest struct {
	Image      StatusMediaInput `json:"image"`
	Recipients []string         `json:"recipients"`
	Caption    string           `json:"caption,omitempty"`
}

// SendVideoStatusRequest posts a video status (nested {video:{...}} body).
type SendVideoStatusRequest struct {
	Video      StatusMediaInput `json:"video"`
	Recipients []string         `json:"recipients"`
	Caption    string           `json:"caption,omitempty"`
}

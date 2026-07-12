package openwa

// StatusRecord is a status/story entry.
type StatusRecord struct {
	ID        string  `json:"id"`
	StatusID  string  `json:"statusId,omitempty"`
	Type      string  `json:"type,omitempty"`
	Body      *string `json:"body,omitempty"`
	Timestamp any     `json:"timestamp,omitempty"`
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

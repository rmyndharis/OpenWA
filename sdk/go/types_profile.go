package openwa

// SetProfileNameRequest sets the account display name (WhatsApp limit: 25
// chars).
type SetProfileNameRequest struct {
	Name string `json:"name"`
}

// SetProfileStatusRequest sets the account about/status text (WhatsApp limit:
// 139 chars). An empty Status clears it.
type SetProfileStatusRequest struct {
	Status string `json:"status"`
}

// SetProfilePictureRequest sets the account profile picture. Provide exactly
// one of URL (a public http/https image the server fetches) or Base64 (inline
// image data, with Mimetype).
type SetProfilePictureRequest struct {
	URL      string `json:"url,omitempty"`
	Base64   string `json:"base64,omitempty"`
	Mimetype string `json:"mimetype,omitempty"`
}

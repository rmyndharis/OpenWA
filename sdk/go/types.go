package openwa

// Wire types for the OpenWA API, split by domain into types_*.go files. Field
// names / JSON tags mirror the backend DTOs exactly (camelCase). Optional
// request fields use `omitempty` (and pointers where the zero value is
// meaningful); nullable response fields use pointers so absent and empty are
// distinguishable.
//
// The types_*.go files are the single source of truth for wire shapes and are
// structured so they can later be regenerated from openapi.json without
// touching the hand-written service methods (paths + DX live elsewhere).

// Ptr returns a pointer to v — handy for optional pointer fields:
//
//	openwa.DeleteMessageRequest{ChatID: id, MessageID: mid, ForEveryone: openwa.Ptr(false)}
func Ptr[T any](v T) *T { return &v }

// SuccessResult is the generic {success, message} acknowledgement.
type SuccessResult struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}

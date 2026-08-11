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

// ParticipantResult is one entry per requested participant, in the order they were requested.
//
// Success is true only when the engine confirmed the change for this participant. Engines that
// confirm the batch rather than each member report one success entry per requested id, so a true
// here does not always mean the engine spoke about that participant individually.
type ParticipantResult struct {
	ID      string `json:"id"`
	Success bool   `json:"success"`
	Status  int    `json:"status,omitempty"`
	// Message is the engine-reported reason, when it gave one.
	Message string `json:"message,omitempty"`
}

// ParticipantsResult is the response of the group membership writes.
//
// A partial refusal does NOT fail the batch — the request answers 200 and reports the
// per-participant outcome in Results, so Success alone hides a member that was rejected.
type ParticipantsResult struct {
	Success bool                `json:"success"`
	Message string              `json:"message,omitempty"`
	Results []ParticipantResult `json:"results"`
}

// ProductMessageResponse is the response of send-product.
//
// The route answers with the sent message's id under "id", not the "messageId" the other send
// routes use.
type ProductMessageResponse struct {
	ID string `json:"id"`
	// Timestamp is unix SECONDS the engine stamped on the outgoing message.
	Timestamp int64 `json:"timestamp"`
}

package openwa

import (
	"encoding/json"
	"strings"
	"testing"
)

// Clearing a vote is the zero value, and the API requires options to be an array: a nil slice
// encoded as `null` failed validation, so the one thing the zero value should express could not be.
func TestVotePollRequestEncodesNilOptionsAsEmptyArray(t *testing.T) {
	body, err := json.Marshal(VotePollRequest{ChatID: "628@c.us", PollMessageID: "M1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"options":[]`) {
		t.Fatalf("expected an empty array, got %s", body)
	}
	body, err = json.Marshal(VotePollRequest{ChatID: "628@c.us", PollMessageID: "M1", Options: []string{"Yes"}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"options":["Yes"]`) {
		t.Fatalf("expected the supplied options, got %s", body)
	}
}

package openwa

import (
	"encoding/json"
	"strings"
	"testing"
)

// Unmuting is a nil MuteUntil, and the route requires the key to be present: with `omitempty` the
// field would vanish from the body and the request would be rejected, so the one thing nil should
// express could not be. An omitted value is also ambiguous in a way null is not — unmute now and
// mute indefinitely are opposite readings of the same absence.
func TestMuteChatRequestEncodesNilMuteUntilAsExplicitNull(t *testing.T) {
	body, err := json.Marshal(MuteChatRequest{ChatID: "628@c.us"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"muteUntil":null`) {
		t.Errorf("nil MuteUntil must serialise as an explicit null, got %s", body)
	}
}

// The timestamp is epoch MILLISECONDS. A value rescaled to seconds points at an instant in 1970, so
// the mute expires immediately while the call still answers 200 — the wrong unit is invisible in the
// response and only observable on the wire.
func TestMuteChatRequestSendsEpochMillisecondsUnchanged(t *testing.T) {
	until := int64(1893456000000)
	body, err := json.Marshal(MuteChatRequest{ChatID: "628@c.us", MuteUntil: &until})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"muteUntil":1893456000000`) {
		t.Errorf("MuteUntil must reach the wire unscaled, got %s", body)
	}
}

package openwa

import (
	"context"
	"testing"
)

// Omitting `participants` tells the gateway to act on EVERY pending join request, so the empty
// slice and the nil slice must not reach the wire as the same body. `membershipRequestAction`
// already draws that line (`if participants != nil`), and every other client keys on null rather
// than emptiness: the JavaScript, Python and PHP clients send `{"participants": []}` for an empty
// list and the gateway answers 400 (`@ArrayNotEmpty`). An `omitempty` tag would erase the
// distinction after the check had made it, turning "approve nobody" into "approve everybody" —
// silently, and irreversibly for the group.
func TestMembershipRequestActionDistinguishesEmptyFromOmitted(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct {
		name         string
		participants []string
		wantBody     string
	}{
		{"nil acts on every pending request", nil, `{}`},
		{"empty slice names nobody", []string{}, `{"participants":[]}`},
		{"one id names that id", []string{"628111@c.us"}, `{"participants":["628111@c.us"]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rt := &recordTransport{status: 200, body: `{}`}
			c := newTestClient(t, rt)
			if _, err := c.Groups.ApproveMembershipRequests(ctx, "s1", "g1", tc.participants); err != nil {
				t.Fatalf("ApproveMembershipRequests: %v", err)
			}
			if got := string(rt.lastRaw); got != tc.wantBody {
				t.Errorf("body = %s, want %s", got, tc.wantBody)
			}
		})
	}
}

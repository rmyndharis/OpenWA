package openwa

import (
	"context"
	"encoding/json"
	"testing"
)

// The validate route reports whether the key is restricted to selected sessions.
func TestAuthValidateResponseDecodesScoped(t *testing.T) {
	var out AuthValidateResponse
	if err := json.Unmarshal([]byte(`{"valid":true,"role":"viewer","scoped":true}`), &out); err != nil {
		t.Fatal(err)
	}
	if !out.Scoped {
		t.Errorf("Scoped = false, want true")
	}
}

// Every key of the validate answer reaches its field: a renamed JSON tag would read the key as invalid, or
// drop its role, without any other test noticing.
func TestAuthValidateDecodesEveryField(t *testing.T) {
	rt := &recordTransport{status: 200, body: `{"valid":true,"role":"operator","engineType":"baileys","scoped":true}`}
	c := newTestClient(t, rt)
	out, err := c.Auth.Validate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rt.lastReq.Method != "POST" || rt.lastReq.URL.Path != "/api/auth/validate" {
		t.Errorf("request = %s %s, want POST /api/auth/validate", rt.lastReq.Method, rt.lastReq.URL.Path)
	}
	if !out.Valid || out.Role != "operator" || out.EngineType != "baileys" || !out.Scoped {
		t.Errorf("decoded %+v, want valid, role operator, engineType baileys, scoped", *out)
	}

	// A key the gateway refuses is answered with the one key.
	rt.body = `{"valid":false}`
	out, err = c.Auth.Validate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if out.Valid || out.Role != "" || out.EngineType != "" || out.Scoped {
		t.Errorf("decoded %+v, want an invalid key with nothing else", *out)
	}
}

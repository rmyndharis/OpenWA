package openwa

import (
	"encoding/json"
	"strings"
	"testing"
)

// Shared across the SDK suites; the gateway's generateSignature produces this
// header for this body.
const (
	webhookSecret = "test-secret-0123456789"
	webhookBody   = `{"event":"message.received","timestamp":"2026-02-02T10:00:00.000Z","sessionId":"s1","idempotencyKey":"k",` +
		`"deliveryId":"dlv_1","data":{"text":"h` + "éllo \U0001F44B" + `"}}`
	webhookHex = "d74a41bb687f31ed4c932f76f524116100ca4120d2cabb7a469ee5d928122f70"
)

func TestVerifyWebhookSignature(t *testing.T) {
	sig := "sha256=" + webhookHex
	if !VerifyWebhookSignature([]byte(webhookBody), sig, webhookSecret) {
		t.Fatal("valid signature rejected")
	}
	if !VerifyWebhookSignature([]byte(webhookBody), "sha256="+strings.ToUpper(webhookHex), webhookSecret) {
		t.Fatal("uppercase hex rejected")
	}

	tampered := []byte(webhookBody)
	tampered[10] ^= 1
	if VerifyWebhookSignature(tampered, sig, webhookSecret) {
		t.Fatal("changed body accepted")
	}
	if VerifyWebhookSignature([]byte(webhookBody), sig, "another-secret-012345") {
		t.Fatal("wrong secret accepted")
	}
	if VerifyWebhookSignature([]byte(webhookBody), sig, "") {
		t.Fatal("empty secret accepted")
	}
	for _, h := range []string{webhookHex, "SHA256=" + webhookHex, "sha256=" + webhookHex[1:], "sha256=" + webhookHex[1:] + "z", ""} {
		if VerifyWebhookSignature([]byte(webhookBody), h, webhookSecret) {
			t.Fatalf("malformed header %q accepted", h)
		}
	}
}

func TestWebhookDeliveryDecodesTestEvent(t *testing.T) {
	var d WebhookDelivery
	if err := json.Unmarshal([]byte(`{"event":"test","sessionId":"s1","deliveryId":"dlv_1","data":{"a":1}}`), &d); err != nil {
		t.Fatal(err)
	}
	if d.Event != "test" || d.SessionID != "s1" || d.DeliveryID != "dlv_1" || string(d.Data) != `{"a":1}` {
		t.Fatalf("decoded %+v", d)
	}
}

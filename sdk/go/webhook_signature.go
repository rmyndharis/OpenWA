package openwa

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// VerifyWebhookSignature checks a delivery's X-OpenWA-Signature header
// ("sha256=<hex HMAC-SHA256>") against the webhook secret. Pass the raw request
// body exactly as received; a re-serialized decode can differ byte for byte and
// will not verify. It returns false for a missing, malformed or non-matching
// signature and for an empty secret.
func VerifyWebhookSignature(body []byte, signature, secret string) bool {
	given, ok := strings.CutPrefix(signature, "sha256=")
	if !ok || len(given) != sha256.Size*2 || secret == "" {
		return false
	}
	want, err := hex.DecodeString(given)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), want)
}

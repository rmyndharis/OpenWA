"""Webhook delivery signature check."""

from __future__ import annotations

import hashlib
import hmac
import re

_SIGNATURE = re.compile(r"sha256=([0-9a-fA-F]{64})")


def verify_webhook_signature(raw_body: bytes | str, signature: str | None, secret: str) -> bool:
    """Check a delivery's ``X-OpenWA-Signature`` header (``sha256=<hex HMAC-SHA256>``) against the
    webhook secret.

    Pass the raw request body exactly as received; a re-serialized parse can differ byte for byte
    and will not verify. Returns False (never raises) for a missing, malformed or non-matching
    signature and for an empty secret.
    """
    match = _SIGNATURE.fullmatch(signature or "")
    if match is None or not secret:
        return False
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, match.group(1).lower())

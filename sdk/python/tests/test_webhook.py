"""Webhook signature helper."""

from __future__ import annotations

import pytest

from openwa import verify_webhook_signature
from openwa.types import WebhookDelivery

# Shared across the SDK suites; the gateway's generateSignature produces this header for this body.
SECRET = "test-secret-0123456789"
BODY = (
    '{"event":"message.received","timestamp":"2026-02-02T10:00:00.000Z","sessionId":"s1","idempotencyKey":"k",'
    '"deliveryId":"dlv_1","data":{"text":"héllo \U0001F44B"}}'
)
HEX = "d74a41bb687f31ed4c932f76f524116100ca4120d2cabb7a469ee5d928122f70"
SIGNATURE = f"sha256={HEX}"


def test_accepts_the_gateway_signature_over_text_or_bytes():
    assert verify_webhook_signature(BODY, SIGNATURE, SECRET)
    assert verify_webhook_signature(BODY.encode("utf-8"), SIGNATURE, SECRET)
    assert verify_webhook_signature(BODY, f"sha256={HEX.upper()}", SECRET)


@pytest.mark.parametrize(
    "header",
    [HEX, f"SHA256={HEX}", f"sha256={HEX[1:]}", f"sha256={HEX[1:]}z", f"sha256={HEX}\n", "", None],
)
def test_rejects_a_malformed_header(header):
    assert verify_webhook_signature(BODY, header, SECRET) is False


def test_rejects_a_changed_body_a_wrong_secret_and_an_empty_secret():
    tampered = bytearray(BODY.encode("utf-8"))
    tampered[10] ^= 1
    assert verify_webhook_signature(bytes(tampered), SIGNATURE, SECRET) is False
    assert verify_webhook_signature(BODY, SIGNATURE, "another-secret-012345") is False
    assert verify_webhook_signature(BODY, SIGNATURE, "") is False


def test_delivery_type_accepts_the_test_event():
    delivery: WebhookDelivery = {
        "event": "test",
        "timestamp": "2026-02-02T10:00:00.000Z",
        "sessionId": "s1",
        "idempotencyKey": "k",
        "deliveryId": "dlv_1",
        "data": {},
    }
    assert delivery["event"] == "test"

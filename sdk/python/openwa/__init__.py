"""
OpenWA Python SDK.

Official client library for the OpenWA WhatsApp API Gateway.

Example usage::

    from openwa import OpenWAClient

    client = OpenWAClient(
        base_url="http://localhost:2785",
        api_key="owa_k1_…",
    )

    # Sessions are addressed by the UUID that create() returns, not by name.
    session = client.sessions.create({"name": "my-session"})
    client.sessions.start(session["id"])
    result = client.messages.send_text(session["id"], {
        "chatId": "628123456789@c.us",
        "text": "Hello from the OpenWA Python SDK!",
    })
    print(result["messageId"])
"""

from __future__ import annotations

from .client import OpenWAClient
from .errors import (
    OpenWAApiError,
    OpenWAAuthError,
    OpenWAConflictError,
    OpenWAError,
    OpenWAForbiddenError,
    OpenWANotFoundError,
    OpenWANotImplementedError,
    OpenWAServiceUnavailableError,
    OpenWARateLimitError,
    OpenWATimeoutError,
)
from .webhook import verify_webhook_signature

__all__ = [
    "OpenWAClient",
    "OpenWAError",
    "OpenWAApiError",
    "OpenWAAuthError",
    "OpenWAForbiddenError",
    "OpenWANotFoundError",
    "OpenWAConflictError",
    "OpenWARateLimitError",
    "OpenWANotImplementedError",
    "OpenWAServiceUnavailableError",
    "OpenWATimeoutError",
    "verify_webhook_signature",
]

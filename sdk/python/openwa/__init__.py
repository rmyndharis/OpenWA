"""
OpenWA Python SDK.

Official client library for the OpenWA WhatsApp API Gateway.

Example usage::

    from openwa import OpenWAClient

    client = OpenWAClient(
        base_url="http://localhost:2785",
        api_key="owa_k1_…",
    )

    client.sessions.start("my-session")
    result = client.messages.send_text("my-session", {
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
    OpenWARateLimitError,
    OpenWATimeoutError,
)

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
    "OpenWATimeoutError",
]

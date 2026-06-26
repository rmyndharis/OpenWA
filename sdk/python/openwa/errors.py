"""Typed error hierarchy for the OpenWA Python SDK.

The OpenWA API returns NestJS-default errors of the shape::

    {"statusCode": int, "message": str | list[str], "error": str}

This module maps that to a typed, ergonomic error tree so callers can
``isinstance``-check or branch on ``.status``.
"""

from __future__ import annotations

from typing import Any


class OpenWAError(Exception):
    """Base class for every error raised by the SDK."""


class OpenWAApiError(OpenWAError):
    """Raised when the API responds with a non-2xx status.

    Attributes:
        status: HTTP status code.
        body: Parsed JSON body if available, otherwise the raw text.
        error_kind: Value of the ``error`` field in the NestJS envelope.
    """

    def __init__(self, message: str, status: int, body: Any = None, error_kind: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.error_kind = error_kind

    @classmethod
    def from_response(cls, status_code: int, text: str, context: str) -> "OpenWAApiError":
        import json

        body: Any = None
        if text:
            try:
                body = json.loads(text)
            except ValueError:
                body = text
        envelope = body if isinstance(body, dict) and "statusCode" in body else None
        raw_message = envelope.get("message") if envelope else body
        if isinstance(raw_message, list):
            message_text = ", ".join(str(m) for m in raw_message)
        elif isinstance(raw_message, str):
            message_text = raw_message
        else:
            message_text = str(raw_message)
        message = f"OpenWA API {status_code} — {context}: {message_text}"
        return classify(status_code, message, body, envelope.get("error") if envelope else None)


class OpenWAAuthError(OpenWAApiError):
    """401 Unauthorized — missing or invalid API key."""


class OpenWAForbiddenError(OpenWAApiError):
    """403 Forbidden — insufficient role."""


class OpenWANotFoundError(OpenWAApiError):
    """404 Not Found."""


class OpenWAConflictError(OpenWAApiError):
    """409 Conflict — typically an engine-not-ready condition."""


class OpenWARateLimitError(OpenWAApiError):
    """429 Too Many Requests."""


class OpenWANotImplementedError(OpenWAApiError):
    """501 Not Implemented — the active engine does not support this operation."""


class OpenWATimeoutError(OpenWAError):
    """Raised when a request exceeds the configured timeout."""

    def __init__(self, timeout: float) -> None:
        super().__init__(f"Request timed out after {timeout}s")
        self.timeout = timeout


def classify(status: int, message: str, body: Any, error_kind: str | None) -> OpenWAApiError:
    """Pick the most specific :class:`OpenWAApiError` subclass for a status."""
    cls = {
        401: OpenWAAuthError,
        403: OpenWAForbiddenError,
        404: OpenWANotFoundError,
        409: OpenWAConflictError,
        429: OpenWARateLimitError,
        501: OpenWANotImplementedError,
    }.get(status, OpenWAApiError)
    return cls(message, status, body, error_kind)

"""Typed error hierarchy for the OpenWA Python SDK.

The OpenWA API returns NestJS-default errors of the shape::

    {"statusCode": int, "message": str | list[str], "error": str}

This module maps that to a typed, ergonomic error tree so callers can
``isinstance``-check or branch on ``.status``.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Mapping


class OpenWAError(Exception):
    """Base class for every error raised by the SDK."""


class OpenWAApiError(OpenWAError):
    """Raised when the API responds with a non-2xx status.

    Attributes:
        status: HTTP status code.
        body: Parsed JSON body if available, otherwise the raw text.
        error_kind: Value of the ``error`` field in the NestJS envelope.
        code: The body's machine-readable ``code`` (e.g. ``SEND_PACING_LIMITED``), if any.
        retry_after_seconds: Seconds to wait before retrying: the body's ``retryAfterSeconds``
            when present, else the ``Retry-After`` header (seconds or an HTTP date), else None.
        headers: The response headers, when the error came from a response.
    """

    def __init__(
        self,
        message: str,
        status: int,
        body: Any = None,
        error_kind: str | None = None,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.error_kind = error_kind
        self.headers = headers
        fields = body if isinstance(body, dict) else {}
        code = fields.get("code")
        self.code: str | None = code if isinstance(code, str) else None
        header = next((v for k, v in (headers or {}).items() if k.lower() == "retry-after"), None)
        self.retry_after_seconds = _retry_after_seconds(fields.get("retryAfterSeconds"), header)

    @classmethod
    def from_response(
        cls, status_code: int, text: str, context: str, *, headers: Mapping[str, str] | None = None
    ) -> "OpenWAApiError":
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
        return classify(status_code, message, body, envelope.get("error") if envelope else None, headers=headers)


class OpenWAAuthError(OpenWAApiError):
    """401 Unauthorized — missing or invalid API key."""


class OpenWAForbiddenError(OpenWAApiError):
    """403 Forbidden: the API key's role or scope (session, IP or chat allow-list) refuses the call."""


class OpenWANotFoundError(OpenWAApiError):
    """404 Not Found."""


class OpenWAConflictError(OpenWAApiError):
    """409 Conflict — typically an engine-not-ready condition."""


class OpenWARateLimitError(OpenWAApiError):
    """429 Too Many Requests.

    The global rate limiter's 429 lifts when its window expires (seconds for the
    per-second tier, up to an hour for the hourly tier by default), and
    ``retry_after_seconds`` carries its Retry-After header. A 429 with code
    "SEND_PACING_LIMITED" is not transient: do not retry it before
    ``retry_after_seconds``, which then comes from the body and can be hours.
    """


class OpenWANotImplementedError(OpenWAApiError):
    """501 Not Implemented — the active engine does not support this operation."""


class OpenWAServiceUnavailableError(OpenWAApiError):
    """503 Service Unavailable -- a transport failure, not a refusal.

    The gateway answers this when the engine did not confirm the operation in time: WhatsApp never
    replied, the socket was down, or the request budget ran out. Retryable, but a catalog 503 can
    persist because WhatsApp may never answer that query, so bound any retry. The non-idempotent
    sends are deliberately left unbounded by the gateway so a slow WhatsApp reply never answers
    one, and in a multi-node deployment a forwarded request answers 503 only when the owner node
    was never reached. A forward that fails after the request was sent answers 502 or 504 instead
    (a plain OpenWAApiError): the owner may already have carried it out, so do not repeat a
    non-idempotent send on those unchecked.
    """


class OpenWATimeoutError(OpenWAError):
    """Raised when a request exceeds the configured timeout."""

    def __init__(self, timeout: float) -> None:
        super().__init__(f"Request timed out after {timeout}s")
        self.timeout = timeout


def classify(
    status: int, message: str, body: Any, error_kind: str | None, *, headers: Mapping[str, str] | None = None
) -> OpenWAApiError:
    """Pick the most specific :class:`OpenWAApiError` subclass for a status."""
    cls = {
        401: OpenWAAuthError,
        403: OpenWAForbiddenError,
        404: OpenWANotFoundError,
        409: OpenWAConflictError,
        429: OpenWARateLimitError,
        501: OpenWANotImplementedError,
        503: OpenWAServiceUnavailableError,
    }.get(status, OpenWAApiError)
    return cls(message, status, body, error_kind, headers=headers)


def _retry_after_seconds(from_body: Any, header: str | None) -> int | None:
    """The body's ``retryAfterSeconds`` wins: send pacing puts its wait (possibly hours) only there,
    and a header added by a proxy must not shorten it. Otherwise read ``Retry-After`` as seconds or
    an HTTP date, clamped at 0."""
    if isinstance(from_body, (int, float)) and not isinstance(from_body, bool) and 0 <= from_body < math.inf:
        return math.ceil(from_body)
    value = (header or "").strip()
    if not value:
        return None
    if value.isascii() and value.isdigit():
        return int(value)
    try:
        at = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if at is None:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return max(0, math.ceil((at - datetime.now(timezone.utc)).total_seconds()))

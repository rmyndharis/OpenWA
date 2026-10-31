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
    """Base class for errors the SDK raises for an API response or a timeout.

    Connection failures surface as ``httpx.TransportError``; an invalid argument (a missing
    ``base_url`` or ``api_key``, an empty or dot path segment) raises ``ValueError``.
    """


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

    def __reduce__(self) -> tuple[Any, ...]:
        # Exception pickles only `args` (the message), which cannot rebuild an error that needs a status.
        return (_rebuild_api_error, (type(self), self.args[0], self.status, self.body, self.error_kind, self.headers))

    @classmethod
    def from_response(
        cls,
        status_code: int,
        text: str,
        context: str,
        *,
        headers: Mapping[str, str] | None = None,
        reason: str | None = None,
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
        elif raw_message is None:
            # An empty body (a proxy's bare 502) or an envelope with no message: the status text is all
            # there is, and "None" would be read as the reason.
            message_text = reason or "no response body"
        else:
            message_text = str(raw_message)
        message = f"OpenWA API {status_code} — {context}: {message_text}"
        return classify(status_code, message, body, envelope.get("error") if envelope else None, headers=headers)


class OpenWAAuthError(OpenWAApiError):
    """401 Unauthorized — missing or invalid API key."""


class OpenWAForbiddenError(OpenWAApiError):
    """403 Forbidden: the API key's role or scope (session, IP or chat allow-list) refuses the call,
    or WhatsApp itself refused the operation (for example, missing group admin rights).
    """


class OpenWANotFoundError(OpenWAApiError):
    """404 Not Found."""


class OpenWAConflictError(OpenWAApiError):
    """409 Conflict: a conflicting state, typically a session that is not ready for the operation, or a keyed send that is pending or may already have been sent (see ``code``)."""


class OpenWARateLimitError(OpenWAApiError):
    """429 Too Many Requests.

    The global rate limiter's 429 lifts when its window expires (seconds for the
    per-second tier, up to an hour for the hourly tier by default), and
    ``retry_after_seconds`` carries its Retry-After header. A 429 with code
    "SEND_PACING_LIMITED" is usually not transient: do not retry it before
    ``retry_after_seconds``, which then comes from the body: a few seconds
    when only sends still in flight caused it, the rest of the failure
    breaker's cooldown (SEND_PACING_BREAKER_COOLDOWN_MS, 15 minutes by
    default) after a run of send failures, otherwise up to the next UTC day.
    """


class OpenWANotImplementedError(OpenWAApiError):
    """501 Not Implemented — the active engine does not support this operation."""


class OpenWAServiceUnavailableError(OpenWAApiError):
    """503 Service Unavailable: the gateway could not complete the request right now.

    The path to WhatsApp failed (WhatsApp never replied, the socket was down, or the request budget
    ran out), the gateway is draining or short of a dependency, or, on Baileys, WhatsApp itself
    throttled (code 429) or timed out (code 408) the request; a throttle or timeout names its code
    in the message. Retryable, but back off and retry later instead of at once: repeating a throttled
    request straight away prolongs the throttle. A catalog 503 can persist because WhatsApp may
    never answer that query, so bound any retry.

    On a send or a single write, a throttle turned the request away before it ran, so nothing was
    sent or applied. A send also sent nothing when its recipient lookup failed, its connection
    closed before the message was written, or its media or preview image URL could not be fetched
    through the session's proxy. Each of these frees a keyed send's ``Idempotency-Key`` for the
    retry. A group settings update with several fields applies them one at a time, so a 503 on a
    later field, a throttle included, leaves the earlier ones applied; the message lists them after
    ``already applied:``, so re-read the settings before retrying, or send one field per request. Any
    other timeout proves nothing: the write may still have been applied, and a keyed send keeps its key
    taken. The non-idempotent sends are deliberately left unbounded by the gateway so a slow
    WhatsApp reply never answers one, and in a multi-node deployment a forward that fails before
    reaching the owner node answers 503. A 503 from the owner itself is relayed unchanged and keeps
    its meaning, so a bounded write (group, channel, contact or profile change) that timed out may
    still have been applied; re-read the state before repeating it. A forward that fails after the
    request was sent answers 502 or 504 instead (a plain OpenWAApiError): the owner may already have
    carried it out, so do not repeat a non-idempotent send on those unchecked.
    """


class OpenWATimeoutError(OpenWAError):
    """Raised when a request exceeds the configured timeout."""

    def __init__(self, timeout: float) -> None:
        super().__init__(f"Request timed out after {timeout}s")
        self.timeout = timeout

    def __reduce__(self) -> tuple[Any, ...]:
        # `args` holds the formatted message, which would be formatted again on the way back.
        return (type(self), (self.timeout,))


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


def _rebuild_api_error(
    cls: type[OpenWAApiError],
    message: str,
    status: int,
    body: Any,
    error_kind: str | None,
    headers: Mapping[str, str] | None,
) -> OpenWAApiError:
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
        try:
            return int(value)
        except ValueError:
            # Past the interpreter's integer string limit: unparseable, like a malformed date below.
            return None
    try:
        at = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if at is None:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return max(0, math.ceil((at - datetime.now(timezone.utc)).total_seconds()))

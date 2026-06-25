"""HTTP transport wrapper for the OpenWA Python SDK.

The client never builds a bare :class:`httpx.Client` with a hard-coded
transport. Instead it accepts an optional ``transport`` (an ``httpx.BaseTransport``)
that overrides the default. This makes the SDK trivially testable — a test
passes ``httpx.MockTransport(handler)`` instead of monkey-patching — and lets
consumers intercept/observability-wrap outbound calls.
"""

from __future__ import annotations

from typing import Any, Mapping
from urllib.parse import quote

import httpx

from .errors import OpenWAApiError, OpenWATimeoutError, classify

HttpMethod = str  # "GET" | "POST" | "PUT" | "PATCH" | "DELETE"


def quote_segment(segment: Any) -> str:
    """Percent-encode a single path segment so a value containing ``/``, ``#`` or
    ``?`` can't break out of its path position. WhatsApp-id characters that are
    already path-safe (``@``, ``:``, ``+``) are kept readable.
    """
    return quote(str(segment), safe="@:+")


def build_url(base_url: str, path: str, query: Mapping[str, Any] | None = None) -> str:
    """Build a URL, serializing query params and skipping ``None`` values."""
    url = f"{base_url.rstrip('/')}{path}"
    if not query:
        return url

    def _serialize(v: Any) -> str:
        # Booleans must be lowercase: the backend reads query flags as `=== 'true'`,
        # so Python's default str(True) == 'True' would be silently ignored.
        if v is True:
            return "true"
        if v is False:
            return "false"
        return str(v)

    params = {k: _serialize(v) for k, v in query.items() if v is not None}
    if not params:
        return url
    req = httpx.Request("GET", url, params=params)
    # httpx.Request already encoded params into the URL string.
    return str(req.url)


class HttpExecutor:
    """Owns the :class:`httpx.Client` and performs JSON requests.

    Constructed once per :class:`OpenWAClient`; the transport is taken from
    the client config so all requests share one connection pool.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
        default_headers: Mapping[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        # Caller-supplied default headers are applied FIRST so the auth/JSON
        # headers below always win and can never be clobbered (mirrors the JS SDK).
        headers: dict[str, str] = {}
        if default_headers:
            headers.update(default_headers)
        headers["Content-Type"] = "application/json"
        headers["X-API-Key"] = api_key
        client_kwargs: dict[str, Any] = {
            "base_url": base_url.rstrip("/"),
            "headers": headers,
            "timeout": timeout,
            # Never auto-follow redirects: doing so would re-send the X-API-Key
            # header to the redirect target (potentially a different origin).
            # (This is also httpx's default; set explicitly so it can't regress.)
            "follow_redirects": False,
        }
        if transport is not None:
            client_kwargs["transport"] = transport
        self._client = httpx.Client(**client_kwargs)
        self._timeout = timeout

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HttpExecutor":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def request(self, method: HttpMethod, path: str, *, query: Mapping[str, Any] | None = None, body: Any = None) -> Any:
        """Perform one request and return the parsed JSON (or ``None`` for 204)."""
        url = build_url("", path, query)
        try:
            res = self._client.request(method, url, json=body if body is not None else None)
        except httpx.TimeoutException as e:
            raise OpenWATimeoutError(self._timeout) from e
        # Treat any non-2xx as an error, including 3xx: redirects are deliberately not followed
        # (so the API key is never re-sent to the target), which makes an unfollowed 3xx unusable
        # rather than a success. Matches the JS transport's `!res.ok`.
        if res.status_code >= 300:
            context = f"{method} {path}"
            raise OpenWAApiError.from_response(res.status_code, res.text, context)
        if res.status_code == 204 or not res.content:
            return None
        try:
            return res.json()
        except ValueError:
            # A 2xx body that isn't JSON surfaces as text rather than a raw
            # JSONDecodeError (mirrors the JS and PHP transports).
            return res.text

"""HTTP transport wrapper for the OpenWA Python SDK.

The client never builds a bare :class:`httpx.Client` with a hard-coded
transport. Instead it accepts an optional ``transport`` (an ``httpx.BaseTransport``)
that overrides the default. This makes the SDK trivially testable — a test
passes ``httpx.MockTransport(handler)`` instead of monkey-patching — and lets
consumers intercept/observability-wrap outbound calls.
"""

from __future__ import annotations

import math
from typing import Any, Mapping
from urllib.parse import quote

import httpx

from .errors import OpenWAApiError, OpenWATimeoutError, classify

HttpMethod = str  # "GET" | "POST" | "PUT" | "PATCH" | "DELETE"


def quote_segment(segment: Any) -> str:
    """Percent-encode a single path segment so a value containing ``/``, ``#`` or
    ``?`` can't break out of its path position. WhatsApp-id characters that are
    already path-safe (``@``, ``:``, ``+``) are kept readable.

    Raises :class:`ValueError` for an empty, ``.`` or ``..`` segment: httpx
    resolves dot segments before sending, so such an id would reach the
    parent resource instead of the intended one.
    """
    text = str(segment)
    if text in ("", ".", ".."):
        raise ValueError(f"OpenWA: empty or dot path segment {text!r}")
    return quote(text, safe="@:+")


def build_url(base_url: str, path: str, query: Mapping[str, Any] | None = None) -> str:
    """Build a URL, serializing query params and skipping ``None`` values.

    Raises :class:`ValueError` for a path that does not begin with ``/``, as the
    JavaScript, Go and Java clients do: an absolute URL such as
    ``https://example.net/x`` would replace the client's base host and carry the
    API key there.
    """
    if not path.startswith("/"):
        raise ValueError(f"OpenWA: path must begin with '/': {path!r}")
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
    # Merge rather than pass params= to httpx.Request, which replaces a query already in the path.
    return str(httpx.URL(url).copy_merge_params(params))


def resolve_timeout(
    timeout: float | httpx.Timeout | tuple[float | None, float | None, float | None, float | None] | None,
) -> float | httpx.Timeout | None:
    """The timeout httpx is given: seconds per network operation, or ``None`` for none.

    ``None``, ``0`` and ``math.inf`` mean no timeout, as ``0`` does in the JavaScript and PHP clients;
    httpx would otherwise take ``0`` literally and fail every connect. A ``(connect, read, write, pool)``
    tuple is the way to set the operations apart, and each of its elements means the same: ``0`` and
    ``math.inf`` leave that operation without a limit. An :class:`httpx.Timeout` goes to httpx as given,
    since it was accepted before this validator existed. Anything else that is not a non-negative number
    raises at construction rather than at the first request.
    """
    if timeout is None:
        return None
    if isinstance(timeout, httpx.Timeout):
        return timeout
    if isinstance(timeout, tuple):
        parts = [part for part in timeout]
        if len(parts) != 4 or any(
            part is not None
            and (isinstance(part, bool) or not isinstance(part, (int, float)) or math.isnan(part) or part < 0)
            for part in parts
        ):
            raise ValueError(
                "OpenWAClient: a timeout tuple is (connect, read, write, pool), each a non-negative number "
                f"of seconds or None (got {timeout!r})"
            )
        connect, read, write, pool = (
            None if part is None or part == 0 or math.isinf(part) else float(part) for part in parts
        )
        return httpx.Timeout(connect=connect, read=read, write=write, pool=pool)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or math.isnan(timeout) or timeout < 0:
        raise ValueError(
            f"OpenWAClient: timeout must be a non-negative number of seconds, or None for none (got {timeout!r})"
        )
    return None if timeout == 0 or math.isinf(timeout) else float(timeout)


_HEADER_NAME_CHARS = frozenset("!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")


def clean_default_headers(default_headers: Any) -> httpx.Headers:
    """The default headers as httpx will hold them, or a ``ValueError`` naming the header and never its value.

    Whatever httpx takes (a mapping, a list of ``(name, value)`` pairs, text or bytes) is read the same way.
    A value is trimmed of the spaces and tabs the HTTP stack would refuse at its ends, as the JDK and PSR-7
    do, and refused when a control or non-ASCII character is left. A credential for a proxy in front of the
    gateway is usually read from a file and keeps its newline; the stack's own error quotes the value, which
    would put the credential in the application's log.
    """
    if default_headers is None:
        return httpx.Headers()
    if isinstance(default_headers, httpx.Headers):
        # Its repeated names are lines of their own; `.items()` would join them into one.
        pairs: list[Any] = list(default_headers.multi_items())
    elif isinstance(default_headers, Mapping):
        pairs = list(default_headers.items())
    else:
        try:
            pairs = list(default_headers)
        except TypeError:
            raise ValueError(
                "OpenWAClient: default_headers must be a mapping of header names to text, or (name, value) pairs"
            ) from None
    cleaned: list[tuple[str, str]] = []
    for pair in pairs:
        try:
            name, value = pair
        except (TypeError, ValueError):
            raise ValueError("OpenWAClient: default_headers entries must be (name, value) pairs") from None
        if isinstance(name, bytes):
            name = name.decode("latin-1")
        if isinstance(value, bytes):
            value = value.decode("latin-1")
        if not isinstance(name, str) or not name or not all(char in _HEADER_NAME_CHARS for char in name):
            raise ValueError("OpenWAClient: default_headers has a header name that is not a valid HTTP token")
        if not isinstance(value, str) or any(char != "\t" and not " " <= char <= "~" for char in value):
            raise ValueError(
                f"OpenWAClient: default_headers value for {name!r} must be text without control or non-ASCII "
                "characters; check for a stray newline"
            )
        cleaned.append((name, value.strip(" \t")))
    return httpx.Headers(cleaned)


class HttpExecutor:
    """Owns the :class:`httpx.Client` and performs JSON requests.

    Constructed once per :class:`OpenWAClient`; the transport is taken from
    the client config so all requests share one connection pool.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float | httpx.Timeout | tuple[float | None, float | None, float | None, float | None] | None = 30.0,
        default_headers: Mapping[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        timeout = resolve_timeout(timeout)
        # Caller-supplied default headers are applied FIRST so the auth/JSON
        # headers below always win and can never be clobbered (mirrors the JS SDK).
        # httpx.Headers matches names case-insensitively, so a lowercase copy is
        # replaced instead of being sent alongside ours.
        headers = clean_default_headers(default_headers)
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
        # The seconds a timeout error reports: the one number given, or for an httpx.Timeout the longest
        # of its operations that has a limit.
        if isinstance(timeout, httpx.Timeout):
            limits = [part for part in (timeout.connect, timeout.read, timeout.write, timeout.pool) if part is not None]
            self._timeout: float | None = max(limits) if limits else None
        else:
            self._timeout = timeout

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HttpExecutor":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def request(
        self, method: HttpMethod, path: str, *, query: Mapping[str, Any] | None = None,
        body: Any = None, idempotency_key: str | None = None
    ) -> Any:
        """Perform one request and return the parsed JSON (or ``None`` for 204)."""
        res = self._send(method, path, query=query, body=body, idempotency_key=idempotency_key)
        if res.status_code == 204 or not res.content:
            return None
        try:
            return res.json()
        except ValueError:
            # A 2xx body that isn't JSON surfaces as text rather than a raw
            # JSONDecodeError (mirrors the JS and PHP transports).
            return res.text

    def request_bytes(
        self, method: HttpMethod, path: str, *, query: Mapping[str, Any] | None = None
    ) -> tuple[bytes, str | None]:
        """Perform one request for a non-JSON (binary) 2xx body — e.g. stored
        status media — and return ``(body bytes, content type)``. A 204 yields
        empty bytes and ``None``; any other empty 2xx body yields empty bytes
        and the served content type."""
        res = self._send(method, path, query=query, body=None)
        if res.status_code == 204:
            return b"", None
        return res.content, res.headers.get("content-type")

    def _send(
        self, method: HttpMethod, path: str, *, query: Mapping[str, Any] | None,
        body: Any, idempotency_key: str | None = None
    ) -> httpx.Response:
        """Shared transport for :meth:`request` and :meth:`request_bytes`: builds
        the URL, performs the request, and translates a non-2xx into a typed error."""
        headers = None
        if idempotency_key is not None:
            if (
                not isinstance(idempotency_key, str)
                or not 1 <= len(idempotency_key) <= 255
                or any(not "!" <= char <= "~" for char in idempotency_key)
            ):
                raise ValueError("Idempotency-Key must contain 1-255 visible ASCII characters")
            headers = {"Idempotency-Key": idempotency_key}
        url = build_url("", path, query)
        try:
            res = self._client.request(method, url, json=body if body is not None else None, headers=headers)
        except httpx.TimeoutException as e:
            raise OpenWATimeoutError(self._timeout or 0) from e
        # Treat any non-2xx as an error, including 3xx: redirects are deliberately not followed
        # (so the API key is never re-sent to the target), which makes an unfollowed 3xx unusable
        # rather than a success. A final 1xx from a custom transport is no more usable. Matches the JS
        # transport's `!res.ok`.
        if not 200 <= res.status_code < 300:
            context = f"{method} {path}"
            raise OpenWAApiError.from_response(
                res.status_code, res.text, context, headers=res.headers, reason=res.reason_phrase
            )
        return res

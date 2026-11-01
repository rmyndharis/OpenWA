"""OpenWA Python SDK — client core.

The :class:`OpenWAClient` is the single entry point. It owns an
:class:`HttpExecutor` (which wraps :class:`httpx.Client` with an injectable
transport) and exposes domain resources as properties::

    from openwa import OpenWAClient

    client = OpenWAClient(
        base_url="http://localhost:2785",
        api_key="owa_k1_…",
    )

    # Sessions are addressed by the UUID that create() returns, not by name.
    session = client.sessions.create({"name": "my-session"})
    client.sessions.start(session["id"])
    # Link the account before sending: scan sessions.get_qr_code (or use sessions.request_pairing_code for a number with no linked session),
    # then wait for status "ready". An unlinked session answers the send with 409.
    client.messages.send_text(session["id"], {
        "chatId": "628123456789@c.us",
        "text": "Hello from the OpenWA SDK!",
    })

Pass ``transport=httpx.MockTransport(handler)`` for testability — no global
monkey-patching required.
"""

from __future__ import annotations

import warnings
from types import TracebackType
from typing import Any, Mapping
from urllib.parse import urlparse

import httpx

from ._http import HttpExecutor, HttpMethod
from .resources import (
    CallsResource,
    MediaResource,
    CatalogResource,
    ChannelsResource,
    ChatsResource,
    ContactsResource,
    GroupsResource,
    HealthResource,
    LabelsResource,
    MessagesResource,
    ProfileResource,
    SearchResource,
    SessionsResource,
    StatusResource,
    TemplatesResource,
    WebhooksResource,
)
from .types import AuthValidateResponse


_LOCALHOST_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _warn_if_insecure_http(url: str) -> None:
    """Warn (not raise) when base_url is http:// and the host is not localhost.

    The API key is sent as an X-API-Key header on every request — over plaintext http
    to a non-local host that's cleartext on the wire. Warning (not refusing) keeps local
    dev and TLS-terminating-proxy topologies working.
    """
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").strip("[]")
        if parsed.scheme == "http" and host not in _LOCALHOST_HOSTS:
            warnings.warn(
                f"OpenWAClient: base_url uses an insecure http:// URL (host: {host}). "
                "The API key will be sent in cleartext. Use https:// in production.",
                stacklevel=3,
            )
    except Exception:
        pass


class OpenWAClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        # Seconds per network operation (connect, read, write, pool), not for the whole call: a response
        # that keeps trickling bytes is not cut off. 0 or None means no timeout.
        timeout: float | httpx.Timeout | tuple[float | None, float | None, float | None, float | None] | None = 30.0,
        default_headers: Mapping[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("OpenWAClient: base_url is required")
        # A key read from a secret file usually ends in a newline, which the HTTP layer refuses with an error
        # that quotes the whole key. Trim it, and refuse a control or non-ASCII character left inside: the
        # gateway takes any printable ASCII, a space included, and the other clients send it as it is.
        api_key = api_key.strip() if isinstance(api_key, str) else api_key
        if not api_key:
            raise ValueError("OpenWAClient: api_key is required")
        if not isinstance(api_key, str) or not all(" " <= char <= "~" for char in api_key):
            raise ValueError(
                "OpenWAClient: api_key contains a control or non-ASCII character; check for a stray newline"
            )
        _warn_if_insecure_http(base_url)
        self._http = HttpExecutor(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            default_headers=default_headers,
            transport=transport,
        )

    # ── Resources ────────────────────────────────────────────────────

    @property
    def sessions(self) -> SessionsResource:
        return SessionsResource(self._http)

    @property
    def messages(self) -> MessagesResource:
        return MessagesResource(self._http)

    @property
    def contacts(self) -> ContactsResource:
        return ContactsResource(self._http)

    @property
    def groups(self) -> GroupsResource:
        return GroupsResource(self._http)

    @property
    def webhooks(self) -> WebhooksResource:
        return WebhooksResource(self._http)

    @property
    def chats(self) -> ChatsResource:
        return ChatsResource(self._http)

    @property
    def status(self) -> StatusResource:
        return StatusResource(self._http)

    @property
    def health(self) -> HealthResource:
        return HealthResource(self._http)

    @property
    def labels(self) -> LabelsResource:
        return LabelsResource(self._http)

    @property
    def channels(self) -> ChannelsResource:
        return ChannelsResource(self._http)

    @property
    def catalog(self) -> CatalogResource:
        return CatalogResource(self._http)

    @property
    def templates(self) -> TemplatesResource:
        return TemplatesResource(self._http)

    @property
    def search(self) -> SearchResource:
        return SearchResource(self._http)

    @property
    def profile(self) -> ProfileResource:
        return ProfileResource(self._http)

    @property
    def calls(self) -> CallsResource:
        return CallsResource(self._http)

    @property
    def media(self) -> MediaResource:
        return MediaResource(self._http)

    # ── Auth ─────────────────────────────────────────────────────────

    def auth(self) -> AuthValidateResponse:
        return self._http.request("POST", "/api/auth/validate")

    # ── Raw request escape hatch ─────────────────────────────────────

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Issue a raw request against the API (advanced use). ``path`` begins with ``/``.

        ``idempotency_key`` is sent as ``Idempotency-Key``, which the gateway honors on its keyed send routes.
        """
        return self._http.request(method, path, query=query, body=body, idempotency_key=idempotency_key)

    # ── Lifecycle ────────────────────────────────────────────────────

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "OpenWAClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

"""OpenWA Python SDK — client core.

The :class:`OpenWAClient` is the single entry point. It owns an
:class:`HttpExecutor` (which wraps :class:`httpx.Client` with an injectable
transport) and exposes domain resources as properties::

    from openwa import OpenWAClient

    client = OpenWAClient(
        base_url="http://localhost:2785",
        api_key="owa_k1_…",
    )

    client.sessions.start("my-session")
    client.messages.send_text("my-session", {
        "chatId": "628123456789@c.us",
        "text": "Hello from the OpenWA SDK!",
    })

Pass ``transport=httpx.MockTransport(handler)`` for testability — no global
monkey-patching required.
"""

from __future__ import annotations

from types import TracebackType
from typing import Any, Mapping

import httpx

from ._http import HttpExecutor, HttpMethod
from .resources import (
    CatalogResource,
    ChannelsResource,
    ChatsResource,
    ContactsResource,
    GroupsResource,
    HealthResource,
    LabelsResource,
    MessagesResource,
    SessionsResource,
    StatusResource,
    TemplatesResource,
    WebhooksResource,
)
from .types import AuthValidateResponse


class OpenWAClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 30.0,
        default_headers: Mapping[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not base_url:
            raise ValueError("OpenWAClient: base_url is required")
        if not api_key:
            raise ValueError("OpenWAClient: api_key is required")
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
    ) -> Any:
        """Issue a raw request against the API (advanced use). ``path`` begins with ``/``."""
        return self._http.request(method, path, query=query, body=body)

    # ── Lifecycle ────────────────────────────────────────────────────

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "OpenWAClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

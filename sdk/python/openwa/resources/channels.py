"""Channels resource — WhatsApp Channels / Newsletters.

Backed by ``src/modules/channel/channel.controller.ts``
(``@Controller('sessions/:sessionId/channels')``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    ChannelMessageQuery,
    ChannelMessageRecord,
    ChannelRecord,
    SubscribeChannelRequest,
    SuccessResult,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class ChannelsResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str) -> list[ChannelRecord]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/channels")

    def get(self, session_id: str, channel_id: str) -> ChannelRecord:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/channels/{quote_segment(channel_id)}")

    def messages(
        self, session_id: str, channel_id: str, query: ChannelMessageQuery | None = None
    ) -> list[ChannelMessageRecord]:
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/channels/{quote_segment(channel_id)}/messages", query=query
        )

    def subscribe(self, session_id: str, body: SubscribeChannelRequest) -> ChannelRecord:
        """Subscribe to a channel using its invite code. Requires an OPERATOR-level key."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/channels/subscribe", body=body)

    def unsubscribe(self, session_id: str, channel_id: str) -> SuccessResult:
        """Unsubscribe from a channel. Requires an OPERATOR-level key."""
        return self._http.request("DELETE", f"/api/sessions/{quote_segment(session_id)}/channels/{quote_segment(channel_id)}")

"""Channels resource — WhatsApp Channels / Newsletters.

Backed by ``src/modules/channel/channel.controller.ts``
(``@Controller('sessions/:sessionId/channels')``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    CreateChannelRequest,
    MuteChannelRequest,
    ChannelMessageQuery,
    ChannelMessageRecord,
    ChannelRecord,
    SubscribeChannelRequest,
    SuccessResult,
    DemoteChannelAdminRequest,
    TransferChannelOwnershipRequest,
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

    def create(self, session_id: str, body: CreateChannelRequest) -> ChannelRecord:
        """Create a channel. The account owns it, which is what makes delete() possible later."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/channels", body=body)

    def delete(self, session_id: str, channel_id: str) -> SuccessResult:
        """Delete a channel this account owns. Irreversible; every subscriber loses it.

        Note the path: unsubscribe is the DELETE route, and the two are deliberately not reachable
        by the same request -- leaving a channel and destroying it are very different acts.
        """
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/channels/{quote_segment(channel_id)}/delete"
        )

    def mute(self, session_id: str, channel_id: str, body: MuteChannelRequest) -> SuccessResult:
        """Mute or unmute a channel's notifications. The subscription is untouched either way."""
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/channels/{quote_segment(channel_id)}/mute", body=body
        )

    def subscribe(self, session_id: str, body: SubscribeChannelRequest) -> ChannelRecord:
        """Subscribe to a channel using its invite code. Requires an OPERATOR-level key."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/channels/subscribe", body=body)

    def unsubscribe(self, session_id: str, channel_id: str) -> SuccessResult:
        """Unsubscribe from a channel. Requires an OPERATOR-level key."""
        return self._http.request("DELETE", f"/api/sessions/{quote_segment(session_id)}/channels/{quote_segment(channel_id)}")

    def demote_admin(self, session_id: str, channel_id: str, body: DemoteChannelAdminRequest) -> SuccessResult:
        """Demote a channel admin back to a subscriber. Requires an OPERATOR-level key.

        There is no promote counterpart: neither engine library has one, so an admin is promoted
        from the WhatsApp app and demoted here. The whatsapp-web.js engine answers 501.
        """
        return self._http.request(
            "POST",
            f"/api/sessions/{quote_segment(session_id)}/channels/{quote_segment(channel_id)}/admins/demote",
            body=body,
        )

    def transfer_ownership(
        self, session_id: str, channel_id: str, body: TransferChannelOwnershipRequest
    ) -> SuccessResult:
        """Hand a channel to a new owner. Requires an OPERATOR-level key.

        **Irreversible**: once the transfer lands this account stops being the owner and cannot take
        the channel back. The whatsapp-web.js engine answers 501.
        """
        return self._http.request(
            "POST",
            f"/api/sessions/{quote_segment(session_id)}/channels/{quote_segment(channel_id)}/owner/transfer",
            body=body,
        )

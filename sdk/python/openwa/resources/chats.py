"""Chats resource — chat-list operations (read/unread/delete/typing state).

These endpoints live under the session controller (``/api/sessions/:id/chats/*``)
but are surfaced here as a dedicated resource for clarity.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from .._http import quote_segment
from ..types import (
    ChatPresence,
    ArchiveChatRequest,
    ChatSummary,
    DeleteChatRequest,
    MarkChatRequest,
    SendChatStateRequest,
    SuccessResult,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class ListChatsQuery(TypedDict, total=False):
    limit: int
    offset: int


class ChatsResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str, query: ListChatsQuery | None = None) -> list[ChatSummary]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/chats", query=query)

    def subscribe_presence(self, session_id: str, body: MarkChatRequest) -> SuccessResult:
        """Subscribe to a chat's presence; updates arrive as presence.update events.

        Presence cannot be fetched from either engine, only received. The subscription belongs to
        the connection and does NOT survive a restart or an automatic reconnect, so re-issue it when
        the session comes back. Subscribe per chat: WhatsApp emits an update on every transition.
        whatsapp-web.js answers 501.
        """
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/presence/subscribe", body=body
        )

    def get_presence(self, session_id: str, chat_id: str) -> ChatPresence | None:
        """The last presence reported for a chat, or None when none has been.

        None means the chat was never subscribed, or nothing has changed since. Held in memory, so a
        restart clears it.
        """
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/presence/{quote_segment(chat_id)}"
        )

    def mark_read(self, session_id: str, body: MarkChatRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/read", body=body)

    def mark_unread(self, session_id: str, body: MarkChatRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/unread", body=body)

    def archive(self, session_id: str, body: ArchiveChatRequest) -> SuccessResult:
        """Archive or unarchive a chat. success=False means the engine declined."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/archive", body=body)

    def clear_messages(self, session_id: str, chat_id: str) -> SuccessResult:
        """Delete every message in a chat, keeping the chat. success=False means the engine declined."""
        return self._http.request(
            "DELETE", f"/api/sessions/{quote_segment(session_id)}/chats/{quote_segment(chat_id)}/messages"
        )

    def delete(self, session_id: str, body: DeleteChatRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/delete", body=body)

    def send_state(self, session_id: str, body: SendChatStateRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/typing", body=body)

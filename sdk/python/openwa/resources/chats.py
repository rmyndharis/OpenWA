"""Chats resource — chat-list operations (read/unread/delete/typing state).

These endpoints live under the session controller (``/api/sessions/:id/chats/*``)
but are surfaced here as a dedicated resource for clarity.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from .._http import quote_segment
from ..types import (
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

    def mark_read(self, session_id: str, body: MarkChatRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/read", body=body)

    def mark_unread(self, session_id: str, body: MarkChatRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/unread", body=body)

    def delete(self, session_id: str, body: DeleteChatRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/delete", body=body)

    def send_state(self, session_id: str, body: SendChatStateRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/chats/typing", body=body)

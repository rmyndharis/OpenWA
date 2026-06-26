"""Messages resource — sending and querying messages.

Backed by ``src/modules/message/message.controller.ts``.
NOTE: the real paths use the ``/send-`` prefix, e.g. ``/messages/send-text``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    BatchStatusResponse,
    BulkMessageResponse,
    ChatHistoryMessage,
    DeleteMessageRequest,
    ForwardMessageRequest,
    ListMessagesQuery,
    MessageHistoryQuery,
    MessageListResponse,
    MessageResponse,
    ReactionRecord,
    ReactMessageRequest,
    ReplyMessageRequest,
    SendBulkRequest,
    SendContactRequest,
    SendLocationRequest,
    SendMediaRequest,
    SendTemplateRequest,
    SendTextRequest,
    SuccessResult,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class MessagesResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str, query: ListMessagesQuery | None = None) -> MessageListResponse:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/messages", query=query)

    def send_text(self, session_id: str, body: SendTextRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-text", body=body)

    def send_image(self, session_id: str, body: SendMediaRequest) -> MessageResponse:
        return self._send_media(session_id, "send-image", body)

    def send_video(self, session_id: str, body: SendMediaRequest) -> MessageResponse:
        return self._send_media(session_id, "send-video", body)

    def send_audio(self, session_id: str, body: SendMediaRequest) -> MessageResponse:
        return self._send_media(session_id, "send-audio", body)

    def send_document(self, session_id: str, body: SendMediaRequest) -> MessageResponse:
        return self._send_media(session_id, "send-document", body)

    def send_sticker(self, session_id: str, body: SendMediaRequest) -> MessageResponse:
        return self._send_media(session_id, "send-sticker", body)

    def _send_media(self, session_id: str, segment: str, body: SendMediaRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/{quote_segment(segment)}", body=body)

    def send_location(self, session_id: str, body: SendLocationRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-location", body=body)

    def send_contact(self, session_id: str, body: SendContactRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-contact", body=body)

    def send_template(self, session_id: str, body: SendTemplateRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-template", body=body)

    def reply(self, session_id: str, body: ReplyMessageRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/reply", body=body)

    def forward(self, session_id: str, body: ForwardMessageRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/forward", body=body)

    def react(self, session_id: str, body: ReactMessageRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/react", body=body)

    def delete(self, session_id: str, body: DeleteMessageRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/delete", body=body)

    def history(
        self, session_id: str, chat_id: str, query: MessageHistoryQuery | None = None
    ) -> list[ChatHistoryMessage]:
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/messages/{quote_segment(chat_id)}/history", query=query
        )

    def reactions(self, session_id: str, chat_id: str, message_id: str) -> list[ReactionRecord]:
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/messages/{quote_segment(chat_id)}/{quote_segment(message_id)}/reactions"
        )

    def send_bulk(self, session_id: str, body: SendBulkRequest) -> BulkMessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-bulk", body=body)

    def batch_status(self, session_id: str, batch_id: str) -> BatchStatusResponse:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/messages/batch/{quote_segment(batch_id)}")

    def cancel_batch(self, session_id: str, batch_id: str) -> BatchStatusResponse:
        """Cancel a running batch. Requires an OPERATOR-level key."""
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/messages/batch/{quote_segment(batch_id)}/cancel"
        )

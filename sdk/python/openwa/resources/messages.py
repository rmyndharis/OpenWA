"""Messages resource — sending and querying messages.

Backed by ``src/modules/message/message.controller.ts``.
NOTE: the real paths use the ``/send-`` prefix, e.g. ``/messages/send-text``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    MessageMedia,
    PinMessageRequest,
    StarMessageRequest,
    VotePollRequest,
    UnpinMessageRequest,
    BatchStatusResponse,
    BulkMessageResponse,
    ChatHistoryMessage,
    DeleteMessageRequest,
    EditMessageRequest,
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
    SendAudioRequest,
    SendMediaRequest,
    SendPollRequest,
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

    def send_audio(self, session_id: str, body: SendAudioRequest) -> MessageResponse:
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

    def send_poll(self, session_id: str, body: SendPollRequest) -> MessageResponse:
        """Send a native WhatsApp poll (2–12 options)."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-poll", body=body)

    def reply(self, session_id: str, body: ReplyMessageRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/reply", body=body)

    def forward(self, session_id: str, body: ForwardMessageRequest) -> MessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/forward", body=body)

    def react(self, session_id: str, body: ReactMessageRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/react", body=body)

    def delete(self, session_id: str, body: DeleteMessageRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/delete", body=body)

    def edit_message(self, session_id: str, body: EditMessageRequest) -> MessageResponse:
        """Edit the text of a message sent by this account. 404 when the message is not found."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/edit", body=body)

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

    def pin(self, session_id: str, body: PinMessageRequest) -> SuccessResult:
        """Pin a message. ``durationSeconds`` must be 86400, 604800 or 2592000; defaults to 24h."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/pin", body=body)

    def vote_poll(self, session_id: str, body: VotePollRequest) -> SuccessResult:
        """Cast a vote on a poll. Not supported on the Baileys engine (501)."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/vote-poll", body=body)

    def star(self, session_id: str, body: StarMessageRequest) -> SuccessResult:
        """Star or unstar a message. Best-effort on whatsapp-web.js."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/star", body=body)

    def unpin(self, session_id: str, body: UnpinMessageRequest) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/unpin", body=body)

    def media(self, session_id: str, chat_id: str, message_id: str) -> MessageMedia:
        """Fetch a message's archived media bytes (404 when nothing is archived for it)."""
        data, content_type = self._http.request_bytes(
            "GET",
            f"/api/sessions/{quote_segment(session_id)}/messages/{quote_segment(chat_id)}/{quote_segment(message_id)}/media",
        )
        return {"data": data, "contentType": content_type}

    def send_bulk(self, session_id: str, body: SendBulkRequest) -> BulkMessageResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-bulk", body=body)

    def batch_status(self, session_id: str, batch_id: str) -> BatchStatusResponse:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/messages/batch/{quote_segment(batch_id)}")

    def cancel_batch(self, session_id: str, batch_id: str) -> BatchStatusResponse:
        """Cancel a running batch. Requires an OPERATOR-level key."""
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/messages/batch/{quote_segment(batch_id)}/cancel"
        )

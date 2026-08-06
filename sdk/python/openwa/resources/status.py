"""Status (Stories) resource — WhatsApp status updates.

Backed by ``src/modules/status/status.controller.ts``.
NOTE: this is WhatsApp "Status/Stories", distinct from session lifecycle status.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    SendImageStatusRequest,
    SendTextStatusRequest,
    SendVideoStatusRequest,
    SendVoiceStatusRequest,
    StatusMedia,
    StatusRecord,
    StatusResult,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class StatusResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str) -> dict[str, list[StatusRecord]]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/status")

    def from_contact(self, session_id: str, contact_id: str) -> dict[str, list[StatusRecord]]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/status/{quote_segment(contact_id)}")

    def media(self, session_id: str, status_id: str) -> StatusMedia:
        """Fetch the stored media bytes for a status update (404 when there is no stored media)."""
        data, content_type = self._http.request_bytes(
            "GET", f"/api/sessions/{quote_segment(session_id)}/status/{quote_segment(status_id)}/media"
        )
        return {"data": data, "contentType": content_type}

    def send_text(self, session_id: str, body: SendTextStatusRequest) -> StatusResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/status/send-text", body=body)

    def send_image(self, session_id: str, body: SendImageStatusRequest) -> StatusResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/status/send-image", body=body)

    def send_video(self, session_id: str, body: SendVideoStatusRequest) -> StatusResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/status/send-video", body=body)

    def send_voice(self, session_id: str, body: SendVoiceStatusRequest) -> StatusResult:
        """Post an audio status as a voice note (OPERATOR).

        WhatsApp plays a status voice note only as Ogg/Opus and neither engine transcodes, so
        convert first with ``media.convert_voice`` and post the base64 it returns.
        """
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/status/send-voice", body=body)

    def delete(self, session_id: str, status_id: str) -> None:
        self._http.request("DELETE", f"/api/sessions/{quote_segment(session_id)}/status/{quote_segment(status_id)}")

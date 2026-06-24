"""Labels resource — WhatsApp Business chat labels.

Backed by ``src/modules/label/label.controller.ts``
(``@Controller('sessions/:sessionId/labels')``). Labels are a WhatsApp Business
feature; the session must be a business account.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import AddLabelRequest, LabelRecord, SuccessResult

if TYPE_CHECKING:
    from .._http import HttpExecutor


class LabelsResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str) -> list[LabelRecord]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/labels")

    def get(self, session_id: str, label_id: str) -> LabelRecord:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/labels/{quote_segment(label_id)}")

    def for_chat(self, session_id: str, chat_id: str) -> list[LabelRecord]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/labels/chat/{quote_segment(chat_id)}")

    def add_to_chat(self, session_id: str, chat_id: str, body: AddLabelRequest) -> SuccessResult:
        """Add a label to a chat. Requires an OPERATOR-level key."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/labels/chat/{quote_segment(chat_id)}", body=body)

    def remove_from_chat(self, session_id: str, chat_id: str, label_id: str) -> SuccessResult:
        """Remove a label from a chat. Requires an OPERATOR-level key."""
        return self._http.request(
            "DELETE", f"/api/sessions/{quote_segment(session_id)}/labels/chat/{quote_segment(chat_id)}/{quote_segment(label_id)}"
        )

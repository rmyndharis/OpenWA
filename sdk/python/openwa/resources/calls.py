"""Calls resource — incoming-call handling.

Backed by ``src/modules/call/call.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import CallLinkResponse, CreateCallLinkRequest, SuccessResult

if TYPE_CHECKING:
    from .._http import HttpExecutor


class CallsResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def reject_call(self, session_id: str, call_id: str) -> SuccessResult:
        """Reject a ringing incoming call (the id comes from the ``call.received`` event).

        Requires an OPERATOR-level key. 404 when the call is not found or no longer ringing.
        """
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/calls/{quote_segment(call_id)}/reject"
        )

    def create_link(self, session_id: str, body: CreateCallLinkRequest) -> CallLinkResponse:
        """Create a shareable WhatsApp call link.

        Both fields are required. ``startTime`` is absolute epoch MILLISECONDS — a link for right
        now is the current timestamp rather than an omitted field, because whatsapp-web.js generates
        an event-linked call and has no notion of "no start time". A WhatsApp-side failure answers
        403 rather than a success carrying an empty link.
        """
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/calls/link", body=body)

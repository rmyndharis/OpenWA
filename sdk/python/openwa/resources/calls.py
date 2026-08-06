"""Calls resource — incoming-call handling.

Backed by ``src/modules/call/call.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import SuccessResult

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

"""Sessions resource — lifecycle management for WhatsApp sessions.

Backed by ``src/modules/session/session.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    CreateSessionRequest,
    PairingCodeResponse,
    QrCodeResponse,
    RequestPairingCodeRequest,
    SessionResponse,
    SessionStatsOverview,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class SessionsResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self) -> list[SessionResponse]:
        return self._http.request("GET", "/api/sessions")

    def get(self, session_id: str) -> SessionResponse:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}")

    def create(self, body: CreateSessionRequest) -> SessionResponse:
        return self._http.request("POST", "/api/sessions", body=body)

    def delete(self, session_id: str) -> None:
        self._http.request("DELETE", f"/api/sessions/{quote_segment(session_id)}")

    def start(self, session_id: str) -> SessionResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/start")

    def stop(self, session_id: str) -> SessionResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/stop")

    def force_kill(self, session_id: str) -> SessionResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/force-kill")

    def get_qr_code(self, session_id: str) -> QrCodeResponse:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/qr")

    def request_pairing_code(self, session_id: str, body: RequestPairingCodeRequest) -> PairingCodeResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/pairing-code", body=body)

    def stats(self) -> SessionStatsOverview:
        return self._http.request("GET", "/api/sessions/stats/overview")

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
        """List sessions."""
        return self._http.request("GET", "/api/sessions")

    def get(self, session_id: str) -> SessionResponse:
        """Return a single session."""
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}")

    def create(self, body: CreateSessionRequest) -> SessionResponse:
        """Provision a new session."""
        return self._http.request("POST", "/api/sessions", body=body)

    def delete(self, session_id: str) -> None:
        """Remove a session."""
        self._http.request("DELETE", f"/api/sessions/{quote_segment(session_id)}")

    def start(self, session_id: str) -> SessionResponse:
        """Connect a session (triggers QR / pairing)."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/start")

    def stop(self, session_id: str) -> SessionResponse:
        """Disconnect a session gracefully."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/stop")

    def logout(self, session_id: str) -> SessionResponse:
        """Attempt an engine-native unlink of this device, then tear the session down.

        A 200 means the engine-native unlink operation AND the required local
        credential cleanup completed -- it is not an independent observation
        that the handset UI no longer shows the linked device. Because a
        completed unlink wipes the stored credentials, a later start() requires
        a fresh QR scan or pairing code. Requires a running session.

        Raises on HTTP 502 with ``code: 'SESSION_LOGOUT_INCOMPLETE'`` when the
        session was stopped locally but the logout operation did not complete
        (no send, no acknowledgement, timeout/transport error, or local
        cleanup failure); ``phone`` is cleared and no success audit is written.
        Start the session again and retry the logout. Do not assume the retry
        reconnects automatically or lands in a guaranteed QR state.
        """
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/logout")

    def force_kill(self, session_id: str) -> SessionResponse:
        """Terminate a stuck session immediately."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/force-kill")

    def get_qr_code(self, session_id: str) -> QrCodeResponse:
        """Return the current QR code for a session awaiting scan."""
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/qr")

    def request_pairing_code(self, session_id: str, body: RequestPairingCodeRequest) -> PairingCodeResponse:
        """Request a phone-pairing code."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/pairing-code", body=body)

    def stats(self) -> SessionStatsOverview:
        """Return the aggregate session stats overview."""
        return self._http.request("GET", "/api/sessions/stats/overview")

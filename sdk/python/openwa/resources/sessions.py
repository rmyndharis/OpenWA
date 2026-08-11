"""Sessions resource — lifecycle management for WhatsApp sessions.

Backed by ``src/modules/session/session.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from .._http import quote_segment
from ..types import (
    CreateSessionRequest,
    SessionConfig,
    UpdateSessionConfigRequest,
    PairingCodeResponse,
    QrCodeResponse,
    RequestPairingCodeRequest,
    SessionResponse,
    SessionStatsOverview,
    SetOwnPresenceRequest,
    SuccessResult,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class ListSessionsQuery(TypedDict, total=False):
    """Pagination for :meth:`SessionsResource.list`. The server applies its own default when omitted."""

    limit: int
    offset: int


class SessionsResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, query: ListSessionsQuery | None = None) -> list[SessionResponse]:
        """List sessions."""
        return self._http.request("GET", "/api/sessions", query=query)

    def get_config(self, session_id: str) -> SessionConfig:
        """Read a session's effective configuration."""
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/config")

    def update_config(self, session_id: str, body: UpdateSessionConfigRequest) -> SessionConfig:
        """Update a RUNNING session's configuration -- no re-link and no QR scan.

        All three fields were fixed at creation before this route existed.
        """
        return self._http.request(
            "PATCH", f"/api/sessions/{quote_segment(session_id)}/config", body=body
        )

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

    def set_online_presence(self, session_id: str, body: SetOwnPresenceRequest) -> SuccessResult:
        """Set the account's own global presence — appear online, or offline.

        ``available: False`` hands notifications back to the phone: a linked device that stays
        online suppresses the phone's own alerts. This is the ACCOUNT's presence, not a chat's —
        see the chats resource for per-chat typing/recording states.
        """
        return self._http.request(
            "PUT", f"/api/sessions/{quote_segment(session_id)}/presence", body=body
        )

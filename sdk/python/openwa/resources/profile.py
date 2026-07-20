"""Profile resource — the session account's own profile (name, status, picture).

Backed by ``src/modules/profile/profile.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    SetProfileNameRequest,
    SetProfilePictureRequest,
    SetProfileStatusRequest,
    SuccessResult,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class ProfileResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def set_profile_name(self, session_id: str, body: SetProfileNameRequest) -> SuccessResult:
        """Set the account display name. Requires an OPERATOR-level key."""
        return self._http.request("PUT", f"/api/sessions/{quote_segment(session_id)}/profile/name", body=body)

    def set_profile_status(self, session_id: str, body: SetProfileStatusRequest) -> SuccessResult:
        """Set the account about/status text (empty clears). Requires an OPERATOR-level key."""
        return self._http.request("PUT", f"/api/sessions/{quote_segment(session_id)}/profile/status", body=body)

    def set_profile_picture(self, session_id: str, body: SetProfilePictureRequest) -> SuccessResult:
        """Set the account profile picture — ``url`` OR ``base64`` (+ ``mimetype``).

        Requires an OPERATOR-level key.
        """
        return self._http.request("PUT", f"/api/sessions/{quote_segment(session_id)}/profile/picture", body=body)

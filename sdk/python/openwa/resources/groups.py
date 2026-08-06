"""Groups resource — WhatsApp group management.

Backed by ``src/modules/group/group.controller.ts``.
"""

from __future__ import annotations

from typing import Any, TYPE_CHECKING, TypedDict

from .._http import quote_segment
from ..types import (
    GroupJoinInfo,
    SetGroupPictureRequest,
    CreateGroupRequest,
    GroupInfo,
    GroupSettings,
    GroupSummary,
    InviteCodeResponse,
    JoinGroupRequest,
    JoinGroupResponse,
    SuccessResult,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class ListGroupsQuery(TypedDict, total=False):
    limit: int
    offset: int


class GroupsResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str, query: ListGroupsQuery | None = None) -> list[GroupSummary]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/groups", query=query)

    def get(self, session_id: str, group_id: str) -> GroupInfo:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}")

    def create(self, session_id: str, body: CreateGroupRequest) -> GroupInfo:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/groups", body=body)

    def add_participants(self, session_id: str, group_id: str, participants: list[str]) -> SuccessResult:
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/participants",
            body={"participants": participants},
        )

    def remove_participants(self, session_id: str, group_id: str, participants: list[str]) -> SuccessResult:
        return self._http.request(
            "DELETE", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/participants",
            body={"participants": participants},
        )

    def promote_participants(self, session_id: str, group_id: str, participants: list[str]) -> SuccessResult:
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/participants/promote",
            body={"participants": participants},
        )

    def demote_participants(self, session_id: str, group_id: str, participants: list[str]) -> SuccessResult:
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/participants/demote",
            body={"participants": participants},
        )

    def set_subject(self, session_id: str, group_id: str, subject: str) -> SuccessResult:
        return self._http.request(
            "PUT", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/subject", body={"subject": subject}
        )

    def set_description(self, session_id: str, group_id: str, description: str) -> SuccessResult:
        return self._http.request(
            "PUT", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/description",
            body={"description": description},
        )

    def leave(self, session_id: str, group_id: str) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/leave")

    def get_picture(self, session_id: str, group_id: str) -> dict[str, Any]:
        """Get the group's picture URL (None when it has none)."""
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/picture"
        )

    def set_picture(self, session_id: str, group_id: str, body: SetGroupPictureRequest) -> SuccessResult:
        """Set the group's picture. Requires admin rights on the group."""
        return self._http.request(
            "PUT", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/picture", body=body
        )

    def delete_picture(self, session_id: str, group_id: str) -> SuccessResult:
        """Remove the group's picture. Requires admin rights on the group."""
        return self._http.request(
            "DELETE", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/picture"
        )

    def invite_code(self, session_id: str, group_id: str) -> InviteCodeResponse:
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/invite-code"
        )

    def revoke_invite_code(self, session_id: str, group_id: str) -> InviteCodeResponse:
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/invite-code/revoke"
        )

    def join_info(self, session_id: str, code: str) -> GroupJoinInfo:
        """Preview a group from its invite code, WITHOUT joining.

        Read-only, so it is safe to call on a code from an untrusted source. There is no participant
        list -- the account is not a member -- only a count, and only when WhatsApp discloses one.
        """
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/groups/join-info", query={"code": code}
        )

    def join_group(self, session_id: str, body: JoinGroupRequest) -> JoinGroupResponse:
        """Join a group via an invite code. Requires an OPERATOR-level key."""
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/groups/join", body=body)

    def get_group_settings(self, session_id: str, group_id: str) -> GroupSettings:
        """Read the group's announce/locked/ephemeral settings."""
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/settings"
        )

    def update_group_settings(self, session_id: str, group_id: str, body: GroupSettings) -> SuccessResult:
        """Update group settings — at least one of announce/locked/ephemeralSeconds is required.

        Requires an OPERATOR-level key. ``ephemeralSeconds`` is unsupported on the
        whatsapp-web.js engine (the request then fails with 501).
        """
        return self._http.request(
            "PUT", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/settings", body=body
        )

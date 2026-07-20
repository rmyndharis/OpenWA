"""Groups resource — WhatsApp group management.

Backed by ``src/modules/group/group.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from .._http import quote_segment
from ..types import (
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

    def invite_code(self, session_id: str, group_id: str) -> InviteCodeResponse:
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/invite-code"
        )

    def revoke_invite_code(self, session_id: str, group_id: str) -> InviteCodeResponse:
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/groups/{quote_segment(group_id)}/invite-code/revoke"
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

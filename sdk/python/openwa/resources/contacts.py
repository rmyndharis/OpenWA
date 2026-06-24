"""Contacts resource — contact lookup and management.

Backed by ``src/modules/contact/contact.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from .._http import quote_segment
from ..types import (
    CheckNumberResponse,
    ContactPhoneResponse,
    ContactRecord,
    ProfilePictureResponse,
    SuccessResult,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class ListContactsQuery(TypedDict, total=False):
    limit: int
    offset: int


class ContactsResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str, query: ListContactsQuery | None = None) -> list[ContactRecord]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/contacts", query=query)

    def get(self, session_id: str, contact_id: str) -> ContactRecord:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/contacts/{quote_segment(contact_id)}")

    def check(self, session_id: str, number: str) -> CheckNumberResponse:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/contacts/check/{quote_segment(number)}")

    def profile_picture(self, session_id: str, contact_id: str) -> ProfilePictureResponse:
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/contacts/{quote_segment(contact_id)}/profile-picture"
        )

    def phone(self, session_id: str, contact_id: str) -> ContactPhoneResponse:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/contacts/{quote_segment(contact_id)}/phone")

    def block(self, session_id: str, contact_id: str) -> SuccessResult:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/contacts/{quote_segment(contact_id)}/block")

    def unblock(self, session_id: str, contact_id: str) -> SuccessResult:
        return self._http.request("DELETE", f"/api/sessions/{quote_segment(session_id)}/contacts/{quote_segment(contact_id)}/block")

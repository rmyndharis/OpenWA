"""Templates resource — stored message templates with ``{{variable}}`` placeholders.

Backed by ``src/modules/template/template.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import CreateTemplateRequest, TemplateRecord, UpdateTemplateRequest

if TYPE_CHECKING:
    from .._http import HttpExecutor


class TemplatesResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str) -> list[TemplateRecord]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/templates")

    def get(self, session_id: str, template_id: str) -> TemplateRecord:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/templates/{quote_segment(template_id)}")

    def create(self, session_id: str, body: CreateTemplateRequest) -> TemplateRecord:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/templates", body=body)

    def update(self, session_id: str, template_id: str, body: UpdateTemplateRequest) -> TemplateRecord:
        return self._http.request("PUT", f"/api/sessions/{quote_segment(session_id)}/templates/{quote_segment(template_id)}", body=body)

    def delete(self, session_id: str, template_id: str) -> None:
        self._http.request("DELETE", f"/api/sessions/{quote_segment(session_id)}/templates/{quote_segment(template_id)}")

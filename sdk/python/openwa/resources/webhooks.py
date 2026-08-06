"""Webhooks resource — configure event delivery to external HTTP endpoints.

Backed by ``src/modules/webhook/webhook.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import CreateWebhookRequest, UpdateWebhookRequest, WebhookResponse, WebhookTestResult

if TYPE_CHECKING:
    from .._http import HttpExecutor


class WebhooksResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def list(self, session_id: str) -> list[WebhookResponse]:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/webhooks")

    def get(self, session_id: str, webhook_id: str) -> WebhookResponse:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/webhooks/{quote_segment(webhook_id)}")

    def create(self, session_id: str, body: CreateWebhookRequest) -> WebhookResponse:
        return self._http.request("POST", f"/api/sessions/{quote_segment(session_id)}/webhooks", body=body)

    def update(self, session_id: str, webhook_id: str, body: UpdateWebhookRequest) -> WebhookResponse:
        return self._http.request(
            "PUT", f"/api/sessions/{quote_segment(session_id)}/webhooks/{quote_segment(webhook_id)}", body=body
        )

    def delete(self, session_id: str, webhook_id: str) -> None:
        self._http.request("DELETE", f"/api/sessions/{quote_segment(session_id)}/webhooks/{quote_segment(webhook_id)}")

    def test(self, session_id: str, webhook_id: str) -> WebhookTestResult:
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/webhooks/{quote_segment(webhook_id)}/test"
        )

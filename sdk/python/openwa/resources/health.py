"""Health resource — connectivity and readiness probes.

Backed by ``src/modules/health/health.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..types import HealthReadyResponse, HealthResponse

if TYPE_CHECKING:
    from .._http import HttpExecutor


class HealthResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def check(self) -> HealthResponse:
        return self._http.request("GET", "/api/health")

    def live(self) -> dict[str, str]:
        return self._http.request("GET", "/api/health/live")

    def ready(self) -> HealthReadyResponse:
        return self._http.request("GET", "/api/health/ready")

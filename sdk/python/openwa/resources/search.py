"""Search resource — full-text message search across sessions.

Backed by ``src/modules/search/search.controller.ts`` (``GET /search``).
The active search provider (built-in DB full-text or a plugin) answers; if none
is configured the server returns 501.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..types import SearchQueryParams, SearchResults

if TYPE_CHECKING:
    from .._http import HttpExecutor


class SearchResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def search(self, params: SearchQueryParams) -> SearchResults:
        """Search messages across sessions. ``q`` is required; all other fields optional."""
        return self._http.request("GET", "/api/search", query=params)

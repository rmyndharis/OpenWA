"""Catalog resource — WhatsApp Business catalog, products, and product/catalog sends.

Backed by ``src/modules/catalog/catalog.controller.ts``
(``@Controller('sessions/:sessionId')``). NOTE: the catalog controller is
mounted under the session root, so catalog reads are ``/catalog...`` while
product/catalog SENDS share the messages namespace
(``/messages/send-product``, ``/messages/send-catalog``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    CatalogInfo,
    CatalogProduct,
    CatalogProductsQuery,
    MessageResponse,
    PaginatedProducts,
    SendCatalogRequest,
    SendProductRequest,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class CatalogResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def info(self, session_id: str) -> CatalogInfo:
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/catalog")

    def products(
        self, session_id: str, query: CatalogProductsQuery | None = None
    ) -> PaginatedProducts:
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/catalog/products", query=query
        )

    def product(self, session_id: str, product_id: str) -> CatalogProduct:
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/catalog/products/{quote_segment(product_id)}"
        )

    def send_product(self, session_id: str, body: SendProductRequest) -> MessageResponse:
        """Send a product message. Requires an OPERATOR-level key. Shares the messages path."""
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-product", body=body
        )

    def send_catalog(self, session_id: str, body: SendCatalogRequest) -> MessageResponse:
        """Send a catalog link message. Requires an OPERATOR-level key. Shares the messages path."""
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-catalog", body=body
        )

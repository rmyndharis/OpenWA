"""Catalog resource — WhatsApp Business catalog, products, and product sends.

Backed by ``src/modules/catalog/catalog.controller.ts``
(``@Controller('sessions/:sessionId')``). NOTE: the catalog controller is
mounted under the session root, so catalog reads are ``/catalog...`` while
product sends share the messages namespace
(``/messages/send-product``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .._http import quote_segment
from ..types import (
    CatalogInfo,
    CatalogProduct,
    CatalogProductsQuery,
    PaginatedProducts,
    ProductMessageResponse,
    SendProductRequest,
)

if TYPE_CHECKING:
    from .._http import HttpExecutor


class CatalogResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def info(self, session_id: str) -> CatalogInfo | None:
        """Get catalog info, or None when the account has no catalog. Baileys only; whatsapp-web.js answers 501."""
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/catalog")

    def products(
        self, session_id: str, query: CatalogProductsQuery | None = None
    ) -> PaginatedProducts:
        """List catalog products, one page. Baileys only; whatsapp-web.js answers 501."""
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/catalog/products", query=query
        )

    def product(self, session_id: str, product_id: str) -> CatalogProduct | None:
        """Get one product, or None when no product has that id. Baileys only; whatsapp-web.js answers 501."""
        return self._http.request(
            "GET", f"/api/sessions/{quote_segment(session_id)}/catalog/products/{quote_segment(product_id)}"
        )

    def send_product(self, session_id: str, body: SendProductRequest) -> ProductMessageResponse:
        """Send a product message. Requires an OPERATOR-level key. Shares the messages path.

        Baileys only; whatsapp-web.js answers 501.
        """
        return self._http.request(
            "POST", f"/api/sessions/{quote_segment(session_id)}/messages/send-product", body=body
        )

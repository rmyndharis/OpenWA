/**
 * Catalog resource — WhatsApp Business catalog, products, and product sends.
 *
 * Backed by `src/modules/catalog/catalog.controller.ts` (`@Controller('sessions/:sessionId')`).
 * NOTE: the catalog controller is mounted under the session root, so catalog
 * reads are `/catalog...` while product sends share the messages
 * namespace (`/messages/send-product`). All require
 * an OPERATOR-level key for write operations.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
  CatalogInfo,
  CatalogProduct,
  CatalogProductsQuery,
  PaginatedProducts,
  ProductMessageResponse,
  SendProductRequest,
} from '../types.js';

export class CatalogResource {
  constructor(private readonly client: OpenWAClient) {}

  /**
   * Get the business catalog info, or `null` when the account has no catalog.
   * **Baileys only**: whatsapp-web.js answers 501.
   */
  info(sessionId: string): Promise<CatalogInfo | null> {
    return this.client.request<CatalogInfo | null>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/catalog`,
    });
  }

  /**
   * List catalog products. Returns a `{ products, pagination }` page.
   * **Baileys only**: whatsapp-web.js answers 501.
   */
  products(sessionId: string, query?: CatalogProductsQuery): Promise<PaginatedProducts> {
    return this.client.request<PaginatedProducts>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/catalog/products`,
      query,
    });
  }

  /**
   * Get a single product by id, or `null` when no product in the catalog carries that id.
   * **Baileys only**: whatsapp-web.js answers 501.
   */
  product(sessionId: string, productId: string): Promise<CatalogProduct | null> {
    return this.client.request<CatalogProduct | null>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/catalog/products/${encodeSegment(productId)}`,
    });
  }

  /**
   * Send a product message. Requires an OPERATOR-level key. Shares the messages path.
   * **Baileys only**: whatsapp-web.js answers 501.
   */
  sendProduct(sessionId: string, body: SendProductRequest): Promise<ProductMessageResponse> {
    return this.client.request<ProductMessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-product`,
      body,
    });
  }
}

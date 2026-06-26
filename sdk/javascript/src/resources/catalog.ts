/**
 * Catalog resource — WhatsApp Business catalog, products, and product/catalog sends.
 *
 * Backed by `src/modules/catalog/catalog.controller.ts` (`@Controller('sessions/:sessionId')`).
 * NOTE: the catalog controller is mounted under the session root, so catalog
 * reads are `/catalog...` while product/catalog SENDS share the messages
 * namespace (`/messages/send-product`, `/messages/send-catalog`). All require
 * an OPERATOR-level key for write operations.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
  CatalogInfo,
  CatalogProduct,
  CatalogProductsQuery,
  MessageResponse,
  PaginatedProducts,
  SendCatalogRequest,
  SendProductRequest,
} from '../types.js';

export class CatalogResource {
  constructor(private readonly client: OpenWAClient) {}

  /** Get the business catalog info. */
  info(sessionId: string): Promise<CatalogInfo> {
    return this.client.request<CatalogInfo>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/catalog`,
    });
  }

  /** List catalog products. Returns a `{ products, pagination }` page. */
  products(sessionId: string, query?: CatalogProductsQuery): Promise<PaginatedProducts> {
    return this.client.request<PaginatedProducts>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/catalog/products`,
      query,
    });
  }

  /** Get a single product by id. */
  product(sessionId: string, productId: string): Promise<CatalogProduct> {
    return this.client.request<CatalogProduct>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/catalog/products/${encodeSegment(productId)}`,
    });
  }

  /** Send a product message. Requires an OPERATOR-level key. Shares the messages path. */
  sendProduct(sessionId: string, body: SendProductRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-product`,
      body,
    });
  }

  /** Send a catalog link message. Requires an OPERATOR-level key. Shares the messages path. */
  sendCatalog(sessionId: string, body: SendCatalogRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-catalog`,
      body,
    });
  }
}

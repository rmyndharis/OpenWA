import {
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
  MessageResult,
} from '../../interfaces/whatsapp-engine.interface';
import { AdapterContext } from './context';

/**
 * Catalog concern (WhatsApp Business). whatsapp-web.js has no native Catalog
 * API, so these remain stubs (warn or throw) exactly as in the monolithic
 * adapter. requireClient() preserves the original READY gate.
 */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
export class CatalogAdapter {
  constructor(private readonly ctx: AdapterContext) {}

  async getCatalog(): Promise<Catalog | null> {
    this.ctx.requireClient();
    // whatsapp-web.js doesn't have native Catalog API support
    this.ctx.logger.warn('getCatalog not implemented in whatsapp-web.js adapter');
    return null;
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.ctx.requireClient();
    this.ctx.logger.warn('getProducts not implemented in whatsapp-web.js adapter');
    return {
      products: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    };
  }

  async getProduct(_productId: string): Promise<Product | null> {
    this.ctx.requireClient();
    this.ctx.logger.warn('getProduct not implemented in whatsapp-web.js adapter');
    return null;
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    this.ctx.requireClient();
    throw new Error('sendProduct not yet implemented in whatsapp-web.js adapter');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    this.ctx.requireClient();
    throw new Error('sendCatalog not yet implemented in whatsapp-web.js adapter');
  }
}
/* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

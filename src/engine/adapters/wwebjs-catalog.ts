import {
  Catalog,
  MessageResult,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Catalog operations extracted from WhatsAppWebJsAdapter: whatsapp-web.js has no Catalog API at all
 * (no Client.getCatalog/getProducts/getProduct symbol in index.d.ts), so these are honest 501s.
 * The adapter keeps the public methods as thin forwarders and injects the shared host surface
 * (./wwebjs-host) via closures, so the delegate never touches lifecycle state directly.
 */
export class WwebjsCatalog {
  constructor(private readonly host: WwebjsEngineHost) {}

  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  async getCatalog(): Promise<Catalog | null> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('getCatalog');
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('getProducts');
  }

  async getProduct(_productId: string): Promise<Product | null> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('getProduct');
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('sendProduct');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('sendCatalog');
  }
  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
}

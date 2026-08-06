import { Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type {
  Catalog,
  Product,
  PaginatedProducts,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { SendPacingService } from '../message/send-pacing.service';

@Injectable()
export class CatalogService {
  constructor(
    private readonly engines: EngineRegistry,
    private readonly pacing: SendPacingService,
  ) {}

  async getCatalog(sessionId: string): Promise<Catalog | null> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    return engine.getCatalog();
  }

  async getProducts(sessionId: string, page = 1, limit = 20): Promise<PaginatedProducts> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    return engine.getProducts({ page, limit });
  }

  async getProduct(sessionId: string, productId: string): Promise<Product | null> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    return engine.getProduct(productId);
  }

  /**
   * Sending a product is a real outbound chat message, not a catalog read, so it is paced like every
   * other send. It does NOT go through MessageService, which is why the pacing call has to be here:
   * this path persists no row and fires no message hooks either — deliberately out of scope for this
   * change, but worth knowing when reading the counts.
   */
  async sendProduct(sessionId: string, chatId: string, productId: string, body?: string): Promise<MessageResult> {
    await this.pacing.assertSendAllowed(sessionId, chatId);
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    return engine.sendProduct(chatId, productId, body);
  }

  /**
   * Paced for the same reason as sendProduct. Both engines answer 501 today, so the adapter refuses
   * before any traffic leaves — but the route is live, and pacing it now means the day an engine
   * gains support does not silently open an unpaced send path.
   */
  async sendCatalog(sessionId: string, chatId: string, body?: string): Promise<MessageResult> {
    await this.pacing.assertSendAllowed(sessionId, chatId);
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    return engine.sendCatalog(chatId, body);
  }
}

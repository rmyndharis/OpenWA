import { Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type {
  Catalog,
  Product,
  PaginatedProducts,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';

@Injectable()
export class CatalogService {
  constructor(private readonly engines: EngineRegistry) {}

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

  async sendProduct(sessionId: string, chatId: string, productId: string, body?: string): Promise<MessageResult> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    return engine.sendProduct(chatId, productId, body);
  }

  async sendCatalog(sessionId: string, chatId: string, body?: string): Promise<MessageResult> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    return engine.sendCatalog(chatId, body);
  }
}

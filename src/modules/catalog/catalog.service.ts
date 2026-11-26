import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type {
  Catalog,
  Product,
  PaginatedProducts,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { SendPacingService, countsTowardSendBreaker, sentNothing } from '../message/send-pacing.service';
import { HookManager, applySendingGate } from '../../core/hooks';

@Injectable()
export class CatalogService {
  // HookManager comes from the @Global() HooksModule, so no module import is needed.
  constructor(
    private readonly engines: EngineRegistry,
    private readonly pacing: SendPacingService,
    private readonly hookManager: HookManager,
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
   * Sending a product is a real outbound chat message, not a catalog read. It does NOT go through
   * MessageService, so this method runs the two pre-send steps every chat send gets: pacing, then the
   * `message:sending` plugin gate (input `{ chatId, productId, body }`, type `product`). A plugin may
   * rewrite `productId` or `body`; a rewritten `chatId` is ignored, because `chatId` is the value the
   * API key's chat scope was checked against. No PENDING row is written up front. On Baileys the
   * own-send echo (MessageProjector.handleOwnSendEcho) persists the OUTGOING row afterwards and fires
   * `message:sent` and `message:persisted`, so the send is counted into the pacing daily cap once
   * that row lands. Until then its pacing admission is held: for as long as the engine call runs, and for
   * the hold window after it returns.
   */
  async sendProduct(sessionId: string, chatId: string, productId: string, body?: string): Promise<MessageResult> {
    const settle = await this.pacing.assertSendAllowed(sessionId, chatId, { untilSettled: true });
    let engineAsked = false;
    try {
      const gated = await applySendingGate(
        this.hookManager,
        sessionId,
        'product',
        // The DTO lets a JSON null through as "no body". Normalised here, so the checks below only ever
        // judge what a plugin handed back, never the caller's own input.
        { chatId, productId, body: body ?? undefined },
        'CatalogService',
      );
      const gatedProductId: unknown = gated.productId;
      const gatedBody: unknown = gated.body;
      if (typeof gatedProductId !== 'string' || gatedProductId === '') {
        throw new BadRequestException('A message:sending handler returned an invalid productId');
      }
      if (gatedBody !== undefined && typeof gatedBody !== 'string') {
        throw new BadRequestException('A message:sending handler returned an invalid body');
      }
      const engine = this.engines.require(
        sessionId,
        () => new NotFoundException(`Session ${sessionId} not found or not connected`),
      );
      engineAsked = true;
      const result = await this.recordedSend(sessionId, () => engine.sendProduct(chatId, gatedProductId, gatedBody));
      settle?.(true);
      if (result.resolvedChatId) this.pacing.rememberResolvedNumber(sessionId, chatId, result.resolvedChatId);
      // The answer of the route, named field by field: what else the engine result carries (the number WhatsApp
      // resolved, for the row a send stores) is not part of it, and no row is stored here.
      return { id: result.id, timestamp: result.timestamp };
    } catch (error) {
      // No row is written here, so a send that provably never went out gives its pacing admission back.
      // One whose outcome is unknown stays held for a window from now: its own-send echo may still write
      // the row.
      settle?.(engineAsked && !sentNothing(error));
      throw error;
    }
  }

  /**
   * Report the engine send's outcome to the pacing breaker, as every other send path does. The pacing
   * check and the session lookup stay outside, so a policy 429 or a 404 never feeds the breaker.
   */
  private async recordedSend(sessionId: string, send: () => Promise<MessageResult>): Promise<MessageResult> {
    try {
      const result = await send();
      this.pacing.recordSendSuccess(sessionId);
      return result;
    } catch (error) {
      if (countsTowardSendBreaker(error)) {
        this.pacing.recordSendFailure(sessionId);
      }
      throw error;
    }
  }
}

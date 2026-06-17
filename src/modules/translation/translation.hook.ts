import { Injectable, OnModuleInit } from '@nestjs/common';
import { HookManager } from '../../core/hooks';
import { HookContext } from '../../core/hooks/hook.interfaces';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { TranslationCoordinator } from './core/translation.coordinator';
import { InboundMessage } from './core/ports';
import { createLogger } from '../../common/services/logger.service';

@Injectable()
export class TranslationHook implements OnModuleInit {
  private readonly logger = createLogger('TranslationHook');

  constructor(
    private readonly hookManager: HookManager,
    private readonly coordinator: TranslationCoordinator,
  ) {}

  onModuleInit(): void {
    this.hookManager.register(
      'translation',
      'message:received',
      ctx => this.handle(ctx as HookContext<IncomingMessage>),
      100,
    );
  }

  private async handle(ctx: HookContext<IncomingMessage>): Promise<{ continue: boolean; data: IncomingMessage }> {
    const sessionId = ctx.sessionId;
    const msg = ctx.data;
    if (!sessionId) return { continue: true, data: msg };

    try {
      const inbound: InboundMessage = {
        id: msg.id,
        chatId: msg.chatId,
        body: msg.body,
        author: msg.author ?? '',
        isGroup: msg.isGroup,
        fromMe: msg.fromMe,
        mentionedIds: msg.mentionedIds ?? [],
        pushName: msg.contact?.pushName,
      };
      const { swallow } = await this.coordinator.handleMessage(sessionId, inbound);
      return { continue: !swallow, data: msg };
    } catch (err) {
      this.logger.error('Translation hook failed', err instanceof Error ? err.message : String(err), {
        sessionId,
        action: 'translation_hook_error',
      });
      return { continue: true, data: msg };
    }
  }
}

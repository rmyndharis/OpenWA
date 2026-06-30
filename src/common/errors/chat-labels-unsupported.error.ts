import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Thrown by an engine adapter when a chat-label write cannot be applied: either the account is not a
 * WhatsApp Business account (labels are a Business-only feature — whatsapp-web.js rejects the write with
 * an `[LT01] Only Whatsapp business` error) or the target chat type carries no labels (e.g. a channel).
 *
 * Extends NestJS `UnprocessableEntityException` so it maps to **HTTP 422** through NestJS's built-in
 * exception handler — no custom global filter required. Mirrors how {@link EngineNotReadyError} maps to 409.
 */
export class ChatLabelsUnsupportedError extends UnprocessableEntityException {
  constructor(message = 'Chat labels require a WhatsApp Business account.') {
    super(message);
  }
}

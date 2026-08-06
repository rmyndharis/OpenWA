import { BadRequestException } from '@nestjs/common';

/**
 * Thrown when WhatsApp Web cannot resolve an individual recipient to an addressable id, so the send
 * can never leave the gateway. Since WhatsApp's LID migration the page reports this as a bare
 * `Error: No LID for user` raised inside its own bundle — with no status, no recipient, and nothing
 * that identifies it as a caller problem — which reached the client as `500 Internal server error`
 * and left nothing to act on (#1068, and #156/#573 before it).
 *
 * The gateway already knows better by then: `getNumberId` returned null, which is exactly how
 * whatsapp-web.js reports "this number is not reachable on WhatsApp". That verdict is now surfaced
 * instead of discarded.
 *
 * Extends NestJS `BadRequestException` so it maps to **HTTP 400** through the built-in exception
 * handler — no custom global filter required. 400 rather than 404: on these routes a 404 already
 * means the *session* was not found, and reusing it for the recipient would be ambiguous. Mirrors
 * how {@link EngineNotSupportedError} maps to 501 and {@link EngineRefusedError} to 403.
 *
 * Two distinct situations produce it, and the message names both because the gateway cannot tell
 * them apart: the number genuinely is not on WhatsApp, or this account has never had a chat with it
 * (the upstream whatsapp-web.js LID limitation, whatsapp-web.js#3834).
 */
export class RecipientUnreachableError extends BadRequestException {
  constructor(chatId: string) {
    super(
      `WhatsApp could not resolve the recipient ${chatId}. Either the number is not on WhatsApp, or ` +
        'this session has no existing chat with it — message it once from the phone, then retry.',
    );
  }
}

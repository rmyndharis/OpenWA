import { NotFoundException } from '@nestjs/common';

/**
 * Thrown by the engine layer when a message referenced by id can't be found — it is outside the
 * adapter's fetch/store window (e.g. older than the ~100-message lookup, or absent from the Baileys
 * store) or was revoked.
 *
 * Extends NestJS `NotFoundException` so it maps to **HTTP 404** through the built-in exception
 * handler — i.e. it does NOT depend on a custom global filter being registered, and it survives the
 * `message.service` passthrough (and the un-wrapped react/delete paths) — instead of surfacing as a
 * generic 500 Internal Server Error.
 */
export class MessageNotFoundError extends NotFoundException {
  constructor(messageId: string, chatId?: string) {
    super(chatId ? `Message ${messageId} not found in chat ${chatId}` : `Message ${messageId} not found`);
  }
}

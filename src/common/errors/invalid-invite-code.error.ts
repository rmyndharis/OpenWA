import { BadRequestException } from '@nestjs/common';

/**
 * Thrown by the engine layer when a group invite code cannot be redeemed — it is invalid, expired,
 * or revoked. Both engines report this without a distinguishing detail: whatsapp-web.js throws a
 * page-side error (or resolves a gid-less result), Baileys resolves undefined or fails the IQ.
 *
 * Extends NestJS `BadRequestException` so it maps to **HTTP 400** through the built-in exception
 * handler — no custom global filter required. Mirrors {@link CallNotFoundError} (404).
 */
export class InvalidInviteCodeError extends BadRequestException {
  constructor() {
    super('could not join the group — the invite code may be invalid, expired, or revoked');
  }
}

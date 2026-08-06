import { ForbiddenException } from '@nestjs/common';

/**
 * Thrown by the engine layer when WhatsApp refuses an otherwise well-formed operation — e.g. editing
 * a message that is not the account's own, a group settings write without admin rights, or a profile
 * change the engine reports as rejected. The request was valid; the refusal happened WhatsApp-side.
 *
 * Extends NestJS `ForbiddenException` so it maps to **HTTP 403** through the built-in exception
 * handler — no custom global filter required. Mirrors {@link CallNotFoundError} (404).
 */
export class EngineRefusedError extends ForbiddenException {
  constructor(detail: string) {
    super(detail);
  }
}

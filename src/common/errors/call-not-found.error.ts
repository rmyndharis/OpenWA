import { NotFoundException } from '@nestjs/common';

/**
 * Thrown by the engine layer when a call referenced by id can't be rejected — it is not (or no
 * longer) ringing: the id was never seen, the call already ended, or the adapter's live-call
 * cache entry expired (calls ring for roughly a minute).
 *
 * Extends NestJS `NotFoundException` so it maps to **HTTP 404** through the built-in exception
 * handler — no custom global filter required. Mirrors {@link MessageNotFoundError}.
 */
export class CallNotFoundError extends NotFoundException {
  constructor(callId: string) {
    super(`Call ${callId} not found or no longer ringing`);
  }
}

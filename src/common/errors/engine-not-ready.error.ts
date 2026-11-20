import { ConflictException } from '@nestjs/common';

/**
 * Thrown by the engine layer when an operation requires a connected, READY
 * WhatsApp client but the session is not in that state — e.g. it was just
 * disconnected from the phone, is still initializing, or is reconnecting.
 *
 * Extends NestJS `ConflictException` so it maps to **HTTP 409** through NestJS's
 * built-in exception handler — i.e. it does NOT depend on a custom global filter
 * being registered. API callers (and the dashboard) get a clear, retryable
 * "session not connected" error instead of a generic 500 Internal Server Error.
 */
export class EngineNotReadyError extends ConflictException {
  /** `response` is the message, or the whole body of a subclass that carries more than the default three fields. */
  constructor(
    response: string | Record<string, unknown> = 'Session is not connected. The WhatsApp client is not ready.',
  ) {
    super(response);
  }
}

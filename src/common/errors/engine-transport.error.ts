import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown by an engine adapter when an operation fails because the engine's TRANSPORT is dead —
 * the Chromium page/CDP connection is gone (whatsapp-web.js) or the WebSocket dropped (Baileys) —
 * rather than because the requested resource does not exist. A broad catch that folds this into a
 * not-found result makes a crashed session look like a missing group/channel (404) or a refused
 * invite (400), which is how operators end up debugging the wrong layer.
 *
 * Extends NestJS `ServiceUnavailableException` so it maps to **HTTP 503** through the built-in
 * exception handler — no custom global filter required. Mirrors {@link EngineNotReadyError} (409).
 */
export class EngineTransportError extends ServiceUnavailableException {
  constructor(detail: string) {
    super(detail);
  }
}

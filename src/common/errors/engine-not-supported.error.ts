import { NotImplementedException } from '@nestjs/common';

/**
 * Thrown by an engine adapter when a method is part of the {@link IWhatsAppEngine}
 * contract but the active engine cannot implement it (e.g. the Baileys engine has no
 * self-maintained store, so history/contacts/groups are unavailable in its minimal slice).
 *
 * Extends NestJS `NotImplementedException` so it maps to **HTTP 501** through NestJS's
 * built-in exception handler — no custom global filter required. Mirrors how
 * {@link EngineNotReadyError} maps to 409.
 */
export class EngineNotSupportedError extends NotImplementedException {
  constructor(method: string) {
    super(`Operation not supported by the active engine: ${method}`);
  }
}

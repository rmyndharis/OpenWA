import { NotFoundException } from '@nestjs/common';

/**
 * Thrown by the engine layer when a label id does not resolve — the label was never created, or the
 * account is not a WhatsApp Business one and therefore holds no labels at all. Both are the same
 * answer to the caller, and the same message shape LabelService.getLabelById already returns.
 *
 * Extends NestJS `NotFoundException` so it maps to **HTTP 404** through the built-in exception
 * handler — no custom global filter required. Mirrors {@link GroupNotFoundError}.
 */
export class LabelNotFoundError extends NotFoundException {
  constructor(labelId: string) {
    super(`Label ${labelId} not found`);
  }
}

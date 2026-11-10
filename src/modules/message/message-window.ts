import { BadRequestException } from '@nestjs/common';
import { MessageDirection } from './entities/message.entity';

/** The longest stored message type token, and the longest exact message reference a filter accepts. */
export const MESSAGE_TYPE_MAX_LENGTH = 50;
export const MESSAGE_REFERENCE_MAX_LENGTH = 200;
const MESSAGE_TYPE_PATTERN = new RegExp(`^[a-z][a-z0-9_]{0,${MESSAGE_TYPE_MAX_LENGTH - 1}}$`);

export interface MessageWindow {
  /** Unix epoch milliseconds, inclusive. Selection uses WhatsApp's message time. */
  since?: number;
  /** Unix epoch milliseconds, exclusive. */
  until?: number;
  direction?: MessageDirection;
  /** Exact stored message type (e.g. text, image or voice), no full-text search required. */
  type?: string;
  /** Exact WhatsApp message reference, scoped to the same session/chat. */
  messageId?: string;
  /** Existing ingestion-time order remains the default. Both orders are newest first. */
  orderBy?: 'createdAt' | 'timestamp';
}

/** Match integer message seconds without underflowing a positive millisecond bound to zero. */
export function messageTimeBoundarySeconds(milliseconds: number): number {
  return milliseconds === 0 ? 0 : Math.max(1, Math.ceil(milliseconds / 1000));
}

export function validateMessageWindow(window: MessageWindow): void {
  for (const key of ['since', 'until'] as const) {
    const value = window[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    ) {
      throw new BadRequestException(`${key} must be Unix epoch milliseconds between 0 and ${Number.MAX_SAFE_INTEGER}`);
    }
  }
  if (window.since !== undefined && window.until !== undefined && window.since >= window.until) {
    throw new BadRequestException('since must be earlier than the exclusive until boundary');
  }
  if (window.direction !== undefined && !Object.values(MessageDirection).includes(window.direction)) {
    throw new BadRequestException('direction must be incoming or outgoing');
  }
  if (window.type !== undefined && (typeof window.type !== 'string' || !MESSAGE_TYPE_PATTERN.test(window.type))) {
    throw new BadRequestException('type must be a non-empty message type token');
  }
  if (
    window.messageId !== undefined &&
    (typeof window.messageId !== 'string' ||
      !window.messageId.length ||
      window.messageId.length > MESSAGE_REFERENCE_MAX_LENGTH ||
      /\s/.test(window.messageId) ||
      [...window.messageId].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
  ) {
    throw new BadRequestException(
      `messageId must be a non-empty WhatsApp message reference up to ${MESSAGE_REFERENCE_MAX_LENGTH} characters`,
    );
  }
  if (window.orderBy !== undefined && !['createdAt', 'timestamp'].includes(window.orderBy)) {
    throw new BadRequestException('orderBy must be createdAt or timestamp');
  }
}

export function parseMessageWindow(query: {
  since?: string;
  until?: string;
  direction?: string;
  type?: string;
  /** Exact WhatsApp message reference, scoped to the same session/chat. */
  messageId?: string;
  orderBy?: string;
}): MessageWindow {
  const milliseconds = (key: 'since' | 'until'): number | undefined => {
    const value = query[key];
    if (value === undefined) return undefined;
    // Number('') and Number('0x10') are valid JavaScript, not valid HTTP timestamps.
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value))
      throw new BadRequestException(`${key} must be Unix epoch milliseconds`);
    return Number(value);
  };
  const window: MessageWindow = {
    since: milliseconds('since'),
    until: milliseconds('until'),
    direction: query.direction as MessageDirection | undefined,
    type: query.type,
    messageId: query.messageId,
    orderBy: query.orderBy as MessageWindow['orderBy'],
  };
  validateMessageWindow(window);
  return Object.fromEntries(Object.entries(window).filter(([, value]) => value !== undefined));
}

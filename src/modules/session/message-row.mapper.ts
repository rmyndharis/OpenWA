import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Message types whose rows must show a media placeholder even when the payload carried none.
 *
 * A wwjs own-send echo whose media download failed carries no media field at all, and the history
 * sync maps messages media-free to keep its footprint down. Without the marker such a row renders
 * as an empty bubble — the DB copy wins over the engine-history placeholder in the dashboard
 * merge — and the by-type stats filter would skip it. (The Baileys API-send echo needs no synthesis:
 * it emits the omitted marker itself.)
 */
export const MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'voice', 'sticker', 'document']);

/** The synthesized stand-in for a media payload the engine did not deliver. */
export const OMITTED_MEDIA = { mimetype: '', omitted: true } as const;

/**
 * Builds the `metadata` JSON column for a persisted message row.
 *
 * The three persist paths (live inbound `onMessage`, own-send echo `onMessageCreate`, and the
 * pre-connection history backfill) each assembled this inline, with one deliberate difference:
 * inbound trusts the engine's media field as-is, while the two paths that can arrive without one
 * synthesize a placeholder. Keeping both rules in one function makes that difference explicit
 * instead of something to re-derive at each site.
 *
 * @param synthesizeOmittedMedia When true, a media-typed message with no media payload gets the
 *   omitted marker. False for live inbound, where absent media genuinely means "no media".
 * @returns The metadata object, or undefined when there is nothing to store (the column is nullable
 *   and an empty object would be noise).
 */
export function buildMessageMetadata(
  message: Pick<IncomingMessage, 'media' | 'quotedMessage' | 'call' | 'type'>,
  synthesizeOmittedMedia = false,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (message.media) {
    metadata.media = message.media;
  } else if (synthesizeOmittedMedia && MEDIA_MESSAGE_TYPES.has(message.type)) {
    metadata.media = { ...OMITTED_MEDIA };
  }
  if (message.quotedMessage) {
    metadata.quotedMessage = message.quotedMessage;
  }
  if (message.call) {
    metadata.call = message.call;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * The `waMessageId` to store for a message.
 *
 * An engine that received a message but could not read its id back reports the empty sentinel, and
 * NULL is what the non-partial `(sessionId, waMessageId)` unique index exempts — storing `''` would
 * collide the second such message and lose the row. Every persist path funnels through here so that
 * chokepoint cannot be forgotten at a new one.
 */
export function storableWaMessageId(id: string | undefined): string | undefined {
  return id || undefined;
}

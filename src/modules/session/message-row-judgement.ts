import { MessageDirection } from '../message/entities/message.entity';
import {
  mutationTargetsForeignRowPersisted,
  type MutationSource,
  type StoredMessageRef,
} from './message-mutation-guard';

/** A stored row as it is read to judge a change, with the engine's own `from` and `to`. */
export type JudgedRow = StoredMessageRef & { from?: string; to?: string };

/** whatsapp-web.js names a message `<fromMe>_<chat>_<key>`, with the chat the engine keeps it in. */
const WWEBJS_ID_CHAT = /^(true|false)_([^_]+@(?:c\.us|g\.us|lid|broadcast|newsletter))_/;

/**
 * The ref a whatsapp-web.js id names, for a row stored before engine refs were kept, which a hook may have filed
 * under another chat. Only where the engine's own `from` (incoming) or `to` (own) names that chat too, so an id a
 * hook rewrote adds no chat. Null on a row with an engine ref and for an id that names no chat, and on a message
 * with an author for a one-to-one chat: a group sender picks the id on Baileys, and could name their own chat.
 */
const idNamedRef = (row: JudgedRow, waMessageId: string): StoredMessageRef | null => {
  const named = row.engineRef ? null : WWEBJS_ID_CHAT.exec(waMessageId);
  if (!named) return null;
  const fromMe = named[1] === 'true';
  const chatId = named[2];
  if ((fromMe ? row.to : row.from) !== chatId || (row.author && !chatId.endsWith('@g.us'))) return null;
  return { chatId, direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING, author: row.author };
};

/**
 * Why a change must not touch the stored row under `waMessageId` (null when it may). `moved` says the row took it
 * for what the engine reported of a message a hook filed elsewhere (its engine ref, or the chat its id names), so
 * its pending deliveries carry the filed chat.
 */
export async function judgeStoredRow(
  row: JudgedRow,
  waMessageId: string,
  source: MutationSource,
  resolveLid?: (jid: string) => Promise<string | null>,
): Promise<{ reason: 'chat' | 'direction' | 'author' | null; moved: boolean }> {
  const reason = await mutationTargetsForeignRowPersisted(row, source, resolveLid);
  if (!reason) return { reason, moved: Boolean(row.engineRef) };
  const named = idNamedRef(row, waMessageId);
  if (named && !(await mutationTargetsForeignRowPersisted(named, source, resolveLid))) {
    return { reason: null, moved: true };
  }
  return { reason, moved: false };
}

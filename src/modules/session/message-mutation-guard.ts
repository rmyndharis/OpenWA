import { MessageDirection } from '../message/entities/message.entity';
import { parseWaId } from '../../engine/identity/wa-id';

/** What a stored row says about whose message it is and where it lives. */
export interface StoredMessageRef {
  chatId: string;
  direction: MessageDirection;
  author?: string | null;
}

/** What an inbound edit, revoke or reaction says about who made it and where. */
export interface MutationSource {
  kind: 'edit' | 'revoke' | 'reaction';
  chatId: string;
  /** Whether the account itself made the change, from its phone; undefined when the engine does not say. */
  fromMe?: boolean;
  /** For a group edit, the participant who wrote the message being edited. */
  author?: string;
}

/**
 * What two spellings of one phone number share: its digits, without a '+', spaces or dashes, and without
 * the mobile marker digit that a Brazilian (`55` + area + `9`), Mexican (`521`) or Argentine (`549`) number
 * is written with in one spelling and without in the other. A send stores the chat id as its caller wrote
 * it, so the stored form and the one the engine reports can differ in either direction.
 */
export function phoneKey(local: string): string {
  return local
    .replace(/\D/g, '')
    .replace(/^55(\d{2})9(\d{8})$/, '55$1$2')
    .replace(/^521(\d{10})$/, '52$1')
    .replace(/^549(\d+)$/, '54$1');
}

/**
 * The entity an id names, whatever its dialect: a phone (`@c.us`, `@s.whatsapp.net`, hosted, a `:device`
 * form or a bare number, which is how the send routes may have stored it), a lid, a group or a list.
 * Null for an id this cannot place, which proves nothing.
 */
function entityOf(jid: string): { kind: string; id: string } | null {
  const parsed = parseWaId(jid);
  if (parsed.kind === 'user') return { kind: 'user', id: phoneKey(parsed.userPart) };
  if (parsed.kind !== 'unknown') return { kind: parsed.kind, id: parsed.userPart };
  return !jid.includes('@') && /^\+?\d[\d -]*$/.test(jid.trim()) ? { kind: 'user', id: phoneKey(jid) } : null;
}

const isPerson = (kind: string): boolean => kind === 'user' || kind === 'lid';

/**
 * A message the account sent to a broadcast list, or posted as a status, is filed under the list or the
 * status chat, while each recipient or viewer reacts from their own one-to-one chat: no chat can ever
 * match it. The engine adapters exempt exactly this case for a reaction, and so does the guard.
 */
function isOwnBroadcast(row: StoredMessageRef): boolean {
  const kind = entityOf(row.chatId)?.kind;
  return row.direction === MessageDirection.OUTGOING && (kind === 'broadcast' || kind === 'status');
}

/**
 * A message received through a contact's broadcast list was filed under the list id by earlier versions
 * (its row says `<id>@broadcast`, incoming), though the dashboard and the engines show it in the one-to-one
 * chat with its sender. A change to it names the sender's chat, which is the chat of that message as well,
 * for as long as the row keeps the list id.
 */
function receivedThroughList(
  row: StoredMessageRef,
  chatId: string,
  resolveLid?: (jid: string) => string | null,
): boolean {
  return (
    row.direction === MessageDirection.INCOMING &&
    entityOf(row.chatId)?.kind === 'broadcast' &&
    !provablyDifferent(row.author, chatId, resolveLid)
  );
}

/**
 * Whether two ids provably name different chats or people, compared by the entity they name rather than
 * by dialect or spelling. A LID and phone match only through a reported directory pairing.
 */
export function provablyDifferent(
  a?: string | null,
  b?: string | null,
  resolveLid?: (jid: string) => string | null,
): boolean {
  if (!a || !b || a === b) return false;
  const left = entityOf(a);
  const right = entityOf(b);
  if (!left || !right) return false;
  if (left.kind === right.kind) return left.id !== right.id;
  if (!isPerson(left.kind) || !isPerson(right.kind)) return true;
  const lid = left.kind === 'lid' ? a : b;
  const phone = left.kind === 'user' ? left.id : right.id;
  const mapped = resolveLid?.(lid);
  return !mapped || phoneKey(mapped) !== phone;
}

/**
 * Why a change must not touch the stored row it names, or null when it may.
 *
 * Baileys applies no validation to an edit, a revoke or a reaction: it hands over whatever a participant
 * sent, naming any message id the sender knows. The engine adapter checks it against its own message
 * store, which holds the newest few thousand messages and never a history-synced one, so for an older
 * message only this row can tell. WhatsApp clients ignore a change made by somebody other than the
 * author, so applying it would make the gateway's record say what no client shows.
 *
 *  - `chat`: a message id belongs to one chat. A reaction to a message the account sent to a broadcast
 *    list or posted as a status is the exception: its recipients react from their own chats. So is any
 *    change to a received list message that an earlier version filed under the list, from its sender's chat.
 *  - `direction`: an edit, and a revoke in a one-to-one chat, come from the author only, so a change
 *    made by the counterparty cannot name a message the account sent, nor the reverse. Group revokes are
 *    exempt, since an admin may delete anyone's message.
 *  - `author`: a group edit comes from the participant who wrote the message.
 */
export function mutationTargetsForeignRow(
  row: StoredMessageRef,
  source: MutationSource,
  resolveLid?: (jid: string) => string | null,
): 'chat' | 'direction' | 'author' | null {
  const listed =
    (source.kind === 'reaction' && isOwnBroadcast(row)) || receivedThroughList(row, source.chatId, resolveLid);
  if (!listed && provablyDifferent(row.chatId, source.chatId, resolveLid)) return 'chat';
  const group = source.chatId.endsWith('@g.us') || row.chatId.endsWith('@g.us');
  const authorOnly = source.kind === 'edit' || (source.kind === 'revoke' && !group);
  if (authorOnly && source.fromMe !== undefined) {
    const expected = source.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING;
    if (row.direction && row.direction !== expected) return 'direction';
  }
  if (
    source.kind === 'edit' &&
    group &&
    source.fromMe === false &&
    provablyDifferent(row.author, source.author, resolveLid)
  ) {
    return 'author';
  }
  return null;
}

/** Resolve only cross-dialect comparisons through reported directory data; distinct LIDs stay distinct. */
export async function mutationTargetsForeignRowPersisted(
  row: StoredMessageRef,
  source: MutationSource,
  resolveLid?: (jid: string) => Promise<string | null>,
): Promise<'chat' | 'direction' | 'author' | null> {
  if (!resolveLid) return mutationTargetsForeignRow(row, source);
  const phones = new Map<string, string | null>();
  await Promise.all(
    [...new Set([row.chatId, row.author, source.chatId, source.author])].map(async jid => {
      if (jid && parseWaId(jid).kind === 'lid') phones.set(jid, await resolveLid(jid).catch(() => null));
    }),
  );
  return mutationTargetsForeignRow(row, source, jid => phones.get(jid) ?? null);
}

/**
 * Whether a delivery or read receipt naming `chatId` provably belongs to another chat than the stored row of the
 * message it names. Baileys relays a peer's receipt under the peer's own chat with every id the stanza lists, and
 * checks none of them against that chat, so a receipt from one chat could otherwise move another chat's message.
 *
 * A receipt for a message the account sent to a broadcast list comes from each recipient's own chat, and one for a
 * list message an earlier version filed under the list from its sender's chat: neither is foreign. A lid and a
 * phone with no reported pairing prove nothing either. A receipt only ever moves delivery state forward, and
 * refusing it would leave the account's messages to a lid-addressed contact at sent.
 */
export function receiptTargetsForeignRow(
  row: StoredMessageRef,
  chatId: string,
  resolveLid?: (jid: string) => string | null,
): boolean {
  if (isOwnBroadcast(row) || receivedThroughList(row, chatId, resolveLid)) return false;
  const stored = entityOf(row.chatId);
  const named = entityOf(chatId);
  if (stored && named && stored.kind !== named.kind && isPerson(stored.kind) && isPerson(named.kind)) {
    if (!resolveLid?.(stored.kind === 'lid' ? row.chatId : chatId)) return false;
  }
  return provablyDifferent(row.chatId, chatId, resolveLid);
}

/** {@link receiptTargetsForeignRow} with the lids it compares resolved through reported directory data. */
export async function receiptTargetsForeignRowPersisted(
  row: StoredMessageRef,
  chatId: string,
  resolveLid?: (jid: string) => Promise<string | null>,
): Promise<boolean> {
  if (!resolveLid) return receiptTargetsForeignRow(row, chatId);
  const phones = new Map<string, string | null>();
  await Promise.all(
    [...new Set([row.chatId, row.author, chatId])].map(async jid => {
      if (jid && parseWaId(jid).kind === 'lid') phones.set(jid, await resolveLid(jid).catch(() => null));
    }),
  );
  return receiptTargetsForeignRow(row, chatId, jid => phones.get(jid) ?? null);
}

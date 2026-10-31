import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import { parseWaId, userPart } from '../identity/wa-id';
import { withQueryDeadline } from './baileys-query-deadline';

/** Confirm a phone/LID pair with the public server query, without reading Baileys' signal cache. */
export async function queryLidPhone(
  socket: WASocket,
  library: typeof BaileysLib,
  phone: string,
  lid: string,
  budgetMs: number,
): Promise<boolean> {
  const query = new library.USyncQuery()
    .withLIDProtocol()
    .withContext('background')
    .withUser(new library.USyncUser().withId(`${phone}@s.whatsapp.net`));
  const result = await withQueryDeadline(
    socket.executeUSyncQuery(query),
    budgetMs,
    'WhatsApp did not answer the LID identity query in time',
  );
  const matches = result?.list.filter(row => parseWaId(row.id).kind === 'user' && userPart(row.id) === phone);
  return (
    matches?.length === 1 &&
    typeof matches[0].lid === 'string' &&
    parseWaId(matches[0].lid).kind === 'lid' &&
    userPart(matches[0].lid) === lid
  );
}

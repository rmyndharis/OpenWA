import type * as BaileysLib from '@whiskeysockets/baileys';
import type { USyncQueryResult, WASocket } from '@whiskeysockets/baileys';
import { parseWaId, userPart } from '../identity/wa-id';
import { guardLookup, withQueryDeadline } from './baileys-query-deadline';

/** The server query that asks which LID WhatsApp holds for a phone. */
export function phoneLidQuery(library: typeof BaileysLib, phone: string) {
  return new library.USyncQuery()
    .withLIDProtocol()
    .withContext('background')
    .withUser(new library.USyncUser().withId(`${phone}@s.whatsapp.net`));
}

/**
 * The `<lid>@lid` a {@link phoneLidQuery} answer names for the phone, or null when it names none. An answer that
 * names the phone twice is not trusted for either.
 */
export function lidOfPhone(result: USyncQueryResult | undefined, phone: string): string | null {
  const matches = result?.list.filter(row => parseWaId(row.id).kind === 'user' && userPart(row.id) === phone);
  const lid = matches?.length === 1 ? matches[0].lid : undefined;
  return typeof lid === 'string' && parseWaId(lid).kind === 'lid' ? `${userPart(lid)}@lid` : null;
}

/**
 * Confirm a phone/LID pair with the public server query, without reading Baileys' signal cache. A query
 * WhatsApp refuses or a connection that closes under it rejects as a 503 (see guardLookup), not a raw 500.
 */
export async function queryLidPhone(
  socket: WASocket,
  library: typeof BaileysLib,
  phone: string,
  lid: string,
  budgetMs: number,
): Promise<boolean> {
  const result = await guardLookup(
    withQueryDeadline(
      socket.executeUSyncQuery(phoneLidQuery(library, phone)),
      budgetMs,
      'WhatsApp did not answer the LID identity query in time',
    ),
    'The LID identity query',
  );
  return lidOfPhone(result, phone) === `${lid}@lid`;
}

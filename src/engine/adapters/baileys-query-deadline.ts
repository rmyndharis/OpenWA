import { HttpException } from '@nestjs/common';
import { EngineThrottledError } from '../../common/errors/engine-throttled.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * A deadline OpenWA owns, for Baileys calls whose outcome cannot be read from their return value.
 *
 * Baileys' `query()` catches its own `defaultQueryTimeoutMs` and RESOLVES `undefined` rather than
 * throwing (Socket/socket.js: "Catch timeout and return undefined instead of throwing"). Callers
 * downstream of that split two ways:
 *
 *  - those that can still tell the cases apart from the value (`onWhatsApp` resolves `undefined` where
 *    a real answer is an array, an invite-code read an absent code). They check the value, and are
 *    bounded here all the same: Baileys' 60 s is past this budget and `session.proxyTimeoutMs`;
 *  - those that cannot, because the library discards the result. Every group and profile WRITE is
 *    in this second group: `groupLeave`, `groupUpdateSubject`, `groupSettingUpdate` and their
 *    siblings all `await groupQuery(...)` and return void, so the call resolves identically whether
 *    WhatsApp confirmed the change or never answered at all.
 *
 * For the second group a clock is the only discriminator there is. Shape follows
 * `withInboundDownloadTimeout` (inbound-media-cap.ts): an unref'd timer, cleared in a `finally`,
 * and the abandoned call's late rejection defused so it cannot surface unhandled.
 *
 * Abandoning the call does NOT cancel it — the underlying query settles on Baileys' own 60s clock
 * and is discarded. That is harmless here because nothing loops on it; where an unanswered query
 * drives a loop instead (`resyncAppState`), a deadline would hide the leak rather than stop it and
 * the fix belongs in the library.
 */
export async function withQueryDeadline<T>(work: Promise<T>, timeoutMs: number, detail: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // Defuse a post-settle rejection from the call we may stop awaiting.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EngineTransportError(detail)), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    // The connection closed under the call: a query still waiting rejects with the bare WebSocket close code
    // (Baileys hands the `close` event's argument to reject), and a write on a socket that is no longer open
    // throws Baileys' Boom('Connection Closed', 428), which carries no data. Neither has a WA code a caller can
    // classify, so both would reach the client as a 500. A WhatsApp answer carries its code or GraphQL error as data.
    const boom = error as { isBoom?: unknown; data?: unknown; output?: { statusCode?: unknown } } | null;
    if (typeof error === 'number' || (boom?.isBoom === true && boom.output?.statusCode === 428 && !boom.data)) {
      throw new EngineTransportError(
        `The connection to WhatsApp closed${typeof error === 'number' ? ` (code ${error})` : ''} before it answered`,
      );
    }
    throw error;
  } finally {
    // clearTimeout tolerates undefined, so no guard — a guard here would be a branch no test can
    // reach, since the race always assigns the timer before it can settle.
    clearTimeout(timer);
  }
}

/**
 * Run a lookup that asks WhatsApp about someone and keep every failure to ASK a 503.
 *
 * `onWhatsApp` and `executeUSyncQuery` reject with a raw Boom when WhatsApp answers the query with an error
 * node (`data` is the WA code, see assertNodeErrorFree) and when the connection closes mid-query. Neither is a
 * verdict about the number, and left alone both reach Nest as a 500 where the lookup routes promise a retryable
 * 503. A 429 keeps its own class so a paced caller can tell a throttled request from a dead link. Wrap only the
 * awaited network call: a bug in building the query should still surface as the bug it is. An HttpException
 * (the deadline above, a not-ready engine) is already classified and passes through.
 */
export async function guardLookup<T>(work: Promise<T>, operation: string): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof HttpException) throw error;
    const code = (error as { data?: unknown } | null | undefined)?.data;
    if (code === 429) throw new EngineThrottledError(`${operation} was rate-limited by WhatsApp (code 429)`);
    throw new EngineTransportError(
      `${operation} could not be answered by WhatsApp${typeof code === 'number' ? ` (code ${code})` : ''}`,
    );
  }
}

/** {@link withQueryDeadline} for a write whose confirmation the library discards; the error names the operation. */
export function confirmedWrite<T>(work: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return withQueryDeadline(work, timeoutMs, `WhatsApp did not confirm ${operation} in time`);
}

/**
 * Budget for a single bounded Baileys call, read or write. Anchored to MEDIA_DOWNLOAD_TIMEOUT_MS (inbound-media-cap.ts),
 * this repo's existing figure for one bounded network round trip over WhatsApp. It must stay under
 * Baileys' 60s `defaultQueryTimeoutMs` to be observable at all, and under `session.proxyTimeoutMs`
 * so a multi-node deployment does not race two deadlines against each other.
 *
 * A WhatsApp IQ normally answers in well under a second, so reaching this means something is wrong
 * — but a genuinely slow write that succeeds just after the deadline WILL be reported as
 * unconfirmed. That is the deliberate trade: an honest "not confirmed" beats a "done" for a change
 * WhatsApp never acknowledged, and every write bounded here is safe to repeat.
 */
export const BAILEYS_QUERY_BUDGET_MS = 30_000;

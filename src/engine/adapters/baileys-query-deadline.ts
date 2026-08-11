import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * A deadline OpenWA owns, for Baileys calls whose outcome cannot be read from their return value.
 *
 * Baileys' `query()` catches its own `defaultQueryTimeoutMs` and RESOLVES `undefined` rather than
 * throwing (Socket/socket.js: "Catch timeout and return undefined instead of throwing"). Callers
 * downstream of that split two ways:
 *
 *  - those that can still tell the cases apart from the value — `onWhatsApp` resolves `undefined`
 *    where a real answer is an array — and those check the value directly instead of using this;
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
  } finally {
    // clearTimeout tolerates undefined, so no guard — a guard here would be a branch no test can
    // reach, since the race always assigns the timer before it can settle.
    clearTimeout(timer);
  }
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

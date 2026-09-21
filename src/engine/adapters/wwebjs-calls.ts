import { type Call } from 'whatsapp-web.js';
import { type EngineEventCallbacks, type IncomingCallEvent } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';

/**
 * Incoming-call handling extracted from WhatsAppWebJsAdapter: the `call` client event, the cache of
 * ringing call ids that keeps one call from surfacing as several events, and the call rejection this
 * engine refuses. The adapter keeps the public methods as thin forwarders and injects the host
 * surface via closures, so the delegate never touches lifecycle state directly.
 */
export interface WwebjsCallsHost {
  readonly logger: ReturnType<typeof createLogger>;
  /** Whether teardown has begun — a call landing during or after it is dropped, never cached. */
  isTearingDown(): boolean;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
}

export class WwebjsCalls {
  /** How long a received call id stays cached. Calls ring for roughly a minute, so two minutes
   *  covers the ringing window with margin without pinning dead calls for long. */
  private static readonly LIVE_CALL_TTL_MS = 2 * 60_000;

  /** Expiry time of each ringing call, by call id. Public so the adapter's `liveCalls` alias keeps
   *  working (the spec reads `adapter.liveCalls` through a cast) and lifecycle teardown can clear it
   *  when the client goes away. */
  readonly liveCalls = new Map<string, number>();

  constructor(private readonly host: WwebjsCallsHost) {}

  /**
   * Map a whatsapp-web.js `Call` (client `call` event) to the neutral IncomingCallEvent. Own-account
   * calls (fromMe) are skipped: they are outgoing, not incoming. `from` is passed through as the
   * library reports it, and that can be an `@lid` privacy id rather than `@c.us`. The try/catch
   * mirrors message_edit: a malformed call is logged and dropped, never thrown back into the emitter.
   */
  handleIncomingCall(call: Call): void {
    try {
      // Symmetry with the other client-event handlers (qr/authenticated): a call landing during or
      // after teardown is dropped. A malformed call without an id or a caller is dropped too: never
      // cached, never emitted.
      if (this.host.isTearingDown() || !call?.id || !call.from) {
        return;
      }
      if (call.fromMe) {
        return;
      }
      // whatsapp-web.js fires this handler from a patched `internalCallMap.set()`, which runs on
      // every write to that map, including updates to a call already ringing, so the same call id
      // can arrive more than once. Cache first and emit only for an id not already live, otherwise
      // one call surfaces as several `call.received` events.
      if (!this.cacheLiveCall(call.id)) {
        return;
      }
      const payload: IncomingCallEvent = {
        callId: call.id,
        from: call.from ?? '',
        isVideo: call.isVideo === true,
        isGroup: call.isGroup === true,
        timestamp:
          typeof call.timestamp === 'number' && call.timestamp > 0
            ? Math.floor(call.timestamp)
            : Math.floor(Date.now() / 1000),
      };
      this.host.getCallbacks().onCall?.(payload);
    } catch (error) {
      this.host.logger.error('Error processing call event', String(error));
    }
  }

  /**
   * Cache a ringing call id. Lazy expiry: inserting a new call drops already-expired entries, so the
   * map cannot grow without bound; an entry that never sees another call is tiny and is dropped on
   * teardown or at the next call. No per-entry timer to clean up.
   *
   * Returns true when `callId` was not already ringing, which is what makes `call.received` fire
   * once per call rather than once per upstream map write. A repeat write refreshes the entry, so a
   * long-ringing call is not announced a second time.
   */
  private cacheLiveCall(callId: string): boolean {
    const now = Date.now();
    for (const [id, expiresAt] of this.liveCalls) {
      if (expiresAt <= now) {
        this.liveCalls.delete(id);
      }
    }
    const isNewCall = !this.liveCalls.has(callId);
    this.liveCalls.set(callId, now + WwebjsCalls.LIVE_CALL_TTL_MS);
    return isNewCall;
  }

  /**
   * Not available on this engine, despite `Call.reject()` existing and being typed `Promise<void>`
   * (`index.d.ts:2417`).
   *
   * Measured live on 2026-09-17 on OpenWA 0.23.4 with WhatsApp Web `2.3000.1047471845-alpha`: the
   * reject resolved and OpenWA logged the call as auto-rejected, but the caller's phone kept ringing
   * until it timed out, while a Baileys auto-reject stopped the caller's phone at once that day. Why
   * the rejection has no effect is not established. The page function it runs, `WWebJS.rejectCall`,
   * is modified by OpenWA's install-time patch (`scripts/wwebjs-201832.patch`), which reads the own
   * user id as `getMaybeMePnUser()._serialized || $1`.
   *
   * A 501 tells the caller the truth where a 200 claimed a rejection that did not stop the call.
   * Restoring support needs a live call proving that a rejection stops the ringing.
   */
  /* eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  async rejectCall(_callId: string): Promise<void> {
    throw new EngineNotSupportedError('rejectCall');
  }

  /** Drop every cached call id when the client goes away: the ids belong to the client that saw them. */
  clearLiveCalls(): void {
    this.liveCalls.clear();
  }
}

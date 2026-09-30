import { type Client, WAState } from 'whatsapp-web.js';
import { type EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';

/**
 * Readiness reconciliation extracted from WhatsAppWebJsAdapter: the post-authentication window that
 * promotes a session the library's own `ready` event missed (or failed to attach the inbound bridge
 * for), and the one-shot page reload for a CONNECTED-but-bridge-dead session. The adapter keeps the
 * methods as thin forwarders and injects the host surface via closures, so the delegate never
 * touches lifecycle state directly.
 */
export interface WwebjsReadyReconcileHost {
  readonly logger: ReturnType<typeof createLogger>;
  readonly config: WhatsAppWebJsConfig;
  getClient(): Client | null;
  getStatus(): EngineStatus;
  setStatus(status: EngineStatus): void;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
  /** Promote to READY off the live client's info — the lifecycle's own ready path. */
  markReadyFromClientInfo(): void;
  /** Whether this engine showed a QR before authenticating: a fresh pairing, not a restored session. */
  wasFreshPairing(): boolean;
  /** The deadline's fresh-pairing branch: clear the broken auth and let the lifecycle re-pair. */
  recoverFromStuckAuth(): Promise<void>;
}

const READY_RECONCILE_INTERVAL_MS = 2000;
export const READY_RECONCILE_TIMEOUT_MS = 90_000;

// How long after `authenticated` the event bridge is allowed to still be attaching before a reload is
// considered. whatsapp-web.js clears `eventsAttached` in its constructor (Client.js:109) and sets it
// only once attachEventListeners() resolves (Client.js:373); in between it evaluates LoadUtils, polls
// up to 30s for window.WWebJS (Client.js:334), then builds ClientInfo and InterfaceController. So a
// false flag is the NORMAL reading for most of a minute on a loaded host, and reloading on it aborts
// a healthy attach — the page navigates out from under the in-flight inject(), which then dies before
// re-exposing the bridge and cannot be retried (#1081). Must exceed upstream's own 30s poll with room
// for the rest of the pipeline, and stay well under READY_RECONCILE_TIMEOUT_MS so a reload that IS
// warranted still has time to reinject before the deadline.
export const READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS = 45_000;

export class WwebjsReadyReconcile {
  private readyReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private readyReconcileStartedAt = 0;
  private readyReconcileProbeInFlight = false;
  // What the last reconcile probe observed, driving the bridge-dead self-heal and the deadline
  // decision (a CONNECTED session must never have its credentials wiped).
  private lastProbeStateConnected = false;
  private readyReconcileReloadAttempted = false;

  constructor(private readonly host: WwebjsReadyReconcileHost) {}

  scheduleReadyReconcile(): void {
    this.clearReadyReconcile();
    this.readyReconcileStartedAt = Date.now();

    const tick = (): void => {
      if (!this.host.getClient() || this.host.getStatus() !== EngineStatus.AUTHENTICATING) {
        this.clearReadyReconcile();
        return;
      }

      // Deadline checked at the TOP of every tick (not after the probe) so a slow/hung getState() — a
      // wedged page can make it never resolve, the very #251/#273 condition — can't defeat the 90s ceiling.
      if (Date.now() - this.readyReconcileStartedAt >= READY_RECONCILE_TIMEOUT_MS) {
        // A CONNECTED page whose event bridge never attached (even after the one-shot reload) is a
        // different animal from a stuck-after-QR session: the link and the credentials are fine,
        // only this browser instance is broken. Wiping the only copy of the credentials would trade
        // a restart-fixable fault for a forced re-pair — fail loudly and keep the auth instead.
        // A reload attempt counts as proof of CONNECTED: it only follows a CONNECTED probe, and the
        // page it reboots can report OPENING on every probe until the deadline.
        const bridgeDead =
          (this.lastProbeStateConnected || this.readyReconcileReloadAttempted) &&
          (this.host.getClient() as Client & { eventsAttached?: boolean })?.eventsAttached === false;
        if (bridgeDead) {
          this.host.logger.error(
            'WhatsApp Web stayed connected but its event bridge never attached within the readiness ' +
              'deadline — inbound messages would be silently lost, so the session is marked failed. ' +
              'The saved credentials were kept; restart the session to relaunch the browser.',
            undefined,
            { sessionId: this.host.config.sessionId, action: 'ready_reconcile_bridge_dead' },
          );
          this.clearReadyReconcile();
          this.host.setStatus(EngineStatus.FAILED);
          this.host
            .getCallbacks()
            .onError?.(
              'WhatsApp Web is connected but its event bridge never attached, so inbound messages would be ' +
                'lost. The saved session was kept — restart the session to relaunch the browser.',
            );
          return;
        }
        // A session restored from saved credentials never showed a QR, so nothing says those
        // credentials are bad: a stuck restore is far more often an incompatible WhatsApp Web build,
        // which a re-pair does not fix. Clearing them is not reversible, so keep them and fail loudly.
        if (!this.host.wasFreshPairing()) {
          this.host.logger.error(
            'WhatsApp Web restored the saved session but it never became ready within the readiness ' +
              'deadline; the session is marked failed and the saved credentials were kept.',
            undefined,
            { sessionId: this.host.config.sessionId, action: 'ready_reconcile_timeout_restored' },
          );
          this.clearReadyReconcile();
          this.host.setStatus(EngineStatus.FAILED);
          this.host
            .getCallbacks()
            .onError?.(
              'WhatsApp Web restored the saved session but never became ready; the saved credentials were kept. ' +
                'Restart the session; to pair again, delete it (which clears the saved credentials) and create ' +
                'it anew. Pin WWEBJS_WEB_VERSION if it keeps recurring.',
            );
          return;
        }
        this.host.logger.warn(
          'Timed out waiting for WhatsApp Web runtime readiness after authentication — the saved session ' +
            'is stuck after the QR scan (usually the auto-selected WhatsApp Web build is incompatible). ' +
            'Clearing it to re-pair; pin a known-good version via WWEBJS_WEB_VERSION (see ' +
            'docs/12-troubleshooting-faq.md) if it keeps recurring.',
          // Name the session: on a multi-session host this warning is the only way to tell whether one
          // session timed out or every one of them did, and the two have very different causes.
          { sessionId: this.host.config.sessionId, action: 'ready_reconcile_timeout' },
        );
        this.clearReadyReconcile();
        // Self-heal: don't leave the session stuck at "authenticating" forever — clear the broken auth
        // and disconnect so the lifecycle re-pairs (a fresh QR) instead of hanging.
        void this.host.recoverFromStuckAuth();
        return;
      }

      // Schedule the next tick up front, independent of the probe, so a hung probe can never stall the
      // loop. The probe runs fire-and-forget with at-most-one in flight: if the previous one is still
      // pending (hung), skip this round — the loop keeps ticking and gives up at the deadline above.
      this.readyReconcileTimer = setTimeout(tick, READY_RECONCILE_INTERVAL_MS);
      this.readyReconcileTimer.unref?.();

      if (this.readyReconcileProbeInFlight) return;
      this.readyReconcileProbeInFlight = true;
      void this.isClientRuntimeReady()
        .then(ready => {
          if (ready && this.host.getClient() && this.host.getStatus() === EngineStatus.AUTHENTICATING) {
            this.host.logger.warn('WhatsApp Web ready event was missed; reconciling from connected runtime state');
            this.host.markReadyFromClientInfo();
          } else if (this.host.getStatus() === EngineStatus.AUTHENTICATING) {
            this.maybeReloadDeadBridge();
          }
        })
        .catch(error => this.host.logger.debug('Ready reconciliation probe failed', { error: String(error) }))
        .finally(() => {
          this.readyReconcileProbeInFlight = false;
        });
    };

    this.readyReconcileTimer = setTimeout(tick, READY_RECONCILE_INTERVAL_MS);
    this.readyReconcileTimer.unref?.();
  }

  clearReadyReconcile(): void {
    if (this.readyReconcileTimer) {
      clearTimeout(this.readyReconcileTimer);
      this.readyReconcileTimer = null;
    }
    this.readyReconcileStartedAt = 0;
    this.readyReconcileProbeInFlight = false;
    this.lastProbeStateConnected = false;
    this.readyReconcileReloadAttempted = false;
  }

  /** Live client handle — re-read per use like the adapter's own reads, never cached across awaits. */
  private client(): Client | null {
    return this.host.getClient();
  }

  private async isClientRuntimeReady(): Promise<boolean> {
    if (!this.client()) return false;
    const connected = (await this.client()!.getState()) === WAState.CONNECTED;
    this.lastProbeStateConnected = connected;
    if (!connected) return false;
    if (!this.client()?.info?.wid?.user) return false;

    // The patched whatsapp-web.js client (scripts/patch-wwebjs-ready-sync.js) reports whether
    // attachEventListeners resolved. `false` means the page->Node message bridge is dead even
    // though the page reports CONNECTED — promoting that session to READY masks the loss of every
    // inbound event (the live incident this exists for). `undefined` is an unpatched tree: keep
    // the legacy checks rather than refusing readiness a tree cannot ever signal.
    if ((this.client() as Client & { eventsAttached?: boolean })?.eventsAttached === false) return false;

    const page = (this.client() as unknown as { pupPage?: { evaluate: <T>(fn: () => T) => Promise<T> } }).pupPage;
    const hasWWebJS = await page?.evaluate(
      () => typeof (window as unknown as { WWebJS?: unknown }).WWebJS !== 'undefined',
    );
    return hasWWebJS === true;
  }

  /**
   * One-shot self-heal for a CONNECTED page whose event bridge never attached: reload the page.
   * whatsapp-web.js re-runs its injection on every `framenavigated`, and a fresh page walks the
   * whole auth->synced->attach pipeline again (with the level-check patch closing the missed-edge
   * race), so a reload is the cheapest full reinjection that keeps the saved session intact.
   */
  private maybeReloadDeadBridge(): void {
    if (this.readyReconcileReloadAttempted) return;
    const client = this.host.getClient();
    if (!client || !this.lastProbeStateConnected) return;
    if ((client as Client & { eventsAttached?: boolean }).eventsAttached !== false) return;
    // An attach still inside upstream's own budget is slow, not dead — navigating now would abort it.
    if (Date.now() - this.readyReconcileStartedAt < READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS) return;
    this.readyReconcileReloadAttempted = true;
    this.host.logger.warn(
      'WhatsApp Web is connected but its event bridge never attached; reloading the page to reinject',
      {
        sessionId: this.host.config.sessionId,
        action: 'event_bridge_reload',
      },
    );
    const page = (client as unknown as { pupPage?: { reload?: () => Promise<unknown> } }).pupPage;
    void page?.reload?.()?.catch((error: unknown) =>
      this.host.logger.warn('Event-bridge reload failed', {
        sessionId: this.host.config.sessionId,
        error: String(error),
      }),
    );
  }
}

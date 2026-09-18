import * as fs from 'fs';
import { type Client } from 'whatsapp-web.js';
import { type EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';
import { wwjsAuthDir } from '../auth-dir-paths';

/**
 * Stuck-auth detection and recovery extracted from WhatsAppWebJsAdapter: what to do when a session
 * authenticated but never reached runtime readiness, and the LocalAuth-profile removal both that
 * recovery and a WhatsApp-initiated unlink go through. The adapter keeps the methods as thin
 * forwarders and injects the host surface via closures, so the delegate never touches lifecycle
 * state directly.
 */
export interface WwebjsStuckAuthHost {
  readonly logger: ReturnType<typeof createLogger>;
  readonly config: WhatsAppWebJsConfig;
  getClient(): Client | null;
  setClient(client: Client | null): void;
  setStatus(status: EngineStatus): void;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
}

export class WwebjsStuckAuth {
  // Guards the stuck-auth self-heal so it runs at most once per engine: a re-paired session that still
  // can't reach readiness fails terminally instead of looping QR -> timeout -> clear forever.
  private recoveryAttempted = false;

  constructor(private readonly host: WwebjsStuckAuthHost) {}

  /**
   * Recover a session that authenticated but never reached runtime readiness (stale/incompatible auth
   * or a wedged page). Clear the broken LocalAuth and disconnect so the session lifecycle re-pairs (a
   * fresh QR) instead of hanging at "authenticating". Runs at most ONCE per reconnect episode: the
   * one-shot budget lives on the session (via the synchronous `claimStuckAuthRecovery` callback), so
   * an automatic reconnect that builds a fresh adapter cannot reset it and wipe LocalAuth every
   * generation. A re-paired session that still can't reach readiness fails terminally rather than looping.
   *
   * When the callback is ABSENT (standalone adapter use/test, no session lifecycle) the adapter falls
   * back to its own instance-local boolean so standalone behavior stays one-shot.
   */
  async recoverFromStuckAuth(): Promise<void> {
    // The one-shot budget is decided SYNCHRONOUSLY before any destructive I/O. The session-owned
    // callback is authoritative when present; the instance-local boolean is the standalone fallback.
    // Fail-closed: a callback that throws (or already-spent budget) makes this terminal WITHOUT
    // touching the auth dir, so a wedged claim path can never wipe the only copy of the credentials.
    const claim = this.host.getCallbacks().claimStuckAuthRecovery;
    let granted: boolean;
    if (claim) {
      try {
        granted = claim();
      } catch {
        granted = false;
      }
    } else {
      granted = !this.recoveryAttempted;
      this.recoveryAttempted = true;
    }
    if (!granted) {
      this.host.setStatus(EngineStatus.FAILED);
      this.host
        .getCallbacks()
        .onError?.(
          'WhatsApp Web could not reach readiness after re-pairing. Pin WWEBJS_WEB_VERSION to a known-good build and try again.',
        );
      return;
    }

    const client = this.host.getClient();
    this.host.setClient(null);
    // Clear auth + disconnect FIRST (the recovery path), then tear the wedged client down in the
    // background so a hung Chromium destroy can't block (or skip) the recovery.
    await this.clearLocalAuth();
    this.host.setStatus(EngineStatus.DISCONNECTED);
    // onDisconnected drives the lifecycle's reconnect, which re-creates the engine with no saved auth
    // → a fresh QR. (A no-op once the engine is superseded/torn down.)
    this.host.getCallbacks().onDisconnected?.('Saved session could not be restored; cleared for re-pairing');
    if (typeof client?.destroy === 'function') void client.destroy().catch(() => undefined);
  }

  /** Remove this session's LocalAuth directory so the next start re-pairs from a clean slate. */
  async clearLocalAuth(): Promise<void> {
    const dir = wwjsAuthDir(this.host.config.sessionDataPath, this.host.config.sessionId);
    await fs.promises
      // maxRetries mirrors LocalAuth's own default: on a WhatsApp-initiated unlink the library never
      // closes the browser, so Chromium is still rotating IndexedDB files while this walks the tree and
      // a bare rm reports ENOTEMPTY (#1072). Node's default is 0 retries, which is why the failure
      // surfaced here and never on the library's removal of the same directory.
      .rm(dir, { recursive: true, force: true, maxRetries: 4 })
      .then(() => {
        // #981: this is the only copy of the session's WhatsApp credentials, and removing it is not
        // recoverable — every later start finds an empty profile and can do nothing but show a QR. Say
        // so at the moment it happens: otherwise the sole trace is a session that silently stops
        // reconnecting, indistinguishable from a WhatsApp-side logout or an untouched profile.
        this.host.logger.warn(
          `Deleted this session's stored WhatsApp credentials at ${dir}. That was the only copy, so the ` +
            'next start cannot restore the link and comes back with a fresh QR to scan.',
          { sessionId: this.host.config.sessionId, dir, action: 'auth_cleared' },
        );
      })
      .catch((error: unknown) => {
        this.host.logger.warn(`Could not clear stale auth at ${dir}`, {
          sessionId: this.host.config.sessionId,
          dir,
          error: String(error),
        });
      });
  }
}

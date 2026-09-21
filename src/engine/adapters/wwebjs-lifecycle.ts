import * as qrcode from 'qrcode';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { Client, LocalAuth, WAState } from 'whatsapp-web.js';
import {
  type AccountRestriction,
  type EngineEventCallbacks,
  EngineStatus,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { type createLogger } from '../../common/services/logger.service';
import { MAX_TIMER_MS } from '../../config/configuration';
import { resolveWebVersionPin } from '../wa-web-version';
import { resolveAuthTimeoutMs, resolveEngineInitTimeoutMs } from '../engine-init-timeout';
import { killOrphanedChromiumProcesses, removeStaleSingletonFiles } from './chromium-profile-hygiene';
import { isSupportedProxyUrl, buildProxyLaunchConfig } from './wwebjs-proxy';
import { BACKPORT_MISSING_MESSAGE, isBackportMissing } from './wwebjs-backport-check';
import { unappliedPatches, unappliedPatchesMessage } from './engine-patch-status';
import { reportMissingCallHook } from './wwebjs-call-hook-check';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';
import { AUTH_FAILURE_REASON, STALE_PROFILE_ADVICE } from '../terminal-engine-failure';
import { wwjsAuthDir } from '../auth-dir-paths';

/**
 * Detect Puppeteer's "Execution context was destroyed" error. During `Client.inject()` this is most
 * often a persistent browser profile left stale by an OpenWA upgrade that changed the Chromium/Chrome
 * binary (e.g. the v0.8.12 amd64 Debian Chromium → Chrome for Testing switch, #663 / #708) — but it is
 * not exclusively that: Puppeteer also raises it on a page navigation or a renderer crash (see
 * puppeteer-core `ExecutionContext` / `IsolatedWorld`), so the caller advises rather than asserts.
 * Pure so the detection is unit-testable without mocking the whatsapp-web.js `Client`.
 */
export function isExecutionContextDestroyedError(reason: string): boolean {
  return /execution context was destroyed/i.test(reason);
}

/**
 * A first-inject rejection that reads as "the page navigated out from under the in-flight evaluate":
 * the exec-context class above plus the 'window.require is not a function' variant (an evaluate
 * landing on a document whose WA bundle has not booted yet). Deliberately SEPARATE from the
 * stale-profile advisory classifier: the advisory names a remedy (delete the profile) that is wrong
 * for the window.require shape (see src/config/process-error-monitor.ts) — this predicate only
 * decides whether one in-place retry is worth it, both shapes being transient when a reload caused
 * them. whatsapp-web.js registers its own re-inject handler only AFTER the first inject succeeds
 * (Client.js:502 vs :504), so a navigation landing during it is caught by nothing upstream (#1081).
 */
function isNavigationShapedInitRejection(reason: string): boolean {
  return isExecutionContextDestroyedError(reason) || /window\.require is not a function/i.test(reason);
}

/**
 * requestPairingCode retry budget. WhatsApp Web reloads the QR page while UNPAIRED, so a pairing
 * request can land mid-navigation and either reject fast ("Execution context was destroyed") or hang
 * until Puppeteer's protocol timeout. Each attempt is bounded, and only the navigation/timeout shapes
 * are retried; four attempts across ~1 minute cover several reload cycles, the page reboots in 2-3s.
 */
export const PAIRING_CODE_MAX_ATTEMPTS = 4;
export const PAIRING_CODE_ATTEMPT_TIMEOUT_MS = 15_000;
export const PAIRING_CODE_RETRY_DELAY_MS = 3_000;

/** Sentinel for a per-attempt pairing timeout, so it is retried like a navigation error rather than propagated. */
class PairingCodeAttemptTimeoutError extends Error {
  constructor() {
    super('requestPairingCode attempt timed out');
    this.name = 'PairingCodeAttemptTimeoutError';
  }
}

// A post-READY page navigation (WhatsApp Web's ~5-minute first reload on a fresh pairing, a
// service-worker update, …) destroys the page's JS world; whatsapp-web.js re-injects on its own
// framenavigated handler (Client.js:504-513), but until WA Web has booted again getState() REJECTS,
// so the liveness probe reads a healing page as dead and every delegate evaluate dies as a raw
// TypeError under a status that still says READY (#1081). Sizing — floor: the pre-boot phase alone
// (page load + WA Web bundle boot, the stretch where getState() rejects) takes tens of seconds on a
// slow host, and upstream's re-inject then polls up to 30s for window.WWebJS (Client.js:332-343);
// ceiling: one watchdog interval (60s), so a page that navigates and then wedges loses at most one
// probe to the grace and still dies within one extra interval. NOT a sibling of
// READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS above: that one is capped by the 90s reconcile deadline,
// this one by keeping the watchdog's safety net alive — do not "harmonize" them.
export const NAVIGATION_REINJECT_GRACE_MS = 60_000;

// Hard bound per recovery episode (first navigation → the next completed re-inject): a page stuck in
// a navigation loop re-stamps the rolling grace faster than it expires, which would suppress the
// watchdog forever and leave a zombie session READY that only ever answers 409. Past this cap the
// probe reports the truth again and the watchdog takes over.
export const NAVIGATION_EPISODE_CAP_MS = 3 * NAVIGATION_REINJECT_GRACE_MS;

// The single in-adapter retry of a navigation-killed first inject only runs while at least this much
// of the lifecycle's outer init deadline remains — a retry the outer race SIGKILLs mid-launch would
// surface as a bare 504 with no reason. Below it, fail with today's exact terminal shape instead.
const INIT_RETRY_MIN_REMAINING_MS = 20_000;

// WhatsApp Web states that mean WhatsApp has judged the account or its egress, mapped to the neutral
// restriction kinds. This is the ONLY channel the library offers: there is no dedicated event, error
// type or cause code for account standing (whatsapp-web.js 1.34.7), just a `WAState` string on the
// `disconnected` event.
//
// Deliberately only three of the twelve states. UNPAIRED/UNPAIRED_IDLE and LOGOUT are unlinks,
// CONFLICT is another device taking over, DEPRECATED_VERSION is our own client being too old, and
// TIMEOUT is a fault — none is a statement about the account's standing, and reporting them as
// restrictions would be exactly the false positive that makes the signal worthless to act on.
const WA_STATE_RESTRICTIONS: Readonly<Record<string, AccountRestriction['kind']>> = {
  TOS_BLOCK: 'tos_block',
  SMB_TOS_BLOCK: 'tos_block',
  PROXYBLOCK: 'proxy_block',
};

/**
 * Host surface for {@link WwebjsLifecycle}. The adapter keeps the public engine methods as thin
 * forwarders and builds ONE object literal of these closures, so the delegate drives connection
 * state only through the seams named here: the sibling delegates it coordinates (reconcile,
 * onboarding watcher, call cache, stuck-auth) and the adapter-owned event surface.
 */
export interface WwebjsLifecycleHost {
  readonly logger: ReturnType<typeof createLogger>;
  readonly config: WhatsAppWebJsConfig;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
  /** Re-emit a status transition on the adapter's EventEmitter (`stateChanged`). */
  emitState(status: EngineStatus): void;
  /** Arm / disarm the post-authentication readiness reconciliation (./wwebjs-reconcile). */
  scheduleReadyReconcile(): void;
  clearReadyReconcile(): void;
  /** Arm / disarm the onboarding-modal watcher (./wwebjs-onboarding). */
  startOnboardingWatcher(): void;
  clearOnboardingWatcher(): void;
  /** Drop every cached ringing call id: the client that saw those calls is going away. */
  clearLiveCalls(): void;
  /** Stand-in promise for the LocalAuth profile removal (./wwebjs-stuck-auth), routed through the
   *  adapter's own method so an instance-level replacement stays authoritative. */
  clearLocalAuth(): Promise<void>;
  /** Register the domain client events (messages, groups, calls) on a freshly built client. */
  attachDomainEvents(client: Client): void;
}

/**
 * Connection lifecycle extracted from WhatsAppWebJsAdapter: the initialize launch (with its single
 * navigation-killed retry), the client-event wiring for connection state, puppeteer death detection,
 * teardown in its four flavors, the liveness probe, and the state behind them. The adapter keeps the
 * public IWhatsAppEngine members as thin forwarders and injects the host surface via closures, so
 * the delegate never touches adapter state beyond the seams the host names.
 *
 * The state fields below are public where the adapter aliases them by reference (host closures and
 * an unmodified spec poking `adapter.client` / `adapter.status` / … through a cast keep working
 * byte-identically — the same aliasing BaileysAdapter does for `sock`); the rest stay private.
 */
export class WwebjsLifecycle {
  /** Live whatsapp-web.js client, null once torn down. Aliased by the adapter's `client` accessor. */
  client: Client | null = null;
  /** Current engine status. Aliased by the adapter's `status` accessor. */
  status: EngineStatus = EngineStatus.DISCONNECTED;
  /** Last encoded QR, cleared on authentication. Aliased by the adapter's `qrCode` accessor. */
  qrCode: string | null = null;
  /** Own-account phone number, read once at readiness. */
  private phoneNumber: string | null = null;
  /** Own-account push name, read once at readiness. */
  private pushName: string | null = null;
  /** Set once teardown begins so a late 'authenticated' can't resurrect a disconnecting adapter. Not
   *  reset — an adapter is single-use after teardown (the session creates a fresh one to reconnect).
   *  Aliased by the adapter's `tearingDown` accessor. */
  tearingDown = false;
  /** Set by logout() before it starts the native unlink, which itself registers the real
   *  `client.logout()` promise as the credential teardown. The 'disconnected' LOGOUT handler consults
   *  this to avoid registering a second, redundant stand-in for the same profile rm — while still
   *  registering one for a WhatsApp-initiated logout, including one that lands after another teardown
   *  path has already latched the flags below. Aliased by the adapter's `logoutInitiated` accessor. */
  logoutInitiated = false;
  /** Set once a WhatsApp-initiated LOGOUT has started this session's credential removal, so a repeat of
   *  the same unlink cannot start a second one (#1072). Never reset — an adapter is single-use, and the
   *  profile is gone after the first removal either way. */
  private credentialTeardownStarted = false;
  /** Set once the adapter ACTIVELY transitions to DISCONNECTED (engine disconnect, puppeteer death,
   *  stuck-auth recovery, teardown). Same single-use contract as `tearingDown`, but it latches earlier:
   *  on LOGOUT whatsapp-web.js keeps the browser and re-runs inject(), while the lifecycle only replaces
   *  the engine after the reconnect backoff — so for those seconds the old client can still emit a QR or
   *  re-authenticate, and neither belongs to the session any more (#982). Aliased by the adapter's
   *  `disconnectReported` accessor. */
  disconnectReported = false;
  // Navigation re-inject window (#1081): stamped by our framenavigated listener, closed by the
  // library's re-emitted 'ready' and by teardown. Timestamps, never timers — several suites pin
  // exact jest timer counts, and a timer would also outlive the single-use adapter.
  private lastMainFrameNavigationAt = 0;
  private navigationEpisodeStartedAt = 0;

  constructor(private readonly host: WwebjsLifecycleHost) {}

  async initialize(): Promise<void> {
    this.setStatus(EngineStatus.INITIALIZING);
    const initStartedAt = Date.now();

    // An install that skipped the message-id backport fails later with errors that name no cause
    // (#889) — say so here instead, while the operator is still looking at the startup logs.
    if (isBackportMissing()) {
      this.host.logger.error(BACKPORT_MISSING_MESSAGE);
    }

    // The other seven whatsapp-web.js patchers fail the same way and were equally silent about it.
    const unapplied = unappliedPatches('wwebjs');
    if (unapplied.length) {
      this.host.logger.error(unappliedPatchesMessage('wwebjs', unapplied));
    }

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.host.config.puppeteer?.args
        ? [...this.host.config.puppeteer.args]
        : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
          ];

      // Add proxy configuration if provided — but only when the URL parses to a supported scheme, so
      // a malformed/stored proxy value can't break the Chromium launch or smuggle a non-proxy scheme.
      let proxyAuthentication: { username: string; password: string } | undefined;
      if (this.host.config.proxy) {
        if (isSupportedProxyUrl(this.host.config.proxy.url)) {
          // Chromium ignores credentials in --proxy-server; pass a credential-less server and hand the
          // username/password to wwjs's proxyAuthentication (page.authenticate) for HTTP/HTTPS proxies (#628).
          const proxyLaunch = buildProxyLaunchConfig(this.host.config.proxy.url);
          puppeteerArgs.push(`--proxy-server=${proxyLaunch.serverArg}`);
          proxyAuthentication = proxyLaunch.proxyAuthentication;
          if (proxyLaunch.socksAuthUnsupported) {
            this.host.logger.warn(
              `Proxy for session ${this.host.config.sessionId} has credentials on a SOCKS proxy, but Chromium ` +
                `cannot authenticate SOCKS proxies. Use an IP-authorized proxy or an HTTP/HTTPS proxy instead.`,
            );
          }
          this.host.logger.log(`Using proxy: ${proxyLaunch.serverArg}`);
        } else {
          this.host.logger.warn(`Ignoring invalid proxy URL for session ${this.host.config.sessionId}`);
        }
      }

      // Marker arg: Chromium silently ignores unknown flags, so this exists purely as a label that
      // lets killOrphanedChromiumProcesses() identify this session's browser processes in `ps`
      // output later (after a hard kill of the OpenWA process orphaned them).
      puppeteerArgs.push(`--openwa-session=${this.host.config.sessionId}`);

      // Pin the WA-Web version (fixes the 1.34.x "stuck at authenticating" hang on some setups,
      // #251/#488). DEFAULT: auto-resolve a settled build from the wa-version registry and pin its
      // remote HTML (no integrity check — resolveWebVersionPin logs a loud warning); only
      // WWEBJS_WEB_VERSION=off leaves whatsapp-web.js to use the first-party build from WhatsApp.
      const versionPin = await resolveWebVersionPin();
      if (this.tearingDown) {
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }
      if (versionPin) {
        this.host.logger.log(`Pinning WhatsApp Web version ${versionPin.webVersion}`);
      }

      // Extend the first-boot init wait on slow setups (WSL2/low-resource), #353. Opt-in:
      // unset keeps whatsapp-web.js's 30000ms default.
      const authTimeoutMs = resolveAuthTimeoutMs();
      if (authTimeoutMs) {
        this.host.logger.log(`Using auth timeout ${authTimeoutMs}ms`);
      }

      // One retry for a navigation-killed first inject (#1081): a WhatsApp Web reload landing
      // mid-inject rejects initialize() with nothing upstream ever retrying (see
      // isNavigationShapedInitRejection): on a start() the onError channel below is terminal, and a
      // service-level reconnect still lands this shape in FAILED since it carries the stale-profile advice.
      // Structurally a single second try — skipped when the lifecycle's outer init race is nearly
      // spent (a retry the race SIGKILLs mid-launch would surface as a bare 504 with no reason), and
      // abandoned when attempt 1's browser cannot be destroyed (see resetForInitRetry).
      try {
        await this.runInitAttempt(puppeteerArgs, authTimeoutMs, proxyAuthentication, versionPin);
      } catch (attemptError) {
        const attemptReason = attemptError instanceof Error ? attemptError.message : String(attemptError);
        const budgetLeftMs = resolveEngineInitTimeoutMs() - (Date.now() - initStartedAt);
        if (
          this.tearingDown ||
          !isNavigationShapedInitRejection(attemptReason) ||
          budgetLeftMs < INIT_RETRY_MIN_REMAINING_MS
        ) {
          throw attemptError;
        }
        this.host.logger.warn(
          `"${attemptReason}" killed the first inject — a page navigation landed before ` +
            `whatsapp-web.js installed its re-inject handler. Retrying the launch once (#1081).`,
          { sessionId: this.host.config.sessionId, action: 'init_navigation_retry' },
        );
        const cleaned = await this.resetForInitRetry();
        if (this.tearingDown) {
          this.setStatus(EngineStatus.DISCONNECTED);
          return;
        }
        if (!cleaned) {
          this.host.logger.warn(
            "Attempt 1's browser did not die within the destroy bound — abandoning the retry rather " +
              'than launching a second Chromium into the same profile',
            { sessionId: this.host.config.sessionId, action: 'init_navigation_retry_abandoned' },
          );
          throw attemptError;
        }
        await this.runInitAttempt(puppeteerArgs, authTimeoutMs, proxyAuthentication, versionPin);
      }
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      const reason = error instanceof Error ? error.message : String(error);
      // What the dashboard renders as `lastError` is exactly this string and nothing else — the log
      // below never reaches it. Carry a one-line remedy with the reason for the one failure we can
      // actually advise on, so the session card stops being a dead end (#1081).
      let surfacedReason = reason;
      if (isExecutionContextDestroyedError(reason)) {
        // #708: Puppeteer's "Execution context was destroyed" during inject reads like a Puppeteer bug.
        // During initialize() its dominant cause is a browser profile left stale by an upgrade that
        // changed the Chromium/Chrome binary (e.g. v0.8.12 amd64: Debian Chromium → Chrome for Testing,
        // #663) — but it can also follow a page navigation or a renderer crash, so advise, don't assert.
        // The profile dir is the same one clearLocalAuth() removes on a clean re-pair. Safe to compute
        // here: sessionDataPath is a required config field already resolved in the try block above, so
        // this can't throw and mask the original error we are about to rethrow.
        this.host.logger.warn(
          `"${reason}" during initialize. If this followed an OpenWA upgrade that changed the ` +
            `Chromium/Chrome binary (v0.8.12 amd64 switched Debian Chromium → Chrome for Testing), the ` +
            `session's browser profile is likely stale — delete the profile dir ` +
            `"${wwjsAuthDir(this.host.config.sessionDataPath, this.host.config.sessionId)}" ` +
            `and start again to re-scan. If no upgrade happened, Puppeteer also raises this on a page ` +
            `navigation or renderer crash (check for memory pressure or a WhatsApp Web reload). ` +
            `See docs/12-troubleshooting-faq.md.`,
        );
        // Kept short and with the raw Puppeteer text FIRST: operators search on that string, and the
        // dashboard truncates a long reason. The profile path stays in the log above — it is too long
        // for a card, and naming the wrong remedy is worse than pointing at the FAQ, since deleting a
        // profile forces an irreversible re-pair.
        surfacedReason =
          `${reason} ${STALE_PROFILE_ADVICE} If this followed an ` +
          `upgrade, the session's browser profile is likely stale — see docs/12-troubleshooting-faq.md.`;
      }
      this.host.getCallbacks().onError?.(surfacedReason);
      throw error;
    }
  }

  /**
   * One construction+launch attempt: everything from `new Client(...)` through the puppeteer death
   * listeners. Extracted so the navigation retry (#1081) repeats the FULL sequence — a second
   * attempt without setupEventHandlers() would have no qr/authenticated/ready handlers at all, and
   * without the pre-launch sweeps it would trip over attempt 1's stale Singleton files. A LIVE
   * attempt-1 browser never reaches attempt 2: resetForInitRetry() abandons the retry instead.
   */
  private async runInitAttempt(
    puppeteerArgs: string[],
    authTimeoutMs: number | undefined,
    proxyAuthentication: { username: string; password: string } | undefined,
    versionPin: Awaited<ReturnType<typeof resolveWebVersionPin>>,
  ): Promise<void> {
    // Range-checked at the sink, not only in configuration.ts: a plugin config written through
    // `PUT /api/plugins/whatsapp-web.js/config` is validated as an object and merged over the env
    // blob at every boot, so it can carry a value the config layer never saw. Both bounds are
    // load-bearing. `common/CallbackRegistry.js` arms the timer under `if (timeout)`, so 0 arms
    // none and a wedged renderer holds the command, and the request behind it, indefinitely; above
    // MAX_TIMER_MS Node's timer overflows and fires after 1 ms, so the browser never launches.
    const configuredProtocolTimeout = this.host.config.puppeteer?.protocolTimeoutMs;
    const protocolTimeout =
      typeof configuredProtocolTimeout === 'number' &&
      configuredProtocolTimeout > 0 &&
      configuredProtocolTimeout <= MAX_TIMER_MS
        ? configuredProtocolTimeout
        : undefined;
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.host.config.sessionId,
        dataPath: path.resolve(this.host.config.sessionDataPath),
      }),
      puppeteer: {
        headless: this.host.config.puppeteer?.headless ?? true,
        args: puppeteerArgs,
        // Do NOT let Puppeteer install its own process signal handlers. By default it handles
        // SIGINT (→ synchronous process.exit(130), which would skip the graceful drain entirely)
        // and SIGTERM/SIGHUP (→ kills Chromium at signal time, defeating the drain window). We own
        // signal handling in main.ts. Puppeteer's unconditional `exit` hook still SIGKILLs this
        // browser when the process actually exits, so nothing is orphaned.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        // Only override the executable when explicitly configured; otherwise let
        // whatsapp-web.js fall back to Puppeteer's bundled Chromium.
        ...(this.host.config.puppeteer?.executablePath
          ? { executablePath: this.host.config.puppeteer.executablePath }
          : {}),
        // Per-CDP-command budget, spread only when the host configured a usable one (see above).
        // Absent, puppeteer-core nullish-coalesces to its own 180 000 ms (`cdp/Connection.js`).
        ...(protocolTimeout !== undefined ? { protocolTimeout } : {}),
      },
      ...(authTimeoutMs !== undefined ? { authTimeoutMs } : {}),
      ...(proxyAuthentication ? { proxyAuthentication } : {}),
      ...(versionPin ?? {}),
    });
    this.client = client;

    this.setupEventHandlers();
    if (this.tearingDown) {
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
      return;
    }
    // Kill any Chromium that survived a hard kill of a previous OpenWA process lifetime (its
    // Puppeteer exit hook never ran, leaving an orphaned browser holding the profile). Safe here:
    // this runs before this attempt's browser exists, so the only thing it can kill is an orphan —
    // including attempt 1's browser when the bounded inter-attempt destroy did not finish it.
    await killOrphanedChromiumProcesses(this.host.config.sessionId, this.host.logger);
    // Clear stale Chromium Singleton* files left by a hard kill before launching — see
    // removeStaleSingletonFiles. This runs after the orphan kill above and before this attempt's
    // browser exists, so it cannot pull the files out from under a running Chromium.
    await removeStaleSingletonFiles(this.host.config.sessionId, this.host.config.sessionDataPath, this.host.logger);
    await client.initialize();
    // whatsapp-web.js 1.34.x never observes the Chromium process/page it drives, so a crashed
    // browser leaves the client looking READY forever ("silent death"). Attach death listeners
    // to the puppeteer handles so a dead browser surfaces as a normal disconnect → reconnect.
    this.attachPuppeteerLifecycleListeners();
  }

  /**
   * Reset between a failed first init attempt and its single retry (#1081). Deliberately NOT
   * beginClientTeardown(): that would latch tearingDown (the adapter is single-use after teardown)
   * and write DISCONNECTED, whose disconnectReported latch permanently drops the retry's
   * qr/authenticated events. The reconcile clear matters most: the patched hasSynced level-check can
   * fire AUTHENTICATED before the navigation-killed evaluate rejects initialize(), leaving attempt
   * 1's 90s deadline live — its non-bridge branch deletes credentials (recoverFromStuckAuth), which
   * must never run underneath a retry that is about to succeed.
   *
   * Returns false when attempt 1's browser could not be destroyed within the bound — the caller
   * must then abandon the retry: launching a second Chromium into the same LocalAuth profile risks
   * corrupting the only credential copy (an irreversible re-pair), and the marker-based orphan
   * sweep is explicitly best-effort, so it cannot be trusted as the escalation for a LIVE browser.
   */
  private async resetForInitRetry(): Promise<boolean> {
    const failed = this.client;
    this.client = null;
    this.host.clearReadyReconcile();
    this.qrCode = null;
    this.setStatus(EngineStatus.INITIALIZING);
    if (!failed) return true;
    // The old client may still emit late events from persisted page bindings; 'authenticated' and
    // 'ready' have no source-client identity fence, so silence it before the new attempt starts.
    failed.removeAllListeners();
    // Bounded DIRECT destroy — never this.destroy()/forceDestroy(), both of which latch the
    // teardown flags above.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        failed.destroy(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('init-retry destroy timed out')), 5_000);
          timeout.unref?.();
        }),
      ]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.logger.warn('Destroying the failed first init attempt did not complete cleanly', {
        error: message,
      });
      // A FAST rejection means the browser was already gone (destroy found nothing live to close) —
      // safe to relaunch. A TIMEOUT means a live, wedged Chromium still holds the profile.
      return message !== 'init-retry destroy timed out';
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      // A 'qr' buffered by a wedged page can flush during the awaited client.destroy(), after
      // recoverFromStuckAuth() nulls this.client, or from a client that whatsapp-web.js re-injected
      // after a LOGOUT (#982) — in the last case the browser is still alive and will keep serving QRs
      // until the lifecycle replaces the engine. Ignore all of them so a late event can't resurrect a
      // finished adapter to QR_READY and publish a QR that links a phantom device. Mirrors the
      // 'authenticated' guard below; the normal first QR is unaffected (initialize() moves the status to
      // INITIALIZING before any client exists, so the latch is still clear).
      if (this.tearingDown || this.disconnectReported || this.status === EngineStatus.FAILED || !this.client) {
        return;
      }
      // Capture the source client so the post-await fence can prove THIS client is still the live one.
      // qrcode.toDataURL() is an awaited macrotask: a 'disconnected' (or a teardown nulling this.client)
      // that lands during the encode leaves the pre-await guard stale. Encode to a LOCAL so the stored
      // qrCode is only touched once the fence re-proves the source client and the finished flags.
      const sourceClient = this.client;
      try {
        const encodedQr = await qrcode.toDataURL(qr);
        // Post-await fence: the encode resolved, but the source client may have disconnected or been
        // replaced while we were waiting. Re-check the live client identity and the finished flags before
        // assigning state, publishing a QR, or driving any downstream callback/webhook — a late encode for
        // a dead/finished adapter must be dropped, not resurrected. The status is read through getStatus()
        // (not `this.status`) so the pre-await guard's narrowing does not elide this comparison:
        // setStatus(FAILED) can run on another tick during the await.
        if (
          this.client !== sourceClient ||
          this.tearingDown ||
          this.disconnectReported ||
          this.getStatus() === EngineStatus.FAILED
        ) {
          return;
        }
        this.qrCode = encodedQr;
        this.setStatus(EngineStatus.QR_READY);
        this.host.getCallbacks().onQRCode?.(this.qrCode);
      } catch (error) {
        this.host.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      // Only the first authentication starts the reconcile window. Ignore a re-fired 'authenticated'
      // while already AUTHENTICATING (so it can't restart the 90s deadline), once READY/FAILED, or any
      // time after the adapter is finished — teardown, or a reported disconnect the lifecycle has not
      // replaced the engine for yet (#982). The initial status is DISCONNECTED too, so "finished" is
      // carried by the flags, never by the status alone.
      if (
        this.tearingDown ||
        this.disconnectReported ||
        this.status === EngineStatus.AUTHENTICATING ||
        this.status === EngineStatus.READY ||
        this.status === EngineStatus.FAILED
      ) {
        return;
      }
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.qrCode = null;
      this.host.scheduleReadyReconcile();
    });

    this.client.on('ready', () => {
      // The library re-emits 'ready' at the end of EVERY completed (re)inject pipeline — for a
      // post-navigation re-inject this is the completion edge, and the only one it offers. Close the
      // navigation window HERE, before the guards below: markReadyFromClientInfo early-returns while
      // already READY, so a clear behind it would never run for the re-inject case (#1081).
      this.clearNavigationReinjectWindow();
      // whatsapp-web.js can emit `ready` BEFORE its message listeners are attached: its post-auth
      // callback runs once per hasSynced trigger, and any run that finds `window.WWebJS` already
      // defined skips the attach and bare-emits `ready` — including while the first run's attach is
      // still in flight (observed live). Promoting on that premature emit binds READY to a session
      // whose inbound bridge may never come up. The patched client's `eventsAttached` flag
      // (scripts/patch-wwebjs-ready-sync.js) distinguishes the cases: `false` → ignore this emit
      // and let the attach's own completion re-emit `ready` (it always does), with the readiness
      // reconciliation as the backstop when the attach failed instead. `undefined` (unpatched
      // tree) keeps the legacy behaviour.
      if ((this.client as Client & { eventsAttached?: boolean }).eventsAttached === false) {
        this.host.logger.warn('Ignoring premature ready: the message event bridge is not attached yet', {
          sessionId: this.host.config.sessionId,
          action: 'premature_ready_ignored',
        });
        return;
      }
      this.markReadyFromClientInfo();
    });

    // Message/group/call domain events: registered through the adapter's attachDomainEvents seam,
    // which wires ./wwebjs-message-events, ./wwebjs-group-events and the call-cache delegate.
    this.host.attachDomainEvents(this.client);

    this.client.on('disconnected', reason => {
      // A LOGOUT means whatsapp-web.js is ABOUT to delete this session's profile. The only site that
      // emits this reason is the `framenavigated` listener, which emits and THEN awaits
      // `authStrategy.logout()` → `LocalAuth.logout()` → `fs.rm(userDataDir)` — with the browser still
      // open (only the explicit `Client.logout()` closes it first, and that path emits nothing). That
      // rm happens whatever this listener does, so it MUST be surfaced to the lifecycle before the
      // latch check below can drop out — otherwise a stop()/destroy() that latched first hides an
      // in-flight rm, the name fence sees nothing pending, and a later start() under the same name can
      // have its freshly written profile deleted by it (the #994 hazard, through a narrower window).
      //
      // Skipped when THIS adapter's logout() started it: that path already registered the real
      // `client.logout()` promise, which covers the same rm and settles no earlier. Skipped again on
      // every repeat, because the listener above carries no guard of its own — it resets its
      // `lastLoggedOut` flag only after three awaits and never checks for the main frame, so one unlink
      // can raise this event more than once (#1072). Sitting above the duplicate-event latch is what
      // makes that reachable, so the guard has to be its own one-shot rather than that latch.
      if (reason === 'LOGOUT' && !this.logoutInitiated && !this.credentialTeardownStarted) {
        this.credentialTeardownStarted = true;
        // Idempotent stand-in for the library's own rm, which we cannot get a handle on:
        // `fs.rm(force: true)` races it safely and gives the lifecycle something to await.
        this.host.getCallbacks().onCredentialTeardownStarted?.(this.host.clearLocalAuth());
      }
      // A deliberate teardown (logout/disconnect/destroy/forceDestroy via beginClientTeardown) also
      // raises this event: client.logout() triggers the in-page Cmd 'logout' → framenavigated →
      // DISCONNECTED 'LOGOUT' while we are still awaiting it. The unlink is already acknowledged by
      // the API response and the session service writes DISCONNECTED itself, so report nothing here
      // (mirrors the puppeteer-death gate). A WhatsApp-initiated unlink arrives with
      // tearingDown=false and still flows through to the status/callback below.
      //
      // setStatus(DISCONNECTED) below latches disconnectReported synchronously on the first event, so a
      // duplicate native 'disconnected' (whatsapp-web.js can fire it more than once for one drop) must
      // no-op HERE — before log/status/callback — otherwise clearReadyReconcile(), setStatus, and
      // onDisconnected re-run and the lifecycle schedules a second reconnect.
      if (this.tearingDown || this.disconnectReported) return;
      this.host.clearReadyReconcile();
      // #982: LOGOUT is not a transient drop. The lifecycle's reconnect cannot restore the link; it
      // can only come back with a fresh QR. Say that here rather than leaving the operator with an
      // opaque engine token that reads like any other drop.
      if (reason === 'LOGOUT') {
        this.host.logger.warn(
          'WhatsApp unlinked this device (LOGOUT). whatsapp-web.js is deleting the stored credentials ' +
            'for this session, so reconnecting cannot restore the link — the session comes back with a ' +
            'fresh QR and must be re-scanned. If this was not expected, check Linked devices on the phone.',
        );
      }
      this.setStatus(EngineStatus.DISCONNECTED);
      // Report the account judgement BEFORE the disconnect so a consumer reacting to the disconnect
      // already knows why it happened. Only the state token is passed through — the adapter draws no
      // conclusion about recoverability from it and leaves the reconnect decision exactly as it was.
      const restriction = WA_STATE_RESTRICTIONS[reason];
      if (restriction) {
        this.host.getCallbacks().onAccountRestriction?.({ kind: restriction, code: reason });
      }
      this.host.getCallbacks().onDisconnected?.(reason);
    });

    this.client.on('auth_failure', (message?: string) => {
      this.host.clearReadyReconcile();
      this.setStatus(EngineStatus.FAILED);
      // Authentication failure is terminal: the stored credentials are invalid and
      // reconnecting will not help — the operator must re-scan the QR code. Route it
      // through onError (FAILED, no reconnect) rather than onDisconnected (reconnect).
      this.host.getCallbacks().onError?.(message ? `${AUTH_FAILURE_REASON}: ${message}` : AUTH_FAILURE_REASON);
    });
  }

  /**
   * Attach to the loosely-typed whatsapp-web.js puppeteer handles (same cast pattern as
   * isClientRuntimeReady/forceDestroy). whatsapp-web.js itself never listens to these, so without
   * this a dead Chromium is invisible: browser process death, renderer crash ("Aw Snap"), and a
   * closed tab all mean the session is gone, no matter what status the client still reports.
   */
  attachPuppeteerLifecycleListeners(): void {
    if (!this.client) return;
    const { pupBrowser, pupPage } = this.client as unknown as {
      pupBrowser?: { on: (event: 'disconnected', cb: () => void) => void };
      pupPage?: {
        on: (event: 'error' | 'close' | 'framenavigated', cb: (frame?: { url?: () => string }) => void) => void;
        mainFrame?: () => unknown;
      };
    };
    pupBrowser?.on('disconnected', () => this.handlePuppeteerDeath('Browser process closed or crashed'));
    pupPage?.on('error', () => this.handlePuppeteerDeath('Page crashed'));
    pupPage?.on('close', () => this.handlePuppeteerDeath('Page closed'));
    // A page NAVIGATION fires none of the above: the page is healing, not dead — whatsapp-web.js
    // re-injects on its own framenavigated handler and re-emits 'ready' when done. Stamp the window
    // so probeLiveness and ensureReady treat it as alive-but-recovering (#1081). Never stamp the
    // LOGOUT navigation shapes (post_logout URL, or upstream's latched lastLoggedOut): there the
    // credential teardown driven by the DISCONNECTED('LOGOUT') event is the path that must win.
    pupPage?.on('framenavigated', frame => {
      try {
        // mainFrame is feature-detected: the spec harnesses' EventEmitter pages have no frames.
        if (typeof pupPage.mainFrame === 'function' && frame !== pupPage.mainFrame()) return;
        if (typeof frame?.url === 'function' && frame.url().includes('post_logout=1')) return;
      } catch {
        return; // the frame detached before this handler ran — nothing worth stamping
      }
      // lastLoggedOut is a runtime field the wwjs typings do not declare (same loose-cast pattern as
      // the pupBrowser/pupPage handles above).
      if ((this.client as unknown as { lastLoggedOut?: boolean } | null)?.lastLoggedOut) return;
      const now = Date.now();
      if (this.navigationEpisodeStartedAt === 0) this.navigationEpisodeStartedAt = now;
      this.lastMainFrameNavigationAt = now;
      // `graced: false` here means the episode cap already expired — the stamp is recorded but the
      // probe/ensureReady grace is NOT being granted, so the log must not claim it is.
      this.host.logger.warn('Page navigated; whatsapp-web.js is re-injecting', {
        sessionId: this.host.config.sessionId,
        action: 'page_navigation_reinject_window',
        graced: this.isInNavigationReinjectWindow(),
      });
    });
  }

  /**
   * Route a Chromium/page death (detected via the puppeteer handles) through the exact same path as
   * the client's own 'disconnected' event. A deliberate teardown also fires the browser's
   * 'disconnected', and a real crash usually fires page 'error' and browser 'disconnected' together
   * — so ignore calls during teardown or once the status already is DISCONNECTED/FAILED (first
   * signal wins, no double-report).
   */
  private handlePuppeteerDeath(reason: string): void {
    if (this.tearingDown || this.status === EngineStatus.DISCONNECTED || this.status === EngineStatus.FAILED) {
      return;
    }
    this.host.clearReadyReconcile();
    this.setStatus(EngineStatus.DISCONNECTED);
    this.host.getCallbacks().onDisconnected?.(reason);
  }

  /**
   * Error-message signatures of a dead page/transport: Puppeteer raises these when the browser
   * process, the renderer, or the CDP connection is gone (e.g. 'Protocol error: Target closed').
   */
  private static readonly PAGE_TRANSPORT_ERROR_PATTERN =
    /protocol error|target closed|targetclosederror|detached frame|session closed|connection closed/i;

  /**
   * A per-command CDP timeout is NOT a death: the renderer is merely slower than the budget, and
   * the next command may succeed. On Puppeteer 24.38.0 this message carries none of the signatures
   * above, so the guard changes no current behaviour — it pins the intent.
   *
   * Matched on the FULL puppeteer phrase, not a bare `timed out`: a broad exclusion would also
   * swallow a genuine death whose message happens to mention a timeout.
   */
  private static readonly PROTOCOL_TIMEOUT_PATTERN = /timed out\. increase the 'protocoltimeout'/i;

  /** Whether the error carries a dead page/transport signature (see PAGE_TRANSPORT_ERROR_PATTERN). */
  isPageTransportError(error: unknown): boolean {
    // An HttpException is never a dead page. It is an error THIS application constructed, and its
    // message carries caller-supplied text verbatim: MessageNotFoundError reads
    // `Message ${messageId} not found in chat ${chatId}`, and GroupNotFoundError, LabelNotFoundError
    // and ChannelNotFoundError have the same shape. Matching the pattern against
    // one of those hands the CALLER the classifier. A request naming a messageId of "Target closed"
    // made its own 404 read as a transport death: the session was torn down and reconnected, and the
    // caller got a 503. The reactions read needs no role at all, so the lowest-privilege key could
    // do it at will.
    //
    // Excluding the class loses no real signal. Puppeteer and whatsapp-web.js throw plain Errors,
    // and a page-side throw arrives as one too (puppeteer-core rebuilds it in cdp/utils.js
    // createEvaluationError). It also settles the nested case: an EngineTransportError arriving from
    // an inner catch was already reported where it was built, and handlePuppeteerDeath latches on
    // status, so re-reporting would be a no-op regardless.
    if (error instanceof HttpException) {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (WwebjsLifecycle.PROTOCOL_TIMEOUT_PATTERN.test(message)) {
      return false;
    }
    return WwebjsLifecycle.PAGE_TRANSPORT_ERROR_PATTERN.test(message);
  }

  /**
   * Report a failed client/page operation as a session death when the error matches
   * PAGE_TRANSPORT_ERROR_PATTERN. A wedged page can fire NO events while still reporting CONNECTED
   * (whatsapp-web.js #5728), so the watchdog takes minutes to notice — an operation failing with one
   * of these errors is a much earlier death signal. Detection
   * only: the error itself still propagates to the caller exactly as before, and
   * handlePuppeteerDeath's guard makes this safe during teardown and against double-reporting.
   */
  reportIfPageTransportError(error: unknown, context: string): void {
    if (!this.isPageTransportError(error)) {
      return;
    }
    // Inside the navigation re-inject window the same signatures ride a HEALING page: an in-flight
    // evaluate killed by the navigation keeps its 'Protocol error' prefix (puppeteer only rewrites
    // the shapes that END with a context-gone suffix), and a navigating page transiently detaches
    // frames. Reporting that as death would tear down the session whatsapp-web.js is about to
    // re-inject — faster than the watchdog the grace protects against (#1081). Log the match so the
    // theory stays falsifiable from field logs; the error still propagates to the caller, and a
    // REAL browser death still reports through the pupBrowser/pupPage death listeners untouched.
    if (this.isInNavigationReinjectWindow()) {
      this.host.logger.warn(
        `Page transport error during ${context} inside the navigation re-inject window — not a death`,
        {
          error: error instanceof Error ? error.message : String(error),
          action: 'page_transport_error_graced',
        },
      );
      return;
    }
    this.host.logger.warn(`Page transport error during ${context} — treating the session as dead`, {
      error: error instanceof Error ? error.message : String(error),
    });
    this.handlePuppeteerDeath(`Page transport error during ${context}`);
  }

  markReadyFromClientInfo(): void {
    if (
      [EngineStatus.READY, EngineStatus.DISCONNECTED, EngineStatus.FAILED, EngineStatus.ACTION_REQUIRED].includes(
        this.status,
      )
    )
      return;
    this.host.clearReadyReconcile();
    try {
      const info = this.client?.info;
      this.phoneNumber = info?.wid?.user || null;
      this.pushName = info?.pushname || null;
      this.setStatus(EngineStatus.READY);
      this.host.getCallbacks().onReady?.(this.phoneNumber || '', this.pushName || '');
    } catch (error) {
      this.host.logger.error('Error getting client info', String(error));
      this.setStatus(EngineStatus.READY);
      this.host.getCallbacks().onReady?.('', '');
    }
    // A freshly-linked account may show a "What's new" onboarding modal that, left unacknowledged,
    // gets the companion unlinked (~5m later → disconnected: LOGOUT, #982). Dismiss it best-effort
    // and fall back to ACTION_REQUIRED. Started after READY so a non-ready session never arms it.
    this.host.startOnboardingWatcher();
    // whatsapp-web.js patches the call collection only when the page's module for it exposes an
    // `.on` function. A WhatsApp Web build that keeps the module but drops that method skips the
    // hook while the rest of the evaluate completes, so the session looks healthy, keeps delivering
    // messages, and reports no call at all. That quiet case is the one worth a line in the log; a
    // build that removes the module instead makes the library's own require throw, aborting the
    // evaluate and taking the inbound message bridge with it, which is loud on its own. Warn once
    // per ready; nothing else changes, since only detection is lost. Fire-and-forget: a diagnostic
    // must never delay or fail the promotion to READY.
    //
    // Skipped on a tree missing the ready-sync patch: without it the session can reach READY while
    // that same evaluate is still running, so the probe would read a page whose hook simply has not
    // been installed YET and warn about a problem that does not exist. An unpatched tree already
    // reports itself at startup, which is the honest signal there.
    if (!unappliedPatches('wwebjs').includes('patch-wwebjs-ready-sync')) {
      void reportMissingCallHook(
        (this.client as unknown as { pupPage?: { evaluate: <T>(fn: () => T) => Promise<T> } } | null)?.pupPage,
        this.host.logger,
        this.host.config.sessionId,
      );
    }
  }

  /** The single status-transition funnel: latches disconnectReported, fires the callback, re-emits
   *  on the adapter's EventEmitter. Public because the sibling delegates (reconcile, stuck-auth,
   *  onboarding watcher) drive transitions through their host slices. */
  setStatus(status: EngineStatus): void {
    // Latch before anything observes the transition. The constructor's initial DISCONNECTED is a field
    // initializer and never reaches here, so this only ever fires on a real transition — startup is
    // unaffected while a finished adapter is marked finished for good.
    if (status === EngineStatus.DISCONNECTED) {
      this.disconnectReported = true;
    }
    // The cached QR belongs to the page that produced it, so it dies with the QR_READY window. Same
    // funnel placement as the Baileys engine: only the 'authenticated' and init-retry exits cleared the
    // cache by hand, so a browser or page death, a failed init, an auth failure and teardown all left a
    // dead QR to be served over GET /qr for the whole reconnect backoff.
    if (status !== EngineStatus.QR_READY) {
      this.qrCode = null;
    }
    this.status = status;
    this.host.getCallbacks().onStateChanged?.(status);
    this.host.emitState(status);
  }

  private beginClientTeardown(): Client | null {
    this.tearingDown = true;
    // The cached ringing call ids belong to the client that is going away, so drop them all.
    this.host.clearLiveCalls();
    // Before the clientless early-return: a teardown must always close the navigation window, or a
    // stale stamp could grace the next generation's probe (single-use contract notwithstanding).
    this.clearNavigationReinjectWindow();
    const client = this.client;
    if (!client) return null;

    this.host.clearReadyReconcile();
    this.host.clearOnboardingWatcher();
    if (this.status !== EngineStatus.DISCONNECTED) {
      this.setStatus(EngineStatus.DISCONNECTED);
    }

    return client;
  }

  private finishClientTeardown(client: Client): void {
    if (this.client === client) {
      this.client = null;
    }
    this.host.clearReadyReconcile();
    this.host.clearOnboardingWatcher();
    this.clearNavigationReinjectWindow();
  }

  async disconnect(): Promise<void> {
    const client = this.beginClientTeardown();
    if (!client) return;

    try {
      // Use destroy instead of logout to preserve session data
      // This allows reconnecting without needing to scan QR again
      await client.destroy();
    } catch (error) {
      this.host.logger.warn('Destroy client failed:', { error: String(error) });
      // Already destroyed or not initialized - ignore
    } finally {
      this.finishClientTeardown(client);
    }
  }

  async logout(): Promise<void> {
    // Mark the credential removal as caller-owned before anything can emit 'disconnected'. The
    // lifecycle tracks this call's removal from the outside — SessionService passes the session name
    // to teardownEngineSafely, which registers the whole engine.logout() promise (a superset of the
    // in-page unlink AND the profile rm that follows it), and that is the single owner for BOTH
    // engines, since the Baileys adapter reports nothing here either. So this method must NOT
    // register a second, narrower promise for the same removal, and the 'disconnected' LOGOUT handler
    // must not add its stand-in on top. Set even with no live client: the throw path sends nothing,
    // so no event can arrive, and a caller-initiated logout is still what happened.
    this.logoutInitiated = true;
    const client = this.beginClientTeardown();
    // No live client means there is nothing to send the unlink through. Resolving here would report a
    // confirmed unlink for a request that never reached WhatsApp — the caller writes an audit row on
    // success, and the device would stay listed under the account holder's Linked Devices. The
    // session-level "is it started?" check cannot catch this: an engine stays registered while its
    // client is gone (a stuck-auth recovery nulls it, then waits out the reconnect backoff).
    if (!client) {
      throw new Error('No live WhatsApp Web client — the unlink was not sent');
    }

    try {
      // client.logout() chains authStrategy.logout() (LocalAuth) → fs.rm of this session's profile
      // dir. The lifecycle already tracks that removal through this method's own promise (see the
      // note above logoutInitiated), so nothing is registered here.
      await client.logout();
    } catch (error) {
      this.host.logger.warn('Logout failed:', { error: String(error) });
      // Fall back to destroy so the session still dies locally — but rethrow so the caller
      // learns the unlink never reached WhatsApp: the device may still be listed under the
      // account holder's Linked Devices, and reporting success would write a false audit row.
      try {
        await client.destroy();
      } catch (destroyError) {
        this.host.logger.warn('Client destroy also failed during logout fallback', { error: String(destroyError) });
      }
      throw error;
    } finally {
      this.finishClientTeardown(client);
    }
  }

  async destroy(): Promise<void> {
    const client = this.beginClientTeardown();
    if (!client) return;

    try {
      await client.destroy();
    } finally {
      this.finishClientTeardown(client);
    }
  }

  /**
   * Force-recover a wedged session: SIGKILL THIS client's own Chromium process directly (not a
   * process-wide `pkill`, which would also kill other sessions), then best-effort `client.destroy()`
   * for the rest of the cleanup. Both steps are wrapped so a missing process handle or a hung destroy
   * can't prevent the engine from being torn down and the status reset.
   */
  async forceDestroy(): Promise<void> {
    const client = this.beginClientTeardown();
    if (!client) return;

    try {
      // pupBrowser is the Puppeteer Browser; .process() is the Chromium ChildProcess (null if already gone).
      const proc = (
        client as unknown as { pupBrowser?: { process?: () => { kill?: (sig: string) => void } | null } }
      ).pupBrowser?.process?.();
      proc?.kill?.('SIGKILL');
    } catch (err) {
      this.host.logger.warn('forceDestroy: failed to kill the browser process', { error: String(err) });
    }

    try {
      await client.destroy();
    } catch (err) {
      this.host.logger.warn('forceDestroy: client.destroy() failed after the kill (continuing)', {
        error: String(err),
      });
    } finally {
      this.finishClientTeardown(client);
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  /**
   * Whether a recent main-frame navigation is still inside its bounded re-inject window. Two bounds:
   * the rolling per-navigation grace, and the per-episode cap that stops a navigation LOOP from
   * re-stamping its way past the watchdog forever. Consulted only AFTER the READY-status gates in
   * probeLiveness()/ensureReady() — a teardown or LOGOUT drops the status first, and the grace must
   * never outrank that (#1081).
   */
  isInNavigationReinjectWindow(): boolean {
    if (this.lastMainFrameNavigationAt === 0) return false;
    const now = Date.now();
    return (
      now - this.lastMainFrameNavigationAt < NAVIGATION_REINJECT_GRACE_MS &&
      now - this.navigationEpisodeStartedAt < NAVIGATION_EPISODE_CAP_MS
    );
  }

  private clearNavigationReinjectWindow(): void {
    this.lastMainFrameNavigationAt = 0;
    this.navigationEpisodeStartedAt = 0;
  }

  /**
   * Active liveness probe for the session watchdog: race a real getState() round-trip against a 10s
   * timeout. Probe failure or timeout means dead — a wedged page can keep reporting CONNECTED
   * (whatsapp-web.js #5728), so turning consecutive probe failures into a reconnect decision stays
   * the calling watchdog's job. One exception: inside the bounded navigation re-inject window a
   * failing probe answers alive, since the page is healing, not dead (#1081).
   */
  async probeLiveness(): Promise<boolean> {
    if (this.status !== EngineStatus.READY || !this.client) return false;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await Promise.race([
        this.client.getState(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('liveness probe timed out')), 10_000);
          timeout.unref?.();
        }),
      ]);
      if (state === WAState.CONNECTED) {
        // Observed recovery closes the navigation episode. Without this, an episode whose re-inject
        // died silently (no 'ready' re-emit, but WA Web's socket back up) would keep a stale episode
        // anchor forever, denying the grace to every LATER navigation via the episode cap.
        this.clearNavigationReinjectWindow();
        return true;
      }
      return this.isInNavigationReinjectWindow();
    } catch {
      // Inside the navigation window the evaluate rejecting (context destroyed, window.require not
      // yet a function) means the page is healing, not dead — answer alive so the watchdog does not
      // tear down a session whatsapp-web.js is about to re-inject (#1081). The window is bounded, so
      // a page that navigated and then wedged still dies within one extra watchdog interval.
      return this.isInNavigationReinjectWindow();
    } finally {
      // Never leave the timeout dangling when getState() settles first (Jest open-handle hygiene).
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Request an 8-char pairing code so the user can link via "Link with phone number" instead of
   * scanning the QR.
   *
   * Gated on QR_READY, not on the client merely existing. `this.client` is assigned before
   * `client.initialize()` (see runInitAttempt), so for the whole Chromium launch — seconds on a
   * modest host — a client is present while its `pupPage` is still null, and whatsapp-web.js's
   * requestPairingCode reaches `exposeFunctionIfAbsent(this.pupPage, …)` and throws a raw TypeError
   * that surfaces as a 500. QR_READY is the precise window this can work in anyway: the library
   * emits 'qr' only once the Store is injected and the in-page socket reports UNPAIRED, which are
   * the same preconditions the pairing flow needs.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.client || this.status !== EngineStatus.QR_READY) {
      throw new EngineNotReadyError('Session is not waiting to be linked. Start it and wait for the QR stage.');
    }
    // WhatsApp Web reloads the QR page while UNPAIRED (roughly every 20s). A requestPairingCode that
    // lands mid-navigation runs its in-page evaluate against a destroyed context: it either rejects
    // with "Execution context was destroyed" or hangs until Puppeteer's protocol timeout (minutes),
    // and the dashboard sits on "Creating pairing code..." with nothing ever returned. The navigation
    // is transient (the page reboots in a few seconds), so bound each attempt and retry only the
    // navigation/timeout shapes while the session is still at the QR stage. A real failure (an invalid
    // number, an already-linked account) is not navigation-shaped and propagates on the first attempt.
    let lastError: unknown;
    for (let attempt = 1; attempt <= PAIRING_CODE_MAX_ATTEMPTS; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.client.requestPairingCode(phoneNumber),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new PairingCodeAttemptTimeoutError()), PAIRING_CODE_ATTEMPT_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        lastError = error;
        const reason = error instanceof Error ? error.message : String(error);
        const transient =
          error instanceof PairingCodeAttemptTimeoutError ||
          isExecutionContextDestroyedError(reason) ||
          /callfunctionon timed out|timed out\. increase the 'protocoltimeout'/i.test(reason);
        if (!transient) {
          throw error;
        }
        if (attempt < PAIRING_CODE_MAX_ATTEMPTS) {
          // Nothing cancels the abandoned attempt, and nothing needs to. The library's own
          // requestPairingCode clears the in-page re-request interval as the first act of its
          // evaluate, so the next attempt stops the previous flow itself. Its `cancelPairingCode`
          // would on top of that return the page to QR mode, which is the opposite of what a retry
          // wants, and it is an unbounded page evaluate against the page that is already unwell, so
          // awaiting it would add a full Puppeteer protocol timeout to each gap. The abandoned flow
          // is not inert: each tick of its interval asks WhatsApp for a fresh code and notifies the
          // phone, and its CODE_RECEIVED event reaches nothing here. What bounds it is the page, not
          // us: the interval dies with the next WhatsApp Web reload, which happens every few seconds
          // while the session is UNPAIRED, and with the session itself.
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, PAIRING_CODE_RETRY_DELAY_MS);
            t.unref?.();
          });
          // The reboot may have ended the QR window (linked, or torn down). Do not retry a dead session.
          if (!this.client || this.status !== EngineStatus.QR_READY) {
            throw new EngineNotReadyError('Session is no longer waiting to be linked.');
          }
        }
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
    // Every attempt hit a transient navigation/timeout, so the budget ran out on the transport rather
    // than on anything the caller sent. Reported as EngineTransportError (503) so a caller reads it as
    // retryable: a plain Error here surfaced as a 500, which says the gateway is broken and that
    // retrying is pointless. The last attempt's reason rides along as the detail.
    throw new EngineTransportError(
      `Pairing code could not be generated after ${PAIRING_CODE_MAX_ATTEMPTS} attempts: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

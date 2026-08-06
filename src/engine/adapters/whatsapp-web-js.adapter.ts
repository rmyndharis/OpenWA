import { EventEmitter } from 'events';
import {
  Client,
  LocalAuth,
  MessageMedia,
  WAState,
  type Call,
  type GroupNotification,
  type Message,
} from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupMemberAddMode,
  ParticipantOperationResult,
  LocationInput,
  PollInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  StatusPostOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
  ChatSummary,
  ChatState,
  LabelInput,
  GroupEvent,
  CustomLinkPreview,
  GroupJoinInfo,
  IncomingCallEvent,
  AccountRestriction,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { resolveWebVersionPin } from '../wa-web-version';
import { resolveAuthTimeoutMs } from '../engine-init-timeout';
import { killOrphanedChromiumProcesses, removeStaleSingletonFiles } from './chromium-profile-hygiene';
import { isChannelJid } from '../identity/wa-id';
import { LidMappingStore } from '../identity/lid-mapping-store.service';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { ChannelMediaNotSupportedError } from '../../common/errors/channel-media-not-supported.error';
import { WwebjsGroups } from './wwebjs-groups';
import { type WwebjsEngineHost } from './wwebjs-host';
import { registerWwebjsMessageEvents } from './wwebjs-message-events';
import { WwebjsMessaging, declaredOnlyMedia } from './wwebjs-messaging';
import { WwebjsContacts } from './wwebjs-contacts';
import { WwebjsProfile } from './wwebjs-profile';
import { WwebjsLabels } from './wwebjs-labels';
import { WwebjsChannels } from './wwebjs-channels';
import { WwebjsStatus } from './wwebjs-status';
import { WwebjsChats } from './wwebjs-chats';
import { WwebjsCatalog } from './wwebjs-catalog';
import { isSupportedProxyUrl, buildProxyLaunchConfig } from './wwebjs-proxy';
import {
  probeOnboardingModal,
  resolveOnboardingContinueLabels,
  ONBOARDING_DEFAULT_CONTINUE_LABEL,
} from './wwebjs-onboarding';
import { wwebjsGroupUpdateChanges, wwebjsGroupRecipientIds } from './wwebjs-group-events';
import { BACKPORT_MISSING_MESSAGE, isBackportMissing } from './wwebjs-backport-check';
import {
  capInboundMedia,
  coerceDeclaredSize,
  inboundMediaConcurrency,
  inboundMediaMaxBytes,
  inboundMediaTimeoutMs,
  isMediaDownloadEnabled,
  withInboundDownloadTimeout,
} from './inbound-media-cap';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

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

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
    executablePath?: string;
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
  // Shared lid<->phone table. Threaded in so the wwjs engine can persist the `phone -> lid` pairs it
  // learns while resolving sends, letting the message read-path bridge `@c.us`/`@lid` rows (#583 R3).
  lidMappingStore?: LidMappingStore;
}

const READY_RECONCILE_INTERVAL_MS = 2000;
const READY_RECONCILE_TIMEOUT_MS = 90_000;

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

// Onboarding-modal watcher (#982). A freshly-linked account shows a "What's new on WhatsApp Web"
// modal with a Continue button that must be acknowledged, or WhatsApp unlinks the companion ~5m
// later (surfacing as disconnected: LOGOUT). whatsapp-web.js exposes no API for this (#3550 open),
// so the watcher reaches the page directly and clicks it best-effort. The modal is one-shot per
// account, so the watcher self-terminates after the lifetime cap rather than polling forever.
const ONBOARDING_MODAL_INTERVAL_MS = 5_000;
const ONBOARDING_MODAL_MAX_LIFETIME_MS = 5 * 60_000;
const ONBOARDING_MODAL_PROBE_TIMEOUT_MS = 5_000;
// Clicking Continue dismisses the modal, so one click is the normal case and the next tick finds
// nothing. Repeated clicks mean the click is not landing — the only evidence that actually justifies
// asking a human to intervene. Five, not three: a multi-step "What's new" flow is clicked through
// one screen per tick, and three screens inside one watcher run must not read as a stuck modal.
// Five failed clicks still trips in ~25s — far inside the lifetime cap and the ~5m unlink deadline.
const ONBOARDING_MODAL_MAX_DISMISS_CLICKS = 5;

// WhatsApp Web version resolution (the #488 auto-resolve) lives in a dependency-free module so infra
// status can import it without loading whatsapp-web.js (engine lazy-loading). The adapter imports
// resolveWebVersionPin above for use in initialize().

// resolveAuthTimeoutMs now lives in ../engine-init-timeout, next to the outer init deadline derived
// from it: that deadline is engine-agnostic, so deriving it here made the session lifecycle import
// this adapter just to size a timeout. Re-exported because callers still reach it through the engine
// they are configuring.
export { resolveAuthTimeoutMs };

// extractLinkedParentJID moved to ./wwebjs-groups with the group operations; re-exported because
// existing callers (the adapter spec) still import it from here.
export { extractLinkedParentJID } from './wwebjs-groups';

// Messaging helpers moved to ./wwebjs-messaging with the messaging operations; re-exported because
// existing callers (the adapter spec) still import them from here.
export { isHttpUrl, loadRemoteMedia, extractWwebjsCall, wwebjsAckToDeliveryStatus } from './wwebjs-messaging';

// Proxy launch helpers moved to ./wwebjs-proxy; re-exported because existing callers (the adapter
// spec) still import them from here.
export { isSupportedProxyUrl, buildProxyLaunchConfig } from './wwebjs-proxy';

// The onboarding-modal probe moved to ./wwebjs-onboarding with its label resolution; re-exported
// because existing callers (the adapter spec) still import it from here.
export { probeOnboardingModal } from './wwebjs-onboarding';

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private readyReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private readyReconcileStartedAt = 0;
  private readyReconcileProbeInFlight = false;
  // What the last reconcile probe observed, driving the bridge-dead self-heal and the deadline
  // decision (a CONNECTED session must never have its credentials wiped).
  private lastProbeStateConnected = false;
  private readyReconcileReloadAttempted = false;
  // Onboarding-modal watcher handle (#982). Self-rescheduling setTimeout so a hung probe can't stall
  // the loop; cleared on teardown exactly like readyReconcileTimer.
  private onboardingWatcherTimer: ReturnType<typeof setTimeout> | null = null;
  private onboardingWatcherStartedAt = 0;
  private onboardingWatcherStarted = false;
  // How many times we have clicked the modal's Continue button. Not reset by clearOnboardingWatcher:
  // it counts for the engine's lifetime, which is what makes "the click is not landing" detectable.
  private onboardingDismissClicks = 0;
  /** How long a received call's handle stays rejectable. Calls ring for roughly a minute, so
   *  two minutes covers the ringing window with margin without pinning dead calls for long. */
  private static readonly LIVE_CALL_TTL_MS = 2 * 60_000;
  /** Live incoming calls by call id. The wwebjs `Call` object is only usable while the call is
   *  live, so it must be cached at event time for a later rejectCall() to act on. */
  private readonly liveCalls = new Map<string, { call: Call; expiresAt: number }>();
  // Guards the stuck-auth self-heal so it runs at most once per engine: a re-paired session that still
  // can't reach readiness fails terminally instead of looping QR -> timeout -> clear forever.
  private stuckAuthRecoveryAttempted = false;
  // Set once teardown begins so a late 'authenticated' can't resurrect a disconnecting adapter. Not
  // reset — an adapter is single-use after teardown (the session creates a fresh one to reconnect).
  private tearingDown = false;
  // Set by logout() before it starts the native unlink, which itself registers the real
  // `client.logout()` promise as the credential teardown. The 'disconnected' LOGOUT handler consults
  // this to avoid registering a second, redundant stand-in for the same profile rm — while still
  // registering one for a WhatsApp-initiated logout, including one that lands after another teardown
  // path has already latched the flags below.
  private logoutInitiated = false;
  // Set once a WhatsApp-initiated LOGOUT has started this session's credential removal, so a repeat of
  // the same unlink cannot start a second one (#1072). Never reset — an adapter is single-use, and the
  // profile is gone after the first removal either way.
  private credentialTeardownStarted = false;
  // Set once the adapter ACTIVELY transitions to DISCONNECTED (engine disconnect, puppeteer death,
  // stuck-auth recovery, teardown). Same single-use contract as `tearingDown`, but it latches earlier:
  // on LOGOUT whatsapp-web.js keeps the browser and re-runs inject(), while the lifecycle only replaces
  // the engine after the reconnect backoff — so for those seconds the old client can still emit a QR or
  // re-authenticate, and neither belongs to the session any more (#982).
  private disconnectReported = false;

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
    // API-surface clusters live in ./wwebjs-* delegates; the public methods below forward to them.
    // The host is one object literal shared by every delegate, and closures (not a `this` reference)
    // keep the delegates' surface exactly this narrow. Built in the constructor, not as a field
    // initializer: `config` is a parameter property, which field initializers read before assignment.
    this.host = {
      ensureReady: () => this.ensureReady(),
      getClient: () => this.client!,
      logger: this.logger,
      isPageTransportError: error => this.isPageTransportError(error),
      reportIfPageTransportError: (error, context) => this.reportIfPageTransportError(error, context),
      ensureNotChannelRecipient: chatId => this.ensureNotChannelRecipient(chatId),
      getNumberId: number => this.getNumberId(number),
      capInboundMediaFor: (msg, maxBytesOverride) => this.capInboundMediaFor(msg, maxBytesOverride),
      config: this.config,
      getCallbacks: () => this.callbacks,
      getSelfWid: () => this.client?.info?.wid?._serialized,
    };
    this.groups = new WwebjsGroups(this.host);
    this.messaging = new WwebjsMessaging(this.host);
    this.contacts = new WwebjsContacts(this.host);
    this.profile = new WwebjsProfile(this.host);
    this.labels = new WwebjsLabels(this.host);
    this.channels = new WwebjsChannels(this.host);
    this.statuses = new WwebjsStatus(this.host);
    this.chats = new WwebjsChats(this.host, this.messaging);
    this.catalog = new WwebjsCatalog(this.host);
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');
  // Bound concurrent inbound media downloads: downloadMedia() materialises the full base64 blob, so an
  // unbounded burst could stack many multi-MB allocations.
  private readonly inboundLimiter = new ConcurrencyLimiter(
    inboundMediaConcurrency(),
    // Queue cap == active slots: beyond (active + queued) concurrent media messages, reject instead of
    // parking, so a burst can't grow heap without bound (each parked closure holds the message).
    inboundMediaConcurrency(),
  );

  private readonly host: WwebjsEngineHost;
  private readonly groups: WwebjsGroups;
  private readonly messaging: WwebjsMessaging;
  private readonly contacts: WwebjsContacts;
  private readonly profile: WwebjsProfile;
  private readonly labels: WwebjsLabels;
  private readonly channels: WwebjsChannels;
  private readonly statuses: WwebjsStatus;
  private readonly chats: WwebjsChats;
  private readonly catalog: WwebjsCatalog;

  /**
   * Download inbound media safely. downloadMedia() can't be size-bounded at the source, so (1) pre-gate
   * on the sender-declared size and skip the download entirely when it exceeds the cap, and (2) run the
   * download through the concurrency limiter for backpressure. Returns undefined when there's no media.
   */
  private async capInboundMediaFor(
    msg: Message,
    maxBytesOverride?: number,
  ): Promise<IncomingMessage['media'] | undefined> {
    if (!isMediaDownloadEnabled()) {
      return declaredOnlyMedia(msg);
    }
    const maxBytes = maxBytesOverride ?? inboundMediaMaxBytes();
    const data = (msg as unknown as { _data?: { size?: number; mimetype?: string; filename?: string } })._data;
    const declared = coerceDeclaredSize(data?.size);
    if (declared > maxBytes) {
      this.logger.warn('Inbound media declared size exceeds the cap; skipped download', {
        msgId: msg.id._serialized,
        sizeBytes: declared,
        maxBytes,
      });
      return declaredOnlyMedia(msg);
    }
    // msg.downloadMedia() can't be aborted, so freeing the slot the moment the wall-clock deadline fires
    // would admit a fresh download while the abandoned one is still materialising in heap — letting the
    // number of in-flight downloads exceed inboundMediaConcurrency(). Instead, HOLD the slot until the real
    // download settles; the caller still unblocks on the timeout race and emits the message without media.
    // boundedReady adopts the timeout-bounded race (a Promise resolving a Promise flattens), so awaiting it
    // unblocks the caller once the task is admitted AND the deadline-or-download settles — yielding the
    // media or null on timeout.
    let resolveBounded: (value: MessageMedia | null | PromiseLike<MessageMedia | null>) => void = () => undefined;
    const boundedReady = new Promise<MessageMedia | null>(resolve => {
      resolveBounded = resolve;
    });
    const slotHeld = this.inboundLimiter.run(() => {
      const download = msg.downloadMedia();
      resolveBounded(
        withInboundDownloadTimeout(download, inboundMediaTimeoutMs(), () =>
          this.logger.warn(
            'Inbound media download timed out (MEDIA_DOWNLOAD_TIMEOUT_MS); emitting message without media',
            {
              msgId: msg.id._serialized,
            },
          ),
        ),
      );
      // Keep the slot occupied until the underlying download truly settles, not the timeout race.
      return download.then(
        () => undefined,
        () => undefined,
      );
    });
    // The slot-holder runs in the background. It only rejects when the limiter's waiter queue is
    // saturated (queue full) — in which case the download task never ran and boundedReady would hang.
    // Resolve null so the caller unblocks and emits the message without media, matching the
    // timeout/byte-cap no-media path. Never let it surface as an unhandled rejection either.
    void slotHeld.catch(() => {
      this.logger.warn('Inbound media limiter saturated; emitting message without media', {
        msgId: msg.id._serialized,
      });
      resolveBounded(null);
    });
    const media = await boundedReady;
    if (!media) {
      return declaredOnlyMedia(msg);
    }
    const capped = capInboundMedia({
      mimetype: media.mimetype,
      filename: media.filename || undefined,
      sizeBytes: Buffer.byteLength(media.data, 'base64'),
      toBase64: () => media.data,
    });
    if (capped.omitted) {
      this.logger.warn('Inbound media exceeds MEDIA_DOWNLOAD_MAX_BYTES; dropped payload, kept envelope', {
        msgId: msg.id._serialized,
        sizeBytes: capped.sizeBytes,
      });
    }
    return capped;
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    // An install that skipped the message-id backport fails later with errors that name no cause
    // (#889) — say so here instead, while the operator is still looking at the startup logs.
    if (isBackportMissing()) {
      this.logger.error(BACKPORT_MISSING_MESSAGE);
    }

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.config.puppeteer?.args
        ? [...this.config.puppeteer.args]
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
      if (this.config.proxy) {
        if (isSupportedProxyUrl(this.config.proxy.url)) {
          // Chromium ignores credentials in --proxy-server; pass a credential-less server and hand the
          // username/password to wwjs's proxyAuthentication (page.authenticate) for HTTP/HTTPS proxies (#628).
          const proxyLaunch = buildProxyLaunchConfig(this.config.proxy.url);
          puppeteerArgs.push(`--proxy-server=${proxyLaunch.serverArg}`);
          proxyAuthentication = proxyLaunch.proxyAuthentication;
          if (proxyLaunch.socksAuthUnsupported) {
            this.logger.warn(
              `Proxy for session ${this.config.sessionId} has credentials on a SOCKS proxy, but Chromium ` +
                `cannot authenticate SOCKS proxies. Use an IP-authorized proxy or an HTTP/HTTPS proxy instead.`,
            );
          }
          this.logger.log(`Using proxy: ${proxyLaunch.serverArg}`);
        } else {
          this.logger.warn(`Ignoring invalid proxy URL for session ${this.config.sessionId}`);
        }
      }

      // Marker arg: Chromium silently ignores unknown flags, so this exists purely as a label that
      // lets killOrphanedChromiumProcesses() identify this session's browser processes in `ps`
      // output later (after a hard kill of the OpenWA process orphaned them).
      puppeteerArgs.push(`--openwa-session=${this.config.sessionId}`);

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
        this.logger.log(`Pinning WhatsApp Web version ${versionPin.webVersion}`);
      }

      // Extend the first-boot init wait on slow setups (WSL2/low-resource), #353. Opt-in:
      // unset keeps whatsapp-web.js's 30000ms default.
      const authTimeoutMs = resolveAuthTimeoutMs();
      if (authTimeoutMs) {
        this.logger.log(`Using auth timeout ${authTimeoutMs}ms`);
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
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
          ...(this.config.puppeteer?.executablePath ? { executablePath: this.config.puppeteer.executablePath } : {}),
        },
        ...(authTimeoutMs !== undefined ? { authTimeoutMs } : {}),
        ...(proxyAuthentication ? { proxyAuthentication } : {}),
        ...(versionPin ?? {}),
      });

      this.setupEventHandlers();
      if (this.tearingDown) {
        this.client = null;
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }
      // Kill any Chromium that survived a hard kill of a previous OpenWA process lifetime (its
      // Puppeteer exit hook never ran, leaving an orphaned browser holding the profile). Safe here
      // for the same reason as the Singleton cleanup below: this runs only at engine (re)start,
      // before this lifetime's browser exists, so it cannot kill a live browser.
      await killOrphanedChromiumProcesses(this.config.sessionId, this.logger);
      // Clear stale Chromium Singleton* files left by a hard kill before launching — see
      // removeStaleSingletonFiles. This runs only at engine (re)start, never while
      // the browser is alive, so it cannot pull the files out from under a running Chromium.
      await removeStaleSingletonFiles(this.config.sessionId, this.config.sessionDataPath, this.logger);
      await this.client.initialize();
      // whatsapp-web.js 1.34.x never observes the Chromium process/page it drives, so a crashed
      // browser leaves the client looking READY forever ("silent death"). Attach death listeners
      // to the puppeteer handles so a dead browser surfaces as a normal disconnect → reconnect.
      this.attachPuppeteerLifecycleListeners();
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
        this.logger.warn(
          `"${reason}" during initialize. If this followed an OpenWA upgrade that changed the ` +
            `Chromium/Chrome binary (v0.8.12 amd64 switched Debian Chromium → Chrome for Testing), the ` +
            `session's browser profile is likely stale — delete the profile dir ` +
            `"${path.join(path.resolve(this.config.sessionDataPath), `session-${this.config.sessionId}`)}" ` +
            `and start again to re-scan. If no upgrade happened, Puppeteer also raises this on a page ` +
            `navigation or renderer crash (check for memory pressure or a WhatsApp Web reload). ` +
            `See docs/12-troubleshooting-faq.md.`,
        );
        // Kept short and with the raw Puppeteer text FIRST: operators search on that string, and the
        // dashboard truncates a long reason. The profile path stays in the log above — it is too long
        // for a card, and naming the wrong remedy is worse than pointing at the FAQ, since deleting a
        // profile forces an irreversible re-pair.
        surfacedReason =
          `${reason} WhatsApp Web's page context was destroyed during startup. If this followed an ` +
          `upgrade, the session's browser profile is likely stale — see docs/12-troubleshooting-faq.md.`;
      }
      this.callbacks.onError?.(surfacedReason);
      throw error;
    }
  }

  private setupEventHandlers(): void {
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
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
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
      this.scheduleReadyReconcile();
    });

    this.client.on('ready', () => {
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
        this.logger.warn('Ignoring premature ready: the message event bridge is not attached yet', {
          sessionId: this.config.sessionId,
          action: 'premature_ready_ignored',
        });
        return;
      }
      this.markReadyFromClientInfo();
    });

    // Message-domain events (message, message_create, ack, revoke, reaction, edit): extracted to
    // ./wwebjs-message-events — pure payload mapping fired through the engine callbacks.
    registerWwebjsMessageEvents(this.client, this.host);

    this.client.on('group_join', notification => this.handleGroupNotification('join', notification));
    this.client.on('group_leave', notification => this.handleGroupNotification('leave', notification));
    this.client.on('group_update', notification => this.handleGroupNotification('update', notification));

    this.client.on('call', call => this.handleIncomingCall(call));

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
        this.callbacks.onCredentialTeardownStarted?.(this.clearLocalAuth());
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
      this.clearReadyReconcile();
      // #982: LOGOUT is not a transient drop. The lifecycle's reconnect cannot restore the link; it
      // can only come back with a fresh QR. Say that here rather than leaving the operator with an
      // opaque engine token that reads like any other drop.
      if (reason === 'LOGOUT') {
        this.logger.warn(
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
        this.callbacks.onAccountRestriction?.({ kind: restriction, code: reason });
      }
      this.callbacks.onDisconnected?.(reason);
    });

    this.client.on('auth_failure', (message?: string) => {
      this.clearReadyReconcile();
      this.setStatus(EngineStatus.FAILED);
      // Authentication failure is terminal: the stored credentials are invalid and
      // reconnecting will not help — the operator must re-scan the QR code. Route it
      // through onError (FAILED, no reconnect) rather than onDisconnected (reconnect).
      this.callbacks.onError?.(message ? `Authentication failed: ${message}` : 'Authentication failed');
    });
  }

  /**
   * whatsapp-web.js exposes no way to observe another party's presence: WAWebPresenceChatAction
   * offers only sendPresenceAvailable/sendPresenceUnavailable, which publish the ACCOUNT's own
   * presence, and the library surfaces no presence event at all.
   *
   * Declared here inline rather than in a delegate on purpose. The parity gate reads method bodies
   * off the prototype, so a throw hidden behind a delegate call is invisible to it and the
   * `not-available` matrix row would go unverified; inline, the gate checks it.
   */
  createChannel(name: string, description?: string): Promise<Channel> {
    return this.channels.createChannel(name, description);
  }

  deleteChannel(channelId: string): Promise<void> {
    return this.channels.deleteChannel(channelId);
  }

  muteChannel(channelId: string, mute: boolean): Promise<void> {
    return this.channels.muteChannel(channelId, mute);
  }

  getChatsByLabel(labelId: string): Promise<ChatSummary[]> {
    return this.labels.getChatsByLabel(labelId);
  }

  /**
   * whatsapp-web.js 1.34.7 can read labels and assign them, but cannot create, rename, recolour or
   * delete one — `index.d.ts` exposes getLabels / getLabelById / getChatLabels / getChatsByLabelId /
   * addOrRemoveLabels and nothing that edits the label itself.
   *
   * Inline rather than delegated so the parity gate, which reads bodies off the prototype, can
   * verify the matrix row (see docs/29).
   */
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async upsertLabel(_label: LabelInput): Promise<void> {
    throw new EngineNotSupportedError('upsertLabel');
  }

  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async deleteLabel(_labelId: string): Promise<void> {
    throw new EngineNotSupportedError('deleteLabel');
  }

  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async subscribeToPresence(_chatId: string): Promise<void> {
    throw new EngineNotSupportedError('subscribeToPresence');
  }

  /**
   * Map a whatsapp-web.js GroupNotification (`group_join` / `group_leave` / `group_update`) to the
   * neutral GroupEvent and forward it. wwebjs ids are already in the neutral dialect (@c.us/@g.us),
   * so no jid translation is needed here. The try/catch mirrors message_edit: a malformed
   * notification is logged and dropped, never thrown back into the client's emitter.
   */
  private handleGroupNotification(kind: GroupEvent['kind'], notification: GroupNotification): void {
    try {
      // A notification without a chat id carries no usable target — drop it before payload building.
      if (!notification.chatId) {
        return;
      }
      const payload: GroupEvent = {
        kind,
        groupId: notification.chatId,
        actorId: notification.author || undefined,
        participantIds: wwebjsGroupRecipientIds(notification),
        // The notification's own timestamp IS the occurrence time (unlike message_edit, where
        // wwebjs keeps the original creation time). Fall back to receipt time when absent.
        timestamp:
          typeof notification.timestamp === 'number' && notification.timestamp > 0
            ? Math.floor(notification.timestamp)
            : Math.floor(Date.now() / 1000),
      };
      if (kind === 'update') {
        // Join/leave carry no metadata delta. An update whose subtype/body cannot be interpreted
        // still emits with empty changes rather than being dropped silently.
        payload.changes = wwebjsGroupUpdateChanges(notification);
      }
      this.callbacks.onGroupEvent?.(payload);
    } catch (error) {
      this.logger.error(`Error processing group_${kind} notification`, String(error));
    }
  }

  /**
   * Map a whatsapp-web.js `Call` (client `call` event) to the neutral IncomingCallEvent and cache
   * the live Call so rejectCall() can act on it later — the Call object is only usable while the
   * call is live. Own-account calls (fromMe) are skipped: they are outgoing, not incoming. wwebjs
   * ids are already neutral (@c.us), so no jid translation is needed. The try/catch mirrors
   * message_edit: a malformed call is logged and dropped, never thrown back into the emitter.
   */
  private handleIncomingCall(call: Call): void {
    try {
      // Symmetry with the other client-event handlers (qr/authenticated): a call landing during or
      // after teardown is dropped. A malformed call without the id/from rejectCall() later depends
      // on is dropped too — never cached, never emitted.
      if (this.tearingDown || !call?.id || !call.from) {
        return;
      }
      if (call.fromMe) {
        return;
      }
      // whatsapp-web.js fires this handler from a patched `internalCallMap.set()`, which runs on
      // every write to that map — including updates to a call already ringing — so the same call id
      // can arrive more than once. Cache first and emit only for an id not already live, otherwise
      // one call surfaces as several `call.received` events.
      if (!this.cacheLiveCall(call.id, call)) {
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
      this.callbacks.onCall?.(payload);
    } catch (error) {
      this.logger.error('Error processing call event', String(error));
    }
  }

  /**
   * Cache a live call for a later rejectCall(). Lazy expiry: inserting a new call drops
   * already-expired entries, so a session that receives calls but never rejects them can't grow
   * the map without bound; an entry that never sees another call is tiny and is dropped on
   * teardown (beginClientTeardown) or at the next call. No per-entry timer to clean up.
   *
   * Returns true when `callId` was not already ringing, which is what makes `call.received` fire
   * once per call rather than once per upstream map write. A repeat write still refreshes the
   * entry, so a long-ringing call stays rejectable for a full TTL from the most recent signal.
   */
  private cacheLiveCall(callId: string, call: Call): boolean {
    const now = Date.now();
    for (const [id, entry] of this.liveCalls) {
      if (entry.expiresAt <= now) {
        this.liveCalls.delete(id);
      }
    }
    const isNewCall = !this.liveCalls.has(callId);
    this.liveCalls.set(callId, { call, expiresAt: now + WhatsAppWebJsAdapter.LIVE_CALL_TTL_MS });
    return isNewCall;
  }

  /**
   * Reject a currently-ringing call. The entry is evicted on ANY attempt (a rejected/ended call
   * will not become rejectable again); an unknown id or an expired entry maps to CallNotFoundError
   * (HTTP 404). A failure of the library's reject() itself propagates as-is.
   */
  async rejectCall(callId: string): Promise<void> {
    const entry = this.liveCalls.get(callId);
    this.liveCalls.delete(callId);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new CallNotFoundError(callId);
    }
    await entry.call.reject();
  }

  /**
   * Attach to the loosely-typed whatsapp-web.js puppeteer handles (same cast pattern as
   * isClientRuntimeReady/forceDestroy). whatsapp-web.js itself never listens to these, so without
   * this a dead Chromium is invisible: browser process death, renderer crash ("Aw Snap"), and a
   * closed tab all mean the session is gone, no matter what status the client still reports.
   */
  private attachPuppeteerLifecycleListeners(): void {
    if (!this.client) return;
    const { pupBrowser, pupPage } = this.client as unknown as {
      pupBrowser?: { on: (event: 'disconnected', cb: () => void) => void };
      pupPage?: { on: (event: 'error' | 'close', cb: () => void) => void };
    };
    pupBrowser?.on('disconnected', () => this.handlePuppeteerDeath('Browser process closed or crashed'));
    pupPage?.on('error', () => this.handlePuppeteerDeath('Page crashed'));
    pupPage?.on('close', () => this.handlePuppeteerDeath('Page closed'));
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
    this.clearReadyReconcile();
    this.setStatus(EngineStatus.DISCONNECTED);
    this.callbacks.onDisconnected?.(reason);
  }

  /**
   * Error-message signatures of a dead page/transport: Puppeteer raises these when the browser
   * process, the renderer, or the CDP connection is gone (e.g. 'Protocol error: Target closed').
   */
  private static readonly PAGE_TRANSPORT_ERROR_PATTERN =
    /protocol error|target closed|targetclosederror|detached frame|session closed|connection closed/i;

  /** Whether the error carries a dead page/transport signature (see PAGE_TRANSPORT_ERROR_PATTERN). */
  private isPageTransportError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return WhatsAppWebJsAdapter.PAGE_TRANSPORT_ERROR_PATTERN.test(message);
  }

  /**
   * Report a failed client/page operation as a session death when the error matches
   * PAGE_TRANSPORT_ERROR_PATTERN. A wedged page can fire NO events while still reporting CONNECTED
   * (whatsapp-web.js #5728), so the watchdog takes minutes to notice — an operation failing with one
   * of these errors is a much earlier death signal. Detection
   * only: the error itself still propagates to the caller exactly as before, and
   * handlePuppeteerDeath's guard makes this safe during teardown and against double-reporting.
   */
  private reportIfPageTransportError(error: unknown, context: string): void {
    if (!this.isPageTransportError(error)) {
      return;
    }
    this.logger.warn(`Page transport error during ${context} — treating the session as dead`, {
      error: error instanceof Error ? error.message : String(error),
    });
    this.handlePuppeteerDeath(`Page transport error during ${context}`);
  }

  private markReadyFromClientInfo(): void {
    if (
      [EngineStatus.READY, EngineStatus.DISCONNECTED, EngineStatus.FAILED, EngineStatus.ACTION_REQUIRED].includes(
        this.status,
      )
    )
      return;
    this.clearReadyReconcile();
    try {
      const info = this.client?.info;
      this.phoneNumber = info?.wid?.user || null;
      this.pushName = info?.pushname || null;
      this.setStatus(EngineStatus.READY);
      this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
    } catch (error) {
      this.logger.error('Error getting client info', String(error));
      this.setStatus(EngineStatus.READY);
      this.callbacks.onReady?.('', '');
    }
    // A freshly-linked account may show a "What's new" onboarding modal that, left unacknowledged,
    // gets the companion unlinked (~5m later → disconnected: LOGOUT, #982). Dismiss it best-effort
    // and fall back to ACTION_REQUIRED. Started after READY so a non-ready session never arms it.
    this.startOnboardingWatcher();
  }

  private scheduleReadyReconcile(): void {
    this.clearReadyReconcile();
    this.readyReconcileStartedAt = Date.now();

    const tick = (): void => {
      if (!this.client || this.status !== EngineStatus.AUTHENTICATING) {
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
        const bridgeDead =
          this.lastProbeStateConnected &&
          (this.client as (Client & { eventsAttached?: boolean }) | null)?.eventsAttached === false;
        if (bridgeDead) {
          this.logger.error(
            'WhatsApp Web stayed connected but its event bridge never attached within the readiness ' +
              'deadline — inbound messages would be silently lost, so the session is marked failed. ' +
              'The saved credentials were kept; restart the session to relaunch the browser.',
            undefined,
            { sessionId: this.config.sessionId, action: 'ready_reconcile_bridge_dead' },
          );
          this.clearReadyReconcile();
          this.setStatus(EngineStatus.FAILED);
          this.callbacks.onError?.(
            'WhatsApp Web is connected but its event bridge never attached, so inbound messages would be ' +
              'lost. The saved session was kept — restart the session to relaunch the browser.',
          );
          return;
        }
        this.logger.warn(
          'Timed out waiting for WhatsApp Web runtime readiness after authentication — the saved session ' +
            'is stuck after the QR scan (usually the auto-selected WhatsApp Web build is incompatible). ' +
            'Clearing it to re-pair; pin a known-good version via WWEBJS_WEB_VERSION (see ' +
            'docs/12-troubleshooting-faq.md) if it keeps recurring.',
          // Name the session: on a multi-session host this warning is the only way to tell whether one
          // session timed out or every one of them did, and the two have very different causes.
          { sessionId: this.config.sessionId, action: 'ready_reconcile_timeout' },
        );
        this.clearReadyReconcile();
        // Self-heal: don't leave the session stuck at "authenticating" forever — clear the broken auth
        // and disconnect so the lifecycle re-pairs (a fresh QR) instead of hanging.
        void this.recoverFromStuckAuth();
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
          if (ready && this.client && this.status === EngineStatus.AUTHENTICATING) {
            this.logger.warn('WhatsApp Web ready event was missed; reconciling from connected runtime state');
            this.markReadyFromClientInfo();
          } else if (this.status === EngineStatus.AUTHENTICATING) {
            this.maybeReloadDeadBridge();
          }
        })
        .catch(error => this.logger.debug('Ready reconciliation probe failed', { error: String(error) }))
        .finally(() => {
          this.readyReconcileProbeInFlight = false;
        });
    };

    this.readyReconcileTimer = setTimeout(tick, READY_RECONCILE_INTERVAL_MS);
    this.readyReconcileTimer.unref?.();
  }

  private clearReadyReconcile(): void {
    if (this.readyReconcileTimer) {
      clearTimeout(this.readyReconcileTimer);
      this.readyReconcileTimer = null;
    }
    this.readyReconcileStartedAt = 0;
    this.readyReconcileProbeInFlight = false;
    this.lastProbeStateConnected = false;
    this.readyReconcileReloadAttempted = false;
  }

  /**
   * Dismiss a freshly-linked account's "What's new on WhatsApp Web" onboarding modal (#982). The modal
   * has a Continue button that must be acknowledged or WhatsApp unlinks the companion ~5m later
   * (surfacing as disconnected: LOGOUT). whatsapp-web.js exposes no API for this (#3550 open), so the
   * watcher reaches the page directly. Idempotent and one-shot per engine: the modal appears once per
   * account, so the loop self-terminates at the lifetime cap instead of polling forever.
   *
   * The watcher only ever moves the session out of READY when it has clicked Continue repeatedly and
   * the modal is still there — real evidence a human must acknowledge it. A probe that cannot reach
   * the page, or a page with no such modal, leaves the session exactly where it was: blocking sends
   * over a best-effort DOM guess would be a worse outcome than the problem being guarded against.
   */
  private startOnboardingWatcher(): void {
    if (this.onboardingWatcherStarted) return; // idempotent: ready event + reconcile path share one funnel
    this.onboardingWatcherStarted = true;
    this.onboardingWatcherStartedAt = Date.now();

    const tick = (): void => {
      if (!this.client || this.status !== EngineStatus.READY || this.tearingDown || this.disconnectReported) {
        this.clearOnboardingWatcher();
        return;
      }
      // The modal is one-shot per account: stop after the lifetime cap rather than polling forever.
      if (Date.now() - this.onboardingWatcherStartedAt >= ONBOARDING_MODAL_MAX_LIFETIME_MS) {
        this.clearOnboardingWatcher();
        return;
      }
      // Schedule the next tick up front so a hung page.evaluate can't stall the loop.
      this.onboardingWatcherTimer = setTimeout(tick, ONBOARDING_MODAL_INTERVAL_MS);
      this.onboardingWatcherTimer.unref?.();
      // Fire-and-forget: a rejection is the fallback signal, not a crash.
      void this.dismissOnboardingModalIfNeeded();
    };

    this.onboardingWatcherTimer = setTimeout(tick, ONBOARDING_MODAL_INTERVAL_MS);
    this.onboardingWatcherTimer.unref?.();
  }

  private clearOnboardingWatcher(): void {
    if (this.onboardingWatcherTimer) {
      clearTimeout(this.onboardingWatcherTimer);
      this.onboardingWatcherTimer = null;
    }
    this.onboardingWatcherStartedAt = 0;
  }

  /**
   * One watcher tick: click the onboarding modal's Continue button if it is on screen. Returns the
   * probe verdict rather than mutating state so the loop stays the single owner of the
   * ACTION_REQUIRED transition. A rejected evaluate is NOT an operator signal — see the catch.
   */
  private async dismissOnboardingModalIfNeeded(): Promise<void> {
    if (!this.client) return;
    const page = (
      this.client as unknown as {
        pupPage?: { evaluate: <T, A>(fn: (arg: A) => T, arg: A) => Promise<T> };
      }
    ).pupPage;

    // Resolved out here, not inside the probe: the function body is stringified into the page, so it
    // cannot read process.env. Operator-supplied labels skip the English heading check (see the probe).
    const labels = resolveOnboardingContinueLabels();
    const headingOptionalFor = labels.filter(label => label !== ONBOARDING_DEFAULT_CONTINUE_LABEL);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        page?.evaluate(probeOnboardingModal, { labels, headingOptionalFor }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('onboarding modal probe timed out')),
            ONBOARDING_MODAL_PROBE_TIMEOUT_MS,
          );
          timeout.unref?.();
        }),
      ]);

      if (!result?.dismissed) return;

      // We clicked. A modal that is really dismissed is gone by the next tick, so a click here is
      // normally a one-off. Repeated clicks mean the click is not taking effect (an overlay is
      // swallowing it, or WhatsApp keeps re-showing the modal) — that, and only that, is evidence a
      // human has to acknowledge it on the phone before the companion is unlinked.
      this.onboardingDismissClicks += 1;
      this.logger.log('Dismissed the WhatsApp Web onboarding modal', {
        sessionId: this.config.sessionId,
        attempt: this.onboardingDismissClicks,
        action: 'onboarding_modal_dismissed',
      });
      if (this.onboardingDismissClicks >= ONBOARDING_MODAL_MAX_DISMISS_CLICKS) {
        this.reportActionRequired(
          `WhatsApp is still showing its onboarding modal after ${this.onboardingDismissClicks} ` +
            "attempts to dismiss it. Open WhatsApp Web on the account holder's own browser and click " +
            'through the "What\'s new" screen, or the companion device will be unlinked. Then restart ' +
            'the session (stop, then start) — acknowledging the modal does not return it to ready on its own.',
        );
      }
    } catch {
      // The page navigated, closed, or the probe timed out. This is expected around a reload or a
      // teardown and says nothing about the modal, so it must not move the session: a status change
      // here would take a HEALTHY session out of READY, which blocks every send (ensureReady) for a
      // reason the operator cannot act on. A page that is genuinely gone surfaces through the
      // puppeteer lifecycle listeners as a disconnect, which is where that belongs.
      this.logger.debug('Onboarding modal probe could not reach the page; ignoring', {
        sessionId: this.config.sessionId,
        action: 'onboarding_modal_probe_skipped',
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private reportActionRequired(reason: string): void {
    this.clearOnboardingWatcher();
    if (this.status !== EngineStatus.READY) return; // already leaving READY; don't override a teardown/failure
    this.setStatus(EngineStatus.ACTION_REQUIRED);
    this.callbacks.onActionRequired?.(reason);
    this.logger.warn(reason, { sessionId: this.config.sessionId, action: 'onboarding_modal_fallback' });
  }

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
  private async recoverFromStuckAuth(): Promise<void> {
    // The one-shot budget is decided SYNCHRONOUSLY before any destructive I/O. The session-owned
    // callback is authoritative when present; the instance-local boolean is the standalone fallback.
    // Fail-closed: a callback that throws (or already-spent budget) makes this terminal WITHOUT
    // touching the auth dir, so a wedged claim path can never wipe the only copy of the credentials.
    const claim = this.callbacks.claimStuckAuthRecovery;
    let granted: boolean;
    if (claim) {
      try {
        granted = claim();
      } catch {
        granted = false;
      }
    } else {
      granted = !this.stuckAuthRecoveryAttempted;
      this.stuckAuthRecoveryAttempted = true;
    }
    if (!granted) {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onError?.(
        'WhatsApp Web could not reach readiness after re-pairing. Pin WWEBJS_WEB_VERSION to a known-good build and try again.',
      );
      return;
    }

    const client = this.client;
    this.client = null;
    // Clear auth + disconnect FIRST (the recovery path), then tear the wedged client down in the
    // background so a hung Chromium destroy can't block (or skip) the recovery.
    await this.clearLocalAuth();
    this.setStatus(EngineStatus.DISCONNECTED);
    // onDisconnected drives the lifecycle's reconnect, which re-creates the engine with no saved auth
    // → a fresh QR. (A no-op once the engine is superseded/torn down.)
    this.callbacks.onDisconnected?.('Saved session could not be restored; cleared for re-pairing');
    if (typeof client?.destroy === 'function') void client.destroy().catch(() => undefined);
  }

  /** Remove this session's LocalAuth directory so the next start re-pairs from a clean slate. */
  private async clearLocalAuth(): Promise<void> {
    const dir = path.join(path.resolve(this.config.sessionDataPath), `session-${this.config.sessionId}`);
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
        this.logger.warn(
          `Deleted this session's stored WhatsApp credentials at ${dir}. That was the only copy, so the ` +
            'next start cannot restore the link and comes back with a fresh QR to scan.',
          { sessionId: this.config.sessionId, dir, action: 'auth_cleared' },
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(`Could not clear stale auth at ${dir}`, {
          sessionId: this.config.sessionId,
          dir,
          error: String(error),
        });
      });
  }

  private async isClientRuntimeReady(): Promise<boolean> {
    if (!this.client) return false;
    const connected = (await this.client.getState()) === WAState.CONNECTED;
    this.lastProbeStateConnected = connected;
    if (!connected) return false;
    if (!this.client.info?.wid?.user) return false;

    // The patched whatsapp-web.js client (scripts/patch-wwebjs-ready-sync.js) reports whether
    // attachEventListeners resolved. `false` means the page->Node message bridge is dead even
    // though the page reports CONNECTED — promoting that session to READY masks the loss of every
    // inbound event (the live incident this exists for). `undefined` is an unpatched tree: keep
    // the legacy checks rather than refusing readiness a tree cannot ever signal.
    if ((this.client as Client & { eventsAttached?: boolean }).eventsAttached === false) return false;

    const page = (this.client as unknown as { pupPage?: { evaluate: <T>(fn: () => T) => Promise<T> } }).pupPage;
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
    if (!this.client || !this.lastProbeStateConnected) return;
    const client = this.client as Client & { eventsAttached?: boolean };
    if (client.eventsAttached !== false) return;
    this.readyReconcileReloadAttempted = true;
    this.logger.warn('WhatsApp Web is connected but its event bridge never attached; reloading the page to reinject', {
      sessionId: this.config.sessionId,
      action: 'event_bridge_reload',
    });
    const page = (client as unknown as { pupPage?: { reload?: () => Promise<unknown> } }).pupPage;
    void page?.reload?.()?.catch((error: unknown) =>
      this.logger.warn('Event-bridge reload failed', {
        sessionId: this.config.sessionId,
        error: String(error),
      }),
    );
  }

  private setStatus(status: EngineStatus): void {
    // Latch before anything observes the transition. The constructor's initial DISCONNECTED is a field
    // initializer and never reaches here, so this only ever fires on a real transition — startup is
    // unaffected while a finished adapter is marked finished for good.
    if (status === EngineStatus.DISCONNECTED) {
      this.disconnectReported = true;
    }
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  private beginClientTeardown(): Client | null {
    this.tearingDown = true;
    // Any cached call handle is dead once the client goes away — drop them all so a later
    // rejectCall() reports not-found instead of acting on a destroyed page.
    this.liveCalls.clear();
    const client = this.client;
    if (!client) return null;

    this.clearReadyReconcile();
    this.clearOnboardingWatcher();
    if (this.status !== EngineStatus.DISCONNECTED) {
      this.setStatus(EngineStatus.DISCONNECTED);
    }

    return client;
  }

  private finishClientTeardown(client: Client): void {
    if (this.client === client) {
      this.client = null;
    }
    this.clearReadyReconcile();
    this.clearOnboardingWatcher();
  }

  async disconnect(): Promise<void> {
    const client = this.beginClientTeardown();
    if (!client) return;

    try {
      // Use destroy instead of logout to preserve session data
      // This allows reconnecting without needing to scan QR again
      await client.destroy();
    } catch (error) {
      this.logger.warn('Destroy client failed:', { error: String(error) });
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
      this.logger.warn('Logout failed:', { error: String(error) });
      // Fall back to destroy so the session still dies locally — but rethrow so the caller
      // learns the unlink never reached WhatsApp: the device may still be listed under the
      // account holder's Linked Devices, and reporting success would write a false audit row.
      try {
        await client.destroy();
      } catch (destroyError) {
        this.logger.warn('Client destroy also failed during logout fallback', { error: String(destroyError) });
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
      this.logger.warn('forceDestroy: failed to kill the browser process', { error: String(err) });
    }

    try {
      await client.destroy();
    } catch (err) {
      this.logger.warn('forceDestroy: client.destroy() failed after the kill (continuing)', { error: String(err) });
    } finally {
      this.finishClientTeardown(client);
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  /**
   * Active liveness probe for the session watchdog: race a real getState() round-trip against a 10s
   * timeout. Probe failure or timeout means dead — a wedged page can keep reporting CONNECTED
   * (whatsapp-web.js #5728), so turning consecutive probe failures into a reconnect decision stays
   * the calling watchdog's job.
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
      return state === WAState.CONNECTED;
    } catch {
      return false;
    } finally {
      // Never leave the timeout dangling when getState() settles first (Jest open-handle hygiene).
      if (timeout) clearTimeout(timeout);
    }
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  /**
   * Request an 8-char pairing code so the user can link via "Link with phone number" instead of
   * scanning the QR. Must be called after the engine has started (the client is initialized and
   * waiting to link); whatsapp-web.js throws if called before it is ready or after authentication.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.client) {
      throw new EngineNotReadyError();
    }
    return this.client.requestPairingCode(phoneNumber);
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  sendTextMessage(
    chatId: string,
    text: string,
    mentions?: string[],
    options?: { linkPreview?: boolean; customPreview?: CustomLinkPreview },
  ): Promise<MessageResult> {
    return this.messaging.sendTextMessage(chatId, text, mentions, options);
  }

  sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendImageMessage(chatId, media);
  }

  sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendVideoMessage(chatId, media);
  }

  sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendAudioMessage(chatId, media);
  }

  sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendDocumentMessage(chatId, media);
  }

  getContacts(): Promise<Contact[]> {
    return this.contacts.getContacts();
  }

  getContactById(contactId: string): Promise<Contact | null> {
    return this.contacts.getContactById(contactId);
  }

  getNumberId(number: string): Promise<string | null> {
    return this.contacts.getNumberId(number);
  }

  checkNumberExists(number: string): Promise<boolean> {
    return this.contacts.checkNumberExists(number);
  }

  resolveContactPhone(contactId: string): Promise<string | null> {
    return this.contacts.resolveContactPhone(contactId);
  }

  getGroups(): Promise<Group[]> {
    return this.groups.getGroups();
  }

  // ============= Phase 3: Extended Messaging =============

  sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    return this.messaging.sendLocationMessage(chatId, location);
  }

  sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    return this.messaging.sendContactMessage(chatId, contact);
  }

  sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendStickerMessage(chatId, media);
  }

  sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    return this.messaging.sendPollMessage(chatId, poll);
  }

  replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    return this.messaging.replyToMessage(chatId, quotedMsgId, text);
  }

  forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    return this.messaging.forwardMessage(fromChatId, toChatId, messageId);
  }

  // ============= Phase 3: Group Management =============

  getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    return this.groups.getGroupInfo(groupId);
  }

  createGroup(name: string, participants: string[]): Promise<Group> {
    return this.groups.createGroup(name, participants);
  }

  addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.addParticipants(groupId, participants);
  }

  removeParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.removeParticipants(groupId, participants);
  }

  promoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.promoteParticipants(groupId, participants);
  }

  demoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.demoteParticipants(groupId, participants);
  }

  leaveGroup(groupId: string): Promise<void> {
    return this.groups.leaveGroup(groupId);
  }

  setGroupSubject(groupId: string, subject: string): Promise<void> {
    return this.groups.setGroupSubject(groupId, subject);
  }

  setGroupDescription(groupId: string, description: string): Promise<void> {
    return this.groups.setGroupDescription(groupId, description);
  }

  // Reactions (Phase 3)
  reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    return this.messaging.reactToMessage(chatId, messageId, emoji);
  }

  getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    return this.messaging.getMessageReactions(chatId, messageId);
  }

  // Labels (Phase 3) - WhatsApp Business only
  getLabels(): Promise<Label[]> {
    return this.labels.getLabels();
  }

  getLabelById(labelId: string): Promise<Label | null> {
    return this.labels.getLabelById(labelId);
  }

  getChatLabels(chatId: string): Promise<Label[]> {
    return this.labels.getChatLabels(chatId);
  }

  addLabelToChat(chatId: string, labelId: string): Promise<void> {
    return this.labels.addLabelToChat(chatId, labelId);
  }

  removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    return this.labels.removeLabelFromChat(chatId, labelId);
  }

  // Channels/Newsletter (Phase 3)
  getSubscribedChannels(): Promise<Channel[]> {
    return this.channels.getSubscribedChannels();
  }

  getChannelById(channelId: string): Promise<Channel | null> {
    return this.channels.getChannelById(channelId);
  }

  subscribeToChannel(_inviteCode: string): Promise<Channel> {
    return this.channels.subscribeToChannel(_inviteCode);
  }

  unsubscribeFromChannel(channelId: string): Promise<void> {
    return this.channels.unsubscribeFromChannel(channelId);
  }

  getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    return this.channels.getChannelMessages(channelId, limit);
  }

  // ========== Gap Quick Wins Implementation ==========

  getChatHistory(
    chatId: string,
    limit: number = 50,
    includeMedia: boolean = false,
    mediaMaxBytes?: number,
    signal?: AbortSignal,
  ): Promise<IncomingMessage[]> {
    return this.messaging.getChatHistory(chatId, limit, includeMedia, mediaMaxBytes, signal);
  }

  // Delete Message
  starMessage(chatId: string, messageId: string, star: boolean): Promise<void> {
    return this.messaging.starMessage(chatId, messageId, star);
  }

  pinMessage(chatId: string, messageId: string, durationSeconds: number): Promise<void> {
    return this.messaging.pinMessage(chatId, messageId, durationSeconds);
  }

  votePoll(chatId: string, pollMessageId: string, options: string[]): Promise<void> {
    return this.messaging.votePoll(chatId, pollMessageId, options);
  }

  unpinMessage(chatId: string, messageId: string): Promise<void> {
    return this.messaging.unpinMessage(chatId, messageId);
  }

  deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    return this.messaging.deleteMessage(chatId, messageId, forEveryone);
  }

  // Edit Message
  editMessage(chatId: string, messageId: string, body: string): Promise<MessageResult> {
    return this.messaging.editMessage(chatId, messageId, body);
  }

  // Get Profile Picture
  getProfilePicture(contactId: string): Promise<string | null> {
    return this.contacts.getProfilePicture(contactId);
  }

  // Block Contact
  blockContact(contactId: string): Promise<void> {
    return this.contacts.blockContact(contactId);
  }

  upsertContact(contactId: string, firstName: string, lastName?: string): Promise<void> {
    return this.contacts.upsertContact(contactId, firstName, lastName);
  }

  deleteContact(contactId: string): Promise<void> {
    return this.contacts.deleteContact(contactId);
  }

  // Unblock Contact
  unblockContact(contactId: string): Promise<void> {
    return this.contacts.unblockContact(contactId);
  }

  // ========== Profile (own account) ==========

  setProfileName(name: string): Promise<void> {
    return this.profile.setProfileName(name);
  }

  setProfileStatus(status: string): Promise<void> {
    return this.profile.setProfileStatus(status);
  }

  setProfilePicture(media: MediaInput): Promise<void> {
    return this.profile.setProfilePicture(media);
  }

  // Get Group Invite Code
  getGroupInviteCode(groupId: string): Promise<string> {
    return this.groups.getGroupInviteCode(groupId);
  }

  // Revoke Group Invite Code
  revokeGroupInviteCode(groupId: string): Promise<string> {
    return this.groups.revokeGroupInviteCode(groupId);
  }

  // Join Group via Invite Code
  getGroupJoinInfo(inviteCode: string): Promise<GroupJoinInfo> {
    return this.groups.getGroupJoinInfo(inviteCode);
  }

  joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    return this.groups.joinGroupViaInviteCode(inviteCode);
  }

  // Set "only admins can send messages" (announce)
  setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    return this.groups.setGroupMessagesAdminsOnly(groupId, adminsOnly);
  }

  // Set "only admins can edit group info" (locked/restrict)
  setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    return this.groups.setGroupInfoAdminsOnly(groupId, adminsOnly);
  }

  setGroupMemberAddMode(groupId: string, mode: GroupMemberAddMode): Promise<void> {
    return this.groups.setGroupMemberAddMode(groupId, mode);
  }

  setGroupPicture(groupId: string, media: MediaInput): Promise<void> {
    return this.groups.setGroupPicture(groupId, media);
  }

  deleteGroupPicture(groupId: string): Promise<void> {
    return this.groups.deleteGroupPicture(groupId);
  }

  setGroupEphemeral(groupId: string, durationSec: number): Promise<void> {
    return this.groups.setGroupEphemeral(groupId, durationSec);
  }

  // ========== Status/Stories (Phase 3) ==========
  // Note: These are stub implementations - whatsapp-web.js has limited Status API support

  getContactStatuses(): Promise<Status[]> {
    return this.statuses.getContactStatuses();
  }

  getContactStatus(contactId: string): Promise<Status[]> {
    return this.statuses.getContactStatus(contactId);
  }

  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    return this.statuses.postTextStatus(text, options);
  }

  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.statuses.postImageStatus(media, options);
  }

  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.statuses.postVideoStatus(media, options);
  }

  postVoiceStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.statuses.postVoiceStatus(media, options);
  }

  deleteStatus(statusId: string): Promise<void> {
    return this.statuses.deleteStatus(statusId);
  }

  // ========== Catalog (Phase 3) ==========
  // whatsapp-web.js has no Catalog API at all (no Client.getCatalog/getProducts/getProduct symbol in
  // index.d.ts). These used to be phantom stubs — a warn log plus null/empty results — so the API
  // reported "no catalog" / "no products" for a capability that never ran. Honest 501s instead,
  // matching sendProduct/sendCatalog below.

  getCatalog(): Promise<Catalog | null> {
    return this.catalog.getCatalog();
  }

  getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return this.catalog.getProducts(_options);
  }

  getProduct(_productId: string): Promise<Product | null> {
    return this.catalog.getProduct(_productId);
  }

  sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    return this.catalog.sendProduct(_chatId, _productId, _body);
  }

  sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    return this.catalog.sendCatalog(_chatId, _body);
  }

  getChats(): Promise<ChatSummary[]> {
    return this.chats.getChats();
  }

  sendSeen(chatId: string): Promise<boolean> {
    return this.chats.sendSeen(chatId);
  }

  archiveChat(chatId: string, archive: boolean): Promise<boolean> {
    return this.chats.archiveChat(chatId, archive);
  }

  clearChatMessages(chatId: string): Promise<boolean> {
    return this.chats.clearChatMessages(chatId);
  }

  markUnread(chatId: string): Promise<boolean> {
    return this.chats.markUnread(chatId);
  }

  deleteChat(chatId: string): Promise<boolean> {
    return this.chats.deleteChat(chatId);
  }

  sendChatState(chatId: string, state: ChatState): Promise<void> {
    return this.chats.sendChatState(chatId, state);
  }

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      // Typed so the global filter returns 409 Conflict ("session not connected")
      // instead of a 500 when an engine op is attempted while the session is
      // disconnected / reconnecting / still initializing (#100).
      throw new EngineNotReadyError();
    }
  }

  private ensureNotChannelRecipient(chatId: string): void {
    // whatsapp-web.js crashes building a channel media message (`msg.avParams is not a function`,
    // upstream wwebjs#201823 — WA Web removed Msg.avParams). Text→channel works; media does not.
    // Fail fast with a typed 501 instead of surfacing the raw TypeError as a 500 (#673).
    if (isChannelJid(chatId)) {
      throw new ChannelMediaNotSupportedError();
    }
  }
}

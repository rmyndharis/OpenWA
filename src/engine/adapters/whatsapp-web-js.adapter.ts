import { EventEmitter } from 'events';
import { InternalServerErrorException } from '@nestjs/common';
import {
  Client,
  LocalAuth,
  MessageMedia,
  MessageTypes,
  WAState,
  type Call,
  type GroupNotification,
  type Message,
} from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
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
  GroupParticipant,
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
  DeliveryStatus,
  RevokedMessage,
  EditedMessage,
  ReactionEvent,
  GroupEvent,
  IncomingCallEvent,
} from '../interfaces/whatsapp-engine.interface';
import { resolveWebVersionPin } from '../wa-web-version';
import { isChannelJid, userPart } from '../identity/wa-id';
import { LidMappingStore } from '../identity/lid-mapping-store.service';
import { ChatLabelsUnsupportedError } from '../../common/errors/chat-labels-unsupported.error';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { ChannelMediaNotSupportedError } from '../../common/errors/channel-media-not-supported.error';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import {
  GroupChat,
  GroupMetadataRaw,
  MessageWithReactions,
  BusinessClient,
  WwjsChannelData,
  GroupCreateResult,
  SerializedWid,
} from '../types/whatsapp-web-js.types';
import { buildEditedMessage, buildIncomingMessageBase, mapContactFields } from './message-mapper';
import { buildVCard } from './vcard';
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
 * Map a whatsapp-web.js MessageAck integer to the neutral DeliveryStatus.
 * wwebjs: -1 ERROR, 0 PENDING, 1 SERVER (sent), 2 DEVICE (delivered), 3 READ, 4 PLAYED.
 * PLAYED collapses to `read` (preserving prior behaviour, which treated ack>=3 as read).
 */
export function wwebjsAckToDeliveryStatus(ack: number): DeliveryStatus {
  if (ack < 0) return 'failed';
  if (ack >= 3) return 'read';
  if (ack === 2) return 'delivered';
  if (ack === 1) return 'sent';
  return 'pending';
}

/**
 * Interpret the on/off value a group settings notification carries in `body` ('on'/'true' → true,
 * 'off'/'false' → false). Undefined when the body holds anything else (e.g. a rendered template
 * string), in which case the caller emits the update without that change rather than guess.
 */
function parseWwebjsOnOff(body: string): boolean | undefined {
  const v = body.trim().toLowerCase();
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  return undefined;
}

/**
 * Reduce a `group_update` GroupNotification to the neutral `changes` delta. `subject`/`description`
 * carry the new value in `body`; `announce`/`restrict` encode the new setting as on/off text (the
 * latter maps to the neutral `locked`). Anything uninterpretable — a `picture` change, or a WA Web
 * build that stops putting the value in `body` — yields an empty delta: the occurrence is still
 * emitted, just without fields we would be guessing at. Compared as strings because the runtime
 * gp2 subtypes can exceed the GroupNotificationTypes enum (e.g. a 'locked' rename of 'restrict').
 */
export function wwebjsGroupUpdateChanges(notification: GroupNotification): NonNullable<GroupEvent['changes']> {
  const body = typeof notification.body === 'string' ? notification.body : '';
  switch (String(notification.type)) {
    case 'subject':
      return { subject: body };
    case 'description':
      return { description: body };
    case 'announce': {
      const on = parseWwebjsOnOff(body);
      return on === undefined ? {} : { announce: on };
    }
    case 'restrict':
    case 'locked': {
      const on = parseWwebjsOnOff(body);
      return on === undefined ? {} : { locked: on };
    }
    default:
      return {};
  }
}

/**
 * A GroupNotification's `recipientIds` are assigned straight through from the wire
 * (`this.recipientIds = data.recipients`), outside upstream's id normalization — so on a WA Web
 * build that renamed `_serialized` to `$1` (#747) an entry can arrive as a raw id object instead
 * of a string. Coerce both shapes to the neutral (already @c.us/@g.us) string form; entries that
 * resolve to nothing are dropped rather than forwarded as "undefined".
 */
export function wwebjsGroupRecipientIds(notification: GroupNotification): string[] {
  const raw = notification.recipientIds as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(entry => {
      if (typeof entry === 'string') return entry;
      const wid = entry as SerializedWid | undefined;
      return wid?._serialized ?? wid?.$1 ?? '';
    })
    .filter(id => id.length > 0);
}

/**
 * Extract call detail from a whatsapp-web.js `call_log` message, or `undefined` for any other type.
 * The public Message wrapper doesn't expose call fields, so we read them off the raw `_data`. An
 * incoming call (`!fromMe`) with no recorded `callDuration` was never answered → missed; an outgoing
 * call is never "missed". Used by getChatHistory, where `call_log` entries actually appear.
 */
export function extractWwebjsCall(msg: Message): { video: boolean; missed: boolean } | undefined {
  if ((msg.type as string) !== 'call_log') return undefined;
  const d = (msg as unknown as { _data?: { isVideoCall?: boolean; callDuration?: number } })._data ?? {};
  return { video: Boolean(d.isVideoCall), missed: !msg.fromMe && !d.callDuration };
}

/**
 * Whether a per-session proxy URL parses to a supported scheme — defense-in-depth for a stored proxy
 * that bypassed DTO validation (e.g. loaded from the DB on restart). The host is NOT SSRF-blocked: a
 * per-session proxy is operator-chosen egress, and a loopback proxy sidecar is a legitimate setup.
 */
export function isSupportedProxyUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'socks4:', 'socks5:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export interface ProxyLaunchConfig {
  /** Credential-less `--proxy-server` value — Chromium ignores credentials embedded in this flag. */
  serverArg: string;
  /** Username/password for whatsapp-web.js's `proxyAuthentication` (→ `page.authenticate`, HTTP/HTTPS only). */
  proxyAuthentication?: { username: string; password: string };
  /** The URL carries credentials for a SOCKS proxy, which Chromium cannot authenticate at all. */
  socksAuthUnsupported: boolean;
}

/**
 * Split a proxy URL into a credential-less `--proxy-server` value plus, for an HTTP/HTTPS proxy, the
 * username/password to hand to whatsapp-web.js's `proxyAuthentication` (which calls `page.authenticate`
 * — the only way Chromium authenticates a proxy). Credentials embedded in `--proxy-server` are ignored
 * by Chromium, and SOCKS proxies cannot be authenticated at all, so SOCKS credentials are surfaced via
 * `socksAuthUnsupported` for the caller to warn about instead of failing with an opaque nav timeout (#628).
 * Call only with a URL that already passed {@link isSupportedProxyUrl}.
 */
export function buildProxyLaunchConfig(url: string): ProxyLaunchConfig {
  const parsed = new URL(url);
  const serverArg = `${parsed.protocol}//${parsed.host}`;
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const hasCredentials = username !== '' || password !== '';
  const isSocks = parsed.protocol === 'socks4:' || parsed.protocol === 'socks5:';
  if (hasCredentials && !isSocks) {
    return { serverArg, proxyAuthentication: { username, password }, socksAuthUnsupported: false };
  }
  return { serverArg, socksAuthUnsupported: hasCredentials && isSocks };
}

/**
 * Whether a MediaInput's string `data` is an http(s) URL (to be fetched through the SSRF-guarded
 * loadRemoteMedia) rather than base64. Case-insensitive, matching the Baileys adapter — a mixed-case
 * scheme like `HTTPS://` must still route through the guarded fetch, not be treated as base64.
 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

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
 * Fetch remote media for sending, with an SSRF host guard, a byte cap, and a timeout.
 * The guard runs BEFORE any network call, so an internal/reserved URL throws `SsrfBlockedError`
 * and no outbound socket is opened. The byte cap (node-fetch `size`) and `AbortSignal` timeout
 * bound memory use and hang time. `unsafeMime` is left at its default (false) to preserve the
 * existing MIME-detection behavior.
 */
export async function loadRemoteMedia(url: string): Promise<MessageMedia> {
  // Fetch through the SSRF-pinned path: it validates the host, pins the connection to the vetted IP
  // (so a DNS rebind can't redirect it to an internal target between check and connect), caps bytes,
  // and refuses redirects. We then build the MessageMedia from the returned bytes — NOT via
  // MessageMedia.fromUrl, whose bundled node-fetch performs its own unpinned DNS re-resolution.
  const { data, mimetype } = await loadRemoteMediaBuffer(url);
  const filename = new URL(url).pathname.split('/').pop() || undefined;
  return new MessageMedia(mimetype || 'application/octet-stream', data.toString('base64'), filename);
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

// WhatsApp Web version resolution (the #488 auto-resolve) lives in a dependency-free module so infra
// status can import it without loading whatsapp-web.js (engine lazy-loading). The adapter imports
// resolveWebVersionPin above for use in initialize().

/**
 * Optional override for whatsapp-web.js's initial boot/inject wait (#353). On slow first boots
 * (e.g. WSL2 or low-resource containers) the default 30s `authTimeoutMs` can expire before WhatsApp
 * Web finishes loading, aborting QR generation. Set WWEBJS_AUTH_TIMEOUT_MS to a larger value in
 * milliseconds (e.g. 120000) to extend it. Unset, or a value that is not a positive safe integer,
 * keeps the whatsapp-web.js default (30000ms).
 */
export function resolveAuthTimeoutMs(): number | undefined {
  const raw = process.env.WWEBJS_AUTH_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const ms = Number(raw);
  // Number.isSafeInteger rejects Infinity (from huge digit strings) and >2^53 unsafe integers — both
  // pass the /^\d+$/ shape check but would make whatsapp-web.js's inject loop wait effectively forever.
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

/**
 * Extracts the JID of the parent community a group is linked to, if any.
 * The field name has varied across whatsapp-web.js/WA Web versions, so
 * known candidates are checked in order.
 */
export function extractLinkedParentJID(groupMetadata?: GroupMetadataRaw): string | null {
  const candidate =
    groupMetadata?.parentGroup ?? groupMetadata?.linkedParentGroup ?? groupMetadata?.linkedParent ?? null;

  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    return candidate;
  }

  return candidate._serialized ?? null;
}

/**
 * True when a send error is whatsapp-web.js's "recipient needs a LID we don't have" failure, raised
 * when sending to a `@c.us` for a contact WhatsApp has migrated to `@lid`.
 * ponytail: matched on the wwjs error text — there is no structured code; revisit if wwjs changes it.
 */
export function isNoLidForUserError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('No LID for user');
}

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

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
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

  /**
   * Download inbound media safely. downloadMedia() can't be size-bounded at the source, so (1) pre-gate
   * on the sender-declared size and skip the download entirely when it exceeds the cap, and (2) run the
   * download through the concurrency limiter for backpressure. Returns undefined when there's no media.
   */
  private async capInboundMediaFor(msg: Message): Promise<IncomingMessage['media'] | undefined> {
    if (!isMediaDownloadEnabled()) {
      const data = (msg as unknown as { _data?: { size?: number; mimetype?: string; filename?: string } })._data;
      return {
        mimetype: data?.mimetype ?? '',
        filename: data?.filename || undefined,
        omitted: true,
        sizeBytes: coerceDeclaredSize(data?.size),
      };
    }
    const maxBytes = inboundMediaMaxBytes();
    const data = (msg as unknown as { _data?: { size?: number; mimetype?: string; filename?: string } })._data;
    const declared = coerceDeclaredSize(data?.size);
    if (declared > maxBytes) {
      this.logger.warn('Inbound media declared size exceeds MEDIA_DOWNLOAD_MAX_BYTES; skipped download', {
        msgId: msg.id._serialized,
        sizeBytes: declared,
      });
      return {
        mimetype: data?.mimetype ?? '',
        filename: data?.filename || undefined,
        omitted: true,
        sizeBytes: declared,
      };
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
      return {
        mimetype: data?.mimetype ?? '',
        filename: data?.filename || undefined,
        omitted: true,
        sizeBytes: declared,
      };
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

      // Pin the WA-Web version when configured (fixes the 1.34.x "stuck at authenticating"
      // hang on some setups, #251). Opt-in: unset leaves whatsapp-web.js to auto-select.
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
      await this.killOrphanedChromiumProcesses();
      // Clear stale Chromium Singleton* files left by a hard kill before launching — see
      // removeStaleSingletonFiles. This runs only at engine (re)start, never while
      // the browser is alive, so it cannot pull the files out from under a running Chromium.
      await this.removeStaleSingletonFiles();
      await this.client.initialize();
      // whatsapp-web.js 1.34.x never observes the Chromium process/page it drives, so a crashed
      // browser leaves the client looking READY forever ("silent death"). Attach death listeners
      // to the puppeteer handles so a dead browser surfaces as a normal disconnect → reconnect.
      this.attachPuppeteerLifecycleListeners();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      const reason = error instanceof Error ? error.message : String(error);
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
      }
      this.callbacks.onError?.(reason);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      // A 'qr' buffered by a wedged page can flush during the awaited client.destroy() (teardown sets
      // tearingDown + DISCONNECTED first) or after recoverFromStuckAuth() nulls this.client. Ignore it so a
      // late event can't resurrect a disconnecting adapter to QR_READY and re-emit a stale QR. Mirrors the
      // 'authenticated' guard below; the normal first QR is unaffected (not tearing down, not FAILED, client set).
      if (this.tearingDown || this.status === EngineStatus.FAILED || !this.client) {
        return;
      }
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      // Only the first authentication starts the reconcile window. Ignore a re-fired 'authenticated'
      // while already AUTHENTICATING (so it can't restart the 90s deadline), once READY/FAILED, or any
      // time during/after teardown (so a late event can't resurrect a disconnecting adapter). The
      // initial status is DISCONNECTED, so teardown is distinguished by the flag, not by DISCONNECTED.
      if (
        this.tearingDown ||
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
      this.markReadyFromClientInfo();
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message', async msg => {
      try {
        const incomingMessage: IncomingMessage = buildIncomingMessageBase(msg);

        // Attach the sender's contact info. getContact() gives the real sender (author in groups, from
        // in 1:1); we read only its synchronous fields and never the async getters (profile pic, about),
        // which would hit WhatsApp on every message.
        try {
          const contact = await msg.getContact();
          if (contact) {
            // Off by default the payload keeps { name, pushName }; WEBHOOK_CONTACT_DETAILS opts into the
            // full set. Merge over the base so the notifyName pushName isn't lost, and skip an empty
            // result so we don't emit an empty contact object.
            const full = process.env.WEBHOOK_CONTACT_DETAILS === 'true';
            const merged = { ...incomingMessage.contact, ...mapContactFields(contact, full) };
            if (Object.keys(merged).length > 0) {
              incomingMessage.contact = merged;
            }
          }
        } catch (error) {
          this.logger.error('Error getting message contact', String(error));
        }

        // Handle location
        if (msg.type === MessageTypes.LOCATION && msg.location) {
          incomingMessage.location = {
            latitude: Number(msg.location.latitude),
            longitude: Number(msg.location.longitude),
            description: msg.location.description || undefined,
            address: msg.location.address || undefined,
            url: msg.location.url || undefined,
          };
        }

        // Handle media
        if (msg.hasMedia) {
          try {
            const capped = await this.capInboundMediaFor(msg);
            if (capped) incomingMessage.media = capped;
          } catch (error) {
            this.logger.error('Error downloading media', String(error));
          }
        }

        // Handle quoted message
        if (msg.hasQuotedMsg) {
          try {
            const quoted = await msg.getQuotedMessage();
            incomingMessage.quotedMessage = {
              id: quoted.id._serialized,
              body: quoted.body,
            };
          } catch (error) {
            this.logger.error('Error getting quoted message', String(error));
          }
        }

        // Surface call-log detail on the live path too (getChatHistory already does this), so a missed/
        // video incoming call renders a labeled bubble instead of a generic "Call".
        const call = extractWwebjsCall(msg);
        if (call) incomingMessage.call = call;

        this.callbacks.onMessage?.(incomingMessage);
      } catch (error) {
        this.logger.error('Error processing incoming message', String(error));
      }
    });

    this.client.on('message_create', msg => {
      // `message_create` fires for every message the account creates — including ones composed on a
      // linked phone, which the `message` event above never delivers. Incoming messages are already
      // handled there, so forward only the account's own outgoing (`fromMe`) messages; this is the
      // single source for `message.sent` (covers API sends and phone-composed self-messages alike).
      if (!msg.fromMe) {
        return;
      }

      void (async () => {
        const incomingMessage = buildIncomingMessageBase(msg);
        // Enrich with the media payload through the same capped path the incoming handler uses —
        // the base builder is sync and carries none, so a phone-sent image would otherwise persist
        // and render as a bare 📎 marker even though the media is downloadable right here.
        if (msg.hasMedia) {
          try {
            incomingMessage.media = await this.capInboundMediaFor(msg);
          } catch (error) {
            this.logger.warn('Own-send media download failed; emitting echo without media', {
              msgId: msg.id?._serialized,
              error: String(error),
            });
          }
        }
        try {
          this.callbacks.onMessageCreate?.(incomingMessage);
        } catch (error) {
          this.logger.error('Error processing outgoing message', String(error));
        }
      })();
    });

    this.client.on('message_ack', (msg, ack) => {
      // An unreadable id (a WhatsApp Web build renaming the field, as in #747) would reach the ack
      // UPDATE as undefined, which TypeORM sends as `waMessageId = NULL` — matching nothing, since
      // `x = NULL` is never true. The ack then silently advances no row AND burns its one-shot retry,
      // so the message stays at SENT with only a misleading "no status row advanced" in the log. Drop
      // it here, where the reason is still visible. (Note this differs from the reaction path below,
      // where `findOne` DROPS an undefined key instead of nulling it and matches an arbitrary row.)
      // Read `$1` before giving up, as the send path does (#747): a build that renamed the field still
      // has a perfectly good id here, and dropping it strands the message at SENT — including the
      // `ack < 0` that is the only signal a send failed.
      const rawId = msg.id as unknown as SerializedWid | undefined;
      const ackId = rawId?._serialized ?? rawId?.$1;
      if (!ackId) {
        this.logger.warn('Dropping an ack whose message id could not be read', { ack });
        return;
      }
      // Map the whatsapp-web.js MessageAck integer to the neutral DeliveryStatus here, at the
      // adapter boundary, so no downstream consumer ever sees engine-specific ack codes.
      this.callbacks.onMessageAck?.(ackId, wwebjsAckToDeliveryStatus(ack));
    });

    this.client.on('message_revoke_everyone', (after, before) => {
      try {
        const selfWid = this.client?.info?.wid?._serialized;
        // Emit structured data only; the engine layer never produces a localized
        // display string. The dashboard renders the localized "message deleted" text.
        //
        // `after` is the revocation notification (its own id); `before` is the
        // ORIGINAL deleted message (when whatsapp-web.js has it in the local store).
        // We forward `before.id` as `revokedId` so consumers can reconcile the
        // deleted message in their own storage.
        // Both ids read `$1` before giving up (#747). `revokedId` needs it even on a patched tree:
        // `Client.js` overwrites the normalized id with a raw spread of `protocolMessageKey`
        // (`revoked_msg.id = { ...message.protocolMessageKey }`), and that key is normalized by
        // neither the structure constructor nor the injected serializer — so this is the one place a
        // patched build still hands us a raw MsgKey. Losing it strands the revocation: the UPDATE
        // falls back to the notification's own id, matches no row, and the deleted body stays put.
        const afterId = after.id as unknown as SerializedWid | undefined;
        const beforeId = before?.id as unknown as SerializedWid | undefined;
        const payload: RevokedMessage = {
          id: afterId?._serialized ?? afterId?.$1 ?? '',
          revokedId: beforeId?._serialized ?? beforeId?.$1,
          chatId: after.from === selfWid ? after.to : after.from,
          from: after.from,
          to: after.to,
          type: 'revoked',
          body: '',
          timestamp: after.timestamp,
        };
        this.callbacks.onMessageRevoked?.(payload);
      } catch (error) {
        this.logger.error('Error processing message_revoke_everyone', String(error));
      }
    });

    this.client.on('message_reaction', reaction => {
      try {
        // `Reaction` assigns its keys straight through (`this.msgId = data.parentMsgKey`), which
        // upstream's id normalization doesn't reach: it covers structure constructors and `msg.id`,
        // not keys assigned straight through (`Message.protocolMessageKey` and `Reaction.id` are the
        // same pattern). On a WA Web build that renamed `_serialized` to `$1` (#747),
        // `msgId._serialized` is undefined even with the backport applied.
        // Read `$1` as a fallback, and fall back again to `''` (the same no-id sentinel Baileys uses)
        // rather than pass undefined on: `applyReaction` looks the message up by this id, and TypeORM
        // DROPS an undefined condition from the where-clause — which would match an arbitrary row and
        // emit another message's reactions. Empty string finds nothing and returns cleanly.
        const msgId = reaction.msgId as unknown as SerializedWid;
        const event: ReactionEvent = {
          messageId: msgId?._serialized ?? msgId?.$1 ?? '',
          chatId: reaction.id.remote,
          reaction: reaction.reaction,
          senderId: reaction.senderId,
        };
        this.callbacks.onMessageReaction?.(event);
      } catch (error) {
        this.logger.error('Error processing message_reaction', String(error));
      }
    });

    this.client.on('message_edit', (message, newBody) => {
      try {
        // whatsapp-web.js keeps `message.timestamp` at the ORIGINAL creation time. Consumers need
        // occurrence time for ordering multiple edits, so stamp the edit at receipt and project the
        // otherwise-normal message fields through the same adapter mapper used by inbound messages.
        const editTimestamp = Math.floor(Date.now() / 1000);
        const base = buildIncomingMessageBase({
          id: message.id,
          from: message.from,
          to: message.to,
          body: String(newBody),
          type: message.type,
          timestamp: editTimestamp,
          fromMe: message.fromMe,
          author: message.author,
          mentionedIds: message.mentionedIds,
        });
        const payload: EditedMessage = buildEditedMessage(base, Boolean(message.hasMedia));
        this.callbacks.onMessageEdited?.(payload);
      } catch (error) {
        this.logger.error('Error processing message_edit', String(error));
      }
    });

    this.client.on('group_join', notification => this.handleGroupNotification('join', notification));
    this.client.on('group_leave', notification => this.handleGroupNotification('leave', notification));
    this.client.on('group_update', notification => this.handleGroupNotification('update', notification));

    this.client.on('call', call => this.handleIncomingCall(call));

    this.client.on('disconnected', reason => {
      this.clearReadyReconcile();
      this.setStatus(EngineStatus.DISCONNECTED);
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
      this.cacheLiveCall(call.id, call);
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
   */
  private cacheLiveCall(callId: string, call: Call): void {
    const now = Date.now();
    for (const [id, entry] of this.liveCalls) {
      if (entry.expiresAt <= now) {
        this.liveCalls.delete(id);
      }
    }
    this.liveCalls.set(callId, { call, expiresAt: now + WhatsAppWebJsAdapter.LIVE_CALL_TTL_MS });
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

  /**
   * Report a failed client/page operation as a session death when the error matches
   * PAGE_TRANSPORT_ERROR_PATTERN. A wedged page can fire NO events while still reporting CONNECTED
   * (whatsapp-web.js #5728), so the watchdog takes minutes to notice — an operation failing with one
   * of these errors is a much earlier death signal. Detection
   * only: the error itself still propagates to the caller exactly as before, and
   * handlePuppeteerDeath's guard makes this safe during teardown and against double-reporting.
   */
  private reportIfPageTransportError(error: unknown, context: string): void {
    const message = error instanceof Error ? error.message : String(error);
    if (!WhatsAppWebJsAdapter.PAGE_TRANSPORT_ERROR_PATTERN.test(message)) {
      return;
    }
    this.logger.warn(`Page transport error during ${context} — treating the session as dead`, {
      error: message,
    });
    this.handlePuppeteerDeath(`Page transport error during ${context}`);
  }

  private markReadyFromClientInfo(): void {
    if ([EngineStatus.READY, EngineStatus.DISCONNECTED, EngineStatus.FAILED].includes(this.status)) return;
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
        this.logger.warn(
          'Timed out waiting for WhatsApp Web runtime readiness after authentication — the saved session ' +
            'is stuck after the QR scan (usually the auto-selected WhatsApp Web build is incompatible). ' +
            'Clearing it to re-pair; pin a known-good version via WWEBJS_WEB_VERSION (see ' +
            'docs/12-troubleshooting-faq.md) if it keeps recurring.',
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
  }

  /**
   * Recover a session that authenticated but never reached runtime readiness (stale/incompatible auth
   * or a wedged page). Clear the broken LocalAuth and disconnect so the session lifecycle re-pairs (a
   * fresh QR) instead of hanging at "authenticating". Runs at most once per engine — a re-paired session
   * that still can't reach readiness fails terminally rather than looping.
   */
  private async recoverFromStuckAuth(): Promise<void> {
    if (this.stuckAuthRecoveryAttempted) {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onError?.(
        'WhatsApp Web could not reach readiness after re-pairing. Pin WWEBJS_WEB_VERSION to a known-good build and try again.',
      );
      return;
    }
    this.stuckAuthRecoveryAttempted = true;

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
    await fs.promises.rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      this.logger.warn(`Could not clear stale auth at ${dir}`, { error: String(error) });
    });
  }

  /**
   * SIGKILL any Chromium orphaned by a previous lifetime of this process. When OpenWA dies hard
   * (kill -9, crash, host reboot) Puppeteer's exit hook never runs, so the browser survives as an
   * orphan — leaking memory and pinning the session profile dir. Orphans are identified by the
   * `--openwa-session=<id>` marker arg appended to the puppeteer args at launch (Chromium ignores
   * the unknown flag; it is purely a `ps` label). Best-effort: never throws — a `ps` failure only
   * logs at debug, so the sweep can never block an engine start.
   */
  private async killOrphanedChromiumProcesses(): Promise<void> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      this.logger.debug(`Skipping orphaned Chromium sweep: unsupported platform ${process.platform}`);
      return;
    }
    try {
      // No shell: the args array is handed to ps verbatim, so nothing here is injectable.
      // maxBuffer is raised because `ps -eo args` prints full command lines, which on a busy host
      // (many Chromium renderers carrying dozens of flags each) can exceed the 1MB default.
      const psOutput = await new Promise<string>((resolve, reject) => {
        execFile('ps', ['-eo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
          // The @types/node ExecFileException is an Omit<> of ErrnoException, which the type
          // checker no longer recognises as an Error — narrow it explicitly for the reject.
          if (error) reject(error instanceof Error ? error : new Error(error.message));
          else resolve(stdout);
        });
      });
      const marker = `--openwa-session=${this.config.sessionId}`;
      const killedPids: number[] = [];
      for (const line of psOutput.split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const args = match[2];
        if (pid === process.pid || !args.includes(marker)) continue;
        // Never kill a non-browser process that happens to carry the marker string
        // (e.g. a `grep --openwa-session=…` probing the process table).
        if (!/chrome|chromium|headless/i.test(args)) continue;
        try {
          process.kill(pid, 'SIGKILL');
          killedPids.push(pid);
        } catch (error) {
          // ESRCH: the process exited between `ps` and the kill — nothing left to do.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            this.logger.debug(`Could not SIGKILL orphaned Chromium pid ${pid}`, { error: String(error) });
          }
        }
      }
      if (killedPids.length > 0) {
        this.logger.log(
          `Killed ${killedPids.length} orphaned Chromium process(es) left over from a previous process lifetime`,
          { sessionId: this.config.sessionId, pids: killedPids },
        );
      }
    } catch (error) {
      this.logger.debug('Could not enumerate processes for the orphaned Chromium sweep', { error: String(error) });
    }
  }

  /**
   * Remove Chromium's SingletonLock/SingletonSocket/SingletonCookie from the LocalAuth profile dir
   * (same dir clearLocalAuth removes) before the browser launches. A hard-killed Chromium
   * (SIGKILL/crash) leaves them behind, and on some setups (e.g. Docker PID reuse) the stale files
   * block the next launch unless they are cleared first. Best-effort: a removal
   * failure only logs at debug and never fails the start.
   */
  private async removeStaleSingletonFiles(): Promise<void> {
    const profileDir = path.join(path.resolve(this.config.sessionDataPath), `session-${this.config.sessionId}`);
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try {
        await fs.promises.rm(path.join(profileDir, name), { force: true });
      } catch (error) {
        this.logger.debug(`Could not remove stale ${name} from ${profileDir}`, { error: String(error) });
      }
    }
  }

  private async isClientRuntimeReady(): Promise<boolean> {
    if (!this.client) return false;
    if ((await this.client.getState()) !== WAState.CONNECTED) return false;
    if (!this.client.info?.wid?.user) return false;

    const page = (this.client as unknown as { pupPage?: { evaluate: <T>(fn: () => T) => Promise<T> } }).pupPage;
    const hasWWebJS = await page?.evaluate(
      () => typeof (window as unknown as { WWebJS?: unknown }).WWebJS !== 'undefined',
    );
    return hasWWebJS === true;
  }

  private setStatus(status: EngineStatus): void {
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
    const client = this.beginClientTeardown();
    if (!client) return;

    try {
      // Logout clears session data - user will need to scan QR again
      await client.logout();
    } catch (error) {
      this.logger.warn('Logout failed:', { error: String(error) });
      // Fall back to destroy if logout fails
      try {
        await client.destroy();
      } catch (destroyError) {
        this.logger.warn('Client destroy also failed during logout fallback', { error: String(destroyError) });
      }
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

  // Cache of resolved individual recipients: `<phone>@c.us` -> the id `sendMessage` accepts (a
  // `<lid>@lid` for a migrated contact, or the confirmed `@c.us` for a non-migrated one). `getNumberId`
  // is a rate-limited WhatsApp Web existence probe that also throws intermittently, so caching every
  // confirmed resolution keeps ordinary sends from re-probing on each message (#580). A `@lid` is
  // stable; a stale entry (a contact that migrates mid-session) self-heals via the retry in
  // `sendResolved`.
  // ponytail: unbounded Map, bounded in practice by distinct recipients per session; add an LRU only
  // if a session ever addresses a truly unbounded set of fresh numbers.
  private readonly resolvedSendIds = new Map<string, string>();

  /**
   * Resolve an individual (`@c.us`) recipient to the id whatsapp-web.js will accept. WhatsApp has
   * migrated some contacts to privacy-id addressing, for which `sendMessage` throws `No LID for user`
   * on the phone WID but accepts the `@lid` that `getNumberId` returns (#573). Any server-confirmed
   * resolution (a distinct `@lid` OR a confirmed non-migrated `@c.us`) is cached, since it is stable
   * and re-probing costs a rate-limited round-trip (#580); a `null`/thrown lookup is NOT cached so an
   * unregistered or transiently-flaky contact keeps being retried. Groups/channels and already-`@lid`
   * targets are returned unchanged, and any resolution failure falls back to the original id so a send
   * is never blocked on it.
   */
  private async resolveSendId(chatId: string): Promise<string> {
    if (!chatId.endsWith('@c.us')) {
      return chatId;
    }
    const cached = this.resolvedSendIds.get(chatId);
    if (cached) {
      return cached;
    }
    try {
      const wid = await this.getNumberId(chatId);
      if (wid) {
        this.resolvedSendIds.set(chatId, wid);
        if (wid.endsWith('@lid')) {
          // Persist the learned phone -> lid so the message read-path (resolveJidCandidates) can
          // bridge this contact's `@c.us` and `@lid` rows on a pure whatsapp-web.js deployment
          // (#583 R3). Fire-and-forget: resolution (and the send) must never block/fail on the write.
          void this.config.lidMappingStore
            ?.remember(userPart(wid), userPart(chatId), this.config.sessionId)
            ?.catch(() => {});
        }
        return wid;
      }
      return chatId;
    } catch {
      return chatId;
    }
  }

  /**
   * Resolve `chatId` and run `send` against the resolved id. If the send fails with `No LID for user`
   * — the signature of a contact whose cached/resolved id is stale (typically a `@c.us` for a contact
   * that has since migrated to `@lid`) — drop the mapping, re-resolve once, and retry only if the
   * fresh id differs, so a genuinely unreachable recipient surfaces its error instead of looping.
   */
  private async sendResolved<T>(chatId: string, send: (to: string) => Promise<T>): Promise<T> {
    const to = await this.resolveSendId(chatId);
    try {
      return await send(to);
    } catch (err) {
      // A transport-level failure means the page/browser is gone — report it as a death signal.
      // No-op for ordinary send errors; the retry/throw behavior below is unchanged.
      this.reportIfPageTransportError(err, 'sendMessage');
      if (!chatId.endsWith('@c.us') || !isNoLidForUserError(err)) {
        throw err;
      }
      this.resolvedSendIds.delete(chatId);
      const fresh = await this.resolveSendId(chatId);
      if (fresh === to) {
        throw err;
      }
      return send(fresh);
    }
  }

  async sendTextMessage(chatId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    this.ensureReady();
    // wwebjs accepts neutral `<phone>@c.us` WIDs directly as mentionedJidList, so no de-normalization
    // is needed. Omit the options object entirely when none are given to keep today's send behavior.
    const msg = await this.sendResolved(chatId, to =>
      mentions?.length ? this.client!.sendMessage(to, text, { mentions }) : this.client!.sendMessage(to, text),
    );
    return this.toMessageResult(msg);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media, media.ptt ? { sendAudioAsVoice: true } : undefined);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMediaMessage(chatId, media);
  }

  private async sendMediaMessage(
    chatId: string,
    media: MediaInput,
    extraOptions?: { sendAudioAsVoice?: boolean },
  ): Promise<MessageResult> {
    this.ensureReady();
    this.ensureNotChannelRecipient(chatId);

    // Build the media once (a remote URL is fetched here); sendResolved may retry the send itself.
    const messageMedia = await this.toMessageMedia(media);
    const msg = await this.sendResolved(chatId, to =>
      this.client!.sendMessage(to, messageMedia, {
        caption: media.caption,
        ...(media.mentions?.length ? { mentions: media.mentions } : {}),
        // sendAudioAsVoice only for audio; {...undefined} contributes no keys.
        ...extraOptions,
      }),
    );

    return this.toMessageResult(msg);
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    try {
      const contacts = await this.client!.getContacts();

      return contacts.map(c => ({
        id: c.id._serialized,
        name: c.name || undefined,
        pushName: c.pushname || undefined,
        number: c.number,
        isMyContact: c.isMyContact,
        isBlocked: c.isBlocked,
      }));
    } catch (error) {
      this.reportIfPageTransportError(error, 'getContacts');
      throw error;
    }
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    try {
      const contact = await this.client!.getContactById(contactId);
      return {
        id: contact.id._serialized,
        name: contact.name || undefined,
        pushName: contact.pushname || undefined,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBlocked: contact.isBlocked,
      };
    } catch (error) {
      this.logger.warn(`Failed to get contact: ${contactId}`, { error: String(error) });
      return null;
    }
  }

  async getNumberId(number: string): Promise<string | null> {
    this.ensureReady();
    try {
      const numberId = await this.client!.getNumberId(number);
      return numberId?._serialized ?? null;
    } catch (error) {
      this.reportIfPageTransportError(error, 'getNumberId');
      throw error;
    }
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      // Queried one id at a time: the batch form is prone to "Evaluation failed" and rate-limiting
      // (whatsapp-web.js #3857/#3969). `pn` is the phone JID (`<digits>@c.us`) when the account knows
      // the mapping; best-effort, so a missing mapping or any failure resolves to null.
      const [result] = await this.client!.getContactLidAndPhone([contactId]);
      const pn = result?.pn;
      return pn ? pn.replace(/@c\.us$/i, '').replace(/\D/g, '') || null : null;
    } catch (error) {
      this.logger.debug(`resolveContactPhone failed for ${contactId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    try {
      const chats = await this.client!.getChats();

      // Filter only group chats
      const groups = chats.filter(chat => chat.isGroup);

      // List path: read linkedParentJID synchronously from whatever metadata getChats()
      // already loaded. We deliberately do NOT fall back to getChatById per group here —
      // that would be an N+1 round-trip across every group on every list call. Groups
      // whose metadata isn't loaded report null; the single-group endpoint (getGroupInfo,
      // which loads full metadata via getChatById) is the authoritative source.
      return groups.map(g => {
        const groupChat = g as unknown as GroupChat;
        return {
          id: g.id._serialized,
          name: g.name,
          participantsCount: groupChat.participants?.length,
          isAdmin: groupChat.participants?.some(
            p => p.isAdmin && p.id._serialized === this.client?.info?.wid?._serialized,
          ),
          linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
        };
      });
    } catch (error) {
      this.reportIfPageTransportError(error, 'getGroups');
      throw error;
    }
  }

  // ============= Phase 3: Extended Messaging =============

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Location class dynamically from whatsapp-web.js
    const module = await import('whatsapp-web.js');
    const Location = module.Location || module.default?.Location;

    const loc = new Location(location.latitude, location.longitude, {
      name: location.description || '',
      address: location.address || '',
    });
    const msg = await this.sendResolved(chatId, to => this.client!.sendMessage(to, loc));
    return this.toMessageResult(msg);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    // Shared builder sanitizes name/number (strips CR/LF, digits-only waid) so a crafted contact
    // can't inject extra vCard fields — the previous inline build interpolated raw values.
    const vcard = buildVCard(contact);

    const msg = await this.sendResolved(chatId, to =>
      this.client!.sendMessage(to, vcard, {
        parseVCards: true,
      }),
    );
    return this.toMessageResult(msg);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    // Sticker has its own send path (sendMediaAsSticker), not the sendMediaMessage funnel, but it
    // hits the same channel crash: for a channel wwjs drops the sticker form and runs processMediaData
    // with sendToChannel, which still ends at msg.avParams() (Utils.js:518). Guard it too (#673).
    this.ensureNotChannelRecipient(chatId);
    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (isHttpUrl(media.data)) {
        messageMedia = await loadRemoteMedia(media.data);
      } else {
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    const msg = await this.sendResolved(chatId, to =>
      this.client!.sendMessage(to, messageMedia, {
        sendMediaAsSticker: true,
      }),
    );
    return this.toMessageResult(msg);
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    this.ensureReady();
    // Import Poll dynamically like Location; the .default fallback covers builds where the
    // classes land on module.default (a plain `module.Poll` would be undefined there and
    // `new Poll` fails with "not a constructor").
    const module = await import('whatsapp-web.js');
    const Poll = module.Poll || module.default?.Poll;

    // wwebjs's typings mark `messageSecret` as required, but at runtime it is optional (it is
    // only used as a custom poll id), so cast to the constructor's options type to pass just
    // allowMultipleAnswers.
    type PollSendOptions = ConstructorParameters<typeof Poll>[2];
    const pollOptions = { allowMultipleAnswers: poll.allowMultipleAnswers === true } as PollSendOptions;
    const msg = await this.sendResolved(chatId, to =>
      this.client!.sendMessage(to, new Poll(poll.name, poll.options, pollOptions)),
    );
    return this.toMessageResult(msg);
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    try {
      // Find the message to quote
      const chat = await this.client!.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 100 });
      const quotedMsg = messages.find(m => m.id._serialized === quotedMsgId);

      if (!quotedMsg) {
        throw new MessageNotFoundError(quotedMsgId);
      }

      // Reply's send leg hits the same `No LID for user` path as a normal send for a migrated contact,
      // so route it through sendResolved (resolve @c.us->@lid, cache, self-heal). reply(content, chatId)
      // accepts an explicit target (#583 R1).
      const msg = await this.sendResolved(chatId, to => quotedMsg.reply(text, to));
      return this.toMessageResult(msg);
    } catch (error) {
      this.reportIfPageTransportError(error, 'replyToMessage');
      throw error;
    }
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(fromChatId);
      const messages = await chat.fetchMessages({ limit: 100 });
      const msgToForward = messages.find(m => m.id._serialized === messageId);

      if (!msgToForward) {
        throw new MessageNotFoundError(messageId);
      }

      // The forward's send leg fails with `No LID for user` for a LID-migrated destination, so resolve
      // it (and self-heal a stale mapping) via sendResolved. Capture the id actually sent to so the
      // id-recovery below reads back from the SAME (resolved) chat, not the raw @c.us (#583 R1).
      let resolvedTo = toChatId;
      await this.sendResolved(toChatId, to => {
        resolvedTo = to;
        return msgToForward.forward(to);
      });

      // whatsapp-web.js's forward() returns void, so BEST-EFFORT recover the REAL id of the sent copy by
      // reading it back from the destination chat (the most recent outgoing message). The delivery-ack
      // matcher keys on this id, so a synthetic one would leave the forward stuck at SENT; Baileys already
      // returns the real id. The forward already succeeded here, so recovery must NEVER fail the operation.
      // When the copy can't be identified we return an explicit-unknown id (empty): message.service then
      // leaves the row's waMessageId unset so no ack can mis-match it — unlike a synthetic or source id,
      // which could cross-drive another row's delivery status. Concurrent forwards to the same chat may
      // mis-identify the copy — acceptable for delivery-status accuracy.
      try {
        const destChat = await this.client!.getChatById(resolvedTo);
        const sentByMe = (await destChat?.fetchMessages({ limit: 5, fromMe: true })) ?? [];
        let sent: (typeof sentByMe)[number] | undefined;
        for (const m of sentByMe) {
          if (!sent || m.timestamp > sent.timestamp) {
            sent = m;
          }
        }
        if (sent) {
          return this.toMessageResult(sent);
        }
      } catch (error) {
        // Still surface a dead page even though the send itself succeeded (detection only; the
        // forward's best-effort recovery contract is unchanged).
        this.reportIfPageTransportError(error, 'forwardMessage');
        this.logger.warn(`Forward succeeded but recovering the sent message id failed: ${String(error)}`);
      }
      return { id: '', timestamp: Math.floor(Date.now() / 1000) };
    } catch (error) {
      this.reportIfPageTransportError(error, 'forwardMessage');
      throw error;
    }
  }

  // ============= Phase 3: Group Management =============

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(groupId);
      if (!chat.isGroup) {
        return null;
      }
      const groupChat = chat as unknown as GroupChat;
      const participants: GroupParticipant[] = (groupChat.participants || []).map(p => ({
        id: String(p.id._serialized),
        number: String(p.id.user),
        name: p.name ? String(p.name) : undefined,
        isAdmin: Boolean(p.isAdmin),
        isSuperAdmin: Boolean(p.isSuperAdmin),
      }));

      return {
        id: chat.id._serialized,
        name: chat.name,
        description: groupChat.description ? String(groupChat.description) : undefined,
        owner: groupChat.owner?._serialized ? String(groupChat.owner._serialized) : undefined,
        createdAt: groupChat.createdAt,
        participants,
        isReadOnly: Boolean(groupChat.isReadOnly),
        isAnnounce: Boolean(groupChat.isAnnounce),
        announce: groupChat.groupMetadata?.announce,
        locked: groupChat.groupMetadata?.restrict,
        ephemeralSeconds: groupChat.groupMetadata?.ephemeralDuration,
        linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group: ${groupId}`, { error: String(error) });
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    // whatsapp-web.js reports a failed creation by RESOLVING with a plain string
    // ('CreateGroupError: …', Client.js:2376) rather than throwing, and its own typings say so
    // (`Promise<CreateGroupResult | string>`). Reading `.gid` straight off that string threw an opaque
    // TypeError and discarded the reason upstream actually gave us; surface it instead.
    if (typeof result === 'string') {
      throw new Error(result);
    }
    const gid = (result as unknown as GroupCreateResult).gid as SerializedWid | undefined;
    const groupId = gid?._serialized ?? gid?.$1;
    // A group id is not ack-safe the way a message id is: there is no empty-sentinel equivalent, and any
    // placeholder would be handed back as a real, addressable group. Fail instead of inventing one.
    if (!groupId) {
      throw new Error('the group was created but its id could not be read');
    }
    return {
      id: groupId,
      name: name,
      participantsCount: participants.length,
    };
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).addParticipants(participantIds);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).removeParticipants(participantIds);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).promoteParticipants(participantIds);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    await (chat as unknown as GroupChat).demoteParticipants(participantIds);
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).leave();
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setSubject(subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error('Chat is not a group');
    }
    await (chat as unknown as GroupChat).setDescription(description);
  }

  // Reactions (Phase 3)
  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    try {
      // NOTE: do NOT resolve chatId to @lid here — whatsapp-web.js reacts using the found message's own
      // id, not this chatId, so LID-resolving the lookup gives no send benefit and would miss a message
      // stored under the pre-migration @c.us chat (#583 R1 review).
      const chat = await this.client!.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 100 });
      const message = messages.find(m => m.id._serialized === messageId);
      if (!message) {
        throw new MessageNotFoundError(messageId, chatId);
      }
      await (message as MessageWithReactions).react(emoji);
      this.logger.log(`Reacted to message ${messageId} with ${emoji || '(removed)'}`);
    } catch (error) {
      this.reportIfPageTransportError(error, 'reactToMessage');
      throw error;
    }
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId);
    if (!message) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    const msgWithReactions = message as MessageWithReactions;
    if (!msgWithReactions.hasReaction) {
      return [];
    }
    const reactions = await msgWithReactions.getReactions();
    if (!reactions) {
      return [];
    }
    // Map reactions to our interface format
    const result: MessageReaction[] = [];

    for (const r of reactions) {
      result.push({
        emoji: String(r.id),
        senders: (r.senders || []).map(s => ({
          senderId: String(s.senderId),
          emoji: String(s.reaction),
          timestamp: Number(s.timestamp),
        })),
      });
    }
    return result;
  }

  // Labels (Phase 3) - WhatsApp Business only
  async getLabels(): Promise<Label[]> {
    this.ensureReady();
    const labels = await (this.client as unknown as BusinessClient).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.ensureReady();
    const label = await (this.client as unknown as BusinessClient).getLabelById(labelId);
    if (!label) {
      return null;
    }
    return {
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    };
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    this.ensureReady();
    if (isChannelJid(chatId)) {
      // A channel resolves to a wwebjs `Channel`, which has no getLabels() and carries no chat labels.
      // Return empty instead of letting the unguarded call throw a TypeError (HTTP 500).
      return [];
    }
    const chat = await this.client!.getChatById(chatId);
    const labels = await (chat as unknown as GroupChat).getLabels();
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.changeChatLabel(chatId, labelId, true);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.changeChatLabel(chatId, labelId, false);
  }

  /**
   * whatsapp-web.js has no add-/remove-one-label primitive: `client.addOrRemoveLabels(ids, chats)` REPLACES
   * a chat's label set with `ids` (adding the listed labels, removing any existing label not listed). So
   * toggle a single label by reading the current set, mutating it, and writing the whole set back.
   * Labels are a WhatsApp Business feature — the write throws `[LT01]` on a personal account; channels
   * carry no labels at all. Both are surfaced as a 422 rather than an opaque 500.
   *
   * The read and write are separate calls, so two concurrent single-label writes to the SAME chat can
   * lose an update (last write wins, as a full-set replace). Acceptable for low-frequency label admin;
   * serialize per (sessionId, chatId) if that ever becomes a real workload.
   */
  private async changeChatLabel(chatId: string, labelId: string, add: boolean): Promise<void> {
    if (isChannelJid(chatId)) {
      throw new ChatLabelsUnsupportedError('Channels do not support chat labels.');
    }
    const ids = new Set((await this.getChatLabels(chatId)).map(label => label.id));
    if (add) {
      ids.add(labelId);
    } else {
      ids.delete(labelId);
    }
    try {
      await this.client!.addOrRemoveLabels([...ids], [chatId]);
    } catch (error) {
      // whatsapp-web.js throws `[LT01] Only Whatsapp business` from the page context on a personal account.
      if (String(error instanceof Error ? error.message : error).includes('LT01')) {
        throw new ChatLabelsUnsupportedError();
      }
      throw error;
    }
    this.logger.log(`${add ? 'Added' : 'Removed'} label ${labelId} ${add ? 'to' : 'from'} chat ${chatId}`);
  }

  // Channels/Newsletter (Phase 3)
  async getSubscribedChannels(): Promise<Channel[]> {
    this.ensureReady();
    const channels = await (this.client as unknown as BusinessClient).getChannels();
    if (!channels) {
      return [];
    }
    return channels.map((ch: WwjsChannelData) => ({
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
      verified: ch.verified ? Boolean(ch.verified) : undefined,
    }));
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    // wwebjs 1.34.x exposes no client.getChannelById; resolve from the subscribed-channel list (#625).
    const channels = await this.getSubscribedChannels();
    return channels.find(c => c.id === channelId) ?? null;
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const ch = await (this.client as unknown as BusinessClient).subscribeToChannel(inviteCode);
    this.logger.log(`Subscribed to channel with invite code: ${inviteCode}`);
    return {
      id: String(typeof ch.id === 'object' ? ch.id._serialized : ch.id),
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
    };
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    await (this.client as unknown as BusinessClient).unsubscribeFromChannel(channelId);
    this.logger.log(`Unsubscribed from channel: ${channelId}`);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.ensureReady();
    // wwebjs 1.34.x has no client.getChannelById (calling it threw and the error was swallowed into an
    // empty list, #625). The subscribed Channel instances returned by getChannels() carry fetchMessages(),
    // so resolve the channel from that list and read its messages. A missing channel surfaces as a
    // ChannelNotFoundError (→ 404, like getChannelById) so callers can tell "no messages" apart from
    // "wrong/unsubscribed channel" instead of getting a silent [].
    const channels = await (this.client as unknown as BusinessClient).getChannels();
    const channel = channels?.find(c => (typeof c.id === 'object' ? c.id._serialized : c.id) === channelId);
    if (!channel) {
      throw new ChannelNotFoundError(channelId);
    }
    const messages = await channel.fetchMessages({ limit });
    return (messages ?? []).map(msg => ({
      // Read `$1` before the sentinel (#747), and don't `String()` the object branch: that turned an
      // unreadable id into the literal "undefined" rather than the empty sentinel every other path
      // uses. Read-only endpoint — never persisted, never ack-matched — so `''` carries no collision
      // risk here; it just means "id unreadable".
      id: (typeof msg.id === 'object' ? (msg.id?._serialized ?? msg.id?.$1) : msg.id) || '',
      body: String(msg.body || ''),
      timestamp: Number(msg.timestamp),
      hasMedia: Boolean(msg.hasMedia),
      mediaUrl: msg.mediaUrl ? String(msg.mediaUrl) : undefined,
    }));
  }

  // ========== Gap Quick Wins Implementation ==========

  async getChatHistory(chatId: string, limit: number = 50, includeMedia: boolean = false): Promise<IncomingMessage[]> {
    this.ensureReady();
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    const results: IncomingMessage[] = [];
    for (const msg of messages) {
      // Reuse the shared mapper so history messages carry the same author/contact
      // enrichment as live incoming messages (#223). The mapper defaults chatId to
      // msg.from, which is wrong here (history includes fromMe messages whose `from`
      // is our own number), so override it to the requested chat and recompute the
      // chatId-derived flags (isGroup, isStatusBroadcast) from the real chat.
      const out = buildIncomingMessageBase(msg);
      out.chatId = chatId;
      out.isGroup = chatId.endsWith('@g.us');
      out.isStatusBroadcast = chatId === 'status@broadcast';
      const call = extractWwebjsCall(msg);
      if (call) out.call = call;
      // Mirror the live handler's location + quoted-message enrichment so history renders identically —
      // buildIncomingMessageBase sets type='location' but no coordinates, and never resolves quotes.
      if (msg.type === MessageTypes.LOCATION && msg.location) {
        out.location = {
          latitude: Number(msg.location.latitude),
          longitude: Number(msg.location.longitude),
          description: msg.location.description || undefined,
          address: msg.location.address || undefined,
          url: msg.location.url || undefined,
        };
      }
      if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          out.quotedMessage = { id: quoted.id._serialized, body: quoted.body };
        } catch (error) {
          this.logger.warn(`Failed to resolve quoted message for ${msg.id._serialized}: ${String(error)}`);
        }
      }
      if (includeMedia && msg.hasMedia) {
        try {
          // Same pre-gate + limiter as live media: a large historical blob shouldn't bloat the response/heap.
          const capped = await this.capInboundMediaFor(msg);
          if (capped) out.media = capped;
        } catch (error) {
          this.logger.warn(`Failed to download media for ${msg.id._serialized}: ${String(error)}`);
        }
      }
      results.push(out);
    }
    return results;
  }

  // Delete Message
  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    this.ensureReady();
    // NOTE: do NOT resolve chatId to @lid here — delete operates on the found message's own key, not
    // this chatId, so LID-resolving the lookup gives no benefit and would miss a message stored under
    // the pre-migration @c.us chat (#583 R1 review).
    const chat = await this.client!.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    await message.delete(forEveryone);
    this.logger.log(`Deleted message ${messageId} from chat ${chatId} (forEveryone: ${forEveryone})`);
  }

  // Edit Message
  async editMessage(chatId: string, messageId: string, body: string): Promise<MessageResult> {
    this.ensureReady();
    // Same lookup window as react/delete: fetchMessages sees only the 100 most recent messages.
    // NOTE: do NOT resolve chatId to @lid here — edit operates on the found message's own key, not
    // this chatId, so LID-resolving the lookup would miss a message stored under the pre-migration
    // @c.us chat (#583 R1 review).
    const chat = await this.client!.getChatById(chatId);
    // getChatById RESOLVES undefined for an unknown chat (wwebjs does not throw) — that is the same
    // client-facing outcome as a message outside the fetch window, not a TypeError (-> 500).
    if (!chat) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    const messages = await chat.fetchMessages({ limit: 100 });
    const message = messages.find(m => m.id._serialized === messageId || m.id.id === messageId);
    if (!message) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    const edited = await message.edit(body);
    if (!edited) {
      // wwebjs RESOLVES null (instead of throwing) when the page-side edit is refused — only the
      // account's own text messages are editable; surface the refusal, not a phantom success.
      throw new EngineRefusedError(
        `the edit of message ${messageId} was rejected — only the account's own text messages can be edited`,
      );
    }
    this.logger.log(`Edited message ${messageId} in chat ${chatId}`);
    return this.toMessageResult(edited);
  }

  // Get Profile Picture
  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const url = await this.client!.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
      this.reportIfPageTransportError(error, 'getProfilePicture');
      this.logger.warn(`Failed to get profile picture for ${contactId}: ${String(error)}`);
      return null;
    }
  }

  // Block Contact
  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.block();
    this.logger.log(`Blocked contact ${contactId}`);
  }

  // Unblock Contact
  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    const contact = await this.client!.getContactById(contactId);
    await contact.unblock();
    this.logger.log(`Unblocked contact ${contactId}`);
  }

  // ========== Profile (own account) ==========

  async setProfileName(name: string): Promise<void> {
    this.ensureReady();
    // setDisplayName resolves false (rather than throwing) when WhatsApp refuses the rename.
    const ok = await this.client!.setDisplayName(name);
    if (!ok) {
      throw new EngineRefusedError('the engine rejected the profile name change');
    }
    this.logger.log('Updated profile name');
  }

  async setProfileStatus(status: string): Promise<void> {
    this.ensureReady();
    await this.client!.setStatus(status);
    this.logger.log('Updated profile status');
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    this.ensureReady();
    const messageMedia = await this.toMessageMedia(media);
    // setProfilePicture resolves false (rather than throwing) when the upload is refused.
    const ok = await this.client!.setProfilePicture(messageMedia);
    if (!ok) {
      throw new EngineRefusedError('the engine rejected the profile picture change');
    }
    this.logger.log('Updated profile picture');
  }

  // Get Group Invite Code
  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const inviteCode = await (chat as unknown as GroupChat).getInviteCode();
    this.logger.log(`Got invite code for group ${groupId}`);
    return String(inviteCode);
  }

  // Revoke Group Invite Code
  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    if (!chat.isGroup) {
      throw new Error(`${groupId} is not a group`);
    }
    const newCode = await (chat as unknown as GroupChat).revokeInvite();
    this.logger.log(`Revoked invite code for group ${groupId}, new code generated`);
    return String(newCode);
  }

  // Join Group via Invite Code
  async joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    this.ensureReady();
    // acceptInvite throws a page-side evaluation error when the invite is refused (invalid/expired/
    // revoked); otherwise it resolves the joined group's id (`res.gid._serialized || res.gid.$1`,
    // Client.js:1836-1845) — already the neutral `<id>@g.us` dialect. A gid-less result is the same
    // client-facing outcome as a thrown refusal: no such invite (400, not a 500).
    let groupId: string | undefined;
    try {
      groupId = await this.client!.acceptInvite(inviteCode);
    } catch {
      groupId = undefined;
    }
    if (!groupId) {
      throw new InvalidInviteCodeError();
    }
    this.logger.log(`Joined group ${groupId} via invite code`);
    return groupId;
  }

  /** Resolve a group chat or throw — the shared preamble of the group settings writes. */
  private async requireGroupChat(groupId: string): Promise<GroupChat> {
    this.ensureReady();
    const chat = await this.client!.getChatById(groupId);
    // getChatById RESOLVES undefined for an unknown id (wwebjs does not throw): unknown id and a
    // non-group id are the same client-facing outcome — there is no such group (404, not a 500).
    if (!chat?.isGroup) {
      throw new GroupNotFoundError(groupId);
    }
    return chat as unknown as GroupChat;
  }

  // Set "only admins can send messages" (announce)
  async setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    const groupChat = await this.requireGroupChat(groupId);
    // Resolves false instead of throwing when the account lacks admin rights (GroupChat.js:503) —
    // surface that as an error rather than a silent no-op.
    const ok = await groupChat.setMessagesAdminsOnly(adminsOnly);
    if (!ok) {
      throw new EngineRefusedError(
        `Failed to update the messages-admins-only setting for group ${groupId} — admin rights required`,
      );
    }
  }

  // Set "only admins can edit group info" (locked/restrict)
  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    const groupChat = await this.requireGroupChat(groupId);
    const ok = await groupChat.setInfoAdminsOnly(adminsOnly);
    if (!ok) {
      throw new EngineRefusedError(
        `Failed to update the info-admins-only setting for group ${groupId} — admin rights required`,
      );
    }
  }

  // whatsapp-web.js 1.34.7 exposes no disappearing-messages setter (no Client/GroupChat symbol in
  // index.d.ts; only a create-time messageTimer option, Client.js:2371) — an honest 501, not a no-op.
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async setGroupEphemeral(_groupId: string, _durationSec: number): Promise<void> {
    this.ensureReady();
    throw new EngineNotSupportedError('setGroupEphemeral');
  }

  // ========== Status/Stories (Phase 3) ==========
  // Note: These are stub implementations - whatsapp-web.js has limited Status API support
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getContactStatuses(): Promise<Status[]> {
    this.ensureReady();
    return this.collectStatuses(await this.client!.getBroadcasts());
  }

  async getContactStatus(contactId: string): Promise<Status[]> {
    this.ensureReady();
    // A contact with no active 24h story resolves to an "empty" Broadcast (id/msgs/getContact
    // undefined — Broadcast._patch only runs when data is truthy). That is the common case, so guard
    // it: return [] rather than dereferencing undefined inside collectStatuses (→ 500).
    const broadcast = await this.client!.getBroadcastById(contactId);
    return broadcast?.msgs?.length ? this.collectStatuses([broadcast]) : [];
  }

  /**
   * Map whatsapp-web.js story Broadcasts (+ their Messages) into the neutral Status shape. Each
   * Broadcast is one contact's story (its `msgs`); we flatten across broadcasts. type collapses to
   * the Status union (image/video, else text — audio/other stories are rare and become 'text').
   * expiresAt is timestamp + 24h (WhatsApp status TTL). Broadcasts without msgs are skipped (a story
   * that expired between getBroadcasts and here, or a phantom entry).
   */
  private async collectStatuses(
    broadcasts: ReadonlyArray<{
      msgs?: Message[];
      getContact: () => Promise<{ id: { _serialized: string }; name?: string; pushname?: string }>;
    }>,
  ): Promise<Status[]> {
    const statuses: Status[] = [];
    for (const broadcast of broadcasts) {
      if (!broadcast?.msgs?.length) {
        continue;
      }
      const contact = await broadcast.getContact();
      const contactSummary = {
        id: contact.id._serialized,
        ...(contact.name ? { name: contact.name } : {}),
        ...(contact.pushname ? { pushName: contact.pushname } : {}),
      };
      for (const msg of broadcast.msgs) {
        const ts = new Date(msg.timestamp * 1000);
        statuses.push({
          // `deleteStatus` takes this id as its revoke handle, so losing it to the rename makes a
          // listed status unactionable (#747). The contact id above is a Wid and is unaffected.
          id: ((msg.id as unknown as SerializedWid)?._serialized ?? (msg.id as unknown as SerializedWid)?.$1) || '',
          contact: contactSummary,
          type: msg.type === MessageTypes.IMAGE ? 'image' : msg.type === MessageTypes.VIDEO ? 'video' : 'text',
          ...(msg.body ? { caption: msg.body } : {}),
          timestamp: ts,
          expiresAt: new Date(ts.getTime() + 24 * 3_600_000),
        });
      }
    }
    return statuses;
  }

  private warnedStatusRecipients = false;

  async postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    this.ensureReady();
    this.warnStatusRecipientsOnce(options);
    // whatsapp-web.js posts a text status by messaging status@broadcast with styling in `extra`
    // (Client.js maps options.extra → page extraOptions → sendStatusTextMsgAction in Utils.js).
    // backgroundColor is a #RRGGBB hex; font is the fontStyle index 0-7.
    const msg = await this.client!.sendMessage('status@broadcast', text, {
      extra: {
        ...(options.backgroundColor !== undefined ? { backgroundColor: options.backgroundColor } : {}),
        ...(options.font !== undefined ? { fontStyle: options.font } : {}),
      },
    });
    return this.toStatusResult(msg);
  }

  async postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus(media, options);
  }

  async postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus(media, options);
  }

  private async postMediaStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    this.ensureReady();
    this.warnStatusRecipientsOnce(options);
    const messageMedia = await this.toMessageMedia(media);
    const msg = await this.client!.sendMessage('status@broadcast', messageMedia, {
      ...(options.caption !== undefined ? { caption: options.caption } : {}),
    });
    return this.toStatusResult(msg);
  }

  /** Build a MessageMedia from a MediaInput (URL → fetched, base64/Buffer → wrapped). */
  private async toMessageMedia(media: MediaInput): Promise<MessageMedia> {
    if (typeof media.data === 'string') {
      if (isHttpUrl(media.data)) return loadRemoteMedia(media.data);
      return new MessageMedia(media.mimetype, media.data, media.filename);
    }
    return new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
  }

  /**
   * Build the `MessageResult` for a send from whatever whatsapp-web.js hands back.
   *
   * `client.sendMessage()` can RESOLVE with `undefined` instead of throwing, and it collapses two
   * opposite outcomes into that one value (`Client.js:1558`): the chat could not be resolved so nothing
   * was sent (`if (!chat) return null`, `Client.js:1539`), or the message went out and only its id could
   * not be read back (`Msg.get` miss, `Injected/Utils.js:585`). Nothing here can tell those apart, so an
   * absent message is reported as a failed send: a false negative is visible and retryable, while
   * claiming delivery for a message that never left is not recoverable. wwebjs's own typings hide the
   * case entirely — `index.d.ts` declares `Promise<Message>`, so `strict` never flagged these reads.
   *
   * A `Message` instance is different: wwebjs only builds one from a real message model, so its presence
   * proves the send happened. An id it cannot read there means "sent, id unknown" and carries the empty
   * sentinel `forwardMessage` already returns — which `saveOutgoingMessage` stores as NULL rather than a
   * fabricated id that a later ack could mis-match.
   */
  private toMessageResult(msg: Message | undefined): MessageResult {
    if (!msg) {
      throw new Error(
        'the engine returned no message for this send, so it may not have been delivered — check the chat before retrying',
      );
    }
    const id = msg.id as unknown as SerializedWid | undefined;
    return { id: id?._serialized ?? id?.$1 ?? '', timestamp: msg.timestamp };
  }

  /**
   * The status-post counterpart of `toMessageResult`, but its absent-message case is *narrower* than a
   * send's. `Injected/Utils.js` builds the status model and returns it from the `isStatus` branch before
   * ever reaching the `Msg.get` miss that makes an ordinary send ambiguous — so the only way back with no
   * message is `Client.js`'s `if (!chat) return null`, i.e. nothing was posted at all. Not an ambiguity:
   * a plain failure, which was previously dressed up as a `201` carrying a `new Date()` invented for a
   * status that never existed.
   *
   * Thrown as an `InternalServerErrorException` rather than a bare `Error` because there is no global
   * exception filter (see `message-not-found.error.spec.ts`), so a bare `Error` reaches the caller as
   * `{"statusCode":500,"message":"Internal server error"}` — and unlike a send, which routes its message
   * into the `message:failed` hook, HTTP is the only consumer a status post has. The same 500, with the
   * reason surviving.
   *
   * A present `Message` proves the post happened, so an id it cannot read there carries the same empty
   * sentinel `toMessageResult` uses. Read `$1` before falling back to it (#747): the sentinel means
   * "posted, id unknown", and `deleteStatus` takes this id as the revoke handle — spending it on an id
   * that was readable all along leaves a status nothing can revoke.
   */
  private toStatusResult(msg: Message | undefined): StatusResult {
    if (!msg) {
      throw new InternalServerErrorException(
        'the engine returned no message for this status post, so it may not have been published — check your status before retrying',
      );
    }
    const id = msg.id as unknown as SerializedWid | undefined;
    const ts = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();
    return {
      statusId: id?._serialized ?? id?.$1 ?? '',
      timestamp: ts,
      expiresAt: new Date(ts.getTime() + 24 * 3_600_000),
    };
  }

  private warnStatusRecipientsOnce(options: StatusPostOptions): void {
    if (this.warnedStatusRecipients || !options.recipients?.length) return;
    this.warnedStatusRecipients = true;
    this.logger.warn(
      "postStatus on the whatsapp-web.js engine broadcasts to the account's status-privacy audience; " +
        'the recipients allow-list is not honored by whatsapp-web.js (it is on the Baileys engine).',
    );
  }

  async deleteStatus(statusId: string): Promise<void> {
    this.ensureReady();
    // Revokes the caller's own status post. revokeStatusMessage resolves the message by id and
    // throws if it isn't fromMe/isn't a status — the statusId returned by postText/Image/VideoStatus
    // (msg.id._serialized) is the id it expects.
    await this.client!.revokeStatusMessage(statusId);
  }

  // ========== Catalog (Phase 3) ==========

  async getCatalog(): Promise<Catalog | null> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native Catalog API support
    this.logger.warn('getCatalog not implemented in whatsapp-web.js adapter');
    return null;
  }

  async getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    this.ensureReady();
    this.logger.warn('getProducts not implemented in whatsapp-web.js adapter');
    return {
      products: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    };
  }

  async getProduct(_productId: string): Promise<Product | null> {
    this.ensureReady();
    this.logger.warn('getProduct not implemented in whatsapp-web.js adapter');
    return null;
  }

  async sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new EngineNotSupportedError('sendProduct');
  }

  async sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    this.ensureReady();
    throw new EngineNotSupportedError('sendCatalog');
  }

  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getChats(): Promise<ChatSummary[]> {
    this.ensureReady();
    const chats = await this.client!.getChats();
    const summaries: ChatSummary[] = [];
    let skipped = 0;

    // Map the raw whatsapp-web.js chat objects to the library-agnostic ChatSummary
    // shape so that no library types leak past the engine boundary. Some WA system
    // or channel-like entries can lack the normal serialized id; skip those instead
    // of failing the whole dashboard chats request.
    for (const chat of chats) {
      const id = chat.id?._serialized;
      if (!id) {
        skipped++;
        continue;
      }

      summaries.push({
        id,
        name: chat.name || id,
        isGroup: Boolean(chat.isGroup),
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.timestamp || 0,
        // A location message's body is the base64 map thumbnail; don't surface it as the chat preview.
        lastMessage: chat.lastMessage?.type === MessageTypes.LOCATION ? '📍' : chat.lastMessage?.body || undefined,
      });
    }

    if (skipped > 0) {
      this.logger.warn(`Skipped ${skipped} chat(s) without a serialized id`);
    }

    return summaries;
  }

  async sendSeen(chatId: string): Promise<boolean> {
    this.ensureReady();
    try {
      const chat = await this.client!.getChatById(chatId);
      return await chat.sendSeen();
    } catch (error) {
      this.logger.error(`Error marking chat ${chatId} as read`, String(error));
      return false;
    }
  }

  async markUnread(chatId: string): Promise<boolean> {
    this.ensureReady();
    if (isChannelJid(chatId)) {
      // A channel resolves to a wwebjs `Channel`, which has no markUnread() — there is no unread
      // state to toggle on a channel. Report the no-op rather than throwing a TypeError.
      return false;
    }
    try {
      const chat = await this.client!.getChatById(chatId);
      // Chat.markUnread() resolves void, so synthesize the boolean from a clean call.
      await chat.markUnread();
      return true;
    } catch (error) {
      this.logger.error(`Error marking chat ${chatId} as unread`, String(error));
      return false;
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    this.ensureReady();
    if (isChannelJid(chatId)) {
      // A channel resolves to a wwebjs `Channel`, which has no delete() (only the destructive
      // deleteChannel()); a generic chat-delete must not silently unsubscribe a channel.
      return false;
    }
    try {
      const chat = await this.client!.getChatById(chatId);
      return await chat.delete();
    } catch (error) {
      this.logger.error(`Error deleting chat ${chatId}`, String(error));
      return false;
    }
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.ensureReady();
    if (isChannelJid(chatId)) {
      // A channel resolves to a wwebjs `Channel`, which has no presence methods
      // (sendStateTyping/sendStateRecording/clearState). Presence is best-effort, so no-op.
      return;
    }
    try {
      const to = await this.resolveSendId(chatId);
      const chat = await this.client!.getChatById(to);
      if (state === 'typing') {
        await chat.sendStateTyping();
      } else if (state === 'recording') {
        await chat.sendStateRecording();
      } else {
        await chat.clearState();
      }
    } catch (error) {
      // Presence is best-effort and already swallowed here — it never breaks the surrounding send —
      // so log at WARN, not ERROR: a migrated contact routinely yields `No LID for user` on the
      // presence path and an ERROR line reads as a fault when nothing actually failed (#582).
      this.logger.warn(`Could not set chat state '${state}' for ${chatId} (best-effort)`, { error: String(error) });
    }
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

import { EventEmitter } from 'events';
import { Client, LocalAuth, MessageMedia, MessageTypes, WAState, type Message } from 'whatsapp-web.js';
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
  ReactionEvent,
} from '../interfaces/whatsapp-engine.interface';
import { resolveWebVersionPin } from '../wa-web-version';
import { isChannelJid, userPart } from '../identity/wa-id';
import { LidMappingStore } from '../identity/lid-mapping-store.service';
import { ChatLabelsUnsupportedError } from '../../common/errors/chat-labels-unsupported.error';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import {
  GroupChat,
  GroupMetadataRaw,
  MessageWithReactions,
  BusinessClient,
  WwjsChannelData,
  GroupCreateResult,
} from '../types/whatsapp-web-js.types';
import { buildIncomingMessageBase, mapContactFields } from './message-mapper';
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
import { ConcurrencyLimiter } from './concurrency-limiter';

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

/**
 * Whether a MediaInput's string `data` is an http(s) URL (to be fetched through the SSRF-guarded
 * loadRemoteMedia) rather than base64. Case-insensitive, matching the Baileys adapter — a mixed-case
 * scheme like `HTTPS://` must still route through the guarded fetch, not be treated as base64.
 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
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
  private readonly inboundLimiter = new ConcurrencyLimiter(inboundMediaConcurrency());

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
    // The slot-holder runs in the background; never let it surface as an unhandled rejection.
    void slotHeld.catch(() => undefined);
    const media = await boundedReady;
    if (!media) return undefined;
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
      const puppeteerArgs = this.config.puppeteer?.args || [
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
      if (this.config.proxy) {
        if (isSupportedProxyUrl(this.config.proxy.url)) {
          puppeteerArgs.push(`--proxy-server=${this.config.proxy.url}`);
          this.logger.log(
            `Using proxy: ${this.config.proxy.type}://${this.config.proxy.url.replace(/:[^:@]*@/, ':***@')}`,
          );
        } else {
          this.logger.warn(`Ignoring invalid proxy URL for session ${this.config.sessionId}`);
        }
      }

      // Pin the WA-Web version when configured (fixes the 1.34.x "stuck at authenticating"
      // hang on some setups, #251). Opt-in: unset leaves whatsapp-web.js to auto-select.
      const versionPin = await resolveWebVersionPin();
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
          // Only override the executable when explicitly configured; otherwise let
          // whatsapp-web.js fall back to Puppeteer's bundled Chromium.
          ...(this.config.puppeteer?.executablePath ? { executablePath: this.config.puppeteer.executablePath } : {}),
        },
        ...(authTimeoutMs !== undefined ? { authTimeoutMs } : {}),
        ...(versionPin ?? {}),
      });

      this.setupEventHandlers();
      await this.client.initialize();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      const reason = error instanceof Error ? error.message : String(error);
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

      try {
        this.callbacks.onMessageCreate?.(buildIncomingMessageBase(msg));
      } catch (error) {
        this.logger.error('Error processing outgoing message', String(error));
      }
    });

    this.client.on('message_ack', (msg, ack) => {
      // Map the whatsapp-web.js MessageAck integer to the neutral DeliveryStatus here, at the
      // adapter boundary, so no downstream consumer ever sees engine-specific ack codes.
      this.callbacks.onMessageAck?.(msg.id._serialized, wwebjsAckToDeliveryStatus(ack));
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
        const payload: RevokedMessage = {
          id: after.id._serialized,
          revokedId: before?.id?._serialized,
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
        const event: ReactionEvent = {
          messageId: reaction.msgId._serialized,
          chatId: reaction.id.remote,
          reaction: reaction.reaction,
          senderId: reaction.senderId,
        };
        this.callbacks.onMessageReaction?.(event);
      } catch (error) {
        this.logger.error('Error processing message_reaction', String(error));
      }
    });

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
      this.logger.warn(`Could not clear stale auth at ${dir}`, String(error));
    });
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
    const client = this.client;
    if (!client) return null;

    this.tearingDown = true;
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
      this.logger.warn('Destroy client failed:', String(error));
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
      this.logger.warn('Logout failed:', String(error));
      // Fall back to destroy if logout fails
      try {
        await client.destroy();
      } catch (destroyError) {
        this.logger.warn('Client destroy also failed during logout fallback', String(destroyError));
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
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
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

    let messageMedia: MessageMedia;

    if (typeof media.data === 'string') {
      if (isHttpUrl(media.data)) {
        // URL
        messageMedia = await loadRemoteMedia(media.data);
      } else {
        // Base64
        messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
      }
    } else {
      // Buffer
      messageMedia = new MessageMedia(media.mimetype, media.data.toString('base64'), media.filename);
    }

    // Build the media once (a remote URL is fetched here); sendResolved may retry the send itself.
    const msg = await this.sendResolved(chatId, to =>
      this.client!.sendMessage(to, messageMedia, {
        caption: media.caption,
        ...(media.mentions?.length ? { mentions: media.mentions } : {}),
        // sendAudioAsVoice only for audio; {...undefined} contributes no keys.
        ...extraOptions,
      }),
    );

    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    const contacts = await this.client!.getContacts();

    return contacts.map(c => ({
      id: c.id._serialized,
      name: c.name || undefined,
      pushName: c.pushname || undefined,
      number: c.number,
      isMyContact: c.isMyContact,
      isBlocked: c.isBlocked,
    }));
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
      this.logger.warn(`Failed to get contact: ${contactId}`, String(error));
      return null;
    }
  }

  async getNumberId(number: string): Promise<string | null> {
    this.ensureReady();
    const numberId = await this.client!.getNumberId(number);
    return numberId?._serialized ?? null;
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
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
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
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
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
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
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
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
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
    return {
      id: msg.id._serialized,
      timestamp: msg.timestamp,
    };
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
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
        return { id: sent.id._serialized, timestamp: sent.timestamp };
      }
    } catch (error) {
      this.logger.warn(`Forward succeeded but recovering the sent message id failed: ${String(error)}`);
    }
    return { id: '', timestamp: Math.floor(Date.now() / 1000) };
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
        linkedParentJID: extractLinkedParentJID(groupChat.groupMetadata),
      };
    } catch (error) {
      this.logger.warn(`Failed to get group: ${groupId}`, String(error));
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    // Ensure participant IDs are in correct format
    const participantIds = participants.map(p => (p.includes('@') ? p : `${p}@c.us`));
    const result = await this.client!.createGroup(name, participantIds);

    const groupId = String((result as unknown as GroupCreateResult).gid._serialized);
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
      id: String(typeof msg.id === 'object' ? msg.id._serialized : msg.id),
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

  // Get Profile Picture
  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      const url = await this.client!.getProfilePicUrl(contactId);
      return url || null;
    } catch (error) {
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

  // ========== Status/Stories (Phase 3) ==========
  // Note: These are stub implementations - whatsapp-web.js has limited Status API support
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  async getContactStatuses(): Promise<Status[]> {
    this.ensureReady();
    // whatsapp-web.js has limited Status API support
    // This is a stub that can be enhanced when the library adds support
    this.logger.warn('getContactStatuses not fully implemented in whatsapp-web.js');
    return [];
  }

  async getContactStatus(_contactId: string): Promise<Status[]> {
    this.ensureReady();
    this.logger.warn('getContactStatus not fully implemented in whatsapp-web.js');
    return [];
  }

  async postTextStatus(_text: string, _options?: StatusPostOptions): Promise<StatusResult> {
    this.ensureReady();
    // whatsapp-web.js doesn't have native status posting
    // This would require using the underlying WhatsApp Web API directly
    throw new EngineNotSupportedError('postTextStatus (Baileys-only; wwebjs blocked upstream, see #455)');
  }

  async postImageStatus(_media: MediaInput, _options?: StatusPostOptions): Promise<StatusResult> {
    this.ensureReady();
    throw new EngineNotSupportedError('postImageStatus (Baileys-only; wwebjs blocked upstream, see #455)');
  }

  async postVideoStatus(_media: MediaInput, _options?: StatusPostOptions): Promise<StatusResult> {
    this.ensureReady();
    throw new EngineNotSupportedError('postVideoStatus (Baileys-only; wwebjs blocked upstream, see #455)');
  }

  async deleteStatus(_statusId: string): Promise<void> {
    this.ensureReady();
    throw new EngineNotSupportedError('deleteStatus');
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
      this.logger.warn(`Could not set chat state '${state}' for ${chatId} (best-effort)`, String(error));
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
}

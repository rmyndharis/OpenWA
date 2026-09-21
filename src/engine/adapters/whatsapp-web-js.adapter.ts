import { EventEmitter } from 'events';
import { MessageMedia, type Client, type Message } from 'whatsapp-web.js';
import {
  CallLinkType,
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
  GroupMembershipRequest,
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
  CustomLinkPreview,
  GroupJoinInfo,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { resolveAuthTimeoutMs } from '../engine-init-timeout';
import { isChannelJid } from '../identity/wa-id';
import { LidMappingStore } from '../identity/lid-mapping-store.service';
import { createLogger } from '../../common/services/logger.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
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
import { registerWwebjsGroupEvents } from './wwebjs-group-events';
import { WwebjsOnboardingWatcher } from './wwebjs-onboarding';
import { WwebjsLifecycle } from './wwebjs-lifecycle';
import { WwebjsReadyReconcile } from './wwebjs-reconcile';
import { WwebjsStuckAuth } from './wwebjs-stuck-auth';
import { WwebjsCalls } from './wwebjs-calls';
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
import { readWid } from '../types/whatsapp-web-js.types';

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
    executablePath?: string;
    /** Per-CDP-command budget handed to Puppeteer. Must be positive — see wwebjs-lifecycle. */
    protocolTimeoutMs?: number;
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

// WhatsApp Web version resolution (the #488 auto-resolve) lives in a dependency-free module so infra
// status can import it without loading whatsapp-web.js (engine lazy-loading). The lifecycle delegate
// imports resolveWebVersionPin for use in initialize().

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
export { probeOnboardingModal, collectDialogDiagnostics } from './wwebjs-onboarding';

// Connection lifecycle moved to ./wwebjs-lifecycle (with the navigation re-inject constants) and the
// readiness reconciliation to ./wwebjs-reconcile; re-exported because existing callers (the adapter
// spec) still import them from here.
export {
  isExecutionContextDestroyedError,
  NAVIGATION_REINJECT_GRACE_MS,
  NAVIGATION_EPISODE_CAP_MS,
} from './wwebjs-lifecycle';
export { READY_RECONCILE_TIMEOUT_MS, READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS } from './wwebjs-reconcile';

export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private readonly logger = createLogger('WhatsAppWebJsAdapter');
  // Bound concurrent inbound media downloads: downloadMedia() materialises the full base64 blob, so an
  // unbounded burst could stack many multi-MB allocations.
  // The queue is UNBOUNDED. A cap equal to the active slots made admission a constant
  // (active + queued) whatever the batch size, so a burst lost the media of everything past the
  // eighth — the same defect repaired on the Baileys side. Parking costs one held Message per
  // waiting download, and only the download runs inside the limiter: each message awaits its own
  // capInboundMediaFor, so a parked one delays itself and a text message never enters the gate.
  private readonly inboundLimiter = new ConcurrencyLimiter(inboundMediaConcurrency());

  private callbacks: EngineEventCallbacks = {};
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
  private readonly lifecycle: WwebjsLifecycle;
  private readonly reconcile: WwebjsReadyReconcile;
  private readonly stuckAuth: WwebjsStuckAuth;
  private readonly calls: WwebjsCalls;
  private readonly onboardingWatcher: WwebjsOnboardingWatcher;

  // Connection-lifecycle state is owned by the lifecycle delegate (./wwebjs-lifecycle); these
  // accessors alias it by reference so the host closures below — and an unmodified spec poking
  // `adapter.client` / `adapter.status` / `adapter.tearingDown` / … through a cast — keep working
  // byte-identically. The live-call cache below is the same pattern for ./wwebjs-calls.
  private get client(): Client | null {
    return this.lifecycle.client;
  }
  private set client(value: Client | null) {
    this.lifecycle.client = value;
  }
  private get status(): EngineStatus {
    return this.lifecycle.status;
  }
  private set status(value: EngineStatus) {
    this.lifecycle.status = value;
  }
  private get qrCode(): string | null {
    return this.lifecycle.qrCode;
  }
  private get tearingDown(): boolean {
    return this.lifecycle.tearingDown;
  }
  private set tearingDown(value: boolean) {
    this.lifecycle.tearingDown = value;
  }
  private get logoutInitiated(): boolean {
    return this.lifecycle.logoutInitiated;
  }
  private set logoutInitiated(value: boolean) {
    this.lifecycle.logoutInitiated = value;
  }
  private get disconnectReported(): boolean {
    return this.lifecycle.disconnectReported;
  }
  private set disconnectReported(value: boolean) {
    this.lifecycle.disconnectReported = value;
  }
  /** Ringing call ids and their expiry, owned by the calls delegate, which uses them to announce each
   *  call once; lifecycle teardown clears them. The adapter keeps this alias for the spec, which reads
   *  `adapter.liveCalls` through a cast. */
  private get liveCalls(): Map<string, number> {
    return this.calls.liveCalls;
  }

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
    // Lifecycle collaborators, each with its own narrow host slice of closures. Constructed before
    // the lifecycle delegate, whose host closes over them; every closure reads adapter state live,
    // so construction order carries no initialization requirements.
    this.reconcile = new WwebjsReadyReconcile({
      logger: this.logger,
      config: this.config,
      getClient: () => this.client,
      getStatus: () => this.status,
      setStatus: status => this.lifecycle.setStatus(status),
      getCallbacks: () => this.callbacks,
      markReadyFromClientInfo: () => this.lifecycle.markReadyFromClientInfo(),
      recoverFromStuckAuth: () => this.recoverFromStuckAuth(),
    });
    this.stuckAuth = new WwebjsStuckAuth({
      logger: this.logger,
      config: this.config,
      getClient: () => this.client,
      setClient: client => (this.lifecycle.client = client),
      setStatus: status => this.lifecycle.setStatus(status),
      getCallbacks: () => this.callbacks,
    });
    this.calls = new WwebjsCalls({
      logger: this.logger,
      isTearingDown: () => this.tearingDown,
      getCallbacks: () => this.callbacks,
    });
    this.onboardingWatcher = new WwebjsOnboardingWatcher({
      logger: this.logger,
      config: this.config,
      getClient: () => this.client,
      getStatus: () => this.status,
      setStatus: status => this.lifecycle.setStatus(status),
      isTearingDown: () => this.tearingDown,
      isDisconnectReported: () => this.disconnectReported,
      getCallbacks: () => this.callbacks,
    });
    this.lifecycle = new WwebjsLifecycle({
      logger: this.logger,
      config: this.config,
      getCallbacks: () => this.callbacks,
      emitState: status => this.emit('stateChanged', status),
      scheduleReadyReconcile: () => this.reconcile.scheduleReadyReconcile(),
      clearReadyReconcile: () => this.reconcile.clearReadyReconcile(),
      startOnboardingWatcher: () => this.onboardingWatcher.startOnboardingWatcher(),
      clearOnboardingWatcher: () => this.onboardingWatcher.clearOnboardingWatcher(),
      clearLiveCalls: () => this.calls.clearLiveCalls(),
      clearLocalAuth: () => this.clearLocalAuth(),
      attachDomainEvents: client => this.attachDomainEvents(client),
    });
  }

  /**
   * Download inbound media safely. downloadMedia() can't be size-bounded at the source, so (1) pre-gate
   * on the sender-declared size and skip the download entirely when it exceeds the cap, and (2) run the
   * download through the concurrency limiter for backpressure. Resolves an envelope whenever it has one
   * to build: the payload, or the declared-only marker when no blob is available.
   */
  private async capInboundMediaFor(
    msg: Message,
    maxBytesOverride?: number,
  ): Promise<IncomingMessage['media'] | undefined> {
    if (!isMediaDownloadEnabled()) {
      return declaredOnlyMedia(msg);
    }
    // Read the id once, through readWid: a bare `_serialized` read yields undefined on the WA Web build
    // that renamed it to `$1` (#747), which is the same build whose page-side rename makes these
    // downloads fail. The warnings below are the diagnostic for it, so they must carry a real id.
    const msgId = readWid(msg.id);
    const maxBytes = maxBytesOverride ?? inboundMediaMaxBytes();
    const data = (msg as unknown as { _data?: { size?: number; mimetype?: string; filename?: string } })._data;
    const declared = coerceDeclaredSize(data?.size);
    if (declared > maxBytes) {
      this.logger.warn('Inbound media declared size exceeds the cap; skipped download', {
        msgId,
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
      // downloadMedia() is async, so a page-side throw (a detached target, a WA Web field rename) arrives
      // as a rejection, which boundedReady adopts and rethrows past the only exit that builds the marker,
      // leaving every call site to emit with no media field at all. It is the same "no usable media"
      // outcome as the timeout below, so it takes the same null sentinel.
      const download = msg.downloadMedia().catch((error: unknown) => {
        this.logger.warn('Inbound media download failed; emitting the omitted marker', {
          msgId,
          error: String(error),
        });
        return null;
      });
      resolveBounded(
        withInboundDownloadTimeout(download, inboundMediaTimeoutMs(), () =>
          this.logger.warn(
            'Inbound media download timed out (MEDIA_DOWNLOAD_TIMEOUT_MS); emitting message without media',
            {
              msgId,
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
    // Defensive only, and deliberately kept. `run()` rejects on a full queue (gone — the queue is
    // unbounded) or on close(), which nothing calls on this limiter; the task itself swallows both
    // download outcomes. So nothing is expected here — but an unhandled rejection from a
    // fire-and-forget promise is not an acceptable way to find that out.
    void slotHeld.catch((error: unknown) => {
      this.logger.warn('Inbound media slot holder rejected unexpectedly; emitting message without media', {
        msgId,
        error: String(error),
      });
      resolveBounded(null);
    });
    // The caller's wait spans the QUEUE as well as the download, and BOTH are unbounded: the queue by
    // design now, and the wait for a slot because a slot is held until its download really settles —
    // which a hung page never does. The inner race only starts once this message is admitted, so it
    // cannot cover the waiting. Without a bound here, a burst behind stuck slots parks forever and
    // those messages are never emitted AT ALL — strictly worse than the media loss this change set
    // out to fix. The old queue cap provided that degradation by rejecting; this restores it without
    // shedding at a fixed batch size.
    const media = await withInboundDownloadTimeout(boundedReady, inboundMediaTimeoutMs(), () =>
      this.logger.warn(
        'Inbound media did not arrive within MEDIA_DOWNLOAD_TIMEOUT_MS; emitting message without media',
        {
          msgId,
        },
      ),
    );
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
        msgId,
        sizeBytes: capped.sizeBytes,
      });
    }
    return capped;
  }

  // ----- Lifecycle (./wwebjs-lifecycle and its sibling collaborators) -----

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    return this.lifecycle.initialize();
  }

  private setupEventHandlers(): void {
    this.lifecycle.setupEventHandlers();
  }

  private attachPuppeteerLifecycleListeners(): void {
    this.lifecycle.attachPuppeteerLifecycleListeners();
  }

  private isPageTransportError(error: unknown): boolean {
    return this.lifecycle.isPageTransportError(error);
  }

  private reportIfPageTransportError(error: unknown, context: string): void {
    this.lifecycle.reportIfPageTransportError(error, context);
  }

  async disconnect(): Promise<void> {
    return this.lifecycle.disconnect();
  }

  async logout(): Promise<void> {
    return this.lifecycle.logout();
  }

  async destroy(): Promise<void> {
    return this.lifecycle.destroy();
  }

  async forceDestroy(): Promise<void> {
    return this.lifecycle.forceDestroy();
  }

  getStatus(): EngineStatus {
    return this.lifecycle.getStatus();
  }

  async probeLiveness(): Promise<boolean> {
    return this.lifecycle.probeLiveness();
  }

  getQRCode(): string | null {
    return this.lifecycle.getQRCode();
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    return this.lifecycle.requestPairingCode(phoneNumber);
  }

  getPhoneNumber(): string | null {
    return this.lifecycle.getPhoneNumber();
  }

  getPushName(): string | null {
    return this.lifecycle.getPushName();
  }

  private recoverFromStuckAuth(): Promise<void> {
    return this.stuckAuth.recoverFromStuckAuth();
  }

  private clearLocalAuth(): Promise<void> {
    return this.stuckAuth.clearLocalAuth();
  }

  private reportActionRequired(reason: string): void {
    this.onboardingWatcher.reportActionRequired(reason);
  }

  /**
   * Register the message/group/call domain events on a freshly built client — the one seam the
   * lifecycle's setupEventHandlers() uses for everything that is pure payload mapping. The
   * connection-state events (qr/authenticated/ready/disconnected/auth_failure) stay in the
   * lifecycle module: they drive the latches these registrars never touch.
   */
  private attachDomainEvents(client: Client): void {
    registerWwebjsMessageEvents(client, this.host);
    registerWwebjsGroupEvents(client, this.host);
    client.on('call', call => this.calls.handleIncomingCall(call));
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

  demoteChannelAdmin(channelId: string, userId: string): Promise<void> {
    return this.channels.demoteChannelAdmin(channelId, userId);
  }

  transferChannelOwnership(channelId: string, newOwnerId: string): Promise<void> {
    return this.channels.transferChannelOwnership(channelId, newOwnerId);
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

  createCallLink(type: CallLinkType, startTime: number): Promise<string> {
    return this.profile.createCallLink(type, startTime);
  }

  /** Always EngineNotSupportedError (HTTP 501): a rejection did not stop a live call ringing. See
   *  ./wwebjs-calls. */
  async rejectCall(callId: string): Promise<void> {
    return this.calls.rejectCall(callId);
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

  replyToMessage(chatId: string, quotedMsgId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    return this.messaging.replyToMessage(chatId, quotedMsgId, text, mentions);
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

  // whatsapp-web.js has no interactive button-reply send path; the parameters are not named so the
  // method reads as the 501 it is, and TypeScript accepts the narrower signature for the interface.
  // eslint-disable-next-line @typescript-eslint/require-await
  async clickButton(): Promise<MessageResult> {
    throw new EngineNotSupportedError('clickButton');
  }

  unpinMessage(chatId: string, messageId: string): Promise<void> {
    return this.messaging.unpinMessage(chatId, messageId);
  }

  deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    return this.messaging.deleteMessage(chatId, messageId, forEveryone);
  }

  // Edit Message
  editMessage(chatId: string, messageId: string, body: string, mentions?: string[]): Promise<MessageResult> {
    return this.messaging.editMessage(chatId, messageId, body, mentions);
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

  getBlockedContacts(): Promise<string[]> {
    return this.contacts.getBlockedContacts();
  }

  // ========== Profile (own account) ==========

  setProfileName(name: string): Promise<void> {
    return this.profile.setProfileName(name);
  }

  setProfileStatus(status: string): Promise<void> {
    return this.profile.setProfileStatus(status);
  }

  deleteProfilePicture(): Promise<void> {
    return this.profile.deleteProfilePicture();
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

  getGroupMembershipRequests(groupId: string): Promise<GroupMembershipRequest[]> {
    return this.groups.getGroupMembershipRequests(groupId);
  }

  approveGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.approveGroupMembershipRequests(groupId, participants);
  }

  rejectGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.rejectGroupMembershipRequests(groupId, participants);
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

  // messageIds is dropped on purpose: whatsapp-web.js exposes only a chat-level sendSeen, which
  // already marks every message in the chat.
  sendSeen(chatId: string): Promise<boolean> {
    return this.chats.sendSeen(chatId);
  }

  muteChat(chatId: string, muteUntil: number | null): Promise<void> {
    return this.chats.muteChat(chatId, muteUntil);
  }

  pinChat(chatId: string, pin: boolean): Promise<boolean> {
    return this.chats.pinChat(chatId, pin);
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

  setOnlinePresence(available: boolean): Promise<void> {
    return this.chats.setOnlinePresence(available);
  }

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      // Typed so the global filter returns 409 Conflict ("session not connected")
      // instead of a 500 when an engine op is attempted while the session is
      // disconnected / reconnecting / still initializing (#100).
      throw new EngineNotReadyError();
    }
    // Post-READY navigation window: window.WWebJS is gone until the re-inject completes, so every
    // delegate evaluate would die as a raw TypeError 500 (and five raw send failures latch the send
    // breaker for its 15-minute cooldown). Answer the same retryable 409 the pre-READY states get,
    // naming the reload so the operator can tell this state from a plain disconnect (#1081).
    if (this.lifecycle.isInNavigationReinjectWindow()) {
      throw new EngineNotReadyError(
        'WhatsApp Web is reloading its page and the session is re-injecting. Retry in a few seconds.',
      );
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

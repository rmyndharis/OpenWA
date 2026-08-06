import * as path from 'path';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysChannels } from './baileys-channels';
import { BaileysCatalog } from './baileys-catalog';
import { BaileysContacts } from './baileys-contacts';
import { BaileysEvents } from './baileys-events';
import { BaileysGroups } from './baileys-groups';
import { BaileysHistory, toUnixSeconds } from './baileys-history';
import { BaileysLifecycle } from './baileys-lifecycle';
import { BaileysMessaging } from './baileys-messaging';
import { BaileysStatus } from './baileys-status';
import {
  ChatState,
  Channel,
  ChannelMessage,
  Catalog,
  Contact,
  ContactCard,
  EngineEventCallbacks,
  EngineStatus,
  Group,
  GroupInfo,
  GroupMemberAddMode,
  IncomingMessage,
  IWhatsAppEngine,
  Label,
  CustomLinkPreview,
  GroupJoinInfo,
  LabelInput,
  LocationInput,
  MediaInput,
  MessageReaction,
  MessageResult,
  PaginatedProducts,
  ParticipantOperationResult,
  PollInput,
  Product,
  ProductQueryOptions,
  Status,
  StatusResult,
  ChatSummary,
  StatusPostOptions,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { NotFoundException } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { BaileysAdapterConfig } from '../types/baileys.types';
import { BaileysSessionStore } from './baileys-session-store';
import { inboundMediaConcurrency } from './inbound-media-cap';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

// The implementation moved with connectInner to BaileysLifecycle; it remains part of this module's
// public surface (imported from './baileys.adapter' by the spec).
export { createProxyAgent } from './baileys-lifecycle';

export class BaileysAdapter implements IWhatsAppEngine {
  private readonly logger = createLogger('BaileysAdapter');
  // Bound concurrent inbound media downloads: each materialises a full decrypted buffer in heap, so an
  // unbounded fire-and-forget loop lets a sender flood the gateway with N parallel multi-MB allocations.
  private readonly inboundLimiter = new ConcurrencyLimiter(
    inboundMediaConcurrency(),
    // Queue cap == active slots: beyond (active + queued) concurrent media messages, reject instead of
    // parking, so a burst can't grow heap without bound (each parked closure holds the message).
    inboundMediaConcurrency(),
  );
  private readonly authPath: string;
  private readonly sessionStore: BaileysSessionStore;
  private readonly groups: BaileysGroups;
  private readonly messaging: BaileysMessaging;
  private readonly contacts: BaileysContacts;
  private readonly statusOps: BaileysStatus;
  private readonly channels: BaileysChannels;
  private readonly catalog: BaileysCatalog;
  private readonly history: BaileysHistory;
  private readonly events: BaileysEvents;
  private readonly lifecycle: BaileysLifecycle;
  private callbacks: EngineEventCallbacks = {};
  /** Connection-lifecycle state is owned by the lifecycle delegate; these accessors alias it by
   *  reference so delegate host closures (and an unmodified spec poking `adapter.sock` via a cast)
   *  keep working byte-identically — the liveCalls precedent below. */
  private get sock(): WASocket | null {
    return this.lifecycle.sock;
  }
  private set sock(value: WASocket | null) {
    this.lifecycle.sock = value;
  }
  /** Unix-seconds timestamp of the last 'open' connection.update — the events delegate's
   *  live-vs-history discriminator, read live; the value is owned by the lifecycle delegate. */
  private get connectedAt(): number {
    return this.lifecycle.connectedAt;
  }
  /** Live-call cache handle — the map is owned by the events delegate (call events + rejectCall);
   *  lifecycle teardown clears it so a late rejectCall() reports not-found on a dead socket. The
   *  adapter keeps this alias for the unmodified spec, which reads `adapter.liveCalls` via a cast. */
  private get liveCalls(): Map<string, { callFrom: string; expiresAt: number }> {
    return this.events.liveCalls;
  }

  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  private loadLib(): Promise<typeof BaileysLib> {
    return this.lifecycle.loadLib();
  }

  constructor(private readonly config: BaileysAdapterConfig) {
    // Isolate each session's auth state under its own subdirectory of the shared auth dir.
    this.authPath = path.join(config.authDir, config.sessionId);
    this.sessionStore = new BaileysSessionStore(config.lidMappingStore, config.sessionId);
    // Constructed before messaging: the messaging delegate's own-send echo maps through
    // events.mapMessage (and the lifecycle delegate clears that same live-call cache on teardown).
    // An object-literal getter's `this` is the literal itself, so the live connectedAt read goes
    // through an arrow closure that captures the adapter.
    const connectedAt = (): number => this.connectedAt;
    this.events = new BaileysEvents({
      getSocket: () => this.sock!,
      getSocketOrNull: () => this.sock,
      logger: this.logger,
      toNeutralJid: jid => this.sessionStore.toNeutralJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
      loadLib: () => this.loadLib(),
      get connectedAt() {
        return connectedAt();
      },
      inboundLimiter: this.inboundLimiter,
      recordKeyLidMappings: key => this.sessionStore.recordKeyLidMappings(key),
      recordMessage: msg => this.sessionStore.recordMessage(msg),
      recordMessageEdit: (chatId, messageId, text) => this.sessionStore.recordMessageEdit(chatId, messageId, text),
      putStoredMessage: msg => this.config.messageStore?.put(this.config.dbSessionId, msg),
      getOnMessage: () => this.callbacks.onMessage,
      getOnMessageCreate: () => this.callbacks.onMessageCreate,
      getOnMessageRevoked: () => this.callbacks.onMessageRevoked,
      getOnMessageEdited: () => this.callbacks.onMessageEdited,
      getOnMessageReaction: () => this.callbacks.onMessageReaction,
      getOnMessageAck: () => this.callbacks.onMessageAck,
      getOnGroupEvent: () => this.callbacks.onGroupEvent,
      getOnCall: () => this.callbacks.onCall,
      getOnPresenceUpdate: () => this.callbacks.onPresenceUpdate,
      getOnCallOutcome: () => this.callbacks.onCallOutcome,
    });
    this.groups = new BaileysGroups({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      logger: this.logger,
      toNeutralJid: jid => this.sessionStore.toNeutralJid(jid),
      toEngineJid: jid => this.sessionStore.toEngineJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
    });
    this.messaging = new BaileysMessaging({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      logger: this.logger,
      toNeutralJid: jid => this.sessionStore.toNeutralJid(jid),
      toEngineJid: jid => this.sessionStore.toEngineJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
      getEphemeralExpiration: chatId => this.sessionStore.getEphemeralExpiration(chatId),
      toUnixSeconds,
      loadLib: () => this.loadLib(),
      putStoredMessage: msg => this.config.messageStore?.put(this.config.dbSessionId, msg),
      getStoredMessage: messageId => this.config.messageStore?.getMessage(this.config.dbSessionId, messageId),
      // Store the device-stripped lid: that is the key the lid->phone lookup reads.
      recordLidMapping: (lid, pn) =>
        this.sessionStore.addLidMappings([{ lid: `${lid.split('@')[0].split(':')[0]}@lid`, pn }]),
      getOnMessageCreate: () => this.callbacks.onMessageCreate,
      mapMessage: (msg, contentType, opts) => this.events.mapMessage(msg, contentType, opts),
    });
    this.contacts = new BaileysContacts({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      logger: this.logger,
      normalizedSelfJid: () => this.normalizedSelfJid(),
      listContacts: () => this.sessionStore.listContacts(),
      findContact: contactId => this.sessionStore.findContact(contactId),
      resolvePhone: contactId => this.sessionStore.resolvePhone(contactId),
      listChats: () => this.sessionStore.listChats(),
      lastMessage: chatId => this.sessionStore.lastMessage(chatId),
      toEngineJid: jid => this.sessionStore.toEngineJid(jid),
    });
    this.statusOps = new BaileysStatus({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      toEngineJid: jid => this.sessionStore.toEngineJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
      toUnixSeconds,
    });
    this.channels = new BaileysChannels({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
    });
    this.catalog = new BaileysCatalog({
      ensureReady: () => this.ensureReady(),
      getSocket: () => this.sock!,
      normalizedSelfJid: () => this.normalizedSelfJid(),
    });
    this.history = new BaileysHistory({
      getSocket: () => this.sock!,
      logger: this.logger,
      toNeutralJid: jid => this.sessionStore.toNeutralJid(jid),
      normalizedSelfJid: () => this.normalizedSelfJid(),
      loadLib: () => this.loadLib(),
      recordMessage: msg => this.sessionStore.recordMessage(msg),
      upsertContacts: records => this.sessionStore.upsertContacts(records),
      upsertChats: records => this.sessionStore.upsertChats(records),
      extractEphemeralDuration: msg => this.sessionStore.extractEphemeralDuration(msg),
      getOnHistoryMessages: () => this.callbacks.onHistoryMessages,
    });
    // Constructed last: its host closes over the delegates above (event/history handlers), while the
    // live-call map is captured eagerly — a stable readonly reference owned by BaileysEvents.
    this.lifecycle = new BaileysLifecycle({
      logger: this.logger,
      authPath: this.authPath,
      config: this.config,
      liveCalls: this.events.liveCalls,
      extractPhone: id => this.extractPhone(id),
      upsertContacts: records => this.sessionStore.upsertContacts(records),
      upsertChats: records => this.sessionStore.upsertChats(records),
      addLidMappings: mappings => this.sessionStore.addLidMappings(mappings),
      handleMessagesUpsert: event => this.events.handleMessagesUpsert(event),
      handleMessagesUpdate: updates => this.events.handleMessagesUpdate(updates),
      logContactEvent: (event, records) => this.events.logContactEvent(event, records),
      handleGroupParticipantsUpdate: event => this.events.handleGroupParticipantsUpdate(event),
      handleGroupsUpdate: updates => this.events.handleGroupsUpdate(updates),
      handleCallEvents: calls => this.events.handleCallEvents(calls),
      handlePresenceUpdate: update => this.events.handlePresenceUpdate(update),
      captureHistoryMessages: messages => this.history.captureHistoryMessages(messages),
      hydrateNames: () => this.history.hydrateNames(),
      getOnQRCode: () => this.callbacks.onQRCode,
      getOnReady: () => this.callbacks.onReady,
      getOnDisconnected: () => this.callbacks.onDisconnected,
      getOnError: () => this.callbacks.onError,
      getOnStateChanged: () => this.callbacks.onStateChanged,
      getOnCredentialTeardownStarted: () => this.callbacks.onCredentialTeardownStarted,
      getOnAccountRestriction: () => this.callbacks.onAccountRestriction,
    });
  }

  // ----- Lifecycle -----

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    return this.lifecycle.initialize();
  }

  disconnect(): Promise<void> {
    return this.lifecycle.disconnect();
  }

  async logout(): Promise<void> {
    return this.lifecycle.logout();
  }

  destroy(): Promise<void> {
    return this.lifecycle.destroy();
  }

  // Baileys has no separate Chromium process to SIGKILL (destroy() already ends the socket
  // synchronously), so a force-destroy is just a destroy.
  forceDestroy(): Promise<void> {
    return this.lifecycle.forceDestroy();
  }

  // ----- Status -----

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

  // ----- Messaging -----

  async sendTextMessage(
    chatId: string,
    text: string,
    mentions?: string[],
    options?: { linkPreview?: boolean; customPreview?: CustomLinkPreview },
  ): Promise<MessageResult> {
    return this.messaging.sendTextMessage(chatId, text, mentions, options);
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return this.messaging.checkNumberExists(number);
  }

  async getNumberId(number: string): Promise<string | null> {
    return this.messaging.getNumberId(number);
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    return this.messaging.sendChatState(chatId, state);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendImageMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendVideoMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendAudioMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendDocumentMessage(chatId, media);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendStickerMessage(chatId, media);
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    return this.messaging.sendLocationMessage(chatId, location);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    return this.messaging.sendContactMessage(chatId, contact);
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    return this.messaging.sendPollMessage(chatId, poll);
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    return this.messaging.replyToMessage(chatId, quotedMsgId, text);
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    return this.messaging.forwardMessage(fromChatId, toChatId, messageId);
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    return this.messaging.reactToMessage(chatId, messageId, emoji);
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone = true): Promise<void> {
    return this.messaging.deleteMessage(chatId, messageId, forEveryone);
  }

  async starMessage(chatId: string, messageId: string, star: boolean): Promise<void> {
    return this.messaging.starMessage(chatId, messageId, star);
  }

  async pinMessage(chatId: string, messageId: string, durationSeconds: number): Promise<void> {
    return this.messaging.pinMessage(chatId, messageId, durationSeconds);
  }

  async unpinMessage(chatId: string, messageId: string): Promise<void> {
    return this.messaging.unpinMessage(chatId, messageId);
  }

  async editMessage(chatId: string, messageId: string, body: string): Promise<MessageResult> {
    return this.messaging.editMessage(chatId, messageId, body);
  }

  // ----- Groups -----

  async getGroups(): Promise<Group[]> {
    return this.groups.getGroups();
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    return this.groups.getGroupInfo(groupId);
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    return this.groups.createGroup(name, participants);
  }

  async addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.addParticipants(groupId, participants);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.removeParticipants(groupId, participants);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.promoteParticipants(groupId, participants);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.groups.demoteParticipants(groupId, participants);
  }

  async leaveGroup(groupId: string): Promise<void> {
    return this.groups.leaveGroup(groupId);
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    return this.groups.setGroupSubject(groupId, subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    return this.groups.setGroupDescription(groupId, description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    return this.groups.getGroupInviteCode(groupId);
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    return this.groups.revokeGroupInviteCode(groupId);
  }

  getGroupJoinInfo(inviteCode: string): Promise<GroupJoinInfo> {
    return this.groups.getGroupJoinInfo(inviteCode);
  }

  async joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    return this.groups.joinGroupViaInviteCode(inviteCode);
  }

  async setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    return this.groups.setGroupMessagesAdminsOnly(groupId, adminsOnly);
  }

  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    return this.groups.setGroupInfoAdminsOnly(groupId, adminsOnly);
  }

  async setGroupMemberAddMode(groupId: string, mode: GroupMemberAddMode): Promise<void> {
    return this.groups.setGroupMemberAddMode(groupId, mode);
  }

  async setGroupPicture(groupId: string, media: MediaInput): Promise<void> {
    return this.groups.setGroupPicture(groupId, media);
  }

  async deleteGroupPicture(groupId: string): Promise<void> {
    return this.groups.deleteGroupPicture(groupId);
  }

  async setGroupEphemeral(groupId: string, durationSec: number): Promise<void> {
    return this.groups.setGroupEphemeral(groupId, durationSec);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    return this.contacts.getProfilePicture(contactId);
  }

  async blockContact(contactId: string): Promise<void> {
    return this.contacts.blockContact(contactId);
  }

  async upsertContact(contactId: string, firstName: string, lastName?: string): Promise<void> {
    return this.contacts.upsertContact(contactId, firstName, lastName);
  }

  async deleteContact(contactId: string): Promise<void> {
    return this.contacts.deleteContact(contactId);
  }

  async unblockContact(contactId: string): Promise<void> {
    return this.contacts.unblockContact(contactId);
  }

  // ----- Profile (own account) -----

  async setProfileName(name: string): Promise<void> {
    return this.contacts.setProfileName(name);
  }

  async setProfileStatus(status: string): Promise<void> {
    return this.contacts.setProfileStatus(status);
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    return this.contacts.setProfilePicture(media);
  }

  // ----- Contacts & chats -----

  async getContacts(): Promise<Contact[]> {
    return this.contacts.getContacts();
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    return this.contacts.getContactById(contactId);
  }

  async resolveContactPhone(contactId: string): Promise<string | null> {
    return this.contacts.resolveContactPhone(contactId);
  }

  async getChats(): Promise<ChatSummary[]> {
    return this.contacts.getChats();
  }

  async subscribeToPresence(chatId: string): Promise<void> {
    return this.messaging.subscribeToPresence(chatId);
  }

  async sendSeen(chatId: string): Promise<boolean> {
    return this.contacts.sendSeen(chatId);
  }

  async markUnread(chatId: string): Promise<boolean> {
    return this.contacts.markUnread(chatId);
  }

  async deleteChat(chatId: string): Promise<boolean> {
    return this.contacts.deleteChat(chatId);
  }

  async archiveChat(chatId: string, archive: boolean): Promise<boolean> {
    return this.contacts.archiveChat(chatId, archive);
  }

  async clearChatMessages(chatId: string): Promise<boolean> {
    return this.contacts.clearChatMessages(chatId);
  }

  // ----- Gated: not supported by this minimal slice (no store) -----
  /* eslint-disable @typescript-eslint/no-unused-vars */

  getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    return this.unsupported('getMessageReactions');
  }

  // Baileys exposes label WRITES only — chats.d.ts:69-73 has addLabel/addChatLabel/removeChatLabel
  // and no query of any kind, and Types/Label.d.ts is types-only. Listing the chats on a label would
  // mean maintaining an app-state cache fed by the label-association sync events, which is a
  // separate piece of work from this one and is tracked as such.
  getChatsByLabel(_labelId: string): Promise<ChatSummary[]> {
    return this.unsupported('getChatsByLabel');
  }

  // No vote-send helper exists in Baileys — only decryptPollVote for RECEIVING. Sending one needs a
  // hand-built proto.Message.PollUpdateMessage with HMAC-SHA256 vote encryption keyed by the poll
  // creation's messageSecret.
  votePoll(_chatId: string, _pollMessageId: string, _options: string[]): Promise<void> {
    return this.unsupported('votePoll');
  }
  getChatHistory(
    _chatId: string,
    _limit?: number,
    _includeMedia?: boolean,
    _mediaMaxBytes?: number,
    _signal?: AbortSignal,
  ): Promise<IncomingMessage[]> {
    return this.unsupported('getChatHistory');
  }
  getLabels(): Promise<Label[]> {
    return this.unsupported('getLabels');
  }
  getLabelById(_labelId: string): Promise<Label | null> {
    return this.unsupported('getLabelById');
  }
  getChatLabels(_chatId: string): Promise<Label[]> {
    return this.unsupported('getChatLabels');
  }
  // WhatsApp Business only — Baileys rejects these on personal accounts. The label must already
  // exist (use getLabels on an engine that lists them); addChatLabel/removeChatLabel associate it
  // with a chat, they do not create/edit the label definition.
  // Fold @c.us -> @s.whatsapp.net first: chatModify (which both calls wrap) keys the label
  // app-state index by the RAW jid, so a neutral @c.us would label a phantom chat the phone never
  // reads — reported as success. Same class of no-op the deleteForMe/star folds fixed.
  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.addChatLabel(this.sessionStore.toEngineJid(chatId), labelId);
  }
  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.removeChatLabel(this.sessionStore.toEngineJid(chatId), labelId);
  }
  /**
   * Create or update a label.
   *
   * WhatsApp models this as ONE app-state write — a `label_edit` patch indexed by the label id — so
   * create and update are the same operation, distinguished only by whether the id already exists.
   * That is why the id is caller-supplied rather than returned.
   *
   * The `jid` Baileys asks for is unused on this patch: `chatModifyToPatch` builds the index from
   * `['label_edit', id]` and never reads it (Utils/chat-utils.js:579-593). The account's own jid is
   * passed because the call demands one, not because it addresses anything.
   */
  async upsertLabel(label: LabelInput): Promise<void> {
    this.ensureReady();
    // Unset fields are passed through as undefined rather than stripped: the protobuf encoder skips
    // a field that is `!= null` false, exactly as it skips a missing one (WAProto/index.js,
    // LabelEditAction.encode), so an omitted name really does leave the stored name alone. Colour 0
    // is a real WhatsApp colour and survives that check — which is why it must never be tested for
    // truthiness on the way here.
    await this.sock!.addLabel(this.ownJidForAppState(), { id: label.id, name: label.name, color: label.color });
  }

  /** Delete a label. The same `label_edit` write, with the tombstone flag set. */
  async deleteLabel(labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.addLabel(this.ownJidForAppState(), { id: labelId, deleted: true });
  }

  /**
   * A jid for the label-edit app-state write, which needs one but never uses it. The account's own
   * id is the honest choice — the write is about this account, not about a conversation.
   */
  private ownJidForAppState(): string {
    return this.sock?.user?.id ?? 'status@broadcast';
  }

  createChannel(name: string, description?: string): Promise<Channel> {
    return this.channels.createChannel(name, description);
  }

  deleteChannel(channelId: string): Promise<void> {
    return this.channels.deleteChannel(channelId);
  }

  muteChannel(channelId: string, mute: boolean): Promise<void> {
    return this.channels.muteChannel(channelId, mute);
  }

  getSubscribedChannels(): Promise<Channel[]> {
    return this.unsupported('getSubscribedChannels');
  }
  async getChannelById(channelId: string): Promise<Channel | null> {
    return this.channels.getChannelById(channelId);
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    return this.channels.subscribeToChannel(inviteCode);
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    return this.channels.unsubscribeFromChannel(channelId);
  }

  // getChannelMessages is not wired: Baileys' newsletterFetchMessages returns the RAW query
  // BinaryNode with no library parser, so mapping it to ChannelMessage[] needs a verified
  // BinaryNode walk (or a live spike) that can't be validated without a WhatsApp session. Kept as a
  // documented adapter-gap in the engine capability matrix rather than shipped as an unverified walk.
  getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    return this.unsupported('getChannelMessages');
  }
  getContactStatuses(): Promise<Status[]> {
    return this.unsupported('getContactStatuses');
  }
  getContactStatus(_contactId: string): Promise<Status[]> {
    return this.unsupported('getContactStatus');
  }
  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    return this.statusOps.postTextStatus(text, options);
  }
  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.statusOps.postImageStatus(media, options);
  }
  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.statusOps.postVideoStatus(media, options);
  }

  postVoiceStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.statusOps.postVoiceStatus(media, options);
  }
  async deleteStatus(statusId: string): Promise<void> {
    return this.statusOps.deleteStatus(statusId);
  }
  getCatalog(): Promise<Catalog | null> {
    return this.catalog.getCatalog();
  }
  getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return this.catalog.getProducts(options);
  }
  getProduct(productId: string): Promise<Product | null> {
    return this.catalog.getProduct(productId);
  }
  async sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult> {
    const product = await this.catalog.getProduct(productId);
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found in the session catalog`);
    }
    return this.messaging.sendProductMessage(chatId, product, body);
  }
  // No catalog-level message primitive exists in Baileys (only the single-product {product}
  // content), so sendCatalog stays a documented library limitation.
  sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendCatalog');
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // ----- Events -----

  async rejectCall(callId: string): Promise<void> {
    return this.events.rejectCall(callId);
  }

  // ----- Helpers -----

  private normalizedSelfJid(): string {
    const phone = this.extractPhone(this.sock?.user?.id);
    return phone ? `${phone}@s.whatsapp.net` : '';
  }

  private unsupported(method: string): Promise<any> {
    return Promise.reject(new EngineNotSupportedError(method));
  }

  protected ensureReady(): void {
    this.lifecycle.ensureReady();
  }

  /** `628999:12@s.whatsapp.net` / `628999@s.whatsapp.net` -> `628999`. */
  private extractPhone(id: string | undefined): string | null {
    if (!id) {
      return null;
    }
    return id.split(':')[0].split('@')[0] || null;
  }
}

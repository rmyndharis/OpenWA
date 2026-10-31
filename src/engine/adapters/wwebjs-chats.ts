import { BadRequestException } from '@nestjs/common';
import * as wwebjs from 'whatsapp-web.js';
import { MessageTypes, type Chat, type Client } from 'whatsapp-web.js';
import { ChatSummary, ChatState } from '../interfaces/whatsapp-engine.interface';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { chatKind, isChannelJid } from '../identity/wa-id';
import { WwebjsMessaging } from './wwebjs-messaging';
import { type WwebjsEngineHost, rethrowIfNavigation } from './wwebjs-host';
import { isProtocolTimeout } from './wwebjs-lifecycle';
import { mapWwebjsMessageType } from './message-mapper';

/**
 * Build the chat list IN-PAGE with the same `window.WWebJS.getChatModel` whatsapp-web.js's own
 * `client.getChats()` maps, yielding to the page event loop every 256 chats so the liveness probe's
 * queued `getState()` evaluate can interleave. The library starts every getChatModel in one `map`,
 * and a personal chat reaches no await at all (serialize() plus its last message), so on a large chat
 * list that map is one uninterrupted synchronous stretch that starves the probe and lets the watchdog
 * tear a healthy session down mid-read: the #1501 shape readLeanContacts fixed for contacts.
 *
 * The models and their order are unchanged and the group metadata updates still overlap. A group
 * whose model fails one of WhatsApp Web's own invariants is served from the metadata the page already
 * holds (see the fallback below), so one group WhatsApp Web cannot refresh no longer fails the whole
 * list; any other rejection still rejects the whole read, as upstream does.
 *
 * Given `chatIds`, it reads those chats instead of the whole list, each resolved and modelled as
 * `client.getChatById` does (null for one that does not resolve), with the same group fallback.
 */
export async function readChatModels(chatIds?: string[]): Promise<unknown[]> {
  type PageChat = {
    serialize: () => Record<string, unknown>;
    mute?: { expiration?: number };
    formattedTitle?: unknown;
    groupMetadata?: { serialize: () => { participants?: { id: unknown }[] }; announce?: unknown };
  };
  const w = window as unknown as {
    require: (m: string) => {
      Chat: { getModelsArray: () => PageChat[] };
      toPn: (id: unknown) => unknown;
    };
    WWebJS: {
      getChat: (chatId: string, options: { getAsModel: boolean }) => Promise<PageChat | null>;
      getChatModel: (chat: unknown, options?: { isChannel: boolean }) => Promise<unknown>;
    };
  };
  // A group's model refreshes its metadata from the server first (groupMetadata.update), and WhatsApp
  // Web itself can throw while processing the reply: invariant 76137, raised by its device-list sync
  // for a member whose hosted (coexistence) device lacks the hosted flag, fails one group on every
  // read. Rebuild the model getChatModel would return from the metadata already loaded, without the
  // last-message preview, so the group stays listed. The marker lets listChats report it. Only an
  // invariant (WhatsApp Web rejecting its own data) is recovered: a logout, a network loss or any
  // other failure still fails the read instead of answering every group from stale metadata. If even
  // the local read throws, the original rejection stands.
  const localGroupModel = (chat: PageChat | null, error: unknown): Record<string, unknown> => {
    const failure = error as { name?: unknown; message?: unknown } | undefined;
    const description = `${String(failure?.name)}: ${String(failure?.message ?? error)}`;
    if (!chat?.groupMetadata || !/Invariant Violation|Minified invariant/.test(description)) throw error;
    try {
      const model = chat.serialize();
      model.isGroup = true;
      model.isMuted = chat.mute?.expiration !== 0;
      model.formattedTitle = chat.formattedTitle;
      const { toPn } = w.require('WAWebLidMigrationUtils');
      const metadata = chat.groupMetadata.serialize();
      for (const p of metadata.participants || []) p.id = toPn(p.id) ?? p.id;
      model.groupMetadata = metadata;
      model.isReadOnly = chat.groupMetadata.announce;
      model.lastMessage = null;
      delete model.msgs;
      delete model.msgUnsyncedButtonReplyMsgs;
      delete model.unsyncedButtonReplies;
      model.metadataRefreshError = description.slice(0, 200);
      return model;
    } catch {
      throw error;
    }
  };
  // A copy: getModelsArray() is the collection's live array, which re-sorts on a new message and
  // grows on a new chat, so indexing it across the yields below would read one chat twice and skip
  // another. Upstream's single synchronous map never let it change underneath.
  const chats = chatIds
    ? await Promise.all(chatIds.map(id => w.WWebJS.getChat(id, { getAsModel: false })))
    : w.require('WAWebCollections').Chat.getModelsArray().slice();
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    // getChat's own channel test, so an id is modelled exactly as getChatById models it.
    const options = chatIds && { isChannel: /@\w*newsletter\b/.test(chatIds[i]) };
    const model = w.WWebJS.getChatModel(chat, options).catch(error => localGroupModel(chat, error));
    // Handled here so a rejection that lands during a yield is not reported as unhandled; the
    // Promise.all below still rejects with it.
    model.catch(() => undefined);
    pending.push(model);
    if ((i & 0xff) === 0xff) await new Promise(resolve => setTimeout(resolve));
  }
  return Promise.all(pending);
}

/** The chat structures are classes at runtime; index.d.ts declares them as interfaces only. */
type ChatConstructor = new (client: Client, data: unknown) => Chat;
const { GroupChat, PrivateChat } = wwebjs as unknown as { GroupChat: ChatConstructor; PrivateChat: ChatConstructor };

/**
 * Turn a failure that says the page is gone into the retryable 503 every chat operation answers: a dead
 * page (reported as the early death signal) or a read that outran the protocol budget. Anything else
 * returns, for the caller to handle. A chat action that reported a dead page as "WhatsApp declined" (an
 * opaque `false`) let the caller retry against a corpse.
 */
function rethrowTransportFailure(
  host: WwebjsEngineHost,
  error: unknown,
  context: string,
  activity: string,
  timedOutMessage = `WhatsApp Web did not answer in time while ${activity}`,
): void {
  // A session that stopped during the lookup is the retryable 409, never a `false` refusal.
  if (error instanceof EngineNotReadyError) throw error;
  rethrowIfNavigation(host, error);
  if (host.isPageTransportError(error)) {
    host.reportIfPageTransportError(error, context);
    throw new EngineTransportError(`Transport died while ${activity}`);
  }
  if (isProtocolTimeout(error)) {
    throw new EngineTransportError(timedOutMessage);
  }
}

/**
 * Whether a rejection is one of WhatsApp Web's own invariants, the only failure {@link readChatModels}
 * recovers a group from; the same phrases as its in-page test. Puppeteer rebuilds a page error with
 * the constructor name, so the "Invariant Violation" name arrives inside the message.
 */
export function isPageInvariant(error: unknown): boolean {
  return /Invariant Violation|Minified invariant/.test(String((error as { message?: unknown })?.message ?? error));
}

/**
 * The chats {@link readChatModels} reads (the whole list, or the given ids, leaving out one that does
 * not resolve), rehydrated the way whatsapp-web.js's ChatFactory does for these entries, so every
 * mapped field reads exactly as `client.getChats()` or `client.getChatById()` gave it. Logs the groups
 * served from local metadata. A rejection is the page's own, for the caller to classify.
 */
export async function readChats(host: WwebjsEngineHost, context: string, chatIds?: string[]): Promise<Chat[]> {
  const client = host.getClient();
  const page = (
    client as unknown as {
      pupPage: { evaluate: <T, A>(fn: (arg?: A) => Promise<T>, arg?: A) => Promise<T> };
    }
  ).pupPage;
  const read = chatIds ? await page.evaluate(readChatModels, chatIds) : await page.evaluate(readChatModels);
  const models = read.filter(data => data != null);
  const local = models.filter(
    data => typeof (data as { metadataRefreshError?: unknown }).metadataRefreshError === 'string',
  );
  if (local.length > 0) {
    // Bounded: the list is polled, so name at most ten groups and each distinct error once.
    host.logger.warn(`Read ${local.length} group(s) from local metadata; WhatsApp Web could not refresh them`, {
      context,
      groups: local.slice(0, 10).map(data => (data as { id?: { _serialized?: string } }).id?._serialized),
      errors: [...new Set(local.map(data => (data as { metadataRefreshError: string }).metadataRefreshError))].slice(
        0,
        3,
      ),
    });
  }
  return models.map(data =>
    (data as { isGroup?: boolean }).isGroup ? new GroupChat(client, data) : new PrivateChat(client, data),
  );
}

/**
 * The whole chat list through {@link readChats}. Shared by the chat and group lists. A dead page
 * answers 503 with the death signal, a read that outran the protocol budget answers 503 without one,
 * and anything else is rethrown.
 */
export async function listChats(host: WwebjsEngineHost, context: string): Promise<Chat[]> {
  try {
    return await readChats(host, context);
  } catch (error) {
    // Same split every sibling read makes (see getChatsByLabel): a dead page is a 503 and an
    // early death signal, not an opaque 500 under a status that still says READY (#1081).
    rethrowTransportFailure(
      host,
      error,
      context,
      'listing chats',
      'WhatsApp Web did not answer the chat list read in time',
    );
    throw error;
  }
}

/**
 * Chat-list operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public methods as
 * thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so the delegate
 * never touches lifecycle state directly. Presence (sendChatState) resolves the recipient through
 * the messaging delegate's send-id cache, exactly like a send.
 */
export class WwebjsChats {
  constructor(
    private readonly host: WwebjsEngineHost,
    private readonly messaging: WwebjsMessaging,
  ) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async getChats(): Promise<ChatSummary[]> {
    this.host.ensureReady();
    const chats = await listChats(this.host, 'getChats');
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
        kind: chatKind(id),
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.timestamp || 0,
        // A location message's body is the base64 map thumbnail; don't surface it as the chat preview.
        lastMessage: chat.lastMessage?.type === MessageTypes.LOCATION ? '📍' : chat.lastMessage?.body || undefined,
        lastMessageType: chat.lastMessage ? mapWwebjsMessageType(chat.lastMessage.type) : undefined,
        archived: Boolean(chat.archived),
        pinned: Boolean(chat.pinned),
        // Chat.isMuted is the current verdict; muteExpiration is wwjs epoch SECONDS with -1 = forever.
        muted: Boolean(chat.isMuted),
        // Expose the expiry as ms (0 = indefinite), present only when muted, per ChatSummary.
        muteExpiration: chat.isMuted
          ? (chat.muteExpiration ?? 0) > 0
            ? (chat.muteExpiration ?? 0) * 1000
            : 0
          : undefined,
      });
    }

    if (skipped > 0) {
      this.host.logger.warn(`Skipped ${skipped} chat(s) without a serialized id`);
    }

    return summaries;
  }

  async sendSeen(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    try {
      const chat = await this.client().getChatById(chatId);
      // The chat acts through its own client, which getClient's readiness check never sees again.
      this.host.ensureReady();
      return await chat.sendSeen();
    } catch (error) {
      // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
      rethrowTransportFailure(this.host, error, 'sendSeen', 'marking a chat as read');
      this.host.logger.error(`Error marking chat ${chatId} as read`, String(error));
      return false;
    }
  }

  async clearChatMessages(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    try {
      // An unknown chat needs no special case: getChatById resolves undefined for one, and the
      // resulting TypeError lands in the catch below as the same `false` the injected helper
      // returns for a chat it cannot find. Same shape as sendSeen/archiveChat above.
      const chat = await this.client().getChatById(chatId);
      this.host.ensureReady();
      return await chat.clearMessages();
    } catch (error) {
      // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
      rethrowTransportFailure(this.host, error, 'clearChatMessages', 'clearing a chat');
      this.host.logger.error(`Error clearing messages in chat ${chatId}`, String(error));
      return false;
    }
  }

  async archiveChat(chatId: string, archive: boolean): Promise<boolean> {
    this.host.ensureReady();
    try {
      // Client.archiveChat/unarchiveChat, NOT Chat.archive() — the Chat method resolves void.
      //
      // Their return value is deliberately DISCARDED. Despite looking like a success flag they
      // resolve the chat's NEW ARCHIVE STATE, hard-coded: archiveChat always returns true and
      // unarchiveChat always returns false (Client.js:2009-2031, "Changes and returns the archive
      // state of the Chat"). Surfacing that as `success` reports every successful UNARCHIVE as
      // success:false — which this API's contract defines as "the engine declined to act".
      //
      // whatsapp-web.js offers no refusal signal here at all, so the honest answer is "it did not
      // throw": an unknown chat makes the page-side Cmd.archiveChat reject, which lands below.
      if (archive) {
        await this.client().archiveChat(chatId);
      } else {
        await this.client().unarchiveChat(chatId);
      }
      return true;
    } catch (error) {
      // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
      rethrowTransportFailure(this.host, error, 'archiveChat', 'archiving a chat');
      this.host.logger.error(`Error ${archive ? 'archiving' : 'unarchiving'} chat ${chatId}`, String(error));
      return false;
    }
  }

  /**
   * whatsapp-web.js signals a chat it cannot resolve by rejecting deep inside the page — `No LID for
   * user` from pin's WID lookup, a TypeError from the evaluate inside `Client._muteUnmuteChat` for
   * mute. Both surfaced as a bare 500, a status neither route declares, while every older member of
   * this family answers an unknown chat gracefully.
   *
   * Resolving the chat first turns that into the 400 the contract already promises. It deliberately
   * does NOT wrap the pin/mute call itself: a page-side rejection for a chat that DOES exist is the
   * one signal a renamed page internal produces, and demoting it to "bad input" would hide a total
   * capability failure — the shape `createGroup` turned out to have. `getChatById` is the same
   * resolution five neighbours here already trust, and it reports an unknown chat either way it can,
   * by resolving undefined or by rejecting.
   */
  private async requireResolvableChat(chatId: string): Promise<void> {
    let chat: unknown;
    try {
      chat = await this.client().getChatById(chatId);
    } catch (error) {
      // A dead page resolves NOTHING, so swallowing every rejection here reported it as "no such
      // chat" and named the caller's chatId as the problem. The other chat operations split that case
      // out; without this, the same file answered a dead page two different ways.
      rethrowTransportFailure(this.host, error, 'requireResolvableChat', 'resolving a chat');
      chat = undefined; // an unknown chat rejects too — that is the 400 below
    }
    if (!chat) throw new BadRequestException(`Chat ${chatId} does not exist on this session`);
  }

  /**
   * The write leg of mute, pin and the account's own presence. A dead page or an expired protocol
   * timeout is a 503 (mute, unmute, pin, unpin and a presence change all converge when repeated) and
   * a dead page is reported as the early death signal. Any other rejection is rethrown untouched,
   * for the reason above.
   */
  private async chatWrite<T>(context: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      rethrowIfNavigation(this.host, error);
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, context);
        throw new EngineTransportError(`Transport died during ${context}`);
      }
      if (isProtocolTimeout(error)) {
        throw new EngineTransportError(`WhatsApp Web did not answer in time during ${context}`);
      }
      throw error;
    }
  }

  async muteChat(chatId: string, muteUntil: number | null): Promise<void> {
    this.host.ensureReady();
    await this.requireResolvableChat(chatId);
    if (muteUntil === null) {
      await this.chatWrite('muteChat', () => this.client().unmuteChat(chatId));
      return;
    }
    // muteUntil is epoch milliseconds, which is what Date wants; Client.muteChat floors it to the
    // seconds its page-side call expects. The Baileys side takes the same milliseconds unmodified.
    await this.chatWrite('muteChat', () => this.client().muteChat(chatId, new Date(muteUntil)));
  }

  async pinChat(chatId: string, pin: boolean): Promise<boolean> {
    this.host.ensureReady();
    // Not `return false` for an unknown chat: `false` is already taken here, and means the three-pin
    // cap refused a real chat. Conflating the two would tell a caller with a stale chatId that its
    // pin quota is full.
    await this.requireResolvableChat(chatId);
    if (!pin) {
      // unpinChat resolves the chat's NEW pin state, which is `false` for every successful unpin —
      // both on its early-out for an already-unpinned chat and after actually unpinning
      // (Client.js:2073-2084). Forwarding it would report every success as a refusal, the same trap
      // archiveChat documents. Discard it: an unpin that did not throw succeeded.
      await this.chatWrite('pinChat', () => this.client().unpinChat(chatId));
      return true;
    }
    // In this direction the return value IS information. WhatsApp caps pinned chats at three
    // (MAX_PIN_COUNT, Client.js:2054-2063) and the page returns false without pinning once that is
    // met, so a false here is a real refusal the caller needs to see.
    return await this.chatWrite('pinChat', () => this.client().pinChat(chatId));
  }

  async markUnread(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    if (isChannelJid(chatId)) {
      // A channel resolves to a wwebjs `Channel`, which has no markUnread() — there is no unread
      // state to toggle on a channel. Report the no-op rather than throwing a TypeError.
      return false;
    }
    try {
      const chat = await this.client().getChatById(chatId);
      this.host.ensureReady();
      // Chat.markUnread() resolves void, so synthesize the boolean from a clean call.
      await chat.markUnread();
      return true;
    } catch (error) {
      // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
      rethrowTransportFailure(this.host, error, 'markUnread', 'marking a chat as unread');
      this.host.logger.error(`Error marking chat ${chatId} as unread`, String(error));
      return false;
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    this.host.ensureReady();
    if (isChannelJid(chatId)) {
      // A channel resolves to a wwebjs `Channel`, which has no delete() (only the destructive
      // deleteChannel()); a generic chat-delete must not silently unsubscribe a channel.
      return false;
    }
    try {
      const chat = await this.client().getChatById(chatId);
      this.host.ensureReady();
      return await chat.delete();
    } catch (error) {
      // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
      rethrowTransportFailure(this.host, error, 'deleteChat', 'deleting a chat');
      this.host.logger.error(`Error deleting chat ${chatId}`, String(error));
      return false;
    }
  }

  /**
   * Publish the account's own GLOBAL presence. Not best-effort, unlike sendChatState: the caller
   * asked for a specific visibility, and swallowing a failure would leave the account silently
   * online after the API reported otherwise (#871 — an always-online bot suppresses the phone's
   * own notifications).
   */
  async setOnlinePresence(available: boolean): Promise<void> {
    this.host.ensureReady();
    await this.chatWrite('setOnlinePresence', () =>
      available ? this.client().sendPresenceAvailable() : this.client().sendPresenceUnavailable(),
    );
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.host.ensureReady();
    if (isChannelJid(chatId)) {
      // A channel resolves to a wwebjs `Channel`, which has no presence methods
      // (sendStateTyping/sendStateRecording/clearState). Presence is best-effort, so no-op.
      return;
    }
    try {
      const to = await this.messaging.resolveSendId(chatId);
      const chat = await this.client().getChatById(to);
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
      this.host.logger.warn(`Could not set chat state '${state}' for ${chatId} (best-effort)`, {
        error: String(error),
      });
    }
  }
}

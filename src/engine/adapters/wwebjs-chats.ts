import { MessageTypes, type Client } from 'whatsapp-web.js';
import { ChatSummary, ChatState } from '../interfaces/whatsapp-engine.interface';
import { chatKind, isChannelJid } from '../identity/wa-id';
import { WwebjsMessaging } from './wwebjs-messaging';
import { type WwebjsEngineHost } from './wwebjs-host';

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
    const chats = await this.client().getChats();
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
      return await chat.sendSeen();
    } catch (error) {
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
      return await chat.clearMessages();
    } catch (error) {
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
      this.host.logger.error(`Error ${archive ? 'archiving' : 'unarchiving'} chat ${chatId}`, String(error));
      return false;
    }
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
      // Chat.markUnread() resolves void, so synthesize the boolean from a clean call.
      await chat.markUnread();
      return true;
    } catch (error) {
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
      return await chat.delete();
    } catch (error) {
      this.host.logger.error(`Error deleting chat ${chatId}`, String(error));
      return false;
    }
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

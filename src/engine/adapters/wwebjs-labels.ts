import { NotFoundException } from '@nestjs/common';
import { type Chat, type Client } from 'whatsapp-web.js';
import { mapWwebjsMessageType } from './message-mapper';
import { Label, ChatSummary } from '../interfaces/whatsapp-engine.interface';
import { GroupChat, BusinessClient } from '../types/whatsapp-web-js.types';
import { isChannelJid, chatKind } from '../identity/wa-id';
import { ChatLabelsUnsupportedError } from '../../common/errors/chat-labels-unsupported.error';
import { LabelNotFoundError } from '../../common/errors/label-not-found.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { type WwebjsEngineHost, rethrowIfNavigation, withPage } from './wwebjs-host';
import { isProtocolTimeout } from './wwebjs-lifecycle';
import { isPageSideRejection, readLoadedChats } from './wwebjs-chats';

/**
 * Chat-label operations (WhatsApp Business only) extracted from WhatsAppWebJsAdapter. The adapter
 * keeps the public methods as thin forwarders and injects the shared host surface (./wwebjs-host)
 * via closures, so the delegate never touches lifecycle state directly.
 */
export class WwebjsLabels {
  /** The settled tail of each chat's label writes, so the next write starts after it; gone once the chat is idle. */
  private readonly chatWrites = new Map<string, Promise<void>>();

  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async getLabels(): Promise<Label[]> {
    this.host.ensureReady();
    const labels = await withPage(this.host, 'getLabels', () =>
      (this.client() as unknown as BusinessClient).getLabels(),
    );
    if (!labels) {
      return [];
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  /**
   * Every chat carrying a label. Mapped to the neutral ChatSummary here rather than returned raw,
   * for the same reason getChats does it: no whatsapp-web.js type may cross the engine boundary.
   * Entries without a serialized id are skipped rather than failing the whole request.
   */
  async getChatsByLabel(labelId: string): Promise<ChatSummary[]> {
    this.host.ensureReady();
    // The upstream page code dereferences the label without checking it exists, so an unknown id —
    // and every id on a personal (non-Business) account, whose label collection is empty — throws a
    // page-side TypeError that would surface as an opaque 500. A label that is not there is a 404,
    // the same answer getLabelById gives.
    let chats: Awaited<ReturnType<BusinessClient['getChatsByLabelId']>>;
    try {
      chats = await (this.client() as unknown as BusinessClient)
        .getChatsByLabelId(labelId)
        .catch(error => this.readLoadedLabelChats(labelId, error));
    } catch (error) {
      // Same split the group read makes: a dead page is a 503, not "no such label".
      rethrowIfNavigation(this.host, error);
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getChatsByLabel');
        throw new EngineTransportError(`Transport died while listing chats for label ${labelId}`);
      }
      // Nor is a command that outran the protocol budget: no answer is not "no such label".
      if (isProtocolTimeout(error)) {
        throw new EngineTransportError(`WhatsApp Web did not answer the chat list for label ${labelId} in time`);
      }
      this.host.logger.debug('getChatsByLabelId rejected; treating the label as not found', {
        labelId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LabelNotFoundError(labelId);
    }
    const summaries: ChatSummary[] = [];
    for (const chat of chats ?? []) {
      // The library builds this list via getChatById per label item and yields UNDEFINED entries
      // for chats that no longer resolve (Client.js getChatsByLabelId → ChatFactory) — the whole
      // entry, not just the id, so the optional chain must start at the entry itself.
      const id = chat?.id?._serialized;
      if (!id) continue;
      summaries.push({
        id,
        name: chat.name || id,
        isGroup: Boolean(chat.isGroup),
        kind: chatKind(id),
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.timestamp || 0,
        lastMessageType: chat.lastMessage ? mapWwebjsMessageType(chat.lastMessage.type) : undefined,
        archived: Boolean(chat.archived),
        pinned: Boolean(chat.pinned),
        muted: Boolean(chat.isMuted),
        // wwjs muteExpiration is epoch SECONDS with -1 = forever; expose ms (0 = indefinite), muted only.
        muteExpiration: chat.isMuted
          ? (chat.muteExpiration ?? 0) > 0
            ? (chat.muteExpiration ?? 0) * 1000
            : 0
          : undefined,
      });
    }
    return summaries;
  }

  /**
   * The library resolves every chat behind the label through getChatById, so one group whose metadata
   * refresh fails one of WhatsApp Web's own invariants (#1950) rejected the whole list, which read as an
   * unknown label. Read the label's chats from what the page already holds instead, as the chat list
   * does. A dead page, a timeout or a session that went away skips this, and any failure here lands in
   * the caller's catch exactly as the original rejection would have.
   */
  private async readLoadedLabelChats(labelId: string, error: unknown): Promise<Chat[]> {
    if (!isPageSideRejection(this.host, error)) throw error;
    const page = (
      this.client() as unknown as {
        pupPage: { evaluate: <T, A>(fn: (arg: A) => T, arg: A) => Promise<T> };
      }
    ).pupPage;
    // The same page read getChatsByLabelId starts with (Client.js), so an unknown label still throws.
    const chatIds = await page.evaluate((id: string) => {
      type LabelItem = { parentType: string; parentId: string };
      const w = window as unknown as {
        require: (m: string) => {
          Label: { get: (id: string) => { labelItemCollection: { getModelsArray: () => LabelItem[] } } };
        };
      };
      return w
        .require('WAWebCollections')
        .Label.get(id)
        .labelItemCollection.getModelsArray()
        .filter(item => item.parentType === 'Chat')
        .map(item => item.parentId);
    }, labelId);
    return readLoadedChats(this.host, 'getChatsByLabel', chatIds);
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.host.ensureReady();
    // Client.getLabelById never resolves null: its page code serializes the looked-up label without
    // checking it exists, so an unknown id (every id on a personal account) throws a TypeError that
    // surfaced as a 500. Picking from the full list makes a missing label the documented 404.
    const labels = await withPage(this.host, 'getLabelById', () =>
      (this.client() as unknown as BusinessClient).getLabels(),
    );
    const label = labels?.find(candidate => String(candidate.id) === labelId);
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
    this.host.ensureReady();
    if (isChannelJid(chatId)) {
      // A channel resolves to a wwebjs `Channel`, which has no getLabels() and carries no chat labels.
      // Return empty instead of letting the unguarded call throw a TypeError (HTTP 500).
      return [];
    }
    // An unknown chat carries no labels, which is an honest answer for a read.
    return (await this.readChatLabels(chatId)) ?? [];
  }

  /** The chat's labels, or null when the page cannot resolve the chat (getChatById resolves undefined). */
  private async readChatLabels(chatId: string): Promise<Label[] | null> {
    const labels = await withPage(this.host, 'getChatLabels', async () => {
      const chat = await this.client().getChatById(chatId);
      return chat ? ((await (chat as unknown as GroupChat).getLabels()) ?? []) : null;
    });
    if (!labels) {
      return null;
    }

    return labels.map(label => ({
      id: String(label.id),
      name: String(label.name),
      hexColor: String(label.hexColor),
    }));
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.host.ensureReady();
    await this.changeChatLabel(chatId, labelId, true);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.host.ensureReady();
    await this.changeChatLabel(chatId, labelId, false);
  }

  /**
   * whatsapp-web.js has no add-/remove-one-label primitive: `client.addOrRemoveLabels(ids, chats)` REPLACES
   * a chat's label set with `ids` (adding the listed labels, removing any existing label not listed). So
   * toggle a single label by reading the current set, mutating it, and writing the whole set back.
   * Labels are a WhatsApp Business feature — the write throws `[LT01]` on a personal account; channels
   * carry no labels at all. Both are surfaced as a 422 rather than an opaque 500.
   *
   * The read and write are separate calls, and the page derives the removals from the chat's labels at the
   * moment it runs, so two single-label writes to the SAME chat that overlap would undo each other (the
   * later one removes the label the earlier one just added). They run one after the other per chat; a
   * write that waited re-reads the labels, and answers 409 if the session went away meanwhile.
   */
  private async changeChatLabel(chatId: string, labelId: string, add: boolean): Promise<void> {
    if (isChannelJid(chatId)) {
      throw new ChatLabelsUnsupportedError('Channels do not support chat labels.');
    }
    // `previous` never rejects (it is the settled tail below), so a failed write does not stop the next.
    const previous = this.chatWrites.get(chatId) ?? Promise.resolve();
    const write = previous.then(() => this.writeChatLabel(chatId, labelId, add));
    const tail = write.then(
      () => undefined,
      () => undefined,
    );
    this.chatWrites.set(chatId, tail);
    void tail.then(() => {
      if (this.chatWrites.get(chatId) === tail) this.chatWrites.delete(chatId);
    });
    await write;
  }

  private async writeChatLabel(chatId: string, labelId: string, add: boolean): Promise<void> {
    // Not the read's empty answer: addOrRemoveLabels matches no chat page-side for an unknown id and
    // resolves without writing anything, which the route would report as success.
    const current = await this.readChatLabels(chatId);
    if (!current) {
      throw new NotFoundException(`Chat ${chatId} does not exist on this session`);
    }
    const ids = new Set(current.map(label => label.id));
    if (add) {
      ids.add(labelId);
    } else {
      ids.delete(labelId);
    }
    try {
      await withPage(this.host, 'changeChatLabel', () => this.client().addOrRemoveLabels([...ids], [chatId]));
    } catch (error) {
      // whatsapp-web.js throws `[LT01] Only Whatsapp business` from the page context on a personal account.
      if (String(error instanceof Error ? error.message : error).includes('LT01')) {
        throw new ChatLabelsUnsupportedError();
      }
      throw error;
    }
    // The page drops an id it does not know and resolves, so the write left the chat unchanged. Checked
    // after the write, not before, so a personal account (no labels at all) still gets the LT01 422.
    if (add && !(await this.getLabels()).some(label => label.id === labelId)) {
      throw new LabelNotFoundError(labelId);
    }
    this.host.logger.debug(add ? 'Added label to chat' : 'Removed label from chat', { labelId, chatId });
  }
}

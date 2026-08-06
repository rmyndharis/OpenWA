import { type Client } from 'whatsapp-web.js';
import { Label, ChatSummary } from '../interfaces/whatsapp-engine.interface';
import { GroupChat, BusinessClient } from '../types/whatsapp-web-js.types';
import { isChannelJid, chatKind } from '../identity/wa-id';
import { ChatLabelsUnsupportedError } from '../../common/errors/chat-labels-unsupported.error';
import { LabelNotFoundError } from '../../common/errors/label-not-found.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Chat-label operations (WhatsApp Business only) extracted from WhatsAppWebJsAdapter. The adapter
 * keeps the public methods as thin forwarders and injects the shared host surface (./wwebjs-host)
 * via closures, so the delegate never touches lifecycle state directly.
 */
export class WwebjsLabels {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async getLabels(): Promise<Label[]> {
    this.host.ensureReady();
    const labels = await (this.client() as unknown as BusinessClient).getLabels();
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
      chats = await (this.client() as unknown as BusinessClient).getChatsByLabelId(labelId);
    } catch (error) {
      // Same split the group read makes: a dead page is a 503, not "no such label".
      if (this.host.isPageTransportError(error)) {
        this.host.reportIfPageTransportError(error, 'getChatsByLabel');
        throw new EngineTransportError(`Transport died while listing chats for label ${labelId}`);
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
      });
    }
    return summaries;
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    this.host.ensureReady();
    const label = await (this.client() as unknown as BusinessClient).getLabelById(labelId);
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
    const chat = await this.client().getChatById(chatId);
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
      await this.client().addOrRemoveLabels([...ids], [chatId]);
    } catch (error) {
      // whatsapp-web.js throws `[LT01] Only Whatsapp business` from the page context on a personal account.
      if (String(error instanceof Error ? error.message : error).includes('LT01')) {
        throw new ChatLabelsUnsupportedError();
      }
      throw error;
    }
    this.host.logger.log(`${add ? 'Added' : 'Removed'} label ${labelId} ${add ? 'to' : 'from'} chat ${chatId}`);
  }
}

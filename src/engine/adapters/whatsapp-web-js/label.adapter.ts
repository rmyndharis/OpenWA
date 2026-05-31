import { Label } from '../../interfaces/whatsapp-engine.interface';
import { GroupChat, BusinessClient } from '../../types/whatsapp-web-js.types';
import { AdapterContext } from './context';

/**
 * Label concern (WhatsApp Business only): list labels, per-chat labels,
 * add/remove. Bodies moved verbatim from the monolithic adapter; behavior is
 * identical.
 */
export class LabelAdapter {
  constructor(private readonly ctx: AdapterContext) {}

  async getLabels(): Promise<Label[]> {
    const client = this.ctx.requireClient();
    const labels = await (client as unknown as BusinessClient).getLabels();
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
    const client = this.ctx.requireClient();
    const label = await (client as unknown as BusinessClient).getLabelById(labelId);
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
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(chatId);
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
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(chatId);
    await (chat as unknown as GroupChat).addLabel(labelId);
    this.ctx.logger.log(`Added label ${labelId} to chat ${chatId}`);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    const client = this.ctx.requireClient();
    const chat = await client.getChatById(chatId);
    await (chat as unknown as GroupChat).removeLabel(labelId);
    this.ctx.logger.log(`Removed label ${labelId} from chat ${chatId}`);
  }
}

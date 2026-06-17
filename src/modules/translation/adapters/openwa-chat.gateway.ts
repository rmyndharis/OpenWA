import { ChatGateway } from '../core/ports';
import { MessageService } from '../../message/message.service';
import { SessionService } from '../../session/session.service';

export class OpenWaChatGateway implements ChatGateway {
  constructor(
    private readonly messageService: MessageService,
    private readonly sessionService: SessionService,
  ) {}

  async sendText(sessionId: string, chatId: string, text: string): Promise<void> {
    await this.messageService.sendText(sessionId, { chatId, text });
  }

  async sendCombinedReply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<void> {
    await this.messageService.reply(sessionId, { chatId, quotedMessageId, text });
  }

  async getGroupAdmins(sessionId: string, chatId: string): Promise<string[]> {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) return [];
    const info = await engine.getGroupInfo(chatId);
    if (!info) return [];
    return info.participants.filter(p => p.isAdmin || p.isSuperAdmin).map(p => p.id);
  }
}

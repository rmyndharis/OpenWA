import { ChatGateway } from '../core/ports';
import { MessageService } from '../../message/message.service';
import { SessionService } from '../../session/session.service';
import { createLogger } from '../../../common/services/logger.service';

export class OpenWaChatGateway implements ChatGateway {
  private readonly logger = createLogger('OpenWaChatGateway');

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
    if (!engine) {
      this.logger.warn('getGroupAdmins: no active engine for session', { chatId, action: 'admins_no_engine' });
      return [];
    }
    const info = await engine.getGroupInfo(chatId);
    if (!info) {
      this.logger.warn('getGroupAdmins: getGroupInfo returned null', { chatId, action: 'admins_no_info' });
      return [];
    }
    const admins = info.participants.filter(p => p.isAdmin || p.isSuperAdmin).map(p => p.id);
    // Participant ids can be in the phone (@c.us) scheme while message authors arrive as LID
    // (@lid). The group `owner` is reported in the author's scheme, so including it recognizes the
    // group creator across that split (see spec §16, WID/LID). Non-owner admins on the differing
    // scheme are not auto-resolved yet — the owner can delegate them via `/tr grant @user`.
    if (info.owner) admins.push(info.owner);
    const uniqueAdmins = [...new Set(admins)];
    this.logger.debug('getGroupAdmins resolved', {
      chatId,
      action: 'admins_resolved',
      adminCount: uniqueAdmins.length,
      admins: uniqueAdmins,
    });
    return uniqueAdmins;
  }
}

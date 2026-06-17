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
    // Diagnostic: surface the exact WID format so admin-match failures (LID vs @c.us) are visible.
    this.logger.debug('getGroupAdmins resolved', {
      chatId,
      action: 'admins_resolved',
      adminCount: admins.length,
      admins,
      sampleParticipants: info.participants.slice(0, 5).map(p => ({ id: p.id, isAdmin: p.isAdmin })),
    });
    return admins;
  }
}

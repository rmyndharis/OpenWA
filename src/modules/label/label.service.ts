import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Owns engine access for label operations so the "session not started" guard and label
 * business rules (not-found mapping) live behind the service boundary, not in the controller.
 */
@Injectable()
export class LabelService {
  constructor(private readonly sessionService: SessionService) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
  }

  getLabels(sessionId: string) {
    return this.getEngine(sessionId).getLabels();
  }

  async getLabelById(sessionId: string, labelId: string) {
    const label = await this.getEngine(sessionId).getLabelById(labelId);
    if (!label) {
      throw new NotFoundException(`Label ${labelId} not found`);
    }
    return label;
  }

  getChatLabels(sessionId: string, chatId: string) {
    return this.getEngine(sessionId).getChatLabels(chatId);
  }

  addLabelToChat(sessionId: string, chatId: string, labelId: string) {
    return this.getEngine(sessionId).addLabelToChat(chatId, labelId);
  }

  removeLabelFromChat(sessionId: string, chatId: string, labelId: string) {
    return this.getEngine(sessionId).removeLabelFromChat(chatId, labelId);
  }
}

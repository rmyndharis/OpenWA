import { Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Owns engine access for label operations so the "session not started" guard and label
 * business rules (not-found mapping) live behind the service boundary, not in the controller.
 */
@Injectable()
export class LabelService {
  constructor(private readonly engines: EngineRegistry) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
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

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Owns engine access for channel/newsletter operations so the "session not started" guard
 * and channel business rules (not-found mapping) live behind the service boundary.
 */
@Injectable()
export class ChannelService {
  constructor(private readonly sessionService: SessionService) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
  }

  getSubscribedChannels(sessionId: string) {
    return this.getEngine(sessionId).getSubscribedChannels();
  }

  async getChannelById(sessionId: string, channelId: string) {
    const channel = await this.getEngine(sessionId).getChannelById(channelId);
    if (!channel) {
      throw new NotFoundException(`Channel ${channelId} not found`);
    }
    return channel;
  }

  getChannelMessages(sessionId: string, channelId: string, limit?: number) {
    return this.getEngine(sessionId).getChannelMessages(channelId, limit);
  }

  subscribeToChannel(sessionId: string, inviteCode: string) {
    return this.getEngine(sessionId).subscribeToChannel(inviteCode);
  }

  unsubscribeFromChannel(sessionId: string, channelId: string) {
    return this.getEngine(sessionId).unsubscribeFromChannel(channelId);
  }
}

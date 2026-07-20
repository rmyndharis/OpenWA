import { Injectable, BadRequestException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Owns engine access for call operations. Controllers depend on this service instead of
 * reaching for the raw `IWhatsAppEngine` via `sessionService.getEngine`, so the "session not
 * started" guard lives in one place (mirrors GroupService).
 */
@Injectable()
export class CallService {
  constructor(private readonly sessionService: SessionService) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException('Session is not started');
    }
    return engine;
  }

  /**
   * Reject a currently-ringing incoming call. An unknown or no-longer-ringing callId surfaces
   * as 404 via the adapter's CallNotFoundError; EngineNotSupportedError would map to 501 (both
   * engines support rejectCall today, so no special-casing here).
   */
  rejectCall(sessionId: string, callId: string): Promise<void> {
    return this.getEngine(sessionId).rejectCall(callId);
  }
}

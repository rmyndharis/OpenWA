import { Injectable } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Owns engine access for call operations. Controllers depend on this service instead of
 * reaching for the raw `IWhatsAppEngine` via `sessionService.getEngine`, so the "session not
 * started" guard lives in one place (mirrors GroupService).
 */
@Injectable()
export class CallService {
  constructor(private readonly engines: EngineRegistry) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
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

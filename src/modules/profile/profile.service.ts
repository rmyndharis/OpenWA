import { Injectable } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine, MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';
import { resolveMediaBody } from '../message/media-cap.util';
import { SetProfilePictureDto } from './dto/profile.dto';

/**
 * Owns engine access for own-profile operations. Thin pass-throughs behind the same
 * "session not started" guard as the other session-scoped services (see GroupService).
 */
@Injectable()
export class ProfileService {
  constructor(private readonly engines: EngineRegistry) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
  }

  setProfileName(sessionId: string, name: string) {
    return this.getEngine(sessionId).setProfileName(name);
  }

  setProfileStatus(sessionId: string, status: string) {
    return this.getEngine(sessionId).setProfileStatus(status);
  }

  /** Remove the account's own picture. Idempotent: no picture to remove is a no-op, not an error. */
  deleteProfilePicture(sessionId: string) {
    return this.getEngine(sessionId).deleteProfilePicture();
  }

  /** Map the JSON media body to a MediaInput exactly like the message module's media sends do. */
  setProfilePicture(sessionId: string, dto: SetProfilePictureDto) {
    // base64 wins over url when both are present (mirrors buildMediaInput, #670).
    const media: MediaInput = resolveMediaBody(dto, {
      fallbackMimetype: 'image/jpeg',
      requireMimetypeForBase64: true,
      checkUrl: true,
    });
    return this.getEngine(sessionId).setProfilePicture(media);
  }
}

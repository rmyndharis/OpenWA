import { Injectable, BadRequestException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine, MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';
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
    const base64 = stripBase64DataUri(dto.base64);
    if (!dto.url && !base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }
    if (base64 && !dto.mimetype) {
      throw new BadRequestException('mimetype is required when using base64 data');
    }
    assertBase64WithinMediaCap(base64);
    const media: MediaInput = {
      mimetype: dto.mimetype || 'image/jpeg',
      // base64 wins over url when both are present (mirrors buildMediaInput, #670).
      data: base64 || dto.url!,
    };
    return this.getEngine(sessionId).setProfilePicture(media);
  }
}

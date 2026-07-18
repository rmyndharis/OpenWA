import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import type { Status, StatusResult, StatusPostOptions } from '../../engine/interfaces/whatsapp-engine.interface';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';

@Injectable()
export class StatusService {
  constructor(private readonly sessionService: SessionService) {}

  async getStatuses(sessionId: string): Promise<Status[]> {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new NotFoundException(`Session ${sessionId} not found or not connected`);
    }
    return engine.getContactStatuses();
  }

  async getContactStatus(sessionId: string, contactId: string): Promise<Status[]> {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new NotFoundException(`Session ${sessionId} not found or not connected`);
    }
    return engine.getContactStatus(contactId);
  }

  async postTextStatus(sessionId: string, text: string, options: StatusPostOptions): Promise<StatusResult> {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new NotFoundException(`Session ${sessionId} not found or not connected`);
    }
    return engine.postTextStatus(text, options);
  }

  async postImageStatus(
    sessionId: string,
    media: { url?: string; base64?: string; mimetype?: string } | undefined,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    const base64 = stripBase64DataUri(media?.base64);
    const url = media?.url;
    const mimetype = media?.mimetype;
    if (!url && !base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }
    assertBase64WithinMediaCap(base64);
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new NotFoundException(`Session ${sessionId} not found or not connected`);
    }
    return engine.postImageStatus({ mimetype: mimetype ?? 'image/jpeg', data: base64 || url || '' }, options);
  }

  async postVideoStatus(
    sessionId: string,
    media: { url?: string; base64?: string; mimetype?: string } | undefined,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    const base64 = stripBase64DataUri(media?.base64);
    const url = media?.url;
    const mimetype = media?.mimetype;
    if (!url && !base64) {
      throw new BadRequestException('Either url or base64 must be provided');
    }
    assertBase64WithinMediaCap(base64);
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new NotFoundException(`Session ${sessionId} not found or not connected`);
    }
    return engine.postVideoStatus({ mimetype: mimetype ?? 'video/mp4', data: base64 || url || '' }, options);
  }

  async deleteStatus(sessionId: string, statusId: string): Promise<void> {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new NotFoundException(`Session ${sessionId} not found or not connected`);
    }
    return engine.deleteStatus(statusId);
  }
}

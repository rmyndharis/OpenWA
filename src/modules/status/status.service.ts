import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import type { Status, StatusResult, StatusPostOptions } from '../../engine/interfaces/whatsapp-engine.interface';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';
import { HookManager, applySendingGate } from '../../core/hooks';

@Injectable()
export class StatusService {
  // HookManager comes from the @Global() HooksModule, so no module import is needed here.
  constructor(
    private readonly sessionService: SessionService,
    private readonly hookManager: HookManager,
  ) {}

  /**
   * A status post is content published from the account, so it goes through the same
   * `message:sending` moderation gate as a chat send. `source` distinguishes it from MessageService
   * for plugins that only want to police one of the two.
   *
   * Note for plugin authors: `input` here is NOT a send DTO — it carries no `chatId`. Text posts
   * receive `{ text, options }` and media posts `{ media: { mimetype, data }, options }`.
   */
  private gate<T extends object>(sessionId: string, type: string, input: T): Promise<T> {
    return applySendingGate(this.hookManager, sessionId, type, input, 'StatusService');
  }

  /**
   * Re-apply the media guards to whatever the gate returned. A plugin may rewrite `media.data`, and
   * a rewritten payload has to clear the same data-URI and size checks as the original — this is
   * what the chat path gets for free by gating first and calling buildMediaInput afterwards
   * (`message.service.ts`). Here the guards run before the gate too, so a plugin cannot use a
   * rewrite to slip past `MEDIA_DOWNLOAD_MAX_BYTES`.
   */
  private guardGatedMedia(media: { mimetype: string; data: string }): { mimetype: string; data: string } {
    // `data` carries either a URL or base64 — the two are indistinguishable once merged into one
    // field. Both helpers are safe over either form: stripping a data-URI prefix leaves a URL
    // untouched, and the decoded-byte cap on a URL-length string is trivially satisfied.
    const data = stripBase64DataUri(media.data) ?? media.data;
    assertBase64WithinMediaCap(data);
    return { mimetype: media.mimetype, data };
  }

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
    const gated = await this.gate(sessionId, 'status-text', { text, options });
    return engine.postTextStatus(gated.text, gated.options);
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
    const gated = await this.gate(sessionId, 'status-image', {
      media: { mimetype: mimetype ?? 'image/jpeg', data: base64 || url || '' },
      options,
    });
    return engine.postImageStatus(this.guardGatedMedia(gated.media), gated.options);
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
    const gated = await this.gate(sessionId, 'status-video', {
      media: { mimetype: mimetype ?? 'video/mp4', data: base64 || url || '' },
      options,
    });
    return engine.postVideoStatus(this.guardGatedMedia(gated.media), gated.options);
  }

  async deleteStatus(sessionId: string, statusId: string): Promise<void> {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new NotFoundException(`Session ${sessionId} not found or not connected`);
    }
    return engine.deleteStatus(statusId);
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { StatusStoreService } from '../status-store/status-store.service';
import { StorageService, isMissingObjectError } from '../../common/storage/storage.service';
import type { Status, StatusResult, StatusPostOptions } from '../../engine/interfaces/whatsapp-engine.interface';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';
import { HookManager, applySendingGate } from '../../core/hooks';
import { SendPacingService, countsTowardSendBreaker } from '../message/send-pacing.service';

/** Stored status media is only ever an image, a video or a voice note; a sender-declared mimetype
 * outside that is served as inert octet-stream so the media endpoint can't be turned into active
 * content (HTML/JS) on the API origin. Audio belongs here because a voice status is a first-class
 * status type — without it the dashboard's audio player is handed an octet-stream it cannot play. */
const SAFE_STATUS_MIMETYPE = /^(image|video|audio)\//;

@Injectable()
export class StatusService {
  // HookManager comes from the @Global() HooksModule, StorageService from the @Global()
  // StorageModule — neither needs a module import here.
  constructor(
    private readonly engines: EngineRegistry,
    private readonly hookManager: HookManager,
    private readonly store: StatusStoreService,
    private readonly storageService: StorageService,
    private readonly pacing: SendPacingService,
  ) {}

  /**
   * A status post is content published from the account, so it goes through the same
   * `message:sending` moderation gate as a chat send. `source` distinguishes it from MessageService
   * for plugins that only want to police one of the two.
   *
   * Note for plugin authors: `input` here is NOT a send DTO — it carries no `chatId`. Text posts
   * receive `{ text, options }` and media posts `{ media: { mimetype, data }, options }`.
   */
  private async gate<T extends object>(sessionId: string, type: string, input: T): Promise<T> {
    // Pacing first, for the same reason as the chat path: a post the policy forbids is never offered
    // to plugins. A status post is published to the account's contacts, so it counts as outbound
    // traffic even though it addresses no single chat.
    await this.pacing.assertSendAllowed(sessionId);
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

  // Reads come from the store (StatusStoreService ingests status broadcasts as they arrive, plus a
  // best-effort seed on connect), not the engine — Baileys never implemented
  // `getContactStatuses`/`getContactStatus`, so both engines now answer reads identically from the
  // same 24h-TTL store.
  async getStatuses(sessionId: string): Promise<Status[]> {
    return this.store.list(sessionId);
  }

  async getContactStatus(sessionId: string, contactId: string): Promise<Status[]> {
    return this.store.listByContact(sessionId, contactId);
  }

  async getStatusMedia(sessionId: string, statusId: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const media = await this.store.getMedia(sessionId, statusId);
    if (!media) {
      throw new NotFoundException('Status media not found or expired');
    }
    try {
      const buffer = await this.storageService.getFile(media.path);
      const mimetype = SAFE_STATUS_MIMETYPE.test(media.mimetype) ? media.mimetype : 'application/octet-stream';
      return { buffer, mimetype };
    } catch (error) {
      // The row outlived its file: purgeExpired (or a concurrent delete) removed it between the
      // DB read and this read. That's "gone", not a server fault — surface a 404. The helper covers
      // both backends: the local ENOENT and the codeless NoSuchKey/NotFound an S3 miss raises.
      if (isMissingObjectError(error)) {
        throw new NotFoundException('Status media not found or expired');
      }
      throw error;
    }
  }

  /**
   * Report the engine post's outcome to the pacing breaker, exactly as the chat send path does
   * (message.service failSend/persistSentState): the engine was asked, so a refusal counts toward
   * the failure streak and an accept resets it. The pre-engine pacing/plugin gate runs OUTSIDE this
   * wrapper, so a policy refusal never feeds the breaker — and neither do the client-fault checks
   * the adapters run inside the call (Baileys refuses a status with no recipients, a media URL can
   * be SSRF-blocked): those say nothing about the account's standing. See countsTowardSendBreaker.
   */
  private async recordedPost(sessionId: string, post: () => Promise<StatusResult>): Promise<StatusResult> {
    try {
      const result = await post();
      this.pacing.recordSendSuccess(sessionId);
      return result;
    } catch (error) {
      if (countsTowardSendBreaker(error)) {
        this.pacing.recordSendFailure(sessionId);
      }
      throw error;
    }
  }

  async postTextStatus(sessionId: string, text: string, options: StatusPostOptions): Promise<StatusResult> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    const gated = await this.gate(sessionId, 'status-text', { text, options });
    return this.recordedPost(sessionId, () => engine.postTextStatus(gated.text, gated.options));
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
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    const gated = await this.gate(sessionId, 'status-image', {
      media: { mimetype: mimetype ?? 'image/jpeg', data: base64 || url || '' },
      options,
    });
    return this.recordedPost(sessionId, () => engine.postImageStatus(this.guardGatedMedia(gated.media), gated.options));
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
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    const gated = await this.gate(sessionId, 'status-video', {
      media: { mimetype: mimetype ?? 'video/mp4', data: base64 || url || '' },
      options,
    });
    return this.recordedPost(sessionId, () => engine.postVideoStatus(this.guardGatedMedia(gated.media), gated.options));
  }

  /**
   * Post an audio status as a voice note.
   *
   * The mimetype defaults to Ogg/Opus because that is the only thing WhatsApp plays as a status
   * voice note, and neither engine transcodes — the media conversion endpoints produce it. A caller
   * that supplies another type is taken at its word; the result is an unplayable bubble, exactly as
   * it is for a voice message.
   *
   * There is no caption: WhatsApp has nowhere to render one on a status voice note.
   */
  async postVoiceStatus(
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
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    const gated = await this.gate(sessionId, 'status-voice', {
      media: { mimetype: mimetype ?? 'audio/ogg; codecs=opus', data: base64 || url || '' },
      options,
    });
    return this.recordedPost(sessionId, () => engine.postVoiceStatus(this.guardGatedMedia(gated.media), gated.options));
  }

  async deleteStatus(sessionId: string, statusId: string): Promise<void> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    return engine.deleteStatus(statusId);
  }
}

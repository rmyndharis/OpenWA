import type { AnyMessageContent, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { MediaInput, StatusPostOptions, StatusResult } from '../interfaces/whatsapp-engine.interface';
import { BadRequestException } from '@nestjs/common';
import { resolveMediaBuffer } from './baileys-messaging';

/**
 * Status-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysStatusHost {
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  toEngineJid(jid: string): string;
  normalizedSelfJid(): string;
  /** Baileys timestamps are `number | Long`; normalize to unix seconds. */
  toUnixSeconds(ts: number | { toNumber(): number } | null | undefined): number;
}

export class BaileysStatus {
  constructor(private readonly host: BaileysStatusHost) {}

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    return this.postStatus({ text }, options);
  }

  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('image', media, options);
  }

  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('video', media, options);
  }

  postVoiceStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('voice', media, options);
  }

  private async postMediaStatus(
    kind: 'image' | 'video' | 'voice',
    media: MediaInput,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    this.host.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    // A voice status carries no caption: WhatsApp has nowhere to render one on a status voice note,
    // and `ptt` is what makes it a voice note rather than an audio file. Baileys reads that same flag
    // to decide a status may take a background colour, so the colour `postStatus` already forwards
    // applies here for free.
    const content: AnyMessageContent =
      kind === 'image'
        ? { image: data, caption: options.caption, mimetype }
        : kind === 'video'
          ? { video: data, caption: options.caption, mimetype }
          : { audio: data, mimetype, ptt: true };
    return this.postStatus(content, options);
  }

  /**
   * Best-effort status revoke. Unlike deleteMessage, status messages are NOT persisted, so the revoke
   * key must be constructed from statusId alone (no messageStore lookup). The participant is the
   * engine-dialect self JID (`<me>@s.whatsapp.net`). The revoke shape is empirically UNVERIFIED — the
   * live spike only tested posting; if WhatsApp rejects it, fall back to EngineNotSupportedError.
   */
  async deleteStatus(statusId: string): Promise<void> {
    this.host.ensureReady();
    await this.sock().sendMessage('status@broadcast', {
      delete: {
        remoteJid: 'status@broadcast',
        fromMe: true,
        id: statusId,
        participant: this.host.toEngineJid(this.host.normalizedSelfJid()),
      },
    });
  }

  /**
   * Post a status (story) to `status@broadcast` with a denormalized `statusJidList` (the allow-list of
   * neutral recipients folded back to the engine dialect). Image/video variants route through here too.
   * The outbound status echo is NOT persisted — status isn't a chat message (the inbound filter in
   * handleMessagesUpsert already skips `type:'append'` echoes).
   */
  private async postStatus(content: AnyMessageContent, options: StatusPostOptions): Promise<StatusResult> {
    this.host.ensureReady();
    // Baileys posts to exactly the statusJidList allow-list, so unlike whatsapp-web.js (which
    // broadcasts) an absent/empty recipients list would publish to nobody — reject it as a client
    // error here rather than send a status no contact can see.
    if (!options.recipients?.length) {
      throw new BadRequestException('recipients is required to post a status on the Baileys engine');
    }
    const statusJidList = options.recipients.map(r => this.host.toEngineJid(r));
    const sent = await this.sock().sendMessage('status@broadcast', content, {
      statusJidList,
      backgroundColor: options.backgroundColor,
      font: options.font,
    });
    return this.toStatusResult(sent);
  }

  /** Shape a Baileys send result into a StatusResult; expiresAt is timestamp + 24h (WhatsApp status TTL). */
  private toStatusResult(sent: WAMessage | undefined): StatusResult {
    const ts = sent?.messageTimestamp ? new Date(this.host.toUnixSeconds(sent.messageTimestamp) * 1000) : new Date();
    return {
      statusId: sent?.key?.id ?? '',
      timestamp: ts,
      expiresAt: new Date(ts.getTime() + 24 * 3_600_000),
    };
  }
}

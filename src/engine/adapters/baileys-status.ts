import type { AnyMessageContent, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { MediaInput, StatusPostOptions, StatusResult } from '../interfaces/whatsapp-engine.interface';
import { BadRequestException } from '@nestjs/common';
import { mapSendRefusal, resolveMediaBuffer } from './baileys-messaging';
import { describeAudio } from './baileys-audio-probe';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { BAILEYS_QUERY_BUDGET_MS } from './baileys-query-deadline';

/** How long WhatsApp keeps a status up. */
const STATUS_TTL_MS = 24 * 3_600_000;

/**
 * Status-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysStatusHost {
  /** This session's egress proxy URL (snapshotted at session start), or undefined when direct. */
  sessionProxyUrl(): string | undefined;
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  /** The live socket or null, read without a readiness check: null once a stop or logout tore it down. */
  getSocketOrNull(): WASocket | null;
  toEngineJid(jid: string): string;
  normalizedSelfJid(): string;
  /** Baileys timestamps are `number | Long`; normalize to unix seconds. */
  toUnixSeconds(ts: number | string | { toNumber(): number } | null | undefined): number;
  /** Record the id of a message this session just sent, so its library echo is recognised as ours. */
  rememberOwnSend(id: string | null | undefined): void;
}

export class BaileysStatus {
  /** The recipients of each status posted here, until it expires, oldest first. */
  private readonly audiences = new Map<string, { jids: string[]; expiresAt: number }>();

  constructor(private readonly host: BaileysStatusHost) {}

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  /**
   * Send to `status@broadcast`. A send that fails after a stop or logout has torn its socket down is
   * not ready (409), as a chat send is; a failure on a socket still in place propagates. A proxied
   * session's media upload gets a deadline, as a chat send's does (BaileysMessaging.uploadTimeoutMs).
   */
  private async sendStatus(
    content: AnyMessageContent,
    options: Parameters<WASocket['sendMessage']>[2],
  ): Promise<WAMessage | undefined> {
    const sock = this.sock();
    const deadline = this.host.sessionProxyUrl() ? { mediaUploadTimeoutMs: BAILEYS_QUERY_BUDGET_MS } : {};
    try {
      return await sock.sendMessage('status@broadcast', content, { ...options, ...deadline });
    } catch (error) {
      if (this.host.getSocketOrNull() !== sock) throw new EngineNotReadyError();
      throw mapSendRefusal(error);
    }
  }

  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    // `linkPreview: null` is Baileys' explicit "no preview": with the key absent it runs its own
    // generator (link-preview-js, unfixed SSRF advisory) on any URL in the status text.
    return this.postStatus({ text, linkPreview: null }, options);
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
    // The kind's default labels a URL whose host serves a generic type, rather than octet-stream.
    const fallbackType = kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus';
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl(), fallbackType);
    // A voice status carries no caption: WhatsApp has nowhere to render one on a status voice note,
    // and `ptt` is what makes it a voice note rather than an audio file. Baileys reads that same flag
    // to decide a status may take a background colour, so the colour `postStatus` already forwards
    // applies here for free.
    const content: AnyMessageContent =
      kind === 'image'
        ? { image: data, caption: options.caption, mimetype }
        : kind === 'video'
          ? { video: data, caption: options.caption, mimetype }
          : { audio: data, mimetype, ptt: true, ...(await describeAudio(data, true)) };
    return this.postStatus(content, options);
  }

  /**
   * Best-effort status revoke. Unlike deleteMessage, status messages are NOT persisted, so the revoke
   * key must be constructed from statusId alone (no messageStore lookup). The participant is the
   * engine-dialect self JID (`<me>@s.whatsapp.net`). The revoke shape is empirically UNVERIFIED — the
   * live spike only tested posting; if WhatsApp rejects it, fall back to EngineNotSupportedError.
   *
   * Baileys sends a status stanza, the revoke included, to exactly its `statusJidList`: without one
   * the revoke reaches nobody, yet the send resolves and the status stays up for every viewer. Only
   * the recipients of a status this adapter posted are known, so any other id is refused.
   */
  async deleteStatus(statusId: string): Promise<void> {
    this.host.ensureReady();
    const audience = this.audiences.get(statusId);
    if (!audience || audience.expiresAt <= Date.now()) {
      throw new EngineRefusedError(
        `status ${statusId} was not posted by this session in the last 24 hours, so its recipients are ` +
          'unknown and the revoke cannot be addressed to them',
      );
    }
    const sent = await this.sendStatus(
      {
        delete: {
          remoteJid: 'status@broadcast',
          fromMe: true,
          id: statusId,
          participant: this.host.toEngineJid(this.host.normalizedSelfJid()),
        },
      },
      { statusJidList: audience.jids },
    );
    this.host.rememberOwnSend(sent?.key?.id);
  }

  /**
   * Post a status (story) to `status@broadcast` with a denormalized `statusJidList` (the allow-list of
   * neutral recipients folded back to the engine dialect). Image/video variants route through here too.
   * The outbound status echo is NOT persisted: status isn't a chat message (its id is recorded below
   * so handleMessagesUpsert skips the `type:'append'` echo as ours).
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
    const sent = await this.sendStatus(content, {
      statusJidList,
      backgroundColor: options.backgroundColor,
      font: options.font,
    });
    this.host.rememberOwnSend(sent?.key?.id);
    const now = Date.now();
    for (const [id, audience] of this.audiences) {
      if (audience.expiresAt > now) break;
      this.audiences.delete(id);
    }
    if (sent?.key?.id) this.audiences.set(sent.key.id, { jids: statusJidList, expiresAt: now + STATUS_TTL_MS });
    return this.toStatusResult(sent);
  }

  /** Shape a Baileys send result into a StatusResult; expiresAt is timestamp + 24h (WhatsApp status TTL). */
  private toStatusResult(sent: WAMessage | undefined): StatusResult {
    const ts = sent?.messageTimestamp ? new Date(this.host.toUnixSeconds(sent.messageTimestamp) * 1000) : new Date();
    return {
      statusId: sent?.key?.id ?? '',
      timestamp: ts,
      expiresAt: new Date(ts.getTime() + STATUS_TTL_MS),
    };
  }
}

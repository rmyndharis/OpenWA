import { InternalServerErrorException } from '@nestjs/common';
import { MessageTypes, type Client, type Message } from 'whatsapp-web.js';
import {
  IncomingMessage,
  MediaInput,
  Status,
  StatusPostOptions,
  StatusResult,
} from '../interfaces/whatsapp-engine.interface';
import { SerializedWid } from '../types/whatsapp-web-js.types';
import { toMessageMedia } from './wwebjs-messaging';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * The status-post counterpart of `toMessageResult`, but its absent-message case is *narrower* than a
 * send's. `Injected/Utils.js` builds the status model and returns it from the `isStatus` branch before
 * ever reaching the `Msg.get` miss that makes an ordinary send ambiguous — so the only way back with no
 * message is `Client.js`'s `if (!chat) return null`, i.e. nothing was posted at all. Not an ambiguity:
 * a plain failure, which was previously dressed up as a `201` carrying a `new Date()` invented for a
 * status that never existed.
 *
 * Thrown as an `InternalServerErrorException` rather than a bare `Error` because there is no global
 * exception filter (see `message-not-found.error.spec.ts`), so a bare `Error` reaches the caller as
 * `{"statusCode":500,"message":"Internal server error"}` — and unlike a send, which routes its message
 * into the `message:failed` hook, HTTP is the only consumer a status post has. The same 500, with the
 * reason surviving.
 *
 * A present `Message` proves the post happened, so an id it cannot read there carries the same empty
 * sentinel `toMessageResult` uses. Read `$1` before falling back to it (#747): the sentinel means
 * "posted, id unknown", and `deleteStatus` takes this id as the revoke handle — spending it on an id
 * that was readable all along leaves a status nothing can revoke.
 */
export function toStatusResult(msg: Message | undefined): StatusResult {
  if (!msg) {
    throw new InternalServerErrorException(
      'the engine returned no message for this status post, so it may not have been published — check your status before retrying',
    );
  }
  const id = msg.id as unknown as SerializedWid | undefined;
  const ts = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();
  return {
    statusId: id?._serialized ?? id?.$1 ?? '',
    timestamp: ts,
    expiresAt: new Date(ts.getTime() + 24 * 3_600_000),
  };
}

/**
 * Status/Stories operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public
 * methods as thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so
 * the delegate never touches lifecycle state directly.
 */
export class WwebjsStatus {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async getContactStatuses(): Promise<Status[]> {
    this.host.ensureReady();
    return this.collectStatuses(await this.client().getBroadcasts());
  }

  async getContactStatus(contactId: string): Promise<Status[]> {
    this.host.ensureReady();
    // A contact with no active 24h story resolves to an "empty" Broadcast (id/msgs/getContact
    // undefined — Broadcast._patch only runs when data is truthy). That is the common case, so guard
    // it: return [] rather than dereferencing undefined inside collectStatuses (→ 500).
    const broadcast = await this.client().getBroadcastById(contactId);
    return broadcast?.msgs?.length ? this.collectStatuses([broadcast]) : [];
  }

  /**
   * Map whatsapp-web.js story Broadcasts (+ their Messages) into the neutral Status shape. Each
   * Broadcast is one contact's story (its `msgs`); we flatten across broadcasts. type collapses to
   * the Status union (image/video, else text — audio/other stories are rare and become 'text').
   * expiresAt is timestamp + 24h (WhatsApp status TTL). Broadcasts without msgs are skipped (a story
   * that expired between getBroadcasts and here, or a phantom entry).
   */
  private async collectStatuses(
    broadcasts: ReadonlyArray<{
      msgs?: Message[];
      getContact: () => Promise<{ id: { _serialized: string }; name?: string; pushname?: string }>;
    }>,
  ): Promise<Status[]> {
    const statuses: Status[] = [];
    for (const broadcast of broadcasts) {
      if (!broadcast?.msgs?.length) {
        continue;
      }
      const contact = await broadcast.getContact();
      const contactSummary = {
        id: contact.id._serialized,
        ...(contact.name ? { name: contact.name } : {}),
        ...(contact.pushname ? { pushName: contact.pushname } : {}),
      };
      for (const msg of broadcast.msgs) {
        const ts = new Date(msg.timestamp * 1000);
        // Reuse the same capped/limited/timeout-bounded inbound media download the live message path
        // uses (capInboundMediaFor), so a seeded status renders identically to one that arrived live.
        let media: IncomingMessage['media'];
        if (msg.hasMedia) {
          try {
            media = await this.host.capInboundMediaFor(msg);
          } catch (error) {
            this.host.logger.warn(`Failed to download media for status ${msg.id._serialized}: ${String(error)}`);
          }
        }
        statuses.push({
          // `deleteStatus` takes this id as its revoke handle, so losing it to the rename makes a
          // listed status unactionable (#747). The contact id above is a Wid and is unaffected.
          id: ((msg.id as unknown as SerializedWid)?._serialized ?? (msg.id as unknown as SerializedWid)?.$1) || '',
          contact: contactSummary,
          type:
            msg.type === MessageTypes.IMAGE
              ? 'image'
              : msg.type === MessageTypes.VIDEO
                ? 'video'
                : // MessageTypes.VOICE is wwjs' name for 'ptt'. Without this a posted voice status
                  // reads back as a text status, which is what everything non-image/video collapsed to.
                  msg.type === MessageTypes.VOICE
                  ? 'voice'
                  : 'text',
          ...(msg.body ? { caption: msg.body } : {}),
          ...(media ? { media } : {}),
          timestamp: ts,
          expiresAt: new Date(ts.getTime() + 24 * 3_600_000),
        });
      }
    }
    return statuses;
  }

  private warnedStatusRecipients = false;

  async postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    this.host.ensureReady();
    this.warnStatusRecipientsOnce(options);
    // whatsapp-web.js posts a text status by messaging status@broadcast with styling in `extra`
    // (Client.js maps options.extra → page extraOptions → sendStatusTextMsgAction in Utils.js).
    // backgroundColor is a #RRGGBB hex; font is the fontStyle index 0-7.
    const msg = await this.client().sendMessage('status@broadcast', text, {
      extra: {
        ...(options.backgroundColor !== undefined ? { backgroundColor: options.backgroundColor } : {}),
        ...(options.font !== undefined ? { fontStyle: options.font } : {}),
      },
    });
    return toStatusResult(msg);
  }

  async postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus(media, options);
  }

  async postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus(media, options);
  }

  async postVoiceStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    // `sendAudioAsVoice` is what makes the bubble a voice note rather than an audio file: it becomes
    // `isPtt` inside the page. The waveform is separate — whatsapp-web.js already generates one for
    // any audio going to status, so it appears either way, but only this flag changes the bubble.
    return this.postMediaStatus(media, options, { sendAudioAsVoice: true });
  }

  private async postMediaStatus(
    media: MediaInput,
    options: StatusPostOptions,
    extra?: { sendAudioAsVoice: true },
  ): Promise<StatusResult> {
    this.host.ensureReady();
    this.warnStatusRecipientsOnce(options);
    const messageMedia = await toMessageMedia(media);
    const msg = await this.client().sendMessage('status@broadcast', messageMedia, {
      ...(options.caption !== undefined ? { caption: options.caption } : {}),
      ...extra,
    });
    return toStatusResult(msg);
  }

  private warnStatusRecipientsOnce(options: StatusPostOptions): void {
    if (this.warnedStatusRecipients || !options.recipients?.length) return;
    this.warnedStatusRecipients = true;
    this.host.logger.warn(
      "postStatus on the whatsapp-web.js engine broadcasts to the account's status-privacy audience; " +
        'the recipients allow-list is not honored by whatsapp-web.js (it is on the Baileys engine).',
    );
  }

  async deleteStatus(statusId: string): Promise<void> {
    this.host.ensureReady();
    // Revokes the caller's own status post. revokeStatusMessage resolves the message by id and
    // throws if it isn't fromMe/isn't a status — the statusId returned by postText/Image/VideoStatus
    // (msg.id._serialized) is the id it expects.
    await this.client().revokeStatusMessage(statusId);
  }
}

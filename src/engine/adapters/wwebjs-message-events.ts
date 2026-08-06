import { type Client, MessageTypes } from 'whatsapp-web.js';
import {
  type IncomingMessage,
  type RevokedMessage,
  type ReactionEvent,
  type EditedMessage,
} from '../interfaces/whatsapp-engine.interface';
import { type SerializedWid } from '../types/whatsapp-web-js.types';
import { buildEditedMessage, buildIncomingMessageBase, mapContactFields } from './message-mapper';
import { extractWwebjsCall, wwebjsAckToDeliveryStatus } from './wwebjs-messaging';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Message-domain client events (message, message_create, ack, revoke, reaction, edit) extracted
 * from the adapter's setupEventHandlers: pure mapping from wwebjs payloads to neutral events fired
 * through the engine callbacks. Connection-state events (qr/authenticated/ready/disconnected/
 * auth_failure) stay in the adapter — they drive the lifecycle latches this file never touches.
 */
export function registerWwebjsMessageEvents(client: Client, host: WwebjsEngineHost): void {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  client.on('message', async msg => {
    try {
      const incomingMessage: IncomingMessage = buildIncomingMessageBase(msg);

      // Attach the sender's contact info. getContact() gives the real sender (author in groups, from
      // in 1:1); we read only its synchronous fields and never the async getters (profile pic, about),
      // which would hit WhatsApp on every message.
      try {
        const contact = await msg.getContact();
        if (contact) {
          // Off by default the payload keeps { name, pushName }; WEBHOOK_CONTACT_DETAILS opts into the
          // full set. Merge over the base so the notifyName pushName isn't lost, and skip an empty
          // result so we don't emit an empty contact object.
          const full = process.env.WEBHOOK_CONTACT_DETAILS === 'true';
          const merged = { ...incomingMessage.contact, ...mapContactFields(contact, full) };
          if (Object.keys(merged).length > 0) {
            incomingMessage.contact = merged;
          }
        }
      } catch (error) {
        host.logger.error('Error getting message contact', String(error));
      }

      // Handle location
      if (msg.type === MessageTypes.LOCATION && msg.location) {
        incomingMessage.location = {
          latitude: Number(msg.location.latitude),
          longitude: Number(msg.location.longitude),
          description: msg.location.description || undefined,
          address: msg.location.address || undefined,
          url: msg.location.url || undefined,
        };
      }

      // Handle media
      if (msg.hasMedia) {
        try {
          const capped = await host.capInboundMediaFor(msg);
          if (capped) incomingMessage.media = capped;
        } catch (error) {
          host.logger.error('Error downloading media', String(error));
        }
      }

      // Handle quoted message
      if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          incomingMessage.quotedMessage = {
            id: quoted.id._serialized,
            body: quoted.body,
          };
        } catch (error) {
          host.logger.error('Error getting quoted message', String(error));
        }
      }

      // Surface call-log detail on the live path too (getChatHistory already does this), so a missed/
      // video incoming call renders a labeled bubble instead of a generic "Call".
      const call = extractWwebjsCall(msg);
      if (call) incomingMessage.call = call;

      host.getCallbacks().onMessage?.(incomingMessage);
    } catch (error) {
      host.logger.error('Error processing incoming message', String(error));
    }
  });

  client.on('message_create', msg => {
    // `message_create` fires for every message the account creates — including ones composed on a
    // linked phone, which the `message` event above never delivers. Incoming messages are already
    // handled there, so forward only the account's own outgoing (`fromMe`) messages; this is the
    // single source for `message.sent` (covers API sends and phone-composed self-messages alike).
    if (!msg.fromMe) {
      return;
    }

    void (async () => {
      const incomingMessage = buildIncomingMessageBase(msg);
      // Enrich with the media payload through the same capped path the incoming handler uses —
      // the base builder is sync and carries none, so a phone-sent image would otherwise persist
      // and render as a bare 📎 marker even though the media is downloadable right here.
      if (msg.hasMedia) {
        try {
          incomingMessage.media = await host.capInboundMediaFor(msg);
        } catch (error) {
          host.logger.warn('Own-send media download failed; emitting echo without media', {
            msgId: msg.id?._serialized,
            error: String(error),
          });
        }
      }
      try {
        host.getCallbacks().onMessageCreate?.(incomingMessage);
      } catch (error) {
        host.logger.error('Error processing outgoing message', String(error));
      }
    })();
  });

  client.on('message_ack', (msg, ack) => {
    // An unreadable id (a WhatsApp Web build renaming the field, as in #747) would reach the ack
    // UPDATE as undefined, which TypeORM sends as `waMessageId = NULL` — matching nothing, since
    // `x = NULL` is never true. The ack then silently advances no row AND burns its one-shot retry,
    // so the message stays at SENT with only a misleading "no status row advanced" in the log. Drop
    // it here, where the reason is still visible. (Note this differs from the reaction path below,
    // where `findOne` DROPS an undefined key instead of nulling it and matches an arbitrary row.)
    // Read `$1` before giving up, as the send path does (#747): a build that renamed the field still
    // has a perfectly good id here, and dropping it strands the message at SENT — including the
    // `ack < 0` that is the only signal a send failed.
    const rawId = msg.id as unknown as SerializedWid | undefined;
    const ackId = rawId?._serialized ?? rawId?.$1;
    if (!ackId) {
      host.logger.warn('Dropping an ack whose message id could not be read', { ack });
      return;
    }
    // Map the whatsapp-web.js MessageAck integer to the neutral DeliveryStatus here, at the
    // adapter boundary, so no downstream consumer ever sees engine-specific ack codes.
    host.getCallbacks().onMessageAck?.(ackId, wwebjsAckToDeliveryStatus(ack));
  });

  client.on('message_revoke_everyone', (after, before) => {
    try {
      const selfWid = host.getSelfWid();
      // Emit structured data only; the engine layer never produces a localized
      // display string. The dashboard renders the localized "message deleted" text.
      //
      // `after` is the revocation notification (its own id); `before` is the
      // ORIGINAL deleted message (when whatsapp-web.js has it in the local store).
      // We forward `before.id` as `revokedId` so consumers can reconcile the
      // deleted message in their own storage.
      // Both ids read `$1` before giving up (#747). `revokedId` needs it even on a patched tree:
      // `Client.js` overwrites the normalized id with a raw spread of `protocolMessageKey`
      // (`revoked_msg.id = { ...message.protocolMessageKey }`), and that key is normalized by
      // neither the structure constructor nor the injected serializer — so this is the one place a
      // patched build still hands us a raw MsgKey. Losing it strands the revocation: the UPDATE
      // falls back to the notification's own id, matches no row, and the deleted body stays put.
      const afterId = after.id as unknown as SerializedWid | undefined;
      const beforeId = before?.id as unknown as SerializedWid | undefined;
      const payload: RevokedMessage = {
        id: afterId?._serialized ?? afterId?.$1 ?? '',
        revokedId: beforeId?._serialized ?? beforeId?.$1,
        chatId: after.from === selfWid ? after.to : after.from,
        from: after.from,
        to: after.to,
        type: 'revoked',
        body: '',
        timestamp: after.timestamp,
      };
      host.getCallbacks().onMessageRevoked?.(payload);
    } catch (error) {
      host.logger.error('Error processing message_revoke_everyone', String(error));
    }
  });

  client.on('message_reaction', reaction => {
    try {
      // `Reaction` assigns its keys straight through (`this.msgId = data.parentMsgKey`), which
      // upstream's id normalization doesn't reach: it covers structure constructors and `msg.id`,
      // not keys assigned straight through (`Message.protocolMessageKey` and `Reaction.id` are the
      // same pattern). On a WA Web build that renamed `_serialized` to `$1` (#747),
      // `msgId._serialized` is undefined even with the backport applied.
      // Read `$1` as a fallback, and fall back again to `''` (the same no-id sentinel Baileys uses)
      // rather than pass undefined on: `applyReaction` looks the message up by this id, and TypeORM
      // DROPS an undefined condition from the where-clause — which would match an arbitrary row and
      // emit another message's reactions. Empty string finds nothing and returns cleanly.
      const msgId = reaction.msgId as unknown as SerializedWid;
      const event: ReactionEvent = {
        messageId: msgId?._serialized ?? msgId?.$1 ?? '',
        chatId: reaction.id.remote,
        reaction: reaction.reaction,
        senderId: reaction.senderId,
      };
      host.getCallbacks().onMessageReaction?.(event);
    } catch (error) {
      host.logger.error('Error processing message_reaction', String(error));
    }
  });

  client.on('message_edit', (message, newBody) => {
    try {
      // whatsapp-web.js keeps `message.timestamp` at the ORIGINAL creation time. Consumers need
      // occurrence time for ordering multiple edits, so stamp the edit at receipt and project the
      // otherwise-normal message fields through the same adapter mapper used by inbound messages.
      const editTimestamp = Math.floor(Date.now() / 1000);
      const base = buildIncomingMessageBase({
        id: message.id,
        from: message.from,
        to: message.to,
        body: String(newBody),
        type: message.type,
        timestamp: editTimestamp,
        fromMe: message.fromMe,
        author: message.author,
        mentionedIds: message.mentionedIds,
      });
      const payload: EditedMessage = buildEditedMessage(base, Boolean(message.hasMedia));
      host.getCallbacks().onMessageEdited?.(payload);
    } catch (error) {
      host.logger.error('Error processing message_edit', String(error));
    }
  });
}

import { createHash } from 'crypto';
import { type Client, type Message, MessageTypes } from 'whatsapp-web.js';
import {
  type InboundTicket,
  type IncomingMessage,
  type RevokedMessage,
  type ReactionEvent,
  type EditedMessage,
  type PollVoteEvent,
} from '../interfaces/whatsapp-engine.interface';
import { readWid, type SerializedWid } from '../types/whatsapp-web-js.types';
import { buildEditedMessage, buildIncomingMessageBase, mapContactFields } from './message-mapper';
import { extractWwebjsCall, plannedInboundDownload, wwebjsAckToDeliveryStatus } from './wwebjs-messaging';
import { admitInboundSafely, inboundMediaTimeoutMs, withInboundDownloadTimeout } from './inbound-media-cap';
import { type WwebjsEngineHost } from './wwebjs-host';

/** How many messages being processed have their changes kept at once, and how many changes one message keeps. */
const MAX_MESSAGES_IN_PROCESSING = 5_000;
const MAX_CHANGES_KEPT_PER_MESSAGE = 64;

/** A message this adapter is still processing: what it carries so far, and the changes that reached it. */
interface MessageInProcessing {
  /** The text it arrived with, then that of the latest edit. */
  text: string;
  /** The text the first delivery arrived with: a repeat is built from the message as it is now, edited. */
  arrived: string;
  /** An edit changed its text, though a later one may have restored the text it arrived with. */
  edited: boolean;
  /** A delete for everyone reached it. */
  deleted: boolean;
  /** Its deliveries still being processed: it is forgotten once the last of them ends. */
  deliveries: number;
  /** One of them ended: what reaches the message since goes at once, and is noted here for the others. */
  delivered: boolean;
  changes: Array<() => void>;
}

/** What the processing of one message does with the changes that reached it meanwhile. */
interface Processing {
  /** Apply the latest edit to the copy about to be handed over. False when a delete reached it: it is not handed over. */
  handOver: (message: IncomingMessage) => boolean;
  /** The processing ended, however it did: deliver the kept changes in arrival order; the last to end forgets them. */
  end: () => void;
}

/** A change to a message that is processed: the text of an edit, or a delete for everyone. */
interface Change {
  editedText?: string;
  deletes?: boolean;
}

/** The processing of a message whose changes are not kept: the session holds it, or it is not tracked. */
const NOT_KEPT: Processing = { handOver: () => true, end: () => undefined };

/**
 * Message-domain client events (message, message_create, ack, revoke, reaction, edit, vote) extracted
 * from the adapter's event wiring: pure mapping from wwebjs payloads to neutral events fired
 * through the engine callbacks. Connection-state events (qr/authenticated/ready/disconnected/
 * auth_failure) stay in the lifecycle module (./wwebjs-lifecycle) — they drive the lifecycle
 * latches this file never touches.
 */
export function registerWwebjsMessageEvents(client: Client, host: WwebjsEngineHost): void {
  // Where the session holds a message until its row is written (PostgreSQL), each arrival is admitted
  // synchronously, before anything awaits, so its chat's order and its room follow arrival. The
  // ticket keeps the room until the processing settles, and is dropped when nothing was emitted.
  const admit = (msg: Message, base: IncomingMessage, mayDownload: boolean): InboundTicket | undefined =>
    admitInboundSafely(
      () =>
        host.getCallbacks().admitInbound?.({
          id: base.id,
          chatId: base.chatId,
          status: Boolean(base.isStatusBroadcast),
          needsRoom: mayDownload && plannedInboundDownload(msg),
          fromMe: base.fromMe,
          ...(base.author ? { author: base.author } : {}),
        }),
      error =>
        host.logger.error(
          `Could not admit inbound message ${base.id}; processing it without room for media`,
          String(error),
        ),
    );
  const holdWhileProcessing = (ticket: InboundTicket | undefined, done: Promise<void>): void => {
    ticket?.holdUntil(done);
    void done.then(
      () => ticket?.drop(),
      () => ticket?.drop(),
    );
  };

  // A message reaches the session once its contact, media and quoted message were fetched. A session that holds
  // each arrival (a ticket, PostgreSQL) keeps what reaches the message meanwhile for its row. Any other learns of
  // the message only when it is handed over, so an edit or a delete for everyone that came first would find no
  // row to change, and the message would then be hooked, stored and announced as it was: a deleted one with its
  // content. A reaction would never reach the row. So the adapter keeps those changes here, by message id. The
  // message is handed over with the latest edit applied, or not at all when it was deleted, as the Baileys adapter
  // does, and the changes themselves are delivered right after it, so the session still announces them and marks
  // the edit.
  const inProcessing = new Map<string, MessageInProcessing>();

  const deliverKept = (kept: MessageInProcessing): void => {
    for (const deliver of kept.changes.splice(0)) {
      try {
        deliver();
      } catch (error) {
        host.logger.error('Error delivering a change that reached a message while it was processed', String(error));
      }
    }
  };

  /**
   * Start keeping what reaches a message the session does not hold. `end` must run once when the processing ends,
   * however it ends. A repeat delivery of an id shares the record of the first, which is forgotten once the last of
   * them ended.
   */
  const keepChanges = (message: IncomingMessage, ticket: InboundTicket | undefined): Processing => {
    if (ticket || !message.id || message.isStatusBroadcast) return NOT_KEPT;
    let kept = inProcessing.get(message.id);
    // whatsapp-web.js raises message and message_create for a message WhatsApp Web adds already deleted. Such a
    // delivery takes no text from one of the id still processed, which is then not handed over, and keeps nothing.
    if (message.type === 'revoked') {
      if (kept) kept.deleted = true;
      return NOT_KEPT;
    }
    if (!kept) {
      // Past the bound a message is not tracked, and what reaches it is delivered at once, as it always was.
      if (inProcessing.size >= MAX_MESSAGES_IN_PROCESSING) return NOT_KEPT;
      kept = {
        text: message.body,
        arrived: message.body,
        edited: false,
        deleted: false,
        deliveries: 0,
        delivered: false,
        changes: [],
      };
      inProcessing.set(message.id, kept);
    }
    const mine = kept;
    mine.deliveries++;
    return {
      handOver: handedOver => {
        if (mine.deleted) return false;
        // The session is told of the edits too, and compares them with the text the message arrived with. It is told
        // even when a later edit restored that text: the message was edited all the same, and the edits delivered
        // before it, past the bound, left no mark.
        if (mine.edited) handedOver.originalBody = mine.arrived;
        handedOver.body = mine.text;
        return true;
      },
      end: () => {
        mine.deliveries--;
        // Another delivery of the id still processed is handed over as a later change leaves the message.
        mine.delivered = true;
        if (!mine.deliveries && inProcessing.get(message.id) === mine) inProcessing.delete(message.id);
        deliverKept(mine);
      },
    };
  };

  /**
   * Deliver a change aimed at `messageId`: right after the message while it is still being processed, else at
   * once. An edit that repeats the text the message carries so far changes nothing, and goes through at once as
   * it always did. Past the bound the changes kept so far go first, so none overtakes another.
   */
  const afterMessage = (messageId: string, deliver: () => void, change: Change = {}): void => {
    const kept = inProcessing.get(messageId);
    if (!kept || change.editedText === kept.text) {
      deliver();
      return;
    }
    if (change.editedText !== undefined) {
      kept.text = change.editedText;
      kept.edited = true;
    }
    if (change.deletes) kept.deleted = true;
    if (!kept.delivered && kept.changes.length < MAX_CHANGES_KEPT_PER_MESSAGE) {
      kept.changes.push(deliver);
      return;
    }
    deliverKept(kept);
    deliver();
  };

  // A message WhatsApp Web could not decrypt on arrival ("Waiting for this message") is decrypted in place later, and
  // whatsapp-web.js delivers it from the update that fills in its text, which raises message_edit as well: no edit.
  // Kept by id until that change is seen: unset until the message is delivered, then a fingerprint of the text it was
  // delivered with, so the entries kept hold no message text whatever its length.
  const decryptedLater = new Map<string, string | undefined>();
  const fingerprint = (text: string): string => createHash('sha256').update(text).digest('base64');

  /** Whether a message_edit is the decryption of its message (see decryptedLater). Asked once per message. */
  const isDecryption = (edit: EditedMessage): boolean => {
    if (!decryptedLater.has(edit.messageId)) return false;
    const delivered = decryptedLater.get(edit.messageId);
    decryptedLater.delete(edit.messageId);
    return delivered === undefined || delivered === fingerprint(edit.body);
  };

  const deliveredDecrypted = (message: IncomingMessage): void => {
    if (decryptedLater.has(message.id)) decryptedLater.set(message.id, fingerprint(message.body));
  };

  client.on('message_ciphertext', msg => {
    const id = readWid(msg.id);
    // whatsapp-web.js delivers none of these once decrypted, so what changes them is left as it is.
    const subtype = (msg.rawData as { subtype?: string } | undefined)?.subtype;
    if (!id || subtype?.endsWith('_unavailable_fanout')) return;
    decryptedLater.set(id, undefined);
    if (decryptedLater.size > MAX_MESSAGES_IN_PROCESSING) decryptedLater.delete(decryptedLater.keys().next().value!);
  });

  client.on('message', msg => {
    let base: IncomingMessage;
    try {
      base = buildIncomingMessageBase(msg);
    } catch (error) {
      host.logger.error('Error processing incoming message', String(error));
      return;
    }
    deliveredDecrypted(base);
    const ticket = admit(msg, base, true);
    const processing = keepChanges(base, ticket);
    const done = handleIncoming(host, msg, base, ticket, processing);
    holdWhileProcessing(ticket, done);
    void done.then(processing.end, processing.end);
  });

  client.on('message_create', msg => {
    // `message_create` fires for every message the account creates — including ones composed on a
    // linked phone, which the `message` event above never delivers. Incoming messages are already
    // handled there, so forward only the account's own outgoing (`fromMe`) messages; this is the
    // single source for `message.sent` (covers API sends and phone-composed self-messages alike).
    if (!msg.fromMe) {
      return;
    }

    let ticket: InboundTicket | undefined;
    let processing = NOT_KEPT;
    const done = (async () => {
      let incomingMessage: IncomingMessage;
      try {
        incomingMessage = buildIncomingMessageBase(msg);
      } catch (error) {
        // Logged like the incoming handler does: holdWhileProcessing consumes a rejection, so one left to
        // escape from here would vanish without a log line.
        host.logger.error('Error processing outgoing message', String(error));
        return;
      }
      deliveredDecrypted(incomingMessage);
      // Synchronous, as the first await comes after it.
      ticket = admit(msg, incomingMessage, !incomingMessage.isStatusBroadcast);
      processing = keepChanges(incomingMessage, ticket);
      // Enrich with the media payload through the same capped path the incoming handler uses —
      // the base builder is sync and carries none, so a phone-sent image would otherwise persist
      // and render as a bare 📎 marker even though the media is downloadable right here. Not for an own
      // status post: the echo consumer drops those, so the download would only hold a limiter slot.
      if (msg.hasMedia && !incomingMessage.isStatusBroadcast) {
        try {
          incomingMessage.media = await host.capInboundMediaFor(msg, undefined, ticket);
        } catch (error) {
          host.logger.warn('Own-send media download failed; emitting echo without media', {
            msgId: msg.id?._serialized,
            error: String(error),
          });
        }
      }
      try {
        if (!processing.handOver(incomingMessage)) {
          host.logger.debug('Not handing over an own message deleted for everyone while it was processed', {
            msgId: incomingMessage.id,
          });
          return;
        }
        // The ticket goes along only where one was issued, so elsewhere the call is unchanged.
        if (ticket) host.getCallbacks().onMessageCreate?.(incomingMessage, ticket);
        else host.getCallbacks().onMessageCreate?.(incomingMessage);
      } catch (error) {
        host.logger.error('Error processing outgoing message', String(error));
      }
    })();
    holdWhileProcessing(ticket, done);
    void done.then(
      () => processing.end(),
      () => processing.end(),
    );
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
    const ackId = readWid(rawId);
    if (!ackId) {
      host.logger.warn('Dropping an ack whose message id could not be read', { ack });
      return;
    }
    // An ack is a receipt of a message the account sent. Only an explicit false is dropped: a build that
    // renamed the field (#747) can leave it unreadable, and dropping there strands real acks at SENT.
    if (msg.fromMe === false) return;
    // Map the whatsapp-web.js MessageAck integer to the neutral DeliveryStatus here, at the
    // adapter boundary, so no downstream consumer ever sees engine-specific ack codes. The chat is
    // derived as Message._getChatId derives it (the same direction flag the revoked handler uses),
    // so the ack's chatId matches the chatId of the message it belongs to.
    const ackChatId = msg.fromMe ? msg.to : msg.from;
    host.getCallbacks().onMessageAck?.(ackId, wwebjsAckToDeliveryStatus(ack), ackChatId || undefined);
  });

  client.on('message_revoke_everyone', (after, before) => {
    try {
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
        id: readWid(afterId) ?? '',
        revokedId: readWid(beforeId),
        // Direction flag, as Message._getChatId: an own message in a LID chat carries the own LID as
        // `from`, which never equals the phone-dialect account wid.
        chatId: after.fromMe ? after.to : after.from,
        from: after.from,
        to: after.to,
        type: 'revoked',
        body: '',
        timestamp: after.timestamp,
      };
      afterMessage(payload.revokedId ?? payload.id, () => host.getCallbacks().onMessageRevoked?.(payload), {
        deletes: true,
      });
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
        messageId: readWid(msgId) ?? '',
        chatId: reaction.id.remote,
        reaction: reaction.reaction,
        senderId: reaction.senderId,
      };
      afterMessage(event.messageId, () => host.getCallbacks().onMessageReaction?.(event));
    } catch (error) {
      host.logger.error('Error processing message_reaction', String(error));
    }
  });

  client.on('vote_update', vote => {
    try {
      // `PollVote` assigns its keys straight through, like `Reaction`: `voter` is the raw sender Wid
      // (typed as a string upstream) and `parentMsgKey` (untyped upstream) the raw MsgKey of the poll,
      // so both are read with `readWid` (#747). `parentMessage` is built from the poll creation message
      // when WhatsApp Web holds it, and from nothing otherwise, so its fields may all be undefined; the
      // poll id and chat then come from `parentMsgKey`.
      const raw = vote as typeof vote & {
        voter: SerializedWid | string;
        parentMsgKey?: SerializedWid & { remote?: SerializedWid | string };
      };
      const poll = vote.parentMessage as Partial<Message> | undefined;
      const pollId = poll?.id as unknown as SerializedWid | undefined;
      // Without the creation message whatsapp-web.js keeps only the local option ids, which no route
      // of this API takes, so an option it could not name is left out. A selection with no nameable
      // option is no report of what was chosen, and `[]` means a cleared vote, so it is skipped.
      const selectedOptions = (vote.selectedOptions ?? [])
        .map(option => option.name)
        .filter((name): name is string => typeof name === 'string');
      if ((vote.selectedOptions?.length ?? 0) > 0 && selectedOptions.length === 0) {
        host.logger.debug('Ignoring a poll vote whose options WhatsApp Web cannot name', {
          pollMessageId: readWid(pollId) ?? readWid(raw.parentMsgKey),
        });
        return;
      }
      // Sender clock, in milliseconds. Without it a re-delivered vote gets a fresh stamp and so a fresh key.
      const interactedAtMs = Math.floor(Number(vote.interractedAtTs) || Date.now());
      const event: PollVoteEvent = {
        pollMessageId: readWid(pollId) ?? readWid(raw.parentMsgKey) ?? '',
        // Direction flag, as Message._getChatId (see message_revoke_everyone).
        chatId: (poll?.from ? (poll.fromMe ? poll.to : poll.from) : readWid(raw.parentMsgKey?.remote)) ?? '',
        voterId: readWid(raw.voter) ?? '',
        selectedOptions,
        ...(poll?.pollName ? { pollName: poll.pollName } : {}),
        timestamp: Math.floor(interactedAtMs / 1000),
        timestampMs: interactedAtMs,
      };
      host.getCallbacks().onPollVote?.(event);
    } catch (error) {
      host.logger.error('Error processing vote_update', String(error));
    }
  });

  client.on('message_edit', (message, newBody) => {
    try {
      // Raised for any change of a message's body or caption attribute, with `message` read after it. Users edit
      // only texts and captions, and `message.body` is the text shown: for a message with a file its caption, as
      // the body attribute holds a thumbnail WhatsApp Web may replace. Any other change is no edit.
      if ((message.type !== MessageTypes.TEXT && !message.hasMedia) || String(newBody ?? '') !== message.body) {
        host.logger.debug('Ignoring a message_edit that is no edit of a text or caption', {
          msgId: message.id?._serialized,
          type: message.type,
        });
        return;
      }
      // whatsapp-web.js keeps `message.timestamp` at the ORIGINAL creation time. Consumers need
      // occurrence time for ordering multiple edits, so stamp the edit at receipt and project the
      // otherwise-normal message fields through the same adapter mapper used by inbound messages.
      const editTimestamp = Math.floor(Date.now() / 1000);
      const base = buildIncomingMessageBase({
        id: message.id,
        from: message.from,
        to: message.to,
        body: message.body,
        type: message.type,
        timestamp: editTimestamp,
        fromMe: message.fromMe,
        author: message.author,
        mentionedIds: message.mentionedIds,
      });
      const payload: EditedMessage = buildEditedMessage(base, Boolean(message.hasMedia));
      if (isDecryption(payload)) {
        host.logger.debug('Ignoring the message_edit of a message decrypted in place', { msgId: payload.messageId });
        return;
      }
      afterMessage(payload.messageId, () => host.getCallbacks().onMessageEdited?.(payload), {
        editedText: payload.body,
      });
    } catch (error) {
      host.logger.error('Error processing message_edit', String(error));
    }
  });
}

/**
 * The `message` event body: enrich the incoming message (contact, location, media, quote, call) and
 * emit it with its ticket, carrying the latest edit that reached it, or not at all once a delete for everyone did.
 * Never rejects.
 */
async function handleIncoming(
  host: WwebjsEngineHost,
  msg: Message,
  incomingMessage: IncomingMessage,
  ticket: InboundTicket | undefined,
  processing: Processing,
): Promise<void> {
  // A held message (a ticket) keeps every later message of its chat waiting until it is emitted, so its
  // page lookups get the download deadline instead of Puppeteer's protocol timeout, and go without.
  const lookup = <T>(what: string, call: Promise<T>): Promise<T | null> =>
    ticket
      ? withInboundDownloadTimeout(call, inboundMediaTimeoutMs(), () =>
          host.logger.warn(`Getting the ${what} passed MEDIA_DOWNLOAD_TIMEOUT_MS; emitting without it`, {
            msgId: incomingMessage.id,
          }),
        )
      : call;
  try {
    // Attach the sender's contact info. getContact() gives the real sender (author in groups, from
    // in 1:1); we read only its synchronous fields and never the async getters (profile pic, about),
    // which would hit WhatsApp on every message.
    try {
      const contact = await lookup('message contact', msg.getContact());
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
        const capped = await host.capInboundMediaFor(msg, undefined, ticket);
        if (capped) incomingMessage.media = capped;
      } catch (error) {
        host.logger.error('Error downloading media', String(error));
      }
    }

    // Handle quoted message
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await lookup('quoted message', msg.getQuotedMessage());
        if (quoted) {
          incomingMessage.quotedMessage = {
            id: quoted.id._serialized,
            body: quoted.body,
          };
        }
      } catch (error) {
        host.logger.error('Error getting quoted message', String(error));
      }
    }

    // Surface call-log detail on the live path too (getChatHistory already does this), so a missed/
    // video incoming call renders a labeled bubble instead of a generic "Call".
    const call = extractWwebjsCall(msg);
    if (call) incomingMessage.call = call;

    if (!processing.handOver(incomingMessage)) {
      host.logger.debug('Not handing over a message deleted for everyone while it was processed', {
        msgId: incomingMessage.id,
      });
      return;
    }
    if (ticket) host.getCallbacks().onMessage?.(incomingMessage, ticket);
    else host.getCallbacks().onMessage?.(incomingMessage);
  } catch (error) {
    host.logger.error('Error processing incoming message', String(error));
  }
}

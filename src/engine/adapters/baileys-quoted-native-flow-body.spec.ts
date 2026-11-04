import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { extractBaileysContext } from './baileys-message-mapper';
import { BaileysSessionStore } from './baileys-session-store';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/**
 * A quote carries the body the quoted message is announced with. A native-flow reply can carry the label the user
 * tapped only in its params, and is announced with that label as its body, so a message quoting it carries the
 * label as the quote's body too.
 */

const getContentType = (content: object | undefined): string | undefined =>
  Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message'));
const lib = {
  normalizeMessageContent: (content: unknown) => content,
  extractMessageContent: (content: unknown) => content,
  getContentType,
  proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
} as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

const PEER = '628111@s.whatsapp.net';
const SELF = '628222@s.whatsapp.net';

const nativeFlowReply = (paramsJson: string): NonNullable<WAMessage['message']> => ({
  interactiveResponseMessage: { nativeFlowResponseMessage: { name: 'quick_reply', paramsJson } },
});
const tap = nativeFlowReply('{"id":"opt-yes","display_text":"Yes, book it"}');

function build(): BaileysEvents {
  const store = new BaileysSessionStore(undefined, 's1');
  const noop = (): undefined => undefined;
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger: createLogger('baileys-quoted-native-flow-body.spec'),
    loadLib: () => Promise.resolve(lib),
    getFetchDispatcher: noop,
    toNeutralJid: (jid: string) => store.toNeutralJid(jid),
    normalizedSelfJid: () => SELF,
    inboundLimiter: new ConcurrencyLimiter(2),
    recordKeyLidMappings: noop,
    recordMessage: noop,
    recordMessageEdit: noop,
    consumeOwnSend: () => false,
    getStoredMessage: noop,
    putStoredMessage: noop,
    updateStoredMessage: noop,
    removeStoredMessage: noop,
    getOnMessage: noop,
    getOnMessageCreate: noop,
    getOnMessageRevoked: noop,
    getOnMessageEdited: noop,
    getOnMessageReaction: noop,
    getOnMessageAck: noop,
    getOnMessageReceipt: noop,
    getOnGroupEvent: noop,
    getOnEventResponse: noop,
    findContact: () => null,
    getOnCall: noop,
    getOnPresenceUpdate: noop,
    getOnCallOutcome: noop,
  };
  return new BaileysEvents(host);
}

const message = (id: string, content: NonNullable<WAMessage['message']>, fromMe = false): WAMessage => ({
  key: { id, remoteJid: PEER, fromMe },
  message: content,
  messageTimestamp: 100,
});

describe('Baileys quote of a native-flow reply', () => {
  it('carries the tapped label the quoted reply is announced with', async () => {
    const events = build();
    const announced = await events.mapMessage(message('TAP1', tap), getContentType(tap));
    expect(announced.body).toBe('Yes, book it');

    const quoting: NonNullable<WAMessage['message']> = {
      extendedTextMessage: { text: 'Booked for you', contextInfo: { stanzaId: 'TAP1', quotedMessage: tap } },
    };
    const reply = await events.mapMessage(message('R1', quoting, true), getContentType(quoting));

    expect(reply.quotedMessage).toEqual({ id: 'TAP1', body: announced.body });
  });

  const quoted = (quotedMessage: object) =>
    extractBaileysContext({ extendedTextMessage: { contextInfo: { stanzaId: 'TAP1', quotedMessage } } }).quotedMessage;

  it('reads the label off the params of a quoted native-flow reply, as the history path does', () => {
    expect(quoted(tap)).toEqual({ id: 'TAP1', body: 'Yes, book it' });
  });

  it('answers an empty quote body for a native-flow reply whose params carry no id', () => {
    expect(quoted(nativeFlowReply('{"display_text":"Yes, book it"}'))).toEqual({ id: 'TAP1', body: '' });
  });

  it('reads the text inside the envelope of a quoted view-once or disappearing message, as the preview does', () => {
    expect(quoted({ viewOnceMessageV2: { message: { imageMessage: { caption: 'look' } } } })?.body).toBe('look');
    expect(quoted({ ephemeralMessage: { message: { conversation: 'gone soon' } } })?.body).toBe('gone soon');
  });
});

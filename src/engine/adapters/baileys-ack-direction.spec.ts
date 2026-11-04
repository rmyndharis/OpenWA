import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/**
 * `message.ack` reports a delivery or read receipt of a message the account sent (docs/06). Baileys
 * also raises `messages.update` with status READ when another device of the account reads a message
 * it RECEIVED (a `read-self` receipt: Socket/messages-recv.js handleReceipt keys it `fromMe: false` on
 * the contact's chat). That is the account reading its inbox, not a receipt from the recipient, and
 * must not reach the ack callback as one.
 */
function build(onAck: jest.Mock, onEventResponse: jest.Mock = jest.fn()): BaileysEvents {
  const noop = (): undefined => undefined;
  return new BaileysEvents({
    getSocket: noop,
    getSocketOrNull: () => null,
    logger: createLogger('baileys-ack-direction.spec'),
    loadLib: noop,
    getFetchDispatcher: noop,
    toNeutralJid: (jid: string) => jid.replace('@s.whatsapp.net', '@c.us'),
    normalizedSelfJid: () => '628222@s.whatsapp.net',
    inboundLimiter: new ConcurrencyLimiter(1),
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
    getOnMessageAck: () => onAck,
    getOnMessageReceipt: noop,
    getOnGroupEvent: noop,
    getOnEventResponse: () => onEventResponse,
    findContact: () => null,
    getOnCall: noop,
    getOnPresenceUpdate: noop,
    getOnCallOutcome: noop,
  } as unknown as BaileysEventsHost);
}

describe('Baileys message acks by direction', () => {
  it('reports the read receipt of a message the account sent', () => {
    const onAck = jest.fn();
    build(onAck).handleMessagesUpdate([
      { key: { remoteJid: '628111@s.whatsapp.net', id: 'OUT1', fromMe: true }, update: { status: 4 } },
    ]);
    expect(onAck).toHaveBeenCalledWith('OUT1', 'read', '628111@c.us');
  });

  it('does not report the account reading a message it received as an ack of that message', () => {
    const onAck = jest.fn();
    // The shape rc14 emits for a read-self receipt: the contact's chat, fromMe false, status READ.
    build(onAck).handleMessagesUpdate([
      {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'IN1', fromMe: false, participant: undefined } as never,
        update: { status: 4, messageTimestamp: 1_700_000_000 } as never,
      },
    ]);
    expect(onAck).not.toHaveBeenCalled();
  });

  it('reports a failed send and an update whose key carries no direction', () => {
    const onAck = jest.fn();
    build(onAck).handleMessagesUpdate([
      { key: { remoteJid: '120363000000000001@g.us', id: 'OUT2', fromMe: true }, update: { status: 0 } },
      { key: { remoteJid: '628111@s.whatsapp.net', id: 'OUT3' }, update: { status: 3 } },
    ]);
    expect(onAck).toHaveBeenNthCalledWith(1, 'OUT2', 'failed', '120363000000000001@g.us');
    expect(onAck).toHaveBeenNthCalledWith(2, 'OUT3', 'delivered', '628111@c.us');
  });

  it('still reports an event response carried on a key the account did not send', async () => {
    const onAck = jest.fn();
    const onEventResponse = jest.fn();
    build(onAck, onEventResponse).handleMessagesUpdate([
      {
        key: { remoteJid: '628111@s.whatsapp.net', id: 'EVENT1', fromMe: false },
        update: {
          status: 4,
          eventResponses: [
            {
              eventResponseMessageKey: { id: 'RSVP1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
              response: { response: 1 },
            },
          ],
        },
      },
    ]);
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    expect(onAck).not.toHaveBeenCalled();
    expect(onEventResponse).toHaveBeenCalledWith(
      expect.objectContaining({ eventMessageId: 'EVENT1', responseMessageId: 'RSVP1', response: 'going' }),
    );
  });
});

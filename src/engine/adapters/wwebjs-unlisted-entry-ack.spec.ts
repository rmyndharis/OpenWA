import { EventEmitter } from 'events';
import type { Client } from 'whatsapp-web.js';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { registerWwebjsMessageEvents } from './wwebjs-message-events';

/**
 * An entry of a kind whatsapp-web.js does not list that carries neither text nor media is never handed to the
 * session as a sent message, so a delivery receipt for it would name a message nobody was told about. The ack of a
 * system notice stops at the adapter for that reason, and so must the ack of such an entry. An ack whose entry names
 * no type at all is still forwarded: the handler reads what a renamed field leaves unreadable as "forward" (#747).
 */
function wire(): { client: EventEmitter; onMessageCreate: jest.Mock; onMessageAck: jest.Mock } {
  const client = new EventEmitter();
  const onMessageCreate = jest.fn();
  const onMessageAck = jest.fn();
  const host = {
    logger: createLogger('wwebjs-unlisted-entry-ack.spec'),
    getCallbacks: () => ({ onMessageCreate, onMessageAck }),
    capInboundMediaFor: jest.fn(),
  } as unknown as WwebjsEngineHost;
  registerWwebjsMessageEvents(client as unknown as Client, host);
  return { client, onMessageCreate, onMessageAck };
}

const entry = (type: string | undefined, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: { _serialized: `true_621@c.us_${String(type).toUpperCase()}1` },
  from: 'me@c.us',
  to: '621@c.us',
  body: '',
  type,
  timestamp: 1_700_000_000,
  fromMe: true,
  hasMedia: false,
  hasQuotedMsg: false,
  _data: {},
  ...over,
});

describe('the ack of an own entry the adapter does not hand over', () => {
  it('stops at the adapter for an unlisted contentless entry, as its creation does', () => {
    const { client, onMessageCreate, onMessageAck } = wire();
    const pinned = entry('pin_in_chat');

    client.emit('message_create', pinned);
    client.emit('message_ack', pinned, 2);

    // Both handlers answer before their first await, so nothing is pending here.
    expect(onMessageCreate).not.toHaveBeenCalled();
    expect(onMessageAck).not.toHaveBeenCalled();
  });

  it.each([
    ['an unlisted entry that carries text', entry('future_kind', { body: 'hello' })],
    ['an unlisted entry that carries media', entry('future_kind', { hasMedia: true })],
    ['a listed contentless kind', entry('hsm')],
    ['another listed contentless kind', entry('interactive')],
    ['a listed kind the gateway does not map', entry('unknown')],
    ['an entry that names no type', entry(undefined)],
    ['an entry whose type is empty', entry('')],
  ])('is still forwarded for %s', (_label, message) => {
    const { client, onMessageAck } = wire();

    client.emit('message_ack', message, 2);

    expect(onMessageAck).toHaveBeenCalledTimes(1);
  });
});

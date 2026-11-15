import { EventEmitter } from 'events';
import type { Client } from 'whatsapp-web.js';
import { registerWwebjsMessageEvents } from './wwebjs-message-events';
import { type WwebjsEngineHost } from './wwebjs-host';
import type { InboundTicket } from '../interfaces/whatsapp-engine.interface';

/**
 * whatsapp-web.js raises `message` and `message_create` for every new model WhatsApp Web adds to a chat except group
 * notices and undecrypted placeholders, so when WhatsApp Web adds one of the bubbles it draws by itself (a changed
 * security code, the encryption notice, a business or broadcast notice) as a new message, it arrives like a message.
 * It carries nothing a person sent, so the session must neither store it nor announce it, nor its acks.
 */

const CHAT = '628111@c.us';
const SELF = '628123@c.us';

const NOTICES = [
  'e2e_notification',
  'notification_template',
  'notification',
  'broadcast_notification',
  'group_notification',
  'protocol',
  'debug',
  'gp2',
  // Not a notice, but left out for the same reason: the header of an album, whose media arrive on their own.
  'album',
];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
};

/** A model as whatsapp-web.js wraps it: nothing attached, nothing quoted. */
const model = (
  type: string,
  opts: { fromMe?: boolean; body?: string; hasMedia?: boolean; data?: Record<string, unknown> } = {},
) => ({
  id: { _serialized: `${Boolean(opts.fromMe)}_${CHAT}_${type.toUpperCase()}1` },
  from: opts.fromMe ? SELF : CHAT,
  to: opts.fromMe ? CHAT : SELF,
  body: opts.body ?? '',
  type,
  timestamp: 1_700_000_000,
  fromMe: Boolean(opts.fromMe),
  hasMedia: Boolean(opts.hasMedia),
  hasQuotedMsg: false,
  _data: opts.data ?? {},
  getContact: jest.fn(() => Promise.resolve(null)),
});

/** The adapter's event wiring as PostgreSQL builds it: every arrival is admitted and holds a ticket. */
function wired() {
  const client = new EventEmitter();
  const ticket: InboundTicket = { reserve: () => true, holdUntil: jest.fn(), drop: jest.fn(), revoked: false };
  const callbacks = {
    admitInbound: jest.fn(() => ticket),
    onMessage: jest.fn(),
    onMessageCreate: jest.fn(),
    onMessageAck: jest.fn(),
  };
  const logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const host = {
    logger,
    getCallbacks: () => callbacks,
    capInboundMediaFor: jest.fn(),
  } as unknown as WwebjsEngineHost;
  registerWwebjsMessageEvents(client as unknown as Client, host);
  return { client, ticket, logger, ...callbacks };
}

describe('a whatsapp-web.js system notice', () => {
  it.each(NOTICES)('of type %s is not handed to the session as a received message', async type => {
    const { client, logger, admitInbound, onMessage, onMessageCreate } = wired();
    const notice = model(type);

    // The library raises both events for a message that is not the account's own.
    client.emit('message_create', notice);
    client.emit('message', notice);
    await settle();

    expect(onMessage).not.toHaveBeenCalled();
    expect(onMessageCreate).not.toHaveBeenCalled();
    // Nothing is admitted, so no turn in the chat's order and no room is held for it, and no page lookup is made.
    expect(admitInbound).not.toHaveBeenCalled();
    expect(notice.getContact).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'wwebjs_drop_notice', type }),
    );
  });

  it.each(NOTICES)('of the account itself, type %s, is not handed to the session as a sent message', async type => {
    const { client, admitInbound, onMessage, onMessageCreate } = wired();

    client.emit('message_create', model(type, { fromMe: true }));
    await settle();

    expect(onMessageCreate).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(admitInbound).not.toHaveBeenCalled();
  });

  // The account's own notice was never announced as a sent message, so an ack of it would point at nothing.
  it.each(NOTICES)('of the account itself, type %s, has no ack announced', type => {
    const { client, onMessageAck } = wired();

    client.emit('message_ack', model(type, { fromMe: true }), 2);

    expect(onMessageAck).not.toHaveBeenCalled();
  });

  describe('on the wiring that drops system notices', () => {
    it('still delivers an ordinary received message with its ticket and its contact lookup', async () => {
      const { client, ticket, admitInbound, onMessage } = wired();
      const message = model('chat', { body: 'hello' });

      client.emit('message_create', message);
      client.emit('message', message);
      await settle();

      expect(admitInbound).toHaveBeenCalledTimes(1);
      expect(message.getContact).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', body: 'hello' }), ticket);
    });

    it('still delivers an ordinary sent message with its ticket', async () => {
      const { client, ticket, admitInbound, onMessageCreate } = wired();

      client.emit('message_create', model('chat', { fromMe: true, body: 'hello' }));
      await settle();

      expect(admitInbound).toHaveBeenCalledTimes(1);
      expect(onMessageCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', body: 'hello' }), ticket);
    });

    it('still announces the ack of an ordinary message the account sent', () => {
      const { client, onMessageAck } = wired();
      const sent = model('chat', { fromMe: true, body: 'hello' });

      client.emit('message_ack', sent, 2);

      expect(onMessageAck).toHaveBeenCalledTimes(1);
      expect(onMessageAck).toHaveBeenCalledWith(sent.id._serialized, 'delivered', CHAT);
    });

    // A call log is listed by the chat history, and a prompt can arrive with no text: neither is a notice.
    it.each([
      [
        'a call log as a call',
        'call_log',
        { data: { isVideoCall: true } },
        { type: 'call', call: { video: true, missed: true } },
      ],
      ['a template prompt with no text as unknown', 'hsm', {}, { type: 'unknown', body: '' }],
      ['an interactive prompt with no text as unknown', 'interactive', {}, { type: 'unknown', body: '' }],
      ['a native flow prompt with no text as unknown', 'native_flow', {}, { type: 'unknown', body: '' }],
      ['a list message with no text as unknown', 'list', {}, { type: 'unknown', body: '' }],
      ['a payment message with no text as unknown', 'payment', {}, { type: 'unknown', body: '' }],
      ['a group v4 invite with no text as unknown', 'groups_v4_invite', {}, { type: 'unknown', body: '' }],
      ['an oversized placeholder with no text as unknown', 'oversized', {}, { type: 'unknown', body: '' }],
      ['a listed unknown entry with no text as unknown', 'unknown', {}, { type: 'unknown', body: '' }],
      ['a message deleted before it arrived as revoked', 'revoked', {}, { type: 'revoked', body: '' }],
    ])('still delivers %s', async (_what, type, opts, delivered) => {
      const { client, onMessage } = wired();

      client.emit('message', model(type, opts));
      await settle();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining(delivered), expect.anything());
    });
  });

  describe('a contentless entry of a type whatsapp-web.js does not list', () => {
    it('drops a received unlisted contentless entry with a debug log carrying its raw type', async () => {
      const { client, logger, admitInbound, onMessage, onMessageCreate } = wired();
      const entry = model('member_added_notice');

      client.emit('message_create', entry);
      client.emit('message', entry);
      await settle();

      expect(onMessage).not.toHaveBeenCalled();
      expect(onMessageCreate).not.toHaveBeenCalled();
      expect(admitInbound).not.toHaveBeenCalled();
      expect(entry.getContact).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ action: 'wwebjs_drop_contentless', type: 'member_added_notice' }),
      );
    });

    it('drops an own unlisted contentless entry on message_create with a debug log carrying its raw type', async () => {
      const { client, logger, admitInbound, onMessage, onMessageCreate } = wired();

      client.emit('message_create', model('member_added_notice', { fromMe: true }));
      await settle();

      expect(onMessageCreate).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
      expect(admitInbound).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ action: 'wwebjs_drop_contentless', type: 'member_added_notice' }),
      );
    });

    it('delivers a contentless entry of a listed kind the gateway does not map, and logs its raw type', async () => {
      const { client, logger, onMessage, onMessageCreate } = wired();

      client.emit('message', model('interactive'));
      client.emit('message_create', model('unknown', { fromMe: true }));
      await settle();

      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'unknown', body: '' }), expect.anything());
      expect(onMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unknown', body: '' }),
        expect.anything(),
      );
      expect(
        logger.debug.mock.calls.map(([, meta]: [string, { action: string; type: string }]) => [meta.action, meta.type]),
      ).toEqual([
        ['wwebjs_keep_unmapped', 'interactive'],
        ['wwebjs_keep_unmapped', 'unknown'],
      ]);
    });

    it('logs nothing for a kept entry that carries something, or whose kind the gateway maps', async () => {
      const { client, logger, onMessage } = wired();

      client.emit('message', model('interactive', { body: 'Pick one' }));
      client.emit('message', model('unknown', { hasMedia: true }));
      client.emit('message', model('chat'));
      client.emit('message', model('revoked'));
      await settle();

      expect(onMessage).toHaveBeenCalledTimes(4);
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('still delivers an unlisted entry when it carries a body', async () => {
      const { client, onMessage, onMessageCreate } = wired();

      client.emit('message', model('future_kind', { body: 'hello' }));
      client.emit('message_create', model('future_kind', { fromMe: true, body: 'own hello' }));
      await settle();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unknown', body: 'hello' }),
        expect.anything(),
      );
      expect(onMessageCreate).toHaveBeenCalledTimes(1);
      expect(onMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unknown', body: 'own hello' }),
        expect.anything(),
      );
    });

    it('still delivers an unlisted entry when hasMedia is true', async () => {
      const { client, onMessage, onMessageCreate } = wired();

      client.emit('message', model('future_media_kind', { hasMedia: true }));
      client.emit('message_create', model('future_media_kind', { fromMe: true, hasMedia: true }));
      await settle();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'unknown', body: '' }), expect.anything());
      expect(onMessageCreate).toHaveBeenCalledTimes(1);
      expect(onMessageCreate).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unknown', body: '' }),
        expect.anything(),
      );
    });
  });
});

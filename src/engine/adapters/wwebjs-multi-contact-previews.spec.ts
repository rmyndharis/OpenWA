import { EventEmitter } from 'events';
import { WAState, type Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { WwebjsChats } from './wwebjs-chats';
import { type WwebjsEngineHost } from './wwebjs-host';
import { type WwebjsLifecycle } from './wwebjs-lifecycle';
import { type WwebjsMessaging } from './wwebjs-messaging';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';

/**
 * Several contacts shared in one message reach whatsapp-web.js as a `multi_vcard` message with no body and
 * the cards in `vCards`. The cards are the body everywhere the gateway shows or sends the message: the chat
 * list preview and the quote of such a message, live and in the chat history, carry them as well.
 */
const card = (name: string): string => `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;waid=62811:+62 811\nEND:VCARD`;
const shared = (id: string): Record<string, unknown> => ({
  id: { _serialized: id },
  type: 'multi_vcard',
  body: '',
  vCards: [card('Ana'), card('Budi')],
});
const joined = [card('Ana'), card('Budi')].join('\n');

/** Wait in real time for a condition the handler reaches on its own, up to a deadline. */
const until = async (condition: () => boolean, label: string): Promise<void> => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited >= 5_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

describe('a share of several contacts in the chat list and in a quote', () => {
  it('lists the cards as the last message of the chat', async () => {
    const chat = {
      id: { _serialized: '628111@c.us' },
      formattedTitle: 'Alice',
      isGroup: false,
      unreadCount: 0,
      t: 1_700_000_000,
      // The page model, which the library turns into a Message: it keeps the cards of a share in `vcardList`.
      lastMessage: {
        id: { _serialized: 'm1' },
        type: 'multi_vcard',
        body: '',
        vcardList: [{ vcard: card('Ana') }, { vcard: card('Budi') }],
      },
    };
    const client = {
      info: { wid: { _serialized: '628000@c.us' } },
      pupPage: { evaluate: jest.fn().mockResolvedValue([chat]) },
      getChats: jest.fn(),
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger: createLogger('wwebjs-multi-contact-previews.spec'),
    } as unknown as WwebjsEngineHost;

    const [summary] = await new WwebjsChats(host, {} as WwebjsMessaging).getChats();

    expect(summary).toMatchObject({ lastMessage: joined, lastMessageType: 'contact' });
  });

  it('carries the cards in the quote of such a message found in the chat history', async () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const reply = {
      id: { _serialized: 'M2' },
      from: '621@c.us',
      to: 'me',
      body: 'thanks',
      type: 'chat',
      timestamp: 200,
      fromMe: false,
      hasMedia: false,
      hasQuotedMsg: true,
      getContact: jest.fn().mockResolvedValue(null),
      getQuotedMessage: jest.fn().mockResolvedValue(shared('Q1')),
    };
    const chat = { fetchMessages: jest.fn().mockResolvedValue([reply]) };
    (adapter as unknown as { client: unknown }).client = { getChatById: jest.fn().mockResolvedValue(chat) };

    const [message] = await adapter.getChatHistory('621@c.us', 50, false);

    expect(message.quotedMessage).toEqual({ id: 'Q1', body: joined });
  });

  it('carries the cards in the quote of such a message on a live message', async () => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    const onMessage = jest.fn();
    (adapter as unknown as { callbacks: unknown }).callbacks = { onMessage };
    (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle.setupEventHandlers();

    client.emit('message', {
      id: { _serialized: 'LIVE_1' },
      from: '628111@c.us',
      to: '628111@c.us',
      body: 'thanks',
      type: 'chat',
      timestamp: 1700000050,
      fromMe: false,
      hasMedia: false,
      getContact: jest.fn().mockResolvedValue(null),
      hasQuotedMsg: true,
      getQuotedMessage: jest.fn().mockResolvedValue(shared('LIVE_Q1')),
    });
    await until(() => onMessage.mock.calls.length > 0, 'the live message to be handed over');

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect((onMessage.mock.calls[0] as [{ quotedMessage?: unknown }])[0].quotedMessage).toEqual({
      id: 'LIVE_Q1',
      body: joined,
    });
  });
});

import type { Client } from 'whatsapp-web.js';
import { WwebjsChats, readChatModels } from './wwebjs-chats';
import { WwebjsGroups } from './wwebjs-groups';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { type WwebjsMessaging } from './wwebjs-messaging';

/**
 * The chat list is read with a direct page walk instead of whatsapp-web.js's `client.getChats()`,
 * whose map over every chat runs as one synchronous stretch that starves the liveness probe on a
 * large account. readChatModels runs inside the WhatsApp Web page, so it is driven here against a
 * stand-in `window`; the delegates are driven with the evaluate mocked to return page models.
 */
describe('readChatModels (in-page chat walk)', () => {
  const g = globalThis as unknown as { window?: unknown };

  afterEach(() => {
    delete g.window;
    jest.restoreAllMocks();
  });

  function withChats(chats: string[], getChatModel: (c: string) => Promise<unknown>): void {
    g.window = {
      require: () => ({ Chat: { getModelsArray: () => chats } }),
      WWebJS: { getChatModel },
    };
  }

  it('returns every model in store order and yields every 256 chats', async () => {
    const chats = Array.from({ length: 600 }, (_, i) => String(i));
    withChats(chats, c => Promise.resolve({ id: c }));
    const timers = jest.spyOn(globalThis, 'setTimeout');

    const models = await readChatModels();

    expect(models).toEqual(chats.map(id => ({ id })));
    // i = 255 and i = 511: the queued getState() probe runs in between.
    expect(timers).toHaveBeenCalledTimes(2);
  });

  it('walks the chat list as it stood at the start, even if the store re-sorts during a yield', async () => {
    const chats = Array.from({ length: 300 }, (_, i) => String(i));
    const original = [...chats];
    const read: string[] = [];
    withChats(chats, c => {
      read.push(c);
      return Promise.resolve({ id: c });
    });
    // A new message moves its chat to the front of WhatsApp Web's live array while the walk yields.
    const realSetTimeout = globalThis.setTimeout;
    jest.spyOn(globalThis, 'setTimeout').mockImplementationOnce((cb: () => void) => {
      chats.unshift('new');
      return realSetTimeout(cb);
    });

    const models = await readChatModels();

    expect(read).toEqual(original);
    expect(models).toEqual(original.map(id => ({ id })));
  });

  it('rejects the whole read when one chat model rejects, as whatsapp-web.js does', async () => {
    const chats = Array.from({ length: 300 }, (_, i) => String(i));
    withChats(chats, c => (c === '10' ? Promise.reject(new Error('unreadable')) : Promise.resolve({ id: c })));

    await expect(readChatModels()).rejects.toThrow('unreadable');
  });
});

describe('the chat and group lists read the page walk', () => {
  const logger = createLogger('wwebjs-chats-read.spec');

  function makeHost(models: unknown[]): { host: WwebjsEngineHost; evaluate: jest.Mock; getChats: jest.Mock } {
    const evaluate = jest.fn().mockResolvedValue(models);
    const getChats = jest.fn();
    const client = { info: { wid: { _serialized: '628000@c.us' } }, pupPage: { evaluate }, getChats };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger,
    } as unknown as WwebjsEngineHost;
    return { host, evaluate, getChats };
  }

  const personal = {
    id: { _serialized: '628111@c.us' },
    formattedTitle: 'Alice',
    isGroup: false,
    unreadCount: 2,
    t: 1_700_000_000,
    archive: true,
    pin: 1,
    isMuted: false,
    lastMessage: { id: { _serialized: 'm1' }, type: 'chat', body: 'hello' },
  };
  const group = {
    id: { _serialized: '120363@g.us' },
    formattedTitle: 'Team',
    isGroup: true,
    unreadCount: 0,
    t: 1_700_000_100,
    groupMetadata: {
      participants: [
        { id: { _serialized: '628000@c.us' }, isAdmin: true },
        { id: { _serialized: '628111@c.us' }, isAdmin: false },
      ],
      parentGroup: { _serialized: '120999@g.us' },
    },
  };

  it('getChats maps the rehydrated models and never calls client.getChats', async () => {
    const { host, evaluate, getChats } = makeHost([personal, group]);

    const summaries = await new WwebjsChats(host, {} as WwebjsMessaging).getChats();

    expect(evaluate).toHaveBeenCalledWith(readChatModels);
    expect(getChats).not.toHaveBeenCalled();
    expect(summaries[0]).toMatchObject({
      id: '628111@c.us',
      name: 'Alice',
      isGroup: false,
      unreadCount: 2,
      timestamp: 1_700_000_000,
      lastMessage: 'hello',
      archived: true,
      pinned: true,
      muted: false,
    });
    expect(summaries[1]).toMatchObject({ id: '120363@g.us', name: 'Team', isGroup: true });
  });

  it('getGroups keeps only groups, with participants, admin flag and linked parent', async () => {
    const { host, evaluate, getChats } = makeHost([personal, group]);

    const groups = await new WwebjsGroups(host).getGroups();

    expect(evaluate).toHaveBeenCalledWith(readChatModels);
    expect(getChats).not.toHaveBeenCalled();
    expect(groups).toEqual([
      { id: '120363@g.us', name: 'Team', participantsCount: 2, isAdmin: true, linkedParentJID: '120999@g.us' },
    ]);
  });
});

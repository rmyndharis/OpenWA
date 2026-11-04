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

  it('rejects the whole read when a non-group chat model rejects, as whatsapp-web.js does', async () => {
    const chats = Array.from({ length: 300 }, (_, i) => String(i));
    withChats(chats, c => (c === '10' ? Promise.reject(new Error('unreadable')) : Promise.resolve({ id: c })));

    await expect(readChatModels()).rejects.toThrow('unreadable');
  });

  /** A page chat as WhatsApp Web holds it: a model whose group metadata is already loaded locally. */
  function pageChat(id: string, groupMetadata?: { participants: { id: string }[]; announce?: boolean }) {
    return {
      id,
      serialize: () => ({
        id: { _serialized: id },
        msgs: [{}],
        msgUnsyncedButtonReplyMsgs: [],
        unsyncedButtonReplies: [],
      }),
      mute: { expiration: 0 },
      formattedTitle: `title ${id}`,
      groupMetadata: groupMetadata && {
        announce: groupMetadata.announce,
        // A fresh copy per call, as WhatsApp Web's serialize() returns.
        serialize: () => ({ participants: groupMetadata.participants.map(p => ({ ...p })) }),
      },
    };
  }

  function withPageChats(chats: ReturnType<typeof pageChat>[], getChatModel: (c: { id: string }) => Promise<unknown>) {
    const toPn = jest.fn((id: string) => (id.endsWith('@lid') ? id.replace('@lid', '@c.us') : null));
    g.window = {
      require: (m: string) => (m === 'WAWebLidMigrationUtils' ? { toPn } : { Chat: { getModelsArray: () => chats } }),
      WWebJS: { getChatModel },
    };
    return toPn;
  }

  // The shape WhatsApp Web's invariant() throws in the page: the name carries "Invariant Violation".
  const invariant = Object.assign(new Error('Minified invariant #76137; %s'), { name: 'Invariant Violation' });
  const invariantText = 'Invariant Violation: Minified invariant #76137; %s';

  it('lists a group whose metadata refresh throws from the metadata the page already holds', async () => {
    const chats = [
      pageChat('1@c.us'),
      pageChat('2@g.us', { participants: [{ id: '91@lid' }, { id: '92@c.us' }], announce: true }),
      pageChat('3@g.us', { participants: [{ id: '93@c.us' }] }),
    ];
    const toPn = withPageChats(chats, c =>
      c.id === '2@g.us' ? Promise.reject(invariant) : Promise.resolve({ id: c.id }),
    );

    const models = await readChatModels();

    expect(models).toEqual([
      { id: '1@c.us' },
      {
        id: { _serialized: '2@g.us' },
        isGroup: true,
        isMuted: false,
        formattedTitle: 'title 2@g.us',
        // Participants go through the same lid -> phone mapping getChatModel applies.
        groupMetadata: { participants: [{ id: '91@c.us' }, { id: '92@c.us' }] },
        isReadOnly: true,
        lastMessage: null,
        metadataRefreshError: invariantText,
      },
      { id: '3@g.us' },
    ]);
    expect(toPn).toHaveBeenCalledTimes(2);
  });

  it('keeps yielding every 256 chats when a group model rejects mid-walk', async () => {
    const chats = Array.from({ length: 600 }, (_, i) => pageChat(`${i}@g.us`, { participants: [] }));
    withPageChats(chats, c => (c.id === '300@g.us' ? Promise.reject(invariant) : Promise.resolve({ id: c.id })));
    const timers = jest.spyOn(globalThis, 'setTimeout');

    const models = (await readChatModels()) as { metadataRefreshError?: string }[];

    expect(models).toHaveLength(600);
    expect(models.filter(m => m.metadataRefreshError)).toHaveLength(1);
    expect(timers).toHaveBeenCalledTimes(2);
  });

  it('still rejects with the original error when the group cannot be read locally either', async () => {
    const broken = pageChat('2@g.us', { participants: [] });
    broken.serialize = () => {
      throw new Error('local read failed');
    };
    withPageChats([pageChat('1@g.us', { participants: [] }), broken], c =>
      c.id === '2@g.us' ? Promise.reject(invariant) : Promise.resolve({ id: c.id }),
    );

    await expect(readChatModels()).rejects.toBe(invariant);
  });

  it('does not serve groups from local metadata for a failure that is not an invariant', async () => {
    // A logout or network loss mid-read must fail the list, not answer every group from stale data.
    const lost = new Error('Socket closed');
    withPageChats([pageChat('1@g.us', { participants: [] }), pageChat('2@g.us', { participants: [] })], c =>
      c.id === '2@g.us' ? Promise.reject(lost) : Promise.resolve({ id: c.id }),
    );

    await expect(readChatModels()).rejects.toBe(lost);
  });

  it('recognises the invariant from its message when the page reports a plain Error', async () => {
    withPageChats([pageChat('2@g.us', { participants: [] })], () =>
      Promise.reject(new Error('Invariant Violation: Minified invariant #76137; %s')),
    );

    const [model] = (await readChatModels()) as { metadataRefreshError?: string }[];

    expect(model.metadataRefreshError).toBe('Error: Invariant Violation: Minified invariant #76137; %s');
  });
});

describe('the chat and group lists read the page walk', () => {
  const logger = createLogger('wwebjs-chats-read.spec');

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    jest.restoreAllMocks();
  });

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
      lastMessageType: 'text',
      archived: true,
      pinned: true,
      muted: false,
    });
    expect(summaries[1]).toMatchObject({ id: '120363@g.us', name: 'Team', isGroup: true });
  });

  it.each([
    ['image', 'image'],
    ['ptt', 'voice'],
    ['audio', 'audio'],
    ['document', 'document'],
    ['new_engine_kind', 'unknown'],
  ])('reports %s without needing preview text', async (rawType, type) => {
    const { host } = makeHost([
      { ...personal, lastMessage: { ...personal.lastMessage, type: rawType, body: '' } },
      group,
    ]);
    const summaries = await new WwebjsChats(host, {} as WwebjsMessaging).getChats();
    expect(summaries[0]).toMatchObject({ lastMessageType: type });
    expect(summaries[0].lastMessage).toBeUndefined();
    expect(summaries[1].lastMessageType).toBeUndefined();
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

  it('getGroups and getChats list a group the page walk served from local metadata', async () => {
    // Drive the real in-page walk, then hand its output to the delegates as page.evaluate would.
    const failing = {
      serialize: () => ({ id: { _serialized: '120364@g.us' }, formattedTitle: 'Coex group', msgs: [] }),
      mute: { expiration: 0 },
      formattedTitle: 'Coex group',
      groupMetadata: {
        announce: false,
        serialize: () => ({
          participants: [
            { id: { _serialized: '628000@c.us' }, isAdmin: true },
            { id: { _serialized: '628222@c.us' }, isAdmin: false },
          ],
        }),
      },
    };
    (globalThis as unknown as { window?: unknown }).window = {
      require: (m: string) =>
        m === 'WAWebLidMigrationUtils' ? { toPn: () => null } : { Chat: { getModelsArray: () => [failing] } },
      WWebJS: {
        getChatModel: () =>
          Promise.reject(Object.assign(new Error('Minified invariant #76137; %s'), { name: 'Invariant Violation' })),
      },
    };
    const models = await readChatModels();
    const { host } = makeHost([personal, group, ...models]);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const groups = await new WwebjsGroups(host).getGroups();
    const summaries = await new WwebjsChats(host, {} as WwebjsMessaging).getChats();

    expect(groups).toEqual([
      { id: '120363@g.us', name: 'Team', participantsCount: 2, isAdmin: true, linkedParentJID: '120999@g.us' },
      { id: '120364@g.us', name: 'Coex group', participantsCount: 2, isAdmin: true, linkedParentJID: null },
    ]);
    expect(summaries[2]).toMatchObject({ id: '120364@g.us', isGroup: true });
    expect(summaries[2].lastMessage).toBeUndefined();
    expect(summaries[2].lastMessageType).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 group(s) from local metadata'),
      expect.objectContaining({
        context: 'getGroups',
        groups: ['120364@g.us'],
        errors: ['Invariant Violation: Minified invariant #76137; %s'],
      }),
    );
  });

  it('bounds the report to ten groups and each distinct error once', async () => {
    const local = Array.from({ length: 12 }, (_, i) => ({
      ...group,
      id: { _serialized: `1209${i}@g.us` },
      metadataRefreshError: i % 2 ? 'Invariant Violation: a' : 'Invariant Violation: b',
    }));
    const { host } = makeHost(local);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(new WwebjsGroups(host).getGroups()).resolves.toHaveLength(12);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0] as [string, { groups: string[]; errors: string[] }];
    expect(message).toContain('12 group(s)');
    expect(meta.groups).toHaveLength(10);
    expect(meta.errors.sort()).toEqual(['Invariant Violation: a', 'Invariant Violation: b']);
  });

  it('logs nothing extra when every model refreshed', async () => {
    const { host } = makeHost([personal, group]);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await new WwebjsGroups(host).getGroups();

    expect(warn).not.toHaveBeenCalled();
  });
});

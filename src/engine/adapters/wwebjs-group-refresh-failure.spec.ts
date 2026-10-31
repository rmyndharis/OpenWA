import type { Client } from 'whatsapp-web.js';
import { WwebjsGroups } from './wwebjs-groups';
import { WwebjsLabels } from './wwebjs-labels';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { LabelNotFoundError } from '../../common/errors/label-not-found.error';

/**
 * whatsapp-web.js resolves one group (getGroupInfo) and a label's chats (getChatsByLabelId) through
 * getChatById, which refreshes a group's metadata first. For a group whose refresh fails one of
 * WhatsApp Web's own invariants (76137, a member's hosted device without the hosted flag), that read
 * rejected on every call: the group answered 404 and so did every label it carries. Both reads now
 * serve that group from the metadata the page already holds, as the group list does. The in-page
 * code runs here against a stand-in `window`, with page.evaluate calling it directly.
 */
const logger = createLogger('wwebjs-group-refresh-failure.spec');

const SELF = '628000@c.us';
const GROUP = '120363@g.us';
const OTHER_GROUP = '120364@g.us';
const PERSONAL = '628111@c.us';

/** What WhatsApp Web's invariant() throws in the page. */
const pageInvariant = () => Object.assign(new Error('Minified invariant #76137; %s'), { name: 'Invariant Violation' });
/** The same rejection after Puppeteer rebuilds it outside the page (cdp/utils.js createEvaluationError). */
const hostInvariant = () => new Error('Invariant Violation: Minified invariant #76137; %s');
const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
const timeoutError = new Error(
  "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.",
);

const wid = (serialized: string) => {
  const [user, server] = serialized.split('@');
  return { _serialized: serialized, user, server };
};

type PageChat = {
  id: ReturnType<typeof wid>;
  serialize: () => Record<string, unknown>;
  mute: { expiration: number };
  formattedTitle: string;
  groupMetadata?: { announce: boolean; serialize: () => Record<string, unknown> };
};

function pageChat(id: string, title: string, metadata?: Record<string, unknown>): PageChat {
  return {
    id: wid(id),
    serialize: () => ({ id: wid(id), t: 1_700_000_000, unreadCount: 1, archive: false, pin: 0, msgs: [{}] }),
    mute: { expiration: 0 },
    formattedTitle: title,
    groupMetadata: metadata && {
      announce: Boolean(metadata.announce),
      // A fresh copy per call, as WhatsApp Web's serialize() returns.
      serialize: () => structuredClone(metadata),
    },
  };
}

const coexGroup = () =>
  pageChat(GROUP, 'Coex group', {
    desc: 'Coordination',
    owner: wid(SELF),
    creation: 1_718_900_000,
    announce: true,
    restrict: true,
    ephemeralDuration: 86_400,
    memberAddMode: 'admin_add',
    parentGroup: wid('120999@g.us'),
    participants: [
      { id: wid(SELF), isAdmin: false, isSuperAdmin: false },
      { id: wid('91@lid'), isAdmin: true, isSuperAdmin: true },
    ],
  });

/**
 * A stand-in WhatsApp Web page: `failing` groups reject their model refresh with the invariant, every
 * other chat is modelled as whatsapp-web.js's getChatModel models it.
 */
function installPage(chats: PageChat[], failing: string[], labelItems: { parentType: string; parentId: string }[]) {
  const toPn = (id: { _serialized: string }) => (id._serialized === '91@lid' ? wid('6291@c.us') : null);
  (globalThis as unknown as { window?: unknown }).window = {
    require: (m: string) =>
      m === 'WAWebLidMigrationUtils'
        ? { toPn }
        : { Label: { get: () => ({ labelItemCollection: { getModelsArray: () => labelItems } }) } },
    WWebJS: {
      getChat: (id: string) => Promise.resolve(chats.find(c => c.id._serialized === id)),
      getChatModel: (chat: PageChat | undefined) => {
        if (!chat) return Promise.resolve(null);
        if (failing.includes(chat.id._serialized)) return Promise.reject(pageInvariant());
        const model: Record<string, unknown> = {
          ...chat.serialize(),
          isGroup: Boolean(chat.groupMetadata),
          isMuted: false,
          formattedTitle: chat.formattedTitle,
          lastMessage: { id: { _serialized: 'm1' }, type: 'chat', body: 'hi' },
        };
        if (chat.groupMetadata) model.groupMetadata = chat.groupMetadata.serialize();
        return Promise.resolve(model);
      },
    },
  };
}

function makeHost(client: Record<string, unknown>) {
  const evaluate = jest.fn((fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve().then(() => fn(arg)));
  const fullClient = { info: { wid: wid(SELF) }, pupPage: { evaluate }, ...client };
  const reportIfPageTransportError = jest.fn();
  const getClient = jest.fn(() => fullClient as unknown as Client);
  const host = {
    ensureReady: jest.fn(),
    getClient,
    isPageTransportError: (error: unknown) => error === transportError,
    reportIfPageTransportError,
    logger,
  } as unknown as WwebjsEngineHost;
  return { host, evaluate, getClient, reportIfPageTransportError };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  jest.restoreAllMocks();
});

describe('getGroupInfo for a group whose refresh fails an invariant', () => {
  it('reads the group from the metadata the page already holds', async () => {
    installPage([coexGroup()], [GROUP], []);
    const { host } = makeHost({ getChatById: jest.fn().mockRejectedValue(hostInvariant()) });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const info = await new WwebjsGroups(host).getGroupInfo(GROUP);

    expect(info).toEqual({
      id: GROUP,
      name: 'Coex group',
      description: 'Coordination',
      owner: SELF,
      createdAt: 1_718_900_000,
      // The lid member goes through the same lid -> phone mapping the normal path applies.
      participants: [
        { id: SELF, number: '628000', name: undefined, isAdmin: false, isSuperAdmin: false },
        { id: '6291@c.us', number: '6291', name: undefined, isAdmin: true, isSuperAdmin: true },
      ],
      isReadOnly: true,
      isAnnounce: true,
      announce: true,
      locked: true,
      ephemeralSeconds: 86_400,
      memberAddMode: 'admins',
      linkedParentJID: '120999@g.us',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 group(s) from local metadata'),
      expect.objectContaining({ context: 'getGroupInfo', groups: [GROUP] }),
    );
  });

  it('lets an admin of the announce-only group post', async () => {
    const group = coexGroup();
    const metadata = group.groupMetadata!.serialize() as { participants: { isAdmin: boolean }[] };
    metadata.participants[0].isAdmin = true;
    group.groupMetadata!.serialize = () => structuredClone(metadata);
    installPage([group], [GROUP], []);
    const { host } = makeHost({ getChatById: jest.fn().mockRejectedValue(hostInvariant()) });
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(new WwebjsGroups(host).getGroupInfo(GROUP)).resolves.toMatchObject({
      isReadOnly: false,
      isAnnounce: true,
    });
  });

  it('still answers null for a rejection that is not an invariant, without a second read', async () => {
    installPage([coexGroup()], [GROUP], []);
    const { host, evaluate } = makeHost({ getChatById: jest.fn().mockRejectedValue(new Error('Socket closed')) });
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(new WwebjsGroups(host).getGroupInfo(GROUP)).resolves.toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    ['a dead page', transportError],
    ['an expired protocol timeout', timeoutError],
  ])('still answers %s with a 503, without a second read', async (_, error) => {
    installPage([coexGroup()], [GROUP], []);
    const { host, evaluate } = makeHost({ getChatById: jest.fn().mockRejectedValue(error) });

    await expect(new WwebjsGroups(host).getGroupInfo(GROUP)).rejects.toBeInstanceOf(EngineTransportError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('answers null as before when the group cannot be read locally either', async () => {
    const group = coexGroup();
    group.serialize = () => {
      throw new Error('local read failed');
    };
    installPage([group], [GROUP], []);
    const { host, evaluate } = makeHost({ getChatById: jest.fn().mockRejectedValue(hostInvariant()) });
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(new WwebjsGroups(host).getGroupInfo(GROUP)).resolves.toBeNull();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('answers a page that dies during the local read with a 503, not a missing group', async () => {
    installPage([coexGroup()], [GROUP], []);
    const { host, evaluate, reportIfPageTransportError } = makeHost({
      getChatById: jest.fn().mockRejectedValue(hostInvariant()),
    });
    evaluate.mockRejectedValue(transportError);

    await expect(new WwebjsGroups(host).getGroupInfo(GROUP)).rejects.toBeInstanceOf(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, 'getGroupInfo');
  });
});

describe('getChatsByLabel when a group on the label fails an invariant', () => {
  const items = [
    { parentType: 'Chat', parentId: PERSONAL },
    { parentType: 'Chat', parentId: GROUP },
    { parentType: 'Chat', parentId: OTHER_GROUP },
    // Neither is listed: a non-chat item, and a chat that no longer resolves.
    { parentType: 'Msg', parentId: 'false_628111@c.us_ABC' },
    { parentType: 'Chat', parentId: '628999@c.us' },
  ];
  const chats = () => [
    pageChat(PERSONAL, 'Alice'),
    coexGroup(),
    pageChat(OTHER_GROUP, 'Team', { participants: [{ id: wid(SELF), isAdmin: true }] }),
  ];

  it('lists every chat on the label, the failing group from its loaded metadata', async () => {
    installPage(chats(), [GROUP], items);
    const { host } = makeHost({ getChatsByLabelId: jest.fn().mockRejectedValue(hostInvariant()) });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const summaries = await new WwebjsLabels(host).getChatsByLabel('7');

    const common = { unreadCount: 1, timestamp: 1_700_000_000, archived: false, pinned: false, muted: false };
    expect(summaries).toEqual([
      { id: PERSONAL, name: 'Alice', isGroup: false, kind: 'individual', lastMessageType: 'text', ...common },
      // Served locally: no last message, so no lastMessageType.
      { id: GROUP, name: 'Coex group', isGroup: true, kind: 'group', lastMessageType: undefined, ...common },
      { id: OTHER_GROUP, name: 'Team', isGroup: true, kind: 'group', lastMessageType: 'text', ...common },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 group(s) from local metadata'),
      expect.objectContaining({ context: 'getChatsByLabel', groups: [GROUP] }),
    );
  });

  it.each([
    ['a rejection that is not an invariant', new Error('Socket closed')],
    ['an unknown label', new TypeError("Cannot read properties of undefined (reading 'labelItemCollection')")],
  ])('still answers %s as a missing label, without a second read', async (_, error) => {
    installPage(chats(), [GROUP], items);
    const { host, evaluate } = makeHost({ getChatsByLabelId: jest.fn().mockRejectedValue(error) });

    await expect(new WwebjsLabels(host).getChatsByLabel('7')).rejects.toBeInstanceOf(LabelNotFoundError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    ['a dead page', transportError],
    ['an expired protocol timeout', timeoutError],
  ])('still answers %s with a 503, without a second read', async (_, error) => {
    installPage(chats(), [GROUP], items);
    const { host, evaluate } = makeHost({ getChatsByLabelId: jest.fn().mockRejectedValue(error) });

    await expect(new WwebjsLabels(host).getChatsByLabel('7')).rejects.toBeInstanceOf(EngineTransportError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('answers a missing label as before when the failing group cannot be read locally either', async () => {
    const list = chats();
    list[1].serialize = () => {
      throw new Error('local read failed');
    };
    installPage(list, [GROUP], items);
    const { host, evaluate } = makeHost({ getChatsByLabelId: jest.fn().mockRejectedValue(hostInvariant()) });

    await expect(new WwebjsLabels(host).getChatsByLabel('7')).rejects.toBeInstanceOf(LabelNotFoundError);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('answers a session that stopped before the local read with a 409, not a missing label', async () => {
    installPage(chats(), [GROUP], items);
    const { host, getClient } = makeHost({ getChatsByLabelId: jest.fn().mockRejectedValue(hostInvariant()) });
    const client = getClient();
    getClient
      .mockImplementationOnce(() => client)
      .mockImplementation(() => {
        throw new EngineNotReadyError();
      });

    await expect(new WwebjsLabels(host).getChatsByLabel('7')).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});

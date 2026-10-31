import type { Client } from 'whatsapp-web.js';
import { WwebjsGroups } from './wwebjs-groups';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * getGroupInfo reads a whatsapp-web.js GroupChat, whose accessors do not match the neutral contract:
 * `createdAt` is a getter returning a Date (GroupChat.js:36), there is no `isAnnounce` at all, and
 * `isReadOnly` is overwritten with the group's announce setting (Injected/Utils.js:1005). These pin the
 * fields to what the Baileys mapper reports for the same group.
 */
const logger = createLogger('wwebjs-group-info.spec');

const SELF = '628111@c.us';
const OTHER = '628222@c.us';

function makeGroups(chat: Record<string, unknown>): WwebjsGroups {
  const client = {
    info: { wid: { _serialized: SELF } },
    getChatById: jest
      .fn()
      .mockResolvedValue({ id: { _serialized: '120363@g.us' }, name: 'Team', isGroup: true, ...chat }),
  };
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
  } as unknown as WwebjsEngineHost;
  return new WwebjsGroups(host);
}

const participant = (id: string, isAdmin: boolean): Record<string, unknown> => ({
  id: { _serialized: id, user: id.split('@')[0] },
  isAdmin,
  isSuperAdmin: false,
});

describe('WwebjsGroups.getGroupInfo', () => {
  it('reports createdAt in Unix seconds, not the Date the GroupChat getter builds', async () => {
    const groupMetadata = { creation: 1718900000 };
    const info = await makeGroups({
      groupMetadata,
      participants: [],
      // The real getter: new Date(creation * 1000), which serialises as an ISO string.
      get createdAt() {
        return new Date(groupMetadata.creation * 1000);
      },
    }).getGroupInfo('120363@g.us');

    expect(info?.createdAt).toBe(1718900000);
  });

  it('omits createdAt when the metadata carries no creation time', async () => {
    const info = await makeGroups({ groupMetadata: {}, participants: [] }).getGroupInfo('120363@g.us');

    expect(info?.createdAt).toBeUndefined();
  });

  // WA Web's own isReadOnly is the announce setting, so an admin of an announce-only group was told
  // they could not post, while isAnnounce (absent on GroupChat) always read false.
  it('lets an admin of an announce-only group post', async () => {
    const info = await makeGroups({
      groupMetadata: { announce: true },
      isReadOnly: true,
      participants: [participant(SELF, true), participant(OTHER, false)],
    }).getGroupInfo('120363@g.us');

    expect(info).toMatchObject({ isAnnounce: true, isReadOnly: false, announce: true });
  });

  it('reports a non-admin of an announce-only group as read-only', async () => {
    const info = await makeGroups({
      groupMetadata: { announce: true },
      isReadOnly: true,
      participants: [participant(SELF, false), participant(OTHER, true)],
    }).getGroupInfo('120363@g.us');

    expect(info).toMatchObject({ isAnnounce: true, isReadOnly: true });
  });

  it('reports an open group as writable for everyone', async () => {
    const info = await makeGroups({
      groupMetadata: { announce: false },
      participants: [participant(SELF, false)],
    }).getGroupInfo('120363@g.us');

    expect(info).toMatchObject({ isAnnounce: false, isReadOnly: false });
  });
});

/**
 * getChatById refreshes a group's metadata before it resolves, and WhatsApp Web can fail one of its own
 * invariants on the reply (#1950), so the group read answered 404 for a group the list showed. The
 * fallback runs the real in-page walk against a stand-in page.
 */
describe('WwebjsGroups.getGroupInfo for a group whose metadata refresh fails', () => {
  const g = globalThis as unknown as { window?: unknown };
  const invariant = Object.assign(new Error('Minified invariant #76137; %s'), { name: 'Invariant Violation' });

  afterEach(() => {
    delete g.window;
    jest.restoreAllMocks();
  });

  const loadedGroup = {
    serialize: () => ({ id: { _serialized: '120363@g.us' }, formattedTitle: 'Coex group', msgs: [] }),
    mute: { expiration: 0 },
    formattedTitle: 'Coex group',
    groupMetadata: {
      announce: true,
      serialize: () => ({
        announce: true,
        creation: 1718900000,
        owner: { _serialized: SELF },
        participants: [participant(SELF, true), participant(OTHER, false)],
      }),
    },
  };

  function makeFailingGroups(pageChats: Record<string, unknown>, getChatModel: () => Promise<unknown>) {
    g.window = {
      require: (m: string) =>
        m === 'WAWebLidMigrationUtils'
          ? { toPn: () => null }
          : { Chat: { get: (id: string) => pageChats[id], getModelsArray: () => Object.values(pageChats) } },
      WWebJS: { getChatModel },
    };
    const evaluate = jest.fn((fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg)));
    const client = {
      info: { wid: { _serialized: SELF } },
      getChatById: jest.fn().mockRejectedValue(new Error('Evaluation failed: Invariant Violation: #76137')),
      pupPage: { evaluate },
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
      logger,
    } as unknown as WwebjsEngineHost;
    return { groups: new WwebjsGroups(host), evaluate };
  }

  it('reads the group from the metadata the page already holds', async () => {
    const { groups, evaluate } = makeFailingGroups({ '120363@g.us': loadedGroup }, () => Promise.reject(invariant));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const info = await groups.getGroupInfo('120363@g.us');

    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), ['120363@g.us']);
    expect(info).toMatchObject({
      id: '120363@g.us',
      name: 'Coex group',
      owner: SELF,
      createdAt: 1718900000,
      participants: [
        { id: SELF, isAdmin: true },
        { id: OTHER, isAdmin: false },
      ],
      isAnnounce: true,
      isReadOnly: false,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 group(s) from local metadata'),
      expect.objectContaining({ context: 'getGroupInfo', groups: ['120363@g.us'] }),
    );
  });

  it('still answers null for a group the page does not hold', async () => {
    const { groups } = makeFailingGroups({}, () => Promise.reject(invariant));

    await expect(groups.getGroupInfo('120363@g.us')).resolves.toBeNull();
  });

  it('still answers null when the page fails for a reason other than an invariant', async () => {
    const { groups } = makeFailingGroups({ '120363@g.us': loadedGroup }, () =>
      Promise.reject(new Error('Socket closed')),
    );

    await expect(groups.getGroupInfo('120363@g.us')).resolves.toBeNull();
  });
});

import type { Client } from 'whatsapp-web.js';
import { WwebjsGroups } from './wwebjs-groups';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * getGroupInfo reads a whatsapp-web.js GroupChat, whose accessors do not match the neutral contract:
 * `createdAt` is a getter returning a Date (GroupChat#createdAt), there is no `isAnnounce` at all, and
 * `isReadOnly` is overwritten with the group's announce setting (`WWebJS.getChatModel` in Injected/Utils.js). These pin the
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

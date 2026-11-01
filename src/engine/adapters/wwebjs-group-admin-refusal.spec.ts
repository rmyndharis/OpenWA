import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

/**
 * whatsapp-web.js answers a remove, promote or demote with a fixed status whatever WhatsApp decided, and reads the
 * membership requests from the page's own store, so a non-admin got a false success or a bare 500 where the routes
 * document 403 and Baileys answers it. The account's own entry in the group's participant list decides up front.
 * Only a member that is neither admin nor superadmin is refused: an account the list does not name goes ahead.
 */
describe('whatsapp-web.js group admin writes and reads for an account that is not an admin', () => {
  const GROUP = '120363000000000001@g.us';
  const SELF = '628000000001@c.us';
  const MEMBER = '628111222333@c.us';

  function setup(self: { isAdmin: boolean; isSuperAdmin: boolean } | null) {
    const participants = [{ id: { _serialized: MEMBER, user: '628111222333' }, isAdmin: false, isSuperAdmin: false }];
    if (self) participants.push({ id: { _serialized: SELF, user: '628000000001' }, ...self });
    const batch = jest.fn().mockResolvedValue({ status: 200, matched: [true] });
    const getGroupMembershipRequests = jest.fn().mockResolvedValue([]);
    const requestAction = jest.fn().mockResolvedValue([]);
    const chat = {
      id: { _serialized: GROUP },
      isGroup: true,
      participants,
      removeParticipants: batch,
      promoteParticipants: batch,
      demoteParticipants: batch,
    };
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = {
      info: { wid: { _serialized: SELF, user: '628000000001' } },
      getChatById: jest.fn().mockResolvedValue(chat),
      getGroupMembershipRequests,
      approveGroupMembershipRequests: requestAction,
      rejectGroupMembershipRequests: requestAction,
    };
    return { adapter, batch, getGroupMembershipRequests, requestAction };
  }

  const ops = ['removeParticipants', 'promoteParticipants', 'demoteParticipants'] as const;

  it.each(ops)('%s refuses a member that is not an admin with 403, before the page is asked', async op => {
    const { adapter, batch } = setup({ isAdmin: false, isSuperAdmin: false });

    await expect(adapter[op](GROUP, [MEMBER])).rejects.toBeInstanceOf(EngineRefusedError);
    expect(batch).not.toHaveBeenCalled();
  });

  it('refuses the membership requests read for a member that is not an admin', async () => {
    const { adapter, getGroupMembershipRequests } = setup({ isAdmin: false, isSuperAdmin: false });

    await expect(adapter.getGroupMembershipRequests(GROUP)).rejects.toBeInstanceOf(EngineRefusedError);
    expect(getGroupMembershipRequests).not.toHaveBeenCalled();
  });

  // Approving or rejecting every pending request reads the same store, so for a non-admin it would answer an empty
  // list that reads as "nothing pending".
  it.each(['approveGroupMembershipRequests', 'rejectGroupMembershipRequests'] as const)(
    '%s without named requesters refuses a member that is not an admin, before the page is asked',
    async op => {
      const { adapter, requestAction } = setup({ isAdmin: false, isSuperAdmin: false });

      await expect(adapter[op](GROUP)).rejects.toBeInstanceOf(EngineRefusedError);
      expect(requestAction).not.toHaveBeenCalled();
    },
  );

  it('lets an admin approve every pending request', async () => {
    const { adapter, requestAction } = setup({ isAdmin: true, isSuperAdmin: false });

    await expect(adapter.approveGroupMembershipRequests(GROUP)).resolves.toEqual([]);
    expect(requestAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an admin', { isAdmin: true, isSuperAdmin: false }],
    ['a superadmin', { isAdmin: false, isSuperAdmin: true }],
    ['not named in the participant list', null],
  ])('lets %s go ahead', async (_case, self) => {
    const { adapter, batch, getGroupMembershipRequests } = setup(self);

    await expect(adapter.removeParticipants(GROUP, [MEMBER])).resolves.toEqual([
      expect.objectContaining({ id: MEMBER, success: true }),
    ]);
    await expect(adapter.getGroupMembershipRequests(GROUP)).resolves.toEqual([]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(getGroupMembershipRequests).toHaveBeenCalledTimes(1);
  });
});

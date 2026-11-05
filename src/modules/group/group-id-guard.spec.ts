import { BadRequestException } from '@nestjs/common';
import { GroupService } from './group.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { SendPacingService } from '../message/send-pacing.service';

/**
 * Every group route names one group. An id that is not a group's must be refused before an engine is asked, as the
 * picture routes and the member label already do: Baileys addresses a group IQ to whatever jid it is handed, so a
 * person's id would be sent a group request, and whatsapp-web.js only finds out after a page call. A group id with
 * another case or surrounding space has to reach the engine in the form the group is addressed by.
 */
describe('GroupService group id guard', () => {
  const GROUP = '120363000000000001@g.us';

  const makeEngine = () => ({
    getGroupInfo: jest.fn().mockResolvedValue({ id: GROUP, name: 'G', announce: false, locked: false }),
    addParticipants: jest.fn().mockResolvedValue([]),
    removeParticipants: jest.fn().mockResolvedValue([]),
    promoteParticipants: jest.fn().mockResolvedValue([]),
    demoteParticipants: jest.fn().mockResolvedValue([]),
    getGroupMembershipRequests: jest.fn().mockResolvedValue([]),
    approveGroupMembershipRequests: jest.fn().mockResolvedValue([]),
    rejectGroupMembershipRequests: jest.fn().mockResolvedValue([]),
    setGroupSubject: jest.fn().mockResolvedValue(undefined),
    setGroupDescription: jest.fn().mockResolvedValue(undefined),
    leaveGroup: jest.fn().mockResolvedValue(undefined),
    getGroupInviteCode: jest.fn().mockResolvedValue('CODE'),
    revokeGroupInviteCode: jest.fn().mockResolvedValue('CODE2'),
    setGroupMessagesAdminsOnly: jest.fn().mockResolvedValue(undefined),
    setGroupInfoAdminsOnly: jest.fn().mockResolvedValue(undefined),
    setGroupEphemeral: jest.fn().mockResolvedValue(undefined),
    setGroupMemberAddMode: jest.fn().mockResolvedValue(undefined),
  });
  type Engine = ReturnType<typeof makeEngine>;

  const make = (engine: Engine) => {
    const engines = new EngineRegistry();
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    const pacing = {
      assertReachoutAllowed: jest.fn().mockResolvedValue({ coldCount: 0, dayStartMs: 0 }),
      refundGroupReachouts: jest.fn(),
    };
    return { svc: new GroupService(engines, pacing as unknown as SendPacingService), pacing };
  };

  /** The group id the engine was asked about, the first argument of its only call. */
  const groupArg = (mock: jest.Mock): unknown => (mock.mock.calls[0] as unknown[])[0];

  /** The outcome of a call that may refuse at once or later, as a value. */
  const outcomeOf = async (call: () => unknown): Promise<unknown> => {
    try {
      return await call();
    } catch (error) {
      return error;
    }
  };

  const PEOPLE = ['628111111@c.us'];
  const cases: Array<[route: string, call: (svc: GroupService, id: string) => unknown, method: keyof Engine]> = [
    ['group info', (s, id) => s.getGroupInfo('s1', id), 'getGroupInfo'],
    ['group settings read', (s, id) => s.getGroupSettings('s1', id), 'getGroupInfo'],
    [
      'group settings write',
      (s, id) => s.updateGroupSettings('s1', id, { announce: true }),
      'setGroupMessagesAdminsOnly',
    ],
    ['participants add', (s, id) => s.addParticipants('s1', id, PEOPLE), 'addParticipants'],
    ['participants remove', (s, id) => s.removeParticipants('s1', id, PEOPLE), 'removeParticipants'],
    ['participants promote', (s, id) => s.promoteParticipants('s1', id, PEOPLE), 'promoteParticipants'],
    ['participants demote', (s, id) => s.demoteParticipants('s1', id, PEOPLE), 'demoteParticipants'],
    ['membership requests read', (s, id) => s.getGroupMembershipRequests('s1', id), 'getGroupMembershipRequests'],
    [
      'membership requests approve',
      (s, id) => s.approveGroupMembershipRequests('s1', id),
      'approveGroupMembershipRequests',
    ],
    [
      'membership requests reject',
      (s, id) => s.rejectGroupMembershipRequests('s1', id, PEOPLE),
      'rejectGroupMembershipRequests',
    ],
    ['subject', (s, id) => s.setGroupSubject('s1', id, 'Team'), 'setGroupSubject'],
    ['description', (s, id) => s.setGroupDescription('s1', id, 'About'), 'setGroupDescription'],
    ['leave', (s, id) => s.leaveGroup('s1', id), 'leaveGroup'],
    ['invite code read', (s, id) => s.getGroupInviteCode('s1', id), 'getGroupInviteCode'],
    ['invite code revoke', (s, id) => s.revokeGroupInviteCode('s1', id), 'revokeGroupInviteCode'],
  ];

  const NOT_GROUPS: Array<[label: string, id: string]> = [
    ['a 1:1 id', '628123456789@c.us'],
    ['a device id in the protocol dialect', '628123456789:5@s.whatsapp.net'],
    ['a privacy id', '99887766@lid'],
    ['a channel', '120363000000000000@newsletter'],
    ['a 1:1 id with a group domain appended', '628123456789@c.us@g.us'],
  ];

  describe.each(cases)('%s', (_route, call, method) => {
    it.each(NOT_GROUPS)('refuses %s before an engine or the pacing budget is asked', async (_label, id) => {
      const engine = makeEngine();
      const { svc, pacing } = make(engine);

      const outcome = await outcomeOf(() => call(svc, id));

      expect(engine[method]).not.toHaveBeenCalled();
      expect(pacing.assertReachoutAllowed).not.toHaveBeenCalled();
      expect(outcome).toBeInstanceOf(BadRequestException);
    });

    // The check comes before the engine is looked up, on every route, as the picture routes' check does.
    it('refuses a 1:1 id with the group id message even when the session is not started', async () => {
      const svc = new GroupService(new EngineRegistry(), {} as SendPacingService);

      const outcome = await outcomeOf(() => call(svc, '628123456789@c.us'));

      expect(outcome).toBeInstanceOf(BadRequestException);
      expect((outcome as Error).message).toContain('is not a group id');
    });

    it.each([GROUP, ' 120363000000000001@G.US '])(
      'hands the engine the group id %j in its canonical form',
      async id => {
        const engine = makeEngine();
        const { svc } = make(engine);

        await call(svc, id);

        expect(engine[method]).toHaveBeenCalledTimes(1);
        expect(groupArg(engine[method])).toBe(GROUP);
      },
    );
  });

  it('hands every setting of a group settings write the canonical id', async () => {
    const engine = makeEngine();
    const { svc } = make(engine);

    await svc.updateGroupSettings('s1', ' 120363000000000001@G.US ', {
      announce: true,
      locked: false,
      ephemeralSeconds: 86400,
      memberAddMode: 'admins',
    });

    expect(groupArg(engine.setGroupEphemeral)).toBe(GROUP);
    expect(groupArg(engine.setGroupMemberAddMode)).toBe(GROUP);
    expect(groupArg(engine.setGroupMessagesAdminsOnly)).toBe(GROUP);
    expect(groupArg(engine.setGroupInfoAdminsOnly)).toBe(GROUP);
  });

  it('answers a request for a group on a session that is not started with the not-started 400', () => {
    const svc = new GroupService(new EngineRegistry(), {} as SendPacingService);

    expect(() => svc.leaveGroup('missing', GROUP)).toThrow('Session is not started');
  });
});

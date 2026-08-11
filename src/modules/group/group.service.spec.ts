import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { GroupService } from './group.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { SendPacingService } from '../message/send-pacing.service';

/** Pacing is off by default; its own spec covers the governor, so here it must simply not refuse. */
const inertPacing = (): SendPacingService =>
  ({ assertReachoutAllowed: jest.fn().mockResolvedValue(undefined) }) as unknown as SendPacingService;

describe('GroupService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined, pacing: SendPacingService = inertPacing()) => {
    const engines = new EngineRegistry();
    if (engine) engines.set('s1', engine as IWhatsAppEngine);
    return new GroupService(engines, pacing);
  };

  it('throws 400 "Session is not started" when the engine is missing (guard preserved)', () => {
    // The guard throws synchronously; the controller methods are `async`, so this still surfaces
    // as a rejected promise → 400 at the HTTP layer.
    const svc = makeService(undefined);
    expect(() => svc.getGroups('s1')).toThrow(BadRequestException);
    expect(() => svc.getGroups('s1')).toThrow('Session is not started');
  });

  it('delegates getGroups to the engine when the session is started', async () => {
    const getGroups = jest.fn().mockResolvedValue([{ id: 'g1' }]);
    const svc = makeService({ getGroups });
    await expect(svc.getGroups('s1')).resolves.toEqual([{ id: 'g1' }]);
    expect(getGroups).toHaveBeenCalledTimes(1);
  });

  it('caps an unbounded groups list at the default limit (1000)', async () => {
    const big = Array.from({ length: 1500 }, (_, i) => ({ id: `g${i}` }));
    const svc = makeService({ getGroups: jest.fn().mockResolvedValue(big) });
    await expect(svc.getGroups('s1')).resolves.toHaveLength(1000);
  });

  it('applies limit/offset to the groups list', async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ id: `g${i}` }));
    const page = (await makeService({ getGroups: jest.fn().mockResolvedValue(big) }).getGroups('s1', {
      limit: 5,
      offset: 10,
    })) as { id: string }[];
    expect(page).toHaveLength(5);
    expect(page[0].id).toBe('g10');
  });

  it('maps a missing group to 404 (business rule lives in the service)', async () => {
    const svc = makeService({ getGroupInfo: jest.fn().mockResolvedValue(null) });
    await expect(svc.getGroupInfo('s1', 'g404')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the group when found', async () => {
    const svc = makeService({ getGroupInfo: jest.fn().mockResolvedValue({ id: 'g1', name: 'G' }) });
    await expect(svc.getGroupInfo('s1', 'g1')).resolves.toEqual({ id: 'g1', name: 'G' });
  });

  it('passes participant lists straight through to the engine', async () => {
    const addParticipants = jest.fn().mockResolvedValue(undefined);
    const svc = makeService({ addParticipants });
    // Real-shaped ids: the participant guard requires a numeric user-part, so `a@c.us` would now
    // fail validation and this would stop testing the pass-through it is named for.
    await svc.addParticipants('s1', 'g1', ['628111111@c.us', '628222222@c.us']);
    expect(addParticipants).toHaveBeenCalledWith('g1', ['628111111@c.us', '628222222@c.us']);
  });

  it('joinGroupViaInviteCode delegates and returns the group id', async () => {
    const joinGroupViaInviteCode = jest.fn().mockResolvedValue('120363000@g.us');
    const svc = makeService({ joinGroupViaInviteCode });
    await expect(svc.joinGroupViaInviteCode('s1', 'CODE123')).resolves.toBe('120363000@g.us');
    expect(joinGroupViaInviteCode).toHaveBeenCalledWith('CODE123');
  });

  describe('getGroupSettings', () => {
    it('maps the settings fields from getGroupInfo', async () => {
      const svc = makeService({
        getGroupInfo: jest.fn().mockResolvedValue({ id: 'g1', announce: true, locked: false, ephemeralSeconds: 86400 }),
      });
      await expect(svc.getGroupSettings('s1', 'g1')).resolves.toEqual({
        announce: true,
        locked: false,
        ephemeralSeconds: 86400,
      });
    });

    it('omits ephemeralSeconds when the engine does not report one', async () => {
      const svc = makeService({
        getGroupInfo: jest.fn().mockResolvedValue({ id: 'g1', announce: true, locked: true }),
      });
      const settings = (await svc.getGroupSettings('s1', 'g1')) as Record<string, unknown>;
      expect(settings).toEqual({ announce: true, locked: true });
      expect('ephemeralSeconds' in settings).toBe(false);
    });

    it('maps an unknown group to 404 (same rule as getGroupInfo)', async () => {
      const svc = makeService({ getGroupInfo: jest.fn().mockResolvedValue(null) });
      await expect(svc.getGroupSettings('s1', 'g404')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateGroupSettings', () => {
    it('rejects an empty patch with 400 (at least one setting required)', async () => {
      const svc = makeService({});
      await expect(svc.updateGroupSettings('s1', 'g1', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invokes only the engine methods for the fields present', async () => {
      const engine = {
        setGroupMessagesAdminsOnly: jest.fn().mockResolvedValue(undefined),
        setGroupInfoAdminsOnly: jest.fn().mockResolvedValue(undefined),
        setGroupEphemeral: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(engine);
      await svc.updateGroupSettings('s1', 'g1', { announce: true });
      expect(engine.setGroupMessagesAdminsOnly).toHaveBeenCalledWith('g1', true);
      expect(engine.setGroupInfoAdminsOnly).not.toHaveBeenCalled();
      expect(engine.setGroupEphemeral).not.toHaveBeenCalled();
    });

    it('applies all three fields when all are present (incl. ephemeral 0 = disable)', async () => {
      const engine = {
        setGroupMessagesAdminsOnly: jest.fn().mockResolvedValue(undefined),
        setGroupInfoAdminsOnly: jest.fn().mockResolvedValue(undefined),
        setGroupEphemeral: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(engine);
      await svc.updateGroupSettings('s1', 'g1', { announce: false, locked: true, ephemeralSeconds: 0 });
      expect(engine.setGroupMessagesAdminsOnly).toHaveBeenCalledWith('g1', false);
      expect(engine.setGroupInfoAdminsOnly).toHaveBeenCalledWith('g1', true);
      expect(engine.setGroupEphemeral).toHaveBeenCalledWith('g1', 0);
    });

    it('lets EngineNotSupportedError propagate (→ 501)', async () => {
      const engine = {
        setGroupEphemeral: jest.fn().mockRejectedValue(new EngineNotSupportedError('setGroupEphemeral')),
      };
      const svc = makeService(engine);
      await expect(svc.updateGroupSettings('s1', 'g1', { ephemeralSeconds: 3600 })).rejects.toBeInstanceOf(
        EngineNotSupportedError,
      );
    });

    it('applies ephemeralSeconds FIRST so a 501 cannot leave announce/locked half-applied (wwjs case)', async () => {
      // wwjs always 501s setGroupEphemeral: a {announce, ephemeralSeconds} patch must fail BEFORE
      // touching announce/locked, not after a silent partial application.
      const engine = {
        setGroupMessagesAdminsOnly: jest.fn().mockResolvedValue(undefined),
        setGroupInfoAdminsOnly: jest.fn().mockResolvedValue(undefined),
        setGroupEphemeral: jest.fn().mockRejectedValue(new EngineNotSupportedError('setGroupEphemeral')),
      };
      const svc = makeService(engine);
      await expect(
        svc.updateGroupSettings('s1', 'g1', { announce: true, locked: true, ephemeralSeconds: 86400 }),
      ).rejects.toBeInstanceOf(EngineNotSupportedError);
      expect(engine.setGroupMessagesAdminsOnly).not.toHaveBeenCalled();
      expect(engine.setGroupInfoAdminsOnly).not.toHaveBeenCalled();
    });

    it('keeps memberAddMode BEHIND ephemeralSeconds, so the deterministic 501 still fails first', async () => {
      // memberAddMode is supported on both engines and therefore has no deterministic refusal.
      // Ordering it ahead of ephemeralSeconds would reintroduce exactly the half-applied patch the
      // rule above exists to prevent: the mode would land, then the ephemeral call would 501.
      const engine = {
        setGroupMemberAddMode: jest.fn().mockResolvedValue(undefined),
        setGroupMessagesAdminsOnly: jest.fn().mockResolvedValue(undefined),
        setGroupInfoAdminsOnly: jest.fn().mockResolvedValue(undefined),
        setGroupEphemeral: jest.fn().mockRejectedValue(new EngineNotSupportedError('setGroupEphemeral')),
      };
      const svc = makeService(engine);
      await expect(
        svc.updateGroupSettings('s1', 'g1', { memberAddMode: 'admins', ephemeralSeconds: 86400 }),
      ).rejects.toBeInstanceOf(EngineNotSupportedError);
      expect(engine.setGroupMemberAddMode).not.toHaveBeenCalled();
    });

    it('applies memberAddMode when it is the only field in the patch', async () => {
      const engine = { setGroupMemberAddMode: jest.fn().mockResolvedValue(undefined) };
      const svc = makeService(engine);
      await svc.updateGroupSettings('s1', 'g1', { memberAddMode: 'all' });
      expect(engine.setGroupMemberAddMode).toHaveBeenCalledWith('g1', 'all');
    });

    it('names the failed field AND the applied ones when a patch partially applies', async () => {
      // ephemeralSeconds applied, then announce failed: the client must learn the group is now in a
      // mixed state (and which subset took effect), not receive a bare engine error.
      const engine = {
        setGroupEphemeral: jest.fn().mockResolvedValue(undefined),
        setGroupMessagesAdminsOnly: jest.fn().mockRejectedValue(new EngineRefusedError('not a group admin')),
        setGroupInfoAdminsOnly: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(engine);
      const error = await svc
        .updateGroupSettings('s1', 'g1', { announce: true, locked: true, ephemeralSeconds: 86400 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(403); // the underlying refusal's status survives
      expect((error as HttpException).message).toContain("'announce' failed");
      expect((error as HttpException).message).toContain('ephemeralSeconds');
      // The patch stops at the failure: locked is never attempted.
      expect(engine.setGroupInfoAdminsOnly).not.toHaveBeenCalled();
    });

    it('propagates a first-field failure unchanged (nothing applied → no partial state to report)', async () => {
      const engine = {
        setGroupEphemeral: jest.fn().mockRejectedValue(new EngineRefusedError('not a group admin')),
        setGroupMessagesAdminsOnly: jest.fn().mockResolvedValue(undefined),
      };
      const svc = makeService(engine);
      await expect(
        svc.updateGroupSettings('s1', 'g1', { announce: true, ephemeralSeconds: 86400 }),
      ).rejects.toBeInstanceOf(EngineRefusedError);
      expect(engine.setGroupMessagesAdminsOnly).not.toHaveBeenCalled();
    });
  });
});

// A preview must never look like membership: it reports a count, never a participant list, and it
// changes nothing about the account.
describe('GroupService join-info preview', () => {
  const makeService = (engine: Partial<IWhatsAppEngine>) => {
    const engines = new EngineRegistry();
    engines.set('s1', engine as IWhatsAppEngine);
    return new GroupService(engines, inertPacing());
  };

  it('delegates the trimmed code to the engine', async () => {
    const getGroupJoinInfo = jest.fn().mockResolvedValue({ id: 'g@g.us', name: 'Team' });

    await makeService({ getGroupJoinInfo }).getGroupJoinInfo('s1', '  ABC123  ');

    expect(getGroupJoinInfo).toHaveBeenCalledWith('ABC123');
  });

  // An empty code would otherwise reach the engine and come back as a confusing not-found rather
  // than the client error it plainly is.
  it.each(['', '   ', undefined])('rejects a missing code (%p) before reaching the engine', code => {
    const getGroupJoinInfo = jest.fn();

    expect(() => makeService({ getGroupJoinInfo }).getGroupJoinInfo('s1', code as string)).toThrow(BadRequestException);
    expect(getGroupJoinInfo).not.toHaveBeenCalled();
  });

  it('throws 400 when the session is not started', () => {
    expect(() => new GroupService(new EngineRegistry(), inertPacing()).getGroupJoinInfo('s1', 'ABC')).toThrow(
      BadRequestException,
    );
  });
});

describe('GroupService membership requests', () => {
  const makeService = (engine: Partial<IWhatsAppEngine>, pacing: SendPacingService = inertPacing()) => {
    const engines = new EngineRegistry();
    engines.set('s1', engine as IWhatsAppEngine);
    return { svc: new GroupService(engines, pacing), pacing };
  };

  it('delegates the pending-request list to the engine', async () => {
    const requests = [{ participantId: '628111@c.us', method: 'invite_link', requestedAt: 1754700000 }];
    const getGroupMembershipRequests = jest.fn().mockResolvedValue(requests);

    const { svc } = makeService({ getGroupMembershipRequests });

    await expect(svc.getGroupMembershipRequests('s1', 'g1')).resolves.toEqual(requests);
    expect(getGroupMembershipRequests).toHaveBeenCalledWith('g1');
  });

  it.each([['approveGroupMembershipRequests' as const], ['rejectGroupMembershipRequests' as const]])(
    '%s forwards the named participants and the results verbatim',
    async method => {
      const results = [{ id: '628111@c.us', success: true, status: 200 }];
      const engineFn = jest.fn().mockResolvedValue(results);

      const { svc } = makeService({ [method]: engineFn });

      await expect(svc[method]('s1', 'g1', ['628111@c.us'])).resolves.toEqual(results);
      expect(engineFn).toHaveBeenCalledWith('g1', ['628111@c.us']);
    },
  );

  it('passes an omitted participant list through as undefined (approve/reject ALL pending)', async () => {
    const approveGroupMembershipRequests = jest.fn().mockResolvedValue([]);

    const { svc } = makeService({ approveGroupMembershipRequests });

    await expect(svc.approveGroupMembershipRequests('s1', 'g1')).resolves.toEqual([]);
    expect(approveGroupMembershipRequests).toHaveBeenCalledWith('g1', undefined);
  });

  it('does NOT draw on the cold-reachout budget — the requesters asked for the contact', async () => {
    const approveGroupMembershipRequests = jest.fn().mockResolvedValue([]);
    const assertReachoutAllowed = jest.fn().mockResolvedValue(undefined);

    const { svc } = makeService({ approveGroupMembershipRequests }, {
      assertReachoutAllowed,
    } as unknown as SendPacingService);
    await svc.approveGroupMembershipRequests('s1', 'g1', ['628111@c.us']);

    expect(assertReachoutAllowed).not.toHaveBeenCalled();
  });

  it('throws 400 when the session is not started', () => {
    const svc = new GroupService(new EngineRegistry(), inertPacing());
    expect(() => svc.getGroupMembershipRequests('s1', 'g1')).toThrow(BadRequestException);
  });
});

describe('GroupService participant id validation (#1220)', () => {
  const GROUP = '120363165619688042@g.us';

  const makeService = (engine: Partial<IWhatsAppEngine>, pacing: SendPacingService = inertPacing()) => {
    const engines = new EngineRegistry();
    engines.set('s1', engine as IWhatsAppEngine);
    return new GroupService(engines, pacing);
  };

  /**
   * The three status-only writes are synchronous forwarders, so their guard throws synchronously,
   * while createGroup/addParticipants are async. Routing both through a promise lets one table
   * cover all five without asserting the wrong failure mode for half of them.
   */
  const call = (svc: GroupService, op: string, participants: string[]) =>
    Promise.resolve().then(() =>
      op === 'createGroup'
        ? svc.createGroup('s1', 'Team', participants)
        : (svc as unknown as Record<string, (s: string, g: string, p: string[]) => Promise<unknown>>)[op](
            's1',
            GROUP,
            participants,
          ),
    );

  it.each([
    ['removeParticipants'],
    ['promoteParticipants'],
    ['demoteParticipants'],
    ['addParticipants'],
    ['createGroup'],
  ])('%s rejects an unaddressable id with 400 before reaching the engine', async op => {
    const engineOp = jest.fn();
    const svc = makeService({ [op]: engineOp });

    await expect(call(svc, op, ['NOT A USER'])).rejects.toBeInstanceOf(BadRequestException);
    expect(engineOp).not.toHaveBeenCalled();
  });

  it('names every offending entry and leaves the valid ones out of the message', async () => {
    const svc = makeService({ removeParticipants: jest.fn() });

    const err = await call(svc, 'removeParticipants', ['628123456789@c.us', 'NOT A USER', '12036@g.us']).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toContain('NOT A USER');
    expect((err as Error).message).toContain('12036@g.us');
    expect((err as Error).message).not.toContain('628123456789@c.us');
  });

  it('accepts a bare number, a c.us id and a lid, forwarding them verbatim', async () => {
    const removeParticipants = jest.fn().mockResolvedValue([]);
    const svc = makeService({ removeParticipants });

    await call(svc, 'removeParticipants', ['628123456789', '628999@c.us', '12345678901234567890@lid']);

    expect(removeParticipants).toHaveBeenCalledWith(GROUP, ['628123456789', '628999@c.us', '12345678901234567890@lid']);
  });

  it.each([['addParticipants'], ['createGroup']])(
    '%s rejects a malformed participant before it can consume reachout budget',
    async op => {
      // Both paced writes, not just one: a batch that can never reach WhatsApp must not draw on the
      // cold-reachout budget on its way to a 400.
      const assertReachoutAllowed = jest.fn().mockResolvedValue(undefined);
      const svc = makeService({ [op]: jest.fn() }, { assertReachoutAllowed } as unknown as SendPacingService);

      await expect(call(svc, op, ['NOT A USER'])).rejects.toBeInstanceOf(BadRequestException);
      expect(assertReachoutAllowed).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['NOT A USER'],
    // A recognised domain alone satisfied the first version of the guard, and the id still reached
    // the page-side createWid — reproduced as a 500 against a live session.
    ['NOT A USER@c.us'],
    ['@c.us'],
    ['0@c.us'],
  ])('rejects %s on removeParticipants rather than handing it to the engine', async id => {
    const engineOp = jest.fn();
    const svc = makeService({ removeParticipants: engineOp });

    await expect(call(svc, 'removeParticipants', [id])).rejects.toBeInstanceOf(BadRequestException);
    expect(engineOp).not.toHaveBeenCalled();
  });

  it.each([['approveGroupMembershipRequests'], ['rejectGroupMembershipRequests']])(
    '%s validates named requesters too',
    async op => {
      // These take the same participant ids as the five writes above and were missed in the first
      // sweep. whatsapp-web.js feeds them straight to `requesterIds.map(createWid)` (Utils.js), so
      // free text throws there exactly as it did on the participant routes.
      const engineOp = jest.fn();
      const svc = makeService({ [op]: engineOp });

      // Non-async forwarders, so the guard throws synchronously — route it through a promise, as
      // the participant writes above do.
      await expect(
        Promise.resolve().then(() =>
          (svc as unknown as Record<string, (s: string, g: string, p?: string[]) => Promise<unknown>>)[op](
            's1',
            GROUP,
            ['NOT A USER'],
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(engineOp).not.toHaveBeenCalled();
    },
  );

  it.each([['approveGroupMembershipRequests'], ['rejectGroupMembershipRequests']])(
    '%s still accepts an omitted list, which means every pending request',
    async op => {
      const engineOp = jest.fn().mockResolvedValue([]);
      const svc = makeService({ [op]: engineOp });

      await (svc as unknown as Record<string, (s: string, g: string, p?: string[]) => Promise<unknown>>)[op](
        's1',
        GROUP,
        undefined,
      );
      expect(engineOp).toHaveBeenCalledWith(GROUP, undefined);
    },
  );
});

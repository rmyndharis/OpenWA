import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GroupService } from './group.service';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';

describe('GroupService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const sessionService = { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService;
    return new GroupService(sessionService);
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
    await svc.addParticipants('s1', 'g1', ['a@c.us', 'b@c.us']);
    expect(addParticipants).toHaveBeenCalledWith('g1', ['a@c.us', 'b@c.us']);
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
  });
});

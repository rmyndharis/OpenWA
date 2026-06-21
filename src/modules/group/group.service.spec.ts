import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GroupService } from './group.service';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

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
});

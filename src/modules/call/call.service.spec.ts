import { BadRequestException } from '@nestjs/common';
import { CallService } from './call.service';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';

describe('CallService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const sessionService = { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService;
    return new CallService(sessionService);
  };

  it('throws 400 "Session is not started" when the engine is missing (guard preserved)', () => {
    // The guard throws synchronously; the controller method is `async`, so this still surfaces
    // as a rejected promise -> 400 at the HTTP layer (same shape as GroupService).
    const svc = makeService(undefined);
    expect(() => svc.rejectCall('s1', 'CALL1')).toThrow(BadRequestException);
    expect(() => svc.rejectCall('s1', 'CALL1')).toThrow('Session is not started');
  });

  it('delegates rejectCall to the engine when the session is started', async () => {
    const rejectCall = jest.fn().mockResolvedValue(undefined);
    const svc = makeService({ rejectCall });
    await svc.rejectCall('s1', 'CALL1');
    expect(rejectCall).toHaveBeenCalledWith('CALL1');
  });

  it('propagates the engine not-found error (unknown/expired call id -> 404)', async () => {
    const rejectCall = jest.fn().mockRejectedValue(new CallNotFoundError('CALL1'));
    const svc = makeService({ rejectCall });
    await expect(svc.rejectCall('s1', 'CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
  });
});

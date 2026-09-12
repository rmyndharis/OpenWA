import { ForbiddenException } from '@nestjs/common';
import { RemoteOpenWaQueuesController } from './remote-openwa-queues.controller';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

describe('RemoteOpenWaQueuesController', () => {
  it('forbids operator keys', async () => {
    const auth = {
      canAccessOpenWaRemoteQueues: jest.fn().mockReturnValue(false),
    };
    const queues = { getStatus: jest.fn() };
    const ctrl = new RemoteOpenWaQueuesController(queues as never, auth as never);
    await expect(
      ctrl.getStatus({ role: ApiKeyRole.OPERATOR } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queues.getStatus).not.toHaveBeenCalled();
  });

  it('returns status for companion_operator', async () => {
    const auth = { canAccessOpenWaRemoteQueues: jest.fn().mockReturnValue(true) };
    const payload = { configured: true, source: 'bull-board', queues: [] };
    const queues = { getStatus: jest.fn().mockResolvedValue(payload) };
    const ctrl = new RemoteOpenWaQueuesController(queues as never, auth as never);
    await expect(
      ctrl.getStatus({ role: ApiKeyRole.COMPANION_OPERATOR } as never),
    ).resolves.toEqual(payload);
  });
});

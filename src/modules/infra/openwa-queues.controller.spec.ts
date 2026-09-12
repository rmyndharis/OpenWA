import { ForbiddenException } from '@nestjs/common';
import { OpenWaQueuesController } from './openwa-queues.controller';

describe('OpenWaQueuesController', () => {
  it('forbids keys without queues access', async () => {
    const auth = { canAccessOpenWaQueues: jest.fn().mockReturnValue(false) };
    const queues = { getStatus: jest.fn() };
    const ctrl = new OpenWaQueuesController(queues as never, auth as never);
    await expect(ctrl.getStatus({ role: 'viewer' } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(queues.getStatus).not.toHaveBeenCalled();
  });

  it('returns local status for allowed roles', async () => {
    const auth = { canAccessOpenWaQueues: jest.fn().mockReturnValue(true) };
    const payload = { configured: true, source: 'local', queues: [] };
    const queues = { getStatus: jest.fn().mockResolvedValue(payload) };
    const ctrl = new OpenWaQueuesController(queues as never, auth as never);
    await expect(ctrl.getStatus({ role: 'companion_operator' } as never)).resolves.toEqual(payload);
  });
});

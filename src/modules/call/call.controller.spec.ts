import { BadRequestException } from '@nestjs/common';
import { CallController } from './call.controller';
import { CallService } from './call.service';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';

describe('CallController', () => {
  const build = (service: Partial<Record<keyof CallService, jest.Mock>>) => {
    const controller = new CallController(service as unknown as CallService);
    return { controller, service };
  };

  it('POST :callId/reject returns the success envelope', async () => {
    const { controller, service } = build({ rejectCall: jest.fn().mockResolvedValue(undefined) });
    await expect(controller.reject('s1', 'CALL1')).resolves.toEqual({ success: true });
    expect(service.rejectCall).toHaveBeenCalledWith('s1', 'CALL1');
  });

  it('propagates a service rejection (session not started -> 400)', async () => {
    const { controller } = build({
      rejectCall: jest.fn().mockRejectedValue(new BadRequestException('Session is not started')),
    });
    await expect(controller.reject('s1', 'CALL1')).rejects.toThrow(BadRequestException);
  });

  it('propagates a service rejection (unknown/expired call id -> 404)', async () => {
    const { controller } = build({
      rejectCall: jest.fn().mockRejectedValue(new CallNotFoundError('CALL1')),
    });
    await expect(controller.reject('s1', 'CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
  });
});

import { BadRequestException } from '@nestjs/common';
import { CallController } from './call.controller';
import { CallService } from './call.service';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

describe('CallController', () => {
  const build = (service: Partial<Record<keyof CallService, jest.Mock>>) => {
    const controller = new CallController(service as unknown as CallService);
    return { controller, service };
  };

  it('POST link returns the generated link', async () => {
    const { controller, service } = build({
      createCallLink: jest.fn().mockResolvedValue('https://call.whatsapp.com/video/TOKEN'),
    });
    await expect(controller.createLink('s1', { type: 'video', startTime: 1_800_000_000_000 })).resolves.toEqual({
      link: 'https://call.whatsapp.com/video/TOKEN',
    });
    expect(service.createCallLink).toHaveBeenCalledWith('s1', 'video', 1_800_000_000_000);
  });

  // A refusal must reach the caller as a refusal. Returning `{ link: '' }` would be a 200 carrying
  // nothing, which reads as success and hands the caller a link that does not exist.
  it('propagates a WhatsApp-side refusal rather than answering with an empty link', async () => {
    const { controller } = build({
      createCallLink: jest.fn().mockRejectedValue(new EngineRefusedError('WhatsApp did not return a call link')),
    });
    await expect(controller.createLink('s1', { type: 'audio', startTime: 1_800_000_000_000 })).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

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

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChannelService } from './channel.service';
import { SessionService } from '../session/session.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

describe('ChannelService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const sessionService = { getEngine: jest.fn().mockReturnValue(engine) } as unknown as SessionService;
    return new ChannelService(sessionService);
  };

  it('throws 400 when the session is not started', () => {
    expect(() => makeService(undefined).getSubscribedChannels('s1')).toThrow(BadRequestException);
  });

  it('maps a missing channel to 404', async () => {
    const svc = makeService({ getChannelById: jest.fn().mockResolvedValue(null) });
    await expect(svc.getChannelById('s1', 'ch404')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('forwards an optional message limit to the engine', async () => {
    const getChannelMessages = jest.fn().mockResolvedValue([]);
    await makeService({ getChannelMessages }).getChannelMessages('s1', 'ch1', 25);
    expect(getChannelMessages).toHaveBeenCalledWith('ch1', 25);
  });
});

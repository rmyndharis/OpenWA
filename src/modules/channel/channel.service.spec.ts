import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChannelService } from './channel.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

describe('ChannelService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined) => {
    const engines = new EngineRegistry();
    if (engine) engines.set('s1', engine as IWhatsAppEngine);
    return new ChannelService(engines);
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

  // The wwjs engine treats a limit < 1 as "no limit" (fail-open): the service clamps the window
  // the same way MessageService.getChatHistory does, so no caller can pull an unbounded history.
  it.each([
    [undefined, 50],
    [NaN, 50],
    [Number.POSITIVE_INFINITY, 50],
    [0, 1],
    [-10, 1],
    [1, 1],
    [100, 100],
    [101, 100],
    [10 ** 9, 100],
    [30.7, 30],
  ])('clamps limit %s to %i before calling the engine', async (input, expected) => {
    const getChannelMessages = jest.fn().mockResolvedValue([]);
    await makeService({ getChannelMessages }).getChannelMessages('s1', 'ch1', input);
    expect(getChannelMessages).toHaveBeenCalledWith('ch1', expected);
  });
});

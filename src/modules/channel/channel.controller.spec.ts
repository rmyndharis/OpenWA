import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';

describe('ChannelController.getMessages limit parsing', () => {
  const build = () => {
    const service = { getChannelMessages: jest.fn().mockResolvedValue([]) };
    const controller = new ChannelController(service as unknown as ChannelService);
    return { controller, service };
  };

  it('falls back to the engine default (undefined) when ?limit is not numeric — never forwards NaN', async () => {
    const { controller, service } = build();
    await controller.getMessages('s1', 'ch1@newsletter', 'abc');
    expect(service.getChannelMessages).toHaveBeenCalledWith('s1', 'ch1@newsletter', undefined);
  });

  it('forwards a valid numeric limit unchanged', async () => {
    const { controller, service } = build();
    await controller.getMessages('s1', 'ch1@newsletter', '25');
    expect(service.getChannelMessages).toHaveBeenCalledWith('s1', 'ch1@newsletter', 25);
  });

  it('forwards undefined when ?limit is omitted (engine default)', async () => {
    const { controller, service } = build();
    await controller.getMessages('s1', 'ch1@newsletter', undefined);
    expect(service.getChannelMessages).toHaveBeenCalledWith('s1', 'ch1@newsletter', undefined);
  });
});

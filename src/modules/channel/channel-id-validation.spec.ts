import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { ChannelService } from './channel.service';

describe('ChannelService channelId validation across channel actions', () => {
  it('rejects non-newsletter JIDs on demoteChannelAdmin and transferChannelOwnership before calling the engine', async () => {
    const engine = {
      demoteChannelAdmin: jest.fn().mockResolvedValue(undefined),
      transferChannelOwnership: jest.fn().mockResolvedValue(undefined),
    };
    const engines = {
      require: jest.fn().mockReturnValue(engine),
    };
    const service = new ChannelService(engines as never);

    await expect(async () =>
      service.demoteChannelAdmin('s1', '120363000000000001@g.us', '628123456789@c.us'),
    ).rejects.toThrow(ChannelNotFoundError);
    await expect(async () =>
      service.transferChannelOwnership('s1', '120363000000000001@g.us', '628123456789@c.us'),
    ).rejects.toThrow(ChannelNotFoundError);

    expect(engine.demoteChannelAdmin).not.toHaveBeenCalled();
    expect(engine.transferChannelOwnership).not.toHaveBeenCalled();
  });

  it('rejects empty-local-part @newsletter and multi-@ newsletter JIDs across channel mutation routes', async () => {
    const engine = {
      deleteChannel: jest.fn().mockResolvedValue(undefined),
      muteChannel: jest.fn().mockResolvedValue(undefined),
      unsubscribeFromChannel: jest.fn().mockResolvedValue(undefined),
      demoteChannelAdmin: jest.fn().mockResolvedValue(undefined),
      transferChannelOwnership: jest.fn().mockResolvedValue(undefined),
    };
    const engines = {
      require: jest.fn().mockReturnValue(engine),
    };
    const service = new ChannelService(engines as never);

    for (const invalidChannelId of ['@newsletter', '   @newsletter', ':5@newsletter', '628123456789@c.us@newsletter']) {
      await expect(async () => service.deleteChannel('s1', invalidChannelId)).rejects.toThrow(ChannelNotFoundError);
      await expect(async () => service.muteChannel('s1', invalidChannelId, true)).rejects.toThrow(ChannelNotFoundError);
      await expect(async () => service.unsubscribeFromChannel('s1', invalidChannelId)).rejects.toThrow(
        ChannelNotFoundError,
      );
      await expect(async () => service.demoteChannelAdmin('s1', invalidChannelId, '628123456789@c.us')).rejects.toThrow(
        ChannelNotFoundError,
      );
      await expect(async () =>
        service.transferChannelOwnership('s1', invalidChannelId, '628123456789@c.us'),
      ).rejects.toThrow(ChannelNotFoundError);
    }

    expect(engine.deleteChannel).not.toHaveBeenCalled();
    expect(engine.muteChannel).not.toHaveBeenCalled();
    expect(engine.unsubscribeFromChannel).not.toHaveBeenCalled();
    expect(engine.demoteChannelAdmin).not.toHaveBeenCalled();
    expect(engine.transferChannelOwnership).not.toHaveBeenCalled();
  });
});

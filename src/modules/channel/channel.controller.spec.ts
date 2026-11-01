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

describe('ChannelController.demoteAdmin', () => {
  it('forwards the path params and the body field in the right order', async () => {
    // The argument order is the whole risk here: sessionId, channelId and userId are all strings,
    // so a swap compiles, type-checks and would demote the wrong party in the wrong channel.
    const service = { demoteChannelAdmin: jest.fn().mockResolvedValue(undefined) };
    const controller = new ChannelController(service as unknown as ChannelService);
    await expect(controller.demoteAdmin('s1', 'ch1@newsletter', { userId: '628@c.us' })).resolves.toEqual({
      success: true,
    });
    expect(service.demoteChannelAdmin).toHaveBeenCalledWith('s1', 'ch1@newsletter', '628@c.us');
  });

  it('lets an engine refusal propagate instead of answering success', async () => {
    const service = { demoteChannelAdmin: jest.fn().mockRejectedValue(new Error('refused')) };
    const controller = new ChannelController(service as unknown as ChannelService);
    await expect(controller.demoteAdmin('s1', 'ch1@newsletter', { userId: '628@c.us' })).rejects.toThrow('refused');
  });
});

describe('ChannelController.transferOwnership', () => {
  it('forwards the path params and the body field in the right order', async () => {
    // sessionId, channelId and newOwnerId are all strings, so a swap compiles and type-checks —
    // and this operation is irreversible, which makes the wrong target unrecoverable.
    const service = { transferChannelOwnership: jest.fn().mockResolvedValue(undefined) };
    const controller = new ChannelController(service as unknown as ChannelService);
    await expect(controller.transferOwnership('s1', 'ch1@newsletter', { newOwnerId: '628@c.us' })).resolves.toEqual({
      success: true,
    });
    expect(service.transferChannelOwnership).toHaveBeenCalledWith('s1', 'ch1@newsletter', '628@c.us');
  });

  it('lets an engine refusal propagate instead of answering success', async () => {
    const service = { transferChannelOwnership: jest.fn().mockRejectedValue(new Error('refused')) };
    const controller = new ChannelController(service as unknown as ChannelService);
    await expect(controller.transferOwnership('s1', 'ch1@newsletter', { newOwnerId: '628@c.us' })).rejects.toThrow(
      'refused',
    );
  });
});

describe('ChannelController OpenAPI 400 responses', () => {
  // Every route resolves the engine through EngineRegistry.require, whose 400 is "Session is not
  // started"; a session that is started but not ready answers 409 instead.
  const described400 = (route: keyof ChannelController): string | undefined =>
    (
      Reflect.getMetadata(
        'swagger/apiResponse',
        Object.getOwnPropertyDescriptor(ChannelController.prototype, route)?.value as object,
      ) as Record<string, { description?: string }>
    )['400']?.description;

  it.each(['findAll', 'findOne', 'getMessages', 'remove', 'unsubscribe'] as const)(
    '%s declares the not-started 400',
    route => {
      expect(described400(route)).toBe('Session not started');
    },
  );

  it.each(['create', 'mute', 'demoteAdmin', 'transferOwnership', 'subscribe'] as const)(
    '%s declares the not-started or validation 400',
    route => {
      expect(described400(route)).toBe('Session not started, or validation failed');
    },
  );
});

describe('ChannelController OpenAPI 404 on the routes that refuse a non-channel id up front', () => {
  // These routes refuse only an id that is not a channel id; none looks the channel up, so the
  // subscribed-list "not synced yet" wording would invite a retry that cannot succeed.
  it.each(['remove', 'unsubscribe', 'demoteAdmin', 'transferOwnership'] as const)(
    '%s describes the 404 as a malformed channel id',
    route => {
      const responses = Reflect.getMetadata(
        'swagger/apiResponse',
        Object.getOwnPropertyDescriptor(ChannelController.prototype, route)?.value as object,
      ) as Record<string, { description?: string }>;
      expect(responses['404']?.description).toContain('@newsletter');
      expect(responses['404']?.description).not.toContain('synced');
    },
  );
});

describe('ChannelController OpenAPI 503 responses', () => {
  const responsesOf = (name: string): Record<string, { description?: string }> =>
    (Reflect.getMetadata(
      'swagger/apiResponse',
      Object.getOwnPropertyDescriptor(ChannelController.prototype, name)!.value as object,
    ) ?? {}) as Record<string, { description?: string }>;

  // Baileys answers 503 for WhatsApp's own rate limit (429) as well as for an unanswered query.
  it('names the WhatsApp rate limit on every 503 it declares', () => {
    const silent = Object.getOwnPropertyNames(ChannelController.prototype).filter(name => {
      const description = responsesOf(name)['503']?.description;
      return description !== undefined && !description.includes('429');
    });
    expect(silent).toEqual([]);
  });

  it('declares the rate-limited 503 on channel creation', () => {
    expect(responsesOf('create')['503']?.description).toContain('429');
  });

  it('does not describe the lookup 503 as a change that may have applied', () => {
    expect(responsesOf('findOne')['503']?.description).not.toContain('applied');
  });
});

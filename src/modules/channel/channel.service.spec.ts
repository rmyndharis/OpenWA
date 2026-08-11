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

  it('demoteChannelAdmin forwards the channel and user to the engine, dropping the sessionId', async () => {
    const demoteChannelAdmin = jest.fn().mockResolvedValue(undefined);
    await makeService({ demoteChannelAdmin }).demoteChannelAdmin('s1', 'ch1@newsletter', '628123456789@c.us');
    expect(demoteChannelAdmin).toHaveBeenCalledWith('ch1@newsletter', '628123456789@c.us');
  });

  it('demoteChannelAdmin throws 400 when the session is not started', () => {
    expect(() => makeService(undefined).demoteChannelAdmin('s1', 'ch1@newsletter', '628123456789@c.us')).toThrow(
      BadRequestException,
    );
  });

  it('transferChannelOwnership forwards the channel and new owner, dropping the sessionId', async () => {
    const transferChannelOwnership = jest.fn().mockResolvedValue(undefined);
    await makeService({ transferChannelOwnership }).transferChannelOwnership(
      's1',
      'ch1@newsletter',
      '628123456789@c.us',
    );
    expect(transferChannelOwnership).toHaveBeenCalledWith('ch1@newsletter', '628123456789@c.us');
  });

  it('transferChannelOwnership throws 400 when the session is not started', () => {
    expect(() => makeService(undefined).transferChannelOwnership('s1', 'ch1@newsletter', '628123456789@c.us')).toThrow(
      BadRequestException,
    );
  });

  // Both DTOs accept any non-empty string, and toEngineJid passes anything it cannot classify
  // through verbatim — so an unaddressable id reached the socket and failed opaquely. The group
  // participant writes reject the same input with a naming 400; these two are the routes that
  // shipped without it.
  it.each([
    ['free text', 'NOT A USER'],
    ['a bare @c.us with no user part', '@c.us'],
    ['a number too short to be a WhatsApp id', '123'],
    ['a group id', '120363@g.us'],
    ['a channel id', 'ch2@newsletter'],
  ])('demoteChannelAdmin rejects %s with 400 instead of forwarding it', (_label, userId) => {
    const demoteChannelAdmin = jest.fn();
    expect(() => makeService({ demoteChannelAdmin }).demoteChannelAdmin('s1', 'ch1@newsletter', userId)).toThrow(
      BadRequestException,
    );
    expect(demoteChannelAdmin).not.toHaveBeenCalled();
  });

  it('transferChannelOwnership rejects an unaddressable new owner with 400', () => {
    const transferChannelOwnership = jest.fn();
    expect(() =>
      makeService({ transferChannelOwnership }).transferChannelOwnership('s1', 'ch1@newsletter', 'NOT A USER'),
    ).toThrow(BadRequestException);
    expect(transferChannelOwnership).not.toHaveBeenCalled();
  });

  // A bare number is the shape the group routes accept and qualify; accepting it here and then
  // handing it over unqualified would just move the opaque failure one layer down.
  it.each([['demoteChannelAdmin' as const], ['transferChannelOwnership' as const]])(
    '%s qualifies a bare phone number before the engine sees it',
    async method => {
      const engineMethod = jest.fn().mockResolvedValue(undefined);
      await makeService({ [method]: engineMethod })[method]('s1', 'ch1@newsletter', '628123456789');
      expect(engineMethod).toHaveBeenCalledWith('ch1@newsletter', '628123456789@c.us');
    },
  );
});

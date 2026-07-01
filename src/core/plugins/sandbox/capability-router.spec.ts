import { dispatchCapabilityVerb, CapabilityContext } from './capability-router';

function makeContext() {
  return {
    messages: {
      sendText: jest.fn().mockResolvedValue({ messageId: 'm1' }),
      reply: jest.fn().mockResolvedValue({ messageId: 'm2' }),
    },
    engine: {
      getGroupInfo: jest.fn().mockResolvedValue({ id: 'g' }),
      getContacts: jest.fn().mockResolvedValue([]),
      getContactById: jest.fn().mockResolvedValue(null),
      checkNumberExists: jest.fn().mockResolvedValue(true),
      getChats: jest.fn().mockResolvedValue([]),
    },
    storage: {
      get: jest.fn().mockResolvedValue('v'),
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([]),
    },
    net: {
      fetch: jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', headers: {}, body: 'x' }),
    },
    conversations: {
      send: jest.fn().mockResolvedValue({ id: 'm3' }),
    },
  };
}

describe('dispatchCapabilityVerb', () => {
  it('routes messages.sendText to the context with positional args', async () => {
    const ctx = makeContext();
    const out = await dispatchCapabilityVerb(ctx, 'messages.sendText', ['s', 'c', 'hi']);
    expect(ctx.messages.sendText).toHaveBeenCalledWith('s', 'c', 'hi');
    expect(out).toEqual({ messageId: 'm1' });
  });

  it('routes messages.reply', async () => {
    const ctx = makeContext();
    await dispatchCapabilityVerb(ctx, 'messages.reply', ['s', 'c', 'q', 'hi']);
    expect(ctx.messages.reply).toHaveBeenCalledWith('s', 'c', 'q', 'hi');
  });

  it('routes engine.getGroupInfo', async () => {
    const ctx = makeContext();
    await dispatchCapabilityVerb(ctx, 'engine.getGroupInfo', ['s', 'g']);
    expect(ctx.engine.getGroupInfo).toHaveBeenCalledWith('s', 'g');
  });

  it('routes storage.get and returns its value', async () => {
    const ctx = makeContext();
    const out = await dispatchCapabilityVerb(ctx, 'storage.get', ['k']);
    expect(ctx.storage.get).toHaveBeenCalledWith('k');
    expect(out).toBe('v');
  });

  it('routes net.fetch with the url + init and returns the serialized response', async () => {
    const ctx = makeContext();
    const init = { method: 'POST', body: '{}' };
    const out = await dispatchCapabilityVerb(ctx, 'net.fetch', ['https://api.example.com/t', init]);
    expect(ctx.net.fetch).toHaveBeenCalledWith('https://api.example.com/t', init);
    expect(out).toMatchObject({ ok: true, status: 200, body: 'x' });
  });

  it('rejects an unknown verb — only allowlisted capabilities are reachable', async () => {
    const ctx = makeContext();
    await expect(dispatchCapabilityVerb(ctx as unknown as CapabilityContext, 'process.exit', [0])).rejects.toThrow(
      /unknown capability verb/i,
    );
    await expect(
      dispatchCapabilityVerb(ctx as unknown as CapabilityContext, 'storage.constructor', []),
    ).rejects.toThrow(/unknown capability verb/i);
  });
});

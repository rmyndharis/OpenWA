import { buildConversationSendFacade } from './conversation-send-facade';
import { PluginCapabilityError } from './plugin.interfaces';

describe('conversation.send facade', () => {
  const manifest = (perms: string[]) => ({ id: 'chatwoot', permissions: perms, sessions: ['*'] });

  it('throws PluginCapabilityError when sessionId is missing', async () => {
    const facade = buildConversationSendFacade({
      manifest: manifest(['conversation:send']) as never,
      assertPermission: () => undefined,
      assertSessionActive: jest.fn(),
      resolveChatId: () => Promise.resolve('chat@c.us'),
      runGuarded: (_events: string[], run: () => Promise<unknown>) => run(),
      sendText: jest.fn(),
      reply: jest.fn(),
    } as never);
    await expect(facade.send({ type: 'text', text: 'x', chatId: 'c' })).rejects.toThrow(PluginCapabilityError);
  });

  it('throws PluginCapabilityError when conversation:send is not granted', async () => {
    const facade = buildConversationSendFacade({
      manifest: manifest([]) as never,
      assertPermission: (m: { permissions: string[] }, p: string) => {
        if (!m.permissions.includes(p)) throw new Error(`missing ${p}`);
      },
      assertSessionActive: () => undefined,
      resolveChatId: () => Promise.resolve('chat@c.us'),
      runGuarded: (_events: string[], run: () => Promise<unknown>) => run(),
      sendText: jest.fn(),
      reply: jest.fn(),
    } as never);
    await expect(facade.send({ type: 'text', text: 'x', sessionId: 's', chatId: 'c' })).rejects.toThrow(
      /conversation:send/,
    );
  });

  it('resolves chatId from the mapping when the envelope omits it, then sends text', async () => {
    const sendText = jest.fn().mockResolvedValue({ id: 'm1' });
    const resolveChatId = jest.fn().mockResolvedValue('chat@c.us');
    const runGuarded = jest.fn((_events: string[], run: () => Promise<unknown>) => run());
    const facade = buildConversationSendFacade({
      manifest: manifest(['conversation:send']) as never,
      assertPermission: () => undefined,
      assertSessionActive: jest.fn(),
      resolveChatId,
      runGuarded,
      sendText,
      reply: jest.fn(),
    } as never);
    const res = await facade.send({
      type: 'text',
      text: 'hi',
      sessionId: 's',
      source: { provider: 'chatwoot', externalConversationId: '42' },
    });
    expect(resolveChatId).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('s', { chatId: 'chat@c.us', text: 'hi' });
    // re-entrancy guard must wrap the downstream send so the adapter's own message:* hook is short-circuited
    expect(runGuarded).toHaveBeenCalled();
    expect(res).toEqual({ id: 'm1' });
  });

  it('routes a media envelope to sendMedia with the caption from text, not sendText', async () => {
    const sendMedia = jest.fn().mockResolvedValue({ id: 'm2' });
    const sendText = jest.fn();
    const facade = buildConversationSendFacade({
      manifest: manifest(['conversation:send']) as never,
      assertPermission: () => undefined,
      assertSessionActive: jest.fn(),
      resolveChatId: () => Promise.resolve('chat@c.us'),
      runGuarded: (_events: string[], run: () => Promise<unknown>) => run(),
      sendText,
      reply: jest.fn(),
      sendMedia,
    } as never);
    const res = await facade.send({
      type: 'image',
      mediaUrl: 'https://cdn.example/x.jpg',
      text: 'a caption',
      sessionId: 's',
      chatId: 'chat@c.us',
    });
    expect(sendMedia).toHaveBeenCalledWith('s', {
      chatId: 'chat@c.us',
      url: 'https://cdn.example/x.jpg',
      type: 'image',
      caption: 'a caption',
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(res).toEqual({ id: 'm2' });
  });

  it('routes a voice envelope to sendMedia with type voice (loader maps it to a PTT audio send)', async () => {
    const sendMedia = jest.fn().mockResolvedValue({ id: 'v1' });
    const facade = buildConversationSendFacade({
      manifest: manifest(['conversation:send']) as never,
      assertPermission: () => undefined,
      assertSessionActive: jest.fn(),
      resolveChatId: () => Promise.resolve('chat@c.us'),
      runGuarded: (_events: string[], run: () => Promise<unknown>) => run(),
      sendText: jest.fn(),
      reply: jest.fn(),
      sendMedia,
    } as never);
    await facade.send({ type: 'voice', mediaUrl: 'https://cdn.example/n.ogg', sessionId: 's', chatId: 'chat@c.us' });
    expect(sendMedia).toHaveBeenCalledWith('s', {
      chatId: 'chat@c.us',
      url: 'https://cdn.example/n.ogg',
      type: 'voice',
      caption: undefined,
    });
  });

  it('rejects replyTo on a media envelope — media-reply is unsupported by the engine', async () => {
    const sendMedia = jest.fn();
    const facade = buildConversationSendFacade({
      manifest: manifest(['conversation:send']) as never,
      assertPermission: () => undefined,
      assertSessionActive: jest.fn(),
      resolveChatId: () => Promise.resolve('chat@c.us'),
      runGuarded: (_events: string[], run: () => Promise<unknown>) => run(),
      sendText: jest.fn(),
      reply: jest.fn(),
      sendMedia,
    } as never);
    await expect(
      facade.send({ type: 'image', mediaUrl: 'https://cdn.example/x.jpg', replyTo: 'Q1', sessionId: 's', chatId: 'c' }),
    ).rejects.toThrow(PluginCapabilityError);
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it('falls back to a text send when a media type carries no mediaUrl (URL-in-text fallback)', async () => {
    const sendMedia = jest.fn();
    const sendText = jest.fn().mockResolvedValue({ id: 't1' });
    const facade = buildConversationSendFacade({
      manifest: manifest(['conversation:send']) as never,
      assertPermission: () => undefined,
      assertSessionActive: jest.fn(),
      resolveChatId: () => Promise.resolve('chat@c.us'),
      runGuarded: (_events: string[], run: () => Promise<unknown>) => run(),
      sendText,
      reply: jest.fn(),
      sendMedia,
    } as never);
    const res = await facade.send({ type: 'video', text: 'https://cdn.example/v.mp4', sessionId: 's', chatId: 'c' });
    expect(sendMedia).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('s', { chatId: 'c', text: 'https://cdn.example/v.mp4' });
    expect(res).toEqual({ id: 't1' });
  });
});

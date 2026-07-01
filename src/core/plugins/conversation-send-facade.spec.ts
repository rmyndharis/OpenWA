import { buildConversationSendFacade } from './conversation-send-facade';

describe('conversation.send facade', () => {
  const manifest = (perms: string[]) => ({ id: 'chatwoot', permissions: perms, sessions: ['*'] });

  it('throws PluginCapabilityError when conversation:send is not granted', async () => {
    const facade = buildConversationSendFacade({
      manifest: manifest([]) as never,
      assertPermission: (m: { permissions: string[] }, p: string) => {
        if (!m.permissions.includes(p)) throw new Error(`missing ${p}`);
      },
      assertSessionAllowed: () => undefined,
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
      assertSessionAllowed: jest.fn(),
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
});

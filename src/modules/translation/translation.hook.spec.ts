import { TranslationHook } from './translation.hook';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';

describe('TranslationHook', () => {
  function setup(handleImpl: jest.Mock) {
    type Handler = (ctx: unknown) => Promise<unknown>;
    const register = jest.fn<string, [string, string, Handler, number]>();
    const hookManager = { register };
    const coordinator = { handleMessage: handleImpl };
    const hook = new TranslationHook(hookManager as never, coordinator as never);
    hook.onModuleInit();
    const handler = register.mock.calls[0][2];
    return { hook, handler, hookManager };
  }

  const ctx = (data: IncomingMessage) => ({
    event: 'message:received',
    data,
    sessionId: 's',
    timestamp: new Date(),
    source: 'Engine',
  });
  const baseMsg: IncomingMessage = {
    id: 'M1',
    from: 'g@g.us',
    to: 'me',
    chatId: 'g@g.us',
    body: 'hi',
    type: 'chat',
    timestamp: 1,
    fromMe: false,
    isGroup: true,
    author: '111@c.us',
  };

  it('registers a message:received handler on init', () => {
    const { hookManager } = setup(jest.fn().mockResolvedValue({ swallow: false }));
    expect(hookManager.register).toHaveBeenCalledWith(
      'translation',
      'message:received',
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('returns continue:false when the coordinator swallows a command', async () => {
    const { handler } = setup(jest.fn().mockResolvedValue({ swallow: true }));
    await expect(handler(ctx(baseMsg))).resolves.toMatchObject({ continue: false });
  });

  it('returns continue:true on normal messages', async () => {
    const { handler } = setup(jest.fn().mockResolvedValue({ swallow: false }));
    await expect(handler(ctx(baseMsg))).resolves.toMatchObject({ continue: true });
  });

  it('never throws; returns continue:true if the coordinator errors', async () => {
    const { handler } = setup(jest.fn().mockRejectedValue(new Error('boom')));
    await expect(handler(ctx(baseMsg))).resolves.toMatchObject({ continue: true });
  });
});

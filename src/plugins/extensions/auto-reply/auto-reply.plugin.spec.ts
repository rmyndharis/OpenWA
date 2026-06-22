import { AutoReplyPlugin } from './index';
import { PluginContext } from '../../../core/plugins';
import { HookContext, HookEvent, HookHandler } from '../../../core/hooks';
import { IncomingMessage } from '../../../engine/interfaces/whatsapp-engine.interface';

function makeContext(reply: jest.Mock, mockStorage: Record<string, any> = {}): { context: PluginContext; getHandler: () => HookHandler } {
  let captured: HookHandler | undefined;
  const context = {
    pluginId: 'auto-reply',
    registerHook: (_event: HookEvent, handler: HookHandler) => {
      captured = handler;
    },
    messages: { reply, sendText: jest.fn() },
    storage: {
      get: jest.fn().mockImplementation((key: string) => Promise.resolve(mockStorage[key] ?? null)),
      set: jest.fn().mockImplementation((key: string, val: any) => {
        mockStorage[key] = val;
        return Promise.resolve();
      }),
      delete: jest.fn().mockImplementation((key: string) => {
        delete mockStorage[key];
        return Promise.resolve();
      }),
    },
    logger: { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as unknown as PluginContext;
  return { context, getHandler: () => captured as HookHandler };
}

function inbound(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'msg-1',
    from: '628@c.us',
    to: 'me',
    chatId: '628@c.us',
    body: 'ping',
    type: 'text',
    timestamp: 1,
    fromMe: false,
    isGroup: false,
    ...overrides,
  };
}

function ctxFor(data: IncomingMessage): HookContext<IncomingMessage> {
  return { event: 'message:received', data, sessionId: 'sess-1', timestamp: new Date(), source: 'Engine' };
}

describe('AutoReplyPlugin', () => {
  let mockStorage: Record<string, any>;

  beforeEach(() => {
    mockStorage = {
      config: {
        sessions: {
          'sess-1': {
            enabled: true,
            trigger: 'ping',
            greeting: 'Auto-reply: ping',
          },
        },
      },
    };
  });

  it('replies to an inbound direct message and keeps it in history', async () => {
    const reply = jest.fn().mockResolvedValue({ messageId: 'x', timestamp: 1 });
    const { context, getHandler } = makeContext(reply, mockStorage);
    await new AutoReplyPlugin().onEnable(context);

    const result = await getHandler()(ctxFor(inbound()));

    expect(reply).toHaveBeenCalledWith('sess-1', '628@c.us', 'msg-1', 'Auto-reply: ping');
    expect(result).toEqual({ continue: true });
  });

  it('does NOT reply to its own outgoing messages (fromMe)', async () => {
    const reply = jest.fn();
    const { context, getHandler } = makeContext(reply, mockStorage);
    await new AutoReplyPlugin().onEnable(context);

    const result = await getHandler()(ctxFor(inbound({ fromMe: true })));

    expect(reply).not.toHaveBeenCalled();
    expect(result).toEqual({ continue: true });
  });

  it('does NOT reply to group messages', async () => {
    const reply = jest.fn();
    const { context, getHandler } = makeContext(reply, mockStorage);
    await new AutoReplyPlugin().onEnable(context);

    const result = await getHandler()(ctxFor(inbound({ isGroup: true })));

    expect(reply).not.toHaveBeenCalled();
    expect(result).toEqual({ continue: true });
  });

  it('does NOT reply when the message did not originate from the engine', async () => {
    const reply = jest.fn();
    const { context, getHandler } = makeContext(reply, mockStorage);
    await new AutoReplyPlugin().onEnable(context);

    const result = await getHandler()({ ...ctxFor(inbound()), source: 'API' });

    expect(reply).not.toHaveBeenCalled();
    expect(result).toEqual({ continue: true });
  });
});


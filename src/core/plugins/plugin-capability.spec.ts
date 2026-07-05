import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import {
  PluginCapabilityError,
  PluginContext,
  PluginInstance,
  PluginManifest,
  PluginStatus,
  PluginType,
} from './plugin.interfaces';
import { MessageService } from '../../modules/message/message.service';
import { SessionService } from '../../modules/session/session.service';

function makePlugin(
  sessions?: string[],
  permissions: string[] = ['messages:send', 'engine:read'],
  activeSessions?: string[],
  sessionScoped?: boolean,
): PluginInstance {
  const manifest: PluginManifest = {
    id: 'test-ext',
    name: 'Test Extension',
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.ts',
    sessions,
    permissions,
    sessionScoped,
  };
  return { manifest, status: PluginStatus.INSTALLED, config: {}, instance: null, activeSessions };
}

describe('PluginLoaderService capability facade — ctx.messages', () => {
  let loader: PluginLoaderService;
  let messageService: { sendText: jest.Mock; reply: jest.Mock };
  let sessionService: { getEngine: jest.Mock };
  let moduleRef: { get: jest.Mock };

  beforeEach(() => {
    messageService = {
      sendText: jest.fn().mockResolvedValue({ messageId: 'wamid', timestamp: 1 }),
      reply: jest.fn().mockResolvedValue({ messageId: 'wamid', timestamp: 1 }),
    };
    sessionService = { getEngine: jest.fn().mockReturnValue({}) }; // truthy live engine
    moduleRef = {
      get: jest
        .fn()
        .mockImplementation((token: unknown) => (token === SessionService ? sessionService : messageService)),
    };
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue({}),
    } as unknown as PluginStorageService;
    loader = new PluginLoaderService(
      configService,
      new HookManager(),
      pluginStorage,
      moduleRef as unknown as ModuleRef,
    );
  });

  function contextFor(plugin: PluginInstance): PluginContext {
    return (loader as unknown as { createPluginContext: (p: PluginInstance) => PluginContext }).createPluginContext(
      plugin,
    );
  }

  it('messages.sendText delegates to MessageService.sendText with a wrapped dto', async () => {
    const ctx = contextFor(makePlugin(['*']));
    await ctx.messages.sendText('sess-1', '628@c.us', 'hi');
    expect(moduleRef.get).toHaveBeenCalledWith(MessageService, { strict: false });
    expect(messageService.sendText).toHaveBeenCalledWith('sess-1', { chatId: '628@c.us', text: 'hi' });
  });

  it('messages.reply delegates to MessageService.reply', async () => {
    const ctx = contextFor(makePlugin(['*']));
    await ctx.messages.reply('sess-1', '628@c.us', 'quoted-id', 'pong');
    expect(moduleRef.get).toHaveBeenCalledWith(MessageService, { strict: false });
    expect(messageService.reply).toHaveBeenCalledWith('sess-1', {
      chatId: '628@c.us',
      quotedMessageId: 'quoted-id',
      text: 'pong',
    });
  });

  it('allows any session when manifest.sessions is absent (defaults to all)', async () => {
    const ctx = contextFor(makePlugin()); // no sessions field
    await ctx.messages.sendText('any-session', '628@c.us', 'hi');
    expect(messageService.sendText).toHaveBeenCalledWith('any-session', { chatId: '628@c.us', text: 'hi' });
  });

  it('rejects an out-of-scope session BEFORE resolving the service', async () => {
    const ctx = contextFor(makePlugin(['allowed-session']));
    await expect(ctx.messages.sendText('other-session', '628@c.us', 'hi')).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
    expect(moduleRef.get).not.toHaveBeenCalled();
    expect(messageService.sendText).not.toHaveBeenCalled();
  });

  it('denies sendText when the plugin is DEACTIVATED for the session, even if manifest.sessions is ["*"]', async () => {
    // manifest allows all sessions, but the operator activated the plugin only for sess-1 — a capability
    // call to sess-2 must be denied (per-session activation is a real boundary, not just a hook filter).
    const ctx = contextFor(makePlugin(['*'], ['messages:send', 'engine:read'], ['sess-1']));
    await expect(ctx.messages.sendText('sess-2', '628@c.us', 'hi')).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(moduleRef.get).not.toHaveBeenCalled();
    expect(messageService.sendText).not.toHaveBeenCalled();
  });

  it('allows sendText when the plugin IS activated for the session', async () => {
    const ctx = contextFor(makePlugin(['*'], ['messages:send', 'engine:read'], ['sess-1']));
    await ctx.messages.sendText('sess-1', '628@c.us', 'hi');
    expect(messageService.sendText).toHaveBeenCalledWith('sess-1', { chatId: '628@c.us', text: 'hi' });
  });

  it('allows any session when activeSessions is undefined (operator never restricted it)', async () => {
    const ctx = contextFor(makePlugin(['*'], ['messages:send', 'engine:read'], undefined));
    await ctx.messages.sendText('whatever', '628@c.us', 'hi');
    expect(messageService.sendText).toHaveBeenCalledWith('whatever', { chatId: '628@c.us', text: 'hi' });
  });

  it('a global (sessionScoped:false) plugin is allowed on any session regardless of activeSessions', async () => {
    const ctx = contextFor(makePlugin(['*'], ['messages:send', 'engine:read'], [], false));
    await ctx.messages.sendText('sess-9', '628@c.us', 'hi');
    expect(messageService.sendText).toHaveBeenCalledWith('sess-9', { chatId: '628@c.us', text: 'hi' });
  });

  it('rejects sendText with PluginCapabilityError when the session has no active engine', async () => {
    sessionService.getEngine.mockReturnValue(undefined);
    const ctx = contextFor(makePlugin(['*']));
    await expect(ctx.messages.sendText('dead-session', '628@c.us', 'hi')).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(messageService.sendText).not.toHaveBeenCalled();
  });

  it('denies sendText when the plugin does not declare the messages:send permission', async () => {
    const ctx = contextFor(makePlugin(['*'], [])); // no permissions
    await expect(ctx.messages.sendText('sess-1', '628@c.us', 'hi')).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(moduleRef.get).not.toHaveBeenCalled();
    expect(messageService.sendText).not.toHaveBeenCalled();
  });

  it('denies reply when the plugin does not declare the messages:send permission', async () => {
    const ctx = contextFor(makePlugin(['*'], []));
    await expect(ctx.messages.reply('sess-1', '628@c.us', 'q', 'hi')).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(messageService.reply).not.toHaveBeenCalled();
  });
});

describe('PluginLoaderService capability facade — ctx.engine', () => {
  let loader: PluginLoaderService;
  let moduleRef: { get: jest.Mock };

  function build(getEngineReturn: unknown): { sessionService: { getEngine: jest.Mock } } {
    const sessionService = { getEngine: jest.fn().mockReturnValue(getEngineReturn) };
    moduleRef = { get: jest.fn().mockReturnValue(sessionService) };
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue({}),
    } as unknown as PluginStorageService;
    loader = new PluginLoaderService(
      configService,
      new HookManager(),
      pluginStorage,
      moduleRef as unknown as ModuleRef,
    );
    return { sessionService };
  }

  function contextFor(plugin: PluginInstance): PluginContext {
    return (loader as unknown as { createPluginContext: (p: PluginInstance) => PluginContext }).createPluginContext(
      plugin,
    );
  }

  it('engine.getGroupInfo delegates to SessionService.getEngine(id).getGroupInfo', async () => {
    const engine = { getGroupInfo: jest.fn().mockResolvedValue({ id: 'g@g.us' }) };
    const { sessionService } = build(engine);
    const ctx = contextFor(makePlugin(['*']));
    await ctx.engine.getGroupInfo('sess-1', 'g@g.us');
    expect(moduleRef.get).toHaveBeenCalledWith(SessionService, { strict: false });
    expect(sessionService.getEngine).toHaveBeenCalledWith('sess-1');
    expect(engine.getGroupInfo).toHaveBeenCalledWith('g@g.us');
  });

  it('throws PluginCapabilityError when the session has no active engine', async () => {
    build(undefined);
    const ctx = contextFor(makePlugin(['*']));
    await expect(ctx.engine.getContacts('dead-session')).rejects.toBeInstanceOf(PluginCapabilityError);
  });

  it('rejects an out-of-scope session before resolving the engine', async () => {
    const { sessionService } = build({ getChats: jest.fn() });
    const ctx = contextFor(makePlugin(['allowed']));
    await expect(ctx.engine.getChats('other')).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(sessionService.getEngine).not.toHaveBeenCalled();
  });

  it('denies engine.getGroupInfo when the plugin does not declare the engine:read permission', async () => {
    const { sessionService } = build({ getGroupInfo: jest.fn() });
    const ctx = contextFor(makePlugin(['*'], ['messages:send'])); // has messages, lacks engine:read
    await expect(ctx.engine.getGroupInfo('sess-1', 'g@g.us')).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(sessionService.getEngine).not.toHaveBeenCalled();
  });

  it('denies engine reads when the plugin is deactivated for the session (activeSessions excludes it)', async () => {
    const { sessionService } = build({ getGroupInfo: jest.fn() });
    const ctx = contextFor(makePlugin(['*'], ['engine:read'], ['sess-1']));
    await expect(ctx.engine.getGroupInfo('sess-2', 'g@g.us')).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(sessionService.getEngine).not.toHaveBeenCalled();
  });

  it('allows engine.getGroupInfo when the plugin declares engine:read', async () => {
    const engine = { getGroupInfo: jest.fn().mockResolvedValue({ id: 'g@g.us' }) };
    build(engine);
    const ctx = contextFor(makePlugin(['*'], ['engine:read']));
    await ctx.engine.getGroupInfo('sess-1', 'g@g.us');
    expect(engine.getGroupInfo).toHaveBeenCalledWith('g@g.us');
  });

  it('engine.getChatHistory delegates to the engine and clamps the limit to 100', async () => {
    const engine = { getChatHistory: jest.fn().mockResolvedValue([]) };
    build(engine);
    const ctx = contextFor(makePlugin(['*'], ['engine:read']));
    await ctx.engine.getChatHistory('sess-1', 'c@c.us', 500, true);
    expect(engine.getChatHistory).toHaveBeenCalledWith('c@c.us', 100, true); // 500 clamped to 100
  });

  it('engine.getChatHistory defaults the limit and clamps a non-positive value to 1', async () => {
    const engine = { getChatHistory: jest.fn().mockResolvedValue([]) };
    build(engine);
    const ctx = contextFor(makePlugin(['*'], ['engine:read']));
    await ctx.engine.getChatHistory('sess-1', 'c@c.us'); // no limit → default 50, includeMedia → false
    await ctx.engine.getChatHistory('sess-1', 'c@c.us', 0);
    expect(engine.getChatHistory).toHaveBeenNthCalledWith(1, 'c@c.us', 50, false);
    expect(engine.getChatHistory).toHaveBeenNthCalledWith(2, 'c@c.us', 1, false);
  });

  it('denies engine.getChatHistory without the engine:read permission', async () => {
    const { sessionService } = build({ getChatHistory: jest.fn() });
    const ctx = contextFor(makePlugin(['*'], ['messages:send']));
    await expect(ctx.engine.getChatHistory('sess-1', 'c@c.us')).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(sessionService.getEngine).not.toHaveBeenCalled();
  });
});

describe('PluginLoaderService capability facade — ctx.net', () => {
  function loaderWith(): PluginLoaderService {
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const pluginStorage = { createPluginStorage: jest.fn().mockReturnValue({}) } as unknown as PluginStorageService;
    return new PluginLoaderService(configService, new HookManager(), pluginStorage, {
      get: jest.fn(),
    } as unknown as ModuleRef);
  }
  function netPlugin(permissions: string[], allow?: string[]): PluginInstance {
    const manifest: PluginManifest = {
      id: 'net-ext',
      name: 'Net Extension',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      main: 'index.ts',
      permissions,
      net: allow ? { allow } : undefined,
    };
    return { manifest, status: PluginStatus.INSTALLED, config: {}, instance: null };
  }
  function contextFor(loader: PluginLoaderService, plugin: PluginInstance): PluginContext {
    return (loader as unknown as { createPluginContext: (p: PluginInstance) => PluginContext }).createPluginContext(
      plugin,
    );
  }

  it('denies net.fetch when the plugin does not declare net:fetch', async () => {
    const ctx = contextFor(loaderWith(), netPlugin([], ['*']));
    await expect(ctx.net.fetch('https://api.example.com/x')).rejects.toBeInstanceOf(PluginCapabilityError);
  });

  it('denies net.fetch when the host is not in the manifest net.allow list', async () => {
    const ctx = contextFor(loaderWith(), netPlugin(['net:fetch'], ['only.example.com:443']));
    await expect(ctx.net.fetch('https://api.example.com/x')).rejects.toBeInstanceOf(PluginCapabilityError);
  });
});

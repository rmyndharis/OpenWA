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

function makePlugin(sessions?: string[], permissions: string[] = ['messages:send', 'engine:read']): PluginInstance {
  const manifest: PluginManifest = {
    id: 'test-ext',
    name: 'Test Extension',
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.ts',
    sessions,
    permissions,
  };
  return { manifest, status: PluginStatus.INSTALLED, config: {}, instance: null };
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

  it('allows engine.getGroupInfo when the plugin declares engine:read', async () => {
    const engine = { getGroupInfo: jest.fn().mockResolvedValue({ id: 'g@g.us' }) };
    build(engine);
    const ctx = contextFor(makePlugin(['*'], ['engine:read']));
    await ctx.engine.getGroupInfo('sess-1', 'g@g.us');
    expect(engine.getGroupInfo).toHaveBeenCalledWith('g@g.us');
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

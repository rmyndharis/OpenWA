import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { PLUGIN_CONVERSATION_MAPPING_PORT, PLUGIN_MESSAGE_PORT, PLUGIN_SESSION_PORT } from './plugin-host-ports';

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
        .mockImplementation((token: unknown) => (token === PLUGIN_SESSION_PORT ? sessionService : messageService)),
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
    // The capability surface moved to PluginCapabilityContext; the loader holds one. Every assertion
    // below is unchanged — only the reach-in points at the object that owns the surface now.
    return (
      loader as unknown as { capabilities: { createPluginContext: (p: PluginInstance) => PluginContext } }
    ).capabilities.createPluginContext(plugin);
  }

  it('messages.sendText delegates to MessageService.sendText with a wrapped dto', async () => {
    const ctx = contextFor(makePlugin(['*']));
    await ctx.messages.sendText('sess-1', '628@c.us', 'hi');
    expect(moduleRef.get).toHaveBeenCalledWith(PLUGIN_MESSAGE_PORT, { strict: false });
    expect(messageService.sendText).toHaveBeenCalledWith('sess-1', { chatId: '628@c.us', text: 'hi' });
  });

  it('messages.reply delegates to MessageService.reply', async () => {
    const ctx = contextFor(makePlugin(['*']));
    await ctx.messages.reply('sess-1', '628@c.us', 'quoted-id', 'pong');
    expect(moduleRef.get).toHaveBeenCalledWith(PLUGIN_MESSAGE_PORT, { strict: false });
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

  it('the denial names the fix — the permission, the array and the manifest file', async () => {
    // The whole value of this message is that it reaches the operator at the same time as the
    // symptom: a capability is checked when the verb is CALLED, so a denial lands mid-run as a log
    // line detached from the upgrade that caused it. Naming the fault without the fix leaves the
    // operator with "why is this plugin broken"; one template serves all seven permissions, so a
    // trim here silently degrades every one of them.
    // Asserted on the three carriers of the information — which permission, which field, which file —
    // rather than on the sentence. Pinning the whole string would redden on a punctuation edit
    // without being any stricter about what the operator is actually told.
    const ctx = contextFor(makePlugin(['*'], []));
    const error = await ctx.messages.sendText('sess-1', '628@c.us', 'hi').catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain('messages:send'); // the permission that is missing
    expect(message).toContain('permissions'); // the manifest field to add it to
    expect(message).toContain('manifest.json'); // the file that field lives in
  });

  it('docs/19 quotes the same message the code throws', () => {
    // §19.9 reproduces assertPermission verbatim. A quoted string in prose is an UNGATED COPY of a
    // code string: it rots in silence, which is exactly the failure this repo has paid for more than
    // once. The fragments are derived from the source rather than restated here, so the two cannot
    // drift — restating them would just add a third copy to keep in step.
    //
    // EVERY literal in the throw, not just the one naming the fix. Binding the second half alone
    // left the first — the sentence that names the FAULT, and the one an operator greps for — free
    // to be reworded with docs/19 still asserting the old text, which is the exact rot this test
    // exists to prevent. Deriving them from the function body catches a third sentence too, via the
    // count assertion below.
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const source = readFileSync(join(__dirname, 'plugin-capability-context.ts'), 'utf8');
    const docs = readFileSync(join(__dirname, '..', '..', '..', 'docs', '19-plugin-architecture.md'), 'utf8');

    // Start at the signature: the method's own docblock also backticks `permissions` and
    // manifest.json, and must not be mistaken for part of the thrown string.
    const body = source.match(/private assertPermission\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(body).not.toBe(''); // non-vacuous: a rename would otherwise make this pass on nothing

    const fragments = [...body.matchAll(/`[^`]*`/g)].map(m => norm(m[0]));
    // Pins the count: a literal added to the throw has to be documented too, not silently skipped.
    expect(fragments).toHaveLength(2);
    for (const fragment of fragments) {
      expect(norm(docs)).toContain(fragment);
    }
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
    // The capability surface moved to PluginCapabilityContext; the loader holds one. Every assertion
    // below is unchanged — only the reach-in points at the object that owns the surface now.
    return (
      loader as unknown as { capabilities: { createPluginContext: (p: PluginInstance) => PluginContext } }
    ).capabilities.createPluginContext(plugin);
  }

  it('engine.getGroupInfo delegates to SessionService.getEngine(id).getGroupInfo', async () => {
    const engine = { getGroupInfo: jest.fn().mockResolvedValue({ id: 'g@g.us' }) };
    const { sessionService } = build(engine);
    const ctx = contextFor(makePlugin(['*']));
    await ctx.engine.getGroupInfo('sess-1', 'g@g.us');
    expect(moduleRef.get).toHaveBeenCalledWith(PLUGIN_SESSION_PORT, { strict: false });
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

  // A sandboxed caller's args cross structured clone unvalidated; NaN would reach the engine as "no limit".
  it.each([['x'], [NaN], [{}], [Infinity]])(
    'engine.getChatHistory defaults a non-finite limit (%p) to 50',
    async limit => {
      const engine = { getChatHistory: jest.fn().mockResolvedValue([]) };
      build(engine);
      const ctx = contextFor(makePlugin(['*'], ['engine:read']));
      await ctx.engine.getChatHistory('sess-1', 'c@c.us', limit as number);
      expect(engine.getChatHistory).toHaveBeenCalledWith('c@c.us', 50, false);
    },
  );

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
    // The capability surface moved to PluginCapabilityContext; the loader holds one. Every assertion
    // below is unchanged — only the reach-in points at the object that owns the surface now.
    return (
      loader as unknown as { capabilities: { createPluginContext: (p: PluginInstance) => PluginContext } }
    ).capabilities.createPluginContext(plugin);
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

describe('PluginLoaderService capability facade — ctx.conversations', () => {
  let loader: PluginLoaderService;
  let mappingService: {
    getByProvider: jest.Mock;
    get: jest.Mock;
    setHandover: jest.Mock;
    effectiveHandover: jest.Mock;
  };
  let messageService: { sendText: jest.Mock; reply: jest.Mock };

  beforeEach(() => {
    mappingService = {
      getByProvider: jest.fn(),
      get: jest.fn(),
      setHandover: jest.fn(),
      effectiveHandover: jest.fn(),
    };
    messageService = {
      sendText: jest.fn().mockResolvedValue({ messageId: 'wamid', timestamp: 1 }),
      reply: jest.fn().mockResolvedValue({ messageId: 'wamid', timestamp: 1 }),
    };
    const moduleRef = {
      get: jest
        .fn()
        .mockImplementation((token: unknown) =>
          token === PLUGIN_CONVERSATION_MAPPING_PORT ? mappingService : messageService,
        ),
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
    // The capability surface moved to PluginCapabilityContext; the loader holds one. Every assertion
    // below is unchanged — only the reach-in points at the object that owns the surface now.
    return (
      loader as unknown as { capabilities: { createPluginContext: (p: PluginInstance) => PluginContext } }
    ).capabilities.createPluginContext(plugin);
  }

  const sendEnv = {
    type: 'text' as const,
    text: 'hi',
    instanceId: 'inst-1',
    source: { provider: 'chatwoot', externalConversationId: 'conv-42' },
  };
  const mapping = (sessionId: string) => ({
    id: 'm-1',
    sessionId,
    chatId: '628@c.us',
    pluginId: 'test-ext',
    instanceId: 'inst-1',
    providerConversationId: 'conv-42',
  });

  it('resolves chatId from a mapping on the SAME session as the envelope, then sends', async () => {
    mappingService.getByProvider.mockResolvedValue(mapping('sess-1'));
    const ctx = contextFor(makePlugin(['*'], ['conversation:send']));
    await ctx.conversations.send({ ...sendEnv, sessionId: 'sess-1' });
    expect(mappingService.getByProvider).toHaveBeenCalledWith('test-ext', 'inst-1', 'conv-42');
    expect(messageService.sendText).toHaveBeenCalledWith('sess-1', { chatId: '628@c.us', text: 'hi' });
  });

  it('rejects a mapping owned by ANOTHER session and never sends (wrong-session send)', async () => {
    // The plugin is activated for BOTH sessions, so the per-session activation gate passes — only the
    // mapping's own sessionId stops a stale mapping (e.g. left over after a scope move) from routing
    // sess-1's envelope out through sess-2's chat.
    mappingService.getByProvider.mockResolvedValue(mapping('sess-2'));
    const ctx = contextFor(makePlugin(['*'], ['conversation:send'], ['sess-1', 'sess-2']));
    await expect(ctx.conversations.send({ ...sendEnv, sessionId: 'sess-1' })).rejects.toThrow(
      /belongs to session sess-2, not sess-1/,
    );
    expect(messageService.sendText).not.toHaveBeenCalled();
    expect(messageService.reply).not.toHaveBeenCalled();
  });

  it('rejects a handover state outside bot/human/closed before any mapping lookup', async () => {
    mappingService.get.mockResolvedValue(mapping('sess-1'));
    mappingService.setHandover.mockResolvedValue(undefined);
    const ctx = contextFor(makePlugin(['*'], ['conversation:send']));
    const key = { sessionId: 'sess-1', chatId: '628@c.us', instanceId: 'inst-1' };

    await expect(ctx.handover.set(key, 'Human' as never)).rejects.toThrow(
      "Plugin test-ext: handover state must be 'bot', 'human' or 'closed'",
    );
    expect(mappingService.get).not.toHaveBeenCalled();
    expect(mappingService.setHandover).not.toHaveBeenCalled();

    await ctx.handover.set(key, 'human');
    expect(mappingService.setHandover).toHaveBeenCalledWith('m-1', 'human');
  });

  it('sends with an explicit chatId without consulting the mapping service', async () => {
    const ctx = contextFor(makePlugin(['*'], ['conversation:send']));
    await ctx.conversations.send({ type: 'text', text: 'hi', sessionId: 'sess-1', chatId: '628@c.us' });
    expect(mappingService.getByProvider).not.toHaveBeenCalled();
    expect(messageService.sendText).toHaveBeenCalledWith('sess-1', { chatId: '628@c.us', text: 'hi' });
  });

  it('mappings.get resolves effective handoverState while keeping providerConversationId from requested row', async () => {
    const ctx = contextFor(makePlugin(['*'], ['conversation:send']));
    const key = { sessionId: 'sess-1', chatId: '111@lid', instanceId: 'inst-1' };

    mappingService.get.mockResolvedValue({ ...mapping('sess-1'), chatId: '111@lid', handoverState: 'closed' });
    mappingService.effectiveHandover.mockResolvedValueOnce('human');
    expect(await ctx.mappings.get(key)).toEqual({ providerConversationId: 'conv-42', handoverState: 'human' });

    mappingService.get.mockResolvedValue({ ...mapping('sess-1'), chatId: '111@lid', handoverState: 'bot' });
    mappingService.effectiveHandover.mockResolvedValueOnce('closed');
    expect(await ctx.mappings.get(key)).toEqual({ providerConversationId: 'conv-42', handoverState: 'closed' });

    mappingService.effectiveHandover.mockResolvedValueOnce('bot');
    expect(await ctx.mappings.get(key)).toEqual({ providerConversationId: 'conv-42', handoverState: 'bot' });
  });

  it('mappings.getByProvider resolves effective handoverState and keeps requested sessionId and chatId', async () => {
    const ctx = contextFor(makePlugin(['*'], ['conversation:send'], ['sess-1']));
    const row = { ...mapping('sess-1'), chatId: '111@lid', handoverState: 'closed' };
    mappingService.getByProvider.mockResolvedValue(row);
    mappingService.effectiveHandover.mockResolvedValue('human');

    expect(await ctx.mappings.getByProvider('inst-1', 'conv-42')).toEqual({
      sessionId: 'sess-1',
      chatId: '111@lid',
      handoverState: 'human',
    });
    expect(mappingService.effectiveHandover).toHaveBeenCalledWith(row);
  });

  it('mappings.getByProvider refuses a mapping of a session the plugin is not activated for', async () => {
    const ctx = contextFor(makePlugin(['*'], ['conversation:send'], ['sess-2']));
    mappingService.getByProvider.mockResolvedValue(mapping('sess-1'));

    await expect(ctx.mappings.getByProvider('inst-1', 'conv-42')).rejects.toThrow(
      'Plugin test-ext is not activated for session sess-1',
    );
    expect(mappingService.effectiveHandover).not.toHaveBeenCalled();
  });
});

describe('PluginLoaderService capability facade — ctx.storage', () => {
  let loader: PluginLoaderService;
  let backing: { get: jest.Mock; set: jest.Mock; delete: jest.Mock; list: jest.Mock };

  beforeEach(() => {
    backing = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([]),
    };
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue(backing),
    } as unknown as PluginStorageService;
    loader = new PluginLoaderService(
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      new HookManager(),
      pluginStorage,
      { get: jest.fn() } as unknown as ModuleRef,
    );
  });

  function contextFor(plugin: PluginInstance): PluginContext {
    return (
      loader as unknown as { capabilities: { createPluginContext: (p: PluginInstance) => PluginContext } }
    ).capabilities.createPluginContext(plugin);
  }

  // Every verb, not just the write ones: `list` alone enumerates whatever a previous version of the
  // plugin persisted, and `get` reads it back.
  const VERBS: Array<[string, (ctx: PluginContext) => Promise<unknown>]> = [
    ['get', ctx => ctx.storage.get('k')],
    ['set', ctx => ctx.storage.set('k', { v: 1 })],
    ['delete', ctx => ctx.storage.delete('k')],
    ['list', ctx => ctx.storage.list('prefix')],
  ];

  it.each(VERBS)('denies storage.%s when the plugin does not declare storage:use', async (verb, call) => {
    const ctx = contextFor(makePlugin(['*'], [])); // no permissions at all
    await expect(call(ctx)).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(backing[verb as keyof typeof backing]).not.toHaveBeenCalled();
  });

  it.each(VERBS)('allows storage.%s once the manifest declares storage:use', async (verb, call) => {
    const ctx = contextFor(makePlugin(['*'], ['storage:use']));
    await expect(call(ctx)).resolves.not.toThrow();
    expect(backing[verb as keyof typeof backing]).toHaveBeenCalled();
  });

  it('the storage denial names the fix too, from the same template', async () => {
    // `storage:use` is the newest permission and the reason this message matters most right now: an
    // operator who upgrades the gateway without upgrading a plugin meets THIS refusal, mid-run. One
    // template with `${permission}` interpolated serves all seven, so this should hold for free —
    // which is exactly why it is asserted rather than assumed.
    const ctx = contextFor(makePlugin(['*'], []));
    const error = await ctx.storage.get('k').catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain('storage:use');
    expect(message).toContain('permissions');
    expect(message).toContain('manifest.json');
  });

  it('passes the caller arguments through untouched', async () => {
    const ctx = contextFor(makePlugin(['*'], ['storage:use']));
    await ctx.storage.set('group:sess-1:12345@g.us', { seen: 2 });
    await ctx.storage.list('group:');
    expect(backing.set).toHaveBeenCalledWith('group:sess-1:12345@g.us', { seen: 2 });
    expect(backing.list).toHaveBeenCalledWith('group:');
  });

  it('is not gated by session scope — storage is keyed by plugin, not by session', async () => {
    // A plugin the operator activated for one session only still owns one storage namespace, so the
    // permission is the whole gate here. Asserting it keeps a later "add assertSessionActive for
    // symmetry" change from quietly bricking every stored key outside the active session.
    const ctx = contextFor(makePlugin(['sess-1'], ['storage:use'], ['sess-1']));
    await expect(ctx.storage.get('anything')).resolves.toBeNull();
    expect(backing.get).toHaveBeenCalledWith('anything');
  });
});

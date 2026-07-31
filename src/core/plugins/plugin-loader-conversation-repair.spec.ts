import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import { PluginContext, PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { SessionService } from '../../modules/session/session.service';
import {
  ConversationMappingConflict,
  ConversationMappingService,
} from '../../modules/integration/conversation-mapping.service';

/**
 * Stale-mapping repair after a session is deleted and re-paired under a new id. The cross-session
 * fence in resolveChatId must still reject a mapping owned by a LIVE session, but a mapping whose
 * session no longer exists is rebound to the envelope's session — otherwise the dead session's rows
 * brick conversation.send and mappings.upsert for that instance permanently.
 */
describe('PluginLoaderService — stale conversation-mapping repair', () => {
  let loader: PluginLoaderService;
  let mappingService: { getByProvider: jest.Mock; rebindSession: jest.Mock; delete: jest.Mock; upsert: jest.Mock };
  let messageService: { sendText: jest.Mock; reply: jest.Mock };
  let sessionService: { findOne: jest.Mock };

  beforeEach(() => {
    mappingService = {
      getByProvider: jest.fn(),
      rebindSession: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    messageService = {
      sendText: jest.fn().mockResolvedValue({ messageId: 'wamid', timestamp: 1 }),
      reply: jest.fn().mockResolvedValue({ messageId: 'wamid', timestamp: 1 }),
    };
    sessionService = { findOne: jest.fn() };
    const moduleRef = {
      get: jest.fn().mockImplementation((token: unknown) => {
        if (token === ConversationMappingService) return mappingService;
        if (token === SessionService) return sessionService;
        return messageService;
      }),
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

  function makePlugin(activeSessions?: string[]): PluginInstance {
    const manifest: PluginManifest = {
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      main: 'index.ts',
      permissions: ['conversation:send'],
    };
    return { manifest, status: PluginStatus.INSTALLED, config: {}, instance: null, activeSessions };
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
  const upsertKey = { sessionId: 'sess-new', chatId: 'chat-1', instanceId: 'inst-1' };
  const conflict = () =>
    new ConversationMappingConflict(
      { sessionId: 'sess-new', chatId: 'chat-1', pluginId: 'test-ext', instanceId: 'inst-1' },
      'conv-42',
    );

  it('rebinds a mapping whose session was deleted, then conversation.send succeeds', async () => {
    mappingService.getByProvider.mockResolvedValue(mapping('sess-dead'));
    sessionService.findOne.mockRejectedValue(new NotFoundException("Session with id 'sess-dead' not found"));
    const ctx = contextFor(makePlugin());

    await ctx.conversations.send({ ...sendEnv, sessionId: 'sess-new' });

    expect(sessionService.findOne).toHaveBeenCalledWith('sess-dead');
    expect(mappingService.rebindSession).toHaveBeenCalledWith('m-1', 'sess-new');
    expect(messageService.sendText).toHaveBeenCalledWith('sess-new', { chatId: '628@c.us', text: 'hi' });
  });

  it('still rejects a mapping owned by another LIVE session and never sends', async () => {
    // The plugin is activated for both sessions, so the activation gate passes — only the mapping's
    // own (live) sessionId stops sess-new's envelope from routing out through sess-live's chat.
    mappingService.getByProvider.mockResolvedValue(mapping('sess-live'));
    sessionService.findOne.mockResolvedValue({ id: 'sess-live' });
    const ctx = contextFor(makePlugin(['sess-new', 'sess-live']));

    await expect(ctx.conversations.send({ ...sendEnv, sessionId: 'sess-new' })).rejects.toThrow(
      /belongs to session sess-live, not sess-new/,
    );
    expect(mappingService.rebindSession).not.toHaveBeenCalled();
    expect(messageService.sendText).not.toHaveBeenCalled();
    expect(messageService.reply).not.toHaveBeenCalled();
  });

  it('keeps the fence closed when the session lookup fails for a non-NotFound reason (fail-closed)', async () => {
    mappingService.getByProvider.mockResolvedValue(mapping('sess-maybe'));
    sessionService.findOne.mockRejectedValue(new Error('database is locked'));
    const ctx = contextFor(makePlugin());

    await expect(ctx.conversations.send({ ...sendEnv, sessionId: 'sess-new' })).rejects.toThrow(
      /belongs to session sess-maybe, not sess-new/,
    );
    expect(mappingService.rebindSession).not.toHaveBeenCalled();
    expect(messageService.sendText).not.toHaveBeenCalled();
  });

  it('mappings.upsert supersedes a reverse-key row whose session is gone, then converges', async () => {
    mappingService.upsert.mockRejectedValueOnce(conflict()).mockResolvedValueOnce(undefined);
    mappingService.getByProvider.mockResolvedValue(mapping('sess-dead'));
    sessionService.findOne.mockRejectedValue(new NotFoundException());
    const ctx = contextFor(makePlugin());

    await expect(ctx.mappings.upsert(upsertKey, 'conv-42')).resolves.toBeUndefined();

    expect(mappingService.delete).toHaveBeenCalledWith('m-1');
    expect(mappingService.upsert).toHaveBeenCalledTimes(2);
  });

  it('mappings.upsert rethrows ConversationMappingConflict when the reverse-key row is owned by a live session', async () => {
    mappingService.upsert.mockRejectedValue(conflict());
    mappingService.getByProvider.mockResolvedValue(mapping('sess-live'));
    sessionService.findOne.mockResolvedValue({ id: 'sess-live' });
    const ctx = contextFor(makePlugin());

    await expect(ctx.mappings.upsert(upsertKey, 'conv-42')).rejects.toBeInstanceOf(ConversationMappingConflict);
    expect(mappingService.delete).not.toHaveBeenCalled();
    expect(mappingService.upsert).toHaveBeenCalledTimes(1);
  });

  it('mappings.upsert propagates a non-conflict failure untouched', async () => {
    mappingService.upsert.mockRejectedValue(new Error('disk i/o'));
    const ctx = contextFor(makePlugin());

    await expect(ctx.mappings.upsert(upsertKey, 'conv-42')).rejects.toThrow('disk i/o');
    expect(mappingService.getByProvider).not.toHaveBeenCalled();
    expect(mappingService.delete).not.toHaveBeenCalled();
  });
});

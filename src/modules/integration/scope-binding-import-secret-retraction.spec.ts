import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { InfraDataController } from '../infra/infra-data.controller';
import { InfraDataService } from '../infra/infra-data.service';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Message } from '../message/entities/message.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { Template } from '../template/entities/template.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { ConversationMapping } from './entities/conversation-mapping.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { PluginInstance } from './entities/plugin-instance.entity';
import { PluginInstanceService } from './plugin-instance.service';
import { ScopeBindingService } from './scope-binding.service';

describe('Post-import scope-binding resync retracts secrets of retired or rolled-back wildcard instances', () => {
  const configSchema = {
    type: 'object' as const,
    properties: {
      apiToken: { type: 'string' as const, secret: true },
      baseUrl: { type: 'string' as const },
    },
  };

  const dataEntities = [
    Session,
    Webhook,
    Message,
    MessageBatch,
    Template,
    BaileysStoredMessage,
    LidMapping,
    ChatState,
    PluginInstance,
    ConversationMapping,
    IngressEvent,
    WebhookDeliveryFailure,
    WebhookOutboxEvent,
    IntegrationDeliveryFailure,
    StatusUpdate,
    AutomationRule,
  ];

  function buildStatefulLoader(
    initialConfig: Record<string, unknown>,
    initialSessionConfig: Record<string, Record<string, unknown>> = {},
    initialSessions: string[] = ['*'],
  ) {
    const plugin = {
      manifest: { id: 'chatwoot', configSchema },
      activeSessions: [...initialSessions],
      config: { ...initialConfig },
      sessionConfig: { ...initialSessionConfig },
    };
    const updatePluginConfig = jest.fn((_id: string, patch: Record<string, unknown>) => {
      plugin.config = { ...plugin.config, ...patch };
    });
    const loader = {
      getPlugin: jest.fn((id: string) => (id === 'chatwoot' ? plugin : undefined)),
      setPluginSessionConfig: jest.fn((_id: string, scope: string, cfg: Record<string, unknown>) => {
        plugin.sessionConfig = { ...plugin.sessionConfig, [scope]: cfg };
      }),
      setPluginSessions: jest.fn((_id: string, sessions: string[]) => {
        plugin.activeSessions = sessions;
      }),
      updatePluginConfig,
    };
    return { plugin, loader, updatePluginConfig };
  }

  it('retracts the secret from plugin.config when import-data drops an enabled wildcard instance', async () => {
    const ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: dataEntities,
      synchronize: true,
    });
    await ds.initialize();
    try {
      const sessions = ds.getRepository(Session);
      await sessions.save(
        sessions.create({ id: 'sess-1', name: 'session-sess-1', status: SessionStatus.DISCONNECTED, config: {} }),
      );
      const instances = ds.getRepository(PluginInstance);
      await instances.save(
        instances.create({
          id: 'chatwoot:wild',
          pluginId: 'chatwoot',
          instanceId: 'wild',
          sessionScope: null,
          secret: 's'.repeat(32),
          verifyToken: 'v',
          config: { apiToken: 'tok-dropped-wildcard', baseUrl: 'https://crm.example' },
          enabled: true,
        }),
      );

      const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : def) };
      const dump = await new InfraDataController(new InfraDataService(cfg as never, ds)).exportData();
      // Restore an archive from before the wildcard instance existed.
      const tables = {
        ...dump.tables,
        pluginInstances: [],
      };

      const { plugin, loader } = buildStatefulLoader({
        apiToken: 'tok-dropped-wildcard',
        baseUrl: 'https://crm.example',
      });
      const scopeBinding = new ScopeBindingService(
        new PluginInstanceService(instances),
        loader as unknown as PluginLoaderService,
        { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
        sessions,
      );
      const moduleRef = { get: jest.fn(() => scopeBinding) };
      const service = new InfraDataService(
        cfg as never,
        ds,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        moduleRef as never,
      );
      const controller = new InfraDataController(service);

      const res = await controller.importData({ tables });

      expect(res.imported).toBe(true);
      expect(plugin.activeSessions).toEqual([]);
      expect(plugin.config.apiToken).toBeNull();
    } finally {
      await ds.destroy();
    }
  });

  it('retracts a secret when import-data rolls a wildcard instance back to a config without that secret', async () => {
    const { plugin, loader } = buildStatefulLoader({
      apiToken: 'tok-added-after-backup',
      baseUrl: 'https://crm.example',
    });
    const restored = [
      {
        pluginId: 'chatwoot',
        instanceId: 'wild',
        sessionScope: null,
        config: { baseUrl: 'https://crm.example' },
        enabled: true,
      },
    ];
    const svc = new ScopeBindingService(
      {
        listAll: jest.fn().mockResolvedValue(restored),
        list: jest.fn().mockResolvedValue(restored),
      } as unknown as PluginInstanceService,
      loader as unknown as PluginLoaderService,
      { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
      { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>,
    );

    await svc.resyncAfterImport([
      {
        pluginId: 'chatwoot',
        sessionScope: null,
        enabled: true,
        config: { apiToken: 'tok-added-after-backup', baseUrl: 'https://crm.example' },
      },
    ]);

    expect(plugin.config.apiToken).toBeNull();
  });

  it('retracts the base secret when import-data narrows a wildcard instance to a concrete session', async () => {
    const { plugin, loader } = buildStatefulLoader({
      apiToken: 'tok-narrowed',
      baseUrl: 'https://crm.example',
    });
    const restored = [
      {
        pluginId: 'chatwoot',
        instanceId: 'wild',
        sessionScope: 'sess-1',
        config: { apiToken: 'tok-narrowed', baseUrl: 'https://crm.example' },
        enabled: true,
      },
    ];
    const svc = new ScopeBindingService(
      {
        listAll: jest.fn().mockResolvedValue(restored),
        list: jest.fn().mockResolvedValue(restored),
      } as unknown as PluginInstanceService,
      loader as unknown as PluginLoaderService,
      { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
      { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>,
    );

    await svc.resyncAfterImport([
      {
        pluginId: 'chatwoot',
        instanceId: 'wild',
        sessionScope: '*',
        enabled: true,
        config: { apiToken: 'tok-narrowed', baseUrl: 'https://crm.example' },
      },
    ]);

    expect(plugin.activeSessions).toEqual(['sess-1']);
    expect(plugin.config.apiToken).toBeNull();
    expect(plugin.sessionConfig['sess-1']).toEqual({ apiToken: 'tok-narrowed', baseUrl: 'https://crm.example' });
  });

  it('retracts a dropped wildcard sibling secret when a surviving wildcard omits it', async () => {
    const { plugin, loader } = buildStatefulLoader({
      apiToken: 'tok-b',
      baseUrl: 'https://b.example',
    });
    const restored = [
      {
        pluginId: 'chatwoot',
        instanceId: 'a',
        sessionScope: null,
        config: { baseUrl: 'https://a.example' },
        enabled: true,
      },
    ];
    const svc = new ScopeBindingService(
      {
        listAll: jest.fn().mockResolvedValue(restored),
        list: jest.fn().mockResolvedValue(restored),
      } as unknown as PluginInstanceService,
      loader as unknown as PluginLoaderService,
      { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
      { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>,
    );

    await svc.resyncAfterImport([
      {
        pluginId: 'chatwoot',
        instanceId: 'b',
        sessionScope: null,
        enabled: true,
        config: { apiToken: 'tok-b', baseUrl: 'https://b.example' },
      },
      {
        pluginId: 'chatwoot',
        instanceId: 'a',
        sessionScope: null,
        enabled: true,
        config: { baseUrl: 'https://a.example' },
      },
    ]);

    expect(plugin.config.apiToken).toBeNull();
    expect(plugin.config.baseUrl).toBe('https://a.example');
  });

  it('control: preserves an operator base secret that differs from the retired wildcard instance', async () => {
    const { plugin, loader, updatePluginConfig } = buildStatefulLoader({
      apiToken: 'tok-operator-override',
      baseUrl: 'https://crm.example',
    });
    const svc = new ScopeBindingService(
      {
        listAll: jest.fn().mockResolvedValue([]),
        list: jest.fn().mockResolvedValue([]),
      } as unknown as PluginInstanceService,
      loader as unknown as PluginLoaderService,
      { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
      { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>,
    );

    await svc.resyncAfterImport([
      {
        pluginId: 'chatwoot',
        instanceId: 'wild',
        sessionScope: null,
        enabled: true,
        config: { apiToken: 'tok-wildcard', baseUrl: 'https://crm.example' },
      },
    ]);

    expect(plugin.config.apiToken).toBe('tok-operator-override');
    expect(updatePluginConfig).not.toHaveBeenCalled();
  });

  it('control: clears the sessionConfig slice when import-data drops an enabled concrete-scoped instance', async () => {
    const { plugin, loader } = buildStatefulLoader(
      {},
      { 'sess-1': { apiToken: 'tok-concrete', baseUrl: 'https://crm.example' } },
      ['sess-1'],
    );
    const svc = new ScopeBindingService(
      {
        listAll: jest.fn().mockResolvedValue([]),
        list: jest.fn().mockResolvedValue([]),
      } as unknown as PluginInstanceService,
      loader as unknown as PluginLoaderService,
      { logInfo: jest.fn(), logWarn: jest.fn() } as unknown as AuditService,
      { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } as unknown as Repository<Session>,
    );

    await svc.resyncAfterImport([{ pluginId: 'chatwoot', sessionScope: 'sess-1', enabled: true }]);

    expect(plugin.activeSessions).toEqual([]);
    expect(plugin.sessionConfig['sess-1']).toEqual({});
  });
});

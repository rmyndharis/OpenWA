import { DataSource } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import { InfraDataService } from './infra-data.service';
import type { MigrationTables } from './migration-tables.types';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { AutomationRulesService } from '../automation/automation-rules.service';
import { ScopeBindingService } from '../integration/scope-binding.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { MessageService } from '../message/message.service';

describe('InfraDataService.importData automation rule cache reconciliation', () => {
  let ds: DataSource;
  let engines: EngineRegistry;
  let automationRules: AutomationRulesService;
  let sends: Array<{ sessionId: string; chatId: string; text: string }>;
  let infraData: InfraDataService;

  const inbound = (id: string): Record<string, unknown> => ({
    id,
    from: '628111@c.us',
    to: '628222@c.us',
    chatId: '628111@c.us',
    body: 'hello',
    type: 'text',
    fromMe: false,
    isGroup: false,
  });

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
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
        SendIdempotencyKey,
      ],
      synchronize: true,
    });
    await ds.initialize();

    const sessions = ds.getRepository(Session);
    await sessions.save(sessions.create({ id: 's-live', name: 'live', status: SessionStatus.READY, config: {} }));

    engines = new EngineRegistry();
    engines.set('s-live', {} as IWhatsAppEngine);

    sends = [];
    const messagePortRef = {
      get: () =>
        ({
          sendText: (sessionId: string, dto: { chatId: string; text: string }) => {
            sends.push({ sessionId, chatId: dto.chatId, text: dto.text });
            return Promise.resolve({});
          },
        }) as unknown as MessageService,
    } as unknown as ModuleRef;

    automationRules = new AutomationRulesService(
      ds.getRepository(AutomationRule),
      sessions,
      messagePortRef,
      undefined,
      undefined,
      engines,
    );

    const sessionService = {
      getActiveSessionIds: () => (engines.has('s-live') ? ['s-live'] : []),
      stopOrphanEngines: jest.fn().mockResolvedValue({ stopped: [], notRunning: [], failed: [] }),
      forgetSession: jest.fn(),
    };

    const scopeBindingStub = { resyncAfterImport: jest.fn().mockResolvedValue(undefined) };
    const infraModuleRef = {
      get: (token: unknown) => {
        if (token === AutomationRulesService) return automationRules;
        if (token === ScopeBindingService) return scopeBindingStub;
        return undefined;
      },
    } as unknown as ModuleRef;

    const cfg = { get: (key: string, fallback?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : fallback) };
    infraData = new InfraDataService(
      cfg as never,
      ds,
      undefined,
      sessionService as never,
      undefined,
      undefined,
      undefined,
      infraModuleRef,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
  });

  it('clears cached automation rules and pre-import cooldowns for a retained live session after commit', async () => {
    const original = await automationRules.create('s-live', {
      name: 'greet',
      replyText: 'old-reply',
      cooldownSeconds: 300,
    });
    const dump = await infraData.exportData();

    // Warm the rule cache and enter a long cooldown for the retained live session.
    const findSpy = jest.spyOn(ds.getRepository(AutomationRule), 'find');
    await automationRules.evaluateInbound('s-live', inbound('wamid.1'));
    expect(sends.map(s => s.text)).toEqual(['old-reply']);
    expect(findSpy).toHaveBeenCalledTimes(1);

    // Replace the rule text in the imported archive while retaining s-live (so forgetSession is not called).
    const replacementTables: Partial<MigrationTables> = {
      ...dump.tables,
      automationRules: (dump.tables.automationRules ?? []).map(row =>
        row.id === original.id ? { ...row, replyText: 'restored-reply' } : row,
      ),
    };

    const res = await infraData.importData({ tables: replacementTables });
    expect(res.imported).toBe(true);

    // Next inbound message must re-read the restored rule and fire immediately without stale cache or cooldown.
    await automationRules.evaluateInbound('s-live', inbound('wamid.2'));
    expect(findSpy).toHaveBeenCalledTimes(2);
    expect(sends.map(s => s.text)).toEqual(['old-reply', 'restored-reply']);
  });

  it('leaves cached automation rules and cooldowns intact when importData rolls back', async () => {
    await automationRules.create('s-live', {
      name: 'greet',
      replyText: 'live-reply',
      cooldownSeconds: 300,
    });
    const dump = await infraData.exportData();

    const findSpy = jest.spyOn(ds.getRepository(AutomationRule), 'find');
    await automationRules.evaluateInbound('s-live', inbound('wamid.1'));
    expect(sends.map(s => s.text)).toEqual(['live-reply']);
    expect(findSpy).toHaveBeenCalledTimes(1);

    // Invalid message row forces rollback inside the import transaction.
    const brokenTables: Partial<MigrationTables> = {
      ...dump.tables,
      messages: [
        { id: 'bad', sessionId: 's-live', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' } as never,
      ],
    };

    const res = await infraData.importData({ tables: brokenTables });
    expect(res.imported).toBe(false);

    // Cache remains warm (no extra DB query) and the pre-existing cooldown still suppresses a repeat reply.
    await automationRules.evaluateInbound('s-live', inbound('wamid.2'));
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(sends.map(s => s.text)).toEqual(['live-reply']);
  });
});

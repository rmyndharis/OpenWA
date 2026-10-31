import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { DataSource, Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { HookManager } from '../../../core/hooks';
import { PluginCapabilityContext } from '../../../core/plugins/plugin-capability-context';
import { PluginHostServices } from '../../../core/plugins/plugin-host-services';
import { PluginStorageService } from '../../../core/plugins/plugin-storage.service';
import {
  PluginEngineReadCapability,
  PluginInstance,
  PluginStatus,
  PluginType,
} from '../../../core/plugins/plugin.interfaces';
import { LidMapping } from '../../../engine/identity/lid-mapping.entity';
import { LidMappingStoreService } from '../../../engine/identity/lid-mapping-store.service';
import { AutomationRulesService } from '../../automation/automation-rules.service';
import { AutomationRule } from '../../automation/entities/automation-rule.entity';
import { Session } from '../../session/entities/session.entity';
import { Webhook } from '../entities/webhook.entity';
import { WebhookDeliveryFailure } from '../entities/webhook-delivery-failure.entity';
import { WebhookDeliveryService } from '../webhook-delivery.service';
import { WebhookOutboxService } from '../webhook-outbox.service';
import { WebhookFilters } from './filter-types';

const LID = '484848@lid';
const P = '628111@c.us';
const Q = '628222@c.us';
const filtersFor = (jid: string, field = 'sender', operator: 'is' | 'isNot' = 'is'): WebhookFilters => ({
  conditions: [{ field, operator, value: [jid] }],
});
const message = { from: LID, to: '620000@c.us', chatId: LID, mentionedIds: [LID], body: 'hello', type: 'text' };

describe('Identity readers after a peer changes a mapping', () => {
  let db: DataSource;
  let reader: LidMappingStoreService;
  let peer: LidMappingStoreService;

  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [LidMapping],
      synchronize: true,
    }).initialize();
    const repo = db.getRepository(LidMapping);
    reader = new LidMappingStoreService(repo);
    peer = new LidMappingStoreService(repo);
    await reader.remember('484848', '628111', 'reader');
    await peer.reload();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function webhookMatches(jid: string, field = 'sender', operator: 'is' | 'isNot' = 'is'): Promise<Webhook[]> {
    const delivery = new WebhookDeliveryService(
      {} as Repository<Webhook>,
      {} as Repository<WebhookDeliveryFailure>,
      { get: (_key: string, value: unknown) => value } as ConfigService,
      new HookManager(),
      {} as WebhookOutboxService,
      reader,
    );
    return (
      delivery as unknown as {
        filterMatchingWebhooks: (rows: Webhook[], event: string, data: Record<string, unknown>) => Promise<Webhook[]>;
      }
    ).filterMatchingWebhooks(
      [{ id: 'w', events: ['message.received'], filters: filtersFor(jid, field, operator) } as Webhook],
      'message.received',
      message,
    );
  }

  async function automationSends(jid: string, field = 'sender', operator: 'is' | 'isNot' = 'is'): Promise<jest.Mock> {
    const sendText = jest.fn().mockResolvedValue({});
    const rules = new AutomationRulesService(
      {
        find: () =>
          Promise.resolve([
            { id: 'r', conditions: filtersFor(jid, field, operator), replyText: 'reply', cooldownSeconds: 0 },
          ]),
      } as unknown as Repository<AutomationRule>,
      {} as Repository<Session>,
      { get: () => ({ sendText }) } as unknown as ModuleRef,
      reader,
    );
    await rules.evaluateInbound('s', message);
    return sendText;
  }

  function pluginCapability(): PluginEngineReadCapability {
    const context = new PluginCapabilityContext(
      createLogger('PluginIdentity'),
      { getSessionPort: () => ({ getEngine: () => ({}) }) } as unknown as PluginHostServices,
      new HookManager(),
      {} as PluginStorageService,
      reader,
    );
    const plugin: PluginInstance = {
      manifest: {
        id: 'identity',
        name: 'Identity',
        version: '1.0.0',
        type: PluginType.EXTENSION,
        main: 'index.js',
        permissions: ['engine:read'],
        sessions: ['s'],
      },
      status: PluginStatus.INSTALLED,
      config: {},
      instance: null,
      activeSessions: ['s'],
    };
    return (
      context as unknown as { buildEngineReadCapability: (p: PluginInstance) => PluginEngineReadCapability }
    ).buildEngineReadCapability(plugin);
  }

  it('does not deliver a phone-filtered webhook after a peer revokes the alias', async () => {
    await peer.rememberIfUnknown('484848', '628222', 'peer');
    expect(reader.getCached('484848')).toBe('628111');
    expect(await webhookMatches(P)).toHaveLength(0);
    expect(await webhookMatches(LID)).toHaveLength(1);
  });

  it('does not reply under a phone rule after a peer revokes the alias', async () => {
    await peer.rememberIfUnknown('484848', '628222', 'peer');
    expect(await automationSends(P)).not.toHaveBeenCalled();
    expect(await automationSends(LID)).toHaveBeenCalledTimes(1);
  });

  it('returns the raw LID to a plugin after a peer revokes the alias', async () => {
    await peer.rememberIfUnknown('484848', '628222', 'peer');
    expect(await pluginCapability().canonicalChatId('s', LID)).toBe(LID);
  });

  it('uses the peer reported phone without reloading the resident mirror', async () => {
    await peer.remember('484848', '628222', 'peer');
    expect(reader.getCached('484848')).toBe('628111');
    expect(await webhookMatches(P)).toHaveLength(0);
    expect(await webhookMatches(Q)).toHaveLength(1);
    expect(await automationSends(P)).not.toHaveBeenCalled();
    expect(await automationSends(Q)).toHaveBeenCalledTimes(1);
    expect(await pluginCapability().canonicalChatId('s', LID)).toBe(Q);
  });

  it('preserves matching reported aliases and exact phone inputs', async () => {
    expect(await webhookMatches(P)).toHaveLength(1);
    expect(await automationSends(P)).toHaveBeenCalledTimes(1);
    expect(await pluginCapability().canonicalChatId('s', LID)).toBe(P);
    expect(await pluginCapability().canonicalChatId('s', Q)).toBe(Q);
  });

  it.each([
    ['sender', 'is'],
    ['sender', 'isNot'],
    ['mentions', 'is'],
    ['mentions', 'isNot'],
  ] as const)('keeps distinct reported LIDs separate for %s %s rules', async (field, operator) => {
    const other = '595959@lid';
    await peer.remember('595959', '628111', 'peer');
    const matches = operator === 'is' ? 0 : 1;
    expect(await webhookMatches(other, field, operator)).toHaveLength(matches);
    expect(await automationSends(other, field, operator)).toHaveBeenCalledTimes(matches);
    expect(await webhookMatches(P, field)).toHaveLength(1);
    expect(await automationSends(P, field)).toHaveBeenCalledTimes(1);
    expect(await webhookMatches(LID, field)).toHaveLength(1);
    expect(await automationSends(LID, field)).toHaveBeenCalledTimes(1);
  });
});

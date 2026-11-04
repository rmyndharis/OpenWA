import 'reflect-metadata';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { InfraDataService } from './infra-data.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
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

/**
 * What docs/14 (Timestamps travel as UTC) says a SQLite-made archive holds, checked against an export from
 * a SQLite data database the migration chain built, the default deployment: created and updated columns
 * keep SQLite's zone-less UTC text, the columns the app writes itself are ISO 8601 with Z.
 */
const SQLITE_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('a SQLite-made export archive', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const dir = join(__dirname, '..', '..', 'database', 'migrations');
    const migrations = readdirSync(dir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .sort()
      .map(f =>
        Object.values(jest.requireActual<Record<string, unknown>>(join(dir, f))).find(
          v => typeof v === 'function' && (v as { prototype?: { up?: unknown } }).prototype?.up !== undefined,
        ),
      );
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
      migrations: migrations as never,
    });
    await ds.initialize();
    await ds.runMigrations({ transaction: 'all' });
    const session = await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        name: 'stamp-probe',
        status: SessionStatus.DISCONNECTED,
        config: {},
        connectedAt: new Date('2026-10-28T23:01:07.123Z'),
      }),
    );
    await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        sessionId: session.id,
        waMessageId: 'wa-1',
        chatId: '628222@c.us',
        from: '628222@c.us',
        to: '628111@c.us',
        body: 'hello',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 1798844587123,
      }),
    );
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  it('keeps SQLite text for created and updated columns and ISO 8601 with Z for the others', async () => {
    const cfg = { get: (_key: string, def?: unknown) => def };
    const archive = await new InfraDataService(cfg as never, ds).exportData();
    const [session] = archive.tables.sessions;
    const [message] = archive.tables.messages;
    expect([session.createdAt, session.updatedAt, message.createdAt]).toEqual([
      expect.stringMatching(SQLITE_TEXT),
      expect.stringMatching(SQLITE_TEXT),
      expect.stringMatching(SQLITE_TEXT),
    ]);
    expect(session.connectedAt).toMatch(ISO_UTC);
  });

  it('is described as it is in docs/14', () => {
    const doc = readFileSync(join(__dirname, '..', '..', '..', 'docs', '14-migration-guide.md'), 'utf8');
    const note = doc.slice(doc.indexOf('**Timestamps travel as UTC.**')).split('\n\n')[0];
    expect(note).toContain('`YYYY-MM-DD HH:MM:SS`');
    expect(note).not.toMatch(/Every stamp in the archive is ISO 8601/);
  });
});

/* istanbul ignore file: PG-gated, only runs under DATABASE_TYPE=postgres (test-postgres CI job). */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { InfraDataService } from './infra-data.service';
import { EXPORT_TABLES } from './export-tables';
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
import { postgresUtcExtra } from '../../database/postgres-utc';

const entities = [
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
];

async function seedSession(ds: DataSource): Promise<string> {
  const id = randomUUID();
  await ds.getRepository(Session).save(
    ds.getRepository(Session).create({
      id,
      name: `session-${id}`,
      status: SessionStatus.DISCONNECTED,
      config: {},
      phone: null,
      pushName: null,
      proxyUrl: null,
      proxyType: null,
      connectedAt: null,
      lastActiveAt: null,
    }),
  );
  return id;
}

const optionalTables = EXPORT_TABLES.filter(entry => entry.optional).map(entry => ({
  table: entry.table,
  key: entry.key,
}));
const describePostgres = process.env.DATABASE_TYPE === 'postgres' ? describe : describe.skip;

describePostgres('PostgreSQL restore tolerates absent optional archive tables', () => {
  jest.setTimeout(20000);
  const options = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };
  let admin: DataSource;
  let ds: DataSource;
  let service: InfraDataService;
  let schema: string;
  let sessionId: string;
  beforeAll(async () => {
    admin = await new DataSource(options).initialize();
  });
  beforeEach(async () => {
    schema = `restore_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    ds = await new DataSource({
      ...options,
      schema,
      // Only the scratch schema: a table dropped from it must read as absent, not resolve to one in public.
      // gen_random_uuid() is core since PostgreSQL 13; uuid_generate_v4() lives in an extension that an earlier spec may
      // have installed in public, which this search_path no longer reaches.
      uuidExtension: 'pgcrypto' as const,
      extra: { ...postgresUtcExtra(), options: `-c search_path=${schema}` },
      entities,
      synchronize: true,
    }).initialize();
    service = new InfraDataService(
      { get: (key: string, fallback?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : fallback) } as never,
      ds,
    );
    sessionId = await seedSession(ds);
  });
  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (admin?.isInitialized && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy();
  });
  it('restores an archive against an intact synchronized schema', async () => {
    const dump = await service.exportData();
    expect(dump.skippedTables).toEqual([]);
    await expect(service.importData(dump)).resolves.toMatchObject({ imported: true, warnings: [] });
    expect(await ds.getRepository(Session).findOneBy({ id: sessionId })).not.toBeNull();
  });
  it.each(optionalTables)('restores the real empty-table export when $table is absent', async ({ table, key }) => {
    await ds.query(`DROP TABLE "${table}" CASCADE`);
    const dump = await service.exportData();
    expect(dump.skippedTables).toContain(table);
    expect(dump.tables[key]).toEqual([]);
    await expect(service.importData(dump)).resolves.toMatchObject({ imported: true, warnings: [] });
    expect(await ds.getRepository(Session).findOneBy({ id: sessionId })).not.toBeNull();
    const runner = ds.createQueryRunner();
    try {
      expect(await runner.hasTable(table)).toBe(false);
    } finally {
      await runner.release();
    }
  });
  it('rolls back completed clears and inserts after a genuine malformed row', async () => {
    const before = await ds.query<unknown[]>('SELECT * FROM sessions ORDER BY id');
    const dump = await service.exportData();
    const addedId = randomUUID();
    const kept = dump.tables.sessions[0];
    dump.tables.sessions = [
      { ...kept, id: addedId, name: 'valid-first-row' },
      { ...kept, createdAt: 'invalid-timestamp' },
    ];
    const result = await service.importData(dump);
    expect(result.imported).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(await ds.query('SELECT * FROM sessions ORDER BY id')).toEqual(before);
    expect(await ds.getRepository(Session).findOneBy({ id: addedId })).toBeNull();
  });
  it('rejects a nonempty table payload that the target schema cannot restore atomically', async () => {
    const dump = await service.exportData();
    await ds.query('DROP TABLE message_batches');
    const before = await ds.query<unknown[]>('SELECT * FROM sessions ORDER BY id');
    dump.tables.messageBatches = [
      {
        id: randomUUID(),
        batch_id: 'unsupported-target',
        session_id: sessionId,
        status: 'pending',
        messages: '[]',
        options: null,
        progress: null,
        results: null,
        current_index: 0,
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      },
    ];
    const result = await service.importData(dump);
    expect(result.imported).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(await ds.query('SELECT * FROM sessions ORDER BY id')).toEqual(before);
  });
  it('rolls back a genuine DELETE error instead of treating it as an optional table', async () => {
    const before = await ds.query<unknown[]>('SELECT * FROM sessions ORDER BY id');
    const dump = await service.exportData();
    await ds.query(
      `CREATE FUNCTION fail_clear() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture blocked delete'; END $$`,
    );
    await ds.query(
      'CREATE TRIGGER fail_clear BEFORE DELETE ON messages FOR EACH STATEMENT EXECUTE FUNCTION fail_clear()',
    );
    await expect(service.importData(dump)).rejects.toThrow('fixture blocked delete');
    expect(await ds.query('SELECT * FROM sessions ORDER BY id')).toEqual(before);
  });
});

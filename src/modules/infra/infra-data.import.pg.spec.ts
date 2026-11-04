/* istanbul ignore file: PG-gated, only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { InfraDataController } from './infra-data.controller';
import { InfraDataService } from './infra-data.service';
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
import { captureSessionWrites } from '../../common/utils/session-write-scope';

/**
 * The replace-all import trims send_idempotency_keys with a statement that compares the claim's
 * varchar sessionId with sessions.id, a uuid on PostgreSQL. The comparison only holds because the
 * statement casts, and the cast is invisible on SQLite, where both are text: without it every import
 * on PostgreSQL answers imported:false with a warning about idempotency claims.
 */
const describePostgres = process.env.DATABASE_TYPE === 'postgres' ? describe : describe.skip;

describePostgres('InfraDataController.importData (postgres)', () => {
  const schema = `infra_import_${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: DataSource;
  let ds: DataSource;
  let controller: InfraDataController;

  beforeAll(async () => {
    const options = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
    };
    admin = await new DataSource(options).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    ds = await new DataSource({
      ...options,
      schema,
      extra: { ...postgresUtcExtra(), options: `-c search_path=${schema},public` },
      // The full data-connection entity set: exportData validates its table registry against it.
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
    }).initialize();
    const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : def) };
    controller = new InfraDataController(new InfraDataService(cfg as never, ds, undefined, undefined, undefined));
  });

  afterAll(async () => {
    await ds?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('drops the claims of a session the restore removes and keeps those of one it restores', async () => {
    const sessions = ds.getRepository(Session);
    const claims = ds.getRepository(SendIdempotencyKey);
    const [kept, removed] = [randomUUID(), randomUUID()];
    for (const id of [kept, removed]) {
      await sessions.save(
        sessions.create({
          id,
          name: `session-${id.slice(0, 8)}`,
          status: SessionStatus.READY,
          phone: null,
          pushName: null,
          config: {},
          proxyUrl: null,
          proxyType: null,
          connectedAt: null,
          lastActiveAt: null,
        }),
      );
      await claims.save(
        claims.create({
          sessionId: id,
          idempotencyKey: 'order-42',
          route: 'send-text',
          requestHash: 'h',
          state: 'completed',
          responseBody: { messageId: `sent-by-${id}` },
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      );
    }
    const dump = await controller.exportData();
    const onlyKept = {
      tables: {
        ...dump.tables,
        sessions: (dump.tables.sessions as unknown as Array<{ id: string }>).filter(row => row.id === kept),
      },
    };

    const result = await controller.importData(onlyKept as never);

    expect(result).toMatchObject({ imported: true });
    expect(result.warnings).toEqual([]);
    expect((await claims.find()).map(claim => claim.sessionId)).toEqual([kept]);
  });

  it('preserves reported mapping origin and restores legacy mappings as display data', async () => {
    const mappings = ds.getRepository(LidMapping);
    await mappings.insert([
      { lid: '111', phone: '628111', sessionId: null, isReported: true },
      { lid: '222', phone: '628222', sessionId: null, isReported: false },
    ]);
    const dump = await controller.exportData();
    await expect(controller.importData(dump as never)).resolves.toMatchObject({ imported: true, warnings: [] });
    expect(await mappings.findOneBy({ lid: '111' })).toMatchObject({ isReported: true });
    expect(await mappings.findOneBy({ lid: '222' })).toMatchObject({ isReported: false });
    const rows = (dump.tables as unknown as { lidMappings: { isReported?: boolean | number }[] }).lidMappings;
    for (const row of rows) delete row.isReported;
    await expect(controller.importData(dump as never)).resolves.toMatchObject({ imported: true, warnings: [] });
    expect(await mappings.findOneBy({ lid: '111' })).toMatchObject({ phone: '628111', isReported: false });
  });

  // A bigint column the export reads back as a string.
  it('restores the deletion mark of a chat state', async () => {
    const states = ds.getRepository(ChatState);
    await states.insert([{ sessionId: 's1', chatId: '628111@s.whatsapp.net', deletedAt: 1790000000000 }]);
    const dump = await controller.exportData();
    await expect(controller.importData(dump as never)).resolves.toMatchObject({ imported: true, warnings: [] });
    expect(await states.findOneBy({ chatId: '628111@s.whatsapp.net' })).toMatchObject({ deletedAt: 1790000000000 });
  });

  // The runtime pool cancels a statement that outlives statement_timeout (30 s by default), and the
  // clears of a replace-all import scale with the live tables, not with the archive. A slow trigger on
  // messages stands in for a table that has grown large: with the pool's timeout lowered below it, the
  // import only completes when it lifts the timeout for its own transaction.
  it('completes a restore whose clears outlast the runtime statement timeout', async () => {
    const dump = await controller.exportData();
    const strict = await new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
      schema,
      extra: { ...postgresUtcExtra(), options: `-c search_path=${schema},public`, statement_timeout: 250 },
      entities: ds.options.entities,
      synchronize: false,
    }).initialize();
    const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : def) };
    const strictController = new InfraDataController(
      new InfraDataService(cfg as never, strict, undefined, undefined, undefined),
    );
    await admin.query(
      `CREATE FUNCTION "${schema}".slow_messages_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NULL; END $$`,
    );
    await admin.query(
      `CREATE TRIGGER slow_messages_delete BEFORE DELETE ON "${schema}".messages FOR EACH STATEMENT EXECUTE FUNCTION "${schema}".slow_messages_delete()`,
    );
    try {
      // Guard the guard: the lowered timeout does cancel the slow clear outside the import's transaction.
      await expect(strict.query('DELETE FROM messages')).rejects.toThrow(/statement timeout/);

      await expect(strictController.importData(dump as never)).resolves.toMatchObject({ imported: true });
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS slow_messages_delete ON "${schema}".messages`);
      await admin.query(`DROP FUNCTION IF EXISTS "${schema}".slow_messages_delete()`);
      await strict.destroy();
    }
  });

  // Before its transaction opens, the import waits for the writes still in flight for the sessions it
  // removes. A write that has yet to get a client from the pool needs the one the import would hold, so on a
  // pool of one the import must not take it until the wait is over.
  it.each([0, 10_000])(
    'waits out a write of a session it removes on a pool of one client (connection timeout %i ms)',
    async connectionTimeoutMillis => {
      const sessions = ds.getRepository(Session);
      const removed = randomUUID();
      await sessions.save(
        sessions.create({
          id: removed,
          name: `removed-${removed.slice(0, 8)}`,
          status: SessionStatus.READY,
          config: {},
        }),
      );
      const dump = await controller.exportData();
      const withoutRemoved = {
        tables: {
          ...dump.tables,
          sessions: (dump.tables.sessions as unknown as Array<{ id: string }>).filter(row => row.id !== removed),
        },
      };
      const applicationName = `${schema}_pool_of_one`;
      const single = await new DataSource({
        type: 'postgres',
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
        schema,
        extra: {
          ...postgresUtcExtra(),
          options: `-c search_path=${schema},public`,
          max: 1,
          connectionTimeoutMillis,
          application_name: applicationName,
        },
        entities: ds.options.entities,
        synchronize: false,
      }).initialize();
      const cfg = { get: (key: string, def?: unknown) => (key === 'dataDatabase.type' ? 'postgres' : def) };
      const service = new InfraDataService(cfg as never, single, undefined, undefined, undefined);
      // The write is let go once the import reads the sessions it removes, so it asks the pool for its client
      // after the import has begun.
      let reading!: () => void;
      const read = new Promise<void>(resolve => (reading = resolve));
      let letGo!: () => void;
      const go = new Promise<void>(resolve => (letGo = resolve));
      const realCreate = single.createQueryRunner.bind(single);
      jest.spyOn(single, 'createQueryRunner').mockImplementation((...args: Parameters<typeof realCreate>) => {
        const runner = realCreate(...args);
        const query = runner.query.bind(runner);
        runner.query = ((...queryArgs: Parameters<typeof query>) => {
          if (/^SELECT id FROM sessions/.test(queryArgs[0])) reading();
          return query(...queryArgs);
        }) as typeof runner.query;
        return runner;
      });
      const scope = captureSessionWrites(single, removed);
      const writing = scope.write(async () => {
        await go;
        await single
          .getRepository(Message)
          .insert({ sessionId: removed, chatId: '10000000001@c.us', from: 'me', to: '10000000001@c.us', body: 'm' });
      });

      const importing = service.importData(withoutRemoved as never);
      await read;
      letGo();
      const outcome = await Promise.race([
        importing.then(result => result.imported),
        new Promise(resolve => setTimeout(() => resolve('still waiting after 8 s'), 8_000)),
      ]);
      try {
        expect(outcome).toBe(true);
        await expect(writing).resolves.toBeUndefined();
        expect(await sessions.countBy({ id: removed })).toBe(0);
        expect(await ds.getRepository(Message).countBy({ sessionId: removed })).toBe(0);
      } finally {
        jest.restoreAllMocks();
        scope.close();
        // Only when the import is stuck: cut its connection so the pool can close.
        if (outcome !== true) {
          await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [
            applicationName,
          ]);
        }
        await Promise.allSettled([importing, writing]);
        await single.destroy();
      }
    },
    30_000,
  );
});

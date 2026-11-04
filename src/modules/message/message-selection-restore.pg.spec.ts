/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { InfraDataService } from '../infra/infra-data.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection } from './entities/message.entity';
import { MessageService, GetMessagesOptions } from './message.service';
import { MessageBatch } from './entities/message-batch.entity';
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
import { SendIdempotencyKey } from './entities/send-idempotency-key.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { ChatScopeService } from '../auth/chat-scope.service';
import { postgresUtcExtra } from '../../database/postgres-utc';

const enabled = process.env.DATABASE_TYPE === 'postgres';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
};
(enabled ? describe : describe.skip)('stored message selection during data restore', () => {
  const schema = `message_selection_${randomBytes(4).toString('hex')}`;
  const SID = '00000000-0000-4000-8000-000000000001';
  const OLD = '00000000-0000-4000-8000-000000000011';
  const MID = '00000000-0000-4000-8000-000000000012';
  const NEW = '00000000-0000-4000-8000-000000000013';
  const A = '100@g.us';
  const B = '200@g.us';
  let admin: DataSource;
  let ds: DataSource;
  let main: DataSource;
  let repo: Repository<Message>;
  let service: MessageService;
  let infra: InfraDataService;
  let key: ApiKey;
  let releaseGate: (() => void) | undefined;
  let previousBudget: string | undefined;
  const chatScope = new ChatScopeService();

  beforeAll(async () => {
    const options = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'fixture',
      password: process.env.DATABASE_PASSWORD || 'fixture',
      database: process.env.DATABASE_NAME || 'fixture',
    };
    admin = await new DataSource(options).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    ds = await new DataSource({
      ...options,
      schema,
      extra: {
        ...postgresUtcExtra(),
        options: `-c search_path=${schema},public`,
        max: 3,
        statement_timeout: 5000,
        connectionTimeoutMillis: 2000,
      },
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
    main = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey],
      synchronize: true,
    }).initialize();
    key = await main.getRepository(ApiKey).save(
      main.getRepository(ApiKey).create({
        name: 'scoped-viewer',
        keyHash: '0'.repeat(64),
        keyPrefix: 'dummy-prefix',
        role: ApiKeyRole.VIEWER,
        allowedSessions: [SID],
        allowedChats: [A],
        allowedIps: null,
      }),
    );
    repo = ds.getRepository(Message);
    service = new MessageService(
      repo,
      {} as never,
      {} as never,
      {} as never,
      {
        findLidsForPhone: jest.fn().mockResolvedValue([]),
        findPhoneForLid: jest.fn().mockResolvedValue(null),
      } as never,
      {} as never,
      {} as never,
    );
    infra = new InfraDataService(
      { get: (name: string, fallback: unknown) => (name === 'dataDatabase.type' ? 'postgres' : fallback) } as never,
      ds,
    );
  });
  afterAll(async () => {
    releaseGate?.();
    if (ds?.isInitialized) await ds.destroy();
    if (main?.isInitialized) await main.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    previousBudget = process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
    await ds.createQueryBuilder().delete().from(Message).execute();
    await ds.createQueryBuilder().delete().from(Session).execute();
    await ds.getRepository(Session).save(
      ds.getRepository(Session).create({
        id: SID,
        name: 'kept-session',
        status: SessionStatus.DISCONNECTED,
        phone: null,
        pushName: null,
        config: {},
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
      }),
    );
    for (const [id, second] of [
      [OLD, 0],
      [MID, 1],
      [NEW, 2],
    ] as const) {
      await repo.insert({
        id,
        sessionId: SID,
        waMessageId: id,
        chatId: A,
        from: A,
        to: 'me',
        body: `original-${second}`,
        type: 'image',
        timestamp: 1000 + second,
        direction: MessageDirection.INCOMING,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
        metadata: { media: { mimetype: 'image/png', data: 'A'.repeat(1000) } },
      });
    }
  });
  afterEach(() => {
    releaseGate?.();
    releaseGate = undefined;
    jest.restoreAllMocks();
    if (previousBudget === undefined) delete process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
    else process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = previousBudget;
  });

  it.each(['chat', 'time', 'type'] as const)('preserves the original %s selection after data restore', async drift => {
    const archive = await infra.exportData();
    const row = archive.tables.messages.find(message => message.id === MID)!;
    expect(row).toBeDefined();
    row.body = 'replacement-outside-selection';
    if (drift === 'chat') row.chatId = B;
    if (drift === 'time') row.timestamp = 2000;
    if (drift === 'type') row.type = 'document';
    const selection: GetMessagesOptions = {
      chatId: A,
      inlineMedia: false,
      ...(drift === 'time' ? { since: 1000000, until: 1003000, orderBy: 'timestamp' as const } : {}),
      ...(drift === 'type' ? { type: 'image' } : {}),
    };
    expect(await chatScope.allows(key, A)).toBe(true);
    expect(await chatScope.allows(key, B)).toBe(false);
    chatScope.requireChat(key, A);
    const entered = deferred();
    const proceed = deferred();
    releaseGate = proceed.resolve;
    const createRunner = ds.createQueryRunner.bind(ds);
    let paused = false;
    jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
      const runner = createRunner(...args);
      const query = runner.query.bind(runner);
      jest.spyOn(runner, 'query').mockImplementation(async (sql, ...parameters) => {
        if (!paused && /^\s*SELECT/i.test(sql) && sql.includes('"metadata"') && !sql.includes('OCTET_LENGTH')) {
          paused = true;
          entered.resolve();
          await proceed.promise;
        }
        return query(sql, ...parameters) as Promise<unknown>;
      });
      return runner;
    });
    const reading = service.getMessages(SID, selection);
    await entered.promise;
    try {
      expect(await infra.importData(archive as never)).toMatchObject({ imported: true, warnings: [] });
      // Data restore does not replace the separate main DB's key or its A-only allowlist.
      const currentKey = await main.getRepository(ApiKey).findOneByOrFail({ id: key.id });
      expect(currentKey.allowedChats).toEqual([A]);
      expect(await chatScope.allows(currentKey, B)).toBe(false);
    } finally {
      proceed.resolve();
    }
    const page = await reading;
    expect(page.messages.filter(message => message.id !== MID).map(message => message.id)).toEqual([NEW, OLD]);
    expect(new Set(page.messages.map(message => message.id)).size).toBe(page.messages.length);
    for (const message of page.messages) {
      expect(message.chatId).toBe(A);
      expect(message.body).not.toBe('replacement-outside-selection');
      if (drift === 'time') {
        expect(message.timestamp).toBeGreaterThanOrEqual(1000);
        expect(message.timestamp).toBeLessThan(1003);
      }
      if (drift === 'type') expect(message.type).toBe('image');
    }
  });
  it('still serves the picked page when the cursor row is deleted before its rows are read', async () => {
    const getMany = Object.getOwnPropertyDescriptor(SelectQueryBuilder.prototype, 'getMany')!
      .value as SelectQueryBuilder<Message>['getMany'];
    jest.spyOn(SelectQueryBuilder.prototype, 'getMany').mockImplementationOnce(async function (
      this: SelectQueryBuilder<Message>,
    ) {
      await repo.delete({ id: NEW });
      return getMany.call(this);
    });

    const page = await service.getMessages(SID, { chatId: A, after: NEW, inlineMedia: false });

    expect(page.total).toBe(3);
    expect(page.messages.map(message => message.id)).toEqual([MID, OLD]);
  });
  it('keeps newest-first ordering and encoded inline budget without restore', async () => {
    process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = '1500';
    const page = await service.getMessages(SID, { chatId: A });
    expect(page.messages.map(message => message.id)).toEqual([NEW, MID, OLD]);
    const inline = page.messages.map(message => (message.metadata.media as { data?: string }).data);
    expect(inline.map(data => typeof data === 'string')).toEqual([true, false, false]);
    expect(inline.reduce((bytes, data) => bytes + (data?.length ?? 0), 0)).toBeLessThanOrEqual(1500);
    const metadataOnly = await service.getMessages(SID, { chatId: A, inlineMedia: false });
    expect(metadataOnly.messages.map(message => message.id)).toEqual([NEW, MID, OLD]);
    for (const message of metadataOnly.messages) expect(message.metadata.media).toMatchObject({ omitted: true });
  });
});

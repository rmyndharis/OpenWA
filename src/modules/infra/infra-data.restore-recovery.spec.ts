jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import 'reflect-metadata';
import { AsyncResource } from 'async_hooks';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { InfraDataService, type InfraExportDataResult } from './infra-data.service';
import { readExport } from '../../../test/helpers/read-export';
import { createSqlitePrepareDatabase, type SqliteJournalMode } from '../../database/sqlite-pragmas';
import { LoggerService } from '../../common/services/logger.service';
import { RecoveryJournal } from '../../common/utils/recovery-journal';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
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
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';
import { WebhookDeliveryService, type WebhookJobData } from '../webhook/webhook-delivery.service';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookReconcilerService } from '../webhook/webhook-reconciler.service';
import { WebhookProcessor } from '../queue/processors/webhook.processor';
import { MessageProjector } from '../session/message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from '../session/session-lid-resolver.service';
import { dataHash } from '../webhook/utils/deliver-once';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const ENTITIES = [
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

/** The messages the archive restores: more than one chunk, so the restore yields between two of them. */
const ROWS = 600;
const CHAT = '628111@c.us';
const KEY = 'msg_s1_WA-3_w1';

type Tables = InfraExportDataResult['tables'];

/**
 * A data import (POST /api/infra/import-data) that restores a SQLite file on its own connection, while the message
 * changes, the queued webhook jobs, the sweep and the recovery queue go on against the shared one. What they issue
 * meanwhile is held until the restore commits, then runs against the restored data: nothing is refused, so nothing is
 * kept, no attempt is spent and no recovery hold follows. A change kept before the import, still kept when it runs,
 * lands once after the commit.
 */
describe.each<SqliteJournalMode>(['WAL', 'DELETE'])(
  'a SQLite data import (%s journal) beside the recovery work',
  journal => {
    const mockFetch = undiciFetch as jest.Mock;
    let dir: string;
    let file: string;
    let ds: DataSource;
    let archive: Tables;
    let outbox: WebhookOutboxService;
    let delivery: WebhookDeliveryService;
    let webhookService: WebhookService;
    let reconciler: WebhookReconcilerService;
    let projector: MessageProjector;
    let hooks: HookManager;
    let recoveryJournal: RecoveryJournal;
    // Writes of the messages and outbox tables on the shared connection fail while set: the database refuses them.
    let refusing: boolean;
    let warn: jest.SpyInstance;
    let error: jest.SpyInstance;

    const config = {
      get: (key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          'dataDatabase.type': 'sqlite',
          'queue.enabled': false,
          'webhook.timeout': 5000,
          'webhook.retryDelay': 50,
          'webhook.maxPayloadBytes': 1024 * 1024,
          'webhook.mediaInlineMaxBytes': 1024 * 1024,
        };
        return key in values ? values[key] : fallback;
      },
    } as unknown as ConfigService;
    const sessionsService = { getActiveSessionIds: () => [], forgetSession: jest.fn() };
    const infra = (): InfraDataService =>
      new InfraDataService(config, ds, undefined, sessionsService as never, undefined, undefined);
    const open = (): Promise<DataSource> =>
      new DataSource({
        type: 'better-sqlite3',
        database: file,
        // Short, so a statement that met the restore's lock would fail the test instead of waiting it out.
        timeout: 1_500,
        prepareDatabase: createSqlitePrepareDatabase(file, journal),
        entities: ENTITIES,
        synchronize: true,
      }).initialize();
    const message = (id: string, body: string) => ({
      sessionId: 's1',
      waMessageId: id,
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      body,
      type: 'text',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: 1_700_000_000,
    });
    const deliveryData = (body: string) => ({
      id: 'WA-3',
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      fromMe: false,
      type: 'text',
      body,
      timestamp: 1_700_000_000,
    });
    const actions = (spy: jest.SpyInstance): unknown[] =>
      (spy.mock.calls as unknown[][]).map(call => (call.at(-1) as { action?: string } | undefined)?.action);
    const rowOf = (id: string) => ds.getRepository(Message).findOneByOrFail({ sessionId: 's1', waMessageId: id });

    /**
     * Runs `action` once, at the restore's first insert of messages on its own connection, in the context of the caller
     * of this function, as another request or an engine event would issue it meanwhile.
     */
    const atRestoreInsert = (action: () => void): void => {
      const outside = AsyncResource.bind(action);
      let ran = false;
      const query = Reflect.get(BetterSqlite3QueryRunner.prototype, 'query') as (
        this: unknown,
        ...args: unknown[]
      ) => Promise<unknown>;
      jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
        this: BetterSqlite3QueryRunner,
        text: string,
        ...rest: unknown[]
      ) {
        if (this.connection !== ds && !ran && /^INSERT INTO "?messages/i.test(text)) {
          ran = true;
          outside();
        }
        if (
          this.connection === ds &&
          refusing &&
          /^(INSERT|UPDATE|DELETE)\b.*"?(messages|webhook_outbox_events)"?/is.test(text)
        ) {
          return Promise.reject(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }));
        }
        return query.call(this, text, ...rest) as never;
      });
    };

    beforeAll(async () => {
      jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
      dir = mkdtempSync(join(tmpdir(), 'owa-restore-recovery-'));
      file = join(dir, 'data.sqlite');
      ds = await open();
      await ds.getRepository(Session).save({ id: 's1', name: 'restored', status: SessionStatus.READY, config: {} });
      await ds.getRepository(Webhook).save({
        id: 'w1',
        sessionId: 's1',
        url: 'https://receiver.example/hook',
        events: ['*'],
        secret: null,
        headers: {},
        filters: null,
        active: true,
        retryCount: 3,
      });
      await ds.getRepository(Message).save(
        Array.from({ length: ROWS }, (_, i) => message(`WA-${i}`, `restored ${i}`)),
        { chunk: 200 },
      );
      await ds.getRepository(WebhookOutboxEvent).insert({
        webhookId: 'w1',
        sessionId: 's1',
        event: 'message.received',
        idempotencyKey: KEY,
        deliveryId: 'd1',
        payload: deliveryData('restored text'),
        state: 'queued',
      });
      archive = (await readExport(infra().exportData())).tables;
      await ds.destroy();
    });

    beforeEach(async () => {
      warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
      error = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
      mockFetch.mockReset();
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
      refusing = false;
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
      rmSync(join(dir, 'recovery-journal.jsonl'), { force: true });
      ds = await open();
      // The data as it is before the import: the session and webhook, a few of its messages, a queued delivery.
      await ds.getRepository(Session).save({ id: 's1', name: 'before', status: SessionStatus.READY, config: {} });
      await ds.getRepository(Webhook).save({
        id: 'w1',
        sessionId: 's1',
        url: 'https://receiver.example/hook',
        events: ['*'],
        secret: null,
        headers: {},
        filters: null,
        active: true,
        retryCount: 3,
      });
      await ds.getRepository(Message).save([message('WA-3', 'before 3'), message('WA-4', 'before 4')]);
      await ds.getRepository(WebhookOutboxEvent).insert({
        webhookId: 'w1',
        sessionId: 's1',
        event: 'message.received',
        idempotencyKey: KEY,
        deliveryId: 'd1',
        payload: deliveryData('before text'),
        state: 'queued',
      });
      hooks = new HookManager();
      recoveryJournal = new RecoveryJournal(join(dir, 'recovery-journal.jsonl'));
      outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent), recoveryJournal);
      delivery = new WebhookDeliveryService(
        ds.getRepository(Webhook),
        ds.getRepository(WebhookDeliveryFailure),
        config,
        hooks,
        outbox,
        undefined,
        undefined,
        recoveryJournal,
      );
      webhookService = new WebhookService(
        ds.getRepository(Webhook),
        ds.getRepository(WebhookDeliveryFailure),
        ds.getRepository(Session),
        config,
        delivery,
      );
      reconciler = new WebhookReconcilerService(ds.getRepository(Webhook), outbox, delivery, config);
      const engines = new EngineRegistry();
      engines.set('s1', {} as IWhatsAppEngine);
      projector = new MessageProjector(
        ds.getRepository(Message),
        ds.getRepository(Session),
        engines,
        new Proxy({}, { get: () => jest.fn() }) as unknown as EventsGateway,
        webhookService,
        hooks,
        {} as unknown as StatusStoreService,
        { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
        config,
      );
      delivery.onApplicationBootstrap();
    });

    afterEach(async () => {
      refusing = false;
      await delivery.onModuleDestroy();
      await reconciler.onModuleDestroy();
      await outbox.onModuleDestroy();
      recoveryJournal.close();
      jest.restoreAllMocks();
      jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
      await ds.destroy();
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('applies an engine revoke and an edit issued mid-restore to the restored rows, keeping nothing', async () => {
      const changes: Promise<unknown>[] = [];
      atRestoreInsert(() => {
        changes.push(
          projector.recordRevoke('s1', 'WA-1', { kind: 'revoke', chatId: CHAT, fromMe: false }, true),
          projector.recordOutboundMessageEdit('s1', 'WA-2', 'edited text', {
            kind: 'edit',
            chatId: CHAT,
            fromMe: false,
          }),
        );
      });

      await expect(infra().importData({ tables: archive })).resolves.toMatchObject({ imported: true });
      await Promise.all(changes);

      expect(changes).toHaveLength(2);
      // Written to the rows the import restored, which a change landing before its commit would not have reached.
      expect(await rowOf('WA-1')).toMatchObject({ type: 'revoked', body: '' });
      expect(await rowOf('WA-2')).toMatchObject({ body: 'edited text' });
      expect(actions(warn)).not.toContain('message_change_parked');
      expect(delivery.recoveryQueue().size).toBe(0);
    });

    it('lets a queued job whose outbox read was issued mid-restore deliver what the restored row holds, spending no attempt', async () => {
      const processor = new WebhookProcessor(
        ds.getRepository(Webhook),
        ds.getRepository(WebhookDeliveryFailure),
        hooks,
        config,
        outbox,
        ds.getRepository(Message),
      );
      const moveToDelayed = jest.fn();
      const job = {
        id: 'd1',
        attemptsMade: 1,
        attemptsStarted: 2,
        moveToDelayed,
        data: {
          webhookId: 'w1',
          url: 'https://receiver.example/hook',
          event: 'message.received',
          payload: {
            event: 'message.received',
            timestamp: new Date().toISOString(),
            sessionId: 's1',
            idempotencyKey: KEY,
            deliveryId: 'd1',
            data: deliveryData('before text'),
          },
          attempt: 2,
          maxRetries: 3,
          baseHash: dataHash(deliveryData('before text')),
        },
      } as unknown as Job<WebhookJobData>;
      let processed: Promise<unknown> | undefined;
      atRestoreInsert(() => {
        processed = processor.process(job, 'tok');
      });

      await expect(infra().importData({ tables: archive })).resolves.toMatchObject({ imported: true });

      await expect(processed).resolves.toMatchObject({ success: true });
      expect(moveToDelayed).not.toHaveBeenCalled();
      const posted = mockFetch.mock.calls.map(
        ([, init]) => (JSON.parse((init as { body: string }).body) as { data: { body: string } }).data.body,
      );
      // Read after the commit: the outbox row the import restored, not the one it replaced.
      expect(posted).toEqual(['restored text']);
      expect(await ds.getRepository(WebhookDeliveryFailure).count()).toBe(0);
    });

    it('gives the sweep no recovery hold for a pass that ran mid-restore', async () => {
      const options = { intervalMs: 60_000, graceMs: 30_000, batchSize: 50, maxAttempts: 5 };
      let swept: Promise<unknown> | undefined;
      atRestoreInsert(() => {
        swept = reconciler.sweep(options, new Date(Date.now() + 60_000));
      });

      await expect(infra().importData({ tables: archive })).resolves.toMatchObject({ imported: true });
      await swept;
      await reconciler.sweep(options, new Date(Date.now() + 120_000));

      expect(actions(warn)).not.toContain('webhook_reconcile_recovery_hold');
      expect((reconciler as unknown as { holdUntil: number }).holdUntil).toBe(0);
    });

    it('lands a change kept before the import once, after its commit, on the restored row', async () => {
      const announced: string[] = [];
      hooks.register('spec', 'message:persisted', ctx => {
        const { message: row } = ctx.data as { message: Message };
        announced.push(`${row.waMessageId} ${row.type}`);
        return Promise.resolve({ continue: true });
      });
      // The database answers again as the import runs, and the kept change is tried while its rows are restored.
      let retried: Promise<void> | undefined;
      atRestoreInsert(() => {
        refusing = false;
        retried = projector.retryParkedChanges();
      });
      refusing = true;
      await projector.recordRevoke('s1', 'WA-4', { kind: 'revoke', chatId: CHAT, fromMe: false }, true);
      for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
      expect(actions(warn)).toContain('message_change_parked');
      expect(delivery.recoveryQueue().size).toBe(1);

      await expect(infra().importData({ tables: archive })).resolves.toMatchObject({ imported: true });
      await retried;
      await projector.retryParkedChanges();

      expect(await rowOf('WA-4')).toMatchObject({ type: 'revoked', body: '' });
      expect(announced).toEqual(['WA-4 revoked']);
      expect(delivery.recoveryQueue().size).toBe(0);
      expect(actions(error)).not.toContain('message_change_lost');
      expect(readFileSync(join(dir, 'recovery-journal.jsonl'), 'utf8')).toBe('');
    });
  },
);

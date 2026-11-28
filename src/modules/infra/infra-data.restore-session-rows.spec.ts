import 'reflect-metadata';
import { AsyncResource } from 'async_hooks';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { ConfigService } from '@nestjs/config';
import { InfraDataService, type InfraExportDataResult } from './infra-data.service';
import { readExport } from '../../../test/helpers/read-export';
import { createSqlitePrepareDatabase } from '../../database/sqlite-pragmas';
import { LoggerService } from '../../common/services/logger.service';
import { RecoveryJournal } from '../../common/utils/recovery-journal';
import { RecoveryQueue, recoveryQueueOptions } from '../../common/utils/recovery-queue';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { SessionEngineLifecycle } from '../session/session-engine-lifecycle.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { SessionService } from '../session/session.service';
import { SessionErrorStore } from '../session/session-error-store.service';
import { SessionRestrictionStore } from '../session/session-restriction-store.service';
import { STOP_MOVES } from '../session/session-row-park';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message } from '../message/entities/message.entity';
import { BatchStatus, MessageBatch } from '../message/entities/message-batch.entity';
import { BulkMessageService } from '../message/bulk-message.service';
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

/**
 * A data import (POST /api/infra/import-data) replaces the rows of the sessions it restores. A write of one of those
 * rows the database refused before the import, still kept, is about the row the import replaced: it must not land on
 * the restored one, neither after the commit nor when it is tried while the restore holds the shared connection. The
 * same holds for a kept reap of the batches a takeover of one of those sessions left behind.
 */
describe('a SQLite data import beside the session row writes kept for the database', () => {
  let dir: string;
  let file: string;
  let ds: DataSource;
  let archive: InfraExportDataResult['tables'];
  let journal: RecoveryJournal;
  let queue: RecoveryQueue;
  let lifecycle: SessionEngineLifecycle;
  let service: SessionService;

  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ 'dataDatabase.type': 'sqlite', 'queue.enabled': false })[key] ?? fallback,
  } as unknown as ConfigService;
  const open = (): Promise<DataSource> =>
    new DataSource({
      type: 'better-sqlite3',
      database: file,
      timeout: 1_500,
      prepareDatabase: createSqlitePrepareDatabase(file, 'WAL'),
      entities: ENTITIES,
      synchronize: true,
    }).initialize();
  const infra = (sessions?: SessionService): InfraDataService =>
    new InfraDataService(config, ds, undefined, sessions, undefined, undefined);
  const unavailable = (): Error => Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
  const desiredState = async (): Promise<Session['desiredState']> =>
    (await ds.getRepository(Session).findOneByOrFail({ id: 's1' })).desiredState;
  const batchOf = (batchId: string, status: BatchStatus): Partial<MessageBatch> => ({
    batchId,
    sessionId: 's1',
    status,
    messages: [{ chatId: '628222@c.us', type: 'text', content: { text: 'hello' } }] as MessageBatch['messages'],
    progress: { total: 1, pending: 1, sent: 0, failed: 0, cancelled: 0 },
    results: [],
  });
  const batchStatus = async (batchId: string): Promise<BatchStatus> =>
    (await ds.getRepository(MessageBatch).findOneByOrFail({ batchId })).status;

  /** Runs `action` once, at the restore's first insert on its own connection, as another caller would issue it. */
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
      if (this.connection !== ds && !ran && /^INSERT INTO/i.test(text)) {
        ran = true;
        outside();
      }
      return query.call(this, text, ...rest) as never;
    });
  };

  beforeAll(async () => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'owa-restore-session-rows-'));
    file = join(dir, 'data.sqlite');
    ds = await open();
    // The backup holds the session as an operator left it: not stopped, linked to 628111, with a batch running.
    await ds.getRepository(Session).save({
      id: 's1',
      name: 'restored',
      status: SessionStatus.DISCONNECTED,
      phone: '628111',
      config: {},
    });
    await ds.getRepository(MessageBatch).save(batchOf('restored', BatchStatus.PROCESSING));
    archive = (await readExport(infra().exportData())).tables;
    await ds.destroy();
  });

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
    rmSync(join(dir, 'recovery-journal.jsonl'), { force: true });
    ds = await open();
    await ds.getRepository(Session).save({
      id: 's1',
      name: 'before',
      status: SessionStatus.DISCONNECTED,
      phone: '628111',
      config: {},
    });
    journal = new RecoveryJournal(join(dir, 'recovery-journal.jsonl'));
    queue = new RecoveryQueue({
      ...recoveryQueueOptions(false, 60_000),
      baseDelayMs: 600_000,
      capDelayMs: 600_000,
      journal,
    });
    queue.ready();
    const sessions = ds.getRepository(Session);
    const registry = new EngineRegistry();
    const errors = new SessionErrorStore();
    const restrictions = new SessionRestrictionStore();
    const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
    const watchdog = { clear: jest.fn(), start: jest.fn(), stop: jest.fn() };
    const presence = { clear: jest.fn(), getOwnIntent: jest.fn() };
    lifecycle = new SessionEngineLifecycle(
      sessions,
      ds,
      { create: jest.fn(), purgeSessionData: jest.fn() } as never,
      registry,
      watchdog as never,
      { holdsInbound: false, settleParkedChanges: jest.fn(), forgetSession: (id: string) => queue.forget(id) } as never,
      errors,
      restrictions,
      presence as never,
      { emitSessionStatus: jest.fn() } as never,
      { dispatch: jest.fn().mockResolvedValue(undefined), recoveryQueue: () => queue } as never,
      hooks as never,
      {} as never,
      config,
    );
    service = new SessionService(
      sessions,
      ds.getRepository(Message),
      ds,
      registry,
      watchdog as never,
      errors,
      restrictions,
      presence as never,
      hooks as never,
      lifecycle,
      {} as never,
      config,
    );
    // An operator's force-kill of the session the database refused to record: kept, the kill done.
    expect(lifecycle.rows.keep('s1', { field: 'desiredState', moves: STOP_MOVES }, unavailable())).toBe(true);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    await queue.drain(0);
    journal.close();
    await ds.destroy();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * node-b takes s1 over from node-a, whose lease lapsed, and the database refuses the reap of the batch node-a left:
   * it is kept in the session lane, to run once the database answers while that claim stands.
   */
  async function takenOverWithKeptReap(): Promise<void> {
    const sessions = ds.getRepository(Session);
    const batches = ds.getRepository(MessageBatch);
    await sessions.update('s1', {
      nodeId: 'node-a',
      claimedAt: new Date(Date.now() - 300_000),
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    await batches.save(batchOf('left-behind', BatchStatus.PROCESSING));
    const settings: Record<string, unknown> = { 'session.nodeId': 'node-b' };
    const ownership = new SessionOwnershipService(sessions, {
      get: (key: string, fallback?: unknown) => settings[key] ?? fallback,
    } as never);
    const bulk = new BulkMessageService(
      batches,
      new EngineRegistry(),
      {} as never,
      {} as never,
      {} as never,
      ownership,
      undefined,
      undefined,
      undefined,
      { recoveryQueue: () => queue } as never,
    );
    bulk.onModuleInit();
    jest.spyOn(bulk, 'reapProcessingBatches').mockRejectedValueOnce(unavailable());
    await expect(ownership.claim('s1')).resolves.toBe(true);
    expect(queue.get('session', 's1:batches')).toBeDefined();
  }

  it('drops the write it kept for a session the import restores', async () => {
    await expect(infra(service).importData({ tables: archive })).resolves.toMatchObject({ imported: true });
    await queue.flush();

    expect(await desiredState()).toBeNull();
    expect([...queue.records('session')]).toHaveLength(0);
  });

  it('lands nothing on the restored row when it is tried while the restore runs', async () => {
    let tried: Promise<void> | undefined;
    atRestoreInsert(() => {
      tried = queue.flush();
    });

    await expect(infra(service).importData({ tables: archive })).resolves.toMatchObject({ imported: true });
    await tried;
    await queue.flush();

    expect(tried).toBeDefined();
    expect(await desiredState()).toBeNull();
  });

  it('drops a kept takeover reap of a session it restores', async () => {
    await takenOverWithKeptReap();

    await expect(infra(service).importData({ tables: archive })).resolves.toMatchObject({ imported: true });
    await queue.flush();

    expect(await batchStatus('restored')).toBe(BatchStatus.PROCESSING);
    expect([...queue.records('session')]).toHaveLength(0);
  });

  it('fails none of the batches it restores with a kept takeover reap tried while the restore runs', async () => {
    await takenOverWithKeptReap();
    let tried: Promise<void> | undefined;
    atRestoreInsert(() => {
      tried = queue.flush();
    });

    await expect(infra(service).importData({ tables: archive })).resolves.toMatchObject({ imported: true });
    await tried;
    await queue.flush();

    expect(tried).toBeDefined();
    expect(await batchStatus('restored')).toBe(BatchStatus.PROCESSING);
  });

  it('keeps a status write refused after it, guarded on the status this process last wrote', async () => {
    await lifecycle.updateStatus('s1', SessionStatus.DISCONNECTED);
    await expect(infra(service).importData({ tables: archive })).resolves.toMatchObject({ imported: true });
    // The restored row holds that status too, and the database refuses the next status write of the session.
    jest.spyOn(ds.getRepository(Session), 'update').mockRejectedValueOnce(unavailable());
    await expect(lifecycle.updateStatus('s1', SessionStatus.FAILED)).rejects.toThrow('disk I/O error');

    await queue.flush();

    expect((await ds.getRepository(Session).findOneByOrFail({ id: 's1' })).status).toBe(SessionStatus.FAILED);
  });
});

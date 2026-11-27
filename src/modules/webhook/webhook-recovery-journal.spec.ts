jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import 'reflect-metadata';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { ConfigService } from '@nestjs/config';
import { fetch as undiciFetch } from 'undici';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookService } from './webhook.service';
import { WebhookReconcilerService } from './webhook-reconciler.service';
import { MessageProjector } from '../session/message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { HookManager } from '../../core/hooks';
import { EventsGateway } from '../events/events.gateway';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from '../session/session-lid-resolver.service';
import { LoggerService } from '../../common/services/logger.service';
import { RecoveryJournal } from '../../common/utils/recovery-journal';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

const CHAT = '628111@c.us';

/** What the database refused, kept in the journal across a restart or a crash of the process (SQLite). */
describe('What the database refused, across a restart', () => {
  const mockFetch = undiciFetch as jest.Mock;
  let dir: string;
  let ds: DataSource;
  let sessionId: string;
  let webhook: Webhook;
  // 'on': every statement fails; 'writes': the database reads but refuses every write.
  let outage: 'off' | 'on' | 'writes';
  let node: Awaited<ReturnType<typeof boot>>;
  const configService = {
    get: <T>(key: string, defaultValue?: T): T => {
      const values: Record<string, unknown> = {
        'queue.enabled': false,
        'webhook.dispatchConcurrency': 8,
        'webhook.dispatchMaxQueued': 100,
        'webhook.timeout': 5000,
        'webhook.retryDelay': 50,
        'webhook.shutdownDrainMs': 1000,
        'webhook.failurePayloadRetentionHours': 0,
        'webhook.maxPayloadBytes': 1024 * 1024,
        'webhook.mediaInlineMaxBytes': 1024,
      };
      return (key in values ? values[key] : defaultValue) as T;
    },
  } as unknown as ConfigService;

  /**
   * One process: its services over the shared database, with the journal it opens at start. `engine` says whether the
   * session's engine runs yet; `plugins` stands in for the plugin restore at start, done once it settles.
   */
  const boot = ({
    engine = true,
    plugins,
    queue,
  }: { engine?: boolean; plugins?: Promise<void>; queue?: Record<string, unknown> } = {}) => {
    const journal = new RecoveryJournal(join(dir, 'recovery-journal.jsonl'));
    const hookManager = new HookManager();
    const outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent), journal);
    const queueOn = {
      get: <T>(key: string, defaultValue?: T): T =>
        (key === 'queue.enabled'
          ? true
          : (configService as unknown as { get: (key: string, defaultValue?: unknown) => unknown }).get(
              key,
              defaultValue,
            )) as T,
    } as unknown as ConfigService;
    const delivery = new WebhookDeliveryService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      queue ? queueOn : configService,
      hookManager,
      outbox,
      undefined,
      queue as never,
      journal,
      plugins && ({ whenRestored: () => plugins } as unknown as PluginLoaderService),
    );
    const webhookService = new WebhookService(
      ds.getRepository(Webhook),
      ds.getRepository(WebhookDeliveryFailure),
      ds.getRepository(Session),
      configService,
      delivery,
    );
    const reconciler = new WebhookReconcilerService(ds.getRepository(Webhook), outbox, delivery, configService);
    const engines = new EngineRegistry();
    if (engine) engines.set(sessionId, {} as IWhatsAppEngine);
    const projector = new MessageProjector(
      ds.getRepository(Message),
      ds.getRepository(Session),
      engines,
      new Proxy({}, { get: () => jest.fn() }) as unknown as EventsGateway,
      webhookService,
      hookManager,
      {} as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      configService,
    );
    delivery.onApplicationBootstrap();
    return { journal, hookManager, outbox, delivery, webhookService, reconciler, projector, engines };
  };
  /** What `message:persisted` handlers of a process are handed, as type and body. */
  const persistedOn = (hookManager: HookManager): Array<[string, string]> => {
    const seen: Array<[string, string]> = [];
    hookManager.register('spec', 'message:persisted', ctx => {
      const { message } = ctx.data as { message: Message };
      seen.push([message.type, message.body ?? '']);
      return Promise.resolve({ continue: true });
    });
    return seen;
  };

  /** The process dies while the database is away: no pass of its own runs again, and the journal is all that is left. */
  const crash = (): Promise<void> => {
    outage = 'on';
    const queue = node.delivery.recoveryQueue() as unknown as {
      stopped: Set<string>;
      timer?: ReturnType<typeof setTimeout>;
    };
    clearTimeout(queue.timer);
    for (const lane of ['send', 'change', 'dispatch']) queue.stopped.add(lane);
    node.journal.close();
    // Nothing of the dead process reaches the file the next one opens.
    node.journal.put = () => false;
    node.journal.del = () => undefined;
    return Promise.resolve();
  };

  /** The process stops on its own, shutdown passes included, while the database is still away. */
  const shutdown = async (): Promise<void> => {
    outage = 'on';
    await node.projector.settleParkedChanges(0);
    await node.delivery.onModuleDestroy();
    node.journal.close();
  };

  const settle = async (turns = 60): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
  };
  /** The database answers again: what was kept runs now rather than on its timer. */
  const recover = async (): Promise<void> => {
    outage = 'off';
    await node.projector.retryParkedChanges();
    await settle();
  };
  const posted = (): Array<{ event: string; key: string; data: Record<string, unknown> }> =>
    mockFetch.mock.calls.map(([, init]) => {
      const { body, headers } = init as { body: string; headers: Record<string, string> };
      const parsed = JSON.parse(body) as { event: string; data: Record<string, unknown> };
      return { event: parsed.event, key: headers['X-OpenWA-Idempotency-Key'], data: parsed.data };
    });
  const received = (id = 'J-1') => ({
    id,
    chatId: CHAT,
    from: CHAT,
    to: '628222@c.us',
    fromMe: false,
    type: 'text',
    body: 'first text',
    timestamp: 1_700_000_000,
  });
  const storeRow = (id = 'J-1') =>
    ds.getRepository(Message).insert({
      sessionId,
      waMessageId: id,
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      body: 'first text',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 1_700_000_000,
    });
  const revoke = (id = 'J-1') =>
    node.projector.recordRevoke(sessionId, id, { kind: 'revoke', chatId: CHAT, fromMe: false }, true);
  const rowOf = (id = 'J-1') => ds.getRepository(Message).findOneByOrFail({ sessionId, waMessageId: id });
  const actions = (): unknown[] =>
    [
      ...((LoggerService.prototype.warn as jest.Mock).mock.calls as unknown[][]),
      ...((LoggerService.prototype.error as jest.Mock).mock.calls as unknown[][]),
    ].map(call => (call.at(-1) as { action?: string } | undefined)?.action);

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    outage = 'off';
    dir = mkdtempSync(join(tmpdir(), 'recovery-journal-restart-'));
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message, Webhook, WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();
    sessionId = (
      await ds
        .getRepository(Session)
        .save(ds.getRepository(Session).create({ name: 'journal', status: SessionStatus.READY, config: {} }))
    ).id;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below with the runner as `this`
    const realQuery = BetterSqlite3QueryRunner.prototype.query;
    jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
      this: BetterSqlite3QueryRunner,
      ...args: Parameters<BetterSqlite3QueryRunner['query']>
    ) {
      const write = !/^\s*SELECT/i.test(String(args[0]));
      if (outage === 'on' || (outage === 'writes' && write)) {
        return Promise.reject(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }));
      }
      return realQuery.apply(this, args);
    } as never);
    webhook = await ds.getRepository(Webhook).save(
      ds.getRepository(Webhook).create({
        sessionId,
        url: 'https://receiver.example/hook',
        events: ['*'],
        secret: null,
        headers: {},
        filters: null,
        active: true,
        retryCount: 1,
      }),
    );
    node = boot();
  });

  afterEach(async () => {
    outage = 'off';
    await node.delivery.onModuleDestroy();
    await node.reconciler.onModuleDestroy();
    await node.outbox.onModuleDestroy();
    node.journal.close();
    await ds.destroy();
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['a crash', () => crash()],
    ['a shutdown', () => shutdown()],
  ] as const)('dispatches an event kept before %s once the database answers, under the same key', async (_l, stop) => {
    outage = 'on';
    await node.webhookService.dispatch(sessionId, 'message.received', received());
    expect(mockFetch).not.toHaveBeenCalled();

    await stop();
    node = boot();
    await recover();

    expect(posted().map(({ event, key, data }) => [event, key, data.body])).toEqual([
      ['message.received', `msg_${sessionId}_J-1_${webhook.id}`, 'first text'],
    ]);
    expect(actions()).toContain('recovery_journal_restored');
  });

  it('withdraws an announcement kept before a crash by a revoke kept with it, before it goes out', async () => {
    await storeRow();
    outage = 'on';
    await revoke();
    await node.webhookService.dispatch(sessionId, 'message.received', received());

    await crash();
    node = boot();
    await recover();

    expect(posted()).toEqual([]);
    expect(await rowOf()).toMatchObject({ type: 'revoked', body: '' });
  });

  it("keeps none of a session's state events across a restart", async () => {
    outage = 'on';
    await node.webhookService.dispatch(sessionId, 'session.status', { sessionId, status: 'ready' });
    await node.webhookService.dispatch(sessionId, 'group.join', { sessionId, groupId: '1203@g.us' });
    expect(readFileSync(join(dir, 'recovery-journal.jsonl'), 'utf8')).not.toContain('session.status');

    await crash();
    node = boot();
    await recover();

    expect(posted().map(post => post.event)).toEqual(['group.join']);
  });

  it('skips a torn last line, and restores what comes before it', async () => {
    outage = 'on';
    await node.webhookService.dispatch(sessionId, 'message.received', received());
    await crash();
    appendFileSync(join(dir, 'recovery-journal.jsonl'), '{"l":"change","k":"torn","v":{"s"');

    node = boot();
    await recover();

    expect(posted().map(post => post.event)).toEqual(['message.received']);
    expect(actions()).toContain('recovery_journal_line_skipped');
  });

  it('holds a delivery the sweep would replay until a revoke kept before the restart lands', async () => {
    await storeRow();
    await node.outbox.open({
      webhookId: webhook.id,
      sessionId,
      event: 'message.received',
      idempotencyKey: `msg_${sessionId}_J-1_${webhook.id}`,
      deliveryId: 'delivery-J-1',
      payload: received(),
    });
    outage = 'writes';
    await revoke();

    await crash();
    node = boot();
    outage = 'writes';
    await node.reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    await settle();
    expect(posted()).toEqual([]);

    await recover();
    await node.reconciler.sweep(
      { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
      new Date(Date.now() + 1000),
    );
    await settle();

    expect(posted()).toEqual([]);
    expect(await rowOf()).toMatchObject({ type: 'revoked', body: '' });
  });

  it('writes an edit kept before a restart, and gives up one older than the content age cap', async () => {
    await storeRow('J-1');
    await storeRow('J-2');
    outage = 'on';
    const edit = (id: string) =>
      node.projector.recordOutboundMessageEdit(sessionId, id, 'edited text', {
        kind: 'edit',
        chatId: CHAT,
        fromMe: false,
      });
    await edit('J-1');
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now - 61 * 60 * 1000);
    await edit('J-2');
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await crash();
    node = boot();
    await recover();

    expect(await rowOf('J-1')).toMatchObject({ body: 'edited text' });
    expect(await rowOf('J-2')).toMatchObject({ body: 'first text' });
  });

  it("restores a message's records whose claims disagree each on its own, and holds its edit events again", async () => {
    await storeRow();
    outage = 'on';
    const edit = (chatId: string, body: string) =>
      node.projector.recordOutboundMessageEdit(sessionId, 'J-1', body, { kind: 'edit', chatId, fromMe: false });
    await edit(CHAT, 'edited text');
    await edit('628999@c.us', 'edited elsewhere');
    await revoke();
    const editEvent = { sessionId, event: 'message.edited', data: { messageId: 'J-1' } };

    await crash();
    node = boot();

    // The revoke took the place of the edit it agrees with; the edit of another chat is kept beside it.
    const changes = readFileSync(join(dir, 'recovery-journal.jsonl'), 'utf8')
      .split('\n')
      .filter(line => line.includes('"l":"change"'))
      .map(line => (JSON.parse(line) as { v: Record<string, { chatId?: string; judge?: { chatId: string } }> }).v);
    expect(changes.map(change => change.edit?.judge?.chatId ?? (change.revoke && 'revoke'))).toEqual([
      '628999@c.us',
      'revoke',
    ]);
    expect(node.outbox.isMessageHeld(`edit_${sessionId}_J-1_o1_${webhook.id}`, webhook.id, editEvent)).toBe(true);
    await recover();
    expect(await rowOf()).toMatchObject({ type: 'revoked', body: '' });
    expect(node.outbox.isMessageHeld(`edit_${sessionId}_J-1_o1_${webhook.id}`, webhook.id, editEvent)).toBe(false);
  });

  it("announces a revoke kept before a crash once it lands, though the session's engine is not running yet", async () => {
    await storeRow();
    outage = 'on';
    await revoke();

    await crash();
    node = boot({ engine: false });
    const persisted = persistedOn(node.hookManager);
    await recover();

    expect(await rowOf()).toMatchObject({ type: 'revoked', body: '' });
    expect(persisted).toEqual([['revoked', '']]);
  });

  it('announces nothing of a change kept for a session removed since', async () => {
    await storeRow();
    outage = 'on';
    await revoke();
    await crash();
    outage = 'off';
    await ds.getRepository(Message).delete({ sessionId });

    node = boot({ engine: false });
    const persisted = persistedOn(node.hookManager);
    await recover();

    expect(persisted).toEqual([]);
  });

  it('tries nothing it restored before the plugins are back, so their handlers hear it', async () => {
    await storeRow();
    outage = 'on';
    await revoke();
    await node.webhookService.dispatch(sessionId, 'group.join', { sessionId, groupId: '1203@g.us' });
    await crash();
    let restored!: () => void;

    node = boot({ engine: false, plugins: new Promise<void>(resolve => (restored = resolve)) });
    const persisted = persistedOn(node.hookManager);
    await recover();
    expect(await rowOf()).toMatchObject({ type: 'text', body: 'first text' });
    expect(posted()).toEqual([]);

    restored();
    await settle();
    await recover();
    expect(await rowOf()).toMatchObject({ type: 'revoked', body: '' });
    expect(persisted).toEqual([['revoked', '']]);
    expect(posted().map(post => post.event)).toEqual(['group.join']);
  });

  it('holds, from the start, the queued job of a message whose change the journal restored', async () => {
    const leases: Array<[string, unknown]> = [];
    const released: string[] = [];
    const job = { data: {}, getState: () => Promise.resolve('delayed'), updateData: () => Promise.resolve() };
    const queue = {
      toKey: (type: string) => `bull:webhook:${type}`,
      waitUntilReady: () => Promise.resolve(),
      getJob: () => Promise.resolve(job),
      getBackend: () => ({
        client: Promise.resolve({
          set: (key: string, _value: string, options: unknown) => (leases.push([key, options]), Promise.resolve('OK')),
          del: (key: string) => (released.push(key), Promise.resolve(1)),
        }),
      }),
    };
    await storeRow();
    // What the last process left: a revoke the database refused, and the copy of a queued delivery of the message.
    node.journal.close();
    appendFileSync(
      join(dir, 'recovery-journal.jsonl'),
      [
        {
          l: 'change',
          k: `${sessionId}:J-1#1`,
          v: {
            s: sessionId,
            m: 'J-1',
            t: Date.now(),
            revoke: { source: { kind: 'revoke', chatId: CHAT, fromMe: false }, announced: true, notify: true },
          },
        },
        {
          l: 'copy',
          k: `${webhook.id}\u0000msg_${sessionId}_J-1_${webhook.id}`,
          v: { s: sessionId, e: 'message.received', d: received(), r: null, q: 'd1' },
        },
      ]
        .map(line => `${JSON.stringify(line)}\n`)
        .join(''),
    );
    outage = 'on';

    node = boot({ queue });
    await settle();

    expect(leases).toEqual([['bull:webhook:held:d1', { PX: 60_000 }]]);
    expect(released).toEqual([]);
    await recover();
    expect(released).toEqual(['bull:webhook:held:d1']);
  });

  it('stores a message received before a crash, its row refused, once, with its announcement sent once', async () => {
    outage = 'on';
    void node.projector.handleInboundMessage(sessionId, node.engines.get(sessionId)!, received() as never);
    await settle(200);
    expect(readFileSync(join(dir, 'recovery-journal.jsonl'), 'utf8')).toContain('"l":"receive"');

    await crash();
    node = boot();
    const persisted = persistedOn(node.hookManager);
    await recover();
    await recover();

    const rows = await ds.getRepository(Message).find({ where: { sessionId } });
    expect(rows.map(row => [row.waMessageId, row.body])).toEqual([['J-1', 'first text']]);
    expect(posted().filter(post => post.event === 'message.received')).toHaveLength(1);
    expect(persisted).toEqual([['text', 'first text']]);
  });

  it('lets go of what it cannot read back as a record, and of copies whose queued job will never run here', async () => {
    node.journal.close();
    appendFileSync(
      join(dir, 'recovery-journal.jsonl'),
      [
        { l: 'change', k: `${sessionId}:J-1#1`, v: { s: sessionId, m: 'J-1', t: Date.now() } },
        { l: 'change', k: 'bad', v: null },
        { l: 'dispatch', k: `${sessionId}#1`, v: { s: sessionId, e: 'session.status', d: {}, o: 'o', t: 1 } },
        { l: 'dispatch', k: `${sessionId}#2`, v: { s: sessionId, e: 'message.received', d: null, o: 'o', t: 1 } },
        { l: 'copy', k: 'bad', v: { s: sessionId } },
        {
          l: 'copy',
          k: `${webhook.id}\u0000msg_${sessionId}_J-1_${webhook.id}`,
          v: { s: sessionId, e: 'message.received', d: received(), r: null, q: 'job-1' },
        },
      ]
        .map(line => `${JSON.stringify(line)}\n`)
        .join(''),
    );

    node = boot();
    await recover();

    expect(posted()).toEqual([]);
    expect(node.outbox.unwrittenCopy(webhook.id, `msg_${sessionId}_J-1_${webhook.id}`)).toBeUndefined();
    expect(actions()).toContain('recovery_journal_orphan');
    expect(readFileSync(join(dir, 'recovery-journal.jsonl'), 'utf8')).toBe('');
  });

  it('keeps nothing in the journal once what was kept settled', async () => {
    outage = 'on';
    await node.webhookService.dispatch(sessionId, 'message.received', received());
    await recover();

    expect(readFileSync(join(dir, 'recovery-journal.jsonl'), 'utf8')).toBe('');
  });
});

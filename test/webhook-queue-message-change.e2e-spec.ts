import { spawnSync } from 'node:child_process';

// Queue-on boot env, set BEFORE AppModule is imported below (see webhook-unreadable-message-id-queue.e2e-spec.ts). Its
// own key prefix keeps its jobs apart from those of the other queue suites sharing one Redis. The retry delay leaves a
// job waiting long enough for a change to reach the message between its attempts.
process.env.QUEUE_ENABLED = 'true';
process.env.REDIS_ENABLED = 'true';
process.env.QUEUE_PREFIX = 'openwa-e2e-change';
process.env.WEBHOOK_RETRY_DELAY = '1500';
const REDIS_HOST = process.env.QUEUE_TEST_REDIS_HOST || process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.QUEUE_TEST_REDIS_PORT || process.env.REDIS_PORT || '6379', 10);
process.env.REDIS_HOST = REDIS_HOST;
process.env.REDIS_PORT = String(REDIS_PORT);

// Jest registers suites synchronously and has no runtime skip, so the Redis probe settles synchronously too. Without
// Redis the suite is skipped on a developer box; under GitHub Actions an unreachable Redis is drift and fails it.
const probeRedis = (host: string, port: number, timeoutMs: number): boolean => {
  const script =
    `const s = require('net').connect(${port}, ${JSON.stringify(host)});` +
    `const t = setTimeout(() => process.exit(2), ${timeoutMs});` +
    `s.on('connect', () => { clearTimeout(t); s.end(); process.exit(0); });` +
    `s.on('error', () => { clearTimeout(t); process.exit(1); });`;
  return spawnSync(process.execPath, ['-e', script], { timeout: timeoutMs + 1000 }).status === 0;
};

const REDIS_AVAILABLE = probeRedis(REDIS_HOST, REDIS_PORT, 1000);
if (!REDIS_AVAILABLE && process.env.GITHUB_ACTIONS === 'true') {
  throw new Error(
    `webhook queue e2e: no Redis at ${REDIS_HOST}:${REDIS_PORT} under GitHub Actions (set REDIS_HOST/REDIS_PORT or ` +
      'QUEUE_TEST_REDIS_HOST/QUEUE_TEST_REDIS_PORT); refusing to skip',
  );
}
const describeQueueOn = REDIS_AVAILABLE ? describe : describe.skip;

import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';
import { QUEUE_NAMES } from '../src/modules/queue/queue-names';
import { Webhook } from '../src/modules/webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../src/modules/webhook/entities/webhook-outbox-event.entity';
import { Session } from '../src/modules/session/entities/session.entity';
import { Message, MessageDirection } from '../src/modules/message/entities/message.entity';
import { WebhookService } from '../src/modules/webhook/webhook.service';
import { WebhookReconcilerService } from '../src/modules/webhook/webhook-reconciler.service';
import { MessageProjector } from '../src/modules/session/message-projector.service';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

const CHAT = '628111@c.us';

/**
 * A message delivery handed to the queue is changed while its job waits: the job's next attempt, or the sweep's
 * replay of a job Redis lost, sends the message as the change left it, never the text the sender took back or edited.
 *
 * Needs a real Redis: `docker run -d -p 6379:6379 redis:7-alpine`, or QUEUE_TEST_REDIS_HOST and QUEUE_TEST_REDIS_PORT.
 */
describeQueueOn('A queued message delivery after its message changed (e2e)', () => {
  let app: INestApplication<App>;
  let receiver: http.Server;
  let receiverUrl: string;
  let receiverStatus: number;
  let webhookQueue: Queue;
  let webhookService: WebhookService;
  let reconciler: WebhookReconcilerService;
  let projector: MessageProjector;
  let webhooks: Repository<Webhook>;
  let outbox: Repository<WebhookOutboxEvent>;
  let sessions: Repository<Session>;
  let messages: Repository<Message>;
  let received: Array<{ body: string | undefined; type: string | undefined }>;
  const prevSsrf = process.env.WEBHOOK_SSRF_PROTECT;

  beforeAll(async () => {
    // The 127.0.0.1 receiver would trip the SSRF guard at delivery time; disabled for this suite as in the others.
    process.env.WEBHOOK_SSRF_PROTECT = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();
    webhookQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.WEBHOOK));
    webhookService = app.get(WebhookService);
    reconciler = app.get(WebhookReconcilerService);
    projector = app.get(MessageProjector);
    webhooks = app.get<Repository<Webhook>>(getRepositoryToken(Webhook, 'data'));
    outbox = app.get<Repository<WebhookOutboxEvent>>(getRepositoryToken(WebhookOutboxEvent, 'data'));
    sessions = app.get<Repository<Session>>(getRepositoryToken(Session, 'data'));
    messages = app.get<Repository<Message>>(getRepositoryToken(Message, 'data'));
    received = [];
    receiverStatus = 200;
    receiver = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { data?: { body?: string; type?: string } };
        received.push({ body: body.data?.body, type: body.data?.type });
        res.writeHead(receiverStatus).end();
      });
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  }, 60000);

  afterAll(async () => {
    await new Promise<void>(resolve => receiver?.close(() => resolve()));
    if (prevSsrf === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
    else process.env.WEBHOOK_SSRF_PROTECT = prevSsrf;
    await app?.close();
  });

  /** The worker has finished every job it was given, including one waiting out its retry backoff. */
  const queueIdle = async (): Promise<boolean> =>
    Object.values(await webhookQueue.getJobCounts('active', 'waiting', 'delayed', 'prioritized')).every(n => n === 0);

  // 'outbox writes': every write of the outbox table fails; 'on': every statement does.
  let outage: 'off' | 'outbox writes' | 'on' = 'off';
  beforeEach(() => {
    outage = 'off';
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below with the runner as `this`
    const realQuery = BetterSqlite3QueryRunner.prototype.query;
    jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
      this: BetterSqlite3QueryRunner,
      ...args: Parameters<BetterSqlite3QueryRunner['query']>
    ) {
      const sql = String(args[0]);
      const outboxWrite = !/^\s*SELECT/i.test(sql) && sql.includes('webhook_outbox_events');
      if (outage === 'on' || (outage === 'outbox writes' && outboxWrite)) {
        return Promise.reject(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }));
      }
      return realQuery.apply(this, args);
    } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  /** A stored message whose delivery failed once: its job waits for the retry, its outbox row is queued. */
  const failedOnce = async (
    during: 'off' | 'outbox writes' = 'off',
  ): Promise<{ sessionId: string; id: string; webhookId: string }> => {
    received.length = 0;
    receiverStatus = 500;
    const session = await sessions.save(sessions.create({ name: `queue-change-${Date.now()}-${Math.random()}` }));
    const webhook = await webhooks.save(
      webhooks.create({
        sessionId: session.id,
        url: receiverUrl,
        events: ['message.received'],
        active: true,
        retryCount: 4,
      }),
    );
    const id = `M-${Date.now()}-${Math.random()}`;
    await messages.insert({
      sessionId: session.id,
      waMessageId: id,
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      body: 'first text',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 1790000000,
    });
    outage = during;
    await webhookService.dispatch(session.id, 'message.received', {
      id,
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      fromMe: false,
      type: 'text',
      body: 'first text',
      timestamp: 1790000000,
    });
    await waitFor(() => received.length >= 1);
    outage = 'off';
    return { sessionId: session.id, id, webhookId: webhook.id };
  };

  const changes: Record<string, (sessionId: string, id: string) => Promise<void>> = {
    'an engine revoke': (sessionId, id) =>
      projector.recordRevoke(sessionId, id, { kind: 'revoke', chatId: CHAT, fromMe: false }, true),
    'a delete through the API': (sessionId, id) =>
      projector.recordRevoke(sessionId, id, { kind: 'revoke', chatId: CHAT }),
    'an edit': (sessionId, id) =>
      projector.recordOutboundMessageEdit(sessionId, id, 'edited text', { kind: 'edit', chatId: CHAT, fromMe: false }),
  };
  const expected: Record<string, Array<{ body: string | undefined; type: string | undefined }>> = {
    'an engine revoke': [],
    'a delete through the API': [{ body: '', type: 'revoked' }],
    'an edit': [{ body: 'edited text', type: 'text' }],
  };

  it.each(Object.keys(changes))(
    'retries as %s left the message, while its job waits',
    async change => {
      const { sessionId, id } = await failedOnce();

      await changes[change](sessionId, id);
      receiverStatus = 200;
      await waitFor(queueIdle);

      expect(received.slice(1)).toEqual(expected[change]);
    },
    60000,
  );

  it.each(Object.keys(changes))(
    'retries as %s left the message, while its job waits, though no outbox row could be written for it',
    async change => {
      const { sessionId, id, webhookId } = await failedOnce('outbox writes');
      expect(await outbox.countBy({ webhookId })).toBe(0);

      await changes[change](sessionId, id);
      receiverStatus = 200;
      await waitFor(queueIdle);

      expect(received.slice(1)).toEqual(expected[change]);
    },
    60000,
  );

  it('sends the edit of an event kept while the database was away, once its job waits', async () => {
    received.length = 0;
    const session = await sessions.save(sessions.create({ name: `queue-kept-${Date.now()}-${Math.random()}` }));
    await webhooks.save(
      webhooks.create({
        sessionId: session.id,
        url: receiverUrl,
        events: ['message.received'],
        active: true,
        retryCount: 4,
      }),
    );
    const id = `K-${Date.now()}-${Math.random()}`;
    await messages.insert({
      sessionId: session.id,
      waMessageId: id,
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      body: 'first text',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 1790000000,
    });
    outage = 'on';
    await webhookService.dispatch(session.id, 'message.received', {
      id,
      chatId: CHAT,
      from: CHAT,
      to: '628222@c.us',
      fromMe: false,
      type: 'text',
      body: 'first text',
      timestamp: 1790000000,
    });
    expect(received).toEqual([]);
    // The database answers: the kept event is dispatched, handed to the queue, and its first attempt fails.
    outage = 'off';
    receiverStatus = 500;
    await projector.retryParkedChanges();
    await waitFor(() => received.length >= 1);

    await changes['an edit'](session.id, id);
    receiverStatus = 200;
    await waitFor(queueIdle);

    expect(received.map(post => post.body)).toEqual(['first text', 'edited text']);
  }, 60000);

  it.each(Object.keys(changes))(
    'replays as %s left the message, once Redis lost its job',
    async change => {
      const { sessionId, id, webhookId } = await failedOnce();
      const row = await outbox.findOneByOrFail({ webhookId });
      await (await webhookQueue.getJob(row.deliveryId))?.remove();

      await changes[change](sessionId, id);
      receiverStatus = 200;
      await reconciler.sweep(
        { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
        new Date(Date.now() + 1000),
      );
      await waitFor(queueIdle);

      expect(received.slice(1)).toEqual(expected[change]);
    },
    60000,
  );
});

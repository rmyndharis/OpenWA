import { spawnSync } from 'node:child_process';

// Queue-on boot env, set BEFORE AppModule is imported below: QUEUE_ENABLED is read at module-eval time and the
// worker connection reads REDIS_* when the @Processor decorators evaluate (see queue-on.e2e-spec.ts). setup-e2e.ts
// forces the queue off for the e2e family; this suite opts back in. Its own key prefix keeps its jobs apart from
// those of the other queue suites sharing one Redis.
process.env.QUEUE_ENABLED = 'true';
process.env.REDIS_ENABLED = 'true';
process.env.QUEUE_PREFIX = 'openwa-e2e-noid';
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
import { WebhookDeliveryFailure } from '../src/modules/webhook/entities/webhook-delivery-failure.entity';
import { Session } from '../src/modules/session/entities/session.entity';
import { WebhookService } from '../src/modules/webhook/webhook.service';

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<void> => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

/**
 * A message whose id the engine could not read is announced with the empty id, and with the queue on its delivery is
 * a job that a worker settles: the worker closes the outbox row and clears the delivery-failure rows under the key the
 * job carries. Two such messages must carry two keys, or the delivery of one settles the records of the other. The
 * queue.add spy shows the delivery went through the queue and not through the direct fallback.
 *
 * Needs a real Redis: `docker run -d -p 6379:6379 redis:7-alpine`, or QUEUE_TEST_REDIS_HOST and QUEUE_TEST_REDIS_PORT.
 */
describeQueueOn('Webhook delivery of messages whose id could not be read, through the queue (e2e)', () => {
  let app: INestApplication<App>;
  let receiver: http.Server;
  let receiverUrl: string;
  let receiverStatus: number;
  let webhookQueue: Queue;
  let webhookService: WebhookService;
  let webhooks: Repository<Webhook>;
  let outbox: Repository<WebhookOutboxEvent>;
  let failures: Repository<WebhookDeliveryFailure>;
  let sessions: Repository<Session>;
  let received: Array<{ key: string | undefined; text: string }>;
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
    webhooks = app.get<Repository<Webhook>>(getRepositoryToken(Webhook, 'data'));
    outbox = app.get<Repository<WebhookOutboxEvent>>(getRepositoryToken(WebhookOutboxEvent, 'data'));
    failures = app.get<Repository<WebhookDeliveryFailure>>(getRepositoryToken(WebhookDeliveryFailure, 'data'));
    sessions = app.get<Repository<Session>>(getRepositoryToken(Session, 'data'));

    received = [];
    receiverStatus = 200;
    receiver = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { data?: { body?: string } };
        received.push({
          key: req.headers['x-openwa-idempotency-key'] as string | undefined,
          text: body.data?.body ?? '',
        });
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

  const newWebhook = async (retryCount?: number): Promise<{ sessionId: string; webhookId: string }> => {
    received.length = 0;
    receiverStatus = 200;
    const session = await sessions.save(
      sessions.create({ name: `unreadable-id-queue-${Date.now()}-${Math.random()}` }),
    );
    const webhook = await webhooks.save(
      webhooks.create({
        sessionId: session.id,
        url: receiverUrl,
        events: ['message.received'],
        active: true,
        retryCount,
      }),
    );
    return { sessionId: session.id, webhookId: webhook.id };
  };

  /**
   * The worker has finished every job it was given. A job completes only after the worker's bookkeeping (closing the
   * outbox row, clearing delivery-failure rows), so records read after this are final. dispatch() resolves once the
   * queue has accepted the job, so a job of an earlier dispatch is never missed here.
   */
  const queueIdle = async (): Promise<boolean> =>
    Object.values(await webhookQueue.getJobCounts('active', 'waiting', 'delayed', 'prioritized')).every(n => n === 0);

  const dispatchUnreadable = (sessionId: string, text: string): Promise<void> =>
    webhookService.dispatch(sessionId, 'message.received', {
      id: '',
      from: '628111111111@c.us',
      chatId: '628111111111@c.us',
      type: 'text',
      body: text,
      timestamp: 1790000000,
    });

  it('delivers two messages with an unreadable id under two keys, each retired by the worker through its own row', async () => {
    const { sessionId, webhookId } = await newWebhook();
    const addSpy = jest.spyOn(webhookQueue, 'add');
    try {
      await dispatchUnreadable(sessionId, 'first');
      await dispatchUnreadable(sessionId, 'second');
      expect(addSpy).toHaveBeenCalledTimes(2);
    } finally {
      addSpy.mockRestore();
    }

    await waitFor(queueIdle);
    expect(received.map(r => r.text).sort()).toEqual(['first', 'second']);
    expect(new Set(received.map(r => r.key)).size).toBe(2);
    expect(await outbox.countBy({ webhookId, state: 'dispatched' })).toBe(2);
    expect((await outbox.find({ where: { webhookId } })).map(r => r.idempotencyKey).sort()).toEqual(
      received.map(r => r.key).sort(),
    );
  }, 60000);

  it('keeps the dead-letter record of one message when the worker delivers another with an unreadable id', async () => {
    const { sessionId, webhookId } = await newWebhook(1);

    receiverStatus = 500;
    await dispatchUnreadable(sessionId, 'A');
    await waitFor(queueIdle);
    expect(await failures.countBy({ webhookId })).toBe(1);

    receiverStatus = 200;
    await dispatchUnreadable(sessionId, 'B');
    await waitFor(queueIdle);

    expect(received.filter(r => r.text === 'B')).toHaveLength(1);
    expect(await failures.countBy({ webhookId })).toBe(1);
    expect(await outbox.countBy({ webhookId })).toBe(2);
  }, 60000);
});

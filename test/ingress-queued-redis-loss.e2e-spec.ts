import { spawnSync } from 'node:child_process';

// Queue-on boot env, set BEFORE AppModule is imported below (see queue-on.e2e-spec.ts): QUEUE_ENABLED is read at
// module-eval time and the worker connection reads REDIS_* when the @Processor decorators evaluate. Its own key
// prefix keeps this suite's jobs apart from the other queue suites sharing one Redis.
process.env.QUEUE_ENABLED = 'true';
process.env.REDIS_ENABLED = 'true';
process.env.QUEUE_PREFIX = 'openwa-e2e-loss';
const REDIS_HOST = process.env.QUEUE_TEST_REDIS_HOST || process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.QUEUE_TEST_REDIS_PORT || process.env.REDIS_PORT || '6379', 10);
process.env.REDIS_HOST = REDIS_HOST;
process.env.REDIS_PORT = String(REDIS_PORT);

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
  throw new Error(`ingress queue e2e: no Redis at ${REDIS_HOST}:${REDIS_PORT} under GitHub Actions; refusing to skip`);
}
const describeQueueOn = REDIS_AVAILABLE ? describe : describe.skip;

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { json, urlencoded, Request } from 'express';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';
import { PluginLoaderService } from '../src/core/plugins/plugin-loader.service';
import { PluginInstance } from '../src/modules/integration/entities/plugin-instance.entity';
import { IngressEvent } from '../src/modules/integration/entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from '../src/modules/integration/entities/integration-delivery-failure.entity';
import { IngressReconcilerService } from '../src/modules/integration/ingress-reconciler.service';
import { sanitizeIngressJobId } from '../src/modules/integration/ingress-enqueue.service';
import { IngressJobData } from '../src/modules/queue/processors/ingress.processor';
import { WebhookReconcilerService } from '../src/modules/webhook/webhook-reconciler.service';
import { WebhookService } from '../src/modules/webhook/webhook.service';
import { Webhook } from '../src/modules/webhook/entities/webhook.entity';
import { WebhookOutboxEvent } from '../src/modules/webhook/entities/webhook-outbox-event.entity';
import { Session } from '../src/modules/session/entities/session.entity';
import { QUEUE_NAMES } from '../src/modules/queue/queue-names';

/**
 * A delivery acknowledged to the provider with the queue on survives a restart of the gateway, because its job waits
 * in Redis. The event row keeps its payload until the delivery has settled, so when Redis loses that one job (a hard
 * crash between AOF fsyncs, a failover to a replica that was behind, a restore from an earlier snapshot) the delivery
 * is still dispatched or dead-lettered by the recovery passes, as an outbound webhook delivery is for the same loss:
 * the provider was told 202 and will not send it again. The loss is made by removing the one job from Redis, which
 * leaves the same state as a snapshot taken before it was added.
 *
 * Needs a real Redis: `docker run -d -p 6379:6379 redis:7-alpine`, or QUEUE_TEST_REDIS_HOST and QUEUE_TEST_REDIS_PORT.
 */
describeQueueOn('An acknowledged ingress delivery whose job Redis loses (e2e, QUEUE_ENABLED=true)', () => {
  let app: INestApplication<App>;
  let ingressQueue: Queue<IngressJobData>;
  let dispatchWebhookForInstance: jest.Mock;
  let eventRepo: Repository<IngressEvent>;
  let failureRepo: Repository<IntegrationDeliveryFailure>;

  const secret = randomBytes(32).toString('hex');
  const raw = readFileSync(
    join(__dirname, '../src/modules/integration/__fixtures__/chatwoot-message_created.json'),
    'utf8',
  );
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const INGRESS_PATH = '/api/ingress/chatwoot/acct1/chatwoot';
  const ingressManifestRoute = {
    route: 'chatwoot',
    mode: 'async' as const,
    verify: 'core' as const,
    maxBodyBytes: 262144,
    signature: {
      scheme: 'hmac-sha256' as const,
      header: 'X-Chatwoot-Signature',
      contentTemplate: '{rawBody}',
      encoding: 'hex' as const,
      prefix: 'sha256=',
    },
    dedupHeader: 'x-chatwoot-delivery',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    app.use(
      json({
        verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    app.use(
      urlencoded({
        extended: true,
        verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    await app.init();
    ingressQueue = app.get<Queue<IngressJobData>>(getQueueToken(QUEUE_NAMES.INGRESS));

    const loader = app.get(PluginLoaderService);
    const realGetPlugin = loader.getPlugin.bind(loader);
    jest.spyOn(loader, 'getPlugin').mockImplementation((pluginId: string) => {
      if (pluginId === 'chatwoot') {
        return { manifest: { ingress: [ingressManifestRoute] } } as unknown as ReturnType<typeof loader.getPlugin>;
      }
      return realGetPlugin(pluginId);
    });
    dispatchWebhookForInstance = jest.spyOn(loader, 'dispatchWebhookForInstance').mockResolvedValue(undefined) as never;

    const instanceRepo = app.get<Repository<PluginInstance>>(getRepositoryToken(PluginInstance, 'data'));
    await instanceRepo.save(
      instanceRepo.create({
        id: 'chatwoot:acct1',
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        secret,
        enabled: true,
        sessionScope: 'sess-1',
        verifyToken: null,
        config: null,
      }),
    );
    eventRepo = app.get<Repository<IngressEvent>>(getRepositoryToken(IngressEvent, 'data'));
    failureRepo = app.get<Repository<IntegrationDeliveryFailure>>(
      getRepositoryToken(IntegrationDeliveryFailure, 'data'),
    );
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  const deliver = (deliveryId: string) =>
    request(app.getHttpServer())
      .post(INGRESS_PATH)
      .set('X-Chatwoot-Signature', sig)
      .set('X-Chatwoot-Delivery', deliveryId)
      .set('Content-Type', 'application/json')
      .send(raw);

  const sweepOptions = { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 };
  const dispatchesOf = (deliveryId: string): number =>
    (dispatchWebhookForInstance.mock.calls as IngressJobData[][]).filter(call => call[0].deliveryId === deliveryId)
      .length;
  const rowOf = (deliveryId: string) => eventRepo.findOneByOrFail({ providerDeliveryId: deliveryId });
  const jobIdOf = (deliveryId: string) => sanitizeIngressJobId(deliveryId, 'chatwoot\u0000acct1');

  /** Polls for a condition with a deadline: the worker settles a row some time after the job ends. */
  const waitFor = async (what: string, condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  it('is dispatched once from its row by the recovery passes when Redis loses its job', async () => {
    // The job waits in Redis, as it does behind a backlog or while its plugin is restored.
    await ingressQueue.pause();
    const deliveryId = `redis-loss-${Date.now()}`;
    try {
      const res = await deliver(deliveryId);
      expect(res.status).toBe(202);
      const jobId = jobIdOf(deliveryId);
      expect(await ingressQueue.getJobState(jobId)).toBe('waiting');
      // The job is only how the delivery reaches the plugin: the row keeps its payload until it settles.
      const queued = await rowOf(deliveryId);
      expect(queued).toMatchObject({ dispatchState: 'pending' });
      expect(queued.payload).not.toBeNull();

      await ingressQueue.remove(jobId);
      expect(await ingressQueue.getJobState(jobId)).toBe('unknown');
    } finally {
      await ingressQueue.resume();
    }

    // Every recovery pass the gateway has: the reconciler sweep, then the retention hand-off.
    const reconciler = app.get(IngressReconcilerService);
    await reconciler.sweep(sweepOptions, new Date(Date.now() + 1000));
    await reconciler.deadLetterAgedPending(new Date(Date.now() + 60_000));

    await waitFor('the replayed job to deliver', () => Promise.resolve(dispatchesOf(deliveryId) >= 1));
    await waitFor('the row to settle', async () => (await rowOf(deliveryId)).dispatchState === 'dispatched');
    expect(await rowOf(deliveryId)).toMatchObject({ dispatchState: 'dispatched', payload: null });
    expect(dispatchesOf(deliveryId)).toBe(1);
    expect(await failureRepo.countBy({ deliveryId })).toBe(0);
  }, 60000);

  it('settles the row at the worker, and the recovery passes dispatch nothing a second time', async () => {
    const deliveryId = `settled-${Date.now()}`;

    expect((await deliver(deliveryId)).status).toBe(202);
    await waitFor('the job to deliver', () => Promise.resolve(dispatchesOf(deliveryId) >= 1));
    await waitFor('the row to settle', async () => (await rowOf(deliveryId)).dispatchState === 'dispatched');

    expect((await rowOf(deliveryId)).payload).toBeNull();
    const reconciler = app.get(IngressReconcilerService);
    await reconciler.sweep(sweepOptions, new Date(Date.now() + 1000));
    await reconciler.deadLetterAgedPending(new Date(Date.now() + 60_000));
    expect(dispatchesOf(deliveryId)).toBe(1);
    expect(await failureRepo.countBy({ deliveryId })).toBe(0);
  }, 30000);

  it('leaves a delivery whose job is still waiting untouched, and the worker settles it later', async () => {
    await ingressQueue.pause();
    const deliveryId = `waiting-${Date.now()}`;
    try {
      expect((await deliver(deliveryId)).status).toBe(202);

      const stats = await app.get(IngressReconcilerService).sweep(sweepOptions, new Date(Date.now() + 1000));

      expect(stats.replayed).toBe(0);
      const row = await rowOf(deliveryId);
      expect(row.dispatchState).toBe('pending');
      expect(row.payload).not.toBeNull();
      expect(await ingressQueue.getJobState(jobIdOf(deliveryId))).toBe('waiting');
    } finally {
      await ingressQueue.resume();
    }

    await waitFor('the row to settle', async () => (await rowOf(deliveryId)).dispatchState === 'dispatched');
    expect((await rowOf(deliveryId)).payload).toBeNull();
    expect(dispatchesOf(deliveryId)).toBe(1);
  }, 30000);

  it('settles a row whose job completed but whose settle write was lost, without a second delivery', async () => {
    const deliveryId = `completed-${Date.now()}`;
    expect((await deliver(deliveryId)).status).toBe(202);
    await waitFor(
      'the job to complete',
      async () => (await ingressQueue.getJobState(jobIdOf(deliveryId))) === 'completed',
    );
    await waitFor('the row to settle', async () => (await rowOf(deliveryId)).dispatchState === 'dispatched');
    const row = await rowOf(deliveryId);
    // Put the row back to what a lost settle write leaves behind.
    await eventRepo.update(
      { id: row.id },
      { dispatchState: 'pending', payload: { headers: {}, query: {}, body: raw, rawBody: raw, method: 'POST' } },
    );

    await app.get(IngressReconcilerService).sweep(sweepOptions, new Date(Date.now() + 1000));

    expect(await eventRepo.findOneByOrFail({ id: row.id })).toMatchObject({
      dispatchState: 'dispatched',
      payload: null,
    });
    expect(dispatchesOf(deliveryId)).toBe(1);
  }, 30000);

  // The add fails (Redis unreachable): the delivery is dispatched inline after the row was persisted, and the row
  // retires its payload as soon as the plugin has it. No job is left in Redis.
  it('dispatches inline and settles the row at once when the queue add fails', async () => {
    const deliveryId = `add-fails-${Date.now()}`;
    jest.spyOn(ingressQueue, 'add').mockRejectedValueOnce(new Error('Connection is closed'));

    expect((await deliver(deliveryId)).status).toBe(202);

    expect(dispatchesOf(deliveryId)).toBe(1);
    expect(await rowOf(deliveryId)).toMatchObject({ dispatchState: 'dispatched', payload: null });
    expect(await ingressQueue.getJobState(jobIdOf(deliveryId))).toBe('unknown');
  }, 30000);

  // The inline fallback fails too: the row stays pending with its payload and a dead letter is filed. Once Redis is
  // back the sweep replays the delivery through the queue, closes the dead letter, and the worker settles the row.
  it('replays through the queue a delivery whose inline fallback failed, and closes its dead letter', async () => {
    const deliveryId = `inline-fails-${Date.now()}`;
    jest.spyOn(ingressQueue, 'add').mockRejectedValueOnce(new Error('Connection is closed'));
    dispatchWebhookForInstance.mockRejectedValueOnce(new Error('sandbox down'));

    expect((await deliver(deliveryId)).status).toBe(202);

    const failed = await rowOf(deliveryId);
    expect(failed).toMatchObject({ dispatchState: 'pending', dispatchAttempts: 1 });
    expect(failed.payload).not.toBeNull();
    expect(await failureRepo.countBy({ deliveryId, redriven: false })).toBe(1);

    await app.get(IngressReconcilerService).sweep(sweepOptions, new Date(Date.now() + 1000));

    await waitFor('the row to settle', async () => (await rowOf(deliveryId)).dispatchState === 'dispatched');
    expect(await rowOf(deliveryId)).toMatchObject({ dispatchState: 'dispatched', payload: null });
    expect(dispatchesOf(deliveryId)).toBe(2);
    expect(await failureRepo.countBy({ deliveryId, redriven: false })).toBe(0);
  }, 30000);

  it('dead-letters a delivery whose job keeps vanishing once the replay budget is spent', async () => {
    await ingressQueue.pause();
    const deliveryId = `vanishing-${Date.now()}`;
    try {
      expect((await deliver(deliveryId)).status).toBe(202);
      const reconciler = app.get(IngressReconcilerService);
      const options = { ...sweepOptions, maxAttempts: 2 };
      for (let pass = 1; pass <= 4; pass++) {
        await ingressQueue.remove(jobIdOf(deliveryId));
        await reconciler.sweep(options, new Date(Date.now() + 1000 * pass));
      }
    } finally {
      await ingressQueue.resume();
    }

    expect(await rowOf(deliveryId)).toMatchObject({ dispatchState: 'failed', payload: null });
    expect(await failureRepo.countBy({ deliveryId, redriven: false })).toBe(1);
    expect(dispatchesOf(deliveryId)).toBe(0);
  }, 30000);

  // The outbound webhook queue keeps its replay copy in the outbox until the worker settles the delivery, so the same
  // loss of the job is recovered there by the reconciler. Control for the tests above.
  it('recovers an outbound webhook delivery from the same loss of its job', async () => {
    const prevSsrf = process.env.WEBHOOK_SSRF_PROTECT;
    process.env.WEBHOOK_SSRF_PROTECT = 'false';
    const received: string[] = [];
    const receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        received.push(String(req.headers['x-openwa-idempotency-key']));
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    const webhookQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.WEBHOOK));
    try {
      const sessions = app.get<Repository<Session>>(getRepositoryToken(Session, 'data'));
      const webhooks = app.get<Repository<Webhook>>(getRepositoryToken(Webhook, 'data'));
      const outbox = app.get<Repository<WebhookOutboxEvent>>(getRepositoryToken(WebhookOutboxEvent, 'data'));
      const session = await sessions.save(sessions.create({ name: `redis-loss-${Date.now()}` }));
      const webhook = await webhooks.save(
        webhooks.create({ sessionId: session.id, url, events: ['message.received'], active: true }),
      );
      await webhookQueue.pause();
      try {
        await app.get(WebhookService).dispatch(session.id, 'message.received', {
          id: 'wamid.redis-loss',
          from: '628111111111@c.us',
          chatId: '628111111111@c.us',
          type: 'text',
          body: 'lost job',
          timestamp: 1790000000,
        });
        const row = await outbox.findOneByOrFail({ webhookId: webhook.id });
        expect(row).toMatchObject({ state: 'queued' });
        await webhookQueue.remove(row.deliveryId);
      } finally {
        await webhookQueue.resume();
      }

      const reconciler = app.get(WebhookReconcilerService);
      await reconciler.sweep(
        { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 },
        new Date(Date.now() + 1000),
      );
      const deadline = Date.now() + 15_000;
      while (received.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      expect(received).toHaveLength(1);
    } finally {
      await new Promise<void>(resolve => receiver.close(() => resolve()));
      if (prevSsrf === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
      else process.env.WEBHOOK_SSRF_PROTECT = prevSsrf;
    }
  }, 60000);
});

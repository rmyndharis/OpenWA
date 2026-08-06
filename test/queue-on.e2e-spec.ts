// archiver v8 is ESM-only and is pulled in transitively via the @Global StorageModule when
// AppModule boots; stub it so ts-jest (CommonJS) can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { spawnSync } from 'node:child_process';

// Queue-on boot env, set BEFORE AppModule is imported below: QUEUE_ENABLED is read at module-eval
// time (app.module.ts / integration.module.ts / webhook.module.ts conditionally require QueueModule),
// and redis-connection.ts's workerConnectionOptions() reads REDIS_* when the @Processor decorators
// evaluate. setup-e2e.ts forces QUEUE_ENABLED=false for the whole e2e family; this suite deliberately
// opts back in — the integration-instance suite uses the same env-before-import pattern for its flags.
process.env.QUEUE_ENABLED = 'true';
process.env.REDIS_ENABLED = 'true';
// QUEUE_TEST_REDIS_* overrides the standard REDIS_* for this suite only, so a dev box whose Redis is
// not on localhost:6379 can still run it; CI sets REDIS_HOST/REDIS_PORT at the service container.
const REDIS_HOST = process.env.QUEUE_TEST_REDIS_HOST || process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.QUEUE_TEST_REDIS_PORT || process.env.REDIS_PORT || '6379', 10);
process.env.REDIS_HOST = REDIS_HOST;
process.env.REDIS_PORT = String(REDIS_PORT);

// Jest registers suites synchronously at file load and has no runtime skip, so the Redis
// availability probe has to settle synchronously too: spawn a throwaway node one-liner that
// TCP-connects with a hard deadline (spawnSync kills it past the timeout margin). Unreachable →
// describe.skip below: an explicit green skip instead of a red boot.
const probeRedis = (host: string, port: number, timeoutMs: number): boolean => {
  const script =
    `const s = require('net').connect(${port}, ${JSON.stringify(host)});` +
    `const t = setTimeout(() => process.exit(2), ${timeoutMs});` +
    `s.on('connect', () => { clearTimeout(t); s.end(); process.exit(0); });` +
    `s.on('error', () => { clearTimeout(t); process.exit(1); });`;
  return spawnSync(process.execPath, ['-e', script], { timeout: timeoutMs + 1000 }).status === 0;
};

const REDIS_AVAILABLE = probeRedis(REDIS_HOST, REDIS_PORT, 1000);
const describeQueueOn = REDIS_AVAILABLE ? describe : describe.skip;

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
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
import { QUEUE_NAMES } from '../src/modules/queue/queue-names';
import { IngressJobData } from '../src/modules/queue/processors/ingress.processor';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { Session } from '../src/modules/session/entities/session.entity';
import { WebhookService } from '../src/modules/webhook/webhook.service';

/**
 * Queue-on coverage for the dispatch paths every other e2e suite boots with QUEUE_ENABLED=false:
 * the full AppModule comes up with the BullMQ wiring live against a real Redis, and both the
 * ingress and webhook dispatch paths are proven to go through their queues (not the inline
 * fallbacks) and to be processed by the queue workers end-to-end:
 *
 *   - boot succeeds, so IngressEnqueueService's fail-fast tripwire (QUEUE_ENABLED=true but the
 *     ingress-queue provider did not resolve) stays silent — the broken wiring it guards against
 *     (IntegrationModule not importing QueueModule) would crash this suite's beforeAll;
 *   - a signed ingress delivery fast-acks 202 with its job persisted in `ingress-queue`
 *     (jobId = deliveryId, awaited before the ack — deterministic proof the enqueue path ran, since
 *     the inline fallback never touches the queue), and the IngressProcessor worker then performs
 *     the dispatch;
 *   - WebhookService.dispatch() enqueues onto `webhook-queue` (the queue.add spy fires before
 *     dispatch() resolves — the direct-delivery fallback never calls it) and the WebhookProcessor
 *     worker POSTs to a live local receiver.
 *
 * Needs a real Redis. Locally: `docker run -d -p 6379:6379 redis:7-alpine`
 * (or `docker compose --profile redis up -d redis`); point elsewhere with
 * QUEUE_TEST_REDIS_HOST/QUEUE_TEST_REDIS_PORT. CI runs it against the redis service of the Test job.
 * With no Redis reachable the whole suite self-skips (see REDIS_AVAILABLE above), so a bare
 * `npm run test:e2e` on a Redis-less box stays green.
 */
describeQueueOn('Queued dispatch paths (e2e, QUEUE_ENABLED=true)', () => {
  let app: INestApplication<App>;
  let ingressQueue: Queue<IngressJobData>;
  let webhookQueue: Queue;
  let dispatchWebhookForInstance: jest.Mock;
  let webhookService: WebhookService;
  let sessionRepo: Repository<Session>;
  let eventRepo: Repository<IngressEvent>;
  let apiKey: string;
  let received: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  let receiver: http.Server;
  let receiverUrl: string;
  const prevSsrf = process.env.WEBHOOK_SSRF_PROTECT;

  // Chatwoot-style signed ingress route, mirroring the integration-fabric suite byte-for-byte so the
  // only delta under test is queue-on vs queue-off.
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

  const waitFor = async (predicate: () => boolean, timeoutMs = 10000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
      await new Promise(r => setTimeout(r, 10));
    }
  };

  beforeAll(async () => {
    // The 127.0.0.1 receiver would trip the SSRF guard at registration AND at delivery time; disable
    // it for this suite like the webhooks suite does (restored in afterAll).
    process.env.WEBHOOK_SSRF_PROTECT = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    // Mirror main.ts's raw-body wiring (see the integration-fabric suite): the ingress controller
    // verifies the HMAC over the exact wire bytes stashed by this verify callback.
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

    // Both queues resolve from the same container the workers consume — a boot that fails here is
    // itself the tripwire signal (IngressEnqueueService refuses to boot queue-on without the queue).
    ingressQueue = app.get<Queue<IngressJobData>>(getQueueToken(QUEUE_NAMES.INGRESS));
    webhookQueue = app.get<Queue>(getQueueToken(QUEUE_NAMES.WEBHOOK));

    // Same spy seam as the integration-fabric suite: engine registration stays real, only the
    // ingress pipeline's two PluginLoaderService entry points are spied.
    const loader = app.get(PluginLoaderService);
    const realGetPlugin = loader.getPlugin.bind(loader);
    jest.spyOn(loader, 'getPlugin').mockImplementation((pluginId: string) => {
      if (pluginId === 'chatwoot') {
        return { manifest: { ingress: [ingressManifestRoute] } } as unknown as ReturnType<typeof loader.getPlugin>;
      }
      return realGetPlugin(pluginId);
    });
    dispatchWebhookForInstance = jest.spyOn(loader, 'dispatchWebhookForInstance').mockResolvedValue(undefined) as never;

    // The chatwoot plugin instance the signed delivery resolves against.
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
    webhookService = app.get(WebhookService);
    sessionRepo = app.get(getRepositoryToken(Session, 'data'));
    apiKey = (await app.get(AuthService).createApiKey({ name: 'e2e-queue-on', role: ApiKeyRole.ADMIN })).rawKey;

    received = [];
    receiver = http.createServer((req, res) => {
      let rawBody = '';
      req.on('data', chunk => (rawBody += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(rawBody || '{}') as Record<string, unknown> });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  }, 60000);

  afterAll(async () => {
    await new Promise<void>(resolve => receiver?.close(() => resolve()));
    if (prevSsrf === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
    else process.env.WEBHOOK_SSRF_PROTECT = prevSsrf;
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('boots with QUEUE_ENABLED=true and both BullMQ queues resolved', () => {
    expect(ingressQueue).toBeDefined();
    expect(webhookQueue).toBeDefined();
  });

  it('enqueues the ingress delivery and the worker dispatches it', async () => {
    // Unique per run: the enqueue sets jobId = deliveryId and BullMQ dedups a repeated jobId while
    // the previous job still lingers (auto-evicted, 1h window) — a fixed id would make a fast local
    // rerun enqueue nothing and time out below.
    const deliveryId = `queue-on-${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post(INGRESS_PATH)
      .set('X-Chatwoot-Signature', sig)
      .set('X-Chatwoot-Delivery', deliveryId)
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(202);
    // The no-`response` route awaits the enqueue before the ack, so the job MUST already exist; the
    // inline fallback never touches the queue, making this the queued-vs-inline discriminator.
    const job = await ingressQueue.getJob(deliveryId);
    expect(job).toBeDefined();
    // The enqueue outcome was recorded on the event row (queued counts as reached-the-dispatch-tier).
    const event = await eventRepo.findOneByOrFail({ providerDeliveryId: deliveryId });
    expect(event.dispatchState).toBe('dispatched');

    // The IngressProcessor worker (not the request path — that only enqueued) performs the dispatch.
    await waitFor(() => dispatchWebhookForInstance.mock.calls.length >= 1);
    const dispatchedArgs = dispatchWebhookForInstance.mock.calls as IngressJobData[][];
    expect(dispatchedArgs[0][0].deliveryId).toBe(deliveryId);
  }, 30000);

  it('enqueues the webhook delivery and the worker POSTs it to the receiver', async () => {
    const session = await sessionRepo.save(sessionRepo.create({ name: `e2e-queue-on-${Date.now()}` }));
    await request(app.getHttpServer())
      .post(`/api/sessions/${session.id}/webhooks`)
      .set('X-API-Key', apiKey)
      .send({ url: receiverUrl, events: ['*'] })
      .expect(201);

    // dispatch() awaits its delivery tasks, so a resolved dispatch with add() called once means the
    // job was accepted by the queue — the direct-delivery fallback never calls add().
    const addSpy = jest.spyOn(webhookQueue, 'add');
    await webhookService.dispatch(session.id, 'message.received', {
      id: 'wamid.queue-on-1',
      from: '15551234567@c.us',
      body: 'queued end-to-end',
    });
    expect(addSpy).toHaveBeenCalledTimes(1);

    // The WebhookProcessor worker picked the job up and delivered it over HTTP.
    await waitFor(() => received.length >= 1);
    expect(received[0].body.event).toBe('message.received');
    expect(received[0].headers['x-openwa-event']).toBe('message.received');
  }, 30000);
});

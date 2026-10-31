import { spawnSync } from 'node:child_process';

// Queue-on boot env, set BEFORE AppModule is imported below: QUEUE_ENABLED is read at module-eval
// time (app.module.ts / integration.module.ts / webhook.module.ts conditionally require QueueModule),
// and redis-connection.ts's workerConnectionOptions() reads REDIS_* when the @Processor decorators
// evaluate. setup-e2e.ts forces QUEUE_ENABLED=false for the whole e2e family; this suite deliberately
// opts back in — the integration-instance suite uses the same env-before-import pattern for its flags.
process.env.QUEUE_ENABLED = 'true';
process.env.REDIS_ENABLED = 'true';
// A non-default key prefix for the whole suite: a Worker that built its queue under a different prefix
// than the producer would never see a job, and the dispatch tests below would time out.
process.env.QUEUE_PREFIX = 'openwa-e2e';
// QUEUE_TEST_REDIS_* overrides the standard REDIS_* for this suite only, so a dev box whose Redis is
// not on localhost:6379 can still run it; CI sets REDIS_HOST/REDIS_PORT at the service container.
const REDIS_HOST = process.env.QUEUE_TEST_REDIS_HOST || process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.QUEUE_TEST_REDIS_PORT || process.env.REDIS_PORT || '6379', 10);
process.env.REDIS_HOST = REDIS_HOST;
process.env.REDIS_PORT = String(REDIS_PORT);

// Jest registers suites synchronously at file load and has no runtime skip, so the Redis
// availability probe has to settle synchronously too: spawn a throwaway node one-liner that
// TCP-connects with a hard deadline (spawnSync kills it past the timeout margin). Unreachable →
// describe.skip below on a developer box: an explicit green skip instead of a red boot. On GitHub
// Actions every workflow that runs this suite provides Redis, so an unreachable one is drift (a
// removed service, a renamed env var) and fails the suite instead of reporting green on tests it
// never ran. Keyed on GITHUB_ACTIONS rather than CI, which a local shell may export without Redis.
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
    `queue-on e2e: no Redis at ${REDIS_HOST}:${REDIS_PORT} under GitHub Actions (set REDIS_HOST/REDIS_PORT or ` +
      'QUEUE_TEST_REDIS_HOST/QUEUE_TEST_REDIS_PORT); refusing to skip',
  );
}
const describeQueueOn = REDIS_AVAILABLE ? describe : describe.skip;

import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import request from 'supertest';
import { App } from 'supertest/types';
import { json, urlencoded, Request } from 'express';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';
import { PluginLoaderService } from '../src/core/plugins/plugin-loader.service';
import { PluginStorageService } from '../src/core/plugins/plugin-storage.service';
import { PluginStatus, PluginType } from '../src/core/plugins/plugin.interfaces';
import { PluginInstance } from '../src/modules/integration/entities/plugin-instance.entity';
import { IngressEvent } from '../src/modules/integration/entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from '../src/modules/integration/entities/integration-delivery-failure.entity';
import { WebhookOutboxEvent } from '../src/modules/webhook/entities/webhook-outbox-event.entity';
import { resolveIngressJobOptions, sanitizeIngressJobId } from '../src/modules/integration/ingress-enqueue.service';
import { QUEUE_NAMES } from '../src/modules/queue/queue-names';
import { IngressJobData } from '../src/modules/queue/processors/ingress.processor';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { Session } from '../src/modules/session/entities/session.entity';
import { WebhookService } from '../src/modules/webhook/webhook.service';

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 10));
  }
};

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
 *     (its jobId derived from the deliveryId, awaited before the ack — deterministic proof the
 *     enqueue path ran, since the inline fallback never touches the queue), and the IngressProcessor
 *     worker then performs the dispatch;
 *   - WebhookService.dispatch() enqueues onto `webhook-queue` (the queue.add spy fires before
 *     dispatch() resolves — the direct-delivery fallback never calls it) and the WebhookProcessor
 *     worker POSTs to a live local receiver.
 *
 * Needs a real Redis. Locally: `docker run -d -p 6379:6379 redis:7-alpine`
 * (or `docker compose --profile redis up -d redis`); point elsewhere with
 * QUEUE_TEST_REDIS_HOST/QUEUE_TEST_REDIS_PORT. CI runs it against the redis service of the Test job.
 * With no Redis reachable the whole suite self-skips (see REDIS_AVAILABLE above), so a bare
 * `npm run test:e2e` on a Redis-less box stays green; on GitHub Actions it fails instead.
 */
describeQueueOn('Queued dispatch paths (e2e, QUEUE_ENABLED=true)', () => {
  let app: INestApplication<App>;
  let ingressQueue: Queue<IngressJobData>;
  let webhookQueue: Queue;
  let dispatchWebhookForInstance: jest.Mock;
  let webhookService: WebhookService;
  let sessionRepo: Repository<Session>;
  let eventRepo: Repository<IngressEvent>;
  let outboxRepo: Repository<WebhookOutboxEvent>;
  let apiKey: string;
  let received: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  let receiver: http.Server;
  let receiverUrl: string;
  let bootOrder: { loaderInit: number[]; workerRun: number[] };
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

  beforeAll(async () => {
    // The 127.0.0.1 receiver would trip the SSRF guard at registration AND at delivery time; disable
    // it for this suite like the webhooks suite does (restored in afterAll).
    process.env.WEBHOOK_SSRF_PROTECT = 'false';
    // Both call through; jest numbers every mock call in one sequence, which gives the boot order.
    const loaderInit = jest.spyOn(PluginLoaderService.prototype, 'onModuleInit');
    const workerRun = jest.spyOn(Worker.prototype, 'run');

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
    bootOrder = {
      loaderInit: [...loaderInit.mock.invocationCallOrder],
      workerRun: [...workerRun.mock.invocationCallOrder],
    };
    loaderInit.mockRestore();
    workerRun.mockRestore();

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
    outboxRepo = app.get<Repository<WebhookOutboxEvent>>(getRepositoryToken(WebhookOutboxEvent, 'data'));
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

  it('marks the plugins it will restore before any queue worker starts', () => {
    // A worker running first could take a queued ingress job for a plugin not yet marked as restoring and
    // spend its only attempt on a missing plugin worker. The order comes from AppModule's imports.
    expect(bootOrder.loaderInit).toHaveLength(1);
    expect(bootOrder.workerRun.length).toBeGreaterThan(0);
    expect(bootOrder.loaderInit[0]).toBeLessThan(Math.min(...bootOrder.workerRun));
  });

  it('enqueues the ingress delivery and the worker dispatches it', async () => {
    // Unique per run: the enqueue derives the jobId from deliveryId and BullMQ dedups a repeated jobId
    // while the previous job still lingers (auto-evicted, 1h window) — a fixed id would make a fast local
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
    // The job id is the delivery id hashed with its plugin/instance namespace, as the enqueue mints it.
    const job = await ingressQueue.getJob(sanitizeIngressJobId(deliveryId, 'chatwoot\u0000acct1'));
    expect(job).toBeDefined();
    // The enqueue outcome was recorded on the event row (queued counts as reached-the-dispatch-tier).
    const event = await eventRepo.findOneByOrFail({ providerDeliveryId: deliveryId });
    expect(event.dispatchState).toBe('dispatched');

    // The IngressProcessor worker (not the request path — that only enqueued) performs the dispatch.
    await waitFor(() => dispatchWebhookForInstance.mock.calls.length >= 1);
    const dispatchedArgs = dispatchWebhookForInstance.mock.calls as IngressJobData[][];
    expect(dispatchedArgs[0][0].deliveryId).toBe(deliveryId);
  }, 30000);

  it('accepts a delivery for a plugin that is still restoring, holds its job without spending an attempt, then dispatches it', async () => {
    // The held job comes back after the retry delay, at least a second; a short one keeps the test brief.
    const prevDelay = process.env.INGRESS_RETRY_DELAY_MS;
    process.env.INGRESS_RETRY_DELAY_MS = '1000';
    const deliveryId = `queue-on-held-${Date.now()}`;
    const restoring = jest.spyOn(app.get(PluginLoaderService), 'isRestorePending').mockReturnValue(true);
    dispatchWebhookForInstance.mockClear();
    try {
      const res = await request(app.getHttpServer())
        .post(INGRESS_PATH)
        .set('X-Chatwoot-Signature', sig)
        .set('X-Chatwoot-Delivery', deliveryId)
        .set('Content-Type', 'application/json')
        .send(raw);

      // Accepted and queued like any delivery: no refusal for a route without a response contract.
      expect(res.status).toBe(202);
      const jobId = sanitizeIngressJobId(deliveryId, 'chatwoot\u0000acct1');
      // The worker takes the job, sees the plugin is not up, and puts it back in the delayed set. It does this
      // again at every delay, and spends no attempt, so the retry budget is intact when the plugin is up.
      await waitFor(
        async () =>
          (await ingressQueue.getJob(jobId))?.attemptsStarted !== 0 &&
          (await ingressQueue.getJobState(jobId)) === 'delayed',
      );
      await new Promise(resolve => setTimeout(resolve, 2500));
      const held = await ingressQueue.getJob(jobId);
      expect(held?.attemptsStarted).toBeGreaterThan(1);
      expect(held?.attemptsMade).toBe(0);
      expect(dispatchWebhookForInstance).not.toHaveBeenCalled();

      restoring.mockRestore();
      await waitFor(() => dispatchWebhookForInstance.mock.calls.length >= 1, 15000);
      expect((dispatchWebhookForInstance.mock.calls as IngressJobData[][])[0][0].deliveryId).toBe(deliveryId);
      await waitFor(async () => (await ingressQueue.getJobState(jobId)) === 'completed');
      expect((await ingressQueue.getJob(jobId))?.attemptsMade).toBe(1);
    } finally {
      restoring.mockRestore();
      if (prevDelay === undefined) delete process.env.INGRESS_RETRY_DELAY_MS;
      else process.env.INGRESS_RETRY_DELAY_MS = prevDelay;
    }
  }, 60000);

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

    // With the queue on, the worker is the only party that retires the delivery's outbox row. Left queued,
    // every reconciler sweep would replay the event to the receiver again.
    const idempotencyKey = received[0].headers['x-openwa-idempotency-key'] as string;
    await waitFor(async () => (await outboxRepo.findOneBy({ idempotencyKey }))?.state === 'dispatched');
    expect(await outboxRepo.findOneByOrFail({ idempotencyKey })).toMatchObject({ state: 'dispatched', payload: null });
  }, 30000);

  it('keeps both queues under QUEUE_PREFIX', async () => {
    expect(ingressQueue.opts.prefix).toBe('openwa-e2e');
    expect(webhookQueue.opts.prefix).toBe('openwa-e2e');

    const redis = new IORedis({ host: REDIS_HOST, port: REDIS_PORT });
    try {
      for (const name of [QUEUE_NAMES.INGRESS, QUEUE_NAMES.WEBHOOK]) {
        expect((await redis.keys(`openwa-e2e:${name}:*`)).length).toBeGreaterThan(0);
      }
    } finally {
      redis.disconnect();
    }
  });
});

/**
 * The BullMQ workers start while the modules initialise, and PluginLoaderService restores the plugins the
 * operator had enabled only at bootstrap, after that. A job already waiting in Redis can be taken in between
 * (on a busy host the bootstrap comes later than the worker's first fetch), so its plugin has to count as
 * restoring from module init on: held without spending an attempt, while the job of a plugin that is not
 * being restored is dispatched as usual.
 */
describeQueueOn('An ingress job waiting in Redis when the gateway starts (e2e, QUEUE_ENABLED=true)', () => {
  const PLUGIN = 'restore-held';
  const run = `${Date.now()}`;
  const held: IngressJobData = {
    pluginId: PLUGIN,
    instanceId: 'acct1',
    route: 'hook',
    deliveryId: `restore-held-${run}`,
    payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
  };
  const served: IngressJobData = { ...held, pluginId: 'not-restoring', deliveryId: `not-restoring-${run}` };
  const prevEnv = {
    PLUGINS_DIR: process.env.PLUGINS_DIR,
    INGRESS_MAX_ATTEMPTS: process.env.INGRESS_MAX_ATTEMPTS,
    INGRESS_RETRY_DELAY_MS: process.env.INGRESS_RETRY_DELAY_MS,
  };
  let app: INestApplication<App>;
  let queue: Queue<IngressJobData>;
  let failures: Repository<IntegrationDeliveryFailure>;
  let booting: Promise<unknown>;
  let bootstrap: jest.SpyInstance;
  let enable: jest.SpyInstance;
  let dispatch: jest.SpyInstance;
  // The restore of the plugin stays in flight until the test ends it.
  let restored = false;
  let endRestore!: () => void;
  const restore = new Promise<void>(resolve => (endRestore = resolve));

  beforeAll(async () => {
    // A single attempt: a job that spends it before the plugin is up is dead-lettered.
    process.env.INGRESS_MAX_ATTEMPTS = '1';
    process.env.INGRESS_RETRY_DELAY_MS = '1000';

    // A plugin the operator had enabled before the restart: its package on disk and its decision in the registry.
    const pluginsDir = join(process.env.PLUGIN_STATE_DIR!, 'plugins');
    process.env.PLUGINS_DIR = pluginsDir;
    const manifest = {
      id: PLUGIN,
      name: 'Restore Held',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      main: 'index.js',
    };
    mkdirSync(join(pluginsDir, PLUGIN), { recursive: true });
    writeFileSync(join(pluginsDir, PLUGIN, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(pluginsDir, PLUGIN, 'index.js'), 'module.exports = class {};');
    new PluginStorageService({
      get: (k: string) => (k === 'dataDir' ? process.env.PLUGIN_STATE_DIR : undefined),
    } as unknown as ConfigService).setPluginEntry({
      ...manifest,
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
      enabledByOperator: true,
    });

    queue = new Queue<IngressJobData>(QUEUE_NAMES.INGRESS, {
      connection: { host: REDIS_HOST, port: REDIS_PORT },
      prefix: 'openwa-e2e',
    });
    for (const d of [held, served]) {
      await queue.add('ingress', d, { jobId: d.deliveryId, ...resolveIngressJobOptions() });
    }

    // The worker's first fetch, before the bootstrap starts the restore: wait until the worker has decided on the job.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the loader as this
    const realBootstrap = PluginLoaderService.prototype.onApplicationBootstrap;
    bootstrap = jest.spyOn(PluginLoaderService.prototype, 'onApplicationBootstrap').mockImplementation(async function (
      this: PluginLoaderService,
    ) {
      await waitFor(async () => !['waiting', 'active'].includes(await queue.getJobState(held.deliveryId)));
      return realBootstrap.call(this);
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the loader as this
    const realEnable = PluginLoaderService.prototype.enablePlugin;
    enable = jest.spyOn(PluginLoaderService.prototype, 'enablePlugin').mockImplementation(function (
      this: PluginLoaderService,
      id: string,
    ) {
      return id === PLUGIN ? restore : realEnable.call(this, id);
    });
    // As the real dispatch does, it fails while the plugin has no worker yet.
    dispatch = jest
      .spyOn(PluginLoaderService.prototype, 'dispatchWebhookForInstance')
      .mockImplementation((d: IngressJobData) =>
        d.pluginId === PLUGIN && !restored
          ? Promise.reject(new Error(`no live sandbox host for plugin ${PLUGIN}`))
          : Promise.resolve(),
      );

    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    failures = app.get(getRepositoryToken(IntegrationDeliveryFailure, 'data'));
    // init() waits for the restore, so it settles only once the test has ended the restore.
    booting = app.init();
  }, 60000);

  afterAll(async () => {
    restored = true;
    endRestore();
    try {
      await booting;
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
    // A job left behind by a failed run would be dispatched by the next run's first suite.
    await Promise.allSettled([held, served].map(d => queue?.remove(d.deliveryId)));
    await queue?.close();
    bootstrap?.mockRestore();
    enable?.mockRestore();
    dispatch?.mockRestore();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('holds the job of a plugin still being restored without spending its attempt, and serves the others', async () => {
    // The worker has taken the job and put it back while the restore is in flight. A held job comes back at
    // every retry delay, so the state is read once.
    let state = '';
    await waitFor(async () => !['waiting', 'active'].includes((state = await queue.getJobState(held.deliveryId))));
    expect(state).toBe('delayed');
    expect((await queue.getJob(held.deliveryId))?.attemptsStarted).toBeGreaterThanOrEqual(1);
    expect((await queue.getJob(held.deliveryId))?.attemptsMade).toBe(0);
    expect(dispatch.mock.calls.map(([d]: [IngressJobData]) => d.deliveryId)).not.toContain(held.deliveryId);
    expect(await failures.countBy({ deliveryId: held.deliveryId })).toBe(0);

    // A plugin that is not being restored is not held.
    await waitFor(async () => (await queue.getJobState(served.deliveryId)) === 'completed');
    expect((await queue.getJob(served.deliveryId))?.attemptsMade).toBe(1);

    await waitFor(() => enable.mock.calls.some(([id]: [string]) => id === PLUGIN));
    restored = true;
    endRestore();
    await booting;

    await waitFor(async () => (await queue.getJobState(held.deliveryId)) === 'completed', 15000);
    expect((await queue.getJob(held.deliveryId))?.attemptsMade).toBe(1);
    expect(dispatch.mock.calls.filter(([d]: [IngressJobData]) => d.deliveryId === held.deliveryId)).toHaveLength(1);
    expect(await failures.countBy({ deliveryId: held.deliveryId })).toBe(0);
  }, 60000);
});

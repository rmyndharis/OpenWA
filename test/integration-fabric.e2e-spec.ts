import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { json, urlencoded, Request } from 'express';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { PluginLoaderService } from './../src/core/plugins/plugin-loader.service';
import { IngressReconcilerService } from './../src/modules/integration/ingress-reconciler.service';
import { PluginInstance } from './../src/modules/integration/entities/plugin-instance.entity';
import { IngressEvent } from './../src/modules/integration/entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './../src/modules/integration/entities/integration-delivery-failure.entity';

/**
 * Byte-exact HTTP coverage for the Integration SDK v1 ingress contract, over the seam the
 * service-level golden test (src/modules/integration/ingress-golden.spec.ts) can't reach: the real
 * @Public IngressController route, the real raw-body json({verify}) wiring mirrored from main.ts
 * (Nest's testing module does not replicate bootstrap()'s manual body-parser setup), and a real
 * TypeORM-persisted plugin instance. PluginLoaderService's engine-registration side effects are left
 * real (they run at module init regardless); only the two entry points the ingress pipeline calls
 * (getPlugin, dispatchWebhookForInstance) are spied so no live sandbox worker is required — the
 * contract under test is the wire path (verify -> dedup -> dispatch), not a real WhatsApp send.
 *
 * This is the production address, `app.setGlobalPrefix('api')` + `@Controller('ingress')` composing to
 * a single `/api/ingress/...` (matching the metrics.controller.ts @Public precedent), and the
 * `:pluginId/:instanceId/*path` wildcard reading `req.params.path` — the named-wildcard form Express 5
 * / path-to-regexp v8 requires (see ingress.controller.ts for the routing fix itself).
 */
describe('Integration Fabric ingress (e2e)', () => {
  let app: INestApplication<App>;
  let instanceRepo: Repository<PluginInstance>;
  let dispatchWebhookForInstance: jest.Mock;

  const secret = randomBytes(32).toString('hex');
  const raw = readFileSync(
    join(__dirname, '../src/modules/integration/__fixtures__/chatwoot-message_created.json'),
    'utf8',
  );
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

  // The real production address: main.ts's setGlobalPrefix('api') + the controller's bare
  // @Controller('ingress') compose to a single /api/ingress/... path.
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
  // The same provider contract on a route that declares a response contract (an ack alone), as an adapter whose
  // provider needs an answer now does: while its plugin is restoring, that is the one route a delivery is refused on.
  const answeringManifestRoute = { ...ingressManifestRoute, route: 'send-sms', response: { ack: { status: 204 } } };
  const ANSWERING_PATH = '/api/ingress/chatwoot/acct1/send-sms';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    // Mirror main.ts's raw-body wiring: the ingress controller reads req.rawBody (stashed by this
    // verify callback) so the HMAC would be checked over the EXACT bytes the provider signed. Nest's
    // testing module does not install this on its own — it's manual bootstrap()-only wiring in main.ts.
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

    instanceRepo = app.get(getRepositoryToken(PluginInstance, 'data'));

    // The real PluginLoaderService boots the built-in engine plugins (wwjs/Baileys) at onModuleInit,
    // so it can't be blanket-replaced with a useValue stub without reimplementing that bootstrap. Instead
    // spy on just the two entry points the ingress pipeline calls, leaving engine registration real.
    const loader = app.get(PluginLoaderService);
    const realGetPlugin = loader.getPlugin.bind(loader);
    jest.spyOn(loader, 'getPlugin').mockImplementation((pluginId: string) => {
      if (pluginId === 'chatwoot') {
        return {
          manifest: { ingress: [ingressManifestRoute, answeringManifestRoute] },
        } as unknown as ReturnType<typeof loader.getPlugin>;
      }
      return realGetPlugin(pluginId);
    });
    dispatchWebhookForInstance = jest.spyOn(loader, 'dispatchWebhookForInstance').mockResolvedValue(undefined) as never;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  beforeEach(async () => {
    dispatchWebhookForInstance.mockClear();
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
  });

  it('accepts a correctly signed Chatwoot delivery over the real /api/ingress path', async () => {
    // This is the request shape the SDK v1 design doc and the golden fixture describe, sent to the
    // real production address. QUEUE_ENABLED is unset in this test env, so IngressService's factory
    // wires the inline-dispatch fallback — dispatchWebhookForInstance runs synchronously before the 202.
    const res = await request(app.getHttpServer())
      .post(INGRESS_PATH)
      .set('X-Chatwoot-Signature', sig)
      .set('X-Chatwoot-Delivery', 'delivery-http-1')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(202);
    expect(dispatchWebhookForInstance).toHaveBeenCalledTimes(1);
  });

  it('verifies form-urlencoded deliveries against their exact wire bytes', async () => {
    const formRaw = 'event=message_created&account_id=42';
    const formSignature = 'sha256=' + createHmac('sha256', secret).update(formRaw).digest('hex');
    const res = await request(app.getHttpServer())
      .post(INGRESS_PATH)
      .set('X-Chatwoot-Signature', formSignature)
      .set('X-Chatwoot-Delivery', 'delivery-form-1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(formRaw);

    expect(res.status).toBe(202);
    expect(dispatchWebhookForInstance).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered signature with 401 and never dispatches', async () => {
    const res = await request(app.getHttpServer())
      .post(INGRESS_PATH)
      .set('X-Chatwoot-Signature', 'sha256=' + '0'.repeat(64))
      .set('X-Chatwoot-Delivery', 'delivery-http-2')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(401);
    expect(dispatchWebhookForInstance).not.toHaveBeenCalled();
  });

  // A plugin the boot restore has not reached has no worker. A route without a response contract is accepted and
  // persisted like every delivery; with the queue off the row is not dispatched at the door but left for the
  // reconciler, which dispatches it once the plugin is up.
  describe('while the plugin restore is pending', () => {
    const stateRepos = () => ({
      events: app.get<Repository<IngressEvent>>(getRepositoryToken(IngressEvent, 'data')),
      failures: app.get<Repository<IntegrationDeliveryFailure>>(getRepositoryToken(IntegrationDeliveryFailure, 'data')),
    });
    const post = (path: string, deliveryId: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('X-Chatwoot-Signature', sig)
        .set('X-Chatwoot-Delivery', deliveryId)
        .set('Content-Type', 'application/json')
        .send(raw);
    const restoring = () => jest.spyOn(app.get(PluginLoaderService), 'isRestorePending').mockReturnValue(true);

    it('accepts and persists a delivery of a route without a response contract, and the reconciler delivers it afterwards', async () => {
      const { events, failures } = stateRepos();
      const restore = restoring();
      try {
        const accepted = await post(INGRESS_PATH, 'delivery-held-1');

        expect(accepted.status).toBe(202);
        // Not dispatched into a plugin with no worker, and not dead-lettered: the row is the record of it.
        expect(dispatchWebhookForInstance).not.toHaveBeenCalled();
        const held = await events.findOneByOrFail({ providerDeliveryId: 'delivery-held-1' });
        expect(held.dispatchState).toBe('pending');
        expect(held.dispatchAttempts).toBe(0);
        expect(held.payload).not.toBeNull();
        expect(await failures.countBy({ deliveryId: 'delivery-held-1' })).toBe(0);

        // The provider's own retry of it is a duplicate, as for any persisted delivery.
        expect((await post(INGRESS_PATH, 'delivery-held-1')).status).toBe(202);
        expect(await events.countBy({ providerDeliveryId: 'delivery-held-1' })).toBe(1);

        // While the restore lasts the reconciler leaves the row alone.
        const reconciler = app.get(IngressReconcilerService);
        const options = { intervalMs: 60_000, graceMs: 0, batchSize: 50, maxAttempts: 5 };
        await new Promise(resolve => setTimeout(resolve, 5));
        await reconciler.sweep(options);
        expect(dispatchWebhookForInstance).not.toHaveBeenCalled();

        restore.mockRestore();
        const stats = await reconciler.sweep(options);

        expect(stats).toMatchObject({ scanned: 1, replayed: 1 });
        expect(dispatchWebhookForInstance).toHaveBeenCalledTimes(1);
        const delivered = await events.findOneByOrFail({ providerDeliveryId: 'delivery-held-1' });
        expect(delivered.dispatchState).toBe('dispatched');
        expect(delivered.payload).toBeNull();
      } finally {
        restore.mockRestore();
      }
    });

    it('refuses a route that declares a response contract with 503 and Retry-After, stores nothing, then accepts the retry', async () => {
      const { events, failures } = stateRepos();
      const restore = restoring();
      try {
        const refused = await post(ANSWERING_PATH, 'delivery-answer-1');

        expect(refused.status).toBe(503);
        expect(refused.headers['retry-after']).toBe('5');
        expect(dispatchWebhookForInstance).not.toHaveBeenCalled();
        // A stored row would answer the provider's retry with a 'duplicate' ack and lose the delivery.
        expect(await events.countBy({ providerDeliveryId: 'delivery-answer-1' })).toBe(0);
        expect(await failures.countBy({ deliveryId: 'delivery-answer-1' })).toBe(0);
      } finally {
        restore.mockRestore();
      }

      const retried = await post(ANSWERING_PATH, 'delivery-answer-1');

      expect(retried.status).toBe(204);
      expect(dispatchWebhookForInstance).toHaveBeenCalledTimes(1);
    });

    it('still dispatches at the door when the reconciler is off, since nothing would replay a held row', async () => {
      const { events, failures } = stateRepos();
      const original = process.env.INGRESS_RECONCILE_INTERVAL_MS;
      process.env.INGRESS_RECONCILE_INTERVAL_MS = '0';
      const restore = restoring();
      dispatchWebhookForInstance.mockRejectedValueOnce(new Error('no live sandbox host for plugin chatwoot'));
      try {
        const res = await post(INGRESS_PATH, 'delivery-noreconcile-1');

        // The inline dispatch fails and files the redrivable dead letter an operator can see.
        expect(res.status).toBe(202);
        expect(dispatchWebhookForInstance).toHaveBeenCalledTimes(1);
        expect(await failures.countBy({ deliveryId: 'delivery-noreconcile-1', redriven: false })).toBe(1);
        expect((await events.findOneByOrFail({ providerDeliveryId: 'delivery-noreconcile-1' })).dispatchAttempts).toBe(
          1,
        );
      } finally {
        restore.mockRestore();
        if (original === undefined) delete process.env.INGRESS_RECONCILE_INTERVAL_MS;
        else process.env.INGRESS_RECONCILE_INTERVAL_MS = original;
        // An unused once-rejection must not reach the next test.
        dispatchWebhookForInstance.mockReset().mockResolvedValue(undefined);
      }
    });
  });

  it('marks the persisted event dispatched once a successful inline dispatch is recorded', async () => {
    const eventRepo = app.get<Repository<IngressEvent>>(getRepositoryToken(IngressEvent, 'data'));
    const res = await request(app.getHttpServer())
      .post(INGRESS_PATH)
      .set('X-Chatwoot-Signature', sig)
      .set('X-Chatwoot-Delivery', 'delivery-marked-1')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(202);
    // The no-`response` route awaits enqueue before the ack, so the outcome is already recorded:
    // a crash between persist and dispatch is the only way a fresh row stays 'pending'.
    const row = await eventRepo.findOneByOrFail({ providerDeliveryId: 'delivery-marked-1' });
    expect(row.dispatchState).toBe('dispatched');
    expect(row.lastDispatchAt).not.toBeNull();
    // With the outcome recorded, the dispatch tier owns the payload: the dedup row retires it to
    // NULL and keeps only the slim content fingerprint for operator correlation.
    expect(row.payload).toBeNull();
    expect(row.payloadHash).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('persists a redrivable dead-letter row (still 202) when inline dispatch fails', async () => {
    const failureRepo = app.get<Repository<IntegrationDeliveryFailure>>(
      getRepositoryToken(IntegrationDeliveryFailure, 'data'),
    );
    const eventRepo = app.get<Repository<IngressEvent>>(getRepositoryToken(IngressEvent, 'data'));
    // The plugin handler throws — the inline-dispatch fallback fails and is swallowed. Without a
    // dead-letter row the event would be stranded: handle() still 202s, and RedriveService only scans
    // this table (never ingress_events). The live-ingress wiring must therefore persist the failure here.
    dispatchWebhookForInstance.mockRejectedValueOnce(new Error('sandbox handler 5xx'));

    const res = await request(app.getHttpServer())
      .post(INGRESS_PATH)
      .set('X-Chatwoot-Signature', sig)
      .set('X-Chatwoot-Delivery', 'delivery-dlq-1')
      .set('Content-Type', 'application/json')
      .send(raw);

    // Provider still gets its 202 (at-least-once) — the failure is captured durably, not surfaced as 5xx.
    expect(res.status).toBe(202);
    const rows = await failureRepo.find({ where: { deliveryId: 'delivery-dlq-1', direction: 'inbound' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      redriven: false,
      lastError: 'sandbox handler 5xx',
    });

    // The event row itself stays 'pending' with the failure counted, so the reconciler retries the
    // dispatch on its next sweep instead of waiting for a manual redrive alone. Its payload is KEPT
    // — it is the reconciler's replay source (the DLQ row carries the copy redrive uses).
    const event = await eventRepo.findOneByOrFail({ providerDeliveryId: 'delivery-dlq-1' });
    expect(event.dispatchState).toBe('pending');
    expect(event.dispatchAttempts).toBe(1);
    expect(event.payload).not.toBeNull();
    expect(event.payloadHash).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});

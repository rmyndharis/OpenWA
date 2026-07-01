// archiver v8 is ESM-only and is pulled in transitively via the @Global StorageModule when
// AppModule boots; stub it so ts-jest (CommonJS) can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { json, urlencoded, Request } from 'express';
import { AppModule } from './../src/app.module';
import { PluginLoaderService } from './../src/core/plugins/plugin-loader.service';
import { PluginInstance } from './../src/modules/integration/entities/plugin-instance.entity';

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

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
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
    app.use(urlencoded({ extended: true }));
    await app.init();

    instanceRepo = app.get(getRepositoryToken(PluginInstance, 'data'));

    // The real PluginLoaderService boots the built-in engine plugins (wwjs/Baileys) at onModuleInit,
    // so it can't be blanket-replaced with a useValue stub without reimplementing that bootstrap. Instead
    // spy on just the two entry points the ingress pipeline calls, leaving engine registration real.
    const loader = app.get(PluginLoaderService);
    const realGetPlugin = loader.getPlugin.bind(loader);
    jest.spyOn(loader, 'getPlugin').mockImplementation((pluginId: string) => {
      if (pluginId === 'chatwoot') {
        return { manifest: { ingress: [ingressManifestRoute] } } as unknown as ReturnType<typeof loader.getPlugin>;
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
});

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
 * KNOWN BREAK (found while writing this test, reproduced independently of it — see task-8-report.md):
 * under the app's real dependency stack (express@5.2.1 / @nestjs/platform-express@11, confirmed via
 * @types/express ^5.0.0), IngressController's `@All(':pluginId/:instanceId/*')` (ingress.controller.ts:16)
 * is silently legacy-converted by Nest's LegacyRouteConverter to `{*path}` (path-to-regexp v8 dropped
 * bare `*`). That lands the wildcard capture in `req.params.path` (an array), but the handler reads
 * `req.params[0]` (ingress.controller.ts:24) — always undefined on this stack — so `route` resolves to
 * `''` and IngressService 404s "unknown route" for every real inbound delivery. Separately,
 * `@Controller('api/ingress')` plus `app.setGlobalPrefix('api')` in main.ts double up to
 * `/api/api/ingress/...` rather than the single `/api/ingress/...` the design doc and the
 * ingress.controller.spec.ts unit test (which hand-builds `req.params = { 0: 'chatwoot' }` and so never
 * exercises real Express routing) assume. Both are pre-existing bugs in the merged Task 1-7 controller
 * code; this is a test-only task and does not fix them. The two tests below assert the CURRENT,
 * observed behavior (404 for a well-formed, correctly signed delivery) rather than a hoped-for 202, so
 * this file documents the break instead of hiding it. The service-level golden test is unaffected
 * because it drives IngressService directly and never goes through the controller/router.
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

  // The design-intended single-prefix path. Confirmed against a live boot to hit the real router:
  // this address 404s with Nest's own "Cannot GET" body, i.e. no route is registered here at all.
  const DESIGN_PATH = '/api/ingress/chatwoot/acct1/chatwoot';

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

  it('DESIGN GAP: a correctly signed Chatwoot delivery to the documented path 404s instead of 202', async () => {
    // This is the request shape the SDK v1 design doc and the golden fixture describe. It currently
    // 404s at the router (no controller matches `/api/ingress/...`) — see the KNOWN BREAK note above.
    const res = await request(app.getHttpServer())
      .post(DESIGN_PATH)
      .set('X-Chatwoot-Signature', sig)
      .set('X-Chatwoot-Delivery', 'delivery-http-1')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(404);
    expect(dispatchWebhookForInstance).not.toHaveBeenCalled();
  });

  it('DESIGN GAP: the double-prefixed live route also 404s, because the wildcard param never resolves', async () => {
    // Routing to the ACTUAL registered address (/api/api/ingress/...) clears the prefix bug but still
    // 404s "unknown route": the controller reads req.params[0], which Express 5 + Nest's legacy-route
    // conversion never populates (the capture lands in req.params.path instead). No delivery can ever
    // reach IngressService.handle's signature check through the real HTTP surface on this stack.
    const res = await request(app.getHttpServer())
      .post('/api/api/ingress/chatwoot/acct1/chatwoot')
      .set('X-Chatwoot-Signature', sig)
      .set('X-Chatwoot-Delivery', 'delivery-http-2')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(404);
    expect(res.text).toBe('unknown route');
    expect(dispatchWebhookForInstance).not.toHaveBeenCalled();
  });
});

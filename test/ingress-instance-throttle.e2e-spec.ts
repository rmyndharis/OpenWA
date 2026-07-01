// archiver v8 is ESM-only and is pulled in transitively via the @Global StorageModule when
// AppModule boots; stub it so ts-jest (CommonJS) can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

// Set BEFORE AppModule is imported: InstanceThrottlerGuard reads these directly in its onModuleInit
// (a lifecycle hook that runs once at boot), not per-request, so they must be in place before the
// Nest testing module is compiled below.
process.env.INGRESS_INSTANCE_LIMIT = '3';
process.env.INGRESS_INSTANCE_TTL = '60000';

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
 * Deterministic proof that InstanceThrottlerGuard actually enforces its per-route limit, and that two
 * different instances get independent buckets (a noisy tenant doesn't starve its neighbor). Uses its
 * own low INGRESS_INSTANCE_LIMIT (3) set before AppModule boots, rather than the shared e2e app in
 * integration-fabric.e2e-spec.ts, so hammering past the limit is fast and doesn't perturb the golden
 * 202/401 coverage there (which relies on the default limit of 120 never being hit).
 */
describe('Ingress per-instance fairness throttle (e2e)', () => {
  let app: INestApplication<App>;
  let instanceRepo: Repository<PluginInstance>;

  const secret = randomBytes(32).toString('hex');
  const raw = readFileSync(
    join(__dirname, '../src/modules/integration/__fixtures__/chatwoot-message_created.json'),
    'utf8',
  );
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

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

    const loader = app.get(PluginLoaderService);
    const realGetPlugin = loader.getPlugin.bind(loader);
    jest.spyOn(loader, 'getPlugin').mockImplementation((pluginId: string) => {
      if (pluginId === 'chatwoot') {
        return { manifest: { ingress: [ingressManifestRoute] } } as unknown as ReturnType<typeof loader.getPlugin>;
      }
      return realGetPlugin(pluginId);
    });
    jest.spyOn(loader, 'dispatchWebhookForInstance').mockResolvedValue(undefined);

    for (const instanceId of ['acct1', 'acct2']) {
      await instanceRepo.save(
        instanceRepo.create({
          id: `chatwoot:${instanceId}`,
          pluginId: 'chatwoot',
          instanceId,
          secret,
          enabled: true,
          sessionScope: 'sess-1',
          verifyToken: null,
          config: null,
        }),
      );
    }
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  const send = (instanceId: string, deliveryId: string) =>
    request(app.getHttpServer())
      .post(`/api/ingress/chatwoot/${instanceId}/chatwoot`)
      .set('X-Chatwoot-Signature', sig)
      .set('X-Chatwoot-Delivery', deliveryId)
      .set('Content-Type', 'application/json')
      .send(raw);

  it('429s the Nth+1 request within the TTL, and does not starve a different instance', async () => {
    // INGRESS_INSTANCE_LIMIT=3: the first 3 requests on acct1 succeed, the 4th is shed at the edge.
    for (let i = 0; i < 3; i++) {
      const res = await send('acct1', `acct1-${i}`);
      expect(res.status).toBe(202);
    }

    const blocked = await send('acct1', 'acct1-overflow');
    expect(blocked.status).toBe(429);
    // ThrottlerGuard runs as a guard, before the handler, so it throws ThrottlerException before the
    // controller's @Res() is ever reached — the header is set on the real response object directly
    // from the guard layer and the global exception filter formats the 429 body. Confirm both survive
    // the @Res() route (not just the status code).
    expect(blocked.headers['retry-after-instance']).toBeDefined();
    expect(blocked.body).toMatchObject({ statusCode: 429 });

    // A different (pluginId, instanceId) shares the provider's egress IP but gets an independent
    // bucket — it must NOT be affected by acct1 having just been throttled.
    const other = await send('acct2', 'acct2-0');
    expect(other.status).toBe(202);
  });
});

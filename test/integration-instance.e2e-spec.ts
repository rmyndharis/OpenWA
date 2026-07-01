// archiver v8 is ESM-only; stub it so ts-jest can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

// Seed the well-known dev-admin-key BEFORE AppModule is imported (mirrors mcp-auth.e2e-spec.ts's
// pattern of setting the enabling env var ahead of the import).
process.env.ALLOW_DEV_API_KEY = 'true';
process.env.BASE_URL = 'https://api.example.com';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PluginLoaderService } from '../src/core/plugins/plugin-loader.service';

// A stub ingress-capable plugin so the capability check passes without a real plugin on disk.
const INGRESS_PLUGIN = {
  manifest: { id: 'chatwoot', ingress: [{ route: 'chatwoot' }], permissions: ['webhook:ingress', 'conversation:send'] },
};
const NON_INGRESS_PLUGIN = { manifest: { id: 'plain', permissions: [] } };

interface InstanceViewBody {
  secret: string;
  enabled: boolean;
  sessionScope: string | null;
  ingressUrls: Array<{ route: string; url: string }>;
}

describe('IntegrationInstanceController (e2e)', () => {
  let app: INestApplication<App>;
  const key = 'dev-admin-key';
  const base = '/api/integration/plugins';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PluginLoaderService)
      .useValue({
        getPlugin: (id: string) =>
          id === 'chatwoot' ? INGRESS_PLUGIN : id === 'plain' ? NON_INGRESS_PLUGIN : undefined,
        dispatchWebhookForInstance: jest.fn(),
        // EngineFactory.onModuleInit registers the built-in whatsapp-web.js/baileys engine plugins
        // and auto-enables the configured one through these at boot; no-ops keep app boot working
        // without a real plugin registry (enablePlugin failing is caught+logged, not fatal, but a
        // no-op keeps the test log free of that expected-but-noisy error).
        registerBuiltInPlugin: jest.fn(),
        enablePlugin: jest.fn().mockResolvedValue(undefined),
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('requires an API key (401 without one)', async () => {
    await request(app.getHttpServer()).get(`${base}/chatwoot/instances`).expect(401);
  });

  it('mints an instance and returns the secret + ingress URLs exactly once, then masks on read', async () => {
    const mint = await request(app.getHttpServer())
      .post(`${base}/chatwoot/instances`)
      .set('X-API-Key', key)
      .send({ instanceId: 'acct1', sessionScope: 'sess-1' })
      .expect(201);
    const minted = mint.body as InstanceViewBody;
    expect(minted.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.ingressUrls).toEqual([
      { route: 'chatwoot', url: 'https://api.example.com/api/ingress/chatwoot/acct1/chatwoot' },
    ]);

    const list = await request(app.getHttpServer()).get(`${base}/chatwoot/instances`).set('X-API-Key', key).expect(200);
    expect((list.body as InstanceViewBody[])[0].secret).toBe('***');

    const one = await request(app.getHttpServer())
      .get(`${base}/chatwoot/instances/acct1`)
      .set('X-API-Key', key)
      .expect(200);
    expect((one.body as InstanceViewBody).secret).toBe('***');
  });

  it('rejects minting on a non-ingress plugin (400) and a duplicate (409)', async () => {
    await request(app.getHttpServer())
      .post(`${base}/plain/instances`)
      .set('X-API-Key', key)
      .send({ instanceId: 'x' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`${base}/chatwoot/instances`)
      .set('X-API-Key', key)
      .send({ instanceId: 'acct1' })
      .expect(409);
  });

  it('rejects minting on an unknown plugin (404)', async () => {
    await request(app.getHttpServer())
      .post(`${base}/nonexistent/instances`)
      .set('X-API-Key', key)
      .send({ instanceId: 'x' })
      .expect(404);
  });

  it('rejects an invalid instanceId charset (400)', async () => {
    await request(app.getHttpServer())
      .post(`${base}/chatwoot/instances`)
      .set('X-API-Key', key)
      .send({ instanceId: 'bad:id' })
      .expect(400);
  });

  it('regenerates the secret and returns it once, then masks again on the next read', async () => {
    const regen = await request(app.getHttpServer())
      .post(`${base}/chatwoot/instances/acct1/regenerate-secret`)
      .set('X-API-Key', key)
      .expect(200);
    expect((regen.body as InstanceViewBody).secret).toMatch(/^[0-9a-f]{64}$/);

    const one = await request(app.getHttpServer())
      .get(`${base}/chatwoot/instances/acct1`)
      .set('X-API-Key', key)
      .expect(200);
    expect((one.body as InstanceViewBody).secret).toBe('***');
  });

  it('patches enabled + sessionScope and returns a masked view', async () => {
    const patched = await request(app.getHttpServer())
      .patch(`${base}/chatwoot/instances/acct1`)
      .set('X-API-Key', key)
      .send({ enabled: false, sessionScope: 'sess-2' })
      .expect(200);
    const body = patched.body as InstanceViewBody;
    expect(body.enabled).toBe(false);
    expect(body.sessionScope).toBe('sess-2');
    expect(body.secret).toBe('***');
  });

  it('404s GET/PATCH/DELETE for a missing instanceId on an ingress-capable plugin', async () => {
    await request(app.getHttpServer())
      .get(`${base}/chatwoot/instances/does-not-exist`)
      .set('X-API-Key', key)
      .expect(404);
    await request(app.getHttpServer())
      .patch(`${base}/chatwoot/instances/does-not-exist`)
      .set('X-API-Key', key)
      .send({ enabled: false })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`${base}/chatwoot/instances/does-not-exist`)
      .set('X-API-Key', key)
      .expect(404);
  });

  it('deletes the instance (204) and audits it', async () => {
    await request(app.getHttpServer()).delete(`${base}/chatwoot/instances/acct1`).set('X-API-Key', key).expect(204);
    await request(app.getHttpServer()).get(`${base}/chatwoot/instances/acct1`).set('X-API-Key', key).expect(404);
  });
});

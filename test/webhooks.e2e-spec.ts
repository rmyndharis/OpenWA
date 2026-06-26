// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import http from 'http';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { WebhookService } from './../src/modules/webhook/webhook.service';

/**
 * End-to-end coverage for the webhooks module across the seam the unit specs can't reach: the REST
 * surface (CRUD + auth + validation, with the global ValidationPipe), persistence, and real
 * HMAC-signed HTTP delivery to a live local receiver. Dispatch is the one thing the WhatsApp socket
 * would normally trigger, so we call WebhookService.dispatch() directly - that boundary isn't
 * webhook logic.
 *
 * SSRF protection is ON by default and would reject the 127.0.0.1 receiver at both registration and
 * delivery, so the suite runs with WEBHOOK_SSRF_PROTECT=false (one test flips it back on locally).
 */
describe('Webhooks (e2e)', () => {
  let app: INestApplication<App>;
  let webhookService: WebhookService;
  let sessionRepo: Repository<Session>;
  let apiKey: string;
  let viewerKey: string;
  let received: Array<{ headers: http.IncomingHttpHeaders; raw: string; body: Record<string, unknown> }>;
  let receiver: http.Server;
  let receiverUrl: string;
  const prevSsrf = process.env.WEBHOOK_SSRF_PROTECT;

  // Webhooks carry a CASCADE foreign key to a session row, and dispatch looks them up by sessionId.
  // Persisting one real session per test both satisfies the FK and isolates each case (and prior
  // runs) from the others, since dispatch and the session-scoped routes only see that session's id.
  let sessionSeq = 0;
  const nextSession = async (): Promise<string> => {
    const session = await sessionRepo.save(sessionRepo.create({ name: `e2e-webhooks-${Date.now()}-${sessionSeq++}` }));
    return session.id;
  };

  const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
      await new Promise(r => setTimeout(r, 10));
    }
  };

  // Create a webhook via the REST API (exercises CreateWebhookDto + filter validation) and return the
  // response DTO. Defaults to the receiver URL + a subscribe-all event so dispatch tests can refine
  // behaviour purely through filters/overrides.
  const createWebhook = async (
    session: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const res = await request(app.getHttpServer())
      .post(`/api/sessions/${session}/webhooks`)
      .set('X-API-Key', apiKey)
      .send({ url: receiverUrl, events: ['*'], ...overrides })
      .expect(201);
    return res.body as Record<string, unknown>;
  };

  beforeAll(async () => {
    process.env.WEBHOOK_SSRF_PROTECT = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    webhookService = app.get(WebhookService);
    sessionRepo = app.get(getRepositoryToken(Session, 'data'));

    // Mint real keys so the suite doesn't depend on seed/DB state; ADMIN covers the OPERATOR routes.
    const authService = app.get(AuthService);
    apiKey = (await authService.createApiKey({ name: 'e2e-admin', role: ApiKeyRole.ADMIN })).rawKey;
    viewerKey = (await authService.createApiKey({ name: 'e2e-viewer', role: ApiKeyRole.VIEWER })).rawKey;

    received = [];
    receiver = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, raw, body: JSON.parse(raw || '{}') as Record<string, unknown> });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => receiver.close(() => resolve()));
    if (prevSsrf === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
    else process.env.WEBHOOK_SSRF_PROTECT = prevSsrf;
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  beforeEach(() => {
    received = [];
  });

  // ── CRUD over the REST surface ────────────────────────────────────

  describe('CRUD over REST', () => {
    it('creates a webhook and never leaks the secret or headers in the response', async () => {
      const session = await nextSession();
      const dto = await createWebhook(session, {
        secret: 'top-secret',
        headers: { 'X-Custom': 'v' },
        filters: { conditions: [{ field: 'sender', operator: 'is', value: ['a@c.us'] }] },
      });

      expect(dto.id).toBeDefined();
      expect(dto.sessionId).toBe(session);
      expect(dto.active).toBe(true);
      // Write-only fields must never appear in any API response.
      expect(dto.secret).toBeUndefined();
      expect(dto.headers).toBeUndefined();
    });

    it('lists webhooks for a session', async () => {
      const session = await nextSession();
      const created = await createWebhook(session);

      const res = await request(app.getHttpServer())
        .get(`/api/sessions/${session}/webhooks`)
        .set('X-API-Key', apiKey)
        .expect(200);

      const list = res.body as Array<{ id: string }>;
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(created.id);
    });

    it('gets a webhook by id, and returns 404 for an unknown id', async () => {
      const session = await nextSession();
      const created = await createWebhook(session);

      await request(app.getHttpServer())
        .get(`/api/sessions/${session}/webhooks/${created.id as string}`)
        .set('X-API-Key', apiKey)
        .expect(200)
        .expect(res => {
          if ((res.body as { id: string }).id !== created.id) throw new Error('wrong webhook returned');
        });

      await request(app.getHttpServer())
        .get(`/api/sessions/${session}/webhooks/00000000-0000-0000-0000-000000000000`)
        .set('X-API-Key', apiKey)
        .expect(404);
    });

    it('updates fields and persists them', async () => {
      const session = await nextSession();
      const created = await createWebhook(session);

      const res = await request(app.getHttpServer())
        .put(`/api/sessions/${session}/webhooks/${created.id as string}`)
        .set('X-API-Key', apiKey)
        .send({ events: ['message.received', 'session.status'], active: false })
        .expect(200);

      const updated = res.body as { events: string[]; active: boolean };
      expect(updated.events).toEqual(['message.received', 'session.status']);
      expect(updated.active).toBe(false);
    });

    it('lists the webhook across all sessions via GET /api/webhooks', async () => {
      const session = await nextSession();
      const created = await createWebhook(session);

      const res = await request(app.getHttpServer()).get('/api/webhooks').set('X-API-Key', apiKey).expect(200);

      const ids = (res.body as Array<{ id: string }>).map(w => w.id);
      expect(ids).toContain(created.id);
    });

    it('deletes a webhook (204) and then it is gone (404)', async () => {
      const session = await nextSession();
      const created = await createWebhook(session);

      await request(app.getHttpServer())
        .delete(`/api/sessions/${session}/webhooks/${created.id as string}`)
        .set('X-API-Key', apiKey)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/sessions/${session}/webhooks/${created.id as string}`)
        .set('X-API-Key', apiKey)
        .expect(404);
    });
  });

  // ── auth boundaries ───────────────────────────────────────────────

  describe('auth', () => {
    it('rejects a request with no API key (401)', async () => {
      const session = await nextSession();
      await request(app.getHttpServer()).get(`/api/sessions/${session}/webhooks`).expect(401);
    });

    it('forbids a viewer-role key from creating a webhook (403)', async () => {
      const session = await nextSession();
      await request(app.getHttpServer())
        .post(`/api/sessions/${session}/webhooks`)
        .set('X-API-Key', viewerKey)
        .send({ url: receiverUrl })
        .expect(403);
    });
  });

  // ── registration validation ───────────────────────────────────────

  describe('registration validation', () => {
    it('rejects an internal URL with 400 when SSRF protection is on', async () => {
      const session = await nextSession();
      // Self-contained: turn protection on and clear any ambient SSRF_ALLOWED_HOSTS (a dev .env may
      // allowlist 127.0.0.1) so the assertion holds regardless of the local environment.
      const prevAllow = process.env.SSRF_ALLOWED_HOSTS;
      process.env.WEBHOOK_SSRF_PROTECT = 'true';
      process.env.SSRF_ALLOWED_HOSTS = '';
      try {
        await request(app.getHttpServer())
          .post(`/api/sessions/${session}/webhooks`)
          .set('X-API-Key', apiKey)
          .send({ url: 'http://169.254.169.254/hook' }) // link-local cloud metadata, a canonical SSRF target
          .expect(400);
      } finally {
        process.env.WEBHOOK_SSRF_PROTECT = 'false';
        if (prevAllow === undefined) delete process.env.SSRF_ALLOWED_HOSTS;
        else process.env.SSRF_ALLOWED_HOSTS = prevAllow;
      }
    });
  });

  // ── dispatch over real HTTP ───────────────────────────────────────

  describe('dispatch over real HTTP', () => {
    it('delivers a correctly HMAC-signed POST when a filter matches', async () => {
      const session = await nextSession();
      const secret = 'sig-secret';
      await createWebhook(session, {
        secret,
        filters: { conditions: [{ field: 'sender', operator: 'is', value: ['boss@c.us'] }] },
      });

      await webhookService.dispatch(session, 'message.received', { from: 'boss@c.us', body: 'hi' });
      await waitFor(() => received.length === 1);

      const { headers, raw, body } = received[0];
      expect(headers['x-openwa-event']).toBe('message.received');
      // Verify the signature over the exact bytes that were sent, not a re-serialization.
      const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
      expect(headers['x-openwa-signature']).toBe(expected);
      expect((body as { data: { from: string } }).data.from).toBe('boss@c.us');
    });

    it('does not deliver when the filter does not match', async () => {
      const session = await nextSession();
      await createWebhook(session, {
        filters: { conditions: [{ field: 'sender', operator: 'is', value: ['boss@c.us'] }] },
      });

      await webhookService.dispatch(session, 'message.received', { from: 'spammer@c.us', body: 'spam' });
      // No way to await a non-event; give dispatch a real chance to (not) deliver, then assert silence.
      await new Promise(r => setTimeout(r, 100));
      expect(received).toHaveLength(0);
    });

    it('passes a non-message event through a message-only filter', async () => {
      const session = await nextSession();
      await createWebhook(session, {
        filters: { conditions: [{ field: 'sender', operator: 'is', value: ['nobody@c.us'] }] },
      });

      await webhookService.dispatch(session, 'session.status', { status: 'connected' });
      await waitFor(() => received.length === 1);
      expect(received[0].headers['x-openwa-event']).toBe('session.status');
    });

    it('does not deliver to an inactive webhook', async () => {
      const session = await nextSession();
      const created = await createWebhook(session);
      await request(app.getHttpServer())
        .put(`/api/sessions/${session}/webhooks/${created.id as string}`)
        .set('X-API-Key', apiKey)
        .send({ active: false })
        .expect(200);

      await webhookService.dispatch(session, 'message.received', { from: 'a@c.us' });
      await new Promise(r => setTimeout(r, 100));
      expect(received).toHaveLength(0);
    });

    it('drops forged reserved headers but keeps custom ones on the wire', async () => {
      const session = await nextSession();
      await createWebhook(session, {
        headers: { 'X-OpenWA-Event': 'forged', 'Content-Type': 'text/plain', 'X-Custom': 'ok' },
      });

      await webhookService.dispatch(session, 'message.received', {});
      await waitFor(() => received.length === 1);

      const { headers } = received[0];
      expect(headers['x-openwa-event']).toBe('message.received'); // system value wins, not 'forged'
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-custom']).toBe('ok'); // legitimate custom header preserved
    });
  });

  // ── the test endpoint ─────────────────────────────────────────────

  describe('test endpoint', () => {
    it('POST /:id/test delivers a test event to the receiver and reports success', async () => {
      const session = await nextSession();
      const created = await createWebhook(session);

      const res = await request(app.getHttpServer())
        .post(`/api/sessions/${session}/webhooks/${created.id as string}/test`)
        .set('X-API-Key', apiKey)
        .expect(201);

      expect((res.body as { success: boolean }).success).toBe(true);
      await waitFor(() => received.length === 1);
      expect(received[0].headers['x-openwa-event']).toBe('test');
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { AuditAction } from './../src/modules/audit/entities/audit-log.entity';
import { Session } from './../src/modules/session/entities/session.entity';

// Above the 10 s deadline of waitForRow, so a row that never arrives fails with that message, not with a timeout.
jest.setTimeout(30_000);

interface AuditRow {
  action: string;
  apiKeyName: string | null;
  sessionId: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * A webhook sends every event of its session, message bodies included, to its URL, so creating one, changing it and
 * deleting it are administrative actions an operator reads back from the audit log, as it reads back the plugin,
 * instance, key and infrastructure changes of the same kind. The rows carry names and the URL host, never the secret,
 * the custom headers or the URL path and query, where a receiver token can live.
 */
describe('Webhook administration is recorded in the audit log (e2e)', () => {
  let app: INestApplication<App>;
  let sessions: Repository<Session>;
  let adminKey: string;
  let scopedKeyFor: (sessionId: string) => Promise<string>;
  const prevSsrf = process.env.WEBHOOK_SSRF_PROTECT;

  // The URL carries a token in its path and in its query, the way chat-tool webhook URLs do.
  const receiverUrl = 'https://receiver.example:8443/hooks/T0001/path-token-9f3?key=query-token-7a1';
  const secret = 'signing-secret-0123456789abcdef';
  const authorization = 'Bearer receiver-header-token-5c2';

  beforeAll(async () => {
    process.env.WEBHOOK_SSRF_PROTECT = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();
    sessions = app.get(getRepositoryToken(Session, 'data'));
    const auth = app.get(AuthService);
    adminKey = (await auth.createApiKey({ name: 'e2e-audit-admin', role: ApiKeyRole.ADMIN })).rawKey;
    scopedKeyFor = async sessionId =>
      (
        await auth.createApiKey({
          name: `e2e-audit-scoped-${sessionId}`,
          role: ApiKeyRole.ADMIN,
          allowedSessions: [sessionId],
        })
      ).rawKey;
  });

  afterAll(async () => {
    if (prevSsrf === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
    else process.env.WEBHOOK_SSRF_PROTECT = prevSsrf;
    await app?.close();
  });

  const newSession = (): Promise<Session> =>
    sessions.save(sessions.create({ name: `e2e-webhook-audit-${Date.now()}` }));

  const auditRows = async (key: string, sessionId: string, action: AuditAction): Promise<AuditRow[]> => {
    const res = await request(app.getHttpServer())
      .get(`/api/audit?action=${action}&sessionId=${sessionId}&limit=50`)
      .set('X-API-Key', key)
      .expect(200);
    return (res.body as { data: AuditRow[] }).data;
  };

  // The audit write is fire and forget, so wait for the row with a deadline instead of for a fixed time.
  const waitForRow = async (key: string, sessionId: string, action: AuditAction): Promise<AuditRow> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await auditRows(key, sessionId, action);
      if (row) return row;
      if (Date.now() > deadline) throw new Error(`no ${action} audit row within 10 s`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  it('writes a row for a create, a change of URL and a delete, naming the key, the session and only the host', async () => {
    const session = await newSession();
    const base = `/api/sessions/${session.id}/webhooks`;

    const created = await request(app.getHttpServer())
      .post(base)
      .set('X-API-Key', adminKey)
      .send({ url: receiverUrl, events: ['message.received'], secret, headers: { Authorization: authorization } })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer())
      .put(`${base}/${id}`)
      .set('X-API-Key', adminKey)
      .send({ url: 'https://other.example/hook-path-token-2e8?key=query-token-4d6', secret: `${secret}-rotated` })
      .expect(200);
    await request(app.getHttpServer()).delete(`${base}/${id}`).set('X-API-Key', adminKey).expect(204);

    const createdRow = await waitForRow(adminKey, session.id, AuditAction.WEBHOOK_CREATED);
    const updatedRow = await waitForRow(adminKey, session.id, AuditAction.WEBHOOK_UPDATED);
    const deletedRow = await waitForRow(adminKey, session.id, AuditAction.WEBHOOK_DELETED);

    for (const row of [createdRow, updatedRow, deletedRow]) {
      expect(row.apiKeyName).toBe('e2e-audit-admin');
      expect(row.sessionId).toBe(session.id);
    }
    expect(createdRow.metadata).toMatchObject({
      webhookId: id,
      urlHost: 'receiver.example:8443',
      events: ['message.received'],
      active: true,
    });
    expect(updatedRow.metadata).toMatchObject({
      webhookId: id,
      urlHost: 'other.example',
      previousUrlHost: 'receiver.example:8443',
      changed: ['url', 'secret'],
    });
    expect(deletedRow.metadata).toMatchObject({
      webhookId: id,
      urlHost: 'other.example',
      events: ['message.received'],
    });

    const stored = JSON.stringify([createdRow, updatedRow, deletedRow]);
    for (const hidden of [secret, authorization, 'path-token', 'query-token', '/hooks/', 'hook-path']) {
      expect(stored).not.toContain(hidden);
    }
  });

  it('writes nothing for an update that changes no field', async () => {
    const session = await newSession();
    const base = `/api/sessions/${session.id}/webhooks`;
    const created = await request(app.getHttpServer())
      .post(base)
      .set('X-API-Key', adminKey)
      .send({ url: receiverUrl, events: ['message.received'] })
      .expect(201);
    const id = (created.body as { id: string }).id;

    // The dashboard re-sends every field on each edit.
    await request(app.getHttpServer())
      .put(`${base}/${id}`)
      .set('X-API-Key', adminKey)
      .send({ url: receiverUrl, events: ['message.received'], active: true, retryCount: 3 })
      .expect(200);
    // A later audited change is the control: once its row is readable, the earlier write has been attempted too.
    await request(app.getHttpServer()).delete(`${base}/${id}`).set('X-API-Key', adminKey).expect(204);
    await waitForRow(adminKey, session.id, AuditAction.WEBHOOK_DELETED);

    expect(await auditRows(adminKey, session.id, AuditAction.WEBHOOK_UPDATED)).toEqual([]);
  });

  it('writes nothing for a refused change, and its rows are readable by a key scoped to the session', async () => {
    const session = await newSession();
    const base = `/api/sessions/${session.id}/webhooks`;
    await request(app.getHttpServer())
      .put(`${base}/00000000-0000-4000-8000-000000000000`)
      .set('X-API-Key', adminKey)
      .send({ url: receiverUrl })
      .expect(404);
    await request(app.getHttpServer()).post(base).set('X-API-Key', adminKey).send({ url: 'not a url' }).expect(400);
    await request(app.getHttpServer()).post(base).set('X-API-Key', adminKey).send({ url: receiverUrl }).expect(201);

    const scoped = await scopedKeyFor(session.id);
    const row = await waitForRow(scoped, session.id, AuditAction.WEBHOOK_CREATED);

    expect(row.sessionId).toBe(session.id);
    expect(await auditRows(scoped, session.id, AuditAction.WEBHOOK_UPDATED)).toEqual([]);
  });
});

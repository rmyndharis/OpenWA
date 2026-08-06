// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

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
import { Session } from './../src/modules/session/entities/session.entity';
import { AutomationRule } from './../src/modules/automation/entities/automation-rule.entity';

/**
 * REST-surface coverage for autoreply rules: CRUD with the global ValidationPipe, role
 * enforcement, and the cross-session ownership fence. Evaluation itself (matching, cooldown,
 * loop-safety) is unit-covered in automation-rules.service.spec.ts — no engine runs here.
 */
describe('Automation rules (e2e)', () => {
  let app: INestApplication<App>;
  let sessionRepo: Repository<Session>;
  let apiKey: string;
  let viewerKey: string;

  let sessionSeq = 0;
  const nextSession = async (): Promise<string> => {
    const session = await sessionRepo.save(
      sessionRepo.create({ name: `e2e-automation-${Date.now()}-${sessionSeq++}` }),
    );
    return session.id;
  };

  const createRule = async (
    session: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const res = await request(app.getHttpServer())
      .post(`/api/sessions/${session}/automation-rules`)
      .set('X-API-Key', apiKey)
      .send({ name: 'greet', replyText: 'welcome!', ...overrides })
      .expect(201);
    return res.body as Record<string, unknown>;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    sessionRepo = app.get(getRepositoryToken(Session, 'data'));
    const authService = app.get(AuthService);
    apiKey = (await authService.createApiKey({ name: 'e2e-automation-admin', role: ApiKeyRole.ADMIN })).rawKey;
    viewerKey = (await authService.createApiKey({ name: 'e2e-automation-viewer', role: ApiKeyRole.VIEWER })).rawKey;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('creates a rule with defaults and reads it back', async () => {
    const session = await nextSession();
    const rule = await createRule(session);

    expect(rule.enabled).toBe(true);
    expect(rule.cooldownSeconds).toBe(60);
    expect(rule.conditions).toBeNull();
    expect(rule.replyText).toBe('welcome!');

    const fetched = await request(app.getHttpServer())
      .get(`/api/sessions/${session}/automation-rules/${rule.id as string}`)
      .set('X-API-Key', apiKey)
      .expect(200);
    expect((fetched.body as { id: string }).id).toBe(rule.id);
  });

  it('lists rules in evaluation order and updates in place', async () => {
    const session = await nextSession();
    const first = await createRule(session, { name: 'first' });
    await createRule(session, { name: 'second' });
    // createdAt has 1-second precision on SQLite; same-second rules tie and fall back to the id
    // tiebreak. Pin distinct timestamps so the asserted order is the chronological one.
    await app
      .get<Repository<AutomationRule>>(getRepositoryToken(AutomationRule, 'data'))
      .update(first.id as string, { createdAt: new Date('2026-01-01T00:00:00Z') });

    const list = await request(app.getHttpServer())
      .get(`/api/sessions/${session}/automation-rules`)
      .set('X-API-Key', apiKey)
      .expect(200);
    expect((list.body as Array<{ name: string }>).map(r => r.name)).toEqual(['first', 'second']);

    const updated = await request(app.getHttpServer())
      .put(`/api/sessions/${session}/automation-rules/${first.id as string}`)
      .set('X-API-Key', apiKey)
      .send({ enabled: false, cooldownSeconds: 0 })
      .expect(200);
    const updatedBody = updated.body as { enabled: boolean; cooldownSeconds: number };
    expect(updatedBody.enabled).toBe(false);
    expect(updatedBody.cooldownSeconds).toBe(0);
  });

  it('deletes a rule (204) and answers 404 afterwards', async () => {
    const session = await nextSession();
    const rule = await createRule(session);

    await request(app.getHttpServer())
      .delete(`/api/sessions/${session}/automation-rules/${rule.id as string}`)
      .set('X-API-Key', apiKey)
      .expect(204);
    await request(app.getHttpServer())
      .get(`/api/sessions/${session}/automation-rules/${rule.id as string}`)
      .set('X-API-Key', apiKey)
      .expect(404);
  });

  it('fences rules to their owning session (cross-session read/update/delete answer 404)', async () => {
    const sessionA = await nextSession();
    const sessionB = await nextSession();
    const rule = await createRule(sessionA);

    const base = `/api/sessions/${sessionB}/automation-rules/${rule.id as string}`;
    await request(app.getHttpServer()).get(base).set('X-API-Key', apiKey).expect(404);
    await request(app.getHttpServer()).put(base).set('X-API-Key', apiKey).send({ name: 'x' }).expect(404);
    await request(app.getHttpServer()).delete(base).set('X-API-Key', apiKey).expect(404);
  });

  it('requires an API key (401) and the OPERATOR role (403 for a viewer)', async () => {
    const session = await nextSession();
    await request(app.getHttpServer()).get(`/api/sessions/${session}/automation-rules`).expect(401);
    await request(app.getHttpServer())
      .post(`/api/sessions/${session}/automation-rules`)
      .set('X-API-Key', viewerKey)
      .send({ name: 'x', replyText: 'y' })
      .expect(403);
  });

  it('rejects invalid rules: missing reply, unknown condition field, out-of-range cooldown', async () => {
    const session = await nextSession();
    await request(app.getHttpServer())
      .post(`/api/sessions/${session}/automation-rules`)
      .set('X-API-Key', apiKey)
      .send({ name: 'x' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/sessions/${session}/automation-rules`)
      .set('X-API-Key', apiKey)
      .send({
        name: 'x',
        replyText: 'y',
        conditions: { conditions: [{ field: 'no-such-field', operator: 'is', value: ['1'] }] },
      })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/sessions/${session}/automation-rules`)
      .set('X-API-Key', apiKey)
      .send({ name: 'x', replyText: 'y', cooldownSeconds: 999_999 })
      .expect(400);
  });
});

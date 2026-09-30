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

/**
 * End-to-end proof of the chat fence through the real HTTP stack (guard + reflector metadata + DI +
 * routing), which the unit specs mock away: a key restricted to one chat is refused on routes with no
 * chat dimension and on any other chat, and admitted where its chat is named or the list is filtered.
 * No engine runs here, so an admitted request is asserted only as "not refused by the fence".
 */
describe('Chat-restricted API keys (e2e)', () => {
  const ALLOWED = '111@c.us';
  const OTHER = '222@c.us';
  let app: INestApplication<App>;
  let sessionId: string;
  let chatKey: string; // OPERATOR, allowedChats: [ALLOWED]
  let openKey: string; // OPERATOR, unrestricted

  const get = (path: string, key: string) => request(app.getHttpServer()).get(path).set('X-API-Key', key);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-chat-scope-${Date.now()}` }))).id;

    const authService = app.get(AuthService);
    chatKey = (await authService.createApiKey({ name: 'e2e-chat', role: ApiKeyRole.OPERATOR, allowedChats: [ALLOWED] }))
      .rawKey;
    openKey = (await authService.createApiKey({ name: 'e2e-open', role: ApiKeyRole.OPERATOR })).rawKey;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  it('refuses a route with no chat dimension, which an unrestricted key reaches', async () => {
    const res = await get(`/api/sessions/${sessionId}/webhooks`, chatKey).expect(403);
    expect((res.body as { message: string }).message).toBe('API key is restricted to selected chats');
    expect((await get(`/api/sessions/${sessionId}/webhooks`, openKey)).status).not.toBe(403);
  });

  it('refuses a chat outside the allowlist in a path param and in a send body', async () => {
    const res = await get(`/api/sessions/${sessionId}/contacts/${OTHER}`, chatKey).expect(403);
    expect((res.body as { message: string }).message).toBe('API key not authorized for this chat');

    await request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/messages/send-text`)
      .set('X-API-Key', chatKey)
      .send({ chatId: OTHER, text: 'hi' })
      .expect(403);
  });

  it('admits the allowed chat', async () => {
    expect((await get(`/api/sessions/${sessionId}/contacts/${ALLOWED}`, chatKey)).status).not.toBe(403);
  });

  it('reads stored messages only for a chat it names', async () => {
    const path = `/api/sessions/${sessionId}/messages`;
    const missing = await get(path, chatKey).expect(403);
    expect((missing.body as { message: string }).message).toBe(
      'chatId is required for a key restricted to selected chats',
    );
    await get(`${path}?chatId=${OTHER}`, chatKey).expect(403);
    await get(`${path}?chatId=${ALLOWED}`, chatKey).expect(200);
    await get(path, openKey).expect(200);
  });

  it.each(['chats', 'groups', 'contacts', 'labels/1/chats'])('admits the filtered list route %s', async route => {
    expect((await get(`/api/sessions/${sessionId}/${route}`, chatKey)).status).not.toBe(403);
  });
});

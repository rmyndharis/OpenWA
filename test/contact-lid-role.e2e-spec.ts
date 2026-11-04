import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { Session } from '../src/modules/session/entities/session.entity';
import { EngineRegistry } from '../src/engine/engine-registry.service';
import { EngineTransportError } from '../src/common/errors/engine-transport.error';
import type { IWhatsAppEngine } from '../src/engine/interfaces/whatsapp-engine.interface';

/**
 * The phone-to-LID lookup is an outbound WhatsApp query about a third party, so it sits at OPERATOR like the
 * number check, and it names a phone number rather than a chat, so a key restricted to selected chats is
 * refused by the fence's default deny. These tests pin both through the real HTTP stack, and pin that an
 * unanswered lookup reaches the caller as 503 rather than as `lid: null`.
 *
 * The engine is a stub registered in the live EngineRegistry, so a 403 asserts the guard refusal itself.
 */
describe('Contact LID lookup gate (e2e)', () => {
  let app: INestApplication<App>;
  let sessionId: string;
  let viewerKey: string;
  let operatorKey: string;
  let chatRestrictedKey: string;

  const engine = { getContactLid: jest.fn() };

  const lidGet = (key: string, number = '628123456789') =>
    request(app.getHttpServer()).get(`/api/sessions/${sessionId}/contacts/${number}/lid`).set('X-API-Key', key);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-contact-lid-${Date.now()}` }))).id;

    app.get(EngineRegistry).set(sessionId, engine as unknown as IWhatsAppEngine);

    const authService = app.get(AuthService);
    viewerKey = (
      await authService.createApiKey({ name: 'e2e-lid-viewer', role: ApiKeyRole.VIEWER, allowedSessions: [sessionId] })
    ).rawKey;
    operatorKey = (await authService.createApiKey({ name: 'e2e-lid-operator', role: ApiKeyRole.OPERATOR })).rawKey;
    chatRestrictedKey = (
      await authService.createApiKey({
        name: 'e2e-lid-chat',
        role: ApiKeyRole.OPERATOR,
        allowedChats: ['628123456789@c.us'],
      })
    ).rawKey;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('refuses a VIEWER key (403) without reaching the engine', async () => {
    const res = await lidGet(viewerKey).expect(403);
    expect((res.body as { message?: string }).message).toContain('Required: operator');
    expect(engine.getContactLid).not.toHaveBeenCalled();
  });

  it('refuses an OPERATOR key restricted to selected chats (403), even for its own number', async () => {
    const res = await lidGet(chatRestrictedKey).expect(403);
    expect((res.body as { message?: string }).message).toContain('restricted to selected chats');
    expect(engine.getContactLid).not.toHaveBeenCalled();
  });

  it('serves an OPERATOR key the number and its lid', async () => {
    engine.getContactLid.mockResolvedValue('234767895240796@lid');

    const res = await lidGet(operatorKey).expect(200);

    expect(res.body).toEqual({ number: '628123456789', lid: '234767895240796@lid' });
    expect(engine.getContactLid).toHaveBeenCalledWith('628123456789');
  });

  it('answers lid:null for a number WhatsApp holds no lid for', async () => {
    engine.getContactLid.mockResolvedValue(null);

    const res = await lidGet(operatorKey).expect(200);

    expect(res.body).toEqual({ number: '628123456789', lid: null });
  });

  it('refuses a privacy id or a group id as the number (400) without asking the engine', async () => {
    await lidGet(operatorKey, '234767895240796@lid').expect(400);
    await lidGet(operatorKey, '120363021234567890@g.us').expect(400);
    expect(engine.getContactLid).not.toHaveBeenCalled();
  });

  it('passes an unanswered lookup through as 503, never as lid:null', async () => {
    engine.getContactLid.mockRejectedValue(new EngineTransportError('WhatsApp did not answer the LID lookup'));

    await lidGet(operatorKey).expect(503);
  });

  it('keeps the number check on its own handler', async () => {
    const check = jest.fn().mockResolvedValue('628123456789@c.us');
    app.get(EngineRegistry).set(sessionId, { ...engine, getNumberId: check } as unknown as IWhatsAppEngine);

    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${sessionId}/contacts/check/628123456789`)
      .set('X-API-Key', operatorKey)
      .expect(200);

    expect(res.body).toEqual({ number: '628123456789', exists: true, whatsappId: '628123456789@c.us' });
    expect(engine.getContactLid).not.toHaveBeenCalled();
  });
});

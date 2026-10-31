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
import type { IWhatsAppEngine } from '../src/engine/interfaces/whatsapp-engine.interface';

/**
 * A group invite code is a transferable join capability, not read data: whoever holds the link
 * joins the group on WhatsApp with no OpenWA credential at all, and that membership survives
 * revoking the key that fetched the code. These tests pin the invite-code GET at the OPERATOR
 * role through the real HTTP stack, mirroring the QR endpoint: the reads whose payload is a
 * credential for a system outside OpenWA's authority are not VIEWER surface.
 *
 * The engine is a stub registered in the live EngineRegistry (the message-send e2e harness), so
 * the 403 asserts the guard refusal itself while the 200s prove the pass-through path: a
 * session-scoped VIEWER key is the least-credential holder that can otherwise reach the route.
 */
describe('Group invite-code role gate (e2e)', () => {
  let app: INestApplication<App>;
  let sessionId: string;
  let scopedViewerKey: string;
  let operatorKey: string;
  let adminKey: string;
  const groupId = '120363021234567890@g.us';

  const engine = {
    getGroupInviteCode: jest.fn().mockResolvedValue('AbCdEf123456'),
  };

  const inviteCodeGet = (key: string) =>
    request(app.getHttpServer()).get(`/api/sessions/${sessionId}/groups/${groupId}/invite-code`).set('X-API-Key', key);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-invite-${Date.now()}` }))).id;

    app.get(EngineRegistry).set(sessionId, engine as unknown as IWhatsAppEngine);

    const authService = app.get(AuthService);
    scopedViewerKey = (
      await authService.createApiKey({
        name: 'e2e-invite-viewer',
        role: ApiKeyRole.VIEWER,
        allowedSessions: [sessionId],
      })
    ).rawKey;
    operatorKey = (await authService.createApiKey({ name: 'e2e-invite-operator', role: ApiKeyRole.OPERATOR })).rawKey;
    adminKey = (await authService.createApiKey({ name: 'e2e-invite-admin', role: ApiKeyRole.ADMIN })).rawKey;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore TypeORM multi-datasource teardown quirk */
    }
  });

  beforeEach(() => jest.clearAllMocks());

  it('refuses a session-scoped VIEWER key (403) without reaching the engine', async () => {
    const res = await inviteCodeGet(scopedViewerKey).expect(403);
    expect((res.body as { message?: string }).message).toContain('Required: operator');
    expect(engine.getGroupInviteCode).not.toHaveBeenCalled();
  });

  it('serves an OPERATOR key the code + link', async () => {
    const res = await inviteCodeGet(operatorKey).expect(200);
    expect(res.body).toEqual({
      inviteCode: 'AbCdEf123456',
      inviteLink: 'https://chat.whatsapp.com/AbCdEf123456',
    });
    expect(engine.getGroupInviteCode).toHaveBeenCalledWith(groupId);
  });

  it('serves an ADMIN key the code + link', async () => {
    await inviteCodeGet(adminKey).expect(200);
  });
});

import type { INestApplication, PipeTransform } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { MAX_SESSION_ID_LENGTH, SessionIdPipe } from './session-id.pipe';
import { SessionStatus } from './entities/session.entity';
import { AuditService } from '../audit/audit.service';
import { ChatScopeService } from '../auth/chat-scope.service';
import { TABLE_IMPORTERS } from '../infra/table-importers';

type RouteArg = { data?: unknown; pipes?: Array<PipeTransform | (new () => PipeTransform)> };

/** The pipes Nest runs on the `sessionId` parameter of a SessionController handler, or undefined without one. */
function sessionIdPipes(handler: string): RouteArg['pipes'] | undefined {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, SessionController, handler) as
    Record<string, RouteArg> | undefined;
  const param = Object.values(args ?? {}).find(arg => arg.data === 'sessionId');
  return param ? (param.pipes ?? []) : undefined;
}

/**
 * A backup restore keeps any safe key as a session id (sessions.id is varchar on both dialects), and the engine
 * factory, boot auto-start and every other controller accept such an id. The session routes must reach the row the
 * restore wrote, or the session runs with no way to stop, log out, force-kill or delete it over the API.
 */
describe('a restored session whose id is a safe non-UUID key', () => {
  const RESTORED_ID = 'sales-bot';
  let app: INestApplication<App>;
  const row = {
    id: RESTORED_ID,
    name: 'sales',
    status: SessionStatus.READY,
    phone: '628444',
    pushName: null,
    connectedAt: null,
    lastActiveAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const sessionService = {
    findOne: jest.fn().mockResolvedValue(row),
    findOneForDelete: jest.fn().mockResolvedValue(row),
    getConfig: jest.fn(),
    getProxy: jest.fn(),
    getPresence: jest.fn(),
    stop: jest.fn().mockResolvedValue(row),
    delete: jest.fn().mockResolvedValue(undefined),
    engineLoaded: jest.fn().mockReturnValue(true),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [SessionController],
      providers: [
        { provide: SessionService, useValue: sessionService },
        { provide: AuditService, useValue: { logInfo: jest.fn().mockResolvedValue(undefined) } },
        ChatScopeService,
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is kept by the session importer', () => {
    const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
    const skip = sessions?.skip as ((row: unknown) => string | null) | undefined;
    expect(skip?.({ id: RESTORED_ID, name: 'sales', config: {} }) ?? null).toBeNull();
  });

  it('can be read by GET /sessions/:sessionId', async () => {
    const res = await request(app.getHttpServer()).get(`/sessions/${RESTORED_ID}`);
    expect(res.status).toBe(200);
    expect(sessionService.findOne).toHaveBeenCalledWith(RESTORED_ID);
  });

  it('can be stopped by POST /sessions/:sessionId/stop', async () => {
    const res = await request(app.getHttpServer()).post(`/sessions/${RESTORED_ID}/stop`);
    expect(res.status).toBe(200);
    expect(sessionService.stop).toHaveBeenCalledWith(RESTORED_ID);
  });

  it('can be deleted by DELETE /sessions/:sessionId', async () => {
    const res = await request(app.getHttpServer()).delete(`/sessions/${RESTORED_ID}`);
    expect(res.status).toBe(204);
    expect(sessionService.delete).toHaveBeenCalledWith(RESTORED_ID);
  });

  it('is reached by every route that takes :sessionId through one shared pipe', () => {
    const routes = Object.getOwnPropertyNames(SessionController.prototype).filter(
      name => sessionIdPipes(name) !== undefined,
    );
    expect(routes.length).toBeGreaterThan(20);
    for (const name of routes) expect({ name, pipes: sessionIdPipes(name) }).toEqual({ name, pipes: [SessionIdPipe] });
  });

  describe('an id with characters or a length the routes do not take', () => {
    const tooLong = 'a'.repeat(MAX_SESSION_ID_LENGTH + 1);
    // The six routes whose documentation lists the 400.
    const routes: Array<['get' | 'post' | 'delete', string]> = [
      ['get', ''],
      ['get', '/config'],
      ['get', '/proxy'],
      ['delete', ''],
      ['post', '/stop'],
      ['get', '/presence/628111%40c.us'],
    ];

    it.each(routes.flatMap(([method, path]) => ['a.b', tooLong].map(id => [method, path, id] as const)))(
      '%s /sessions/<id>%s answers 400 for %s before the service runs',
      async (method, path, id) => {
        const res = await request(app.getHttpServer())[method](`/sessions/${id}${path}`);
        expect(res.status).toBe(400);
        expect((res.body as { message: string }).message).toContain('letters, digits and hyphens');
        for (const call of Object.values(sessionService)) expect(call).not.toHaveBeenCalled();
      },
    );
  });
});

describe('an id the sessions importer keeps', () => {
  const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
  const skip = sessions?.skip as ((row: unknown) => string | null) | undefined;
  const pipe = new SessionIdPipe();

  it.each([randomUUID(), 'sales-bot', 'a'.repeat(MAX_SESSION_ID_LENGTH)])('is taken by the routes: %s', id => {
    expect(skip?.({ id, name: 'sales', config: {} }) ?? null).toBeNull();
    expect(pipe.transform(id)).toBe(id);
  });

  it.each(['a.b', 'a/b', '..'])('is not one the routes would take: %s', id => {
    expect(skip?.({ id, name: 'sales', config: {} })).toEqual(expect.stringContaining('unsafe id'));
    expect(() => pipe.transform(id)).toThrow();
  });

  // A session restored under an id the routes refuse could run with no way to stop or delete it.
  it('is not one longer than the routes take', () => {
    const id = 'a'.repeat(MAX_SESSION_ID_LENGTH + 1);
    expect(skip?.({ id, name: 'sales', config: {} })).toEqual(expect.stringContaining('longer than'));
    expect(() => pipe.transform(id)).toThrow();
  });
});

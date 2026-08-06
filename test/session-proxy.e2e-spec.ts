// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import http from 'http';
import { AddressInfo } from 'net';
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
import { Session, SessionStatus } from './../src/modules/session/entities/session.entity';

/**
 * The routed topology end-to-end, with a fake peer standing in for the owner node: a request
 * landing here for a session another live node owns must come back with the OWNER's answer, and
 * the forwarded call must be marked so it can never bounce again. NODE_URL is set before the app
 * compiles because the config factory snapshots the environment at boot.
 */
describe('Session request forwarding (e2e)', () => {
  let app: INestApplication<App>;
  let sessions: Repository<Session>;
  let apiKey: string;
  let owner: http.Server;
  let ownerUrl: string;
  let ownerSeen: Array<{ url?: string; headers: http.IncomingHttpHeaders }>;
  const prevNodeUrl = process.env.NODE_URL;
  const prevNodeId = process.env.NODE_ID;

  beforeAll(async () => {
    process.env.NODE_URL = 'http://127.0.0.1:2785';
    process.env.NODE_ID = 'e2e-local-node';

    ownerSeen = [];
    owner = http.createServer((req, res) => {
      ownerSeen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answeredBy: 'the-peer-owner' }));
    });
    await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
    ownerUrl = `http://127.0.0.1:${(owner.address() as AddressInfo).port}`;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    sessions = app.get(getRepositoryToken(Session, 'data'));
    const authService = app.get(AuthService);
    apiKey = (await authService.createApiKey({ name: 'e2e-proxy-admin', role: ApiKeyRole.ADMIN })).rawKey;
  });

  afterAll(async () => {
    if (prevNodeUrl === undefined) delete process.env.NODE_URL;
    else process.env.NODE_URL = prevNodeUrl;
    if (prevNodeId === undefined) delete process.env.NODE_ID;
    else process.env.NODE_ID = prevNodeId;
    await new Promise<void>(resolve => owner.close(() => resolve()));
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  const seedOwnedElsewhere = async (): Promise<Session> =>
    sessions.save(
      sessions.create({
        name: `e2e-proxy-${Date.now()}`,
        status: SessionStatus.READY,
        config: {},
        nodeId: 'peer-node',
        nodeUrl: ownerUrl,
        claimedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    );

  it('relays a session-scoped request to the live owner and returns the owner’s answer', async () => {
    const session = await seedOwnedElsewhere();

    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${session.id}`)
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(res.body).toEqual({ answeredBy: 'the-peer-owner' });
    expect(res.headers['x-openwa-served-by']).toBe('peer-node');
    expect(ownerSeen).toHaveLength(1);
    expect(ownerSeen[0].url).toBe(`/api/sessions/${session.id}`);
    expect(ownerSeen[0].headers['x-openwa-forwarded']).toBe('e2e-local-node');
    expect(ownerSeen[0].headers['x-api-key']).toBe(apiKey);
  });

  it('a forwarded request landing on a live non-owner is refused — the loop dies at one hop', async () => {
    // The hop marker is client-settable, so it is verified rather than trusted: a marked request
    // that still lands on a node that is NOT the live owner (forged header, or ownership moved
    // mid-flight) answers a retryable 409 instead of executing here. Never re-forwarded either way.
    const session = await seedOwnedElsewhere();
    ownerSeen = [];

    await request(app.getHttpServer())
      .get(`/api/sessions/${session.id}`)
      .set('X-API-Key', apiKey)
      .set('x-openwa-forwarded', 'peer-node')
      .expect(409);

    expect(ownerSeen).toHaveLength(0);
  });

  it('a forwarded request is answered locally when nothing holds the session elsewhere', async () => {
    const session = await seedOwnedElsewhere();
    await sessions.update(session.id, { nodeId: null, nodeUrl: null, leaseExpiresAt: null });
    ownerSeen = [];

    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${session.id}`)
      .set('X-API-Key', apiKey)
      .set('x-openwa-forwarded', 'peer-node')
      .expect(200);

    expect(ownerSeen).toHaveLength(0);
    expect((res.body as { id: string }).id).toBe(session.id); // the LOCAL answer, straight from this node's database
  });

  it('a lapsed owner is not forwarded to — the local node answers (takeover semantics)', async () => {
    const session = await seedOwnedElsewhere();
    await sessions.update(session.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    ownerSeen = [];

    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${session.id}`)
      .set('X-API-Key', apiKey)
      .expect(200);

    expect(ownerSeen).toHaveLength(0);
    expect((res.body as { id: string }).id).toBe(session.id);
  });

  it('an unreachable live owner answers 503 naming the owner, not a hang', async () => {
    const session = await seedOwnedElsewhere();
    await sessions.update(session.id, { nodeUrl: 'http://127.0.0.1:1' });

    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${session.id}`)
      .set('X-API-Key', apiKey)
      .expect(503);

    expect((res.body as { message: string }).message).toContain('peer-node');
  });
});

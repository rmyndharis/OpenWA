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
import { FORWARD_BUFFER_LIMIT_BYTES } from './../src/modules/session/session-proxy.interceptor';

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
  const DOWNLOAD_BYTES = FORWARD_BUFFER_LIMIT_BYTES + 2 * 1024 * 1024;
  const downloadBytes = Buffer.from(Array.from({ length: DOWNLOAD_BYTES }, (_, i) => i % 251));
  const wholeBody = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };

  beforeAll(async () => {
    process.env.NODE_URL = 'http://127.0.0.1:2785';
    process.env.NODE_ID = 'e2e-local-node';

    ownerSeen = [];
    owner = http.createServer((req, res) => {
      ownerSeen.push({ url: req.url, headers: req.headers });
      // A stored-media download: bigger than the forwarding node holds, so it is relayed as it arrives.
      if (req.url?.endsWith('/media')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(DOWNLOAD_BYTES) });
        if (req.url.includes('/broken/')) {
          res.write(downloadBytes.subarray(0, FORWARD_BUFFER_LIMIT_BYTES + 1024 * 1024));
          setTimeout(() => req.socket.destroy(), 50);
        } else {
          res.end(downloadBytes);
        }
        return;
      }
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
    await app?.close();
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

  it('relays a download larger than the node holds, byte for byte, through the whole app', async () => {
    const session = await seedOwnedElsewhere();

    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${session.id}/messages/628123%40c.us/3EB0A1/media`)
      .set('X-API-Key', apiKey)
      .buffer(true)
      .parse(wholeBody as never)
      .expect(200);

    expect(res.headers['x-openwa-served-by']).toBe('peer-node');
    expect(res.headers['content-length']).toBe(String(DOWNLOAD_BYTES));
    expect((res.body as Buffer).equals(downloadBytes)).toBe(true);
  });

  it('cuts a download the owner breaks off part-way and keeps serving', async () => {
    const session = await seedOwnedElsewhere();

    await expect(
      request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/messages/broken/3EB0A1/media`)
        .set('X-API-Key', apiKey)
        .buffer(true)
        .parse(wholeBody as never),
    ).rejects.toBeDefined();

    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${session.id}`)
      .set('X-API-Key', apiKey)
      .expect(200);
    expect(res.body).toEqual({ answeredBy: 'the-peer-owner' });
  });

  it('an unreachable live owner answers 503 naming the owner, not a hang', async () => {
    const session = await seedOwnedElsewhere();
    // A port that was just released: the connection is refused, so nothing reached the owner.
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    await sessions.update(session.id, { nodeUrl: `http://127.0.0.1:${port}` });

    const res = await request(app.getHttpServer())
      .get(`/api/sessions/${session.id}`)
      .set('X-API-Key', apiKey)
      .expect(503);

    expect((res.body as { message: string }).message).toContain('peer-node');
  });
});

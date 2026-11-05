import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
 * A backup restore keeps any session id made of letters, digits and hyphens, and the engines run such a session. Every
 * session route used to answer 400 for an id that was not a UUID, so a restored session could not be stopped or
 * deleted over the API. This drives the whole application (key guard, owner lookup, route pipe, service, lifecycle and
 * the database) for a session whose id is a name-like key, written the way the restore writes it.
 */
describe('Session routes for a restored session with a non-UUID id (e2e)', () => {
  let app: INestApplication<App>;
  let sessions: Repository<Session>;
  let apiKey: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    sessions = app.get(getRepositoryToken(Session, 'data'));
    apiKey = (await app.get(AuthService).createApiKey({ name: 'e2e-restored-id', role: ApiKeyRole.ADMIN })).rawKey;
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (method: 'get' | 'post' | 'delete', path: string) =>
    request(app.getHttpServer())[method](`/api/sessions/${path}`).set('X-API-Key', apiKey);

  /** A session row with the id and name given, as the restore writes one. */
  const restore = async (id: string, name: string): Promise<Session> => {
    const row = await sessions.save(sessions.create({ id, name, status: SessionStatus.READY, config: {} }));
    // The column generates a UUID when none is given: the row has to have kept the one it was given.
    expect(row.id).toBe(id);
    expect((await sessions.findOneByOrFail({ name })).id).toBe(id);
    return row;
  };

  it('is read by its id', async () => {
    await restore('sales-bot', 'restored-read');

    const res = await call('get', 'sales-bot').expect(200);

    expect(res.body).toMatchObject({ id: 'sales-bot', name: 'restored-read' });
  });

  it('is stopped by its id and stays stopped', async () => {
    await restore('stop-bot', 'restored-stop');

    const res = await call('post', 'stop-bot/stop').expect(200);

    expect(res.body).toMatchObject({ id: 'stop-bot', status: 'disconnected' });
    expect((await sessions.findOneByOrFail({ id: 'stop-bot' })).desiredState).toBe('stopped');
  });

  it('is deleted by its id, and the id then answers 404', async () => {
    await restore('delete-bot', 'restored-delete');

    await call('delete', 'delete-bot').expect(204);

    expect(await sessions.countBy({ id: 'delete-bot' })).toBe(0);
    await call('get', 'delete-bot').expect(404);
  });

  it('answers 404 with a hint when the session name is sent instead of its id', async () => {
    await restore('named-bot', 'restored-named');

    const res = await call('get', 'restored-named').expect(404);

    expect((res.body as { message: string }).message).toBe(
      "Session with id 'restored-named' not found; session routes take the session id, not its name",
    );
  });

  it.each([
    ['a dot', 'a.b'],
    ['an underscore', 'a_b'],
    ['more than 128 characters', 'a'.repeat(129)],
  ])('answers 400 for an id with %s', async (_label, id) => {
    await call('get', id).expect(400);
    await call('post', `${id}/stop`).expect(400);
    await call('delete', id).expect(400);
  });
});

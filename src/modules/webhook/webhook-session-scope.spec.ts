// webhook by-id operations (findOne/update/delete/test) must be scoped to the URL
// :sessionId, and GET /webhooks must be scoped to the key's allowedSessions. Without it, an
// OPERATOR key for one session can read/edit/delete/redirect/fire another session's webhook,
// and enumerate every session's webhook URLs. These run against a real in-memory DB so the
// scoping is exercised end-to-end, not asserted on a mock's WHERE clause.
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { Webhook } from './entities/webhook.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';

describe('WebhookService session-scoped access', () => {
  let ds: DataSource;
  let service: WebhookService;
  let whA: Webhook;
  let whB: Webhook;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [Session, Webhook],
      synchronize: true,
    });
    await ds.initialize();
    const repo = ds.getRepository(Webhook);
    const cfg = { get: () => false }; // queue.enabled = false
    service = new WebhookService(repo, cfg as never, {} as never, undefined);

    const sessions = ds.getRepository(Session);
    for (const id of ['sessA', 'sessB']) {
      await sessions.save(sessions.create({ id, name: id, status: SessionStatus.READY, config: {} }));
    }
    whA = await repo.save(
      repo.create({
        sessionId: 'sessA',
        url: 'https://a.example/hook',
        events: ['message.received'],
        headers: {},
        retryCount: 3,
      }),
    );
    whB = await repo.save(
      repo.create({
        sessionId: 'sessB',
        url: 'https://b.example/hook',
        events: ['message.received'],
        headers: {},
        retryCount: 3,
      }),
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('findOne returns a webhook only for its owning session', async () => {
    expect((await service.findOne('sessA', whA.id)).id).toBe(whA.id);
    await expect(service.findOne('sessA', whB.id)).rejects.toThrow(NotFoundException);
  });

  it('update refuses (404) a webhook owned by another session and does not mutate it', async () => {
    await expect(service.update('sessA', whB.id, { url: 'https://evil.example/x' })).rejects.toThrow(NotFoundException);
    expect((await ds.getRepository(Webhook).findOneByOrFail({ id: whB.id })).url).toBe('https://b.example/hook');
  });

  it('delete refuses (404) a webhook owned by another session and does not remove it', async () => {
    await expect(service.delete('sessA', whB.id)).rejects.toThrow(NotFoundException);
    expect(await ds.getRepository(Webhook).countBy({ id: whB.id })).toBe(1);
  });

  it('test refuses (404) to fire a webhook owned by another session', async () => {
    await expect(service.test('sessA', whB.id)).rejects.toThrow(NotFoundException);
  });

  it('findAll scopes to allowedSessions when set, returns all when unrestricted', async () => {
    expect((await service.findAll(['sessA'])).map(w => w.id)).toEqual([whA.id]);
    expect((await service.findAll(null)).map(w => w.id).sort()).toEqual([whA.id, whB.id].sort());
    expect((await service.findAll([])).length).toBe(2); // empty allowlist = unrestricted (matches the guard)
  });
});

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { BuiltInFtsProvider } from './builtin-fts.provider';
import { AddMessagesFts } from '../../../database/migrations/1782400000000-AddMessagesFts';

describe('BuiltInFtsProvider (sqlite)', () => {
  let ds: DataSource;
  let provider: BuiltInFtsProvider;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [Session, Message], synchronize: true });
    await ds.initialize();
    await new AddMessagesFts().up(ds.createQueryRunner());
    provider = new BuiltInFtsProvider(ds);
    const repo = ds.getRepository(Message);
    await repo.insert([
      {
        sessionId: 's1',
        chatId: 'c1',
        from: 'a@c.us',
        to: 'dest@c.us',
        body: 'hello world',
        type: 'text',
        direction: MessageDirection.OUTGOING,
        timestamp: 1,
      },
      {
        sessionId: 's1',
        chatId: 'c1',
        from: 'a@c.us',
        to: 'dest@c.us',
        body: 'goodbye world',
        type: 'text',
        direction: MessageDirection.OUTGOING,
        timestamp: 2,
      },
      {
        sessionId: 's2',
        chatId: 'c2',
        from: 'b@c.us',
        to: 'dest@c.us',
        body: 'hello again',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 3,
      },
    ]);
  });
  afterEach(() => ds.destroy());

  it('matches by keyword and ranks + paginates', async () => {
    const res = await provider.search({ q: 'hello', limit: 10 });
    expect(res.provider).toBe('builtin-fts');
    expect(res.hits.length).toBe(2);
    expect(res.hits.every(h => /hello/i.test(h.snippet))).toBe(true);
    expect(res.total).toBe(2);
  });

  it('scopes by sessionIds (auth) and by sessionId filter', async () => {
    const scoped = await provider.search({ q: 'hello', sessionIds: ['s1'] });
    expect(scoped.hits.every(h => h.sessionId === 's1')).toBe(true);
    const one = await provider.search({ q: 'hello', sessionId: 's2' });
    expect(one.hits.map(h => h.sessionId)).toEqual(['s2']);
  });

  it('returns empty (not error) for no matches', async () => {
    const res = await provider.search({ q: 'zzzznomatch' });
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('reports healthy', async () => {
    expect((await provider.health()).ok).toBe(true);
  });
});

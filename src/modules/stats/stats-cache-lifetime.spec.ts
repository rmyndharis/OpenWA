import { DataSource } from 'typeorm';
import { StatsService } from './stats.service';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';

describe('StatsService memo lifetime', () => {
  let ds: DataSource;
  let service: StatsService;
  const keys = () => [...(service as unknown as { memo: Map<string, unknown> }).memo.keys()];

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    const config = { get: (_key: string, fallback: number) => (_key === 'stats.cacheTtlMs' ? 1000 : fallback) };
    service = new StatsService(ds.getRepository(Session), ds.getRepository(Message), config as never);
    for (const id of ['a', 'b']) await ds.getRepository(Session).save({ id, name: id, config: {} });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
  });

  it('drops the expired entry of a deleted session once another one is computed', async () => {
    const start = Date.now();
    await service.getSessionStats('a');
    await ds.getRepository(Session).delete({ id: 'a' });
    expect(keys()).toEqual(['session:a']);

    jest.spyOn(Date, 'now').mockReturnValue(start + 5000);
    await service.getSessionStats('b');

    expect(keys()).toEqual(['session:b']);
  });

  it('keeps an entry that has not expired', async () => {
    await service.getSessionStats('a');
    await service.getSessionStats('b');

    expect(keys().sort()).toEqual(['session:a', 'session:b']);
  });
});

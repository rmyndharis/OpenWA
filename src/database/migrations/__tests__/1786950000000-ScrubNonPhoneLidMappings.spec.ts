import { DataSource, Repository } from 'typeorm';
import { LidMapping } from '../../../engine/identity/lid-mapping.entity';
import { Message, MessageDirection, MessageStatus } from '../../../modules/message/entities/message.entity';
import { ScrubNonPhoneLidMappings1786950000000 } from '../1786950000000-ScrubNonPhoneLidMappings';

// A real SQLite database: the statements themselves are what is under test.
describe('ScrubNonPhoneLidMappings migration', () => {
  const migration = new ScrubNonPhoneLidMappings1786950000000();
  let ds: DataSource;
  let mappings: Repository<LidMapping>;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [LidMapping, Message],
      synchronize: true,
    });
    await ds.initialize();
    mappings = ds.getRepository(LidMapping);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const message = (chatId: string) =>
    ds.getRepository(Message).save({
      sessionId: 's1',
      chatId,
      waMessageId: `wa-${chatId}`,
      from: chatId,
      to: 'me@c.us',
      body: 'hi',
      type: 'text',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: 1,
    });

  it('drops a status or broadcast-list id stored as a phone and keeps real phones and negative results', async () => {
    await mappings.save([
      { lid: '111', phone: 'status', sessionId: 's1' },
      { lid: '222', phone: '1612345678', sessionId: 's1' },
      { lid: '333', phone: '628111', sessionId: 's1' },
      { lid: '444', phone: null, sessionId: 's1' },
    ]);
    await message('1612345678@broadcast');
    await message('status@broadcast');
    await message('628111@c.us');

    const runner = ds.createQueryRunner();
    await migration.up(runner);
    await migration.up(runner); // idempotent
    await runner.release();

    const rows = await mappings.find({ order: { lid: 'ASC' } });
    expect(rows.map(r => [r.lid, r.phone])).toEqual([
      ['333', '628111'],
      ['444', null],
    ]);
  });

  it('skips a database without the tables', async () => {
    const empty = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await empty.initialize();
    const runner = empty.createQueryRunner();

    await expect(migration.up(runner)).resolves.toBeUndefined();
    await expect(migration.down()).resolves.toBeUndefined();

    await runner.release();
    await empty.destroy();
  });
});

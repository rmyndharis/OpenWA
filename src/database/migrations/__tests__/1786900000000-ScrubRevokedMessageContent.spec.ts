import { DataSource, Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../../../modules/message/entities/message.entity';
import { ScrubRevokedMessageContent1786900000000 } from '../1786900000000-ScrubRevokedMessageContent';

// A real SQLite database: the statement itself is what is under test.
describe('ScrubRevokedMessageContent migration', () => {
  const migration = new ScrubRevokedMessageContent1786900000000();
  let ds: DataSource;
  let repository: Repository<Message>;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(Message);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const row = (waMessageId: string, type: string, body: string): Promise<Message> =>
    repository.save(
      repository.create({
        sessionId: 's1',
        chatId: '628111@c.us',
        waMessageId,
        from: '628111@c.us',
        to: 'me@c.us',
        body,
        type,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        timestamp: 1,
        metadata: { media: { mimetype: 'image/png', data: 'AAAA' }, reactions: { 'x@c.us': 'ok' } },
        mediaPath: `chat-media/s1/${waMessageId}.png`,
        mediaMimetype: 'image/png',
      }),
    );

  it('clears the content of revoked rows and leaves every other row alone', async () => {
    const revoked = await row('wa-revoked', 'revoked', 'This message was deleted');
    const kept = await row('wa-kept', 'image', 'caption');

    const runner = ds.createQueryRunner();
    await migration.up(runner);
    await migration.up(runner); // idempotent
    await runner.release();

    expect(await repository.findOneByOrFail({ id: revoked.id })).toMatchObject({
      body: '',
      type: 'revoked',
      metadata: null,
      mediaPath: null,
      mediaMimetype: null,
    });
    expect(await repository.findOneByOrFail({ id: kept.id })).toMatchObject({
      body: 'caption',
      metadata: kept.metadata,
      mediaPath: kept.mediaPath,
      mediaMimetype: 'image/png',
    });
  });

  it('skips a database without a messages table', async () => {
    const empty = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await empty.initialize();
    const runner = empty.createQueryRunner();

    await expect(migration.up(runner)).resolves.toBeUndefined();
    await expect(migration.down()).resolves.toBeUndefined();

    await runner.release();
    await empty.destroy();
  });
});

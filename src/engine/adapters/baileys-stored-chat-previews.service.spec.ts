import { randomUUID } from 'crypto';
import { DataSource, type Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../../modules/message/entities/message.entity';
import {
  ownAccountIds,
  StoredChatPreviewService,
  type StoredChatPreview,
} from './baileys-stored-chat-previews.service';

// The newest stored message per chat, read by a Baileys engine that starts with no chats. Runs on SQLite,
// and on the postgres:16 service when DATABASE_TYPE=postgres (the test-postgres job), where the bigint
// timestamp reads back as a string and identifiers are case-sensitive.
describe('StoredChatPreviewService', () => {
  const SESSION = 's1';
  const OWN = ['628999@c.us', '628999@s.whatsapp.net', '628999'];
  const T = 1_762_000_000;
  let db: DataSource;
  let repository: Repository<Message>;
  let service: StoredChatPreviewService;
  let stored = 0;

  /** The previews with each WhatsApp id checked for presence and left out, since the rows draw them at random. */
  const withoutIds = (previews: StoredChatPreview[]): Omit<StoredChatPreview, 'id'>[] =>
    previews.map(({ id, ...rest }) => {
      expect(id).toHaveLength(36);
      return rest;
    });

  async function row(over: Partial<Message> & { chatId: string }): Promise<void> {
    const incoming = (over.direction ?? MessageDirection.INCOMING) === MessageDirection.INCOMING;
    await repository.save(
      repository.create({
        sessionId: SESSION,
        waMessageId: randomUUID(),
        from: incoming ? over.chatId : '628999@c.us',
        to: incoming ? '628999@c.us' : over.chatId,
        body: 'text',
        type: 'text',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        timestamp: T,
        // Stored in order, a second apart: SQLite keeps createdAt to the second.
        createdAt: new Date(Date.UTC(2026, 10, 1) + ++stored * 1000),
        ...over,
      }),
    );
  }

  beforeEach(async () => {
    db = new DataSource(
      process.env.DATABASE_TYPE === 'postgres'
        ? {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema: `stored_previews_${randomUUID().replace(/-/g, '')}`,
            entities: [Message],
            synchronize: false,
          }
        : { type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true },
    );
    await db.initialize();
    if (db.options.type === 'postgres') {
      await db.query(`CREATE SCHEMA "${db.options.schema}"`);
      await db.synchronize();
    }
    repository = db.getRepository(Message);
    service = new StoredChatPreviewService(repository);
  });

  afterEach(async () => {
    if (db.options.type === 'postgres') await db.query(`DROP SCHEMA "${db.options.schema}" CASCADE`);
    await db.destroy();
  });

  it('answers the newest message of each chat, newest chat first, for this session only', async () => {
    await row({ chatId: '628111@c.us', body: 'older', timestamp: T - 50 });
    await row({ chatId: '628111@c.us', body: 'newest', timestamp: T - 10 });
    await row({ chatId: '120363001@g.us', body: 'standup', timestamp: T, author: '628333@c.us' });
    await row({ chatId: '9001@lid', body: 'sent', timestamp: T - 20, direction: MessageDirection.OUTGOING });
    await row({ chatId: '628777@c.us', sessionId: 'other', timestamp: T + 99 });

    const previews = await service.latestPerChat(SESSION, OWN, 0);

    expect(withoutIds(previews)).toEqual([
      {
        chatId: '120363001@g.us',
        fromMe: false,
        author: '628333@c.us',
        timestamp: T,
        body: 'standup',
        type: 'text',
      },
      { chatId: '628111@c.us', fromMe: false, timestamp: T - 10, body: 'newest', type: 'text' },
      { chatId: '9001@lid', fromMe: true, timestamp: T - 20, body: 'sent', type: 'text' },
    ]);
  });

  it('skips a row without a WhatsApp id or a time, and a chat that has nothing else', async () => {
    await row({ chatId: '628111@c.us', body: 'delivered', timestamp: T - 10 });
    await row({ chatId: '628111@c.us', body: 'failed send', timestamp: T, waMessageId: null as never });
    await row({ chatId: '628111@c.us', body: 'pending send', timestamp: null as never, waMessageId: null as never });
    await row({ chatId: '628222@c.us', body: 'never sent', timestamp: T, waMessageId: null as never });

    const previews = await service.latestPerChat(SESSION, OWN, 0);

    expect(previews.map(p => [p.chatId, p.body])).toEqual([['628111@c.us', 'delivered']]);
  });

  it('counts only the rows of this account, in every spelling it was stored under', async () => {
    // The account this session was linked to before: its rows survive the unlink.
    await row({ chatId: '628111@c.us', body: 'to the old number', timestamp: T, to: '628000@c.us' });
    await row({ chatId: '628111@c.us', body: 'mine', timestamp: T - 5 });
    await row({ chatId: '628222@c.us', timestamp: T, direction: MessageDirection.OUTGOING, from: '628000@c.us' });
    // A send an earlier version stored with the bare digits.
    await row({ chatId: '628333@c.us', body: 'bare', direction: MessageDirection.OUTGOING, from: '628999' });
    // A send made before the number was known names no account, whichever one it was made from.
    await row({ chatId: '628444@c.us', body: 'no number yet', direction: MessageDirection.OUTGOING, from: 'me' });
    await row({ chatId: '628555@c.us', body: 'no number yet', direction: MessageDirection.OUTGOING, from: 'me' });
    await row({ chatId: '628555@c.us', body: 'mine too', timestamp: T - 60 });

    const previews = await service.latestPerChat(SESSION, OWN, 0);

    expect(previews.map(p => [p.chatId, p.body]).sort()).toEqual([
      ['628111@c.us', 'mine'],
      ['628333@c.us', 'bare'],
      ['628555@c.us', 'mine too'],
    ]);
  });

  it('names a chat after the newest message it received with a name, not after a reply', async () => {
    await row({ chatId: '628111@c.us', chatName: 'Old name', timestamp: T - 30 });
    await row({ chatId: '628111@c.us', chatName: 'Rina', timestamp: T - 20 });
    await row({ chatId: '628111@c.us', chatName: 'Desk', direction: MessageDirection.OUTGOING, timestamp: T });
    // Received by the account this session was linked to before.
    await row({ chatId: '628111@c.us', chatName: 'Someone else', timestamp: T - 10, to: '628000@c.us' });
    await row({ chatId: '628222@c.us', direction: MessageDirection.OUTGOING, chatName: 'Desk' });
    await row({ chatId: '628333@c.us' });

    const previews = await service.latestPerChat(SESSION, OWN, 0);

    expect(Object.fromEntries(previews.map(p => [p.chatId, p.name]))).toEqual({
      '628111@c.us': 'Rina',
      '628222@c.us': undefined,
      '628333@c.us': undefined,
    });
  });

  it('answers nothing without an account to match', async () => {
    await row({ chatId: '628111@c.us' });

    await expect(service.latestPerChat(SESSION, [], 0)).resolves.toEqual([]);
  });

  it('keeps the newest chats up to the limit', async () => {
    await row({ chatId: '628111@c.us', timestamp: T - 30 });
    await row({ chatId: '628222@c.us', timestamp: T - 20 });
    await row({ chatId: '628333@c.us', timestamp: T - 10 });

    const previews = await service.latestPerChat(SESSION, OWN, 2);

    expect(previews.map(p => p.chatId)).toEqual(['628333@c.us', '628222@c.us']);
  });

  it('counts a chat of another account against the limit, which is applied before the account check', async () => {
    await row({ chatId: '628111@c.us', timestamp: T - 30 });
    await row({ chatId: '628222@c.us', timestamp: T - 20, to: '628000@c.us' });
    await row({ chatId: '628333@c.us', timestamp: T - 10, to: '628000@c.us' });

    await expect(service.latestPerChat(SESSION, OWN, 2)).resolves.toEqual([]);
    expect((await service.latestPerChat(SESSION, OWN, 3)).map(p => p.chatId)).toEqual(['628111@c.us']);
  });

  it('takes the row stored last of a second, and reads a deleted one as revoked with no text', async () => {
    await row({ chatId: '628111@c.us', body: 'first', timestamp: T });
    await row({ chatId: '628111@c.us', body: null as never, type: 'revoked', timestamp: T });

    const previews = await service.latestPerChat(SESSION, OWN, 0);

    expect(withoutIds(previews)).toEqual([
      {
        chatId: '628111@c.us',
        fromMe: false,
        timestamp: T,
        type: 'revoked',
      },
    ]);
  });

  // PostgreSQL keeps createdAt to the microsecond, so only SQLite has rows that tie on every column but the id.
  (process.env.DATABASE_TYPE === 'postgres' ? it.skip : it)(
    'takes the row inserted last of one second on SQLite, not the one with the larger id',
    async () => {
      const sameSecond = { timestamp: T, createdAt: new Date(Date.UTC(2026, 10, 2)) };
      await row({ chatId: '628111@c.us', body: 'question', id: 'ffffffff-0000-4000-8000-000000000000', ...sameSecond });
      await row({
        chatId: '628111@c.us',
        body: 'reply',
        direction: MessageDirection.OUTGOING,
        id: '00000000-0000-4000-8000-000000000000',
        ...sameSecond,
      });

      const previews = await service.latestPerChat(SESSION, OWN, 0);

      expect(previews.map(p => [p.body, p.fromMe])).toEqual([['reply', true]]);
    },
  );

  (process.env.DATABASE_TYPE === 'postgres' ? it.skip : it)(
    'reads the candidate chats from the session-chat-time index alone on SQLite',
    async () => {
      const logged: Parameters<typeof query>[] = [];
      const query = repository.manager.query.bind(repository.manager);
      jest.spyOn(repository.manager, 'query').mockImplementation((...args: Parameters<typeof query>) => {
        logged.push(args);
        return query<unknown>(...args);
      });
      await service.latestPerChat(SESSION, OWN, 0);
      const [[sql, params]] = logged;
      const plan: Array<{ detail: string }> = await query(`EXPLAIN QUERY PLAN ${sql}`, params);

      expect(plan.map(step => step.detail)).toEqual(
        expect.arrayContaining([
          'SEARCH l USING COVERING INDEX IDX_messages_session_chat_timestamp_id (sessionId=?)',
          'SEARCH w USING INDEX IDX_messages_session_chat_timestamp_id (sessionId=? AND chatId=? AND timestamp>?)',
        ]),
      );
    },
  );
});

describe('ownAccountIds', () => {
  it('names an account by its JID in both dialects and by its bare digits, never by the placeholder of an unnumbered send', () => {
    expect(ownAccountIds('628999')).toEqual(['628999@c.us', '628999@s.whatsapp.net', '628999']);
  });
});

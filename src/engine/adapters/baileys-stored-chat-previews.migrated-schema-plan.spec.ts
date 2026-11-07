import { readdirSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from '../../modules/message/entities/message.entity';
import { StoredChatPreviewService } from './baileys-stored-chat-previews.service';

/**
 * The `n` (chat name) subquery's plan on the REAL migration-built schema, which a `synchronize:
 * true` DataSource (as the sibling spec file uses, matching the repo's usual plan-pinning style)
 * does not reproduce: against a single-entity synchronized schema SQLite always seeks `n` through
 * IDX_messages_session_chat_timestamp_id regardless of the fix below, so a test built that way
 * cannot tell a working query from a regressed one. Against the migration chain's schema it does,
 * at any data size tried down to a handful of rows; this file exists only to hold that one
 * discriminating case, built the same way src/database/migrations/__tests__/migration-drift.spec.ts
 * builds its data connection.
 */
const importMigrations = (dir: string): unknown[] => {
  const out: unknown[] = [];
  for (const file of readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('.spec.ts'))
    .sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(dir, file)) as Record<string, unknown>;
    const Ctor = Object.values(mod).find(
      (v): v is new () => { up: (runner: never) => Promise<void> } =>
        typeof v === 'function' && (v as { prototype?: { up?: unknown } }).prototype?.up !== undefined,
    );
    if (Ctor) out.push(Ctor);
  }
  return out;
};
const repoRoot = join(__dirname, '../../..');

describe('StoredChatPreviewService on the migration-built schema', () => {
  it('reads the name subquery through the chatId index, not the session+direction one', async () => {
    const db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      migrations: importMigrations(join(repoRoot, 'src/database/migrations')) as never,
    });
    await db.initialize();
    try {
      await db.runMigrations({ transaction: 'all' });
      const repo = db.getRepository(Message);
      const service = new StoredChatPreviewService(repo);

      // The chat with the name is itself a candidate the name subquery must still find; an
      // outgoing-only chat (a recipient who never replies) sits beside it with no incoming row for
      // the `n` subquery to match at all, which is what made SQLite prefer the session+direction
      // index in the first place.
      await repo.save(
        repo.create({
          sessionId: 's1',
          waMessageId: 'wa1',
          chatId: '628111@c.us',
          from: '628111@c.us',
          to: '628999@c.us',
          body: 'hi',
          type: 'text',
          direction: MessageDirection.INCOMING,
          timestamp: 1000,
          chatName: 'Rina',
        }),
      );
      await repo.save(
        repo.create({
          sessionId: 's1',
          waMessageId: 'wa2',
          chatId: '628222@c.us',
          from: '628999@c.us',
          to: '628222@c.us',
          body: 'your code',
          type: 'text',
          direction: MessageDirection.OUTGOING,
          timestamp: 1001,
        }),
      );

      const spy = jest.spyOn(repo.manager, 'query');
      const previews = await service.latestPerChat('s1', ['628999@c.us', '628999@s.whatsapp.net', '628999'], 0);
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      spy.mockRestore();

      expect(previews.map(p => [p.chatId, p.name])).toEqual(
        expect.arrayContaining([
          ['628111@c.us', 'Rina'],
          ['628222@c.us', undefined],
        ]),
      );
      const plan = await db.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${sql}`, params);
      const nLine = plan.map(p => p.detail).find(detail => detail.includes('SEARCH n ') || detail.includes('SCAN n'));
      expect(nLine).toBe(
        'SEARCH n USING INDEX IDX_messages_session_chat_timestamp_id (sessionId=? AND chatId=? AND timestamp>?)',
      );
    } finally {
      // Matches migration-drift.spec.ts's own teardown: a destroy failure here must not mask an
      // assertion failure from the try block above.
      await db.destroy().catch(() => undefined);
    }
  }, 30_000);
});

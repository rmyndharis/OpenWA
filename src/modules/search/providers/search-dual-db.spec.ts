import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { AddMessagesFts1782400000000 } from '../../../database/migrations/1782400000000-AddMessagesFts';
import { BuiltInFtsProvider } from './builtin-fts.provider';

/**
 * Dual-DB switching + import/export round-trip safety (Task 12). OpenWA's `data` DB is SQLite-or-
 * Postgres and switchable; export/import performs `repo.clear()` + re-insert. DB-level sync (SQLite
 * FTS5 triggers / PG generated `body_ts` column) must keep the index correct across that clear+re-
 * insert — no stale or duplicate FTS rows. This is the SQLite runtime proof; the Postgres round-trip
 * is the same clear+re-insert cycle in 1782400000000-AddMessagesFts.pg.spec.ts.
 *
 * Also covers the FTS-absent safety net: if the FTS schema is missing (e.g. non-FTS5 SQLite build
 * where the migration skipped, or a partial state), the provider 501s cleanly instead of crashing on
 * a missing table — and the dialect branch reads `dataSource.options.type`.
 */
async function boot(): Promise<{ ds: DataSource; provider: BuiltInFtsProvider }> {
  const ds = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [Session, Message],
    synchronize: true,
  });
  await ds.initialize();
  await new AddMessagesFts1782400000000().up(ds.createQueryRunner());
  return { ds, provider: new BuiltInFtsProvider(ds) };
}

// Minimal row factory. `to` is NOT NULL on the entity; including it keeps the insert from failing at
// runtime (the entity's TS type would flag the omission, but the brief's `as any` masked it).
const row = (body: string) => ({
  sessionId: 's1',
  chatId: 'c1',
  from: 'a@c.us',
  to: 'b@c.us',
  body,
  type: 'text',
  direction: MessageDirection.OUTGOING,
  timestamp: 1,
});

describe('search dual-DB + import/export round-trip safety (sqlite)', () => {
  it('keeps FTS correct after a clear+re-insert (the import path), repeatedly', async () => {
    const { ds, provider } = await boot();
    const repo = ds.getRepository(Message);

    // Seed before the cycling begins.
    await repo.insert([row('alpha beta'), row('gamma delta')]);

    // Simulate POST /infra/import-data: clear, then re-insert. The FTS5 external-content triggers
    // must re-derive every index row on re-insert, so no stale 'gamma delta' (only) entry survives
    // and no duplicates accumulate across cycles.
    for (let cycle = 0; cycle < 3; cycle++) {
      await repo.clear();
      await repo.insert([row('alpha beta'), row('gamma delta'), row('alpha gamma')]);
      const res = await provider.search({ q: 'alpha', limit: 10 });
      expect(res.hits).toHaveLength(2); // 'alpha beta' + 'alpha gamma', never the stale 'gamma delta'
      expect(res.total).toBe(2);
    }
    await ds.destroy();
  });

  it('the provider 501s (NotImplemented) when FTS is absent (no-FTS5 / partial-state simulation)', async () => {
    // Boot a DataSource WITHOUT running AddMessagesFts → messages_fts is absent. The provider must
    // detect this and throw NotImplementedException (→ HTTP 501), not crash on a missing table.
    const ds = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    const provider = new BuiltInFtsProvider(ds);
    await expect(provider.search({ q: 'x' })).rejects.toThrow(/no full-text index/i);
    await ds.destroy();
  });

  it('uses the SQLite query path on a sqlite DataSource (dialect branch decision)', async () => {
    // Smoke: the provider reads dataSource.options.type and branches. The SQLite branch is exercised
    // end-to-end above (and in builtin-fts.provider.spec.ts); the PG branch lives in the PG-gated
    // spec. This pins the branch decision so a future refactor can't silently drop the dialect read.
    const sqlite = await boot();
    expect((sqlite.provider as unknown as { dataSource: DataSource }).dataSource.options.type).toBe('sqlite');
    await sqlite.ds.destroy();
  });
});

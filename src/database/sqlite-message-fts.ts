/**
 * Bring the SQLite `messages_fts` index back in line with `messages`.
 *
 * It is an external-content FTS5 table keyed on the implicit rowid, so it breaks silently: the 1782400000000
 * backfill skips NULL bodies while the insert trigger indexes them, a repeated backfill doubles an
 * index's postings, and a table rebuild (synchronize, `addColumn`) renumbers rowids around deleted rows
 * and leaves every key naming another message. A rowid anti-join cannot see any of that; the rank=1
 * integrity check recomputes every document from the content table and fails on all of it.
 */
export async function repairSqliteMessageFts(database: { query(sql: string): Promise<unknown> }): Promise<void> {
  const tables = (await database.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'`,
  )) as unknown[];
  if (tables.length === 0) return;

  const integrityCheck = `INSERT INTO "messages_fts"("messages_fts", "rank") VALUES ('integrity-check', 1)`;
  try {
    await database.query(integrityCheck);
  } catch (error) {
    const failure = error as { code?: string; driverError?: { code?: string } } | null;
    // Any other failure (busy, I/O, a missing content table) says nothing about the index: rebuilding on it
    // would only hide the cause.
    if ((failure?.driverError?.code ?? failure?.code) !== 'SQLITE_CORRUPT_VTAB') throw error;
    await database.query(`INSERT INTO "messages_fts"("messages_fts") VALUES ('rebuild')`);
    await database.query(integrityCheck);
  }
}

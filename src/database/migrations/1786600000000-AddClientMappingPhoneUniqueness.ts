import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes "one real contact = one row per (session, phone)" a DB-level invariant, not just an
 * app-layer convention (`ClientMappingService.resolveAndUpsert`) — see docs/32 §5.
 *
 * WhatsApp addresses the same person through two different jids that both land in this table under
 * the ORIGINAL (sessionId, jid, kind) uniqueness: a `@c.us` jid from a 1:1 chat/contact, and a
 * `@lid` jid from a group's participant list (WhatsApp's own contact store keeps two models for one
 * real contact — verified live, same pushName, same effective id, different `number`).
 * `resolveAndUpsert` stops this for every NEW row by resolving `@lid` -> phone and matching on
 * `phone` before creating, but a partial unique index is the backstop for any write path someone
 * adds later that forgets to call it — the constraint fires with a clear DB error instead of a
 * silent duplicate.
 *
 * Adds `aliasJids` (a JSON array, nullable) alongside the index: when resolveAndUpsert's phone match
 * fires, it is the one place that now remembers "this phone is also addressed by jid X" instead of
 * silently discarding that jid, without disturbing the winning row's own `jid` column.
 *
 * `WHERE "phone" IS NOT NULL` is what makes the index partial rather than a bare composite unique:
 * a group/teammate row's `phone` is always NULL (see entity doc comment), and both dialects would
 * otherwise decline to unique-index a NULL only by accident of "NULLs are distinct" rather than by
 * design — being explicit means the intent survives a future column that legitimately allows NULL
 * phones for another reason.
 *
 * Pre-existing duplicate phones (the same bug this migration is closing) are merged BEFORE the index
 * is created, or the CREATE UNIQUE INDEX itself would fail on live data — see the loop below. The
 * richer row wins (more of company/team/role/notes filled in over the placeholder/null); the loser's
 * jid is preserved on the winner's `aliasJids` rather than silently dropped, then the loser row is
 * deleted. Hand-authored (not `migration:generate`) because `synchronize` is off for `data`, same as
 * every other migration in this chain.
 */
export class AddClientMappingPhoneUniqueness1786600000000 implements MigrationInterface {
  name = 'AddClientMappingPhoneUniqueness1786600000000';

  private static readonly TABLE = 'client_mappings';
  private static readonly INDEX = 'UQ_client_mappings_session_phone';

  /** Single-quote doubling — the standard SQL string-literal escape, used because this table's
   * ids/jids are interpolated straight from a prior SELECT rather than through a parameter binding
   * (this repo's migrations do not have an established cross-dialect parameter-placeholder
   * convention: SQLite takes `?`, Postgres takes `$1`), following the interpolation style already
   * used throughout this migration chain (e.g. AddSessionOwnership's `${column}` in DROP COLUMN). */
  private static esc(value: string): string {
    return value.replace(/'/g, "''");
  }

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.dataSource.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = '${AddClientMappingPhoneUniqueness1786600000000.TABLE}' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(
      `PRAGMA table_info("${AddClientMappingPhoneUniqueness1786600000000.TABLE}")`,
    )) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const TABLE = AddClientMappingPhoneUniqueness1786600000000.TABLE;
    if (!(await queryRunner.hasTable(TABLE))) return;

    if (!(await this.hasColumn(queryRunner, 'aliasJids'))) {
      await queryRunner.query(`ALTER TABLE "${TABLE}" ADD COLUMN "aliasJids" text`);
    }

    type Row = {
      id: string;
      sessionId: string | null;
      jid: string;
      phone: string;
      company: string;
      team: string | null;
      role: string | null;
      notes: string | null;
      aliasJids: string | null;
      updatedAt: string;
    };
    const rows = (await queryRunner.query(
      `SELECT "id", "sessionId", "jid", "phone", "company", "team", "role", "notes", "aliasJids", "updatedAt" ` +
        `FROM "${TABLE}" WHERE "kind" = 'contact' AND "phone" IS NOT NULL`,
    )) as Row[];

    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      // sessionId is non-null for every real contact row in practice (the service layer requires it
      // for kind=contact), but group defensively rather than assume it — a stray NULL-session contact
      // colliding with another NULL-session contact of the same phone is still the same bug.
      const key = `${row.sessionId ?? ''}${row.phone}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    // Richness: how many of the fields an automatic writer can never fill in are actually filled in.
    // Ties break on the most recently updated row — the one a human most recently touched.
    const richness = (r: Row): number =>
      (r.company && r.company !== 'Unknown' ? 1 : 0) + (r.team ? 1 : 0) + (r.role ? 1 : 0) + (r.notes ? 1 : 0);

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => richness(b) - richness(a) || (a.updatedAt < b.updatedAt ? 1 : -1));
      const [winner, ...losers] = group;

      const existingAliases: string[] = (() => {
        try {
          const parsed: unknown = winner.aliasJids ? JSON.parse(winner.aliasJids) : [];
          return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
        } catch {
          return [];
        }
      })();
      const mergedAliases = [...new Set([...existingAliases, winner.jid, ...losers.map(l => l.jid)])];

      await queryRunner.query(
        `UPDATE "${TABLE}" SET "aliasJids" = '${AddClientMappingPhoneUniqueness1786600000000.esc(JSON.stringify(mergedAliases))}' WHERE "id" = '${AddClientMappingPhoneUniqueness1786600000000.esc(winner.id)}'`,
      );
      for (const loser of losers) {
        await queryRunner.query(
          `DELETE FROM "${TABLE}" WHERE "id" = '${AddClientMappingPhoneUniqueness1786600000000.esc(loser.id)}'`,
        );
      }
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${AddClientMappingPhoneUniqueness1786600000000.INDEX}" ON "${TABLE}" ("sessionId", "phone") WHERE "phone" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const TABLE = AddClientMappingPhoneUniqueness1786600000000.TABLE;
    await queryRunner.query(`DROP INDEX IF EXISTS "${AddClientMappingPhoneUniqueness1786600000000.INDEX}"`);
    if (await queryRunner.hasTable(TABLE)) {
      if (await this.hasColumn(queryRunner, 'aliasJids')) {
        await queryRunner.query(`ALTER TABLE "${TABLE}" DROP COLUMN "aliasJids"`);
      }
    }
  }
}

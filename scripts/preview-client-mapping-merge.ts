// Preview or apply the client_mappings phone-duplicate merge that migration 1786600000000
// (docs/32 §5) performs automatically, unattended, the next time the app boots against this
// database — merging is destructive (it deletes the loser row of each duplicate pair) and that
// migration otherwise gives an operator no chance to see it coming first.
//
// Runs the SAME migration class the automatic boot migration runs, inside one transaction, so there
// is no second implementation of the merge/richness logic to drift out of sync with 1786600000000.
// Default mode reports what it found and ROLLS BACK — the database ends up byte-identical to before
// this script ran. Add --apply to COMMIT the same merge for real right now, ahead of a deploy.
//
// Usage:
//   npx ts-node scripts/preview-client-mapping-merge.ts            # dry run (default)
//   npx ts-node scripts/preview-client-mapping-merge.ts --apply    # apply for real
import dataSource from '../src/database/data-source';
import { AddClientMappingPhoneUniqueness1786600000000 } from '../src/database/migrations/1786600000000-AddClientMappingPhoneUniqueness';

interface ContactPhoneRow {
  id: string;
  sessionId: string | null;
  jid: string;
  phone: string;
  name: string;
  company: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.startTransaction();

  try {
    if (!(await runner.hasTable('client_mappings'))) {
      console.log('client_mappings table does not exist yet — nothing to preview.');
      await runner.rollbackTransaction();
      return;
    }

    const before = (await runner.query(
      `SELECT "id", "sessionId", "jid", "phone", "name", "company" FROM "client_mappings" ` +
        `WHERE "kind" = 'contact' AND "phone" IS NOT NULL`,
    )) as ContactPhoneRow[];

    const groups = new Map<string, ContactPhoneRow[]>();
    for (const row of before) {
      const key = `${row.sessionId ?? ''}::${row.phone}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    const duplicateGroups = [...groups.values()].filter(group => group.length > 1);

    if (duplicateGroups.length === 0) {
      console.log('No duplicate (session, phone) pairs found. Nothing to merge.');
      await runner.rollbackTransaction();
      return;
    }

    console.log(`Found ${duplicateGroups.length} duplicate phone group(s):\n`);
    for (const group of duplicateGroups) {
      console.log(`  phone ${group[0].phone}  (session ${group[0].sessionId ?? '(none)'})`);
      for (const row of group) {
        console.log(`    - ${row.jid}  "${row.name}"  company=${row.company}  id=${row.id}`);
      }
    }

    await new AddClientMappingPhoneUniqueness1786600000000().up(runner);

    const mergedIds = [...new Set(duplicateGroups.flat().map(row => row.id))];
    const after = (await runner.query(
      `SELECT "id", "jid", "aliasJids" FROM "client_mappings" WHERE "id" IN (${mergedIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')})`,
    )) as Array<{ id: string; jid: string; aliasJids: string | null }>;
    const survivorIds = new Set(after.map(row => row.id));

    console.log('\nAfter merge:');
    for (const group of duplicateGroups) {
      const survivor = group.find(row => survivorIds.has(row.id));
      const removed = group.filter(row => !survivorIds.has(row.id));
      const survivorAfter = after.find(row => row.id === survivor?.id);
      console.log(
        `  phone ${group[0].phone}: kept "${survivor?.name}" (${survivor?.jid}, id=${survivor?.id}); ` +
          `removed ${removed.map(row => row.jid).join(', ') || '(none)'}`,
      );
      console.log(`    aliasJids -> ${survivorAfter?.aliasJids ?? 'null'}`);
    }

    if (apply) {
      await runner.commitTransaction();
      console.log(`\nAPPLIED — ${duplicateGroups.length} group(s) merged for real.`);
    } else {
      await runner.rollbackTransaction();
      console.log('\nDRY RUN — no changes were made. Re-run with --apply to perform this merge for real.');
    }
  } catch (err) {
    await runner.rollbackTransaction().catch(() => undefined);
    throw err;
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

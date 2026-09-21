import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsBoolean, IsObject, IsOptional } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';
import type { MigrationTables } from '../migration-tables.types';
import { TABLE_IMPORTERS } from '../table-importers';

/**
 * The table keys the restore actually reads, derived from the importer registry rather than restated,
 * so a table added to TABLE_IMPORTERS cannot go missing from the published body schema.
 */
const TABLE_PROPERTIES: Record<string, { type: 'array' }> = Object.fromEntries(
  TABLE_IMPORTERS.map((importer): [string, { type: 'array' }] => [importer.key, { type: 'array' }]),
);

/**
 * Body for POST /infra/import-data, the replace-all restore. A class (not an inline object literal)
 * so the global ValidationPipe's whitelist/forbidNonWhitelisted actually runs — the same reason
 * ImportStorageDto is one. An inline `@Body()` type erases at runtime, so on the most destructive
 * route in the product a body carrying no `tables` reached the handler and failed as a 500 from
 * inside the restore, and a misspelled key was accepted in silence.
 *
 * `tables` is validated as an object and not descended into: without @ValidateNested the per-table
 * row arrays are leaf values, so whitelist cannot strip them. That is load-bearing, not incidental —
 * every key omitted here is restored EMPTY, so a whitelist that reached inside would silently blank
 * the database it was asked to restore.
 *
 * Both flags only ever OPEN an escape from the orphan-engine refusal, so they are kept strict. Under
 * the pipe's enableImplicitConversion a plain `boolean` property casts every non-empty string —
 * `'false'` among them — to `true` before @IsBoolean() can object, which would open that escape for
 * a caller who spelled the opposite. @ToStrictBoolean accepts only a real boolean or an exact
 * 'true'/'false' and leaves anything else to be refused. An absent flag stays absent, so the default
 * path is still the visible 409 IMPORT_WOULD_ORPHAN_ENGINES.
 *
 * The body IS the export file: `docs/14` tells the operator to post it whole, and the export wraps
 * `tables` in five metadata fields. They are declared with @Allow — accepted, never read — because
 * `forbidNonWhitelisted` rejects any property the class does not name, and rejecting the product's
 * own backup would break the restore this route exists for. They carry no constraints on purpose: a
 * restore must not fail over the shape of a field it ignores, including one written by an older
 * release. `import-data.dto.spec.ts` binds this list to the export contract, so a field added to the
 * export cannot silently start failing the import again.
 */
export class ImportDataDto {
  @ApiProperty({
    type: 'object',
    description: `Every one of the ${TABLE_IMPORTERS.length} migration tables is emptied before the restore runs, so a key omitted here is restored EMPTY rather than left untouched. Post the whole GET /api/infra/export-data payload, not a hand-built subset.`,
    properties: TABLE_PROPERTIES,
  })
  @IsObject()
  tables!: Partial<MigrationTables>;

  @ApiPropertyOptional({
    description:
      'Allow the replace to proceed even while engines are running for sessions the backup does not contain (they keep running until restart; see restartRequired). Prefer stopOrphans, which closes that window inside this request instead.',
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({
    description:
      'Stop the running engines for sessions the backup does not contain, inside this request and before the replace runs. Supersedes force for the orphan case: with stopOrphans the engines no longer need a process restart to reconcile, so restartRequired stays false on the success path.',
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  stopOrphans?: boolean;

  // ---- Export-envelope metadata: accepted so the backup posts back verbatim, never read. ----

  // Each carries an explicit published `type` matching what the export sends. The declared TS type is
  // `unknown` because the restore never reads them, but an untyped @ApiPropertyOptional over `unknown`
  // publishes `type: object`, which for `exportedAt` breaks the contract invariant that a timestamp
  // property is never a bare object (`openapi-contract.spec.ts`).

  @ApiPropertyOptional({ type: 'string', description: 'Ignored. Present so the export file posts back unmodified.' })
  @Allow()
  exportedAt?: unknown;

  @ApiPropertyOptional({ type: 'string', description: 'Ignored. Present so the export file posts back unmodified.' })
  @Allow()
  dataDbType?: unknown;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Ignored. Present so the export file posts back unmodified.',
  })
  @Allow()
  counts?: unknown;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    description: 'Ignored. Present so the export file posts back unmodified.',
  })
  @Allow()
  skippedTables?: unknown;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Ignored. Present so the export file posts back unmodified.',
  })
  @Allow()
  omittedInlineMedia?: unknown;
}

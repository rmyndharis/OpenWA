// Generates the committed OpenAPI snapshot by bootstrapping the Nest app WITHOUT listening,
// then calling SwaggerModule.createDocument(). The script pins a hermetic environment below
// (in-memory main SQLite + a temp-dir data SQLite that is removed on exit, queue/MCP off) so it is
// safe to run anywhere: no DB files are left behind, no Redis connection is opened, no engines
// start, no sessions run. The version is sourced from package.json via swagger.config.ts, so the
// snapshot tracks releases automatically.
//
// Usage: npx ts-node scripts/export-openapi.ts <output-path> [--fast]
//   default Runs the real migration boot gate, then exports from a separate synchronized throwaway app.
//   --fast  Skips the migration boot gate. Local iteration only; never use for CI/release snapshots.
import '../src/config/load-env';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwaggerConfig, dropUnexpressibleOperations, exemptPublicOperations } from '../src/config/swagger.config';

// Parse CLI args
const args = process.argv.slice(2);
const fastMode = args.includes('--fast');
const requestedOutPath = args.find(a => !a.startsWith('--'));
if (!requestedOutPath) {
  console.error('Usage: npx ts-node scripts/export-openapi.ts <output-path> [--fast]');
  console.error('  --fast  Skip the real migration boot gate. NOT for CI/production snapshots.');
  process.exit(1);
}
const outPath: string = requestedOutPath;

// Pin a hermetic env BEFORE AppModule is imported. AppModule reads QUEUE_ENABLED / MCP_ENABLED at
// module top-level (its conditional module mounts) and TypeORM reads the DB settings during
// NestFactory.create() below - so these pins must win over whatever the loader applied above. That
// is why AppModule is imported dynamically inside main(), after these assignments. (NestFactory.create
// never calls init(), so onModuleInit / onApplicationBootstrap hooks - session autostart, the
// PROCESSING-batch and message-type backfills - do not fire regardless; the pins are belt-and-braces.)
process.env.QUEUE_ENABLED = 'false';
process.env.MCP_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';
process.env.DATABASE_TYPE = 'sqlite';
// Keep the throttler storage in-memory: with REDIS_ENABLED=true in the caller's env the export
// would open a Redis connection for no benefit (the document doesn't change either way).
process.env.REDIS_ENABLED = 'false';
// The search module mounts conditionally on SEARCH_ENABLED (app.module.ts top-level), so an
// export run with SEARCH_ENABLED=false in the caller's env would silently drop /api/search from
// the snapshot. Pin it on - the committed snapshot documents the full default surface.
process.env.SEARCH_ENABLED = 'true';
// Lifecycle hooks still run in the real migration gate. Make that boot validation-only: do not scan
// user plugin directories or register/enable a WhatsApp engine while generating documentation.
process.env.OPENAPI_EXPORT = 'true';

// The 'data' connection must use a real SQLite file path to satisfy env-validation (an in-memory or
// bare value is rejected to catch PostgreSQL db-name leaks - see env.validation.ts). Use a temp dir
// so the export stays hermetic; the whole dir is removed in main()'s finally, and recursive rmSync
// also drops any SQLite -wal/-shm sidecars. The 'main' connection keeps in-memory SQLite.
const exportDataDir = mkdtempSync(join(tmpdir(), 'openapi-export-'));
process.env.DATABASE_NAME = join(exportDataDir, 'export.sqlite');
process.env.MAIN_DATABASE_NAME = ':memory:';
// AuthService seeds an ADMIN key during app.init(). Keep that credential inside the temporary
// export directory rather than touching the operator's real data/.api-key.
process.env.BOOTSTRAP_KEY_FILE = join(exportDataDir, '.api-key');

// The default configuration is the real boot gate: migrations on and schema synchronization off.
// Only configureDisposableExport() may enable synchronize, after the gate has succeeded (or when the
// caller explicitly selects --fast). This prevents the export bootstrap from masking migration drift.
process.env.DATABASE_SYNCHRONIZE = 'false';
process.env.MAIN_DATABASE_SYNCHRONIZE = 'false';
process.env.DATABASE_MIGRATIONS_RUN = 'true';
process.env.MAIN_DATABASE_MIGRATIONS_RUN = 'true';

function configureDisposableExport(): void {
  process.env.DATABASE_NAME = join(exportDataDir, 'export.sqlite');
  process.env.MAIN_DATABASE_NAME = ':memory:';
  process.env.DATABASE_SYNCHRONIZE = 'true';
  process.env.MAIN_DATABASE_SYNCHRONIZE = 'true';
  process.env.DATABASE_MIGRATIONS_RUN = 'false';
  process.env.MAIN_DATABASE_MIGRATIONS_RUN = 'false';
}

async function validateRealBoot(): Promise<void> {
  const bootDataDir = mkdtempSync(join(tmpdir(), 'openapi-boot-gate-'));
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    process.env.DATABASE_NAME = join(bootDataDir, 'data.sqlite');
    process.env.MAIN_DATABASE_NAME = join(bootDataDir, 'main.sqlite');
    process.env.BOOTSTRAP_KEY_FILE = join(bootDataDir, '.api-key');
    process.env.DATABASE_SYNCHRONIZE = 'false';
    process.env.MAIN_DATABASE_SYNCHRONIZE = 'false';
    process.env.DATABASE_MIGRATIONS_RUN = 'true';
    process.env.MAIN_DATABASE_MIGRATIONS_RUN = 'true';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    await app.init();
  } finally {
    await app?.close();
    rmSync(bootDataDir, { recursive: true, force: true });
  }
}

async function main() {
  if (fastMode) {
    console.warn('⚠  FAST MODE: Skipping the real migration boot gate. Do NOT use for CI/production snapshots.');
  } else {
    await validateRealBoot();
  }
  configureDisposableExport();
  process.env.BOOTSTRAP_KEY_FILE = join(exportDataDir, '.api-key');

  // Imported after the env pins above so AppModule's top-level reads the hermetic values. Uses
  // require() (not a dynamic import()) so ts-node's CommonJS hook resolves the .ts directly - a
  // native import() would fail with ERR_MODULE_NOT_FOUND under ts-node CJS.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../src/app.module');
  // Bootstrap the full DI graph so every controller/DTO is discovered, but never listen.
  // Errors/warns only - bootstrap is chatty and we only need the document.
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  // Mirror main.ts: the global /api prefix is part of the real route paths the docs publish.
  app.setGlobalPrefix('api');
  try {
    const doc = SwaggerModule.createDocument(app, createSwaggerConfig());
    // Before the exemption pass, so it never spends work on an operation about to be removed.
    dropUnexpressibleOperations(doc);
    exemptPublicOperations(doc);
    writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
    console.log(
      '✔ OpenAPI snapshot written to ' +
        outPath +
        ' (version ' +
        doc.info.version +
        ', ' +
        Object.keys(doc.paths).length +
        ' paths)' +
        (fastMode ? ' [FAST MODE]' : ''),
    );
  } finally {
    await app.close();
    rmSync(exportDataDir, { recursive: true, force: true });
  }
}

void main().catch(e => {
  console.error(e);
  process.exit(1);
});

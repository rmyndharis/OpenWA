// Generates the committed OpenAPI snapshot by bootstrapping the Nest app WITHOUT listening,
// then calling SwaggerModule.createDocument(). The script pins a hermetic environment below
// (in-memory main SQLite + a temp-dir data SQLite that is removed on exit, queue/MCP off) so it is
// safe to run anywhere: no DB files are left behind, no Redis connection is opened, no engines
// start, no sessions run. The version is sourced from package.json via swagger.config.ts, so the
// snapshot tracks releases automatically.
//
// Usage: npx ts-node scripts/export-openapi.ts <output-path>
import '../src/config/load-env';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwaggerConfig, exemptPublicOperations } from '../src/config/swagger.config';

// Pin a hermetic env BEFORE AppModule is imported. AppModule reads QUEUE_ENABLED / MCP_ENABLED at
// module top-level (its conditional module mounts) and TypeORM reads the DB settings during
// NestFactory.create() below — so these pins must win over whatever the loader applied above. That
// is why AppModule is imported dynamically inside main(), after these assignments. (NestFactory.create
// never calls init(), so onModuleInit / onApplicationBootstrap hooks — session autostart, the
// PROCESSING-batch and message-type backfills — do not fire regardless; the pins are belt-and-braces.)
process.env.QUEUE_ENABLED = 'false';
process.env.MCP_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';
process.env.DATABASE_TYPE = 'sqlite';
// The 'data' connection must use a real SQLite file path to satisfy env-validation (an in-memory or
// bare value is rejected to catch PostgreSQL db-name leaks — see env.validation.ts). Use a temp dir
// so the export stays hermetic; the whole dir is removed in main()'s finally, and recursive rmSync
// also drops any SQLite -wal/-shm sidecars. The 'main' connection keeps in-memory SQLite.
const exportDataDir = mkdtempSync(join(tmpdir(), 'openapi-export-'));
process.env.DATABASE_NAME = join(exportDataDir, 'export.sqlite');
process.env.MAIN_DATABASE_NAME = ':memory:';

async function main() {
  // Operator-supplied CLI path — this is a local dev/CI tool, not a network service, so there is
  // no trust boundary to enforce (the caller already has full filesystem access). No path
  // validation is applied by design; restricting writes to cwd would break legitimate out-of-tree
  // snapshot writes, which the documented usage explicitly allows.
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: npx ts-node scripts/export-openapi.ts <output-path>');
    process.exit(1);
  }
  // Imported after the env pins above so AppModule's top-level reads the hermetic values. Uses
  // require() (not a dynamic import()) so ts-node's CommonJS hook resolves the .ts directly — a
  // native import() would fail with ERR_MODULE_NOT_FOUND under ts-node CJS.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../src/app.module');
  // Bootstrap the full DI graph so every controller/DTO is discovered, but never listen.
  // Errors/warns only — bootstrap is chatty and we only need the document.
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  // Mirror main.ts: the global /api prefix is part of the real route paths the docs publish.
  app.setGlobalPrefix('api');
  try {
    const doc = SwaggerModule.createDocument(app, createSwaggerConfig());
    exemptPublicOperations(doc);
    writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
    console.log(`✓ OpenAPI snapshot written to ${out} (version ${doc.info.version}, ${Object.keys(doc.paths).length} paths)`);
  } finally {
    await app.close();
    rmSync(exportDataDir, { recursive: true, force: true });
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

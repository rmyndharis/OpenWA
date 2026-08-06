import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural gate for scripts/export-openapi.ts: the committed OpenAPI snapshot must be
 * deterministic, which holds only because the script pins every env var that changes the
 * document (conditional module mounts, storage backends) BEFORE requiring AppModule. If a pin
 * is dropped — or AppModule gets required above the pins — two exports under different
 * environments can diverge and `npm run openapi:check` turns flaky. Verified end-to-end by
 * running the export twice under different env; this spec keeps the mechanism intact.
 */
const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'export-openapi.ts');
const source = readFileSync(SCRIPT_PATH, 'utf8');

// Env vars that alter the generated document or the export's hermeticity.
const REQUIRED_PINS = [
  'QUEUE_ENABLED',
  'MCP_ENABLED',
  'AUTO_START_SESSIONS',
  'DATABASE_TYPE',
  'DATABASE_NAME',
  'MAIN_DATABASE_NAME',
  'REDIS_ENABLED',
  // The search module mounts conditionally on SEARCH_ENABLED — without this pin an export run
  // with SEARCH_ENABLED=false in the caller's env silently drops /api/search from the snapshot.
  'SEARCH_ENABLED',
];

describe('openapi export env pins', () => {
  it.each(REQUIRED_PINS)('pins %s before AppModule is required', name => {
    const pinIndex = source.indexOf(`process.env.${name} =`);
    const requireIndex = source.indexOf("require('../src/app.module')");

    expect(pinIndex).toBeGreaterThanOrEqual(0);
    expect(requireIndex).toBeGreaterThanOrEqual(0);
    expect(pinIndex).toBeLessThan(requireIndex);
  });
});

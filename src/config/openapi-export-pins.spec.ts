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
  'OPENAPI_EXPORT',
  'DATABASE_TYPE',
  'DATABASE_NAME',
  'MAIN_DATABASE_NAME',
  'BOOTSTRAP_KEY_FILE',
  'DATABASE_SYNCHRONIZE',
  'MAIN_DATABASE_SYNCHRONIZE',
  'DATABASE_MIGRATIONS_RUN',
  'MAIN_DATABASE_MIGRATIONS_RUN',
  'REDIS_ENABLED',
  // The search module mounts conditionally on SEARCH_ENABLED — without this pin an export run
  // with SEARCH_ENABLED=false in the caller's env silently drops /api/search from the snapshot.
  'SEARCH_ENABLED',
];

describe('openapi export env pins', () => {
  it('runs the real migration boot gate before configuring the synchronized disposable export', () => {
    expect(source).toContain("const fastMode = args.includes('--fast')");

    const defaultGate = source.match(
      /if \(fastMode\) \{[\s\S]*?\} else \{[\s\S]*?await validateRealBoot\(\);[\s\S]*?\}/,
    )?.[0];
    expect(defaultGate).toBeDefined();

    const validateIndex = source.indexOf('await validateRealBoot();');
    const disposableIndex = source.indexOf('configureDisposableExport();', validateIndex);
    const exportBootIndex = source.indexOf('const app = await NestFactory.create(AppModule', disposableIndex);
    expect(validateIndex).toBeGreaterThanOrEqual(0);
    expect(disposableIndex).toBeGreaterThan(validateIndex);
    expect(exportBootIndex).toBeGreaterThan(disposableIndex);
  });

  it('uses migrations without synchronize for the real gate and confines synchronize to disposable export setup', () => {
    const gateSource = source.match(/async function validateRealBoot\(\): Promise<void> \{([\s\S]*?)\n\}/)?.[1];
    const disposableSource = source.match(/function configureDisposableExport\(\): void \{([\s\S]*?)\n\}/)?.[1];

    expect(gateSource).toContain("process.env.DATABASE_SYNCHRONIZE = 'false'");
    expect(gateSource).toContain("process.env.MAIN_DATABASE_SYNCHRONIZE = 'false'");
    expect(gateSource).toContain("process.env.DATABASE_MIGRATIONS_RUN = 'true'");
    expect(gateSource).toContain("process.env.MAIN_DATABASE_MIGRATIONS_RUN = 'true'");
    expect(gateSource).not.toContain("SYNCHRONIZE = 'true'");

    expect(disposableSource).toContain("process.env.DATABASE_SYNCHRONIZE = 'true'");
    expect(disposableSource).toContain("process.env.MAIN_DATABASE_SYNCHRONIZE = 'true'");
    expect(disposableSource).toContain("process.env.DATABASE_MIGRATIONS_RUN = 'false'");
    expect(disposableSource).toContain("process.env.MAIN_DATABASE_MIGRATIONS_RUN = 'false'");
  });

  it('confines bootstrap API key files to temporary export directories and cleans failed boot gates', () => {
    const gateSource = source.match(/async function validateRealBoot\(\): Promise<void> \{([\s\S]*?)\n\}/)?.[1];

    expect(source).toContain("process.env.BOOTSTRAP_KEY_FILE = join(exportDataDir, '.api-key')");
    expect(gateSource).toContain("process.env.BOOTSTRAP_KEY_FILE = join(bootDataDir, '.api-key')");
    expect(gateSource).toContain('let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined');
    expect(gateSource).toContain('await app?.close()');
    expect(gateSource).toContain('rmSync(bootDataDir, { recursive: true, force: true })');

    const createIndex = gateSource?.indexOf('app = await NestFactory.create') ?? -1;
    const finallyIndex = gateSource?.indexOf('finally') ?? -1;
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(finallyIndex).toBeGreaterThan(createIndex);
  });

  it.each(REQUIRED_PINS)('pins %s before AppModule is required', name => {
    const pinIndex = source.indexOf(`process.env.${name} =`);
    const requireIndex = source.indexOf("require('../src/app.module')");

    expect(pinIndex).toBeGreaterThanOrEqual(0);
    expect(requireIndex).toBeGreaterThanOrEqual(0);
    expect(pinIndex).toBeLessThan(requireIndex);
  });
});

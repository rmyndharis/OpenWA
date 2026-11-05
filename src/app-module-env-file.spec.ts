import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Every production entry point merges `.env` itself, through src/config/load-env.ts, before AppModule is
// evaluated. AppModule is also booted directly, by the e2e suites, which set their own environment in
// test/setup-e2e.ts. Evaluating AppModule must not read the working directory's `.env` behind that
// environment's back: a developer's file would otherwise decide how those suites boot.
describe('AppModule evaluation', () => {
  const probe = 'OPENWA_ENV_FILE_PROBE';
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'openwa-env-file-'));
    writeFileSync(join(dir, '.env'), `${probe}=from-the-working-directory\n`);
    delete process.env[probe];
  });

  afterEach(() => {
    process.chdir(cwd);
    delete process.env[probe];
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the working directory .env to the env loader', () => {
    process.chdir(dir);
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./app.module');
    });
    expect(process.env[probe]).toBeUndefined();
  });
});

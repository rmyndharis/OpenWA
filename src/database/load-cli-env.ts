import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { clearBlankEnv, BLANK_SHADOWED_ENV_KEYS } from '../config/env-precedence';

/**
 * Load environment for the standalone TypeORM CLI data-sources with the SAME precedence as
 * src/main.ts: `process.env` > `.env` > `data/.env.generated` (all dotenv `override: false`), with
 * blank compose-forwarded keys cleared first. Without this, the migration CLI ignored the
 * dashboard-written `data/.env.generated` and ran against the default SQLite DB even when the
 * deployment was configured (via the dashboard) for PostgreSQL — i.e. `migration:run:prod` targeted
 * the wrong database. `cwd` is injectable for testing.
 */
export function loadCliEnv(cwd: string = process.cwd()): void {
  clearBlankEnv(process.env, BLANK_SHADOWED_ENV_KEYS);
  const userEnvPath = path.resolve(cwd, '.env');
  const generatedEnvPath = path.resolve(cwd, 'data', '.env.generated');
  for (const file of [userEnvPath, generatedEnvPath]) {
    if (!fs.existsSync(file)) continue;
    const { error } = config({ path: file, override: false, quiet: true });
    // The app refuses to boot on a file it cannot read (src/config/load-env.ts), and the CLI must not go on without
    // it: skipped, a migration would run against the default SQLite database while the deployment is configured for
    // another one.
    if (error) throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

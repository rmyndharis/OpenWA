import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

/**
 * `data/.env.generated` — the dashboard-written env overlay, one KEY=value per line, merged into
 * `process.env` on the next boot (after `process.env` and `.env`, all `override: false`).
 *
 * Resolved per call rather than captured at import: the location is relative to `process.cwd()`, and
 * the controller has always re-derived it on each use.
 *
 * NOT shared with `database/load-cli-env.ts`, which resolves the same filename against an injected
 * `cwd` so it stays testable without chdir. Folding that into this helper would remove its seam.
 */
export const generatedEnvPath = (): string => path.resolve(process.cwd(), 'data', '.env.generated');

/**
 * Parsed contents, or `{}` when the file has never been written.
 *
 * Three reads share this — the built-in-flag fallback behind the Docker probe
 * (InfraStatusController.readSavedBuiltinFlags), the config form's hydrate
 * (InfraConfigController.getConfig), and the merge base the save path writes back over
 * (InfraConfigController.saveConfig). Re-deriving the location at each of them made the file an
 * undeclared dependency shared between reading infrastructure status, rendering the form, and
 * persisting credentials: three concerns that otherwise touch none of the same state.
 */
export function readGeneratedEnv(): Record<string, string> {
  const envPath = generatedEnvPath();
  return fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
}

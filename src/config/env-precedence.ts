/**
 * Treat a blank (empty or whitespace-only) value for each given key as if the variable were unset,
 * by deleting it from `env`.
 *
 * Why: the bundled compose files forward an operator's engine choice with `- ENGINE_TYPE=${ENGINE_TYPE:-}`
 * so a real `.env`/host value reaches the container. When the operator sets nothing, that line renders
 * an *empty* value, which would still sit in `process.env` and block the lower-priority `.env` /
 * `data/.env.generated` layers (loaded with dotenv `override: false`) from supplying one — silently
 * pinning the default and ignoring the dashboard's selection. Clearing the blank lets the lower layers
 * provide the value, while a real (non-empty) value is preserved and keeps its top precedence.
 */
/**
 * Keys the bundled compose forwards with `- KEY=${KEY:-}`, which renders blank when the operator
 * sets nothing. A blank forward shadows `.env` / `data/.env.generated` (both loaded with dotenv
 * `override: false`), so each is cleared when blank — letting a dashboard switch (database, storage,
 * redis, engine) or a hand-edited `data/.env.generated` actually apply at runtime while a real host
 * value still pins.
 *
 * EVERY `${KEY:-}` forward in docker-compose.yml belongs here — being dashboard-managed is not a
 * further condition, because `data/.env.generated` is documented as hand-editable (see load-env.ts)
 * and `saveConfig` preserves keys it does not own. `env-precedence.spec.ts` derives the expected set
 * from the compose file and fails when the two drift.
 */
export const BLANK_SHADOWED_ENV_KEYS: string[] = [
  'ENGINE_TYPE',
  // Database selection + connection details (#488)
  'DATABASE_TYPE',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_USERNAME',
  'DATABASE_NAME',
  'DATABASE_PASSWORD',
  // PostgreSQL schema (dashboard-managed + compose blank-forwarded, like the other DATABASE_* keys)
  'POSTGRES_SCHEMA',
  // Storage selection + S3 details (#488)
  'STORAGE_TYPE',
  'STORAGE_LOCAL_PATH',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  // Legacy S3 credential names — compose forwards them blank for backward compat, so clear a blank
  // forward too (otherwise it could shadow a value in data/.env.generated).
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  // Redis selection + connection details (#488)
  'REDIS_ENABLED',
  'REDIS_HOST',
  'REDIS_PORT',
  // Engine launch options the dashboard saves (data/.env.generated). Compose blank-forwards these so a
  // dashboard edit is not shadowed by a pinned container default; the app layer (configuration.ts)
  // supplies the sane default when nothing is set.
  'PUPPETEER_HEADLESS',
  'SESSION_DATA_PATH',
  'PUPPETEER_ARGS',
  // Rate-limit values are blank-forwarded by Compose so a host value can take precedence without an
  // empty forward masking the lower-priority loaded .env / data/.env.generated value.
  'RATE_LIMIT_SHORT_TTL',
  'RATE_LIMIT_SHORT_LIMIT',
  'RATE_LIMIT_MEDIUM_TTL',
  'RATE_LIMIT_MEDIUM_LIMIT',
  'RATE_LIMIT_LONG_TTL',
  'RATE_LIMIT_LONG_LIMIT',
  // Boot-time flags and limits an operator sets in .env / data/.env.generated. AUTO_START_SESSIONS
  // gained its compose forward in v0.12.0 without a clear entry here, so the blank forward shadowed
  // the file and auto-start silently stayed off — sessions sat at `disconnected` with no engine and
  // no error to go on (#981).
  'AUTO_START_SESSIONS',
  'BODY_SIZE_LIMIT',
  'API_MASTER_KEY',
  'TRUSTED_PROXIES',
  'CSP_UPGRADE_INSECURE_REQUESTS',
  // whatsapp-web.js launch knobs: the WhatsApp Web version pin, its remote HTML template, and the
  // first-boot init wait raised for slow hosts.
  'WWEBJS_WEB_VERSION',
  'WWEBJS_WEB_VERSION_REMOTE_PATH',
  'WWEBJS_AUTH_TIMEOUT_MS',
];

export function clearBlankEnv(env: NodeJS.ProcessEnv, keys: string[]): void {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() === '') {
      delete env[key];
    }
  }
}

/**
 * Keys that were already in `process.env` before load-env merged `.env` and `data/.env.generated`
 * into it — i.e. genuinely supplied by the host/orchestrator.
 *
 * Needed because after boot the two file layers are indistinguishable from a real host override:
 * both simply sit in `process.env`. Any check that asks "what will the next boot see for this key?"
 * must not read a file value back out of `process.env` and mistake it for an override — for the
 * save-config guard that would mean validating the config being REPLACED instead of the one being
 * written.
 */
let osEnvKeys: Set<string> | null = null;

/** Snapshot the host-supplied keys. Called by load-env after blank-clearing, before any dotenv load. */
export function recordOsEnvKeys(env: NodeJS.ProcessEnv = process.env): void {
  osEnvKeys = new Set(Object.keys(env));
}

/**
 * True when `key` came from the host rather than a loaded env file. With no snapshot taken (a unit
 * test that never boots), every key counts as host-supplied — the caller's own `process.env` is then
 * the only source there is.
 */
export function isOsProvidedEnv(key: string): boolean {
  return osEnvKeys === null || osEnvKeys.has(key);
}

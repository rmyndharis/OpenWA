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
 * Keys the bundled compose forwards with `- KEY=${KEY:-}` (rendering blank when unset) AND the
 * dashboard saves to `data/.env.generated`. A blank forward of one of these would shadow the
 * dashboard's value, so each is cleared when blank — letting a dashboard switch (database, storage,
 * redis, engine) actually apply at runtime while a real host value still pins. Only add a key that
 * meets BOTH conditions (blank-forwarded by compose AND dashboard-managed); keep this list in sync
 * with the `${KEY:-}` forwards in docker-compose.yml.
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
];

export function clearBlankEnv(env: NodeJS.ProcessEnv, keys: string[]): void {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() === '') {
      delete env[key];
    }
  }
}

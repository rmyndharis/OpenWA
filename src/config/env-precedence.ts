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
 * dashboard's value, so each is cleared when blank. Only add a key that meets BOTH conditions —
 * `REDIS_PASSWORD`/`S3_*` are dashboard-managed but not blank-forwarded by compose, so they don't belong.
 */
export const BLANK_SHADOWED_ENV_KEYS: string[] = ['ENGINE_TYPE', 'DATABASE_PASSWORD'];

export function clearBlankEnv(env: NodeJS.ProcessEnv, keys: string[]): void {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() === '') {
      delete env[key];
    }
  }
}

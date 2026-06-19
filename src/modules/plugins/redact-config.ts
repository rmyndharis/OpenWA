import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';

/** Mask shown for a stored secret on read. Treated as "unchanged" on write. */
export const SECRET_SENTINEL = '***';

function secretKeys(schema?: PluginConfigSchema): string[] {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties)
    .filter(([, prop]) => prop?.secret)
    .map(([key]) => key);
}

const isMeaningful = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * Replace secret-flagged, non-empty config values with {@link SECRET_SENTINEL} so a read (GET
 * /plugins) never leaks them. An empty/absent secret is left as-is so the mask never implies a
 * secret that isn't set. Returns a copy; non-secret fields and shape are untouched (bare payload).
 */
export function redactSecretConfig(
  config: Record<string, unknown> | undefined,
  schema?: PluginConfigSchema,
): Record<string, unknown> {
  const out = { ...(config ?? {}) };
  for (const key of secretKeys(schema)) {
    if (isMeaningful(out[key])) out[key] = SECRET_SENTINEL;
  }
  return out;
}

/**
 * On write (PUT /plugins/:id/config), the dashboard sends the whole config back — including the
 * masked secret. Treat a sentinel/empty secret as "keep existing": restore the stored value, or
 * drop the key when there's nothing stored, so the real secret is never overwritten by the mask.
 * A genuinely-new secret value is stored as provided.
 */
export function restoreSecretConfig(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  schema?: PluginConfigSchema,
): Record<string, unknown> {
  const out = { ...incoming };
  for (const key of secretKeys(schema)) {
    const v = out[key];
    if (v === SECRET_SENTINEL || !isMeaningful(v)) {
      if (existing && isMeaningful(existing[key])) {
        out[key] = existing[key];
      } else {
        delete out[key];
      }
    }
  }
  return out;
}

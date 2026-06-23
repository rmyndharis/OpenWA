import type { PluginConfigField, PluginConfigSchema } from '../../core/plugins/plugin.interfaces';

/** Mask shown for a stored secret on read. Treated as "unchanged" on write. */
export const SECRET_SENTINEL = '***';

const isMeaningful = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Redact one value against its field. Recurses into nested objects and into each row of an
 * array-of-rows so a `secret`-flagged field at any depth is masked. An empty/absent secret is left
 * as-is so the mask never implies a secret that isn't set.
 */
function redactValue(value: unknown, field: PluginConfigField): unknown {
  if (field.type === 'object' && field.properties && isPlainObject(value)) {
    return redactObject(value, field.properties);
  }
  if (field.type === 'array' && field.items && Array.isArray(value)) {
    return value.map(item => redactValue(item, field.items as PluginConfigField));
  }
  if (field.secret && isMeaningful(value)) return SECRET_SENTINEL;
  return value;
}

function redactObject(
  config: Record<string, unknown>,
  properties: Record<string, PluginConfigField>,
): Record<string, unknown> {
  const out = { ...config };
  for (const [key, field] of Object.entries(properties)) {
    if (key in out) out[key] = redactValue(out[key], field);
  }
  return out;
}

/**
 * Replace secret-flagged, non-empty config values with {@link SECRET_SENTINEL} so a read (GET
 * /plugins) never leaks them — at any depth. Returns a copy; non-secret fields, unknown keys, and
 * shape are untouched (bare payload).
 */
export function redactSecretConfig(
  config: Record<string, unknown> | undefined,
  schema?: PluginConfigSchema,
): Record<string, unknown> {
  const out = { ...(config ?? {}) };
  if (!schema?.properties) return out;
  return redactObject(out, schema.properties);
}

/** Restore one value against its field. `keep:false` means drop the key (sentinel with nothing stored). */
function restoreValue(
  incoming: unknown,
  existing: unknown,
  field: PluginConfigField,
): { keep: boolean; value?: unknown } {
  if (field.type === 'object' && field.properties && isPlainObject(incoming)) {
    return {
      keep: true,
      value: restoreObject(incoming, isPlainObject(existing) ? existing : undefined, field.properties),
    };
  }
  if (field.type === 'array' && field.items && Array.isArray(incoming)) {
    // ponytail: rows matched to the stored secret by position — fine for the dashboard's full-array
    // round-trip (order preserved); switch to an id-keyed match if rows become reorderable.
    const existingArr = Array.isArray(existing) ? existing : [];
    return {
      keep: true,
      value: incoming.map((item, i) => restoreValue(item, existingArr[i], field.items as PluginConfigField).value),
    };
  }
  if (field.secret && (incoming === SECRET_SENTINEL || !isMeaningful(incoming))) {
    if (isMeaningful(existing)) return { keep: true, value: existing };
    return { keep: false };
  }
  return { keep: true, value: incoming };
}

function restoreObject(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  properties: Record<string, PluginConfigField>,
): Record<string, unknown> {
  const out = { ...incoming };
  for (const [key, field] of Object.entries(properties)) {
    if (!(key in out)) continue;
    const r = restoreValue(out[key], existing?.[key], field);
    if (r.keep) out[key] = r.value;
    else delete out[key];
  }
  return out;
}

/**
 * On write (PUT /plugins/:id/config), the dashboard sends the whole config back — including masked
 * secrets at any depth. Treat a sentinel/empty secret as "keep existing": restore the stored value,
 * or drop the key when there's nothing stored. A genuinely-new value is stored as provided.
 */
export function restoreSecretConfig(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  schema?: PluginConfigSchema,
): Record<string, unknown> {
  if (!schema?.properties) return { ...incoming };
  return restoreObject(incoming, existing, schema.properties);
}

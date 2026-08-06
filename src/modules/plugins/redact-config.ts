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
  // Mask a `secret` field BEFORE descending into its structure: a whole object/array marked secret
  // (e.g. a credentials object or a list of keys) must be masked as one unit, not recursed into —
  // otherwise its non-secret children leak verbatim. Scalar secrets are masked here too.
  if (field.secret && isMeaningful(value)) return SECRET_SENTINEL;
  if (field.type === 'object' && field.properties && isPlainObject(value)) {
    return redactObject(value, field.properties);
  }
  if (field.type === 'array' && field.items && Array.isArray(value)) {
    return value.map(item => redactValue(item, field.items as PluginConfigField));
  }
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
  // Fail CLOSED when the schema is unavailable (plugin unloaded / failed to load): we can't tell which
  // fields are secret, so mask every meaningful value rather than leak a credential. Returning the
  // config unchanged here would expose runtime-stored secrets on GET /plugins.
  if (!schema?.properties) {
    for (const key of Object.keys(out)) {
      if (isMeaningful(out[key])) out[key] = SECRET_SENTINEL;
    }
    return out;
  }
  return redactObject(out, schema.properties);
}

/** Deterministic JSON (object keys sorted) so two equal shapes compare equal regardless of key order. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isPlainObject(v)) {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map(k => JSON.stringify(k) + ':' + stableStringify(v[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * An array element's identity for matching on restore: the element with its secrets masked, so a
 * stored row (real secret) and the dashboard's round-tripped row (sentinel secret) share a signature
 * iff their NON-secret content is equal. Scalar-secret elements collapse to the same signature and so
 * are deliberately ambiguous (never auto-restored to the wrong one).
 */
function elementSignature(value: unknown, field: PluginConfigField): string {
  return stableStringify(redactValue(value, field));
}

/** Restore one value against its field. `keep:false` means drop the key (sentinel with nothing stored). */
function restoreValue(
  incoming: unknown,
  existing: unknown,
  field: PluginConfigField,
): { keep: boolean; value?: unknown } {
  // Mirror redactValue: a `secret` field is handled as ONE unit before any structural recursion. A
  // sentinel/empty incoming keeps the stored value (or drops it); a genuinely-new value is stored
  // as-is. Without this, a composite secret (object/array) would recurse and its masked children
  // would clobber the stored secret instead of restoring it.
  if (field.secret) {
    if (incoming === SECRET_SENTINEL || !isMeaningful(incoming)) {
      return isMeaningful(existing) ? { keep: true, value: existing } : { keep: false };
    }
    return { keep: true, value: incoming };
  }
  if (field.type === 'object' && field.properties && isPlainObject(incoming)) {
    return {
      keep: true,
      value: restoreObject(incoming, isPlainObject(existing) ? existing : undefined, field.properties),
    };
  }
  if (field.type === 'array' && field.items && Array.isArray(incoming)) {
    const itemField = field.items;
    const existingArr: unknown[] = Array.isArray(existing) ? existing : [];
    // Match each incoming element to its stored counterpart by NON-SECRET content (a row's signature
    // is the row with its secrets masked), not by array index. Adding / removing / reordering rows
    // then can't bind a sentinel to a different row's secret. Only an unambiguous match (exactly one
    // stored element with that signature) restores; otherwise the sentinel is treated as "nothing
    // stored" (dropped), so a secret may be lost on an ambiguous edit but is never mis-targeted.
    const sigCount = new Map<string, number>();
    const sigFirst = new Map<string, unknown>();
    for (const ex of existingArr) {
      const s = elementSignature(ex, itemField);
      sigCount.set(s, (sigCount.get(s) ?? 0) + 1);
      if (!sigFirst.has(s)) sigFirst.set(s, ex);
    }
    const sameLength = incoming.length === existingArr.length;
    return {
      keep: true,
      value: incoming
        .map((item, i) => {
          const s = elementSignature(item, itemField);
          // Resolution order: (1) an unambiguous content match keeps a row's secret across
          // reorder/insert/removal; (2) on an unchanged length, fall back to the positional twin (an
          // in-place edit — position i is the same logical row, incl. a non-secret-field rename); (3) on a
          // length change, bind the positional twin ONLY when its masked signature still equals this
          // element's, so an append/removal keeps each surviving sentinel's stored secret while a
          // genuinely-new or signature-changed row at that position is never grafted with a stored secret.
          const twin = existingArr[i];
          const match =
            sigCount.get(s) === 1
              ? sigFirst.get(s)
              : sameLength
                ? twin
                : twin !== undefined && elementSignature(twin, itemField) === s
                  ? twin
                  : undefined;
          return restoreValue(item, match, itemField);
        })
        // Honor keep:false like restoreObject does (drop the element) rather than emitting `.value`
        // (undefined), which would serialize to a null hole in the persisted array.
        .filter(r => r.keep)
        .map(r => r.value),
    };
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
  // Symmetric fail-closed restore for the schemaless case: redactSecretConfig masks EVERY value to the
  // sentinel, so on write treat any sentinel value as "keep existing" (restore the stored value, or drop
  // the key when nothing is stored). Returning `incoming` as-is would persist the sentinel and corrupt
  // the stored config. Non-sentinel values (genuinely edited) are kept verbatim.
  if (!schema?.properties) {
    const out = { ...incoming };
    const ex = existing ?? {};
    for (const key of Object.keys(out)) {
      if (out[key] !== SECRET_SENTINEL) continue;
      if (isMeaningful(ex[key])) out[key] = ex[key];
      else delete out[key];
    }
    return out;
  }
  return restoreObject(incoming, existing, schema.properties);
}

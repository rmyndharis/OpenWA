import type { PluginConfigField } from '../services/api';

/** A blank value for a field, used to seed a form and to add a new array row. */
export function emptyForField(field: PluginConfigField): unknown {
  if (field.default !== undefined) return field.default;
  // A <select> always shows its first option, so seed enum state to it — otherwise the form shows a
  // value the user never picked and would save '' instead.
  if (field.enum && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const obj: Record<string, unknown> = {};
      if (field.properties) for (const [k, sub] of Object.entries(field.properties)) obj[k] = emptyForField(sub);
      return obj;
    }
    case 'number':
      // Seed (and leave) a blank number as undefined, never '' — persisting an empty string for a
      // type:'number' field hands the plugin a string where it expects a number.
      return undefined;
    default: // string | textarea
      return '';
  }
}

/** Coerce a text-input value to the field's type. A cleared number becomes undefined (so the key is
 *  omitted) rather than '' — the inverse of {@link emptyForField} for number fields. A cleared secret
 *  does too: the gateway keeps a stored secret for an empty string, so the save sends null for it
 *  ({@link fillClearedFields}), the one value that removes it. */
export function coerceFieldInput(field: PluginConfigField, raw: string): unknown {
  if (field.type === 'number') return raw === '' ? undefined : Number(raw);
  if (field.secret && raw === '') return undefined;
  return raw;
}

/**
 * Fill each cleared top-level field for the save. The gateway merges the PUT body over the stored
 * config and JSON drops an undefined key, so an omitted field keeps its old value: send the field's
 * default instead, or null when it has none and a value is stored. A field that was never stored
 * stays omitted.
 */
export function fillClearedFields(
  values: Record<string, unknown>,
  stored: Record<string, unknown>,
  properties: Record<string, PluginConfigField>,
): Record<string, unknown> {
  const out = { ...values };
  for (const [key, field] of Object.entries(properties)) {
    if (out[key] !== undefined) continue;
    if (field.default !== undefined) out[key] = field.default;
    else if (stored[key] != null) out[key] = null;
  }
  return out;
}

import type { PluginConfigSchema } from './plugin.interfaces';

/**
 * Fill config keys the schema declares a `default` for and that are absent (undefined) in the
 * stored config. Seeding happens at LOAD time (fresh installs and every boot), so a plugin whose
 * schema fields carry defaults never runs its lifecycle with them missing — the failure class of
 * "enable throws: <field> is required/has no value" for defaulted fields. Explicit values — even
 * null — are never overwritten, and object/array defaults are deep-cloned so the seeded runtime
 * config and the persisted entry can't share a mutable reference. Required fields WITHOUT a
 * declared default stay absent on purpose: those need real operator input, not an invented value.
 */
export function seedConfigDefaults(
  schema: PluginConfigSchema | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema?.properties;
  if (!properties) return config;
  let seeded: Record<string, unknown> | undefined;
  for (const [key, field] of Object.entries(properties)) {
    if (config[key] !== undefined || field === null || typeof field !== 'object') continue;
    const value = field.default;
    if (value === undefined) continue;
    if (!seeded) seeded = { ...config };
    seeded[key] = value !== null && typeof value === 'object' ? structuredClone(value) : value;
  }
  return seeded ?? config;
}

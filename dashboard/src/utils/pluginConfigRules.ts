import { emptyForField } from './pluginConfigForm.ts';
import type { Plugin } from '../services/api';

/**
 * Config rules for the Plugins page, all three of which decide what leaves the browser.
 *
 * `configUiSafeConfig` is the one that matters most: it is the only thing standing between a plugin's
 * sandboxed config-UI iframe and the rest of the plugin's stored configuration. It ran inside a
 * `postMessage` handler, reachable only through an iframe, which is the least testable place in the
 * dashboard for the most security-relevant rule in it.
 */

/**
 * Everything the sandboxed config UI is allowed to see: SCHEMA-DECLARED keys only.
 *
 * A plugin's stored config can hold keys its schema never declared — left by an older version, or
 * written by the host. Sending the raw config would hand all of that to an iframe the plugin itself
 * controls. Filtering by the declared properties means a plugin can only ever read back what it asked
 * for; with no schema there is nothing safe to send at all.
 *
 * With `sessionId`, the resolved slice is exposed: the session's override where set, else the base.
 */
export function configUiSafeConfig(plugin: Plugin, sessionId?: string): Record<string, unknown> {
  const props = plugin.configSchema?.properties;
  if (!props) return {};
  const override = sessionId ? (plugin.sessionConfig?.[sessionId] ?? {}) : {};
  return Object.fromEntries(
    Object.keys(props).flatMap(k => {
      if (sessionId && k in override) return [[k, override[k]]];
      return k in plugin.config ? [[k, plugin.config[k]]] : [];
    }),
  );
}

/**
 * Build a sparse per-session config override from a full edited config: include only non-secret keys
 * whose value differs from the Global base (so untouched keys keep inheriting Global), plus every
 * TOP-LEVEL secret key (the backend restores an untouched `***` to the stored per-session value, or
 * drops it → the host's deep-merge then re-inherits it from Global). A key absent from the base whose
 * value is just the empty default is skipped, so an untouched optional field never creates a spurious
 * override. With no schema, the input is returned as-is.
 *
 * Inheritance of untouched secrets holds for top-level secret keys and secrets nested in an OBJECT
 * (deep-merged). It does NOT hold for a `secret` column inside an array-of-rows: arrays are replaced
 * wholesale at resolve time, so a first-time per-session override that edits any cell of such an array
 * loses the untouched rows' secrets (they redact to `***`, the dashboard can't resend the real value).
 * No bundled plugin ships that shape; a plugin needing per-session array secrets should re-enter them.
 */
export function sparseSessionOverride(full: Record<string, unknown>, plugin: Plugin): Record<string, unknown> {
  const props = plugin.configSchema?.properties;
  if (!props) return full;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(props)) {
    if (!(key in full)) continue;
    const val = full[key];
    if (field.secret) {
      out[key] = val;
      continue;
    }
    if (JSON.stringify(val) === JSON.stringify(plugin.config[key])) continue; // unchanged → inherit Global
    if (plugin.config[key] === undefined && JSON.stringify(val) === JSON.stringify(emptyForField(field))) {
      continue; // untouched optional field with no Global value → don't pin a spurious empty override
    }
    out[key] = val;
  }
  return out;
}

/** Required schema keys the plugin has no usable value for — enabling without these fails at load. */
export function missingRequiredConfig(plugin: Plugin): string[] {
  const props = plugin.configSchema?.properties ?? {};
  return Object.entries(props)
    .filter(
      ([key, field]) =>
        field.required === true &&
        (plugin.config[key] === undefined || plugin.config[key] === null || plugin.config[key] === ''),
    )
    .map(([key]) => key);
}

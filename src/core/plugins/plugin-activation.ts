import type { PluginConfigField, PluginManifest } from './plugin.interfaces';

/**
 * The all-sessions scope is spelled null, undefined or '*' depending on where it was stored; this maps
 * every spelling to '*' and leaves a concrete session id as it is, so two scopes compare by key.
 */
export const sessionScopeKey = (scope: string | null | undefined): string => (!scope || scope === '*' ? '*' : scope);

/** Whether `scope` is the all-sessions scope, in any of its spellings. */
export const isAllSessionsScope = (scope: string | null | undefined): boolean => sessionScopeKey(scope) === '*';

/**
 * Per-session activation gate. A plugin declares whether it is session-scoped (the default); the
 * operator then activates it for all sessions (`['*']`) or an explicit set. A global plugin
 * (`sessionScoped === false`, e.g. a metrics logger) ignores this and is always active.
 *
 * A non-session-attributed event (no `sessionId`) is never gated — the plugin chose to register that
 * hook, and there is no number to scope it to.
 */
export function isPluginActiveForSession(
  sessionScoped: boolean,
  activeSessions: string[],
  sessionId: string | undefined,
): boolean {
  if (!sessionScoped) return true;
  if (sessionId === undefined) return true;
  if (activeSessions.includes('*')) return true;
  return activeSessions.includes(sessionId);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Recursively merge `override` over `base`: nested plain objects merge key-by-key so an override that
 * sets only some keys inherits the rest from the base (incl. nested secrets); arrays and scalars are
 * replaced wholesale. Returns fresh objects; never mutates the inputs.
 */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = out[key];
    out[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
  }
  return out;
}

/**
 * What a layered config merge needs of a manifest: the config keys that name a host the plugin may
 * call (`net.allowConfigHosts`) and the schema that says which fields are secret.
 */
export type ConfigLayerManifest = Pick<PluginManifest, 'net' | 'configSchema'>;

/** The origin a host key names, the trimmed text when it is no URL, or null when it names nothing. */
function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const { origin } = new URL(value);
    return origin === 'null' ? value.trim() : origin;
  } catch {
    return value.trim();
  }
}

/**
 * Whether `layer` points a host key at an origin other than the one `beneath` names. A value that is no text
 * (a list, an object, a number) has no origin to compare, yet a plugin may still turn it into a URL
 * (`String(['https://x.example'])` is `https://x.example`), so it counts as a redirect: only an unset, null or
 * blank value names nothing.
 */
const redirectsHost = (beneath: Record<string, unknown>, layer: Record<string, unknown>, hostKeys: string[]): boolean =>
  hostKeys.some(key => {
    const value = layer[key];
    if (typeof value !== 'string') return value !== undefined && value !== null;
    const next = hostOf(value);
    return next !== null && next !== hostOf(beneath[key]);
  });

const holdsSecret = (field: PluginConfigField): boolean =>
  !!field.secret ||
  Object.values(field.properties ?? {}).some(holdsSecret) ||
  (!!field.items && holdsSecret(field.items));

/**
 * `config` without its declared secret fields, at any depth. A list that holds one is dropped whole,
 * because lists are replaced and never merged.
 */
function withoutSecrets(
  config: Record<string, unknown>,
  properties: Record<string, PluginConfigField>,
): Record<string, unknown> {
  const out = { ...config };
  for (const [key, field] of Object.entries(properties)) {
    const value = out[key];
    if (value === undefined) continue;
    if (field.secret || (field.type === 'array' && holdsSecret(field))) delete out[key];
    else if (field.type === 'object' && field.properties && isPlainObject(value)) {
      out[key] = withoutSecrets(value, field.properties);
    }
  }
  return out;
}

/**
 * Merge `layer` over `beneath`. A layer that points a host key at another origin than the layer
 * beneath names must bring its own secrets: the beneath secrets belong to the host they were saved
 * for, and a key allowed to write the layer (a session-restricted admin, an instance) would otherwise
 * receive them with a host of its choosing. With no schema nothing can be told secret, so nothing is
 * inherited.
 */
function mergeLayer(
  beneath: Record<string, unknown>,
  layer: Record<string, unknown>,
  manifest: ConfigLayerManifest,
): Record<string, unknown> {
  const hostKeys = manifest.net?.allowConfigHosts;
  if (!hostKeys?.length || !redirectsHost(beneath, layer, hostKeys)) return deepMerge(beneath, layer);
  const properties = manifest.configSchema?.properties;
  return deepMerge(properties ? withoutSecrets(beneath, properties) : {}, layer);
}

/** Whether `layer` sets any host key to something: a key it leaves unset, null or blank names no host. */
const namesHost = (layer: Record<string, unknown>, hostKeys: string[]): boolean =>
  hostKeys.some(key => {
    const value = layer[key];
    return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null;
  });

/**
 * The stored layer a write may restore a masked or blank secret from. A write that points a host key at
 * another origin than the stored layer is bound to gets none of the stored secrets back, for the reason
 * {@link mergeLayer} gives: they belong to the host they were saved for, and a key allowed to write the layer
 * (a session-restricted admin) would otherwise send them to a host of its choosing by echoing the mask. A
 * masked or blank secret in such a write is then dropped, and the sender has to supply it.
 *
 * A stored layer that names no host key is bound to the host of the layer `beneath` it, which is what it
 * resolves to, so a write that names that same host moves nothing. A write that is no object is returned
 * with the stored layer untouched, as it was before: it clears the layer.
 */
export function restorableConfig(
  stored: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | null | undefined,
  manifest: ConfigLayerManifest,
  beneath: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  const hostKeys = manifest.net?.allowConfigHosts;
  if (!stored || !hostKeys?.length || !isPlainObject(incoming)) return stored;
  // Only a key the stored layer leaves unset is bound to the layer beneath; any value it holds, a list or a
  // blank text included, stays the host it is bound to, which no named host then equals.
  const bound = Object.fromEntries(
    hostKeys.map(key => [key, stored[key] === undefined || stored[key] === null ? beneath[key] : stored[key]]),
  );
  if (!redirectsHost(bound, incoming, hostKeys)) return stored;
  const properties = manifest.configSchema?.properties;
  return properties ? withoutSecrets(stored, properties) : {};
}

/**
 * Layer one integration instance's own config over whatever resolution produced.
 *
 * Provisioning projects each instance's config into the scope-keyed store, so two enabled instances
 * sharing a session scope collapse onto one key and the later write wins. The scope therefore cannot
 * say WHOSE credentials a delivery must run with; only the instance row can. Applied last so it beats
 * both the base config and an operator's per-session override, and deep-merged so a sparse instance
 * config keeps the keys it did not set.
 *
 * This merge alone does NOT isolate two instances: it corrects the keys the row defines, and every
 * key the row leaves unset still resolves from the layer underneath. Whether that layer can be
 * attributed to this instance is the caller's decision — `PluginSandboxBridge` withholds the
 * scope slice once siblings exist, for exactly that reason.
 *
 * A row that names another host than the layer beneath does not inherit that layer's secrets, see
 * {@link mergeLayer}. A row that leaves a host key unset loses its own secrets when `base` is given and the
 * layers beneath it moved that key away from the base; with no schema to tell its secrets it keeps nothing.
 */
export function resolveInstanceConfig(
  resolved: Record<string, unknown>,
  instanceConfig: Record<string, unknown> | null | undefined,
  manifest: ConfigLayerManifest,
  base?: Record<string, unknown>,
): Record<string, unknown> {
  if (!instanceConfig) return resolved;
  const hostKeys = manifest.net?.allowConfigHosts;
  const properties = manifest.configSchema?.properties;
  // A host key the row leaves unset resolves from the layers beneath it, and the secrets the row holds are
  // bound to the base host it was provisioned against. When those layers have moved such a key away from the
  // base (a per-session override written by a session-restricted admin), the secrets would reach the new
  // host, so the row keeps its other keys and loses its secrets. Without a schema nothing can be told secret,
  // and so nothing is kept, as in mergeLayer. A key the row names itself is its own and is not checked.
  const unset = hostKeys?.filter(key => !namesHost(instanceConfig, [key])) ?? [];
  const moved = !!base && unset.length > 0 && redirectsHost(base, resolved, unset);
  const row = moved ? (properties ? withoutSecrets(instanceConfig, properties) : {}) : instanceConfig;
  return mergeLayer(resolved, row, manifest);
}

/**
 * Resolve the config a plugin sees for a given session: the per-session override (if any) deep-merged
 * over the base ('*') config, so an override only changes the keys it specifies (at any depth) and
 * inherits the rest from the base — a sparse override can't drop a base key (e.g. a nested secret) it
 * didn't touch. A global plugin and a non-session-attributed event (no sessionId) get the base
 * unchanged. Returns a fresh object on merge; never mutates the inputs. An override that names
 * another host than the base does not inherit the base secrets, see {@link mergeLayer}.
 */
export function resolvePluginConfig(
  base: Record<string, unknown>,
  sessionConfig: Record<string, Record<string, unknown>> | undefined,
  sessionId: string | undefined,
  sessionScoped: boolean,
  manifest: ConfigLayerManifest,
): Record<string, unknown> {
  if (!sessionScoped || sessionId === undefined || !sessionConfig) return base;
  const override = sessionConfig[sessionId];
  return override ? mergeLayer(base, override, manifest) : base;
}

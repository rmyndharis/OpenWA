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
 * Resolve the config a plugin sees for a given session: the per-session override (if any) deep-merged
 * over the base ('*') config, so an override only changes the keys it specifies (at any depth) and
 * inherits the rest from the base — a sparse override can't drop a base key (e.g. a nested secret) it
 * didn't touch. A global plugin and a non-session-attributed event (no sessionId) get the base
 * unchanged. Returns a fresh object on merge; never mutates the inputs.
 */
export function resolvePluginConfig(
  base: Record<string, unknown>,
  sessionConfig: Record<string, Record<string, unknown>> | undefined,
  sessionId: string | undefined,
  sessionScoped: boolean,
): Record<string, unknown> {
  if (!sessionScoped || sessionId === undefined || !sessionConfig) return base;
  const override = sessionConfig[sessionId];
  return override ? deepMerge(base, override) : base;
}

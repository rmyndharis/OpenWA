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

/**
 * Resolve the config a plugin sees for a given session: the per-session override (if any) shallow-
 * merged over the base ('*') config, so an override wins per top-level key. A global plugin and a
 * non-session-attributed event (no sessionId) always get the base unchanged. Returns a fresh object
 * on merge; never mutates the inputs.
 */
export function resolvePluginConfig(
  base: Record<string, unknown>,
  sessionConfig: Record<string, Record<string, unknown>> | undefined,
  sessionId: string | undefined,
  sessionScoped: boolean,
): Record<string, unknown> {
  if (!sessionScoped || sessionId === undefined || !sessionConfig) return base;
  const override = sessionConfig[sessionId];
  return override ? { ...base, ...override } : base;
}

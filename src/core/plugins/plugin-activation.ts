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

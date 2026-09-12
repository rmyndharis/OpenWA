/**
 * Operator, companion operator, and viewer (reader) API keys may be limited to an
 * explicit session allowlist. An empty or missing list means the key can reach
 * every session, including ones created later. Admin keys stay unscoped in the
 * dashboard UI.
 */
export function canScopeSessions(role: string): boolean {
  return role === 'operator' || role === 'companion_operator' || role === 'viewer';
}

/** The picker starts open only when the key already has an explicit allowlist. */
export function sessionPickerStartsExpanded(selectedIds: readonly string[]): boolean {
  return selectedIds.length > 0;
}

/**
 * Membership comparison, so an unchanged Save is not sent at all. `PUT /auth/api-keys/:id` writes
 * `allowedSessions` whenever the field is present, and an empty array is not the same stored value
 * as "never scoped": the server reads the write back as an authorization change and disconnects
 * every live `/events` socket holding that key.
 */
export function sameSessionScope(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, index) => id === right[index]);
}

/**
 * The picker's rows: every live session, then any selected id that no longer resolves to one.
 *
 * Nothing prunes a key's allowlist when its session is deleted, so an orphaned id is a steady state,
 * not an edge case. Listing only live sessions would leave it invisible and therefore impossible to
 * untick, and it would be re-persisted on every save.
 */
export function sessionScopeRows<T extends { id: string }>(
  sessions: readonly T[],
  selectedIds: readonly string[],
): Array<{ id: string; session?: T }> {
  const live = new Set(sessions.map(session => session.id));
  const orphans = [...new Set(selectedIds)].filter(id => !live.has(id));
  return [...sessions.map(session => ({ id: session.id, session })), ...orphans.map(id => ({ id }))];
}

export function sessionScopeNames(
  allowedSessions: string[] | undefined | null,
  sessions: ReadonlyArray<{ id: string; name: string }>,
): string[] | null {
  if (!allowedSessions || allowedSessions.length === 0) return null;
  const byId = new Map(sessions.map(session => [session.id, session.name]));
  return allowedSessions.map(id => byId.get(id) ?? id);
}

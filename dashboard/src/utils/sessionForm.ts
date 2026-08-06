/**
 * Validation and filtering rules for the Sessions page.
 *
 * Each of these was re-derived inline at two or three places — the create button's disabled state,
 * the format hint under the input, and the duplicate-name warning each rebuilt the same name rule
 * with a different combination of its clauses. Stating a rule once and asking it what is wrong keeps
 * the three from drifting apart, and makes them testable.
 */

/** Everything wrong with a proposed session name. Empty when it is acceptable. */
export type SessionNameIssue = 'empty' | 'format' | 'too-long' | 'duplicate';

/** Names become on-disk directory names, so the format is deliberately narrow. */
const NAME_FORMAT = /^[a-z0-9-]+$/;
const NAME_MAX_LENGTH = 50;

/**
 * Report EVERY issue rather than the first, because the form shows the format and length messages
 * independently — a name can be both malformed and too long, and the user should see both.
 *
 * `duplicate` is reported only once format and length pass: telling someone their unusable name is
 * also taken is noise, and it is how the form already behaved.
 */
export function sessionNameIssues(name: string, existingNames: string[]): SessionNameIssue[] {
  if (!name.trim()) return ['empty'];
  const issues: SessionNameIssue[] = [];
  if (!NAME_FORMAT.test(name)) issues.push('format');
  if (name.length > NAME_MAX_LENGTH) issues.push('too-long');
  if (issues.length === 0 && existingNames.includes(name)) issues.push('duplicate');
  return issues;
}

/** The create button's gate: any issue at all blocks it. */
export function canCreateSession(name: string, existingNames: string[]): boolean {
  return sessionNameIssues(name, existingNames).length === 0;
}

/** Pairing accepts a bare international number: digits only, no `+`, no separators. */
export function isValidPairingPhone(phone: string): boolean {
  return /^[0-9]{6,15}$/.test(phone.trim());
}

/**
 * The status filter's groups do not map one-to-one onto engine statuses — they are the operator's
 * mental model, not the engine's. `connecting` covers the three transient states, and `inactive`
 * covers everything that is neither ready nor moving, INCLUDING `action_required` and `failed`, which
 * both need the operator rather than time.
 */
const STATUS_GROUPS: Record<string, string[]> = {
  active: ['ready'],
  connecting: ['initializing', 'authenticating', 'qr_ready'],
  inactive: ['created', 'disconnected', 'action_required', 'failed'],
};

export function matchesStatusFilter(status: string, filter: string): boolean {
  if (filter === 'all') return true;
  return (STATUS_GROUPS[filter] ?? []).includes(status);
}

export function filterSessions<T extends { id: string; name: string; status: string }>(
  sessions: T[],
  search: string,
  statusFilter: string,
): T[] {
  const needle = search.toLowerCase();
  return sessions.filter(
    s =>
      (s.name.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle)) &&
      matchesStatusFilter(s.status, statusFilter),
  );
}

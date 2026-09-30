/**
 * Operator and viewer (reader) API keys may be limited to an explicit session
 * allowlist. An empty or missing list means the key can reach every session,
 * including ones created later. Admin keys stay unscoped in the dashboard UI.
 */
export function canScopeSessions(role: string): boolean {
  return role === 'operator' || role === 'viewer';
}

/** The picker starts open only when the key already has an explicit allowlist. */
export function sessionPickerStartsExpanded(selectedIds: readonly string[]): boolean {
  return selectedIds.length > 0;
}

/**
 * Membership comparison, so an unchanged Save is not sent at all. Every `PUT /auth/api-keys/:id`
 * writes an audit row, and on an admin key a scope or expiry that is merely re-sent still runs the
 * last-admin check, which can refuse a save that changed nothing. Repeats are ignored: the API can
 * store a list with a repeated entry, while the form's parsed list never has one.
 */
export function sameSessionScope(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every(id => right.has(id));
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

/** A free-text list as the gateway takes it: one entry per line or comma, trimmed, blanks and repeats dropped. */
export function parseScopeList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0),
    ),
  ];
}

/**
 * The chat allow-list in the form the gateway stores it (normalizeChatAllowList): a bare phone number
 * becomes `<digits>@c.us`. The gateway refuses a list with repeats before it normalizes, and compares
 * stored entries in this form, so both the request and the no-op check use it.
 */
export function normalizeChatScope(text: string): string[] {
  return [...new Set(parseScopeList(text).map(entry => (/^\d{5,}$/.test(entry) ? `${entry}@c.us` : entry)))];
}

/** A stored instant as a `datetime-local` value in this browser's time zone, or '' for none. */
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

// The gateway's allowedIps rule (isIpOrCidr): an IPv4 address, optionally with a /0-32 prefix length.
function isIpOrCidr(entry: string): boolean {
  const [ip, bits, extra] = entry.split('/');
  if (extra !== undefined || !IPV4.test(ip)) return false;
  return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
}

// The gateway's allowedChats rule (isChatId) for a trimmed entry: a bare phone number, a group, or a contact.
function isChatId(entry: string): boolean {
  if (/^\d{5,}$/.test(entry)) return true;
  const at = entry.lastIndexOf('@');
  if (at === -1) return false;
  const user = entry.slice(0, at).split(':')[0];
  const domain = entry.slice(at + 1).toLowerCase();
  if (domain === 'g.us') return /^\d+(?:-\d+)?$/.test(user);
  return ['c.us', 's.whatsapp.net', 'lid'].includes(domain) && /^\d{5,}$/.test(user);
}

/**
 * The first entry the gateway would refuse, or null. Checked here because a production gateway
 * answers a bad entry with a bare "Bad Request" that does not say which line is wrong.
 */
export function invalidIpEntry(entries: readonly string[]): string | null {
  return entries.find(entry => !isIpOrCidr(entry)) ?? null;
}

export function invalidChatEntry(entries: readonly string[]): string | null {
  return entries.find(entry => !isChatId(entry)) ?? null;
}

export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() <= now;
}

interface ScopedKey {
  role: string;
  allowedIps?: string[] | null;
  allowedSessions?: string[] | null;
  allowedChats?: string[] | null;
  expiresAt?: string | null;
}

/** The edit form's state for one key: lists as editable text, expiry as a `datetime-local` value. */
export interface ApiKeyDraft {
  role: string;
  sessions: string[];
  ips: string;
  chats: string;
  expires: string;
}

export interface ApiKeyPatch {
  role?: string;
  allowedIps?: string[];
  allowedSessions?: string[];
  allowedChats?: string[];
  expiresAt?: string | null;
}

export function apiKeyDraft(key: ScopedKey): ApiKeyDraft {
  return {
    role: key.role,
    sessions: key.allowedSessions ?? [],
    ips: (key.allowedIps ?? []).join('\n'),
    chats: (key.allowedChats ?? []).join('\n'),
    expires: toDateTimeLocal(key.expiresAt),
  };
}

/**
 * Only the fields that changed, for the reasons on sameSessionScope: a re-sent field writes an audit
 * row saying the access moved, and on an admin key can trip the last-admin check. Session and chat
 * scope are edited only on operator and viewer keys; an admin key keeps whatever the API gave it,
 * unless it is being promoted, which clears both so the new admin can manage keys.
 */
export function apiKeyPatch(key: ScopedKey, draft: ApiKeyDraft): ApiKeyPatch {
  const patch: ApiKeyPatch = {};
  const scoped = canScopeSessions(draft.role);
  if (draft.role !== key.role) patch.role = draft.role;
  if (scoped || draft.role !== key.role) {
    const sessions = scoped ? draft.sessions : [];
    const chats = scoped ? normalizeChatScope(draft.chats) : [];
    if (!sameSessionScope(sessions, key.allowedSessions ?? [])) patch.allowedSessions = sessions;
    if (!sameSessionScope(chats, key.allowedChats ?? [])) patch.allowedChats = chats;
  }
  const ips = parseScopeList(draft.ips);
  if (!sameSessionScope(ips, key.allowedIps ?? [])) patch.allowedIps = ips;
  // Compared as the form shows it, so an untouched expiry is not re-sent rounded to the minute.
  if (draft.expires !== toDateTimeLocal(key.expiresAt)) {
    patch.expiresAt = draft.expires ? new Date(draft.expires).toISOString() : null;
  }
  return patch;
}

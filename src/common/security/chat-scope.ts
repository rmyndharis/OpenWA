/**
 * Resolve the effective chat filter for a scoped read or send, mirroring `session-scope.ts`.
 *
 * An API key's `allowedChats` is a curated allowlist of chat ids — groups, and/or individual
 * contacts — independent of `allowedSessions`. A key with no allowlist (NULL/empty) is unrestricted;
 * with one, it may reach only the chats inside the fence.
 *
 * Matching is expansion, not string comparison, and it is deliberately asymmetric so the cost lands
 * on the small side:
 *
 * - the allowlist is compiled to its LITERAL address forms (both user dialects for a phone, the
 *   `@lid` form for a lid, the `@g.us` form for a group) — no lookups;
 * - a SINGLE requested chat id is expanded once, through the lid table, into every JID that refers
 *   to the same entity, and tested against those literals. That is at most two lookups per request
 *   (the guard's path), not one per allowlist entry;
 * - a LIST filter is the other way round: the allowlist is expanded once with the table (batched),
 *   and each row is then a pure literal membership test.
 *
 * Keeping phones and lids apart is what stops `555000111@lid` admitting `555000111@c.us`: a lid's
 * digits are not a phone number, so the two only cross where the table maps them.
 */
import { parseWaId } from '../../engine/identity/wa-id';
import { ContactDirectory, resolveJidCandidates } from '../../engine/identity/jid-candidates';

/** A compiled allowlist: the exact JIDs a key may reach (an entry expands to its dialects). */
export interface ChatScope {
  allowed: Set<string>;
}

/** Batched lid<->phone lookups, used to expand the ALLOWLIST once for a list filter. */
export interface ChatScopeDirectory {
  /** lid user-part -> phone digits, for the lids that are mapped. */
  phonesForLids(lids: string[]): Promise<Record<string, string | null>>;
  /** phone digits -> the lid user-parts mapped to it. */
  lidsForPhones(phones: string[]): Promise<Record<string, string[]>>;
}

/** A bare phone number (MSISDN digits) — accepted as a convenience in place of `<phone>@c.us`. */
const BARE_NUMBER = /^\d{5,}$/;

/** True when the key carries a non-empty allowlist, i.e. is actually fenced. */
export function isChatScopeRestricted(allowedChats: string[] | null | undefined): boolean {
  return (allowedChats?.length ?? 0) > 0;
}

/**
 * Canonicalize an `allowedChats` list for storage: trim, drop empties, and qualify a bare phone
 * number to `<digits>@c.us` so a saved entry is the same shape as the chats it must match. Mirrors
 * `normalizeScopeList`'s NULL-not-`[]` contract.
 */
export function normalizeChatAllowList(list: string[] | null | undefined): string[] | null {
  if (list == null) return null;
  const cleaned = list.map(entry => entry.trim()).filter(entry => entry.length > 0);
  const qualified = [...new Set(cleaned.map(entry => (BARE_NUMBER.test(entry) ? `${entry}@c.us` : entry)))];
  return qualified.length > 0 ? qualified : null;
}

/**
 * The stored address forms of a chat id or an allowlist entry. No directory: literal dialects only.
 * A user id has two dialects; a lid and a group each have one; a status/channel/broadcast/unknown id
 * has none and so never matches a contact entry (it is not a chattable contact).
 */
function addressForms(chatId: string): string[] {
  const parsed = parseWaId(chatId);
  switch (parsed.kind) {
    case 'user':
      return [`${parsed.userPart}@c.us`, `${parsed.userPart}@s.whatsapp.net`];
    case 'lid':
      return [`${parsed.userPart}@lid`];
    case 'group':
      return [`${parsed.userPart}@g.us`];
    default:
      return [];
  }
}

/** Compile an `allowedChats` allowlist into a {@link ChatScope}, or `null` for "unrestricted". */
export function buildChatScope(allowedChats: string[] | null | undefined): ChatScope | null {
  if (!isChatScopeRestricted(allowedChats)) return null;
  const allowed = new Set<string>();
  for (const entry of normalizeChatAllowList(allowedChats) ?? []) {
    for (const form of addressForms(entry)) allowed.add(form);
  }
  return { allowed };
}

/**
 * Whether `chatId` falls inside `scope` by LITERAL address form. A `null` scope is unrestricted and
 * admits everything. Use {@link chatIdAllowed} when the lid table should be consulted.
 */
export function chatScopeAllows(scope: ChatScope | null, chatId: string): boolean {
  if (scope === null) return true;
  return addressForms(chatId).some(form => scope.allowed.has(form));
}

/**
 * Whether a single requested `chatId` is inside the allowlist, expanding the REQUESTED id (once)
 * through the lid table rather than the allowlist. `directory` may be omitted, in which case only
 * exact dialects match.
 */
export async function chatIdAllowed(
  scope: ChatScope | null,
  chatId: string,
  directory?: ContactDirectory,
): Promise<boolean> {
  if (scope === null) return true;
  const candidates = await resolveJidCandidates(chatId, directory);
  return candidates.some(candidate => scope.allowed.has(candidate));
}

/**
 * Expand the allowlist once with the lid table (batched: two queries at most) so a list filter can
 * then be a pure membership test per row. Returns the literal scope when there is no directory.
 */
export async function buildExpandedChatScope(
  allowedChats: string[] | null | undefined,
  directory?: ChatScopeDirectory,
): Promise<ChatScope | null> {
  const scope = buildChatScope(allowedChats);
  if (scope === null || !directory) return scope;
  const phones = new Set<string>();
  const lids = new Set<string>();
  for (const entry of normalizeChatAllowList(allowedChats) ?? []) {
    const parsed = parseWaId(entry);
    if (parsed.kind === 'user') phones.add(parsed.userPart);
    else if (parsed.kind === 'lid') lids.add(parsed.userPart);
  }
  const [lidToPhone, phoneToLids] = await Promise.all([
    directory.phonesForLids([...lids]),
    directory.lidsForPhones([...phones]),
  ]);
  const allowed = new Set(scope.allowed);
  for (const phone of Object.values(lidToPhone)) {
    if (phone) {
      allowed.add(`${phone}@c.us`);
      allowed.add(`${phone}@s.whatsapp.net`);
    }
  }
  for (const mapped of Object.values(phoneToLids)) {
    for (const lid of mapped) allowed.add(`${lid}@lid`);
  }
  return { allowed };
}

/**
 * Filter `items` down to the chats a scope admits, keyed by `chatIdOf`. A `null` scope returns the
 * list unchanged. List endpoints use this instead of rejecting, because they have no single chat in
 * the path to refuse.
 */
export function filterByChatScope<T>(
  scope: ChatScope | null,
  items: readonly T[],
  chatIdOf: (item: T) => string | null | undefined,
): T[] {
  if (scope === null) return [...items];
  return items.filter(item => {
    const id = chatIdOf(item);
    return id != null && chatScopeAllows(scope, id);
  });
}

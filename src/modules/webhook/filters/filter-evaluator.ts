import {
  WebhookFilters,
  WebhookFilterCondition,
  FieldDefinition,
  eventFamily,
  getFieldDefinition,
} from './filter-types';
import { parseWaId, toNeutralJid } from '../../../engine/identity/wa-id';

/**
 * Resolves a lid JID to its phone user-part when the mapping is known (mirrors the engine adapter's
 * `resolvePhone`). The dispatcher supplies one backed by the persistent lid->phone table; it is absent
 * in pure/unit contexts, where an unresolved lid simply stays a lid.
 */
export type LidResolver = (jid: string) => string | null;

// Normalize dialect and device suffixes without losing the original LID identity.
const canonicalActor = (jid: string, resolve?: LidResolver): string => toNeutralJid(jid, resolve).toLowerCase();
const canonicalInput = (value: string, resolve?: LidResolver): string => {
  // Bare digits are a phone-addressed user; anything else parses as a JID. Mirrors the engine's
  // user-input canonicalization (byte-identical to the former WaId.fromUserInput().toNeutral()).
  // A group therefore has to be written as a full `<id>@g.us`: digits alone become `<digits>@c.us`
  // and match no group, which the dashboard's chat picker avoids by storing the whole id.
  const trimmed = value.trim();
  if (trimmed && !trimmed.includes('@')) {
    return `${trimmed.replace(/\D/g, '') || trimmed}@c.us`.toLowerCase();
  }
  return toNeutralJid(trimmed, resolve).toLowerCase();
};

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function identitiesIntersect(candidates: string[], actual: string[], resolve?: LidResolver): boolean {
  const literal = new Set(candidates.map(v => canonicalInput(v)));
  const lidPhones = new Set(candidates.filter(v => parseWaId(v).kind === 'lid').map(v => canonicalInput(v, resolve)));
  return actual.some(jid => {
    const key = canonicalActor(jid);
    if (literal.has(key)) return true;
    const kind = parseWaId(jid).kind;
    // A reported pair bridges LID and phone, never two different LIDs sharing a phone.
    if (kind === 'lid') return literal.has(canonicalActor(jid, resolve));
    return kind === 'user' && lidPhones.has(key);
  });
}

/** Read the current aliases once for both sides of the id conditions, rather than a resident mirror. */
export async function prepareFilterLidResolver(
  filters: readonly (WebhookFilters | null | undefined)[],
  event: string,
  data: Record<string, unknown>,
  read?: (lids: string[]) => Promise<Record<string, string | null>>,
): Promise<LidResolver | undefined> {
  if (!read) return undefined;
  const lids = new Set<string>();
  const family = eventFamily(event);
  for (const filter of filters) {
    if (!Array.isArray(filter?.conditions)) continue;
    for (const condition of filter.conditions) {
      // The caller still rejects a malformed filter on its own, without dropping its siblings.
      try {
        const def = getFieldDefinition(family, condition.field);
        if (!def || (def.kind !== 'id' && def.kind !== 'idArray')) continue;
        const value = def.resolve(data);
        const actual = typeof value === 'string' ? [value] : toStringArray(value);
        for (const jid of [...actual, ...toStringArray(condition.value)]) {
          const parsed = parseWaId(jid);
          if (parsed.kind === 'lid') lids.add(parsed.userPart);
        }
      } catch {
        continue;
      }
    }
  }
  const phones: Record<string, string | null> = lids.size ? await read([...lids]).catch(() => ({})) : {};
  return jid => {
    const lid = parseWaId(jid).userPart;
    return Object.hasOwn(phones, lid) ? phones[lid] : null;
  };
}

function evaluateCondition(
  def: FieldDefinition,
  condition: WebhookFilterCondition,
  data: Record<string, unknown>,
  resolve?: LidResolver,
): boolean {
  const { operator, value, caseSensitive = false } = condition;
  const resolved = def.resolve(data);

  switch (def.kind) {
    case 'id': {
      const actual = typeof resolved === 'string' ? [resolved] : [];
      const isMatch = identitiesIntersect(toStringArray(value), actual, resolve);
      return operator === 'isNot' ? !isMatch : isMatch;
    }

    case 'enum': {
      const candidates = new Set(toStringArray(value));
      const actual = typeof resolved === 'string' ? resolved : undefined;
      const isMatch = actual != null && candidates.has(actual);
      return operator === 'isNot' ? !isMatch : isMatch;
    }

    case 'idArray': {
      const intersects = identitiesIntersect(toStringArray(value), toStringArray(resolved), resolve);
      return operator === 'isNot' ? !intersects : intersects;
    }

    case 'boolean':
      return resolved === (value === true);

    case 'text': {
      if (typeof value !== 'string') return true; // malformed; validated on save
      const haystackRaw = typeof resolved === 'string' ? resolved : '';
      const haystack = caseSensitive ? haystackRaw : haystackRaw.toLowerCase();
      const needle = caseSensitive ? value : value.toLowerCase();
      if (operator === 'equals') return haystack === needle;
      return haystack.includes(needle); // contains
    }

    default:
      return true;
  }
}

/**
 * Returns true when the webhook should fire for this event. Absent or empty filters
 * always pass (additive/optional). All conditions must match (AND). Conditions whose
 * field is not registered for the fired event's family are skipped. `resolve` (optional)
 * maps a lid to its phone so id conditions match a lid-addressed actor by phone.
 */
export function evaluateFilters(
  filters: WebhookFilters | null | undefined,
  event: string,
  data: Record<string, unknown>,
  resolve?: LidResolver,
): boolean {
  if (!filters || !Array.isArray(filters.conditions) || filters.conditions.length === 0) {
    return true;
  }
  const family = eventFamily(event);
  for (const condition of filters.conditions) {
    const def = getFieldDefinition(family, condition.field);
    if (!def) continue;
    if (!evaluateCondition(def, condition, data, resolve)) return false;
  }
  return true;
}

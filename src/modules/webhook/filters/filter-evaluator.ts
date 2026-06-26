import {
  WebhookFilters,
  WebhookFilterCondition,
  FieldDefinition,
  eventFamily,
  getFieldDefinition,
} from './filter-types';
import { WaId } from '../../../engine/identity/wa-id.value';

/**
 * Resolves a lid JID to its phone user-part when the mapping is known (mirrors the engine adapter's
 * `resolvePhone`). The dispatcher supplies one backed by the persistent lid->phone table; it is absent
 * in pure/unit contexts, where an unresolved lid simply stays a lid.
 */
export type LidResolver = (jid: string) => string | null;

// Reduce an id to its engine-neutral canonical key so the same contact matches regardless of dialect.
// An engine-emitted JID (any of @c.us / @s.whatsapp.net / @lid, an optional :device suffix, a lid the
// table resolves to its phone) and a user-typed filter value (bare digits or a JID) both collapse to
// the same neutral string (`<phone>@c.us` / `<id>@g.us` / `<lid>@lid`). So a phone filter now matches
// the person across user dialects AND any lid resolving to that phone - previously a silent miss.
const canonicalActor = (jid: string, resolve?: LidResolver): string =>
  WaId.fromEngineJid(jid, resolve).toNeutral().toLowerCase();
const canonicalInput = (value: string): string => WaId.fromUserInput(value).toNeutral().toLowerCase();

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

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
      const candidates = new Set(toStringArray(value).map(canonicalInput));
      const actual = typeof resolved === 'string' ? resolved : undefined;
      const isMatch = actual != null && candidates.has(canonicalActor(actual, resolve));
      return operator === 'isNot' ? !isMatch : isMatch;
    }

    case 'enum': {
      const candidates = new Set(toStringArray(value));
      const actual = typeof resolved === 'string' ? resolved : undefined;
      const isMatch = actual != null && candidates.has(actual);
      return operator === 'isNot' ? !isMatch : isMatch;
    }

    case 'idArray': {
      const candidates = new Set(toStringArray(value).map(canonicalInput));
      const actual = toStringArray(resolved).map(jid => canonicalActor(jid, resolve));
      const intersects = actual.some(v => candidates.has(v));
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

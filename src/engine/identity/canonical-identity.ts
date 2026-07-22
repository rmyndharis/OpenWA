import { parseWaId, toNeutralJid } from './wa-id';
import type { LidMappingStore } from './lid-mapping-store.service';

/**
 * A compact, engine-neutral identity suitable for narrowly scoped consumers.
 *
 * This deliberately exposes only the resolved canonical JID and resolution state. It does not
 * expose the raw engine JID, mapping provenance, contact data, or a write API for the LID cache.
 */
export interface CanonicalIdentity {
  canonicalJid: string;
  kind: 'person' | 'group' | 'broadcast' | 'unknown';
  resolution: 'phone-resolved' | 'lid-unresolved' | 'not-applicable';
}

/**
 * Resolve a JID using OpenWA's persisted LID mapping cache when it is available.
 *
 * The function is synchronous by design: it is safe to use on request/event hot paths and never
 * triggers a network lookup. An unknown (or negatively cached) LID remains a first-class `@lid`
 * identity rather than being guessed as a phone number.
 */
export function canonicalIdentity(jid: string, lidMappings?: Pick<LidMappingStore, 'getCached'>): CanonicalIdentity {
  const parsed = parseWaId(jid);
  if (parsed.kind === 'lid') {
    const phone = lidMappings?.getCached(parsed.userPart);
    if (phone) {
      return {
        canonicalJid: `${phone}@c.us`,
        kind: 'person',
        resolution: 'phone-resolved',
      };
    }
    return {
      canonicalJid: `${parsed.userPart}@lid`,
      kind: 'person',
      resolution: 'lid-unresolved',
    };
  }

  switch (parsed.kind) {
    case 'user':
      return { canonicalJid: toNeutralJid(jid), kind: 'person', resolution: 'phone-resolved' };
    case 'group':
      return { canonicalJid: toNeutralJid(jid), kind: 'group', resolution: 'not-applicable' };
    case 'status':
    case 'newsletter':
    case 'broadcast':
      return { canonicalJid: toNeutralJid(jid), kind: 'broadcast', resolution: 'not-applicable' };
    default:
      return { canonicalJid: toNeutralJid(jid), kind: 'unknown', resolution: 'not-applicable' };
  }
}

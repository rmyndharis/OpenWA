import { canonicalIdentity } from './canonical-identity';
import type { LidMappingStore } from './lid-mapping-store.service';

function mappings(entries: Record<string, string | null> = {}): LidMappingStore {
  return {
    getCached: jest.fn((lid: string) => entries[lid]),
    lidsForPhone: jest.fn(() => []),
    remember: jest.fn(),
  };
}

describe('canonicalIdentity', () => {
  it('normalizes a phone-addressed JID without consulting LID state', () => {
    const getCached = jest.fn();
    const store: LidMappingStore = { getCached, lidsForPhone: jest.fn(() => []), remember: jest.fn() };

    expect(canonicalIdentity('15551234567:12@s.whatsapp.net', store)).toEqual({
      canonicalJid: '15551234567@c.us',
      kind: 'person',
      resolution: 'phone-resolved',
    });
    expect(getCached).not.toHaveBeenCalled();
  });

  it('uses the persisted mapping for a known LID', () => {
    expect(canonicalIdentity('12345@lid', mappings({ '12345': '15551234567' }))).toEqual({
      canonicalJid: '15551234567@c.us',
      kind: 'person',
      resolution: 'phone-resolved',
    });
  });

  it('keeps an unknown LID as a first-class unresolved identity', () => {
    expect(canonicalIdentity('12345:7@lid', mappings())).toEqual({
      canonicalJid: '12345@lid',
      kind: 'person',
      resolution: 'lid-unresolved',
    });
  });

  it('does not label groups, broadcasts, or unknown ids as phone-resolved people', () => {
    expect(canonicalIdentity('group-1@g.us')).toEqual({
      canonicalJid: 'group-1@g.us',
      kind: 'group',
      resolution: 'not-applicable',
    });
    expect(canonicalIdentity('status@broadcast')).toEqual({
      canonicalJid: 'status@broadcast',
      kind: 'broadcast',
      resolution: 'not-applicable',
    });
    expect(canonicalIdentity('not-a-jid')).toEqual({
      canonicalJid: 'not-a-jid',
      kind: 'unknown',
      resolution: 'not-applicable',
    });
  });
});
